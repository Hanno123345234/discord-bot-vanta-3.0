const STORAGE_NAMES = "quiz_duel_names_v1";
const STORAGE_COUNT = "quiz_duel_count_v1";
const STORAGE_ROOM = "quiz_duel_room_code_draft_v1";
const STORAGE_ONLINE_NAME = "quiz_duel_online_name_v1";
const STORAGE_CATEGORY = "quiz_duel_category_v1";
const STORAGE_DIFFICULTY = "quiz_duel_difficulty_v1";
const STORAGE_MAX_PLAYERS = "quiz_duel_max_players_v1";
const STORAGE_ONLINE_PLAYER_KEY = "quiz_duel_online_player_key_v1";
const STORAGE_ONLINE_SESSION = "quiz_duel_online_session_v1";

const setupCard = document.getElementById("setupCard");
const lobbyCard = document.getElementById("lobbyCard");
const playCard = document.getElementById("playCard");
const resultCard = document.getElementById("resultCard");

const playerAInput = document.getElementById("playerA");
const playerBInput = document.getElementById("playerB");
const questionCountInput = document.getElementById("questionCount");
const categorySelect = document.getElementById("category");
const difficultySelect = document.getElementById("difficulty");
const startQuizBtn = document.getElementById("startQuizBtn");
const setupError = document.getElementById("setupError");

const hostOnlineBtn = document.getElementById("hostOnlineBtn");
const joinOnlineBtn = document.getElementById("joinOnlineBtn");
const roomCodeInput = document.getElementById("roomCode");
const onlineNameInput = document.getElementById("onlineName");
const hostCodeLine = document.getElementById("hostCodeLine");
const hostCodeText = document.getElementById("hostCodeText");
const onlineStatus = document.getElementById("onlineStatus");
const maxPlayersSelect = document.getElementById("maxPlayers");

const leaveLobbyBtn = document.getElementById("leaveLobbyBtn");
const lobbyStatus = document.getElementById("lobbyStatus");
const lobbyCodeText = document.getElementById("lobbyCodeText");
const lobbyPlayers = document.getElementById("lobbyPlayers");
const lobbyQuestionCountInput = document.getElementById("lobbyQuestionCount");
const lobbyCategorySelect = document.getElementById("lobbyCategory");
const lobbyDifficultySelect = document.getElementById("lobbyDifficulty");
const lobbyMaxPlayersSelect = document.getElementById("lobbyMaxPlayers");
const readyBtn = document.getElementById("readyBtn");

const progressTitle = document.getElementById("progressTitle");
const turnSubtitle = document.getElementById("turnSubtitle");
const roomSubtitle = document.getElementById("roomSubtitle");
const questionText = document.getElementById("questionText");
const answersEl = document.getElementById("answers");
const feedbackEl = document.getElementById("feedback");
const aiHintBtn = document.getElementById("aiHintBtn");
const aiExplainBtn = document.getElementById("aiExplainBtn");
const aiAskInput = document.getElementById("aiAskInput");
const aiAskBtn = document.getElementById("aiAskBtn");
const aiHelpStatusEl = document.getElementById("aiHelpStatus");
const aiHelpTextEl = document.getElementById("aiHelpText");
const nextBtn = document.getElementById("nextBtn");
const quitBtn = document.getElementById("quitBtn");

const scoreListEl = document.getElementById("scoreList");

const resultText = document.getElementById("resultText");
const finalScoreListEl = document.getElementById("finalScoreList");
const restartBtn = document.getElementById("restartBtn");

let questionBank = [];
let questionBankLoaded = false;

let game = null;
let mode = "local";

let cooldownTimeout = null;
let cooldownInterval = null;

const aiState = {
  loading: false,
  lastQuestionKey: ""
};

const online = {
  socket: null,
  connected: false,
  roomCode: null,
  playerIndex: null,
  hostIndex: null,
  players: [],
  connectedPlayers: [],
  scores: [],
  questionNumber: 0,
  totalQuestions: 0,
  question: null,
  reveal: null,
  answeredThisQuestion: false,
  ready: [],
  settings: {
    questionCount: 10,
    category: "",
    difficulty: "",
    maxPlayers: 8
  }
};

