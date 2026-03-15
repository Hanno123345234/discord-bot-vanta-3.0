const fs = require('fs');
const path = require('path');

const BUILTIN_CLAIMING_CONFIG = {
  channels: {
    announceNormal: '',
    announceReload: '',
    claimStaff: '',
    claimHead: '',
  },
  roles: {
    staff: '',
    head: '',
    headStaff: '',
  },
  timing: {
    preRegLeadMs: 60 * 60 * 1000,
    catchupMs: 90 * 60 * 1000,
    headImmediateLeadMs: 1200,
  },
  limits: {
    staffMaxClaims: 1,
    headMaxClaims: 2,
  },
};

let CLAIMING_CONFIG = BUILTIN_CLAIMING_CONFIG;
try {
  const external = require('./claiming.config');
  CLAIMING_CONFIG = {
    ...BUILTIN_CLAIMING_CONFIG,
    ...external,
    channels: { ...BUILTIN_CLAIMING_CONFIG.channels, ...(external && external.channels ? external.channels : {}) },
    roles: { ...BUILTIN_CLAIMING_CONFIG.roles, ...(external && external.roles ? external.roles : {}) },
    timing: { ...BUILTIN_CLAIMING_CONFIG.timing, ...(external && external.timing ? external.timing : {}) },
    limits: { ...BUILTIN_CLAIMING_CONFIG.limits, ...(external && external.limits ? external.limits : {}) },
  };
} catch (_) {}
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ApplicationCommandOptionType,
  PermissionsBitField,
} = require('discord.js');

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function saveJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

