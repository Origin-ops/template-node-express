import { Router, Request, Response } from "express";
import twilio from "twilio";

export const twilioGenerateTokenRouter = Router();

twilioGenerateTokenRouter.post("/generate-token", async (req: Request, res: Response) => {
  try {
    // ✅ Shared secret so only Base44 can call this
    const secret = process.env.INTERNAL_SHARED_SECRET || "";
    const got = req.header("x-internal-secret") || "";
    if (!secret || got !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      identity: rawIdentity,
      ttl = 3600,
    } = (req.body || {}) as { identity?: string; ttl?: number };

    const accountSid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
    const apiKeySid = (process.env.TWILIO_API_KEY_SID || "").trim();
    const apiKeySecret = (process.env.TWILIO_API_KEY_SECRET || "").trim();
    const twimlAppSid = (process.env.TWILIO_TWIML_APP_SID || "").trim();

    if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
      return res.status(500).json({ error: "Twilio credentials not configured" });
    }

    if (!rawIdentity) {
      return res.status(400).json({ error: "Missing identity" });
    }

    // Make it safe for Twilio identity field
    const identity = String(rawIdentity).replace(/[^\w@.-]/g, "_").slice(0, 100);

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: false,
    });

    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity,
      ttl: Number(ttl) || 3600,
    });

    token.addGrant(voiceGrant);

    return res.json({ token: token.toJwt() });
  } catch (e: any) {
    console.error("[twilioGenerateToken] error", e?.stack || e);
    return res.status(500).json({ error: "Server error" });
  }
});

// Optional GET check
twilioGenerateTokenRouter.get("/generate-token", (req: Request, res: Response) => {
  res.status(200).send("twilioGenerateToken is live (POST required).");
});