function getOnlinePlayerKey() {
  const saved = String(window.localStorage.getItem(STORAGE_ONLINE_PLAYER_KEY) || "").trim();
  if (saved) return saved;
  const generated = `qp_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  window.localStorage.setItem(STORAGE_ONLINE_PLAYER_KEY, generated);
  return generated;
}

function loadOnlineSession() {
  try {
    const raw = window.localStorage.getItem(STORAGE_ONLINE_SESSION) || "";
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const code = String(parsed.code || "").trim().toUpperCase();
    const playerKey = String(parsed.playerKey || "").trim();
    const name = String(parsed.name || "").trim().slice(0, 24);
    if (!code || !playerKey) return null;
    return { code, playerKey, name };
  } catch {
    return null;
  }
}

function persistOnlineSession() {
  const code = String(online.roomCode || "").trim().toUpperCase();
  if (!code) return;
  const playerKey = getOnlinePlayerKey();
  const name = getOnlineName();
  window.localStorage.setItem(STORAGE_ONLINE_SESSION, JSON.stringify({ code, playerKey, name }));
}

function clearOnlineSession() {
  window.localStorage.removeItem(STORAGE_ONLINE_SESSION);
}

function normalizeMaxPlayers(raw) {
  const value = Math.round(Number(raw));
  if ([4, 6, 8].includes(value)) return value;
  return 8;
}

function showCard(card) {
  [setupCard, lobbyCard, playCard, resultCard].forEach((el) => el.classList.remove("active"));
  card.classList.add("active");
}

function setSetupError(text) {
  setupError.textContent = String(text || "");
}

function setOnlineStatus(text) {
  onlineStatus.textContent = String(text || "");
}

function setLobbyStatus(text) {
  if (!lobbyStatus) return;
  lobbyStatus.textContent = String(text || "");
}

function clearCooldown() {
  if (cooldownTimeout) {
    clearTimeout(cooldownTimeout);
    cooldownTimeout = null;
  }
  if (cooldownInterval) {
    clearInterval(cooldownInterval);
    cooldownInterval = null;
  }
}

// Timer UI removed.

function normalizeName(raw, fallback) {
  const name = String(raw || "").trim().slice(0, 24);
  return name || fallback;
}

function shuffle(list) {
  const cloned = [...list];
  for (let i = cloned.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }
  return cloned;
}

function normalizeCategory(raw) {
  const value = String(raw || "").trim();
  return value;
}

function normalizeDifficulty(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (["easy", "medium", "hard"].includes(value)) return value;
  return "";
}

function getQuizApiBaseOrigin() {
  const base = String(window.QUIZ_ONLINE_ORIGIN || "").trim();
  return base || window.location.origin;
}

function getCurrentQuestion() {
  if (mode === "online") {
    return online.question || null;
  }
  if (!game || !Array.isArray(game.questions)) return null;
  if (!Number.isInteger(game.turn) || game.turn < 0 || game.turn >= game.questions.length) return null;
  return game.questions[game.turn] || null;
}

function canExplainCurrentQuestion() {
  if (mode === "online") {
    return !!online.reveal;
  }
  return !!game?.answered;
}

function setAiHelpStatus(text) {
  if (!aiHelpStatusEl) return;
  aiHelpStatusEl.textContent = String(text || "");
}

function setAiHelpText(text) {
  if (!aiHelpTextEl) return;
  aiHelpTextEl.textContent = String(text || "");
}

function updateAiButtons() {
  const hasQuestion = !!getCurrentQuestion();
  if (aiHintBtn) aiHintBtn.disabled = aiState.loading || !hasQuestion;
  if (aiExplainBtn) aiExplainBtn.disabled = aiState.loading || !hasQuestion || !canExplainCurrentQuestion();
  if (aiAskBtn) aiAskBtn.disabled = aiState.loading || !hasQuestion;
}

function resetAiHelpForQuestion() {
  const q = getCurrentQuestion();
  aiState.lastQuestionKey = q?.id || q?.text || "";
  setAiHelpStatus("");
  setAiHelpText("");
  updateAiButtons();
}

async function requestAiHelp(modeType) {
  const q = getCurrentQuestion();
  if (!q) {
    setAiHelpStatus("Keine aktive Frage.");
    return;
  }

  if (modeType === "explain" && !canExplainCurrentQuestion()) {
    setAiHelpStatus("Erklaerung kommt nach der Aufloesung.");
    return;
  }

  aiState.loading = true;
  updateAiButtons();
  setAiHelpStatus("KI denkt...");

  const category = mode === "online"
    ? String(online.settings?.category || "")
    : String(categorySelect?.value || "");
  const difficulty = mode === "online"
    ? String(online.settings?.difficulty || "")
    : String(difficultySelect?.value || "");

  let correctIndex = null;
  if (modeType === "explain") {
    if (mode === "online") {
      const revealIndex = Number(online.reveal?.correctIndex);
      correctIndex = Number.isInteger(revealIndex) ? revealIndex : null;
    } else {
      const localIndex = Number(q?.correctIndex);
      correctIndex = Number.isInteger(localIndex) ? localIndex : null;
    }
  }

  try {
    const response = await fetch(`${getQuizApiBaseOrigin()}/api/quiz/ai-help`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: modeType,
        question: String(q?.text || ""),
        answers: Array.isArray(q?.answers) ? q.answers : [],
        correctIndex,
        category,
        difficulty
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(payload?.error || `HTTP ${response.status}`));
    }

    setAiHelpText(String(payload?.text || ""));
    setAiHelpStatus(modeType === "hint" ? "KI-Tipp bereit." : "KI-Erklaerung bereit.");
  } catch (error) {
    setAiHelpStatus(`KI nicht verfuegbar: ${String(error?.message || "Unbekannter Fehler")}`);
  } finally {
    aiState.loading = false;
    updateAiButtons();
  }
}

async function requestAiChat() {
  const q = getCurrentQuestion();
  if (!q) {
    setAiHelpStatus("Keine aktive Frage.");
    return;
  }

  const userMessage = String(aiAskInput?.value || "").trim().slice(0, 280);
  if (!userMessage) {
    setAiHelpStatus("Bitte erst eine Frage an die KI eingeben.");
    return;
  }

  aiState.loading = true;
  updateAiButtons();
  setAiHelpStatus("KI antwortet...");

  const category = mode === "online"
    ? String(online.settings?.category || "")
    : String(categorySelect?.value || "");
  const difficulty = mode === "online"
    ? String(online.settings?.difficulty || "")
    : String(difficultySelect?.value || "");

  try {
    const response = await fetch(`${getQuizApiBaseOrigin()}/api/quiz/ai-help`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "chat",
        userMessage,
        question: String(q?.text || ""),
        answers: Array.isArray(q?.answers) ? q.answers : [],
        category,
        difficulty
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(payload?.error || `HTTP ${response.status}`));
    }

    setAiHelpText(String(payload?.text || ""));
    setAiHelpStatus("KI-Antwort bereit.");
  } catch (error) {
    setAiHelpStatus(`KI nicht verfuegbar: ${String(error?.message || "Unbekannter Fehler")}`);
  } finally {
    aiState.loading = false;
    updateAiButtons();
  }
}

function getFilters() {
  const category = normalizeCategory(categorySelect?.value);
  const difficulty = normalizeDifficulty(difficultySelect?.value);
  return { category, difficulty };
}

function getLobbyFilters() {
  const category = normalizeCategory(lobbyCategorySelect?.value);
  const difficulty = normalizeDifficulty(lobbyDifficultySelect?.value);
  return { category, difficulty };
}

function filterQuestionBank(bank, filters) {
  const category = filters?.category ? String(filters.category) : "";
  const difficulty = filters?.difficulty ? String(filters.difficulty) : "";

  return (Array.isArray(bank) ? bank : []).filter((q) => {
    if (!q || typeof q.q !== "string") return false;
    if (!Array.isArray(q.a) || q.a.length !== 4) return false;
    if (!Number.isInteger(q.c) || q.c < 0 || q.c > 3) return false;

    if (category && String(q.category || "") !== category) return false;
    if (difficulty && String(q.difficulty || "").toLowerCase() !== difficulty) return false;
    return true;
  });
}

function shuffleQuestionAnswers(q) {
  const order = shuffle([0, 1, 2, 3]);
  const answers = order.map((idx) => String(q.a[idx]));
  const correctIndex = order.indexOf(Number(q.c));
  return {
    id: String(q.id || ""),
    text: String(q.q),
    answers,
    correctIndex
  };
}

function setSelectOptions(selectEl, options, selectedValue) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  options.forEach(({ value, label }) => {
    const opt = document.createElement("option");
    opt.value = String(value);
    opt.textContent = String(label);
    selectEl.appendChild(opt);
  });

  if (selectedValue !== undefined && selectedValue !== null) {
    const value = String(selectedValue);
    const exists = [...selectEl.options].some((o) => o.value === value);
    selectEl.value = exists ? value : String(options?.[0]?.value ?? "");
  }
}

function updateQuestionCountLimits() {
  const filtered = filterQuestionBank(questionBank, getFilters());
  const max = Math.max(4, Math.min(40, filtered.length || 4));
  questionCountInput.max = String(max);
  const current = Math.round(Number(questionCountInput.value || 10));
  const clamped = Math.max(4, Math.min(max, Number.isFinite(current) ? current : 10));
  questionCountInput.value = String(clamped);
}

function updateLobbyQuestionCountLimits() {
  if (!lobbyQuestionCountInput) return;
  const filtered = filterQuestionBank(questionBank, getLobbyFilters());
  const max = Math.max(4, Math.min(40, filtered.length || 4));
  lobbyQuestionCountInput.max = String(max);
  const current = Math.round(Number(lobbyQuestionCountInput.value || 10));
  const clamped = Math.max(4, Math.min(max, Number.isFinite(current) ? current : 10));
  lobbyQuestionCountInput.value = String(clamped);
}

async function loadQuestionBank() {
  try {
    const resp = await fetch("./quiz_questions.json", { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data)) throw new Error("Invalid questions JSON");
    questionBank = data;
    questionBankLoaded = true;
    return true;
  } catch {
    questionBank = [];
    questionBankLoaded = false;
    return false;
  }
}

function populateFiltersFromBank() {
  const categories = [...new Set((questionBank || []).map((q) => String(q?.category || "").trim()).filter(Boolean))].sort();
  const difficulties = [...new Set((questionBank || []).map((q) => String(q?.difficulty || "").trim().toLowerCase()).filter(Boolean))]
    .filter((d) => ["easy", "medium", "hard"].includes(d))
    .sort((a, b) => {
      const rank = { easy: 1, medium: 2, hard: 3 };
      return (rank[a] || 99) - (rank[b] || 99);
    });

  const savedCategory = String(window.localStorage.getItem(STORAGE_CATEGORY) || "");
  const savedDifficulty = normalizeDifficulty(window.localStorage.getItem(STORAGE_DIFFICULTY) || "");

  setSelectOptions(
    categorySelect,
    [{ value: "", label: "Alle Kategorien" }, ...categories.map((c) => ({ value: c, label: c }))],
    savedCategory
  );

  setSelectOptions(
    difficultySelect,
    [{ value: "", label: "Gemischt" }, ...difficulties.map((d) => ({ value: d, label: d === "easy" ? "Leicht" : d === "medium" ? "Mittel" : "Schwer" }))],
    savedDifficulty
  );

  setSelectOptions(
    lobbyCategorySelect,
    [{ value: "", label: "Alle Kategorien" }, ...categories.map((c) => ({ value: c, label: c }))],
    savedCategory
  );

  setSelectOptions(
    lobbyDifficultySelect,
    [{ value: "", label: "Gemischt" }, ...difficulties.map((d) => ({ value: d, label: d === "easy" ? "Leicht" : d === "medium" ? "Mittel" : "Schwer" }))],
    savedDifficulty
  );

  updateQuestionCountLimits();
  updateLobbyQuestionCountLimits();
}

function isHost() {
  return Number(online.playerIndex) === Number(online.hostIndex);
}

function canReady() {
  return mode === "online" && online.roomCode && Array.isArray(online.players) && online.players.length >= 2;
}

function renderPlayerScoreList(targetEl, players, scores) {
  if (!targetEl) return;
  targetEl.innerHTML = "";

  const names = Array.isArray(players) ? players : [];
  const values = Array.isArray(scores) ? scores : [];
  const count = Math.max(names.length, values.length, 0);

  for (let index = 0; index < count; index += 1) {
    const li = document.createElement("li");
    const label = names[index] || `Spieler ${index + 1}`;
    const points = Number(values[index] || 0);

    const nameStrong = document.createElement("strong");
    nameStrong.textContent = label;

    li.appendChild(nameStrong);
    li.appendChild(document.createTextNode(`: ${points}`));
    targetEl.appendChild(li);
  }
}

function renderLobby() {
  if (mode !== "online") return;
  if (!lobbyCard) return;

  showCard(lobbyCard);

  if (lobbyCodeText) {
    lobbyCodeText.textContent = String(online.roomCode || "");
  }

  const players = Array.isArray(online.players) ? online.players : [];
  const connected = Array.isArray(online.connectedPlayers) ? online.connectedPlayers : players.map(() => true);
  const ready = Array.isArray(online.ready) ? online.ready : [false, false];

  if (lobbyPlayers) {
    lobbyPlayers.innerHTML = "";
    const list = players.map((_, idx) => {
      const name = players[idx] || `Spieler ${idx + 1}`;
      const isReady = !!ready[idx];
      const isConnected = connected[idx] !== false;
      const li = document.createElement("li");
      const statusBits = [];
      if (!isConnected) statusBits.push("offline");
      if (isReady) statusBits.push("bereit");
      li.textContent = statusBits.length > 0 ? `${name} (${statusBits.join(", ")})` : name;
      return li;
    });
    list.forEach((li) => lobbyPlayers.appendChild(li));
  }

  const host = isHost();
  if (lobbyQuestionCountInput) lobbyQuestionCountInput.disabled = !host;
  if (lobbyCategorySelect) lobbyCategorySelect.disabled = !host;
  if (lobbyDifficultySelect) lobbyDifficultySelect.disabled = !host;
  if (lobbyMaxPlayersSelect) lobbyMaxPlayersSelect.disabled = !host;

  // Fill controls from server settings if present.
  const serverSettings = online.settings || {};
  if (lobbyQuestionCountInput && Number.isFinite(Number(serverSettings.questionCount))) {
    lobbyQuestionCountInput.value = String(serverSettings.questionCount);
  }
  if (lobbyCategorySelect) {
    const cat = String(serverSettings.category || "");
    if ([...lobbyCategorySelect.options].some((o) => o.value === cat)) lobbyCategorySelect.value = cat;
  }
  if (lobbyDifficultySelect) {
    const diff = normalizeDifficulty(serverSettings.difficulty || "");
    if ([...lobbyDifficultySelect.options].some((o) => o.value === diff)) lobbyDifficultySelect.value = diff;
  }
  if (lobbyMaxPlayersSelect) {
    const maxPlayers = normalizeMaxPlayers(serverSettings.maxPlayers || 8);
    if ([...lobbyMaxPlayersSelect.options].some((o) => Number(o.value) === maxPlayers)) {
      lobbyMaxPlayersSelect.value = String(maxPlayers);
    }
    if (maxPlayersSelect) maxPlayersSelect.value = String(maxPlayers);
  }

  updateLobbyQuestionCountLimits();

  const me = Number(online.playerIndex);
  const myReady = !!ready[me];
  if (readyBtn) {
    readyBtn.disabled = !canReady() || myReady;
    readyBtn.textContent = myReady ? "Bereit ✓" : "Bereit";
  }

  if (players.length < 2) {
    setLobbyStatus("Warte auf weitere Spieler…");
  } else {
    const readyCount = ready.filter(Boolean).length;
    const missing = Math.max(0, players.length - readyCount);
    if (missing === 0) {
      setLobbyStatus("Alle sind bereit. Spiel startet…");
    } else {
      setLobbyStatus(`${readyCount}/${players.length} bereit – warte auf ${missing}.`);
    }
  }
}

function emitOnlineSettingsUpdate() {
  if (mode !== "online") return;
  if (!online.socket) return;
  if (!isHost()) return;
  if (!online.roomCode) return;
  const { category, difficulty } = getLobbyFilters();
  const requested = Math.round(Number(lobbyQuestionCountInput?.value || questionCountInput.value || 10));
  const maxPlayers = normalizeMaxPlayers(lobbyMaxPlayersSelect?.value || maxPlayersSelect?.value || 8);

  online.socket.emit("quiz_update_settings", {
    code: online.roomCode,
    questionCount: requested,
    category,
    difficulty,
    maxPlayers
  });
}

function saveSetupDraft() {
  const payload = {
    a: String(playerAInput.value || ""),
    b: String(playerBInput.value || "")
  };
  window.localStorage.setItem(STORAGE_NAMES, JSON.stringify(payload));
  window.localStorage.setItem(STORAGE_COUNT, String(questionCountInput.value || "10"));
  window.localStorage.setItem(STORAGE_ROOM, String(roomCodeInput.value || ""));
  window.localStorage.setItem(STORAGE_ONLINE_NAME, String(onlineNameInput.value || ""));
  window.localStorage.setItem(STORAGE_CATEGORY, String(categorySelect?.value || ""));
  window.localStorage.setItem(STORAGE_DIFFICULTY, String(difficultySelect?.value || ""));
  window.localStorage.setItem(STORAGE_MAX_PLAYERS, String(normalizeMaxPlayers(maxPlayersSelect?.value || lobbyMaxPlayersSelect?.value || 8)));
}

function loadSetupDraft() {
  try {
    const names = JSON.parse(window.localStorage.getItem(STORAGE_NAMES) || "{}") || {};
    if (typeof names.a === "string") playerAInput.value = names.a;
    if (typeof names.b === "string") playerBInput.value = names.b;
  } catch {
    // ignore
  }

  const count = Number(window.localStorage.getItem(STORAGE_COUNT) || "10");
  if (Number.isFinite(count)) {
    questionCountInput.value = String(Math.max(4, Math.min(40, Math.round(count))));
  }

  const roomCode = String(window.localStorage.getItem(STORAGE_ROOM) || "");
  if (roomCode) {
    roomCodeInput.value = roomCode;
  }

  const onlineName = String(window.localStorage.getItem(STORAGE_ONLINE_NAME) || "");
  if (onlineName) {
    onlineNameInput.value = onlineName;
  }

  const storedCategory = String(window.localStorage.getItem(STORAGE_CATEGORY) || "");
  if (categorySelect && storedCategory) {
    categorySelect.value = storedCategory;
  }

  const storedDifficulty = String(window.localStorage.getItem(STORAGE_DIFFICULTY) || "");
  if (difficultySelect && storedDifficulty) {
    difficultySelect.value = storedDifficulty;
  }

  const storedMaxPlayers = normalizeMaxPlayers(window.localStorage.getItem(STORAGE_MAX_PLAYERS) || 8);
  if (maxPlayersSelect) maxPlayersSelect.value = String(storedMaxPlayers);
  if (lobbyMaxPlayersSelect) lobbyMaxPlayersSelect.value = String(storedMaxPlayers);
}

function buildGame() {
  if (!questionBankLoaded) {
    return { ok: false, error: "Fragen konnten nicht geladen werden." };
  }

  const nameA = normalizeName(playerAInput.value, "Spieler 1");
  const nameB = normalizeName(playerBInput.value, "Spieler 2");

  const filters = getFilters();
  const filtered = filterQuestionBank(questionBank, filters);
  const max = Math.max(4, Math.min(40, filtered.length || 4));
  const count = Math.max(4, Math.min(max, Math.round(Number(questionCountInput.value || 10))));
  if (count > filtered.length) {
    return { ok: false, error: `Zu wenig Fragen im Pool (${filtered.length}).` };
  }

  const picked = shuffle(filtered).slice(0, count).map(shuffleQuestionAnswers);

  return {
    ok: true,
    game: {
      players: [nameA, nameB],
      scores: [0, 0],
      turn: 0,
      questions: picked,
      answered: false
    }
  };
}

function renderScore() {
  if (mode === "online") {
    renderPlayerScoreList(scoreListEl, online.players, online.scores);
    return;
  }

  renderPlayerScoreList(scoreListEl, game.players, game.scores);
}

function renderLocalQuestion() {
  clearCooldown();
  const currentIndex = game.turn;
  const total = game.questions.length;
  const playerIndex = currentIndex % 2;
  const playerName = game.players[playerIndex];

  progressTitle.textContent = `Frage ${currentIndex + 1}/${total}`;
  turnSubtitle.textContent = `Am Zug: ${playerName}`;
  roomSubtitle.textContent = "";

  const q = game.questions[currentIndex];
  questionText.textContent = q.text;

  feedbackEl.textContent = "";
  nextBtn.disabled = true;
  game.answered = false;

  answersEl.innerHTML = "";
  q.answers.forEach((label, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => onLocalAnswer(idx));
    answersEl.appendChild(btn);
  });

  resetAiHelpForQuestion();
  renderScore();
}

function startCooldown(callback) {
  clearCooldown();
  const endsAt = Date.now() + 2000;
  const tick = () => {
    const leftMs = Math.max(0, endsAt - Date.now());
    const leftSec = Math.ceil(leftMs / 1000);
    if (leftSec <= 0) {
      feedbackEl.textContent = "";
    } else {
      feedbackEl.textContent = `${feedbackEl.textContent.replace(/\s*\(.*\)$/, "")} (Nächste Frage in ${leftSec}s)`;
    }
  };
  tick();
  cooldownInterval = setInterval(tick, 150);
  cooldownTimeout = setTimeout(() => {
    clearCooldown();
    callback();
  }, 2000);
}

function onLocalAnswer(selectedIndex) {
  if (!game || game.answered) return;
  game.answered = true;

  const currentIndex = game.turn;
  const playerIndex = currentIndex % 2;
  const q = game.questions[currentIndex];

  const correct = selectedIndex === q.correctIndex;
  if (correct) {
    game.scores[playerIndex] += 1;
  }

  [...answersEl.querySelectorAll("button")].forEach((btn, idx) => {
    btn.disabled = true;
    if (idx === q.correctIndex) {
      btn.classList.add("success");
    }
  });

  feedbackEl.textContent = correct ? "Richtig! +1 Punkt" : `Falsch. Richtig ist: ${q.answers[q.correctIndex]}`;
  nextBtn.disabled = true;
  updateAiButtons();
  renderScore();

  startCooldown(() => advanceLocal());
}

function advanceLocal() {
  if (!game) return;
  game.turn += 1;
  if (game.turn >= game.questions.length) {
    finishGame();
    return;
  }
  renderLocalQuestion();
}

function finishGame() {
  const players = mode === "online" ? online.players : game.players;
  const scores = mode === "online" ? online.scores : game.scores;

  renderPlayerScoreList(finalScoreListEl, players, scores);

  const numericScores = (Array.isArray(scores) ? scores : []).map((value) => Number(value || 0));
  const maxScore = numericScores.length ? Math.max(...numericScores) : 0;
  const winnerIndices = numericScores
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value === maxScore)
    .map((entry) => entry.index);

  if (winnerIndices.length <= 0 || winnerIndices.length === numericScores.length) {
    resultText.textContent = "Unentschieden!";
  } else if (winnerIndices.length === 1) {
    resultText.textContent = `${players[winnerIndices[0]] || "Jemand"} gewinnt!`;
  } else {
    const labels = winnerIndices.map((index) => players[index] || `Spieler ${index + 1}`);
    resultText.textContent = `Unentschieden zwischen ${labels.join(", ")}.`;
  }

  showCard(resultCard);
}

function startLocal() {
  mode = "local";
  setSetupError("");
  setOnlineStatus("");
  hostCodeLine.style.display = "none";
  const built = buildGame();
  if (!built.ok) {
    setSetupError(built.error);
    return;
  }
  game = built.game;
  showCard(playCard);
  renderLocalQuestion();
}

function resetToSetup() {
  clearCooldown();
  game = null;
  mode = "local";
  roomSubtitle.textContent = "";

  if (online.socket) {
    try {
      online.socket.emit("quiz_leave_room");
      online.socket.disconnect();
    } catch {
      // ignore
    }
  }
  online.socket = null;
  online.connected = false;
  online.roomCode = null;
  online.playerIndex = null;
  online.hostIndex = null;
  online.players = [];
  online.connectedPlayers = [];
  online.scores = [];
  online.questionNumber = 0;
  online.totalQuestions = 0;
  online.question = null;
  online.reveal = null;
  online.answeredThisQuestion = false;
  online.ready = [];
  online.settings = { questionCount: 10, category: "", difficulty: "", maxPlayers: 8 };
  clearOnlineSession();

  hostCodeLine.style.display = "none";
  hostCodeText.textContent = "";
  setOnlineStatus("");
  setLobbyStatus("");
  setAiHelpStatus("");
  setAiHelpText("");
  updateAiButtons();
  showCard(setupCard);
}

async function loadSocketIoClient() {
  if (typeof window.io === "function") return;

  const onlineOrigin = String(window.QUIZ_ONLINE_ORIGIN || "").trim() || window.location.origin;

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${onlineOrigin}/socket.io/socket.io.js`;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function ensureOnlineSocket() {
  if (online.socket) return online.socket;

  await loadSocketIoClient();
  if (typeof window.io !== "function") {
    throw new Error("Socket.IO client not available");
  }

  const onlineOrigin = String(window.QUIZ_ONLINE_ORIGIN || "").trim();
  const socket = onlineOrigin
    ? window.io(onlineOrigin, { transports: ["websocket", "polling"] })
    : window.io({ transports: ["websocket", "polling"] });
  online.socket = socket;
  setOnlineStatus("Verbinden…");

  socket.on("connect", () => {
    online.connected = true;
    setOnlineStatus("Verbunden.");

    if (!online.roomCode) {
      const session = loadOnlineSession();
      if (session?.code && session?.playerKey) {
        socket.emit("quiz_reconnect", {
          code: session.code,
          playerKey: session.playerKey,
          name: session.name || getOnlineName()
        });
        setOnlineStatus("Verbindung wiederherstellen…");
      }
    }
  });

  socket.on("disconnect", () => {
    online.connected = false;
    if (mode === "online") {
      setOnlineStatus("Verbindung getrennt.");
    }
  });

  socket.on("quiz_error", (message) => {
    if (mode === "online") {
      setSetupError(String(message || "Fehler."));
    }
  });

  socket.on("quiz_room_created", (payload) => {
    mode = "online";
    online.roomCode = String(payload?.code || "");
    online.playerIndex = Number(payload?.playerIndex || 0);
    online.hostIndex = Number(payload?.hostIndex ?? 0);
    online.players = Array.isArray(payload?.players) ? payload.players : [];
    online.connectedPlayers = Array.isArray(payload?.connected) ? payload.connected : online.players.map(() => true);
    online.scores = Array.isArray(payload?.scores) ? payload.scores : [];
    online.ready = Array.isArray(payload?.ready) ? payload.ready : online.players.map(() => false);
    online.settings = payload?.settings || online.settings;
    online.settings.maxPlayers = normalizeMaxPlayers(online.settings.maxPlayers || 8);

    if (online.roomCode) {
      hostCodeText.textContent = online.roomCode;
      hostCodeLine.style.display = "block";
      roomCodeInput.value = online.roomCode;
      saveSetupDraft();
    }

    setOnlineStatus("Lobby geöffnet.");
    persistOnlineSession();
    renderScore();
    renderLobby();
  });

  socket.on("quiz_joined", (payload) => {
    mode = "online";
    online.roomCode = String(payload?.code || online.roomCode || "");
    online.playerIndex = Number(payload?.playerIndex);
    online.hostIndex = Number(payload?.hostIndex ?? online.hostIndex ?? 0);
    online.players = Array.isArray(payload?.players) ? payload.players : online.players;
    online.connectedPlayers = Array.isArray(payload?.connected) ? payload.connected : online.players.map(() => true);
    online.scores = Array.isArray(payload?.scores) ? payload.scores : online.scores;
    online.ready = Array.isArray(payload?.ready) ? payload.ready : online.players.map(() => false);
    online.settings = payload?.settings || online.settings;
    online.settings.maxPlayers = normalizeMaxPlayers(online.settings.maxPlayers || 8);
    setOnlineStatus("Beigetreten.");
    persistOnlineSession();
    renderScore();
    renderLobby();
  });

  socket.on("quiz_reconnected", (payload) => {
    mode = "online";
    online.roomCode = String(payload?.code || online.roomCode || "");
    online.playerIndex = Number(payload?.playerIndex ?? online.playerIndex ?? 0);
    online.hostIndex = Number(payload?.hostIndex ?? online.hostIndex ?? 0);
    online.players = Array.isArray(payload?.players) ? payload.players : online.players;
    online.connectedPlayers = Array.isArray(payload?.connected) ? payload.connected : online.players.map(() => true);
    online.scores = Array.isArray(payload?.scores) ? payload.scores : online.scores;
    online.ready = Array.isArray(payload?.ready) ? payload.ready : online.players.map(() => false);
    online.settings = payload?.settings || online.settings;
    online.settings.maxPlayers = normalizeMaxPlayers(online.settings.maxPlayers || 8);
    setOnlineStatus("Wieder verbunden.");
    persistOnlineSession();
    renderScore();
    renderLobby();
  });

  socket.on("quiz_room_update", (payload) => {
    if (mode !== "online") return;
    online.players = Array.isArray(payload?.players) ? payload.players : online.players;
    online.connectedPlayers = Array.isArray(payload?.connected) ? payload.connected : online.players.map(() => true);
    online.hostIndex = Number(payload?.hostIndex ?? online.hostIndex ?? 0);
    online.scores = Array.isArray(payload?.scores) ? payload.scores : online.scores;
    online.ready = Array.isArray(payload?.ready) ? payload.ready : online.players.map(() => false);
    online.settings = payload?.settings || online.settings;
    online.settings.maxPlayers = normalizeMaxPlayers(online.settings.maxPlayers || 8);
    renderScore();

    if (!payload?.started) {
      renderLobby();
    }

    if ((online.players || []).length < 2) {
      setOnlineStatus("Warte auf weitere Spieler…");
    } else {
      setOnlineStatus("Spieler verbunden.");
    }
  });

  socket.on("quiz_question", (payload) => {
    mode = "online";
    clearCooldown();

    online.roomCode = String(payload?.code || online.roomCode || "");
    online.players = Array.isArray(payload?.players) ? payload.players : online.players;
    online.scores = Array.isArray(payload?.scores) ? payload.scores : online.scores;
    online.questionNumber = Number(payload?.questionNumber || 1);
    online.totalQuestions = Number(payload?.totalQuestions || online.totalQuestions || 0);
    online.question = payload?.question || null;
    online.reveal = null;
    online.answeredThisQuestion = false;

    showCard(playCard);
    renderOnlineQuestion();
  });

  socket.on("quiz_result", (payload) => {
    if (mode !== "online") return;

    online.scores = Array.isArray(payload?.scores) ? payload.scores : online.scores;
    online.players = Array.isArray(payload?.players) ? payload.players : online.players;
    renderScore();

    const correctIndex = Number(payload?.correctIndex);
    const correctAnswer = String(payload?.correctAnswer || "");
    const type = String(payload?.type || "");
    const detail = String(payload?.detail || "");
    const winnerIndex = payload?.winnerIndex === null || payload?.winnerIndex === undefined
      ? null
      : Number(payload?.winnerIndex);
    online.reveal = {
      correctIndex,
      correctAnswer,
      type,
      detail,
      winnerIndex
    };

    [...answersEl.querySelectorAll("button")].forEach((btn, idx) => {
      btn.disabled = true;
      if (idx === correctIndex) {
        btn.classList.add("success");
      }
    });

    if (type === "correct" && winnerIndex !== null) {
      const winnerName = online.players[winnerIndex] || "Jemand";
      const me = Number(online.playerIndex);
      const winnerLabel = winnerIndex === me ? "Du" : winnerName;

      if (detail === "fastest") {
        feedbackEl.textContent = `Beide richtig — ${winnerLabel} war schneller! +1 Punkt`;
      } else {
        feedbackEl.textContent = winnerIndex === me ? "Richtig! +1 Punkt" : `${winnerName} war richtig! +1 Punkt`;
      }
    } else {
      feedbackEl.textContent = `Niemand richtig. Richtig ist: ${correctAnswer}`;
    }

    updateAiButtons();

    // Next question comes from server after ~2s.
  });

  socket.on("quiz_game_over", (payload) => {
    if (mode !== "online") return;
    online.players = Array.isArray(payload?.players) ? payload.players : online.players;
    online.scores = Array.isArray(payload?.scores) ? payload.scores : online.scores;
    finishGame();
  });

  socket.on("quiz_opponent_left", () => {
    if (mode !== "online") return;
    setSetupError("Ein Spieler hat den Raum verlassen.");
    resetToSetup();
  });

  return socket;
}

function getOnlineName() {
  const explicit = normalizeName(onlineNameInput.value, "");
  if (explicit) return explicit;

  // fallback: keep older behavior if field is empty
  const fallback = normalizeName(playerAInput.value, "Spieler");
  return fallback;
}

function normalizeRoomCode(raw) {
  return String(raw || "").trim().toUpperCase().replace(/\s+/g, "").slice(0, 8);
}

function renderOnlineQuestion() {
  const total = online.totalQuestions || 0;
  progressTitle.textContent = `Frage ${online.questionNumber}/${total || "?"}`;

  turnSubtitle.textContent = "Beide beantworten. Wenn beide richtig: schneller bekommt den Punkt.";
  roomSubtitle.textContent = online.roomCode ? `Online-Raum: ${online.roomCode}` : "Online";

  const q = online.question;
  questionText.textContent = String(q?.text || "");
  feedbackEl.textContent = "";
  nextBtn.disabled = true;

  answersEl.innerHTML = "";
  const answers = Array.isArray(q?.answers) ? q.answers : [];
  answers.forEach((label, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = String(label);
    const canAnswer = Number.isInteger(Number(online.playerIndex))
      && Number(online.playerIndex) >= 0
      && Number(online.playerIndex) < online.players.length
      && !online.answeredThisQuestion;
    btn.disabled = !canAnswer;
    btn.addEventListener("click", () => onOnlineAnswer(idx));
    answersEl.appendChild(btn);
  });

  resetAiHelpForQuestion();
  renderScore();
}

function onOnlineAnswer(selectedIndex) {
  if (mode !== "online") return;
  if (!online.socket) return;
  if (!Number.isInteger(Number(online.playerIndex))) return;
  if (Number(online.playerIndex) < 0 || Number(online.playerIndex) >= online.players.length) return;
  if (!online.roomCode) return;

  if (online.answeredThisQuestion) return;
  online.answeredThisQuestion = true;

  [...answersEl.querySelectorAll("button")].forEach((btn) => {
    btn.disabled = true;
  });
  feedbackEl.textContent = "Antwort gesendet…";
  online.socket.emit("quiz_answer", { code: online.roomCode, selectedIndex });
}

async function hostOnline() {
  setSetupError("");
  setOnlineStatus("");
  hostCodeLine.style.display = "none";
  hostCodeText.textContent = "";

  const name = getOnlineName();
  const count = Math.max(4, Math.min(40, Math.round(Number(questionCountInput.value || 10))));
  const { category, difficulty } = getFilters();
  const maxPlayers = normalizeMaxPlayers(maxPlayersSelect?.value || 8);
  const playerKey = getOnlinePlayerKey();

  try {
    const socket = await ensureOnlineSocket();
    mode = "online";
    socket.emit("quiz_create_room", { name, questionCount: count, category, difficulty, maxPlayers, playerKey });
    setOnlineStatus("Raum wird erstellt…");
  } catch {
    setSetupError("Online geht hier nicht (Server/Socket.IO fehlt). Nutze Render oder localhost.");
  }
}

async function joinOnline() {
  setSetupError("");
  setOnlineStatus("");
  hostCodeLine.style.display = "none";
  hostCodeText.textContent = "";

  const name = getOnlineName();
  const code = normalizeRoomCode(roomCodeInput.value);
  const playerKey = getOnlinePlayerKey();
  roomCodeInput.value = code;
  saveSetupDraft();

  if (!code) {
    setSetupError("Bitte einen Code eingeben.");
    return;
  }

  try {
    const socket = await ensureOnlineSocket();
    mode = "online";
    online.roomCode = code;
    socket.emit("quiz_join_room", { name, code, playerKey });
    setOnlineStatus("Beitreten…");
  } catch {
    setSetupError("Online geht hier nicht (Server/Socket.IO fehlt). Nutze Render oder localhost.");
  }
}

startQuizBtn.addEventListener("click", startLocal);
nextBtn.addEventListener("click", () => {
  // Cooldown ist automatisch – Button bleibt deaktiviert.
});

quitBtn.addEventListener("click", resetToSetup);
restartBtn.addEventListener("click", () => {
  showCard(setupCard);
});

if (leaveLobbyBtn) {
  leaveLobbyBtn.addEventListener("click", resetToSetup);
}

if (readyBtn) {
  readyBtn.addEventListener("click", () => {
    if (mode !== "online") return;
    if (!online.socket) return;
    if (!online.roomCode) return;
    const me = Number(online.playerIndex);
    if (!Number.isInteger(me) || me < 0 || me >= online.players.length) return;
    online.socket.emit("quiz_ready", { code: online.roomCode });
  });
}

hostOnlineBtn.addEventListener("click", hostOnline);
joinOnlineBtn.addEventListener("click", joinOnline);

if (aiHintBtn) {
  aiHintBtn.addEventListener("click", () => {
    requestAiHelp("hint");
  });
}

if (aiExplainBtn) {
  aiExplainBtn.addEventListener("click", () => {
    requestAiHelp("explain");
  });
}

if (aiAskBtn) {
  aiAskBtn.addEventListener("click", () => {
    requestAiChat();
  });
}

if (aiAskInput) {
  aiAskInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      requestAiChat();
    }
  });
}

