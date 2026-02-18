import { Router, Request, Response } from "express";
import Twilio from "twilio";

export const twilioGenerateTokenRouter = Router();

twilioGenerateTokenRouter.post("/generate-token", async (req: Request, res: Response) => {
  try {
    const { 
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      TWILIO_TWIML_APP_SID
    } = process.env;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWILIO_TWIML_APP_SID) {
      return res.status(500).json({ error: "Missing Twilio env vars" });
    }

    const identity = req.body?.identity || "dialer-user";

    const AccessToken = Twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      { identity, ttl: 3600 }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: TWILIO_TWIML_APP_SID,
      incomingAllow: false
    });

    token.addGrant(voiceGrant);

    return res.json({ token: token.toJwt() });

  } catch (err: any) {
    console.error("Token generation error:", err);
    return res.status(500).json({ error: "Token generation failed" });
  }
});