function parseHHMMToNextMs(input, now = new Date()) {
  const m = String(input || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (d.getTime() + 60_000 < now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function parseAnnouncementSessions(content, referenceDate = new Date()) {
  const lines = String(content || '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const out = [];
  let current = null;

  const toMs = (token) => {
    const ts = String(token || '').trim().match(/^<t:(\d+):t>$/i);
    if (ts) return Number(ts[1]) * 1000;
    const hm = String(token || '').trim().match(/^([0-2]?\d):([0-5]\d)$/);
    if (!hm) return null;
    const d = new Date(referenceDate);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    return d.getTime();
  };

  for (const rawLine of lines) {
    const line = rawLine
      .replace(/^[\s>*•◦\-–—]+/, '')
      .replace(/[*_`~]/g, '')
      .trim();

    const header = line.match(/^session\D*(\d+)/i) || line.match(/^\d+\.?\s*(\d+)$/i);
    if (header) {
      if (current && current.reg != null && current.game != null) out.push(current);
      current = { index: Number(header[1]), reg: null, game: null };
      continue;
    }

    if (!current) continue;

    const reg = line.match(/registration\D*(<t:\d+:t>|[0-2]?\d:[0-5]\d)/i);
    if (reg) {
      const ms = toMs(reg[1]);
      if (ms != null) current.reg = ms;
      continue;
    }

    const game = line.match(/first\s*game\D*(<t:\d+:t>|[0-2]?\d:[0-5]\d)/i);
    if (game) {
      const ms = toMs(game[1]);
      if (ms != null) current.game = ms;
      continue;
    }
  }

  if (current && current.reg != null && current.game != null) out.push(current);

  return out.map(s => {
    let reg = Number(s.reg);
    let game = Number(s.game);
    if (game <= reg) game += 24 * 60 * 60 * 1000;
    return { index: s.index, regTs: Math.floor(reg / 1000), gameTs: Math.floor(game / 1000) };
  });
}

class ClaimingSystem {
  constructor(options = {}) {
    this.dataDir = options.dataDir || process.cwd();
    this.announceChannelId = String(options.announceChannelId || CLAIMING_CONFIG.channels.announceNormal);
    this.announceReloadChannelId = String(options.announceReloadChannelId || CLAIMING_CONFIG.channels.announceReload || '');
    this.staffClaimChannelId = String(options.staffClaimChannelId || CLAIMING_CONFIG.channels.claimStaff);
    this.headClaimChannelId = String(options.headClaimChannelId || CLAIMING_CONFIG.channels.claimHead);
    this.staffRoleId = String(options.staffRoleId || CLAIMING_CONFIG.roles.staff);
    this.headStaffRoleId = String(options.headStaffRoleId || CLAIMING_CONFIG.roles.headStaff || CLAIMING_CONFIG.roles.staff);
    this.staffMaxClaims = Number(options.staffMaxClaims || CLAIMING_CONFIG.limits.staffMaxClaims || 1);
    this.headMaxClaims = Number(options.headMaxClaims || CLAIMING_CONFIG.limits.headMaxClaims || 2);
    this.headImmediateLeadMs = Number(options.headImmediateLeadMs || CLAIMING_CONFIG.timing.headImmediateLeadMs || 1200);
    this.preLeadMs = Number(options.preLeadMs || CLAIMING_CONFIG.timing.preRegLeadMs);
    this.catchupMs = Number(options.catchupMs || CLAIMING_CONFIG.timing.catchupMs);

    this.claimPanels = new Map();
    this.claimTimers = new Map();
    this.preRegTimers = new Map();

    this.claimSchedulesPath = path.join(this.dataDir, 'duo_claim_schedules.json');
    this.preRegJobsPath = path.join(this.dataDir, 'pre_reg_staff_jobs.json');
    this.panelStatesPath = path.join(this.dataDir, 'claim_panel_states.json');

    this.client = null;
  }

  static getClaimCommandData() {
    return {
      name: 'claim',
      description: 'Schedule a duo session claim panel',
      options: [
        { name: 'time', description: 'Start time in HH:MM (24h)', type: ApplicationCommandOptionType.String, required: true },
        { name: 'gamemode', description: 'Gamemode label (e.g. Duos)', type: ApplicationCommandOptionType.String, required: true },
        { name: 'session', description: 'Session number', type: ApplicationCommandOptionType.Integer, required: true, min_value: 1 },
        { name: 'reload', description: 'Is this a reload session?', type: ApplicationCommandOptionType.Boolean, required: false },
      ],
    };
  }

  init(client) {
    this.client = client;
    this.restorePanelStates();
    this.restoreClaimSchedules();
    this.restorePreRegJobs();
  }

  loadPanelStates() {
    const rows = loadJson(this.panelStatesPath, []);
    return Array.isArray(rows) ? rows : [];
  }

  savePanelStates(rows) {
    saveJson(this.panelStatesPath, Array.isArray(rows) ? rows : []);
  }

  upsertPanelState(state) {
    const panelId = String(state?.panelId || '');
    if (!panelId) return;

    const clean = {
      panelId,
      panelType: String(state.panelType || ''),
      channelId: String(state.channelId || ''),
      targetKey: String(state.targetKey || ''),
      claimRoleId: String(state.claimRoleId || ''),
      maxClaimsPerUser: Number(state.maxClaimsPerUser || 0),
      gamemode: state.gamemode,
      session: state.session,
      reload: !!state.reload,
      sessionIndex: state.sessionIndex,
      regTs: state.regTs,
      gameTs: state.gameTs,
      claims: Array.isArray(state.claims) ? state.claims.map(x => String(x)) : [],
      sessions: Array.isArray(state.sessions)
        ? state.sessions.map(s => ({
            sessionNumber: Number(s.sessionNumber || 0),
            regTs: Number(s.regTs || 0),
            gameTs: Number(s.gameTs || 0),
            supervisorId: s.supervisorId ? String(s.supervisorId) : null,
          }))
        : [],
      updatedAt: Date.now(),
    };

    const all = this.loadPanelStates();
    const idx = all.findIndex(x => String(x.panelId || '') === panelId);
    if (idx >= 0) all[idx] = clean;
    else all.push(clean);
    this.savePanelStates(all);
  }

  getPanelState(panelId) {
    const id = String(panelId || '');
    if (!id) return null;

    const mem = this.claimPanels.get(id);
    if (mem) return mem;

    const all = this.loadPanelStates();
    const found = all.find(x => String(x.panelId || '') === id);
    if (!found) return null;

    const hydrated = {
      panelId: id,
      panelType: String(found.panelType || ''),
      channelId: String(found.channelId || ''),
      targetKey: String(found.targetKey || ''),
      claimRoleId: String(found.claimRoleId || ''),
      maxClaimsPerUser: Number(found.maxClaimsPerUser || 0),
      gamemode: found.gamemode,
      session: found.session,
      reload: !!found.reload,
      sessionIndex: found.sessionIndex,
      regTs: found.regTs,
      gameTs: found.gameTs,
      claims: Array.isArray(found.claims) ? found.claims.map(x => String(x)) : [],
      sessions: Array.isArray(found.sessions)
        ? found.sessions.map(s => ({
            sessionNumber: Number(s.sessionNumber || 0),
            regTs: Number(s.regTs || 0),
            gameTs: Number(s.gameTs || 0),
            supervisorId: s.supervisorId ? String(s.supervisorId) : null,
          }))
        : [],
    };
    this.claimPanels.set(id, hydrated);
    return hydrated;
  }

  restorePanelStates() {
    const all = this.loadPanelStates();
    const keep = [];

    for (const row of all) {
      const panelId = String(row?.panelId || '');
      if (!panelId) continue;

      const restored = {
        panelId,
        panelType: String(row.panelType || ''),
        channelId: String(row.channelId || ''),
        targetKey: String(row.targetKey || ''),
        claimRoleId: String(row.claimRoleId || ''),
        maxClaimsPerUser: Number(row.maxClaimsPerUser || 0),
        gamemode: row.gamemode,
        session: row.session,
        reload: !!row.reload,
        sessionIndex: row.sessionIndex,
        regTs: row.regTs,
        gameTs: row.gameTs,
        claims: Array.isArray(row.claims) ? row.claims.map(x => String(x)) : [],
        sessions: Array.isArray(row.sessions)
          ? row.sessions.map(s => ({
              sessionNumber: Number(s.sessionNumber || 0),
              regTs: Number(s.regTs || 0),
              gameTs: Number(s.gameTs || 0),
              supervisorId: s.supervisorId ? String(s.supervisorId) : null,
            }))
          : [],
      };

      this.claimPanels.set(panelId, restored);
      keep.push({ ...restored, updatedAt: Date.now() });
    }

    this.savePanelStates(keep);
  }

  buildClaimEmbed(state) {
    const claims = Array.isArray(state.claims) ? state.claims : [];
    const title = state.reload ? `Reload Session ${state.session}` : `${state.gamemode} Session ${state.session}`;
    const embed = new EmbedBuilder().setColor(0x87CEFA).setTitle(title);

    if (!claims.length) {
      embed.setDescription('No session claimed yet.\n\nPress a button below to claim/unclaim.');
      return embed;
    }

    embed.setDescription('Lobby order:');
    const fields = [];
    const shown = claims.slice(0, 24);
    for (let i = 0; i < shown.length; i += 2) {
      fields.push({ name: `Lobby ${i + 1}`, value: `<@${shown[i]}>`, inline: true });
      if (shown[i + 1]) fields.push({ name: `Lobby ${i + 2}`, value: `<@${shown[i + 1]}>`, inline: true });
      else fields.push({ name: '\u200B', value: '\u200B', inline: true });
      fields.push({ name: '\u200B', value: '\u200B', inline: true });
    }
    fields.push({ name: '\u200B', value: 'Press the button to claim/unclaim', inline: false });
    embed.addFields(fields);
    return embed;
  }

  buildStaffPanelEmbed(panel) {
    const claims = Array.isArray(panel.claims) ? panel.claims : [];
    const title = panel.reload ? `Reload Session ${panel.sessionIndex} Staff Panel` : `Duos Session ${panel.sessionIndex} Staff Panel`;
    const embed = new EmbedBuilder()
      .setColor(0x87CEFA)
      .setTitle(title)
      .setDescription(`**Registration:** <t:${panel.regTs}:t>\n**First Game:** <t:${panel.gameTs}:t>`)
      .setFooter({ text: `Session ID: auto_${panel.sessionIndex}_${panel.regTs}` });

    const fields = [];
    fields.push({ name: 'Lobby 1', value: claims[0] ? `<@${claims[0]}>` : '—', inline: true });
    fields.push({ name: 'Lobby 2', value: claims[1] ? `<@${claims[1]}>` : '—', inline: true });
    fields.push({ name: '\u200B', value: '\u200B', inline: true });

    for (let i = 2; i < claims.length; i += 2) {
      fields.push({ name: `Lobby ${i + 1}`, value: `<@${claims[i]}>`, inline: true });
      if (claims[i + 1]) fields.push({ name: `Lobby ${i + 2}`, value: `<@${claims[i + 1]}>`, inline: true });
      else fields.push({ name: '\u200B', value: '\u200B', inline: true });
      fields.push({ name: '\u200B', value: '\u200B', inline: true });
    }

    fields.push({ name: '\u200B', value: 'Press the button to claim/unclaim', inline: false });
    embed.addFields(fields);
    return embed;
  }

  buildHeadPanelEmbed(panel) {
    const sessions = Array.isArray(panel.sessions) ? panel.sessions : [];
    const title = panel.reload ? 'Reload Sessions Supervisor Panel' : 'Sessions Supervisor Panel';
    const embed = new EmbedBuilder().setColor(0x87CEFA).setTitle(title);

    if (!sessions.length) {
      embed.setDescription('No sessions available.');
      return embed;
    }

    const lines = sessions.map(s => {
      const num = Number(s.sessionNumber || 0);
      const owner = s.supervisorId ? `<@${s.supervisorId}>` : '—';
      return `**Session ${num}:** ${owner}  •  <t:${Number(s.regTs || 0)}:t> / <t:${Number(s.gameTs || 0)}:t>`;
    });
    embed.setDescription(lines.join('\n'));
    embed.setFooter({ text: `Limit: ${this.headMaxClaims} sessions per supervisor` });
    return embed;
  }

  buildClaimRow(messageId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`duo_claim_add:${messageId}`).setLabel('Claim Lobby').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`duo_claim_remove:${messageId}`).setLabel('Unclaim').setStyle(ButtonStyle.Secondary),
    );
  }

  buildStaffRow(messageId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`staffpanel_claim:${messageId}`).setLabel('🖐 Claim Lobby').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`staffpanel_unclaim:${messageId}`).setLabel('Unclaim').setStyle(ButtonStyle.Danger),
    );
  }

  buildHeadRows(messageId, panel) {
    const sessions = Array.isArray(panel.sessions) ? panel.sessions : [];
    const rows = [];

    for (let i = 0; i < sessions.length && i < 20; i += 5) {
      const chunk = sessions.slice(i, i + 5);
      const row = new ActionRowBuilder();
      for (const s of chunk) {
        const n = Number(s.sessionNumber || 0);
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`staffpanel_toggle:${messageId}:${n}`)
            .setLabel(`Session ${n}`)
            .setStyle(s.supervisorId ? ButtonStyle.Secondary : ButtonStyle.Primary),
        );
      }
      rows.push(row);
    }

    return rows;
  }

  async sendTemporaryRolePing(channel, roleId) {
    const role = String(roleId || '');
    if (!role) return;
    const pingMsg = await channel.send({
      content: `<@&${role}>`,
      allowedMentions: { roles: [role] },
    }).catch(() => null);

    if (pingMsg) {
      setTimeout(() => {
        try { pingMsg.delete().catch(() => {}); } catch (_) {}
      }, 1800);
    }
  }

  loadClaimSchedules() {
    const rows = loadJson(this.claimSchedulesPath, []);
    return Array.isArray(rows) ? rows : [];
  }

  saveClaimSchedules(rows) {
    saveJson(this.claimSchedulesPath, Array.isArray(rows) ? rows : []);
  }

  upsertClaimSchedule(job) {
    const all = this.loadClaimSchedules();
    const idx = all.findIndex(x => String(x.scheduleKey || '') === String(job.scheduleKey || ''));
    if (idx >= 0) all[idx] = job;
    else all.push(job);
    this.saveClaimSchedules(all);
  }

  removeClaimSchedule(scheduleKey) {
    const all = this.loadClaimSchedules();
    this.saveClaimSchedules(all.filter(x => String(x.scheduleKey || '') !== String(scheduleKey || '')));
  }

  scheduleClaimJob(job, persist = true) {
    const key = String(job.scheduleKey || '');
    if (!key || !this.client) return;

    if (this.claimTimers.has(key)) {
      try { clearTimeout(this.claimTimers.get(key)); } catch (_) {}
      this.claimTimers.delete(key);
    }

    if (persist) this.upsertClaimSchedule(job);

    let delay = Math.max(0, Number(job.targetMs || Date.now()) - Date.now());
    if (!Number.isFinite(delay)) delay = 0;

    const t = setTimeout(async () => {
      try {
        const channel = this.client.channels.cache.get(String(job.channelId))
          || await this.client.channels.fetch(String(job.channelId)).catch(() => null);
        if (!channel || typeof channel.send !== 'function') return;

        const state = { panelId: null, gamemode: job.gamemode, session: job.session, reload: !!job.reload, claims: [] };
        const pendingRow = this.buildClaimRow('pending');
        const sent = await channel.send({ embeds: [this.buildClaimEmbed(state)], components: [pendingRow], allowedMentions: { parse: ['users'] } }).catch(() => null);
        if (!sent) return;

        state.panelId = String(sent.id);
        state.panelType = 'duo';
        state.channelId = String(channel.id || '');
        this.claimPanels.set(String(sent.id), state);
        this.upsertPanelState(state);
        await sent.edit({ embeds: [this.buildClaimEmbed(state)], components: [this.buildClaimRow(String(sent.id))] }).catch(() => {});
        await this.sendTemporaryRolePing(channel, this.staffRoleId);
      } finally {
        this.claimTimers.delete(key);
        this.removeClaimSchedule(key);
      }
    }, delay);

    this.claimTimers.set(key, t);
  }

  restoreClaimSchedules() {
    const now = Date.now();
    const all = this.loadClaimSchedules();
    const keep = [];

    for (const job of all) {
      if (!job || !job.scheduleKey || !job.channelId) continue;
      const targetMs = Number(job.targetMs || 0);
      if (!Number.isFinite(targetMs) || targetMs <= 0) continue;
      if (targetMs < (now - 2 * 60 * 60 * 1000)) continue;

      const fixed = { ...job };
      if (targetMs < now) fixed.targetMs = now + 2000;
      keep.push(fixed);
      this.scheduleClaimJob(fixed, false);
    }

    this.saveClaimSchedules(keep);
  }

  loadPreRegJobs() {
    const rows = loadJson(this.preRegJobsPath, []);
    return Array.isArray(rows) ? rows : [];
  }

  savePreRegJobs(rows) {
    saveJson(this.preRegJobsPath, Array.isArray(rows) ? rows : []);
  }

  upsertPreRegJob(job) {
    const all = this.loadPreRegJobs();
    const idx = all.findIndex(x => String(x.timerKey || '') === String(job.timerKey || ''));
    if (idx >= 0) all[idx] = job;
    else all.push(job);
    this.savePreRegJobs(all);
  }

  removePreRegJob(timerKey) {
    const all = this.loadPreRegJobs();
    this.savePreRegJobs(all.filter(x => String(x.timerKey || '') !== String(timerKey || '')));
  }

  removePreRegJobsByOrigin(originMessageId) {
    const prefix = `${String(originMessageId)}:`;
    const all = this.loadPreRegJobs();
    this.savePreRegJobs(all.filter(x => !String(x.timerKey || '').startsWith(prefix)));
  }

  async postPreRegPanel(job) {
    const target = String(job.targetKey || '');
    const channelId = target === 'head' ? this.headClaimChannelId : this.staffClaimChannelId;
    const channel = this.client.channels.cache.get(channelId)
      || await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return;

    if (target === 'head') {
      const sessions = Array.isArray(job.sessions)
        ? job.sessions
            .map(s => ({
              sessionNumber: Number(s.sessionNumber || 0),
              regTs: Number(s.regTs || 0),
              gameTs: Number(s.gameTs || 0),
              supervisorId: null,
            }))
            .filter(s => s.sessionNumber > 0 && s.regTs > 0 && s.gameTs > 0)
        : [];
      if (!sessions.length) return;

      const panel = {
        panelId: null,
        panelType: 'head-supervisor',
        channelId: String(channel.id || ''),
        targetKey: 'head',
        claimRoleId: this.headStaffRoleId,
        maxClaimsPerUser: this.headMaxClaims,
        reload: !!job.reload,
        sessions,
        claims: [],
      };

      const sent = await channel.send({
        embeds: [this.buildHeadPanelEmbed(panel)],
        components: this.buildHeadRows('pending', panel),
        allowedMentions: { parse: ['users'] },
      }).catch(() => null);
      if (!sent) return;

      panel.panelId = String(sent.id);
      this.claimPanels.set(panel.panelId, panel);
      this.upsertPanelState(panel);
      await sent.edit({
        embeds: [this.buildHeadPanelEmbed(panel)],
        components: this.buildHeadRows(panel.panelId, panel),
      }).catch(() => {});
      await this.sendTemporaryRolePing(channel, this.headStaffRoleId);
      return;
    }

    const panel = {
      panelId: null,
      panelType: 'staff-lobby',
      channelId: String(channel.id || ''),
      targetKey: 'staff',
      claimRoleId: this.staffRoleId,
      maxClaimsPerUser: this.staffMaxClaims,
      sessionIndex: Number(job.sessionIndex || 1),
      regTs: Number(job.regTs),
      gameTs: Number(job.gameTs),
      reload: !!job.reload,
      claims: [],
    };

    const sent = await channel.send({
      embeds: [this.buildStaffPanelEmbed(panel)],
      components: [this.buildStaffRow('pending')],
      allowedMentions: { parse: ['users'] },
    }).catch(() => null);
    if (!sent) return;

    panel.panelId = String(sent.id);
    this.claimPanels.set(panel.panelId, panel);
    this.upsertPanelState(panel);
    await sent.edit({ embeds: [this.buildStaffPanelEmbed(panel)], components: [this.buildStaffRow(panel.panelId)] }).catch(() => {});
    await this.sendTemporaryRolePing(channel, this.staffRoleId);
  }

  schedulePreRegJob(job, persist = true) {
    const key = String(job.timerKey || '');
    if (!key || !this.client) return;

    if (this.preRegTimers.has(key)) {
      try { clearTimeout(this.preRegTimers.get(key)); } catch (_) {}
      this.preRegTimers.delete(key);
    }

    if (persist) this.upsertPreRegJob(job);

    let delay = Math.max(0, Number(job.sendAtMs || Date.now()) - Date.now());
    if (!Number.isFinite(delay)) delay = 0;

    const t = setTimeout(async () => {
      try {
        await this.postPreRegPanel(job);
      } finally {
        this.preRegTimers.delete(key);
        this.removePreRegJob(key);
      }
    }, delay);

    this.preRegTimers.set(key, t);
  }

  restorePreRegJobs() {
    const now = Date.now();
    const all = this.loadPreRegJobs();
    const keep = [];

    for (const job of all) {
      if (!job || !job.timerKey) continue;
      let sendAtMs = Number(job.sendAtMs || 0);
      if (!Number.isFinite(sendAtMs) || sendAtMs <= 0) continue;

      let gameEndMs = 0;
      if (Array.isArray(job.sessions) && job.sessions.length) {
        const maxGame = Math.max(...job.sessions.map(s => Number(s.gameTs || 0)));
        gameEndMs = (maxGame * 1000) + this.catchupMs;
      } else {
        gameEndMs = (Number(job.gameTs || 0) * 1000) + this.catchupMs;
      }
      if (!Number.isFinite(gameEndMs) || gameEndMs <= 0) continue;
      if (now > gameEndMs) continue;

      if (sendAtMs < now) sendAtMs = now + 1500;
      const fixed = { ...job, sendAtMs };
      keep.push(fixed);
      this.schedulePreRegJob(fixed, false);
    }

    this.savePreRegJobs(keep);
  }

  scheduleFromAnnouncement({ originMessageId, originChannelId, sessions }) {
    const src = String(originChannelId || '');
    const isNormal = src === this.announceChannelId;
    const isReload = !!this.announceReloadChannelId && src === this.announceReloadChannelId;
    if (!isNormal && !isReload) return;
    if (!Array.isArray(sessions) || !sessions.length) return;

    for (const [k, t] of this.preRegTimers.entries()) {
      if (String(k).startsWith(`${String(originMessageId)}:`)) {
        try { clearTimeout(t); } catch (_) {}
        this.preRegTimers.delete(k);
      }
    }
    this.removePreRegJobsByOrigin(originMessageId);

    const now = Date.now();
    const normalized = sessions
      .map((s, idx) => {
        const regTs = Number(s.regTs || s.start || 0);
        const gameTs = Number(s.gameTs || s.end || 0);
        const sessionIndex = Number(s.index || idx + 1);
        return { sessionIndex, regTs, gameTs };
      })
      .filter(s => Number.isFinite(s.regTs) && Number.isFinite(s.gameTs) && s.regTs > 0 && s.gameTs > 0)
      .filter(s => now <= ((s.gameTs * 1000) + this.catchupMs));

    if (!normalized.length) return;

    const headJob = {
      timerKey: `${String(originMessageId)}:head:bundle`,
      originMessageId: String(originMessageId),
      targetKey: 'head',
      reload: isReload,
      sessions: normalized.map(s => ({ sessionNumber: s.sessionIndex, regTs: s.regTs, gameTs: s.gameTs })),
      sendAtMs: Date.now() + this.headImmediateLeadMs,
      createdAt: Date.now(),
    };
    this.schedulePreRegJob(headJob, true);

    for (let idx = 0; idx < normalized.length; idx++) {
      const s = normalized[idx];
      const regTs = Number(s.regTs || 0);
      const gameTs = Number(s.gameTs || 0);

      const sendAt = (regTs * 1000) - this.preLeadMs;
      let delay = sendAt - now;
      if (delay <= 0) {
        const stillRelevant = now <= ((gameTs * 1000) + this.catchupMs);
        if (!stillRelevant) continue;
        delay = 1200 + (idx * 900);
      }

      const sessionIndex = Number(s.sessionIndex || idx + 1);
      const timerKey = `${String(originMessageId)}:staff:${sessionIndex}`;
      const job = {
        timerKey,
        originMessageId: String(originMessageId),
        targetKey: 'staff',
        reload: isReload,
        sessionIndex,
        regTs,
        gameTs,
        sendAtMs: Date.now() + delay,
        createdAt: Date.now(),
      };
      this.schedulePreRegJob(job, true);
    }
  }

  async handleInteraction(interaction) {
    // /claim
    if (interaction.isChatInputCommand && interaction.isChatInputCommand() && interaction.commandName === 'claim') {
      const timeRaw = interaction.options.getString('time', true);
      const gamemode = String(interaction.options.getString('gamemode', true) || 'Duos').trim().slice(0, 50) || 'Duos';
      const session = interaction.options.getInteger('session', true);
      const reload = interaction.options.getBoolean('reload') === true;

      const targetMs = parseHHMMToNextMs(timeRaw, new Date());
      if (!targetMs) {
        return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Invalid `time`. Please use `HH:MM` (24h).')], ephemeral: true });
      }

      const scheduleKey = `${String(interaction.guildId || 'dm')}:${String(interaction.channelId)}:${String(gamemode).toLowerCase()}:${session}`;
      const job = {
        scheduleKey,
        guildId: String(interaction.guildId || ''),
        channelId: String(interaction.channelId || ''),
        targetMs,
        gamemode,
        session,
        reload,
        createdAt: Date.now(),
        createdBy: String(interaction.user.id || ''),
      };

      this.scheduleClaimJob(job, true);
      const ts = Math.floor(targetMs / 1000);
      return interaction.reply({ content: `Claim scheduled <t:${ts}:F>`, ephemeral: false });
    }

    // claim/unclaim panel buttons
    if (interaction.isButton && interaction.isButton()) {
      const id = String(interaction.customId || '');
      const isDuoClaim = id.startsWith('duo_claim_add:') || id.startsWith('duo_claim_remove:');
      const isStaffClaim = id.startsWith('staffpanel_claim:') || id.startsWith('staffpanel_unclaim:');
      const isHeadToggle = id.startsWith('staffpanel_toggle:');
      if (!isDuoClaim && !isStaffClaim && !isHeadToggle) return false;

      await interaction.deferReply({ ephemeral: true }).catch(() => {});
      const msgId = String(id.split(':')[1] || interaction.message?.id || '');
      if (!msgId || msgId === 'pending') {
        await interaction.editReply({ content: 'Panel not ready yet.', ephemeral: true }).catch(() => {});
        return true;
      }

      const state = this.getPanelState(msgId);
      if (!state) {
        await interaction.editReply({ content: 'Panel expired or not found.', ephemeral: true }).catch(() => {});
        return true;
      }

      const hasManageGuild = interaction.memberPermissions?.has?.(PermissionsBitField.Flags.ManageGuild) === true;
      const requiredRole = String(state.claimRoleId || '');
      const hasRole = requiredRole
        ? interaction.member?.roles?.cache?.has?.(requiredRole) === true
        : true;
      if (!hasRole && !hasManageGuild) {
        await interaction.editReply({ content: 'You are not allowed to use this panel.', ephemeral: true }).catch(() => {});
        return true;
      }

      if (isHeadToggle || state.panelType === 'head-supervisor') {
        const sessionNo = Number(id.split(':')[2] || 0);
        if (!sessionNo) {
          await interaction.editReply({ content: 'Invalid session button.', ephemeral: true }).catch(() => {});
          return true;
        }

        if (!Array.isArray(state.sessions)) state.sessions = [];
        const target = state.sessions.find(s => Number(s.sessionNumber) === sessionNo);
        if (!target) {
          await interaction.editReply({ content: 'Session not found on this panel.', ephemeral: true }).catch(() => {});
          return true;
        }

        const uid = String(interaction.user.id);
        const maxClaims = Number(state.maxClaimsPerUser || this.headMaxClaims || 2);
        const currentCount = state.sessions.filter(s => String(s.supervisorId || '') === uid).length;

        if (target.supervisorId) {
          if (String(target.supervisorId) !== uid) {
            await interaction.editReply({ content: 'This session is already claimed by another supervisor.', ephemeral: true }).catch(() => {});
            return true;
          }
          target.supervisorId = null;
          state.claims = state.sessions.filter(s => s.supervisorId).map(s => String(s.supervisorId));
          await interaction.message.edit({ embeds: [this.buildHeadPanelEmbed(state)], components: this.buildHeadRows(msgId, state) }).catch(() => {});
          this.upsertPanelState(state);
          await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`You unclaimed Session ${sessionNo}.`)] }).catch(() => {});
          return true;
        }

        if (currentCount >= maxClaims) {
          await interaction.editReply({ content: `You reached the limit (${maxClaims}). Unclaim first.`, ephemeral: true }).catch(() => {});
          return true;
        }

        target.supervisorId = uid;
        state.claims = state.sessions.filter(s => s.supervisorId).map(s => String(s.supervisorId));
        await interaction.message.edit({ embeds: [this.buildHeadPanelEmbed(state)], components: this.buildHeadRows(msgId, state) }).catch(() => {});
        this.upsertPanelState(state);
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`You claimed Session ${sessionNo}.`)] }).catch(() => {});
        return true;
      }

      const isUnclaim = id.includes('_remove:') || id.startsWith('staffpanel_unclaim:');

      if (!Array.isArray(state.claims)) state.claims = [];
      const uid = String(interaction.user.id);
      const idx = state.claims.indexOf(uid);
      let info = '';

      if (isUnclaim) {
        if (idx === -1) {
          await interaction.editReply({ content: 'You have no claimed lobby to unclaim.', ephemeral: true }).catch(() => {});
          return true;
        }
        state.claims.splice(idx, 1);
        info = 'You unclaimed your lobby.';
      } else {
        if (idx !== -1) {
          await interaction.editReply({ content: 'You already claimed a lobby. Use Unclaim first.', ephemeral: true }).catch(() => {});
          return true;
        }
        const maxClaims = Number(state.maxClaimsPerUser || this.staffMaxClaims || 1);
        if (state.claims.length >= maxClaims) {
          await interaction.editReply({ content: `This panel is full (${maxClaims}/${maxClaims}).`, ephemeral: true }).catch(() => {});
          return true;
        }
        state.claims.push(uid);
        info = `You claimed Lobby ${state.claims.length}.`;
      }

      const row = isStaffClaim ? this.buildStaffRow(msgId) : this.buildClaimRow(msgId);
      const embed = (state.regTs && state.gameTs && state.sessionIndex)
        ? this.buildStaffPanelEmbed(state)
        : this.buildClaimEmbed(state);

      await interaction.message.edit({ embeds: [embed], components: [row], allowedMentions: { parse: ['users'] } }).catch(() => {});
      this.upsertPanelState(state);
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(info)] }).catch(() => {});
      return true;
    }

    return false;
  }
}

module.exports = {
  ClaimingSystem,
  parseAnnouncementSessions,
};
