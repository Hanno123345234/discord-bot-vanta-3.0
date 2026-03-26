const form = document.getElementById("createLobbyForm");
const registrationInput = document.getElementById("registrationOpens");
const supporterTimeEl = document.getElementById("supporterTime");
const boosterTimeEl = document.getElementById("boosterTime");
const verifiedTimeEl = document.getElementById("verifiedTime");
const resultBox = document.getElementById("result");
const resultText = document.getElementById("resultText");
const resetBtn = document.getElementById("resetBtn");
const submitBtn = form.querySelector('button[type="submit"]');

const API_BASE = String(window.SCRIMS_API_BASE || "").trim().replace(/\/+$/, "");
const SCRIMS_GUILD_ID = String(window.SCRIMS_GUILD_ID || "").trim();
let isDiscordConnected = false;

function apiUrl(path) {
  return API_BASE ? `${API_BASE}${path}` : path;
}

async function fetchJsonWithFallback(paths, options) {
  let lastError = null;
  for (const path of paths) {
    try {
      const response = await fetch(apiUrl(path), options);
      const data = await response.json().catch(() => ({}));
      if (!response.ok && (response.status === 404 || response.status === 405)) {
        lastError = new Error(`HTTP ${response.status} for ${path}`);
        continue;
      }
      return { response, data, path };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Request failed.");
}

function addMinutes(hhmm, minutes) {
  const [h, m] = String(hhmm || "00:00").split(":").map(Number);
  const base = new Date();
  base.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0);
  base.setMinutes(base.getMinutes() + minutes);
  return `${String(base.getHours()).padStart(2, "0")}:${String(base.getMinutes()).padStart(2, "0")}`;
}

function refreshPriorityTimes() {
  const opens = registrationInput.value || "00:00";
  supporterTimeEl.textContent = addMinutes(opens, 1);
  boosterTimeEl.textContent = addMinutes(opens, 2);
  verifiedTimeEl.textContent = addMinutes(opens, 3);
}

registrationInput.addEventListener("input", refreshPriorityTimes);

resetBtn.addEventListener("click", () => {
  form.reset();
  document.getElementById("session").value = "1";
  document.getElementById("lobby").value = "1";
  registrationInput.value = "00:48";
  document.getElementById("lobbyTemplate").value = "duo-default";
  resultBox.hidden = true;
  refreshPriorityTimes();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!isDiscordConnected) {
    resultText.textContent = "Bitte zuerst mit Discord verbinden: /auth/discord";
    resultBox.hidden = false;
    return;
  }

  const payload = {
    session: Number(document.getElementById("session").value),
    lobby: Number(document.getElementById("lobby").value),
    registrationOpens: registrationInput.value,
    lobbyTemplate: document.getElementById("lobbyTemplate").value,
    guildId: SCRIMS_GUILD_ID || undefined,
  };

  submitBtn.disabled = true;
  submitBtn.textContent = "Creating...";

  try {
    const { response, data } = await fetchJsonWithFallback(["/api/scrims/create-lobby", "/api/create-lobby"], {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Lobby creation failed.");
    }

    resultText.textContent = `Erfolgreich: ${data.categoryName || "Lobby erstellt"}`;
    resultBox.hidden = false;
  } catch (error) {
    resultText.textContent = `Fehler: ${error.message || "Unknown error"}`;
    resultBox.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Create Lobby";
  }
});

refreshPriorityTimes();

async function loadDiscordSession() {
  try {
    const response = await fetch(apiUrl("/api/me"), { credentials: "include" });
    const data = await response.json().catch(() => ({}));
    isDiscordConnected = Boolean(response.ok && data && data.user && data.user.id);
    if (!isDiscordConnected) {
      submitBtn.disabled = true;
      resultText.textContent = "Discord nicht verbunden. Bitte zuerst einloggen: /auth/discord";
      resultBox.hidden = false;
      return;
    }
    submitBtn.disabled = false;
  } catch (error) {
    isDiscordConnected = false;
    submitBtn.disabled = true;
    resultText.textContent = "Discord-Session konnte nicht geprueft werden. Bitte erneut einloggen.";
    resultBox.hidden = false;
  }
}

async function checkScrimsHealth() {
  try {
    const { response, data } = await fetchJsonWithFallback(["/api/scrims/health", "/api/health"]);
    if (!response.ok || !data || data.ok !== true) {
      const missing = Array.isArray(data && data.missing) ? data.missing.join(", ") : "unbekannt";
      resultText.textContent = `Hinweis: Fehlende Konfiguration (${missing}).`;
      resultBox.hidden = false;
      return;
    }
  } catch (error) {
    resultText.textContent = "Hinweis: Health-Check nicht erreichbar.";
    resultBox.hidden = false;
  }
}

checkScrimsHealth();
loadDiscordSession();