[
  playerAInput,
  playerBInput,
  questionCountInput,
  categorySelect,
  difficultySelect,
  maxPlayersSelect
]
  .filter(Boolean)
  .forEach((el) => {
    el.addEventListener("input", saveSetupDraft);
  });

if (categorySelect) {
  categorySelect.addEventListener("change", () => {
    updateQuestionCountLimits();
    saveSetupDraft();
  });
}

if (difficultySelect) {
  difficultySelect.addEventListener("change", () => {
    updateQuestionCountLimits();
    saveSetupDraft();
  });
}

if (maxPlayersSelect) {
  maxPlayersSelect.addEventListener("change", () => {
    if (lobbyMaxPlayersSelect) lobbyMaxPlayersSelect.value = String(maxPlayersSelect.value || "8");
    saveSetupDraft();
  });
}

roomCodeInput.addEventListener("input", saveSetupDraft);
onlineNameInput.addEventListener("input", saveSetupDraft);

if (lobbyQuestionCountInput) {
  lobbyQuestionCountInput.addEventListener("input", () => {
    // keep setup field in sync
    questionCountInput.value = String(lobbyQuestionCountInput.value || questionCountInput.value || "10");
    saveSetupDraft();
    updateLobbyQuestionCountLimits();
    emitOnlineSettingsUpdate();
  });
}

