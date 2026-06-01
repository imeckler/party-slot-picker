import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOUNDARIES,
  BOUNDARY_SET,
  SLOTS,
  formatTimeLabel,
  slotInRange,
  toMinutes,
} from "./slots.js";
import {
  countsBySlot,
  deleteRsvp,
  getRsvp,
  listRsvps,
  upsertRsvp,
} from "./db.js";
import {
  reminderStatus,
  sendReminder,
  startReminderScheduler,
  type ReminderKey,
} from "./reminders.js";
import { sendSms, twilioConfigured } from "./twilio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const PORT = Number(process.env.PORT ?? 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "change-me";
// When set, every guest-facing route requires either ?password=XXX (which
// installs a cookie) or a previously-set cookie. Leave unset to disable.
const SITE_PASSWORD = process.env.SITE_PASSWORD ?? "";
// When true, guests pick an arrival/departure time range and per-slot density is
// shown. When false (default), the RSVP is just name + phone — no times at all.
const COLLECT_TIMES = (process.env.COLLECT_TIMES ?? "false").toLowerCase() === "true";
// Allow `\n` in env vars to produce real line breaks (the .env file format
// can't carry actual newlines, so the convention is a literal backslash-n).
const expandNewlines = (s: string) => s.replace(/\\n/g, "\n");

const PARTY = {
  title: process.env.PARTY_TITLE ?? "The Party",
  address: expandNewlines(process.env.PARTY_ADDRESS ?? "123 Example St, Somewhere"),
  description: expandNewlines(
    process.env.PARTY_DESCRIPTION ??
      "Replace this with the real party description. Snacks, drinks, and good company. Come and go as you please.",
  ),
};

// Validate and normalize a US phone number to E.164 (+1XXXXXXXXXX).
// Accepts common formats: "(415) 555-2671", "415-555-2671", "+1 415 555 2671",
// "14155552671", etc. Returns null if it isn't a valid NANP US number.
function normalizeUsPhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  // Drop a leading country code "1" if present (11 digits total).
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  // NANP: area code and exchange code must start with 2-9.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
  return `+1${national}`;
}

const RSVP_COOKIE = "rsvp_id";
const ADMIN_COOKIE = "admin_session";
const SITE_COOKIE = "site_session";
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 365;

function requireSite(req: Request, res: Response, next: NextFunction) {
  if (!SITE_PASSWORD) return next();
  const provided = typeof req.query.password === "string" ? req.query.password : "";
  if (provided === SITE_PASSWORD) {
    res.cookie(SITE_COOKIE, SITE_PASSWORD, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: COOKIE_MAX_AGE,
    });
    return next();
  }
  if (req.cookies[SITE_COOKIE] === SITE_PASSWORD) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Password required." });
  }
  res
    .status(401)
    .type("html")
    .send(
      `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Password required</title></head>
<body style="font-family: system-ui, -apple-system, sans-serif; padding: 2rem; max-width: 28rem; margin: 0 auto; color: #222;">
<h1 style="margin-top: 0;">Password required</h1>
<p>This page is private. You need an invite link to view it.</p>
</body></html>`,
    );
}

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/public", express.static(PUBLIC_DIR));

// ---- Public API ---------------------------------------------------------

app.get("/api/slots", requireSite, async (_req, res) => {
  const counts = await countsBySlot();
  res.json({
    slots: SLOTS.map((s) => ({ time: s, label: formatTimeLabel(s), count: counts[s] ?? 0 })),
    boundaries: BOUNDARIES.map((b) => ({ time: b, label: formatTimeLabel(b) })),
  });
});

app.get("/api/me", requireSite, async (req, res) => {
  const id = req.cookies[RSVP_COOKIE];
  if (!id) return res.json({ rsvp: null });
  const rsvp = await getRsvp(id);
  res.json({ rsvp: rsvp ?? null });
});

app.post("/api/rsvp", requireSite, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const phoneRaw = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
  const start = typeof req.body?.start === "string" ? req.body.start : "";
  const end = typeof req.body?.end === "string" ? req.body.end : "";

  if (!name) return res.status(400).json({ error: "Name is required." });
  if (name.length > 80) return res.status(400).json({ error: "Name too long." });
  // The client normalizes to E.164 (+1 followed by 10 digits), but re-validate
  // here since the API is reachable directly. We also accept a raw 10/11-digit
  // US number as a fallback and normalize it ourselves.
  const phone = normalizeUsPhone(phoneRaw);
  if (!phone) return res.status(400).json({ error: "Please enter a valid US phone number." });
  if (COLLECT_TIMES) {
    if (!BOUNDARY_SET.has(start) || !BOUNDARY_SET.has(end)) {
      return res.status(400).json({ error: "Invalid time range." });
    }
    if (toMinutes(end) <= toMinutes(start)) {
      return res.status(400).json({ error: "End time must be after start time." });
    }
  }

  const existingId: string | undefined = req.cookies[RSVP_COOKIE];
  const rsvp = await upsertRsvp({
    id: existingId,
    name,
    phone,
    start: COLLECT_TIMES ? start : undefined,
    end: COLLECT_TIMES ? end : undefined,
  });

  res.cookie(RSVP_COOKIE, rsvp.id, {
    httpOnly: false,
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
  });

  res.json({ rsvp, party: PARTY });
});

