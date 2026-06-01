// 30-minute time blocks from noon to 8pm.
// SLOTS = the 16 block START times (12:00, 12:30, ..., 19:30).
// BOUNDARIES = the 17 endpoints (12:00, 12:30, ..., 20:00) usable as
//              start/end of an RSVP range. End is exclusive.

const FIRST_MIN = 12 * 60;   // noon
const LAST_MIN = 17 * 60;    // 5 pm
const STEP = 30;

function fmt(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export const SLOTS: string[] = (() => {
  const out: string[] = [];
  for (let m = FIRST_MIN; m < LAST_MIN; m += STEP) out.push(fmt(m));
  return out;
})();

export const BOUNDARIES: string[] = (() => {
  const out: string[] = [];
  for (let m = FIRST_MIN; m <= LAST_MIN; m += STEP) out.push(fmt(m));
  return out;
})();

export const BOUNDARY_SET = new Set(BOUNDARIES);

export function toMinutes(boundary: string): number {
  const [h, m] = boundary.split(":").map(Number);
  return h * 60 + m;
}

export function formatTimeLabel(boundary: string): string {
  const [hStr, mStr] = boundary.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (h === 24 || (h === 20 && m === 0)) {
    // 8 pm, etc.
  }
  const period = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}:00 ${period}` : `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

export function formatRange(start: string, end: string): string {
  return `${formatTimeLabel(start)} – ${formatTimeLabel(end)}`;
}

// True if the 30-min block starting at `slot` is covered by [start, end).
export function slotInRange(slot: string, start: string, end: string): boolean {
  const s = toMinutes(slot);
  return toMinutes(start) <= s && s < toMinutes(end);
}
