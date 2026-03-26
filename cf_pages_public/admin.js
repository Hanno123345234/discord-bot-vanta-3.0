const ADMIN_KEY_STORAGE = "admin_access_key_v1";
const ADMIN_KEY_DRAFT_STORAGE = "admin_access_key_draft_v1";

const adminInfo = document.getElementById("adminInfo");
const adminPanel = document.getElementById("adminPanel");
const adminKeyInput = document.getElementById("adminKeyInput");
const refreshBtn = document.getElementById("refreshAdminBtn");

const aiLogList = document.getElementById("aiLogList");
const aiControlInfo = document.getElementById("aiControlInfo");
const enableAiBtn = document.getElementById("enableAiBtn");
const disableAiBtn = document.getElementById("disableAiBtn");
const commandList = document.getElementById("discordCommandList");
const cmdTriggerInput = document.getElementById("cmdTriggerInput");
const cmdModeSelect = document.getElementById("cmdModeSelect");
const cmdEmbedFields = document.getElementById("cmdEmbedFields");
const cmdSearchInput = document.getElementById("cmdSearchInput");
const cmdFilterAction = document.getElementById("cmdFilterAction");
const cmdEmbedTitleInput = document.getElementById("cmdEmbedTitleInput");
const cmdEmbedColorInput = document.getElementById("cmdEmbedColorInput");
const cmdResponseInput = document.getElementById("cmdResponseInput");
const cmdEnabledInput = document.getElementById("cmdEnabledInput");
const cmdDeleteTriggerInput = document.getElementById("cmdDeleteTriggerInput");
const cmdSaveBtn = document.getElementById("cmdSaveBtn");
const cmdResetBtn = document.getElementById("cmdResetBtn");
const cmdStatusInfo = document.getElementById("cmdStatusInfo");
const wickGuildIdInput = document.getElementById("wickGuildIdInput");
const wickLogChannelInput = document.getElementById("wickLogChannelInput");
const wickEnabledInput = document.getElementById("wickEnabledInput");
const wickAutoStrikeInput = document.getElementById("wickAutoStrikeInput");
const wickTimeout3Input = document.getElementById("wickTimeout3Input");
const wickTimeout5Input = document.getElementById("wickTimeout5Input");
const wickAntiRaidEnabledInput = document.getElementById("wickAntiRaidEnabledInput");
const wickRaidJoinsInput = document.getElementById("wickRaidJoinsInput");
const wickRaidSecondsInput = document.getElementById("wickRaidSecondsInput");
const wickRaidSlowmodeInput = document.getElementById("wickRaidSlowmodeInput");
const wickAntiNukeEnabledInput = document.getElementById("wickAntiNukeEnabledInput");
const wickNukeChannelDeleteInput = document.getElementById("wickNukeChannelDeleteInput");
const wickNukeRoleDeleteInput = document.getElementById("wickNukeRoleDeleteInput");
const wickNukeLockdownInput = document.getElementById("wickNukeLockdownInput");
const wickLinkShieldEnabledInput = document.getElementById("wickLinkShieldEnabledInput");
const wickBlockInvitesInput = document.getElementById("wickBlockInvitesInput");
const wickWhitelistDomainsInput = document.getElementById("wickWhitelistDomainsInput");
const wickSaveBtn = document.getElementById("wickSaveBtn");
const wickResetBtn = document.getElementById("wickResetBtn");
const wickGuildList = document.getElementById("wickGuildList");
const wickStatusInfo = document.getElementById("wickStatusInfo");
const modmailStatusFilter = document.getElementById("modmailStatusFilter");
const modmailReloadBtn = document.getElementById("modmailReloadBtn");
const modmailList = document.getElementById("modmailList");
const modmailStatusInfo = document.getElementById("modmailStatusInfo");

let adminKey = window.localStorage.getItem(ADMIN_KEY_STORAGE) || "";
const draftKey = window.localStorage.getItem(ADMIN_KEY_DRAFT_STORAGE) || "";
if (draftKey) adminKey = draftKey;

let canEditAdmin = false;
let discordCommands = [];
let editingTrigger = null;
let wickSettingsState = { guilds: {} };
let modmailItems = [];

function setInfo(text) {
  adminInfo.textContent = String(text || "");
}

function setCommandStatus(text) {
  if (!cmdStatusInfo) return;
  cmdStatusInfo.textContent = String(text || "");
}

function setWickStatus(text) {
  if (!wickStatusInfo) return;
  wickStatusInfo.textContent = String(text || "");
}

function setModmailStatus(text) {
  if (!modmailStatusInfo) return;
  modmailStatusInfo.textContent = String(text || "");
}

