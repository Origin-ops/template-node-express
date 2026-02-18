import { Router, Request, Response } from "express";

export const streamCallRecordingRouter = Router();

/**
 * base64url decode to string
 */
function base64UrlToString(input: string) {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (b64.length % 4)) % 4;
  const padded = b64 + "=".repeat(padLen);
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * HMAC verify where the signed message is the *payloadB64* string (exactly like your Deno code)
 */
function hmacVerify(secret: string, payloadB64: string, sigB64: string) {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const mac = crypto.createHmac("sha256", secret).update(payloadB64, "utf8").digest("base64");
  const calc = mac.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return calc === sigB64;
}

/**
 * CORS helper
 */
function applyCors(res: Response) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges");
}

async function base44LoginAndGetCall(callId: string) {
  const appId = (process.env.BASE44_APP_ID || "").trim();
  const email = (process.env.BASE44_ADMIN_EMAIL || "").trim();
  const password = (process.env.BASE44_ADMIN_PASSWORD || "").trim();
  if (!appId || !email || !password) {
    throw new Error("Base44 service role credentials not configured");
  }

  // These endpoints match Base44 patterns you’ve already used.
  const base = "https://base44.app";

  // 1) Login
  const loginRes = await fetch(`${base}/api/apps/${appId}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!loginRes.ok) {
    const t = await loginRes.text().catch(() => "");
    throw new Error(`Base44 login failed (${loginRes.status}): ${t}`);
  }

  const loginJson: any = await loginRes.json().catch(() => ({}));
  const token = loginJson?.token || loginJson?.access_token || loginJson?.accessToken;
  if (!token) {
    throw new Error("Base44 login did not return an access token");
  }

  // 2) Fetch Call entity by id
  const callRes = await fetch(`${base}/api/apps/${appId}/entities/Call/${encodeURIComponent(callId)}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });

  if (callRes.status === 404) return null;
  if (!callRes.ok) {
    const t = await callRes.text().catch(() => "");
    throw new Error(`Base44 Call fetch failed (${callRes.status}): ${t}`);
  }

  return await callRes.json().catch(() => null);
}

streamCallRecordingRouter.options("/stream-call-recording", async (_req: Request, res: Response) => {
  applyCors(res);
  return res.status(204).send("");
});

streamCallRecordingRouter.get("/stream-call-recording", async (req: Request, res: Response) => {
  return handle(req, res);
});

streamCallRecordingRouter.head("/stream-call-recording", async (req: Request, res: Response) => {
  return handle(req, res, true);
});

