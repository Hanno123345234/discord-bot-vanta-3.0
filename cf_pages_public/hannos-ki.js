const KI_SESSIONS_KEY = "hannos_ki_sessions_v1";
const KI_ACTIVE_SESSION_KEY = "hannos_ki_active_session_v1";
const MAX_SESSIONS = 40;
const MAX_MESSAGES_PER_SESSION = 120;

const newChatBtn = document.getElementById("newChatBtn");
const chatSessionList = document.getElementById("chatSessionList");
const kiMessages = document.getElementById("kiMessages");
const kiInput = document.getElementById("kiInput");
const kiSendBtn = document.getElementById("kiSendBtn");
const kiStatus = document.getElementById("kiStatus");

let sending = false;
let sessions = loadSessions();
let activeSessionId = window.localStorage.getItem(KI_ACTIVE_SESSION_KEY) || "";

function getApiBase() {
  const configured = String(window.QUIZ_ONLINE_ORIGIN || "").trim();
  return configured || window.location.origin;
}

function setStatus(text) {
  kiStatus.textContent = String(text || "");
}

function makeId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadSessions() {
  try {
    const raw = window.localStorage.getItem(KI_SESSIONS_KEY) || "";
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((session) => ({
        id: String(session?.id || makeId()),
        title: String(session?.title || "Neuer Chat").slice(0, 80),
        createdAt: Number(session?.createdAt || Date.now()),
        updatedAt: Number(session?.updatedAt || Date.now()),
        messages: Array.isArray(session?.messages)
          ? session.messages
            .map((message) => ({
              role: message?.role === "user" ? "user" : "ai",
              text: String(message?.text || "").slice(0, 2000),
              at: Number(message?.at || Date.now())
            }))
            .filter((message) => message.text)
          : []
      }))
      .slice(0, MAX_SESSIONS);
  } catch {
    return [];
  }
}

function saveSessions() {
  const trimmed = sessions
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_SESSIONS)
    .map((session) => ({
      ...session,
      messages: session.messages.slice(-MAX_MESSAGES_PER_SESSION)
    }));
  sessions = trimmed;
  window.localStorage.setItem(KI_SESSIONS_KEY, JSON.stringify(trimmed));
}

function getActiveSession() {
  let session = sessions.find((entry) => entry.id === activeSessionId);
  if (!session) {
    session = createSession("Neuer Chat");
    activeSessionId = session.id;
    window.localStorage.setItem(KI_ACTIVE_SESSION_KEY, activeSessionId);
  }
  return session;
}

function createSession(title) {
  const now = Date.now();
  const session = {
    id: makeId(),
    title: String(title || "Neuer Chat").slice(0, 80),
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        role: "ai",
        text: "Hi! Ich bin Hannos KI. Frag mich alles zum Lernen oder zur Website.",
        at: now
      }
    ]
  };
  sessions.unshift(session);
  saveSessions();
  return session;
}

function formatTitle(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.slice(0, 32) || "Neuer Chat";
}

function renderSessions() {
  chatSessionList.innerHTML = "";
  sessions
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .forEach((session) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ki-session-btn ${session.id === activeSessionId ? "active" : ""}`.trim();
      button.textContent = session.title;
      button.addEventListener("click", () => {
        activeSessionId = session.id;
        window.localStorage.setItem(KI_ACTIVE_SESSION_KEY, activeSessionId);
        renderSessions();
        renderMessages();
      });
      li.appendChild(button);
      chatSessionList.appendChild(li);
    });
}

function renderMessages() {
  kiMessages.innerHTML = "";
  const session = getActiveSession();

  session.messages.forEach((message) => {
    const bubble = document.createElement("div");
    bubble.className = message.role === "user" ? "ki-bubble ki-bubble-user" : "ki-bubble ki-bubble-ai";
    bubble.textContent = message.text;
    kiMessages.appendChild(bubble);
  });

  kiMessages.scrollTop = kiMessages.scrollHeight;
}

function appendMessage(role, text) {
  const session = getActiveSession();
  const now = Date.now();
  session.messages.push({ role: role === "user" ? "user" : "ai", text: String(text || ""), at: now });
  session.updatedAt = now;

  if (role === "user" && (session.title === "Neuer Chat" || session.messages.length <= 3)) {
    session.title = formatTitle(text);
  }

  saveSessions();
  renderSessions();
  renderMessages();
}

async function sendMessage() {
  if (sending) return;
  const message = String(kiInput.value || "").trim().slice(0, 500);
  if (!message) {
    setStatus("Bitte zuerst eine Nachricht eingeben.");
    return;
  }

  sending = true;
  kiSendBtn.disabled = true;
  appendMessage("user", message);
  kiInput.value = "";
  setStatus("Hannos KI denkt...");

  try {
    const response = await fetch(`${getApiBase()}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(payload?.error || `HTTP ${response.status}`));
    }

    appendMessage("ai", String(payload?.text || ""));
    setStatus("Antwort bereit.");
  } catch (error) {
    appendMessage("ai", `Fehler: ${String(error?.message || "Unbekannt")}`);
    setStatus("Antwort fehlgeschlagen.");
  } finally {
    sending = false;
    kiSendBtn.disabled = false;
  }
}

newChatBtn.addEventListener("click", () => {
  const session = createSession("Neuer Chat");
  activeSessionId = session.id;
  window.localStorage.setItem(KI_ACTIVE_SESSION_KEY, activeSessionId);
  renderSessions();
  renderMessages();
  setStatus("Neuer Chat gestartet.");
});

kiSendBtn.addEventListener("click", sendMessage);
kiInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

if (!sessions.length) {
  const session = createSession("Neuer Chat");
  activeSessionId = session.id;
}

window.localStorage.setItem(KI_ACTIVE_SESSION_KEY, activeSessionId);
renderSessions();
renderMessages();
setStatus("Bereit.");