function setLoggedIn(isLoggedIn) {
  adminPanel.classList.toggle("hidden", !isLoggedIn);
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

async function postAdmin(path, payload) {
  const response = await adminFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Aktion fehlgeschlagen");
  }
  return data;
}

function renderAiControl(info = {}, canEdit) {
  const enabled = info?.aiEnabled === true;
  const provider = String(info?.provider || "-");
  const model = String(info?.model || "-");

  aiControlInfo.textContent = `Status: ${enabled ? "aktiv" : "deaktiviert"} • Provider: ${provider} • Modell: ${model}`;

  enableAiBtn.disabled = !canEdit || enabled;
  disableAiBtn.disabled = !canEdit || !enabled;
}

function renderAiLogs(entries = []) {
  aiLogList.innerHTML = "";
  if (!entries.length) {
    const li = document.createElement("li");
    li.textContent = "Noch keine KI-Logs.";
    aiLogList.appendChild(li);
    return;
  }

  entries.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "ai-log-item";

    const at = entry.at ? new Date(entry.at).toLocaleString("de-DE") : "-";
    const state = entry.ok ? "ok" : `error: ${entry.error || "-"}`;

    const meta = document.createElement("div");
    meta.textContent = `${at} • ${entry.endpoint || "-"} • ${entry.mode || "-"} • ${state} • ${entry.provider || "-"}/${entry.model || "-"}`;

    const question = document.createElement("div");
    question.textContent = `Q: ${String(entry.prompt || "-")}`;

    const answer = document.createElement("div");
    answer.textContent = `A: ${String(entry.response || "-")}`;

    li.appendChild(meta);
    li.appendChild(question);
    li.appendChild(answer);
    aiLogList.appendChild(li);
  });
}