app.post("/api/rsvp/clear", requireSite, async (req, res) => {
  const id = req.cookies[RSVP_COOKIE];
  if (id) await deleteRsvp(id);
  res.clearCookie(RSVP_COOKIE);
  res.json({ ok: true });
});

app.get("/api/party", requireSite, (_req, res) => {
  res.json({ party: PARTY });
});

app.get("/api/config", requireSite, (_req, res) => {
  res.json({ collectTimes: COLLECT_TIMES });
});

// ---- Admin --------------------------------------------------------------

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.cookies[ADMIN_COOKIE] === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: "Unauthorized" });
}

app.post("/api/admin/login", (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Wrong password." });
  }
  res.cookie(ADMIN_COOKIE, ADMIN_PASSWORD, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
  });
  res.json({ ok: true });
});

app.post("/api/admin/logout", (_req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.json({ ok: true });
});

app.get("/api/admin/rsvps", requireAdmin, async (_req, res) => {
  const rsvps = await listRsvps();
  // Per-slot attendee list = anyone whose range covers that block. Only
  // meaningful when times are collected; otherwise it's an empty list.
  const slots = COLLECT_TIMES
    ? SLOTS.map((s) => {
        const attendees = rsvps
          .filter((r) => r.start && r.end && slotInRange(s, r.start, r.end))
          .map((r) => ({
            id: r.id,
            name: r.name,
            start: r.start,
            end: r.end,
            startLabel: formatTimeLabel(r.start!),
            endLabel: formatTimeLabel(r.end!),
            updatedAt: r.updatedAt,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { time: s, label: formatTimeLabel(s), attendees };
      })
    : [];

  const guests = rsvps
    .map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone ?? "",
      start: r.start,
      end: r.end,
      startLabel: r.start ? formatTimeLabel(r.start) : "",
      endLabel: r.end ? formatTimeLabel(r.end) : "",
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ total: rsvps.length, collectTimes: COLLECT_TIMES, slots, guests });
});

app.delete("/api/admin/rsvps/:id", requireAdmin, async (req, res) => {
  const ok = await deleteRsvp(req.params.id);
  res.json({ ok });
});

// ---- SMS reminders ------------------------------------------------------

const REMINDER_KEYS: ReminderKey[] = ["2-days-before", "day-of"];

app.get("/api/admin/reminders", requireAdmin, async (_req, res) => {
  res.json(await reminderStatus());
});

// Manually fire a reminder wave now (force re-send even if already sent).
app.post("/api/admin/reminders/:key/send", requireAdmin, async (req, res) => {
  const key = req.params.key as ReminderKey;
  if (!REMINDER_KEYS.includes(key)) {
    return res.status(400).json({ error: "Unknown reminder." });
  }
  if (!twilioConfigured()) {
    return res.status(400).json({ error: "Twilio is not configured." });
  }
  const result = await sendReminder(key, PARTY, { force: true });
  res.json({ ok: true, result });
});

// Send a one-off test SMS to a single number (sanity-check Twilio config).
app.post("/api/admin/reminders/test", requireAdmin, async (req, res) => {
  const to = normalizeUsPhone(typeof req.body?.to === "string" ? req.body.to : "");
  if (!to) return res.status(400).json({ error: "Valid US phone number required." });
  if (!twilioConfigured()) {
    return res.status(400).json({ error: "Twilio is not configured." });
  }
  try {
    await sendSms(to, `Test message from ${PARTY.title}. Twilio is working.`);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Send failed." });
  }
});

// ---- Pages --------------------------------------------------------------

app.get("/", requireSite, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.listen(PORT, () => {
  console.log(`slot-picker listening on http://localhost:${PORT}`);
  if (ADMIN_PASSWORD === "change-me") {
    console.warn("⚠  Using default ADMIN_PASSWORD=change-me. Set ADMIN_PASSWORD env var.");
  }
  startReminderScheduler(PARTY);
});
