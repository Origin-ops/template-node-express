import { Router, Request, Response } from "express";

export const twilioCallStatusRouter = Router();

// Twilio posts x-www-form-urlencoded
twilioCallStatusRouter.post("/call-status", async (req: Request, res: Response) => {
  try {
    const params: Record<string, any> = req.body || {};
    const callRecordId =
      (req.query.call_record_id as string) ||
      params.call_record_id ||
      params.CallRecordId ||
      "";

    console.log("HIT twilioCallStatus", {
      callRecordId,
      CallSid: params.CallSid,
      CallStatus: params.CallStatus,
      To: params.To,
      From: params.From,
      Timestamp: params.Timestamp,
    });

    // For now: just acknowledge to stop Twilio errors.
    // Next step we’ll update Base44 from here.
    return res.status(200).send("OK");
  } catch (e: any) {
    console.error("twilioCallStatus error:", e?.stack || e);
    // Always 200 so Twilio doesn’t retry endlessly
    return res.status(200).send("OK");
  }
});

// Optional GET check in browser
twilioCallStatusRouter.get("/call-status", (req: Request, res: Response) => {
  res.status(200).send("twilioCallStatus is live (POST required).");
});
