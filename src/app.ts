// src/app.ts
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { RequestListener } from "node:http";

import express, { NextFunction, Request, RequestHandler, Response } from "express";
import "express-async-errors";
import pino from "pino";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import { getClientIp } from "request-ip";
import * as ev from "express-validator";

import { Config } from "./config";
import { twilioVoiceWebhookRouter } from "./routes/twilioVoiceWebhook";
import { twilioCallStatusRouter } from "./routes/twilioCallStatus";
import { twilioRecordingStatusRouter } from "./routes/twilioRecordingStatus";
import { twilioGenerateTokenRouter } from "./routes/twilioGenerateToken";
import { streamCallRecordingRouter } from "./routes/streamCallRecording";

export type App = {
  requestListener: RequestListener;
  shutdown: () => Promise<void>;
};

declare global {
  namespace Express {
    interface Request {
      abortSignal: AbortSignal;
    }
  }
}

const LARGE_JSON_PATH = "/large-json-payload";
const APPLICATION_JSON = "application/json";

type Store = {
  logger: pino.Logger;
  requestId: string;
};

const asl = new AsyncLocalStorage<Store>();

export function makeValidationMiddleware(runners: ev.ContextRunner[]): RequestHandler {
  return async function (req: Request, res: Response, next: NextFunction) {
    await Promise.all(runners.map((runner) => runner.run(req)));

    const errors = ev.validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    next();
  };
}

export const initApp = async (config: Config, logger: pino.Logger): Promise<App> => {
  const app = express();
  app.set("trust proxy", true);

  /* ==============================
     ✅ CORS (SAFE FOR BROWSER + TWILIO)
     ============================== */

  const ALLOWED_ORIGINS = new Set([
    "https://crm-originhi.base44.app",
  ]);

  app.use(
    cors({
      origin: (origin, cb) => {
        // No Origin header = server-to-server (Twilio) → allow
        if (!origin) return cb(null, true);

        if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);

        return cb(new Error(`CORS blocked for origin: ${origin}`));
      },
      credentials: true,
      methods: ["GET", "POST", "HEAD", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Range"],
      exposedHeaders: ["Content-Range", "Accept-Ranges"],
      maxAge: 600,
    })
  );

  // Explicitly handle preflight
  app.options("*", cors());

  /* ==============================
     ✅ BODY PARSERS
     ============================== */

  // Needed for Twilio webhooks (form posts)
  app.use(express.urlencoded({ extended: false }));

  // Raw parser for non-JSON payloads
  app.use(
    express.raw({
      limit: "1kb",
      type: (req) => req.headers["content-type"] !== APPLICATION_JSON,
    })
  );

  // JSON parser (except large-json path)
  app.use(
    express.json({
      limit: "50kb",
      type: (req) =>
        req.headers["content-type"] === APPLICATION_JSON &&
        req.url !== LARGE_JSON_PATH,
    })
  );

  /* ==============================
     ✅ LOGGING + CONTEXT
     ============================== */

  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const ac = new AbortController();
    req.abortSignal = ac.signal;
    res.on("close", () => ac.abort());

    const hdr = req.headers["x-request-id"];
    const requestId = (Array.isArray(hdr) ? hdr[0] : hdr) || randomUUID();
    const l = logger.child({ requestId });

    let bytesRead = 0;
    req.on("data", (chunk: Buffer) => {
      bytesRead += chunk.length;
    });

    let bytesWritten = 0;
    const oldWrite = res.write.bind(res);
    const oldEnd = res.end.bind(res);

    (res as any).write = function (chunk: any, ...rest: any[]) {
      if (chunk) {
        bytesWritten += Buffer.isBuffer(chunk)
          ? chunk.length
          : Buffer.byteLength(String(chunk));
      }
      return oldWrite(chunk, ...rest);
    };

    (res as any).end = function (chunk?: any, ...rest: any[]) {
      if (chunk) {
        bytesWritten += Buffer.isBuffer(chunk)
          ? chunk.length
          : Buffer.byteLength(String(chunk));
      }
      return oldEnd(chunk, ...rest);
    };

    res.on("finish", () => {
      l.info(
        {
          duration: Date.now() - start,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ua: req.headers["user-agent"],
          ip: getClientIp(req),
          br: bytesRead,
          bw: bytesWritten,
        },
        "Request handled"
      );
    });

    asl.run({ logger: l, requestId }, () => next());
  });

  app.use(helmet());
  app.use(compression());

  /* ==============================
     ✅ TWILIO ROUTES
     ============================== */

  app.use("/twilio", twilioVoiceWebhookRouter);
  app.use("/twilio", twilioCallStatusRouter);
  app.use("/twilio", twilioRecordingStatusRouter);
  app.use("/twilio", twilioGenerateTokenRouter);
  app.use("/twilio", streamCallRecordingRouter);

  /* ==============================
     ✅ BASIC ROUTES
     ============================== */

  app.get("/", (_req: Request, res: Response) => {
    res.status(200).send("Backend is running 🚀");
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.get(config.healthCheckEndpoint, (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  app.get("/hi", (_req: Request, res: Response) => {
    const s = asl.getStore();
    s?.logger.info("hi");
    res.send("hi");
  });

  app.post(
    "/echo",
    makeValidationMiddleware([ev.body("name").notEmpty()]),
    (req: Request, res: Response) => {
      res.json({ msg: `hi ${req.body.name}` });
    }
  );

  app.post(
    LARGE_JSON_PATH,
    express.json({ limit: "5mb", type: APPLICATION_JSON }),
    (_req: Request, res: Response) => {
      res.end();
    }
  );

  /* ==============================
     ✅ ERROR HANDLER
     ============================== */

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    asl.getStore()?.logger.error(err);
    if (res.headersSent) return;
    res.status(500).json({ msg: "Something went wrong" });
  });

  return {
    requestListener: app,
    shutdown: async () => {},
  };
};