if (lobbyCategorySelect) {
  lobbyCategorySelect.addEventListener("change", () => {
    // keep setup field in sync
    if (categorySelect) categorySelect.value = String(lobbyCategorySelect.value || "");
    saveSetupDraft();
    updateLobbyQuestionCountLimits();
    emitOnlineSettingsUpdate();
  });
}

if (lobbyDifficultySelect) {
  lobbyDifficultySelect.addEventListener("change", () => {
    if (difficultySelect) difficultySelect.value = String(lobbyDifficultySelect.value || "");
    saveSetupDraft();
    updateLobbyQuestionCountLimits();
    emitOnlineSettingsUpdate();
  });
}

if (lobbyMaxPlayersSelect) {
  lobbyMaxPlayersSelect.addEventListener("change", () => {
    if (maxPlayersSelect) maxPlayersSelect.value = String(lobbyMaxPlayersSelect.value || "8");
    saveSetupDraft();
    emitOnlineSettingsUpdate();
  });
}

loadSetupDraft();

(async () => {
  updateAiButtons();

  const ok = await loadQuestionBank();
  if (!ok) {
    setSetupError("Fragen konnten nicht geladen werden (quiz_questions.json fehlt). Online kann trotzdem gehen.");
    setSelectOptions(categorySelect, [{ value: "", label: "Alle Kategorien" }], "");
    setSelectOptions(difficultySelect, [{ value: "", label: "Gemischt" }], "");
    return;
  }

  populateFiltersFromBank();

  // Apply any stored draft selection after options exist.
  const storedCategory = String(window.localStorage.getItem(STORAGE_CATEGORY) || "");
  if (storedCategory) categorySelect.value = storedCategory;
  const storedDifficulty = normalizeDifficulty(window.localStorage.getItem(STORAGE_DIFFICULTY) || "");
  if (storedDifficulty) difficultySelect.value = storedDifficulty;

  updateQuestionCountLimits();
  updateLobbyQuestionCountLimits();
})();
