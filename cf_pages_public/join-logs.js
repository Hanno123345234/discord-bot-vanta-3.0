const ADMIN_KEY_STORAGE = "admin_access_key_v1";
const JOIN_LOGS_KEY_DRAFT_STORAGE = "join_logs_access_key_draft_v1";

const infoEl = document.getElementById("joinLogsInfo");
const panelEl = document.getElementById("joinLogsPanel");
const listEl = document.getElementById("joinLogsList");
const keyInputEl = document.getElementById("joinLogsKeyInput");
const refreshBtn = document.getElementById("refreshJoinLogsBtn");

let adminKey = window.localStorage.getItem(ADMIN_KEY_STORAGE) || "";
const savedDraftKey = window.localStorage.getItem(JOIN_LOGS_KEY_DRAFT_STORAGE) || "";

if (savedDraftKey) {
  adminKey = savedDraftKey;
}

function setInfo(text) {
  infoEl.textContent = text;
}

function setLoggedIn(isLoggedIn) {
  panelEl.classList.toggle("hidden", !isLoggedIn);
  refreshBtn.classList.toggle("hidden", !isLoggedIn);
}

async function adminFetch(url, options = {}) {
  const headers = {
    ...(options.headers || {}),
    "x-admin-key": adminKey
  };
  return fetch(url, {
    ...options,
    headers,
    cache: "no-store"
  });
}

function renderJoinLogs(logs = []) {
  listEl.innerHTML = "";
  if (!logs.length) {
    const li = document.createElement("li");
    li.textContent = "Noch keine Join-Logs.";
    listEl.appendChild(li);
    return;
  }

  logs.slice(0, 250).forEach((entry) => {
    const li = document.createElement("li");
    const at = entry.at ? new Date(entry.at).toLocaleString("de-DE") : "-";
    li.textContent = `${at} • ${entry.action || "-"} • ${entry.name || "-"} • ${entry.fingerprint || "-"} • room:${entry.roomCode || "-"} • queue:${entry.queueType || "-"} • ip:${entry.ip || "-"}`;
    listEl.appendChild(li);
  });
}

async function loadJoinLogs() {
  setInfo("Lade Join-Logs…");
  try {
    const response = await adminFetch("/api/admin/join-logs");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Kein Zugriff");
    }
    renderJoinLogs(data.logs || []);
    setInfo(`Aktualisiert (${(data.logs || []).length} Events)`);
    setLoggedIn(true);
  } catch (error) {
    setLoggedIn(false);
    setInfo(error.message || "Join-Logs konnten nicht geladen werden");
  }
}

document.getElementById("joinLogsLoginBtn").addEventListener("click", async () => {
  adminKey = String(keyInputEl.value || "").trim();
  if (!adminKey) {
    setInfo("Bitte Admin-Key eingeben.");
    return;
  }
  window.localStorage.setItem(ADMIN_KEY_STORAGE, adminKey);
  window.localStorage.setItem(JOIN_LOGS_KEY_DRAFT_STORAGE, adminKey);
  await loadJoinLogs();
});

document.getElementById("joinLogsLogoutBtn").addEventListener("click", () => {
  adminKey = "";
  window.localStorage.removeItem(ADMIN_KEY_STORAGE);
  setLoggedIn(false);
  setInfo("Abgemeldet");
});

refreshBtn.addEventListener("click", loadJoinLogs);

keyInputEl.addEventListener("input", () => {
  const value = String(keyInputEl.value || "");
  window.localStorage.setItem(JOIN_LOGS_KEY_DRAFT_STORAGE, value);
});

if (adminKey) {
  keyInputEl.value = adminKey;
  loadJoinLogs();
} else {
  setLoggedIn(false);
  setInfo("Bitte einloggen");
}
