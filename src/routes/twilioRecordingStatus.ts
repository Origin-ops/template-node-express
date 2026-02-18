import { Router, Request, Response } from "express";
import { createClient } from "@base44/sdk";
import twilio from "twilio";

export const twilioRecordingStatusRouter = Router();

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

// ---- Base44 external client auth (same pattern you used for call-status) ----
const appId = process.env.BASE44_APP_ID || "";
if (!appId) console.warn("[twilioRecordingStatus] Missing BASE44_APP_ID");

const base44 = createClient({ appId });

let lastLoginAt = 0;
const LOGIN_TTL_MS = 50 * 60 * 1000;

async function ensureBase44Auth() {
  const email = process.env.BASE44_ADMIN_EMAIL || "";
  const password = process.env.BASE44_ADMIN_PASSWORD || "";
  if (!email || !password) throw new Error("Missing BASE44_ADMIN_EMAIL / BASE44_ADMIN_PASSWORD");

  const now = Date.now();
  if (now - lastLoginAt < LOGIN_TTL_MS) return;

  await base44.auth.loginViaEmailPassword(email, password);
  lastLoginAt = now;
}

// ---- Twilio API fallback: fetch latest recording for a CallSid ----
async function twilioFetchRecordingIfNeeded(callSid?: string, recordingUrl?: string, duration?: number) {
  const acct = process.env.TWILIO_ACCOUNT_SID || "";
  const token = process.env.TWILIO_AUTH_TOKEN || "";
  if (!acct || !token) return { recordingUrl, duration };

  if (!callSid) return { recordingUrl, duration };

  // Only do this if something is missing
  if (recordingUrl && typeof duration === "number" && Number.isFinite(duration)) {
    return { recordingUrl, duration };
  }

  try {
    const client = twilio(acct, token);
    const recs = await client.recordings.list({ callSid, limit: 1 });

    if (recs && recs.length > 0) {
      const r: any = recs[0];

      let url = recordingUrl;
      if (!url) {
        const baseUri = String(r.uri || "").replace(".json", "");
        url = baseUri ? `https://api.twilio.com${baseUri}.mp3` : url;
      }

      let dur = duration;
      if ((dur === undefined || !Number.isFinite(dur)) && r.duration !== undefined) {
        const n = Number(r.duration);
        if (Number.isFinite(n)) dur = n;
      }

      return { recordingUrl: url, duration: dur };
    }
  } catch (e: any) {
    console.warn("[twilioRecordingStatus] Twilio API fallback failed:", e?.message || e);
  }

  return { recordingUrl, duration };
}

/**
 * POST /twilio/recording-status
 * Twilio posts application/x-www-form-urlencoded
 */
twilioRecordingStatusRouter.post("/recording-status", async (req: Request, res: Response) => {
  // ACK Twilio immediately
  res.status(200).send("OK");

  try {
    const params: Record<string, any> = req.body || {};

    const callRecordId =
      (req.query.call_record_id as string) ||
      params.call_record_id ||
      params.CallRecordId ||
      "";

    if (!callRecordId) {
      console.warn("[twilioRecordingStatus] Missing call_record_id (cannot update Base44)");
      return;
    }

    // Optional signature validation
    const skipSig =
      String(process.env.TWILIO_SKIP_SIGNATURE_VALIDATION || "").toLowerCase() === "true" ||
      process.env.TWILIO_SKIP_SIGNATURE_VALIDATION === "1";

    if (!skipSig) {
      const authToken = process.env.TWILIO_AUTH_TOKEN || "";
      const sigHeader = req.header("X-Twilio-Signature") || "";

      const validationUrl =
        (process.env.TWILIO_RECORDING_STATUS_URL || "").trim() ||
        `${req.protocol}://${req.get("host")}${req.originalUrl.split("?")[0]}`;

      const valid = twilio.validateRequest(authToken, sigHeader, validationUrl, params);
      if (!valid) {
        console.warn("[twilioRecordingStatus] Invalid signature; ignoring update");
        return;
      }
    }

    // Extract key fields
    const recordingSid = params.RecordingSid || params.DialRecordingSid || null;
    const callSid = params.DialCallSid || params.CallSid || params.ParentCallSid || null;

    const from = params.From || params.Caller;
    const to = params.To || params.Called || params.DialTo;

    const callStatus = params.CallStatus || params.RecordingStatus;

    let recordingUrl: string | undefined =
      params.RecordingUrl || params.RecordingUri || params.DialRecordingUrl || undefined;

    if (recordingUrl && !recordingUrl.endsWith(".mp3")) {
      recordingUrl = `${recordingUrl}.mp3`;
    }

    let duration = asNumber(params.RecordingDuration);

    // If missing info, attempt Twilio API fallback (same intent as your Base44 function)
    const fallback = await twilioFetchRecordingIfNeeded(String(callSid || ""), recordingUrl, duration);
    recordingUrl = fallback.recordingUrl;
    duration = fallback.duration;

    // Build Base44 update payload
    const updatePayload: Record<string, any> = {};
    if (recordingUrl) updatePayload.recording_url = recordingUrl;
    if (typeof duration === "number" && Number.isFinite(duration)) updatePayload.duration_seconds = duration;
    if (callSid) updatePayload.twilio_call_sid = String(callSid);
    if (recordingSid) updatePayload.twilio_recording_sid = String(recordingSid);
    if (to) updatePayload.to_number = String(to);
    if (from) updatePayload.from_number = String(from);

    const mapped = mapStatus(callStatus);
    if (mapped) updatePayload.status = mapped;

    if (Object.keys(updatePayload).length === 0) return;

    await ensureBase44Auth();
    await base44.entities.Call.update(callRecordId, updatePayload);

    console.log("[twilioRecordingStatus] Updated Base44 Call", { callRecordId, updatePayload });
  } catch (e: any) {
    console.error("[twilioRecordingStatus] Error:", e?.stack || e);
  }
});

// Optional GET check
twilioRecordingStatusRouter.get("/recording-status", (req: Request, res: Response) => {
  res.status(200).send("twilioRecordingStatus is live (POST required).");
});