async function handle(req: Request, res: Response, isHead = false) {
  try {
    applyCors(res);

    const token = String(req.query.token || "");
    if (!token) return res.status(400).json({ error: "Missing token" });

    const parts = token.split(".");
    if (parts.length !== 2) return res.status(400).json({ error: "Invalid token" });

    const [payloadB64, sigB64] = parts;

    let payload: any;
    try {
      payload = JSON.parse(base64UrlToString(payloadB64));
    } catch {
      return res.status(400).json({ error: "Invalid token payload" });
    }

    const { callId, recordingSid, twilioCallSid, exp } = payload || {};
    if (!callId && !recordingSid) return res.status(400).json({ error: "Invalid token data" });
    if (!exp || Date.now() > Number(exp)) return res.status(401).json({ error: "Token expired" });

    const secret =
      (process.env.RECORDING_TOKEN_SECRET || "").trim() ||
      (process.env.TWILIO_AUTH_TOKEN || "").trim();

    if (!secret) return res.status(500).json({ error: "Server not configured" });

    const valid = hmacVerify(secret, payloadB64, sigB64);
    if (!valid) return res.status(401).json({ error: "Invalid signature" });

    const range = req.headers["range"] as string | undefined;

    // Twilio creds
    const accountSid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
    const authToken = (process.env.TWILIO_AUTH_TOKEN || "").trim();
    const apiKeySid = (process.env.TWILIO_API_KEY_SID || "").trim();
    const apiKeySecret = (process.env.TWILIO_API_KEY_SECRET || "").trim();

    if (!accountSid) return res.status(500).json({ error: "Twilio credentials not configured" });

    const authBasic = authToken
      ? `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`
      : null;

    const keyBasic = apiKeySid && apiKeySecret
      ? `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString("base64")}`
      : null;

    const primaryAuth = authBasic || keyBasic;
    if (!primaryAuth) return res.status(500).json({ error: "Twilio credentials not configured" });

    // Candidate URLs
    let candidates: string[] = [];

    if (recordingSid) {
      candidates = [
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.mp3`,
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${recordingSid}.wav`,
      ];
    } else if (callId) {
      // Base44 call lookup
      let call: any = null;
      try {
        call = await base44LoginAndGetCall(String(callId));
      } catch (e: any) {
        console.warn("[streamCallRecording] base44 lookup failed", e?.message || e);
      }

      if (!call) return res.status(404).json({ error: "Call not found" });

      if (call.twilio_recording_sid) {
        candidates.push(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${call.twilio_recording_sid}.mp3`,
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${call.twilio_recording_sid}.wav`,
        );
      }

      if (call.recording_url) {
        const u = String(call.recording_url);
        if (/\.(mp3|wav)$/i.test(u)) {
          candidates.push(u);
        } else if (/\.json$/i.test(u)) {
          candidates.push(u.replace(/\.json$/i, ".mp3"));
          candidates.push(u.replace(/\.json$/i, ".wav"));
        } else {
          candidates.push(`${u}.mp3`);
          candidates.push(`${u}.wav`);
        }
      }

      if (!candidates.length && call.twilio_call_sid) {
        const listUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${call.twilio_call_sid}/Recordings.json`;
        const listRes = await fetch(listUrl, { headers: { Authorization: primaryAuth } });
        if (listRes.ok) {
          const data: any = await listRes.json().catch(() => ({}));
          const first = data?.recordings?.[0];
          if (first?.sid) {
            candidates.push(
              `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${first.sid}.mp3`,
              `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${first.sid}.wav`,
            );
          }
        }
      }
    }

    // Final fallback: token includes Call SID
    if (!candidates.length && twilioCallSid) {
      const listUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${twilioCallSid}/Recordings.json`;
      const listRes = await fetch(listUrl, { headers: { Authorization: primaryAuth } });
      if (listRes.ok) {
        const data: any = await listRes.json().catch(() => ({}));
        const first = data?.recordings?.[0];
        if (first?.sid) {
          candidates.push(
            `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${first.sid}.mp3`,
            `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${first.sid}.wav`,
          );
        }
      }
    }

    if (!candidates.length) return res.status(404).json({ error: "Recording not available" });

    const fetchAudio = async (urlStr: string, auth: string) => {
      const headers: Record<string, string> = {
        Authorization: auth,
        Accept: "audio/mpeg, audio/*",
      };
      if (range) headers["Range"] = range;

      return fetch(urlStr, { headers, redirect: "follow" });
    };

    let audioRes: Response | null = null;
    let finalUrl = "";

    for (const urlStr of candidates) {
      let r = await fetchAudio(urlStr, primaryAuth);
      // If primary auth was authToken but fails, try api key auth (or vice versa)
      if ((r.status === 401 || r.status === 403) && keyBasic && authBasic) {
        r = await fetchAudio(urlStr, keyBasic);
      }
      if (r.ok && r.body) {
        audioRes = r;
        finalUrl = urlStr;
        break;
      }
    }

    if (!audioRes || !audioRes.ok || !audioRes.body) {
      return res.status(502).json({ error: "Failed to fetch recording audio" });
    }

    // Mirror Twilio headers/status for proper Range support
    const contentType =
      audioRes.headers.get("content-type") ||
      (finalUrl.endsWith(".wav") ? "audio/wav" : "audio/mpeg");

    res.status(audioRes.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", 'inline; filename="recording"');

    const contentRange = audioRes.headers.get("content-range");
    const contentLength = audioRes.headers.get("content-length");
    if (contentRange) res.setHeader("Content-Range", contentRange);
    if (contentLength) res.setHeader("Content-Length", contentLength);

    if (isHead) return res.end();

    // Stream body
    const body = audioRes.body as any; // Web stream
    // Node 18+ supports Readable.fromWeb
    const { Readable } = require("node:stream") as typeof import("node:stream");
    const nodeStream = Readable.fromWeb(body);
    nodeStream.on("error", () => {
      try { res.end(); } catch {}
    });
    nodeStream.pipe(res);
  } catch (error: any) {
    console.error("[streamCallRecording] ERROR", error?.stack || error);
    applyCors(res);
    return res.status(500).json({ error: error?.message || "Server error" });
  }
}
