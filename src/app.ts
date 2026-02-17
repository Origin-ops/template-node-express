// src/app.ts
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { RequestListener } from "node:http";

import express, { NextFunction, Request, RequestHandler, Response } from "express";
import "express-async-errors";
import pino from "pino";
import helmet from "helmet";
import compression from "compression";
import { getClientIp } from "request-ip";
import * as ev from "express-validator";

import { Config } from "./config";
import { twilioVoiceWebhookRouter } from "./routes/twilioVoiceWebhook";

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

  // ✅ Needed for Twilio webhooks (application/x-www-form-urlencoded)
  app.use(express.urlencoded({ extended: false }));

  // Raw parser for non-JSON payloads
  app.use(
    express.raw({
      limit: "1kb",
      type: (req) => req.headers["content-type"] !== APPLICATION_JSON,
    }),
  );

  // JSON parser for normal JSON payloads (except the large-json path)
  app.use(
    express.json({
      limit: "50kb",
      type: (req) =>
        req.headers["content-type"] === APPLICATION_JSON && req.url !== LARGE_JSON_PATH,
    }),
  );

  // Request context + logging + abort signal propagation
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

    // Track bytes written
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).write = function (chunk: any, ...rest: any[]) {
      if (chunk) {
        bytesWritten += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      }
      return oldWrite(chunk, ...rest);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).end = function (chunk?: any, ...rest: any[]) {
      if (chunk) {
        bytesWritten += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
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
        "Request handled",
      );
    });

    asl.run({ logger: l, requestId }, () => next());
  });

  app.use(helmet());
  app.use(compression());

  // ✅ Mount Twilio routes
  app.use("/twilio", twilioVoiceWebhookRouter);

  // Friendly root route
  app.get("/", (req: Request, res: Response) => {
    res.status(200).send("Backend is running 🚀");
  });

  // Simple health route
  app.get("/health", (req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // Existing configured health check endpoint
  app.get(config.healthCheckEndpoint, (req: Request, res: Response) => {
    res.sendStatus(200);
  });

  app.get("/hi", (req: Request, res: Response) => {
    const s = asl.getStore();
    s?.logger.info("hi");
    res.send("hi");
  });

  app.post(
    "/echo",
    makeValidationMiddleware([ev.body("name").notEmpty()]),
    (req: Request, res: Response) => {
      res.json({ msg: `hi ${req.body.name}` });
    },
  );

  app.post(
    LARGE_JSON_PATH,
    express.json({ limit: "5mb", type: APPLICATION_JSON }),
    (req: Request, res: Response) => {
      // TODO: handle large json payload
      res.end();
    },
  );

  app.get("/abort-signal-propagation", async (req: Request, res: Response) => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (req.abortSignal.aborted) throw new Error("aborted");
    }

    const usersRes = await fetch("https://jsonplaceholder.typicode.com/users", {
      signal: req.abortSignal,
    });

    if (usersRes.status !== 200) {
      throw new Error(`unexpected non-200 status code ${usersRes.status}`);
    }

    const users = await usersRes.json();
    res.json(users);
  });

  // Error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    asl.getStore()?.logger.error(err);
    if (res.headersSent) return;
    res.status(500).json({ msg: "Something went wrong" });
  });

  return {
    requestListener: app,
    shutdown: async () => {
      // add any cleanup code here including database/redis disconnecting and background job shutdown
    },
  };
};
