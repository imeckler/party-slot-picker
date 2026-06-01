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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const PORT = Number(process.env.PORT ?? 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "change-me";
// When set, every guest-facing route requires either ?password=XXX (which
// installs a cookie) or a previously-set cookie. Leave unset to disable.
const SITE_PASSWORD = process.env.SITE_PASSWORD ?? "";
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
  const start = typeof req.body?.start === "string" ? req.body.start : "";
  const end = typeof req.body?.end === "string" ? req.body.end : "";

  if (!name) return res.status(400).json({ error: "Name is required." });
  if (name.length > 80) return res.status(400).json({ error: "Name too long." });
  if (!BOUNDARY_SET.has(start) || !BOUNDARY_SET.has(end)) {
    return res.status(400).json({ error: "Invalid time range." });
  }
  if (toMinutes(end) <= toMinutes(start)) {
    return res.status(400).json({ error: "End time must be after start time." });
  }

  const existingId: string | undefined = req.cookies[RSVP_COOKIE];
  const rsvp = await upsertRsvp({ id: existingId, name, start, end });

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
  // Per-slot attendee list = anyone whose range covers that block.
  const slots = SLOTS.map((s) => {
    const attendees = rsvps
      .filter((r) => slotInRange(s, r.start, r.end))
      .map((r) => ({
        id: r.id,
        name: r.name,
        start: r.start,
        end: r.end,
        startLabel: formatTimeLabel(r.start),
        endLabel: formatTimeLabel(r.end),
        updatedAt: r.updatedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { time: s, label: formatTimeLabel(s), attendees };
  });

  const guests = rsvps
    .map((r) => ({
      id: r.id,
      name: r.name,
      start: r.start,
      end: r.end,
      startLabel: formatTimeLabel(r.start),
      endLabel: formatTimeLabel(r.end),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ total: rsvps.length, slots, guests });
});

app.delete("/api/admin/rsvps/:id", requireAdmin, async (req, res) => {
  const ok = await deleteRsvp(req.params.id);
  res.json({ ok });
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
});
