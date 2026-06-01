// SMS reminder scheduler. Sends two reminder waves to every guest with a phone
// number: one 2 days before the event, one on the day of. State is persisted to
// data/reminders.json so restarts never re-send a wave that already went out.

import { promises as fs } from "node:fs";
import path from "node:path";
import { listRsvps, type Rsvp } from "./db.js";
import { formatRange } from "./slots.js";
import { sendSms, twilioConfigured } from "./twilio.js";

export type Party = { title: string; address: string; description: string };

export type ReminderKey = "2-days-before" | "day-of";

type SentRecord = { sentAt: string; ok: number; failed: number };
type State = { sent: Partial<Record<ReminderKey, SentRecord>> };

// Event date (YYYY-MM-DD), the hour of day to send reminders, and the timezone
// those are interpreted in. Defaults target June 19th 2026, 10am Pacific —
// pinned to a named zone so it's correct regardless of the container's TZ.
const EVENT_DATE = process.env.EVENT_DATE ?? "2026-06-19";
const SEND_HOUR = Number(process.env.REMINDER_SEND_HOUR ?? 10);
const REMINDER_TZ = process.env.REMINDER_TZ ?? "America/Los_Angeles";

// Offset (ms) of `tz` from UTC at the given instant: tz_local_wallclock - UTC.
// Uses Intl (Node's bundled ICU has tz data even on alpine without OS tzdata).
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  // %H can come back as "24" at midnight in some environments; treat as 0.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - at.getTime();
}

// The UTC instant for a wall-clock time (y-m-d h:mm) in timezone `tz`.
function zonedTime(y: number, m: number, d: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  let result = new Date(guess - tzOffsetMs(new Date(guess), tz));
  // One correction pass handles DST-boundary cases where the offset differs at
  // the guessed vs. the corrected instant.
  const corrected = guess - tzOffsetMs(result, tz);
  if (corrected !== result.getTime()) result = new Date(corrected);
  return result;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const STATE_FILE = path.join(DATA_DIR, "reminders.json");

function eventParts(): [number, number, number] {
  const [y, m, d] = EVENT_DATE.split("-").map(Number);
  return [y, m, d];
}

// The two reminder waves with their send times (SEND_HOUR in REMINDER_TZ).
export function reminderSchedule(): { key: ReminderKey; sendAt: Date; label: string }[] {
  const [y, m, d] = eventParts();
  return [
    { key: "2-days-before", sendAt: zonedTime(y, m, d - 2, SEND_HOUR, 0, REMINDER_TZ), label: "2 days before" },
    { key: "day-of", sendAt: zonedTime(y, m, d, SEND_HOUR, 0, REMINDER_TZ), label: "day of" },
  ];
}

// End of the event day (in REMINDER_TZ) — past this, a never-sent wave is too
// stale to auto-fire (guards against a late first deploy blasting old guests).
function eventCutoff(): number {
  const [y, m, d] = eventParts();
  return zonedTime(y, m, d, 23, 59, REMINDER_TZ).getTime();
}

async function loadState(): Promise<State> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as State;
    return { sent: parsed.sent ?? {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { sent: {} };
  }
}

async function saveState(state: State): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, STATE_FILE);
}

function messageFor(key: ReminderKey, rsvp: Rsvp, party: Party): string {
  const when = key === "day-of" ? "today" : "in 2 days";
  const coming =
    rsvp.start && rsvp.end ? ` You're coming ${formatRange(rsvp.start, rsvp.end)}.` : "";
  return `Reminder: ${party.title} is ${when}!${coming} ${party.address}`;
}

// Send one reminder wave to all guests. No-op (returns the prior record) if the
// wave already went out, unless force is set. Records ok/failed counts.
export async function sendReminder(
  key: ReminderKey,
  party: Party,
  opts: { force?: boolean } = {},
): Promise<SentRecord> {
  const state = await loadState();
  if (!opts.force && state.sent[key]) return state.sent[key]!;

  const guests = await listRsvps();
  let ok = 0;
  let failed = 0;
  for (const g of guests) {
    if (!g.phone) {
      failed++;
      continue;
    }
    try {
      await sendSms(g.phone, messageFor(key, g, party));
      ok++;
    } catch (err) {
      failed++;
      console.error(`reminder ${key} -> ${g.name} (${g.phone}) failed:`, err);
    }
  }

  const rec: SentRecord = { sentAt: new Date().toISOString(), ok, failed };
  state.sent[key] = rec;
  await saveState(state);
  console.log(`reminder ${key}: sent ${ok}, failed ${failed}`);
  return rec;
}

// Status for the admin view: schedule + what's been sent.
export async function reminderStatus(): Promise<{
  configured: boolean;
  eventDate: string;
  waves: { key: ReminderKey; label: string; sendAt: string; sent: SentRecord | null }[];
}> {
  const state = await loadState();
  return {
    configured: twilioConfigured(),
    eventDate: EVENT_DATE,
    waves: reminderSchedule().map((w) => ({
      key: w.key,
      label: w.label,
      sendAt: w.sendAt.toISOString(),
      sent: state.sent[w.key] ?? null,
    })),
  };
}

let timer: ReturnType<typeof setInterval> | null = null;

// Start the background scheduler. Checks every 5 minutes (and once at startup)
// whether either wave is due and not yet sent.
export function startReminderScheduler(party: Party): void {
  if (!twilioConfigured()) {
    console.warn("⚠  Twilio not configured; SMS reminders disabled. Set TWILIO_* env vars to enable.");
    return;
  }
  if (timer) return;

  const tick = async () => {
    const now = Date.now();
    const cutoff = eventCutoff();
    const state = await loadState();
    for (const w of reminderSchedule()) {
      if (state.sent[w.key]) continue;
      if (now >= w.sendAt.getTime() && now <= cutoff) {
        await sendReminder(w.key, party);
      }
    }
  };

  tick().catch((e) => console.error("reminder tick failed:", e));
  timer = setInterval(() => tick().catch((e) => console.error("reminder tick failed:", e)), 5 * 60 * 1000);
  console.log(`SMS reminders enabled for ${EVENT_DATE} (send hour ${SEND_HOUR}:00 ${REMINDER_TZ}).`);
}
