import { Router, Request, Response } from "express";
import twilio from "twilio";

// Router export
export const twilioVoiceWebhookRouter = Router();

function buildTwiml(
  number: string,
  callerId: string,
  statusCallbackBase: string,
  recordingCallbackBase: string,
  callRecordId?: string,
) {
  const esc = (s: unknown) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const statusCallbackUrl = callRecordId
    ? `${statusCallbackBase}?call_record_id=${encodeURIComponent(callRecordId)}`
    : statusCallbackBase;

  const recordingCallbackUrl = callRecordId
    ? `${recordingCallbackBase}?call_record_id=${encodeURIComponent(callRecordId)}`
    : recordingCallbackBase;

  // ✅ IMPORTANT: do NOT set Dial action=... to call-status, because action expects TwiML.
  // We'll use <Number statusCallback=...> for status updates instead.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${esc(callerId)}"
        record="record-from-answer"
        recordingStatusCallback="${esc(recordingCallbackUrl)}"
        recordingStatusCallbackMethod="POST"
        answerOnBridge="true"
        timeout="30">
    <Number statusCallback="${esc(statusCallbackUrl)}"
            statusCallbackMethod="POST"
            statusCallbackEvent="initiated ringing answered completed">
      ${esc(number)}
    </Number>
  </Dial>
</Response>`;
}

function twimlSay(res: Response, message: string) {
  const esc = (s: unknown) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="alice">${esc(message)}</Say></Response>`;

  return res.status(200).type("text/xml").send(xml);
}

function normalizeNumber(n: unknown) {
  const s = String(n ?? "").trim();
  if (!s) return "";
  const cleaned = s.replace(/[^+\d]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  if (/^0\d{9,}$/.test(cleaned)) return "+44" + cleaned.replace(/^0+/, "");
  if (/^44\d{9,}$/.test(cleaned)) return "+" + cleaned;
  return cleaned;
}

/**
 * POST /twilio/voice-webhook
 * Twilio sends application/x-www-form-urlencoded
 */
twilioVoiceWebhookRouter.post("/voice-webhook", async (req: Request, res: Response) => {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      console.error("twilioVoiceWebhook: Missing TWILIO_AUTH_TOKEN");
      return twimlSay(res, "Server configuration error.");
    }

    const callerId = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER;
    if (!callerId) {
      console.error("twilioVoiceWebhook: Missing TWILIO_PHONE_NUMBER / TWILIO_FROM_NUMBER");
      return twimlSay(res, "Server configuration error.");
    }

    // Params (requires express.urlencoded({extended:false}) in app.ts)
    const params: Record<string, any> = req.body || {};

    // Debug incoming
    try {
      console.log("twilioVoiceWebhook: incoming request", {
        method: req.method,
        url: req.originalUrl,
        contentType: req.headers["content-type"],
        sigPresent: Boolean(req.header("X-Twilio-Signature")),
        keys: Object.keys(params),
      });
    } catch (_) {}

    // Signature validation
    const skipSig =
      (process.env.TWILIO_SKIP_SIGNATURE_VALIDATION || "").toLowerCase() === "true" ||
      process.env.TWILIO_SKIP_SIGNATURE_VALIDATION === "1";

    if (!skipSig) {
      const sigHeader = req.header("X-Twilio-Signature") || "";

      // Validate against a fixed public URL if provided (recommended)
      const validationUrl =
        (process.env.TWILIO_WEBHOOK_URL || "").trim() ||
        `${req.protocol}://${req.get("host")}${req.originalUrl.split("?")[0]}`;

      const valid = twilio.validateRequest(authToken, sigHeader, validationUrl, params);

      if (!valid) {
        console.error("twilioVoiceWebhook: Invalid Twilio signature", {
          validationUrl,
          hasSig: Boolean(sigHeader),
          keys: Object.keys(params),
        });
        return res.status(403).send("Forbidden");
      }
    }

    // Determine destination number
    const rawTo =
      params.To ||
      params.to ||
      params.phoneNumber ||
      params.phone ||
      params.Number ||
      params.number ||
      params.Called ||
      params.DialTo;

    const toNumber = normalizeNumber(rawTo);
    const callRecordId = params.CallRecordId || params.call_record_id;

    if (!toNumber) {
      return twimlSay(res, "Missing destination number.");
    }

    // Build callback URLs (fixed Railway base)
    const base =
      (process.env.TWILIO_WEBHOOK_BASE_URL || "").trim().replace(/\/+$/, "") ||
      "https://node-express-production-24b9.up.railway.app/twilio";

    const statusCallbackUrl = `${base}/call-status`;
    const recordingCallbackUrl = `${base}/recording-status`;

    // Return TwiML
    const twimlXml = buildTwiml(toNumber, callerId, statusCallbackUrl, recordingCallbackUrl, callRecordId);

    try {
      console.log("twilioVoiceWebhook: TwiML callbacks", {
        statusCallbackUrl,
        recordingCallbackUrl,
        toNumber,
        callRecordId,
      });
    } catch (_) {}

    return res.status(200).type("text/xml").send(twimlXml);
  } catch (error: any) {
    console.error("twilioVoiceWebhook ERROR:", error?.stack || error);
    return twimlSay(res, "Server error.");
  }
});

// Optional GET for quick browser check (Twilio uses POST)
twilioVoiceWebhookRouter.get("/voice-webhook", (req: Request, res: Response) => {
  res.status(200).send("twilioVoiceWebhook is live (POST required).");
});
