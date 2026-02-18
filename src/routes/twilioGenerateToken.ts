import { Router, Request, Response } from "express";
import Twilio from "twilio";

export const twilioGenerateTokenRouter = Router();

twilioGenerateTokenRouter.post("/generate-token", async (req: Request, res: Response) => {
  try {
    // ---- Read + trim env vars ----
    const accountSid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
    const apiKeySid = (process.env.TWILIO_API_KEY_SID || "").trim();
    const apiKeySecret = (process.env.TWILIO_API_KEY_SECRET || "").trim();
    const twimlAppSid = (process.env.TWILIO_TWIML_APP_SID || "").trim();

    if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
      console.error("[twilioGenerateToken] Missing env vars", {
        hasAccountSid: !!accountSid,
        hasApiKeySid: !!apiKeySid,
        hasApiKeySecret: !!apiKeySecret,
        hasTwimlAppSid: !!twimlAppSid,
      });
      return res.status(500).json({ error: "Missing Twilio env vars" });
    }

    // ---- Identity (must be safe + short) ----
    const rawIdentity = req.body?.identity || "dialer-user";
    const identity = String(rawIdentity)
      .replace(/[^\w@.-]/g, "_")
      .slice(0, 100);

    // ---- Debug (masked values only) ----
    const mask = (v: string) =>
      v ? `${v.slice(0, 4)}…${v.slice(-4)}` : "";

    console.log("[twilioGenerateToken] generating token", {
      accountSid: mask(accountSid),
      apiKeySid: mask(apiKeySid),
      twimlAppSid: mask(twimlAppSid),
      identity,
    });

    // ---- Build token ----
    const AccessToken = Twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const token = new AccessToken(
      accountSid,
      apiKeySid,
      apiKeySecret,
      {
        identity,
        ttl: 3600,
      }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: false,
    });

    token.addGrant(voiceGrant);

    const jwt = token.toJwt();

    console.log("[twilioGenerateToken] token generated successfully");

    return res.json({ token: jwt });

  } catch (err: any) {
    console.error("[twilioGenerateToken] ERROR", err?.stack || err);
    return res.status(500).json({ error: "Token generation failed" });
  }
});
