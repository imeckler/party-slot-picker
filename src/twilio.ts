// Minimal Twilio SMS client. Uses the REST API directly via fetch so we don't
// pull in the (heavy) twilio SDK. Config comes from env vars:
//   TWILIO_ACCOUNT_SID         - required
//   TWILIO_AUTH_TOKEN          - required
//   TWILIO_FROM_NUMBER         - sender, E.164 (e.g. +14155552671). Optional if
//   TWILIO_MESSAGING_SERVICE_SID - a Messaging Service to send from instead.

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? "";
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";
const FROM_NUMBER = process.env.TWILIO_FROM_NUMBER ?? "";
const MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID ?? "";

export function twilioConfigured(): boolean {
  return Boolean(ACCOUNT_SID && AUTH_TOKEN && (FROM_NUMBER || MESSAGING_SERVICE_SID));
}

// Send one SMS. Resolves on a 2xx from Twilio, throws otherwise (caller decides
// how to handle per-recipient failures).
export async function sendSms(to: string, body: string): Promise<void> {
  if (!twilioConfigured()) {
    throw new Error(
      "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER (or TWILIO_MESSAGING_SERVICE_SID).",
    );
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
  const params = new URLSearchParams({ To: to, Body: body });
  if (MESSAGING_SERVICE_SID) {
    params.set("MessagingServiceSid", MESSAGING_SERVICE_SID);
  } else {
    params.set("From", FROM_NUMBER);
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Twilio send to ${to} failed (HTTP ${resp.status}): ${text}`);
  }
}
