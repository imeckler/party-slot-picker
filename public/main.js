// Guest RSVP page with range selection.
// Tap a slot to set the start of your range; tap a second slot to set the end.
// Both clicked slots are included. Tap again after a range is set to start over.

const slotsEl = document.getElementById("slots");
const nameEl = document.getElementById("name");
const submitEl = document.getElementById("submit");
const errorEl = document.getElementById("error");
const rangeDisplayEl = document.getElementById("range-display");
const headerDefaultEl = document.getElementById("header-default");
const headerPartyEl = document.getElementById("header-party");
const partyTitleEl = document.getElementById("party-title");
const partyDescEl = document.getElementById("party-description");
const partyAddrEl = document.getElementById("party-address");
const partyRangeEl = document.getElementById("party-range");

let slots = [];        // [{ time: "HH:MM" (start of 30-min block), label, count }]
let boundaries = [];   // [{ time, label }] — 17 boundaries for start..end
// Selection: range is represented as inclusive of `firstClick` and `lastClick`,
// where each is one of the slot start times. The persisted [start, end) is
// then [firstClick, lastClick + 30min).
let firstClick = null;
let lastClick = null;
let myExistingRsvp = null;

function toMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function plus30(t) {
  const m = toMinutes(t) + 30;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
function labelFor(boundary) {
  const found = boundaries.find((b) => b.time === boundary);
  if (found) return found.label;
  // Fallback: format ourselves.
  const [h, m] = boundary.split(":").map(Number);
  const period = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}:00 ${period}` : `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// ---- Density coloring ----
function colorForCount(count, max) {
  if (count <= 0) return "#ffffff";
  const ceiling = Math.max(5, max);
  const t = Math.min(1, count / ceiling);
  const sat = Math.round(20 + 70 * t);
  const light = Math.round(100 - 40 * t);
  return `hsl(140, ${sat}%, ${light}%)`;
}

function inSelectedRange(slotTime) {
  if (firstClick === null) return false;
  const a = toMinutes(firstClick);
  const b = lastClick === null ? a : toMinutes(lastClick);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const t = toMinutes(slotTime);
  return t >= lo && t <= hi;
}

function rangeBoundaries() {
  if (firstClick === null) return null;
  const a = toMinutes(firstClick);
  const b = lastClick === null ? a : toMinutes(lastClick);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  // Convert minutes back to HH:MM
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { start: fmt(lo), end: fmt(hi + 30) };
}

function render() {
  const max = slots.reduce((m, s) => Math.max(m, s.count), 0);
  slotsEl.innerHTML = "";
  for (const s of slots) {
    const row = document.createElement("div");
    row.className = "slot";
    row.style.background = colorForCount(s.count, max);
    row.tabIndex = 0;
    row.dataset.time = s.time;

    const inRange = inSelectedRange(s.time);
    if (inRange) row.classList.add("selected");
    if (firstClick === s.time && lastClick === null) row.classList.add("range-start-only");

    const time = document.createElement("div");
    time.className = "time";
    time.textContent = s.label;
    row.appendChild(time);
    row.addEventListener("click", () => handleClick(s.time));
    row.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        handleClick(s.time);
      }
    });
    slotsEl.appendChild(row);
  }
  updateRangeDisplay();
  updateSubmitState();
}

function handleClick(time) {
  if (firstClick === null) {
    firstClick = time;
    lastClick = null;
  } else if (lastClick === null) {
    // Second click finalizes the range. If they tap the same row, range is
    // a single 30-min block. Otherwise it's the inclusive span.
    lastClick = time;
  } else {
    // Range was already complete — start over with this click.
    firstClick = time;
    lastClick = null;
  }
  render();
}

function updateRangeDisplay() {
  const r = rangeBoundaries();
  if (!r) {
    rangeDisplayEl.textContent = "Tap a row to set your arrival time, then tap another to set when you'll leave.";
    rangeDisplayEl.classList.remove("set");
  } else if (lastClick === null) {
    rangeDisplayEl.textContent = `Arriving at ${labelFor(r.start)} — tap another row to set when you'll leave.`;
    rangeDisplayEl.classList.remove("set");
  } else {
    rangeDisplayEl.textContent = `${labelFor(r.start)} → ${labelFor(r.end)}`;
    rangeDisplayEl.classList.add("set");
  }
}

function updateSubmitState() {
  const r = rangeBoundaries();
  const ready = !!r && lastClick !== null && nameEl.value.trim().length > 0;
  submitEl.disabled = !ready;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.add("visible");
}

function clearError() {
  errorEl.textContent = "";
  errorEl.classList.remove("visible");
}

async function loadSlots() {
  const r = await fetch("api/slots");
  const data = await r.json();
  slots = data.slots;
  boundaries = data.boundaries;
}

async function loadMe() {
  const r = await fetch("api/me");
  const data = await r.json();
  if (data.rsvp) {
    myExistingRsvp = data.rsvp;
    nameEl.value = data.rsvp.name;
    // Restore inclusive endpoints from stored half-open range.
    firstClick = data.rsvp.start;
    const endMin = toMinutes(data.rsvp.end) - 30;
    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    lastClick = fmt(endMin);
    // Swap to the party-info header since this person has already RSVPed.
    try {
      const pr = await fetch("api/party");
      const pdata = await pr.json();
      showParty(pdata.party, data.rsvp, { scroll: false });
    } catch {
      // Non-fatal; submitting will fetch the party info again.
    }
  }
}

async function submit() {
  clearError();
  const name = nameEl.value.trim();
  const r = rangeBoundaries();
  if (!name) return showError("Please enter your name.");
  if (!r || lastClick === null) return showError("Please pick a time range.");
  submitEl.disabled = true;
  try {
    const resp = await fetch("api/rsvp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, start: r.start, end: r.end }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      showError(data.error ?? "Something went wrong.");
      submitEl.disabled = false;
      return;
    }
    myExistingRsvp = data.rsvp;
    showParty(data.party, data.rsvp);
  } catch (err) {
    showError("Network error. Try again.");
    submitEl.disabled = false;
  }
}

function showParty(party, rsvp, { scroll = true } = {}) {
  partyTitleEl.textContent = party.title;
  partyDescEl.textContent = party.description;
  partyAddrEl.textContent = party.address;
  partyRangeEl.textContent = `${labelFor(rsvp.start)} → ${labelFor(rsvp.end)}`;
  headerDefaultEl.style.display = "none";
  headerPartyEl.style.display = "block";
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

nameEl.addEventListener("input", updateSubmitState);
submitEl.addEventListener("click", submit);

// Once we've been let in, the cookie carries us — scrub the password from the
// URL so a shared screenshot or refresh doesn't leak the invite token.
(function stripPasswordParam() {
  const params = new URLSearchParams(location.search);
  if (!params.has("password")) return;
  params.delete("password");
  const qs = params.toString();
  const cleaned = location.pathname + (qs ? "?" + qs : "") + location.hash;
  history.replaceState(null, "", cleaned);
})();

(async function init() {
  await Promise.all([loadSlots(), loadMe()]);
  render();
})();
