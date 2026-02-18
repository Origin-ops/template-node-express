import { Router, Request, Response } from "express";
import { createClient } from "@base44/sdk";
import twilio from "twilio";

export const twilioCallStatusRouter = Router();

/** Map Twilio statuses to your internal statuses */
function mapStatus(callStatus: any) {
  const s = String(callStatus || "").toLowerCase();
  if (s === "in-progress" || s === "answered") return "in_progress";
  if (s === "completed") return "completed";
  if (s === "ringing" || s === "queued" || s === "initiated") return "ringing";
  if (s === "failed" || s === "busy" || s === "no-answer" || s === "canceled") return "failed";
  return undefined;
}

function asNumber(x: any): number | undefined {
  if (x === undefined || x === null) return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Base44 client (external backend)
 * - Uses createClient({appId})
 * - Logs in as a dedicated Base44 user
 */
const appId = process.env.BASE44_APP_ID || "";
if (!appId) console.warn("[twilioCallStatus] Missing BASE44_APP_ID");

const base44 = createClient({ appId });

let lastLoginAt = 0;
/** re-login at most once every 50 minutes */
const LOGIN_TTL_MS = 50 * 60 * 1000;

async function ensureBase44Auth() {
  const email = process.env.BASE44_ADMIN_EMAIL || "";
  const password = process.env.BASE44_ADMIN_PASSWORD || "";
  if (!email || !password) {
    throw new Error("Missing BASE44_ADMIN_EMAIL / BASE44_ADMIN_PASSWORD");
  }

  const now = Date.now();
  if (now - lastLoginAt < LOGIN_TTL_MS) return;

  await base44.auth.loginViaEmailPassword(email, password);
  lastLoginAt = now;
}

async function twilioFetchDurationIfNeeded(callSid?: string, currentDuration?: number) {
  if (!callSid) return currentDuration;
  if (typeof currentDuration === "number" && Number.isFinite(currentDuration)) return currentDuration;

  const acct = process.env.TWILIO_ACCOUNT_SID || "";
  const token = process.env.TWILIO_AUTH_TOKEN || "";
  if (!acct || !token) return currentDuration;

  try {
    const client = twilio(acct, token);
    const call = await client.calls(callSid).fetch();
    const n = asNumber((call as any)?.duration);
    return n ?? currentDuration;
  } catch (e: any) {
    console.warn("[twilioCallStatus] Twilio duration fetch failed:", e?.message || e);
    return currentDuration;
  }
}

/**
 * POST /twilio/call-status
 * Twilio posts application/x-www-form-urlencoded
 */
twilioCallStatusRouter.post("/call-status", async (req: Request, res: Response) => {
  // Always ACK Twilio fast
  res.status(200).send("OK");

  try {
    const params: Record<string, any> = req.body || {};

    const callRecordId =
      (req.query.call_record_id as string) ||
      params.call_record_id ||
      params.CallRecordId ||
      "";

    if (!callRecordId) {
      console.warn("[twilioCallStatus] Missing call_record_id (cannot update Base44)");
      return;
    }

    // Optional signature validation (recommended once stable)
    const skipSig =
      String(process.env.TWILIO_SKIP_SIGNATURE_VALIDATION || "").toLowerCase() === "true" ||
      process.env.TWILIO_SKIP_SIGNATURE_VALIDATION === "1";

    if (!skipSig) {
      const authToken = process.env.TWILIO_AUTH_TOKEN || "";
      const sigHeader = req.header("X-Twilio-Signature") || "";
      const validationUrl =
        (process.env.TWILIO_CALL_STATUS_URL || "").trim() ||
        `${req.protocol}://${req.get("host")}${req.originalUrl.split("?")[0]}`;

      const valid = twilio.validateRequest(authToken, sigHeader, validationUrl, params);
      if (!valid) {
        console.warn("[twilioCallStatus] Invalid signature; ignoring update");
        return;
      }
    }

    const callSid = params.DialCallSid || params.CallSid || params.ParentCallSid;
    const from = params.From || params.Caller;
    const to = params.To || params.Called || params.DialTo;

    const callStatus = params.CallStatus || params.DialCallStatus || params.RecordingStatus;
    const mapped = mapStatus(callStatus);

    let duration =
      asNumber(params.CallDuration) ??
      asNumber(params.DialCallDuration) ??
      asNumber(params.RecordingDuration);

    // If Twilio doesn't give duration, fetch on completed (optional)
    if (mapped === "completed") {
      duration = await twilioFetchDurationIfNeeded(String(callSid || ""), duration);
    }

    // Build Base44 update payload
    const updatePayload: Record<string, any> = {};
    if (mapped) updatePayload.status = mapped;
    if (typeof duration === "number") updatePayload.duration_seconds = duration;
    if (callSid) updatePayload.twilio_call_sid = String(callSid);
    if (from) updatePayload.from_number = String(from);
    if (to) updatePayload.to_number = String(to);

    if (Object.keys(updatePayload).length === 0) return;

    await ensureBase44Auth();

    // ✅ Update Base44 Call entity directly
    // Note: entity name must match your Base44 schema ("Call")
    await base44.entities.Call.update(callRecordId, updatePayload);

    // Optional debug log
    console.log("[twilioCallStatus] Updated Base44 Call", { callRecordId, updatePayload });
  } catch (e: any) {
    console.error("[twilioCallStatus] Error:", e?.stack || e);
  }
});

// Optional GET check
twilioCallStatusRouter.get("/call-status", (req: Request, res: Response) => {
  res.status(200).send("twilioCallStatus is live (POST required).");
});