function sanitizeHexColor(raw, fallback = "#87CEFA") {
  const value = String(raw || "").trim();
  const m = value.match(/^#?[0-9a-fA-F]{6}$/);
  if (!m) return fallback;
  return `#${value.replace(/^#/, "").toUpperCase()}`;
}

function updateCommandModeUI() {
  const isEmbed = String(cmdModeSelect.value || "text") === "embed";
  if (cmdEmbedFields) cmdEmbedFields.classList.toggle("hidden", !isEmbed);
}

function commandModeView(modeRaw) {
  const mode = String(modeRaw || "text").toLowerCase();
  if (mode === "embed") return { label: "EMBED", badgeClass: "is-embed" };
  if (mode === "dm") return { label: "DM", badgeClass: "is-dm" };
  if (mode === "ban") return { label: "BAN", badgeClass: "is-ban" };
  if (mode === "mute") return { label: "MUTE", badgeClass: "is-mute" };
  if (mode === "kick") return { label: "KICK", badgeClass: "is-kick" };
  if (mode === "role") return { label: "ROLE", badgeClass: "is-role" };
  return { label: "TEXT", badgeClass: "is-text" };
}

function resetCommandForm() {
  editingTrigger = null;
  cmdTriggerInput.value = "";
  cmdModeSelect.value = "text";
  cmdEmbedTitleInput.value = "";
  cmdEmbedColorInput.value = "#87CEFA";
  cmdResponseInput.value = "";
  cmdEnabledInput.checked = true;
  if (cmdDeleteTriggerInput) cmdDeleteTriggerInput.checked = false;
  cmdSaveBtn.textContent = "Command speichern";
  updateCommandModeUI();
  setCommandStatus("Bereit. Neuen Command anlegen oder bestehenden bearbeiten.");
}

function setCommandEditorEnabled(enabled) {
  cmdTriggerInput.disabled = !enabled;
  cmdModeSelect.disabled = !enabled;
  cmdEmbedTitleInput.disabled = !enabled;
  cmdEmbedColorInput.disabled = !enabled;
  cmdResponseInput.disabled = !enabled;
  cmdEnabledInput.disabled = !enabled;
  if (cmdDeleteTriggerInput) cmdDeleteTriggerInput.disabled = !enabled;
  cmdSaveBtn.disabled = !enabled;
  cmdResetBtn.disabled = !enabled;
  if (wickGuildIdInput) wickGuildIdInput.disabled = !enabled;
  if (wickLogChannelInput) wickLogChannelInput.disabled = !enabled;
  if (wickEnabledInput) wickEnabledInput.disabled = !enabled;
  if (wickAutoStrikeInput) wickAutoStrikeInput.disabled = !enabled;
  if (wickTimeout3Input) wickTimeout3Input.disabled = !enabled;
  if (wickTimeout5Input) wickTimeout5Input.disabled = !enabled;
  if (wickAntiRaidEnabledInput) wickAntiRaidEnabledInput.disabled = !enabled;
  if (wickRaidJoinsInput) wickRaidJoinsInput.disabled = !enabled;
  if (wickRaidSecondsInput) wickRaidSecondsInput.disabled = !enabled;
  if (wickRaidSlowmodeInput) wickRaidSlowmodeInput.disabled = !enabled;
  if (wickAntiNukeEnabledInput) wickAntiNukeEnabledInput.disabled = !enabled;
  if (wickNukeChannelDeleteInput) wickNukeChannelDeleteInput.disabled = !enabled;
  if (wickNukeRoleDeleteInput) wickNukeRoleDeleteInput.disabled = !enabled;
  if (wickNukeLockdownInput) wickNukeLockdownInput.disabled = !enabled;
  if (wickLinkShieldEnabledInput) wickLinkShieldEnabledInput.disabled = !enabled;
  if (wickBlockInvitesInput) wickBlockInvitesInput.disabled = !enabled;
  if (wickWhitelistDomainsInput) wickWhitelistDomainsInput.disabled = !enabled;
  if (wickSaveBtn) wickSaveBtn.disabled = !enabled;
  if (wickResetBtn) wickResetBtn.disabled = !enabled;
  if (modmailReloadBtn) modmailReloadBtn.disabled = !enabled;
}

function modmailStatusLabel(status) {
  const value = String(status || "open").toLowerCase();
  if (value === "in_progress") return "In progress";
  if (value === "resolved") return "Resolved";
  if (value === "closed") return "Closed";
  return "Open";
}

function renderModmailInbox() {
  if (!modmailList) return;
  modmailList.innerHTML = "";

  if (!modmailItems.length) {
    const li = document.createElement("li");
    li.className = "command-empty";
    li.textContent = "No modmail messages yet.";
    modmailList.appendChild(li);
    setModmailStatus("Inbox is empty.");
    return;
  }

  setModmailStatus(`${modmailItems.length} message(s) loaded.`);

  modmailItems.forEach((entry) => {
    const li = document.createElement("li");
    li.className = "command-card";

    const header = document.createElement("div");
    header.className = "command-card-header";

    const title = document.createElement("h4");
    title.className = "command-card-title";
    title.textContent = `${String(entry.title || "No title").slice(0, 120)} (${entry.type || "other"})`;

    const statusBadge = document.createElement("span");
    statusBadge.className = `command-chip ${entry.status === "resolved" || entry.status === "closed" ? "chip-enabled" : "chip-rate"}`;
    statusBadge.textContent = modmailStatusLabel(entry.status);

    header.appendChild(title);
    header.appendChild(statusBadge);

    const meta = document.createElement("div");
    meta.className = "command-card-preview";
    const at = entry.createdAt ? new Date(entry.createdAt).toLocaleString("en-US") : "-";
    meta.textContent = `ID: ${entry.id || "-"} | ${at} | Contact: ${entry.contact || "n/a"}`;

    const body = document.createElement("div");
    body.className = "command-card-preview";
    body.textContent = String(entry.message || "").slice(0, 1000);

    const noteLabel = document.createElement("label");
    noteLabel.textContent = "Admin note";

    const noteInput = document.createElement("textarea");
    noteInput.rows = 3;
    noteInput.maxLength = 1000;
    noteInput.value = String(entry.adminNote || "");
    noteInput.disabled = !canEditAdmin;

    const statusSelect = document.createElement("select");
    ["open", "in_progress", "resolved", "closed"].forEach((status) => {
      const option = document.createElement("option");
      option.value = status;
      option.textContent = modmailStatusLabel(status);
      if (String(entry.status || "open") === status) option.selected = true;
      statusSelect.appendChild(option);
    });
    statusSelect.disabled = !canEditAdmin;

    const actions = document.createElement("div");
    actions.className = "command-card-actions";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "primary command-card-btn";
    saveBtn.textContent = "Save";
    saveBtn.disabled = !canEditAdmin;
    saveBtn.addEventListener("click", async () => {
      try {
        saveBtn.disabled = true;
        const out = await postAdmin("/api/admin/modmail", {
          id: entry.id,
          status: statusSelect.value,
          adminNote: noteInput.value
        });
        const idx = modmailItems.findIndex((item) => item.id === entry.id);
        if (idx >= 0) modmailItems[idx] = out.item;
        renderModmailInbox();
        setInfo(`Modmail ${entry.id} updated.`);
      } catch (error) {
        setInfo(error.message || "Could not update modmail entry.");
      } finally {
        saveBtn.disabled = !canEditAdmin;
      }
    });

    actions.appendChild(saveBtn);
    li.appendChild(header);
    li.appendChild(meta);
    li.appendChild(body);
    li.appendChild(noteLabel);
    li.appendChild(noteInput);
    li.appendChild(statusSelect);
    li.appendChild(actions);
    modmailList.appendChild(li);
  });
}

async function loadModmailInbox() {
  const status = String(modmailStatusFilter?.value || "all");
  const response = await adminFetch(`/api/admin/modmail?status=${encodeURIComponent(status)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Could not load modmail inbox.");
  }
  modmailItems = Array.isArray(data.items) ? data.items : [];
  renderModmailInbox();
}

function normalizeGuildId(input) {
  const id = String(input || "").trim();
  if (!/^\d{5,30}$/.test(id)) return "";
  return id;
}

function parseDomainList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 200);
}

function wickConfigFromForm() {
  return {
    enabled: !!wickEnabledInput.checked,
    logChannelId: normalizeGuildId(wickLogChannelInput.value) || null,
    autoStrikeOnWarn: !!wickAutoStrikeInput.checked,
    timeoutAt3: Math.max(0, Number(wickTimeout3Input.value || 30) || 30),
    timeoutAt5: Math.max(0, Number(wickTimeout5Input.value || 1440) || 1440),
    antiRaid: {
      enabled: !!wickAntiRaidEnabledInput.checked,
      joins: Math.max(2, Number(wickRaidJoinsInput.value || 8) || 8),
      seconds: Math.max(5, Number(wickRaidSecondsInput.value || 20) || 20),
      slowmodeSeconds: Math.max(0, Number(wickRaidSlowmodeInput.value || 15) || 15)
    },
    antiNuke: {
      enabled: !!wickAntiNukeEnabledInput.checked,
      maxChannelDeletePerMinute: Math.max(1, Number(wickNukeChannelDeleteInput.value || 4) || 4),
      maxRoleDeletePerMinute: Math.max(1, Number(wickNukeRoleDeleteInput.value || 3) || 3),
      lockdownMinutes: Math.max(1, Number(wickNukeLockdownInput.value || 10) || 10)
    },
    linkShield: {
      enabled: !!wickLinkShieldEnabledInput.checked,
      blockDiscordInvites: !!wickBlockInvitesInput.checked,
      whitelistDomains: parseDomainList(wickWhitelistDomainsInput.value)
    }
  };
}

function fillWickForm(guildId, cfg = null) {
  wickGuildIdInput.value = String(guildId || "").trim();
  const c = cfg || {
    enabled: true,
    logChannelId: "",
    autoStrikeOnWarn: true,
    timeoutAt3: 30,
    timeoutAt5: 1440,
    antiRaid: { enabled: true, joins: 8, seconds: 20, slowmodeSeconds: 15 },
    antiNuke: { enabled: true, maxChannelDeletePerMinute: 4, maxRoleDeletePerMinute: 3, lockdownMinutes: 10 },
    linkShield: { enabled: false, blockDiscordInvites: true, whitelistDomains: [] }
  };
  wickEnabledInput.checked = c.enabled !== false;
  wickLogChannelInput.value = c.logChannelId || "";
  wickAutoStrikeInput.checked = c.autoStrikeOnWarn !== false;
  wickTimeout3Input.value = Number(c.timeoutAt3 || 30);
  wickTimeout5Input.value = Number(c.timeoutAt5 || 1440);
  wickAntiRaidEnabledInput.checked = c.antiRaid?.enabled !== false;
  wickRaidJoinsInput.value = Number(c.antiRaid?.joins || 8);
  wickRaidSecondsInput.value = Number(c.antiRaid?.seconds || 20);
  wickRaidSlowmodeInput.value = Number(c.antiRaid?.slowmodeSeconds || 15);
  wickAntiNukeEnabledInput.checked = c.antiNuke?.enabled !== false;
  wickNukeChannelDeleteInput.value = Number(c.antiNuke?.maxChannelDeletePerMinute || 4);
  wickNukeRoleDeleteInput.value = Number(c.antiNuke?.maxRoleDeletePerMinute || 3);
  wickNukeLockdownInput.value = Number(c.antiNuke?.lockdownMinutes || 10);
  wickLinkShieldEnabledInput.checked = c.linkShield?.enabled === true;
  wickBlockInvitesInput.checked = c.linkShield?.blockDiscordInvites !== false;
  wickWhitelistDomainsInput.value = Array.isArray(c.linkShield?.whitelistDomains) ? c.linkShield.whitelistDomains.join(", ") : "";
}

function resetWickForm() {
  fillWickForm("", null);
  setWickStatus("Bereit. Guild ID eingeben, konfigurieren und speichern.");
}

function renderWickGuilds() {
  if (!wickGuildList) return;
  wickGuildList.innerHTML = "";
  const guilds = wickSettingsState && wickSettingsState.guilds && typeof wickSettingsState.guilds === "object"
    ? wickSettingsState.guilds
    : {};
  const entries = Object.entries(guilds).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "command-empty";
    li.textContent = "Noch keine Wick Guild-Konfiguration gespeichert.";
    wickGuildList.appendChild(li);
    return;
  }

  entries.forEach(([guildId, cfg]) => {
    const li = document.createElement("li");
    li.className = "wick-guild-card";

    const header = document.createElement("div");
    header.className = "command-card-header";

    const title = document.createElement("h4");
    title.className = "command-card-title";
    title.textContent = guildId;

    const badge = document.createElement("span");
    badge.className = `command-chip ${cfg.enabled === false ? "chip-disabled" : "chip-enabled"}`;
    badge.textContent = cfg.enabled === false ? "Disabled" : "Enabled";

    header.appendChild(title);
    header.appendChild(badge);

    const meta = document.createElement("div");
    meta.className = "wick-guild-meta";
    meta.textContent = `AutoStrike: ${cfg.autoStrikeOnWarn !== false ? "on" : "off"} | Timeout 3/5: ${cfg.timeoutAt3 || 30}m/${cfg.timeoutAt5 || 1440}m | AntiRaid: ${cfg.antiRaid?.enabled !== false ? "on" : "off"} | AntiNuke: ${cfg.antiNuke?.enabled !== false ? "on" : "off"}`;

    const actions = document.createElement("div");
    actions.className = "wick-guild-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "mini-btn command-card-btn";
    editBtn.textContent = "Edit";
    editBtn.disabled = !canEditAdmin;
    editBtn.addEventListener("click", () => {
      fillWickForm(guildId, cfg);
      setWickStatus(`Guild ${guildId} geladen.`);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "kick-btn command-card-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.disabled = !canEditAdmin;
    deleteBtn.addEventListener("click", async () => {
      if (!window.confirm(`Wick Settings fuer Guild ${guildId} loeschen?`)) return;
      try {
        const next = { ...(wickSettingsState || {}), guilds: { ...(wickSettingsState.guilds || {}) } };
        delete next.guilds[guildId];
        const data = await postAdmin("/api/admin/wick-settings", { settings: next });
        wickSettingsState = data?.settings || { guilds: {} };
        renderWickGuilds();
        setInfo(`Wick Settings fuer Guild ${guildId} geloescht.`);
      } catch (error) {
        setInfo(error.message || "Guild-Settings konnten nicht geloescht werden");
      }
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    li.appendChild(header);
    li.appendChild(meta);
    li.appendChild(actions);
    wickGuildList.appendChild(li);
  });
}

async function loadWickSettings() {
  const response = await adminFetch("/api/admin/wick-settings");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Wick Settings konnten nicht geladen werden");
  wickSettingsState = data?.settings && typeof data.settings === "object" ? data.settings : { guilds: {} };
  renderWickGuilds();
  if (data?.persisted === false && data?.persistError) setInfo(`Wick Warnung: ${data.persistError}`);
  setWickStatus(`Wick Settings geladen: ${Object.keys(wickSettingsState.guilds || {}).length} Guild(s).`);
}

async function saveDiscordCommands() {
  const payload = {
    commands: discordCommands.map((entry) => ({
      trigger: entry.trigger,
      response: entry.response,
      enabled: entry.enabled !== false,
      deleteTriggerMessage: entry.deleteTriggerMessage === true,
      mode: entry.mode || "text",
      embedTitle: entry.embedTitle || "",
      embedColor: sanitizeHexColor(entry.embedColor || "#87CEFA")
    }))
  };
  const data = await postAdmin("/api/admin/discord-commands", payload);
  discordCommands = Array.isArray(data?.commands) ? data.commands : [];
  if (data?.persisted === false && data?.persistError) {
    setInfo(`Gespeichert, aber Warnung: ${data.persistError}`);
  } else if (data?.persistError) {
    setInfo(`Gespeichert. Hinweis: ${data.persistError}`);
  }
  return data;
}

function renderDiscordCommands() {
  commandList.innerHTML = "";
  if (!discordCommands.length) {
    const li = document.createElement("li");
    li.className = "command-empty";
    li.textContent = "Noch keine Commands angelegt.";
    commandList.appendChild(li);
    setCommandStatus("0 Commands vorhanden. Lege deinen ersten Command an.");
    return;
  }

  const search = String(cmdSearchInput?.value || "").trim().toLowerCase();
  const actionFilter = String(cmdFilterAction?.value || "all").trim().toLowerCase();

  const visibleCommands = discordCommands.filter((entry) => {
    const mode = String(entry.mode || "text").toLowerCase();
    if (actionFilter !== "all" && mode !== actionFilter) return false;
    if (!search) return true;
    const haystack = `${entry.trigger || ""} ${entry.response || ""} ${entry.embedTitle || ""}`.toLowerCase();
    return haystack.includes(search);
  });

  if (!visibleCommands.length) {
    const li = document.createElement("li");
    li.className = "command-empty";
    li.textContent = "Keine Commands passend zur Suche gefunden.";
    commandList.appendChild(li);
    const activeSearch = search ? `Suche: "${search}"` : "Suche: -";
    const activeFilter = actionFilter !== "all" ? `Filter: ${actionFilter}` : "Filter: alle";
    setCommandStatus(`Keine Treffer. ${activeSearch} | ${activeFilter}`);
    return;
  }

  setCommandStatus(`${visibleCommands.length} von ${discordCommands.length} Commands sichtbar.`);

  visibleCommands
    .slice()
    .sort((a, b) => String(a.trigger).localeCompare(String(b.trigger)))
    .forEach((entry) => {
      const li = document.createElement("li");
      li.className = "command-card";

      const mode = String(entry.mode || "text").toLowerCase();
      const modeView = commandModeView(mode);

      const header = document.createElement("div");
      header.className = "command-card-header";

      const title = document.createElement("h4");
      title.className = "command-card-title";
      title.textContent = String(entry.trigger || "-");

      const actionBadge = document.createElement("span");
      actionBadge.className = `command-action-badge ${modeView.badgeClass}`;
      actionBadge.textContent = modeView.label;

      header.appendChild(title);
      header.appendChild(actionBadge);

      const chips = document.createElement("div");
      chips.className = "command-card-chips";

      const rateChip = document.createElement("span");
      rateChip.className = "command-chip chip-rate";
      rateChip.textContent = "Rate Limited";

      const stateChip = document.createElement("span");
      stateChip.className = `command-chip ${entry.enabled === false ? "chip-disabled" : "chip-enabled"}`;
      stateChip.textContent = entry.enabled === false ? "Disabled" : "Enabled";

      const delChip = document.createElement("span");
      delChip.className = `command-chip ${entry.deleteTriggerMessage === true ? "chip-enabled" : "chip-disabled"}`;
      delChip.textContent = entry.deleteTriggerMessage === true ? "Del Msg" : "Keep Msg";

      chips.appendChild(rateChip);
      chips.appendChild(stateChip);
      chips.appendChild(delChip);

      const preview = document.createElement("div");
      preview.className = "command-card-preview";
      const previewText = String(entry.response || "").trim();
      preview.textContent = previewText ? previewText.slice(0, 160) : "Keine Vorschau";

      const actions = document.createElement("div");
      actions.className = "command-card-actions";

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "mini-btn command-card-btn";
      editBtn.textContent = "Edit";
      editBtn.disabled = !canEditAdmin;
      editBtn.addEventListener("click", () => {
        editingTrigger = entry.trigger;
        cmdTriggerInput.value = entry.trigger;
        cmdModeSelect.value = entry.mode || "text";
        cmdEmbedTitleInput.value = entry.embedTitle || "";
        cmdEmbedColorInput.value = sanitizeHexColor(entry.embedColor || "#87CEFA");
        cmdResponseInput.value = entry.response || "";
        cmdEnabledInput.checked = entry.enabled !== false;
        if (cmdDeleteTriggerInput) cmdDeleteTriggerInput.checked = entry.deleteTriggerMessage === true;
        cmdSaveBtn.textContent = "Command aktualisieren";
        updateCommandModeUI();
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "kick-btn command-card-btn";
      deleteBtn.textContent = "Delete";
      deleteBtn.disabled = !canEditAdmin;
      deleteBtn.addEventListener("click", async () => {
        if (!window.confirm(`Command *${entry.trigger} loeschen?`)) return;
        try {
          discordCommands = discordCommands.filter((item) => item.trigger !== entry.trigger);
          await saveDiscordCommands();
          renderDiscordCommands();
          setInfo(`Command *${entry.trigger} geloescht.`);
          if (editingTrigger === entry.trigger) resetCommandForm();
        } catch (error) {
          setInfo(error.message || "Command konnte nicht geloescht werden");
        }
      });

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
      li.appendChild(header);
      li.appendChild(chips);
      li.appendChild(preview);
      li.appendChild(actions);
      commandList.appendChild(li);
    });
}

async function loadDiscordCommands() {
  const response = await adminFetch("/api/admin/discord-commands");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Discord Commands konnten nicht geladen werden");
  }
  discordCommands = Array.isArray(data?.commands) ? data.commands : [];
  if (data?.persisted === false && data?.persistError) {
    setInfo(`Warnung: ${data.persistError}`);
  }
  if (discordCommands.length) {
    setCommandStatus(`${discordCommands.length} Commands geladen.`);
  } else {
    setCommandStatus("Noch keine Commands vorhanden.");
  }
  renderDiscordCommands();
}

async function loadAdmin() {
  setInfo("Lade Admin-Daten…");
  try {
    const adminResponse = await adminFetch("/api/admin");
    const adminData = await adminResponse.json().catch(() => ({}));
    if (!adminResponse.ok) {
      throw new Error(adminData.error || "Kein Zugriff");
    }

    const aiResponse = await adminFetch("/api/admin/ai/logs");
    const aiData = await aiResponse.json().catch(() => ({}));
    if (!aiResponse.ok) {
      throw new Error(aiData.error || "KI-Logs konnten nicht geladen werden");
    }

    canEditAdmin = !!adminData?.access?.canEdit;
    renderAiControl(aiData, canEditAdmin);
    renderAiLogs(aiData.logs || []);
    setCommandEditorEnabled(canEditAdmin);
    await loadDiscordCommands();
    await loadWickSettings();
    await loadModmailInbox();
    setInfo(`Aktualisiert (${adminData?.access?.role || "viewer"})`);
    setLoggedIn(true);
  } catch (error) {
    setLoggedIn(false);
    setCommandEditorEnabled(false);
    setInfo(error.message || "Admin-Login fehlgeschlagen");
  }
}

document.getElementById("adminLoginBtn").addEventListener("click", async () => {
  adminKey = String(adminKeyInput.value || "").trim();
  if (!adminKey) {
    setInfo("Bitte Admin-Key eingeben.");
    return;
  }
  window.localStorage.setItem(ADMIN_KEY_STORAGE, adminKey);
  window.localStorage.setItem(ADMIN_KEY_DRAFT_STORAGE, adminKey);
  await loadAdmin();
});

document.getElementById("adminLogoutBtn").addEventListener("click", () => {
  adminKey = "";
  window.localStorage.removeItem(ADMIN_KEY_STORAGE);
  setLoggedIn(false);
  setInfo("Abgemeldet");
});

refreshBtn.addEventListener("click", loadAdmin);

enableAiBtn.addEventListener("click", async () => {
  try {
    await postAdmin("/api/admin/ai/toggle", { enabled: true });
    setInfo("KI wurde global eingeschaltet.");
    await loadAdmin();
  } catch (error) {
    setInfo(error.message || "KI konnte nicht eingeschaltet werden");
  }
});

disableAiBtn.addEventListener("click", async () => {
  try {
    await postAdmin("/api/admin/ai/toggle", { enabled: false });
    setInfo("KI wurde global ausgeschaltet.");
    await loadAdmin();
  } catch (error) {
    setInfo(error.message || "KI konnte nicht ausgeschaltet werden");
  }
});

cmdSaveBtn.addEventListener("click", async () => {
  if (!canEditAdmin) {
    setInfo("Keine Bearbeitungsrechte fuer Commands.");
    return;
  }

  const trigger = String(cmdTriggerInput.value || "").trim().toLowerCase().replace(/\s+/g, "");
  const mode = String(cmdModeSelect.value || "text").trim().toLowerCase();
  const response = String(cmdResponseInput.value || "").trim();
  const embedTitle = String(cmdEmbedTitleInput.value || "").trim();
  const embedColor = sanitizeHexColor(cmdEmbedColorInput.value || "#87CEFA");

  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(trigger)) {
    setInfo("Trigger ungueltig. Erlaubt: a-z, 0-9, _, -, Laenge 2-32.");
    return;
  }
  if (!response) {
    setInfo("Antwort darf nicht leer sein.");
    return;
  }

  const allowedModes = new Set(["text", "embed", "dm", "ban", "mute", "kick", "role"]);
  const normalizedMode = allowedModes.has(mode) ? mode : "text";

  const next = {
    trigger,
    response,
    enabled: !!cmdEnabledInput.checked,
    deleteTriggerMessage: !!(cmdDeleteTriggerInput && cmdDeleteTriggerInput.checked),
    mode: normalizedMode,
    embedTitle,
    embedColor
  };

  try {
    const existingIndex = discordCommands.findIndex((entry) => entry.trigger === trigger);
    if (existingIndex >= 0) {
      discordCommands[existingIndex] = next;
    } else {
      discordCommands.push(next);
    }

    if (editingTrigger && editingTrigger !== trigger) {
      discordCommands = discordCommands.filter((entry) => entry.trigger !== editingTrigger);
    }

    const out = await saveDiscordCommands();
    if (cmdSearchInput) cmdSearchInput.value = "";
    if (cmdFilterAction) cmdFilterAction.value = "all";
    renderDiscordCommands();
    resetCommandForm();
    const sync = out?.sync || {};
    if (sync.attempted) {
      if (sync.ok) setInfo(`Command *${trigger} gespeichert und Bot sofort synchronisiert.`);
      else {
        const syncError = String(sync.error || "").toLowerCase();
        if (syncError.includes("timeout")) {
          setInfo(`Command *${trigger} gespeichert. Bot-Sync laeuft verzoegert, der Polling-Fallback uebernimmt.`);
        } else {
          setInfo(`Command *${trigger} gespeichert. Sofort-Sync fehlgeschlagen: ${sync.error || "unknown"}.`);
        }
      }
    } else {
      setInfo(`Command *${trigger} gespeichert.`);
    }
    if (out?.persistPath) {
      setCommandStatus(`Command *${trigger} gespeichert. Speicherpfad: ${out.persistPath}`);
    } else {
      setCommandStatus(`Command *${trigger} gespeichert und unten in der Liste aktualisiert.`);
    }
  } catch (error) {
    setInfo(error.message || "Command konnte nicht gespeichert werden");
    setCommandStatus("Speichern fehlgeschlagen. Bitte Eingaben und Zugriff pruefen.");
  }
});

cmdResetBtn.addEventListener("click", () => {
  if (cmdSearchInput) cmdSearchInput.value = "";
  if (cmdFilterAction) cmdFilterAction.value = "all";
  renderDiscordCommands();
  resetCommandForm();
  setInfo("Formular zurueckgesetzt.");
});

if (wickSaveBtn) {
  wickSaveBtn.addEventListener("click", async () => {
    if (!canEditAdmin) {
      setInfo("Keine Bearbeitungsrechte fuer Wick Settings.");
      return;
    }

    const guildId = normalizeGuildId(wickGuildIdInput.value);
    if (!guildId) {
      setInfo("Bitte eine gueltige Guild ID angeben.");
      return;
    }

    const next = { ...(wickSettingsState || {}), guilds: { ...(wickSettingsState.guilds || {}) } };
    next.guilds[guildId] = wickConfigFromForm();

    try {
      const out = await postAdmin("/api/admin/wick-settings", { settings: next });
      wickSettingsState = out?.settings || { guilds: {} };
      renderWickGuilds();
      const sync = out?.sync || {};
      if (sync.attempted && !sync.ok) {
        setInfo(`Wick Settings gespeichert. Sofort-Sync fehlgeschlagen: ${sync.error || "unknown"}.`);
      } else if (sync.attempted && sync.ok) {
        setInfo(`Wick Settings fuer Guild ${guildId} gespeichert und Bot synchronisiert.`);
      } else {
        setInfo(`Wick Settings fuer Guild ${guildId} gespeichert.`);
      }
      if (out?.persistPath) setWickStatus(`Gespeichert. Speicherpfad: ${out.persistPath}`);
      else setWickStatus(`Guild ${guildId} erfolgreich gespeichert.`);
    } catch (error) {
      setInfo(error.message || "Wick Settings konnten nicht gespeichert werden");
      setWickStatus("Speichern fehlgeschlagen. Eingaben und Berechtigung pruefen.");
    }
  });
}

if (wickResetBtn) {
  wickResetBtn.addEventListener("click", () => {
    resetWickForm();
    setInfo("Wick Formular zurueckgesetzt.");
  });
}

if (cmdModeSelect) cmdModeSelect.addEventListener("change", updateCommandModeUI);
if (cmdSearchInput) {
  cmdSearchInput.addEventListener("input", () => {
    renderDiscordCommands();
    const query = String(cmdSearchInput.value || "").trim();
    if (query) setCommandStatus(`Suche aktiv: "${query}"`);
  });
}
if (cmdFilterAction) {
  cmdFilterAction.addEventListener("change", () => {
    renderDiscordCommands();
    const mode = String(cmdFilterAction.value || "all");
    setCommandStatus(mode === "all" ? "Filter entfernt. Alle Aktionen sichtbar." : `Filter aktiv: ${mode}`);
  });
}

if (modmailStatusFilter) {
  modmailStatusFilter.addEventListener("change", async () => {
    try {
      await loadModmailInbox();
    } catch (error) {
      setInfo(error.message || "Could not refresh modmail inbox.");
    }
  });
}

if (modmailReloadBtn) {
  modmailReloadBtn.addEventListener("click", async () => {
    try {
      await loadModmailInbox();
      setInfo("Modmail inbox refreshed.");
    } catch (error) {
      setInfo(error.message || "Could not refresh modmail inbox.");
    }
  });
}

adminKeyInput.addEventListener("input", () => {
  window.localStorage.setItem(ADMIN_KEY_DRAFT_STORAGE, String(adminKeyInput.value || ""));
});

if (adminKey) {
  adminKeyInput.value = adminKey;
  resetCommandForm();
  resetWickForm();
  updateCommandModeUI();
  loadAdmin();
} else {
  setLoggedIn(false);
  setCommandEditorEnabled(false);
  resetCommandForm();
  resetWickForm();
  updateCommandModeUI();
  setInfo("Bitte einloggen");
}
