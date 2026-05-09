import { promises as fs } from "node:fs";
import path from "node:path";
import { SLOTS, slotInRange } from "./slots.js";

export type Rsvp = {
  id: string;
  name: string;
  start: string; // boundary, inclusive
  end: string;   // boundary, exclusive
  createdAt: string;
  updatedAt: string;
};

type Shape = { rsvps: Rsvp[] };

const DATA_DIR = path.resolve(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "rsvps.json");

let cache: Shape | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function load(): Promise<Shape> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    cache = JSON.parse(raw) as Shape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    cache = { rsvps: [] };
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const snapshot = JSON.stringify(cache, null, 2);
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, snapshot, "utf8");
  await fs.rename(tmp, DATA_FILE);
}

function enqueueWrite(): Promise<void> {
  writeChain = writeChain.then(persist, persist);
  return writeChain;
}

export async function listRsvps(): Promise<Rsvp[]> {
  const db = await load();
  return db.rsvps.slice();
}

export async function getRsvp(id: string): Promise<Rsvp | undefined> {
  const db = await load();
  return db.rsvps.find((r) => r.id === id);
}

export async function upsertRsvp(input: {
  id?: string;
  name: string;
  start: string;
  end: string;
}): Promise<Rsvp> {
  const db = await load();
  const now = new Date().toISOString();
  if (input.id) {
    const existing = db.rsvps.find((r) => r.id === input.id);
    if (existing) {
      existing.name = input.name;
      existing.start = input.start;
      existing.end = input.end;
      existing.updatedAt = now;
      await enqueueWrite();
      return existing;
    }
  }
  const created: Rsvp = {
    id: input.id ?? crypto.randomUUID(),
    name: input.name,
    start: input.start,
    end: input.end,
    createdAt: now,
    updatedAt: now,
  };
  db.rsvps.push(created);
  await enqueueWrite();
  return created;
}

export async function deleteRsvp(id: string): Promise<boolean> {
  const db = await load();
  const idx = db.rsvps.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  db.rsvps.splice(idx, 1);
  await enqueueWrite();
  return true;
}

// Coverage count per 30-min block: how many RSVPs have a range that includes
// each block.
export async function countsBySlot(): Promise<Record<string, number>> {
  const rsvps = await listRsvps();
  const counts: Record<string, number> = {};
  for (const s of SLOTS) counts[s] = 0;
  for (const r of rsvps) {
    for (const s of SLOTS) {
      if (slotInRange(s, r.start, r.end)) counts[s]++;
    }
  }
  return counts;
}
