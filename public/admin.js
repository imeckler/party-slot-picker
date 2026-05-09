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
  totalEl.textContent = String(data.total);
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
    td.colSpan = 3;
    td.textContent = "No RSVPs yet.";
    tr.appendChild(td);
    guestRowsEl.appendChild(tr);
  } else {
    for (const g of data.guests) {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      tdName.textContent = g.name;
      const tdRange = document.createElement("td");
      tdRange.textContent = `${g.startLabel} – ${g.endLabel}`;
      const tdWhen = document.createElement("td");
      tdWhen.className = "muted";
      tdWhen.textContent = new Date(g.updatedAt).toLocaleString();
      tr.appendChild(tdName);
      tr.appendChild(tdRange);
      tr.appendChild(tdWhen);
      guestRowsEl.appendChild(tr);
    }
  }
  showDash();
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

load();
