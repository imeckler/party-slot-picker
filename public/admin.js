const loginEl = document.getElementById("login");
const dashEl = document.getElementById("dashboard");
const passEl = document.getElementById("password");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const rowsEl = document.getElementById("rows");
const guestRowsEl = document.getElementById("guest-rows");
const totalEl = document.getElementById("total");
const refreshBtn = document.getElementById("refresh");
const logoutBtn = document.getElementById("logout");
const remindersStatusEl = document.getElementById("reminders-status");
const reminderRowsEl = document.getElementById("reminder-rows");
const reminderMsgEl = document.getElementById("reminder-msg");
const testToEl = document.getElementById("test-to");
const testSendBtn = document.getElementById("test-send");

const REMINDER_LABELS = { "2-days-before": "2 days before", "day-of": "Day of" };

// Render a stored E.164 US number (+1XXXXXXXXXX) as "(XXX) XXX-XXXX".
function formatUsPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

function showLogin() {
  loginEl.style.display = "block";
  dashEl.style.display = "none";
  passEl.focus();
}
function showDash() {
  loginEl.style.display = "none";
  dashEl.style.display = "block";
}

async function load() {
  const r = await fetch("api/admin/rsvps");
  if (r.status === 401) {
    showLogin();
    return;
  }
  const data = await r.json();
  const collectTimes = !!data.collectTimes;
  totalEl.textContent = String(data.total);
  // Per-slot density and the guest Range column only apply when times are collected.
  document.getElementById("perslot-section").style.display = collectTimes ? "block" : "none";
  document.getElementById("range-col").style.display = collectTimes ? "" : "none";
  rowsEl.innerHTML = "";
  for (const slot of data.slots) {
    const tr = document.createElement("tr");
    if (slot.attendees.length === 0) tr.classList.add("empty-row");

    const tdTime = document.createElement("td");
    tdTime.className = "time";
    tdTime.textContent = slot.label;

    const tdCount = document.createElement("td");
    tdCount.className = "count";
    tdCount.textContent = String(slot.attendees.length);

    const tdAtt = document.createElement("td");
    if (slot.attendees.length === 0) {
      tdAtt.textContent = "—";
    } else {
      for (const a of slot.attendees) {
        const chip = document.createElement("span");
        chip.className = "attendee-chip";
        chip.textContent = a.name;
        chip.title = `${a.startLabel} – ${a.endLabel} · updated ${new Date(a.updatedAt).toLocaleString()}`;
        tdAtt.appendChild(chip);
      }
    }
    tr.appendChild(tdTime);
    tr.appendChild(tdCount);
    tr.appendChild(tdAtt);
    rowsEl.appendChild(tr);
  }

  guestRowsEl.innerHTML = "";
  if (data.guests.length === 0) {
    const tr = document.createElement("tr");
    tr.classList.add("empty-row");
    const td = document.createElement("td");
    td.colSpan = collectTimes ? 4 : 3;
    td.textContent = "No RSVPs yet.";
    tr.appendChild(td);
    guestRowsEl.appendChild(tr);
  } else {
    for (const g of data.guests) {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      tdName.textContent = g.name;
      const tdPhone = document.createElement("td");
      if (g.phone) {
        const link = document.createElement("a");
        link.href = `tel:${g.phone}`;
        link.textContent = formatUsPhone(g.phone);
        tdPhone.appendChild(link);
      } else {
        tdPhone.textContent = "—";
      }
      const tdWhen = document.createElement("td");
      tdWhen.className = "muted";
      tdWhen.textContent = new Date(g.updatedAt).toLocaleString();
      tr.appendChild(tdName);
      tr.appendChild(tdPhone);
      if (collectTimes) {
        const tdRange = document.createElement("td");
        tdRange.textContent = `${g.startLabel} – ${g.endLabel}`;
        tr.appendChild(tdRange);
      }
      tr.appendChild(tdWhen);
      guestRowsEl.appendChild(tr);
    }
  }
  await loadReminders();
  showDash();
}

async function loadReminders() {
  reminderMsgEl.textContent = "";
  const r = await fetch("api/admin/reminders");
  if (!r.ok) return;
  const data = await r.json();
  remindersStatusEl.textContent = data.configured
    ? `Twilio configured. Event date: ${data.eventDate}.`
    : "Twilio not configured — reminders are disabled. Set TWILIO_* env vars.";
  reminderRowsEl.innerHTML = "";
  for (const w of data.waves) {
    const tr = document.createElement("tr");

    const tdWave = document.createElement("td");
    tdWave.textContent = REMINDER_LABELS[w.key] ?? w.key;

    const tdAt = document.createElement("td");
    tdAt.textContent = new Date(w.sendAt).toLocaleString();

    const tdStatus = document.createElement("td");
    tdStatus.textContent = w.sent
      ? `Sent ${new Date(w.sent.sentAt).toLocaleString()} — ${w.sent.ok} ok, ${w.sent.failed} failed`
      : "Not sent yet";

    const tdAction = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary";
    btn.textContent = w.sent ? "Re-send now" : "Send now";
    btn.disabled = !data.configured;
    btn.addEventListener("click", () => sendWave(w.key));
    tdAction.appendChild(btn);

    tr.append(tdWave, tdAt, tdStatus, tdAction);
    reminderRowsEl.appendChild(tr);
  }
}

async function sendWave(key) {
  const label = REMINDER_LABELS[key] ?? key;
  if (!confirm(`Send the "${label}" reminder SMS to all guests now?`)) return;
  reminderMsgEl.textContent = "Sending…";
  const r = await fetch(`api/admin/reminders/${key}/send`, { method: "POST" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    reminderMsgEl.textContent = data.error ?? "Send failed.";
    return;
  }
  reminderMsgEl.textContent = `Done — ${data.result.ok} sent, ${data.result.failed} failed.`;
  await loadReminders();
}

async function sendTest() {
  const to = testToEl.value.trim();
  if (!to) {
    reminderMsgEl.textContent = "Enter a phone number first.";
    return;
  }
  reminderMsgEl.textContent = "Sending test…";
  const r = await fetch("api/admin/reminders/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  const data = await r.json().catch(() => ({}));
  reminderMsgEl.textContent = r.ok ? "Test sent." : (data.error ?? "Send failed.");
}

async function login() {
  loginError.classList.remove("visible");
  const password = passEl.value;
  const r = await fetch("api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) {
    loginError.textContent = "Wrong password.";
    loginError.classList.add("visible");
    return;
  }
  passEl.value = "";
  await load();
}

async function logout() {
  await fetch("api/admin/logout", { method: "POST" });
  showLogin();
}

loginBtn.addEventListener("click", login);
passEl.addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
refreshBtn.addEventListener("click", load);
logoutBtn.addEventListener("click", logout);
testSendBtn.addEventListener("click", sendTest);

load();
