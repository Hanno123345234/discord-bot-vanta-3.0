const fs = require('fs');
const path = require('path');
// Load .env into process.env when present (safe if dotenv isn't installed)
const DOTENV_PATH = path.join(__dirname, '.env');
let DOTENV_PRESENT = false;
let DOTENV_LOADED = false;
try { DOTENV_PRESENT = fs.existsSync(DOTENV_PATH); } catch (e) { DOTENV_PRESENT = false; }
try { 
  require('dotenv').config({ path: path.join(__dirname, '.env') }); 
  console.log('✅ .env file loaded');
  DOTENV_LOADED = true;
} catch (e) { 
  console.warn('⚠️ dotenv not available or .env not found');
}

// Resolve bot token from multiple sources to avoid env issues on hosts
function resolveToken() {

  const sanitizeTokenString = (raw) => {
    if (typeof raw !== 'string') return undefined;
    let v = raw.trim();
    if (!v) return undefined;
    v = v.replace(/^['"]|['"]$/g, '');
    v = v.replace(/^(bot|bearer)\s+/i, '').trim();
    return v || undefined;
  };

  const looksLikeDiscordToken = (raw) => {
    const v = sanitizeTokenString(raw);
    if (!v) return false;
    const parts = v.split('.');
    return parts.length === 3 && v.length >= 50;
  };

  const envCandidates = [
    { key: 'TOKENSP', val: process.env.TOKENSP },
    { key: 'TOKEN', val: process.env.TOKEN },
    { key: 'DISCORD_TOKEN', val: process.env.DISCORD_TOKEN },
    { key: 'DISCORD_BOT_TOKEN', val: process.env.DISCORD_BOT_TOKEN },
    { key: 'BOT_TOKEN', val: process.env.BOT_TOKEN },
    { key: 'GIT_ACCESS_TOKEN', val: process.env.GIT_ACCESS_TOKEN },
  ];

  let token;
  let source;
  const ignored = [];
  for (const c of envCandidates) {
    const v = sanitizeTokenString(c.val);
    if (!v) continue;
    if (looksLikeDiscordToken(v)) {
      token = v;
      source = `env:${c.key}`;
      break;
    }
    ignored.push(`${c.key}(len=${v.length}, parts=${v.split('.').length})`);
  }

  // 2) raw .env file fallback (some panels/users paste ONLY the token into .env)
  try {
    if (!token) {
      const envPath = path.join(__dirname, '.env');
      if (fs.existsSync(envPath)) {
        const lines = String(fs.readFileSync(envPath, 'utf8'))
          .split(/\r?\n/)
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'));

        // If the first meaningful line is a raw token (no '='), accept it.
        const first = lines[0];
        if (first && !first.includes('=') && looksLikeDiscordToken(first)) {
          token = sanitizeTokenString(first);
          source = '.env:raw';
        }
      }
    }
  } catch (e) {}

  // 3) token.txt file (easy to upload on Pterodactyl)
  try {
    if (!token) {
      const tokenFile = path.join(__dirname, 'token.txt');
      if (fs.existsSync(tokenFile)) {
        const raw = fs.readFileSync(tokenFile, 'utf8');
        if (looksLikeDiscordToken(raw)) token = sanitizeTokenString(raw);
        source = 'token.txt';
      }
    }
  } catch (e) {}

  // 4) config.json field (discouraged, but works)
  try {
    if (!token) {
      const cfgPath = path.join(__dirname, 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (cfg && typeof cfg.discordToken === 'string' && cfg.discordToken.trim()) {
          if (looksLikeDiscordToken(cfg.discordToken)) {
            token = sanitizeTokenString(cfg.discordToken);
            source = 'config.json';
          }
        }
      }
    }
  } catch (e) {}

  return { token, source, ignored };
}

function validateTokenFormat(t) {
  if (!t || typeof t !== 'string') return false;
  const parts = t.split('.');
  // Discord tokens are usually 3 parts separated by dots
  if (parts.length !== 3) return false;
  // Basic length check to catch empty/short values
  return t.length >= 50;
}

const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ActivityType, AuditLogEvent } = require('discord.js');

// Safe import of transcript with fallback - prevents crash if file missing on server
let createTranscript;
try {
  createTranscript = require('./utils/transcript').createTranscript;
  console.log('✅ Transcript module loaded successfully');
} catch (e) {
  console.warn('⚠️ Transcript module not found - using fallback (transcripts disabled)');
  createTranscript = async () => ({ txtPath: null, htmlPath: null });
}

const DATA_DIR = __dirname;
const MODLOGS_PATH = path.join(DATA_DIR, 'modlogs.json');
const BLACKLIST_PATH = path.join(DATA_DIR, 'blacklist.json');
const DESTAFFS_PATH = path.join(DATA_DIR, 'destaffs.json');
const DESTAFF_LOG_CHANNEL_ID = process.env.DESTAFF_LOG_CHANNEL_ID || '1459166993381851247';
const DESTAFF_BAN_GUILD_ID = process.env.DESTAFF_BAN_GUILD_ID || '1459164535112990865';
const DESTAFF_BAN_GUILD_NAME = process.env.DESTAFF_BAN_GUILD_NAME || 'Staff hub Test server';
const STAFF_ROLE_HISTORY_PATH = path.join(DATA_DIR, 'staff_role_history.json');
const SESSIONS_REMINDERS_PATH = path.join(DATA_DIR, 'sessions_reminders.json');

function loadJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('Failed to load JSON', p, e);
    return fallback;
  }
}
function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function loadGuildConfig(guildId) {
  const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
  const gid = guildId ? String(guildId) : null;
  const overrides = gid && cfg && cfg.guilds && cfg.guilds[gid] && typeof cfg.guilds[gid] === 'object' ? cfg.guilds[gid] : null;
  return overrides ? Object.assign({}, cfg, overrides) : cfg;
}

function appendActionMd(guild, moderatorTag, title, details) {
  try {
    const mdPath = path.join(DATA_DIR, 'actions.md');
    const now = new Date().toISOString();
    const guildInfo = guild ? `${guild.name} (${guild.id})` : 'Direct Message';
    const entry = [
      `## ${title} — ${now}`,
      `- Server: ${guildInfo}`,
      `- Moderator: ${moderatorTag}`,
      `- Details: ${details}`,
      '',
    ].join('\n');
    fs.appendFileSync(mdPath, entry, 'utf8');
  } catch (e) {
    console.error('Failed to write actions.md', e);
  }
}

let modlogs = loadJson(MODLOGS_PATH, { lastCase: 10000, cases: [] });
let blacklist = loadJson(BLACKLIST_PATH, { blacklisted: [] });
let destaffs = loadJson(DESTAFFS_PATH, { lastCase: 10000, cases: [] });
let staffRoleHistory = loadJson(STAFF_ROLE_HISTORY_PATH, { guilds: {} });

function isStaffLikeRoleName(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  return ['staff', 'admin', 'administrator', 'moderator', 'mod'].some(k => n.includes(k));
}

function ensureStaffHistoryGuild(guildId) {
  if (!staffRoleHistory.guilds) staffRoleHistory.guilds = {};
  if (!staffRoleHistory.guilds[guildId]) staffRoleHistory.guilds[guildId] = { users: {} };
  if (!staffRoleHistory.guilds[guildId].users) staffRoleHistory.guilds[guildId].users = {};
  return staffRoleHistory.guilds[guildId];
}

function setStaffRoleSince(guildId, userId, roleId, ts) {
  const g = ensureStaffHistoryGuild(guildId);
  if (!g.users[userId]) g.users[userId] = { roles: {} };
  if (!g.users[userId].roles) g.users[userId].roles = {};
  if (!g.users[userId].roles[roleId]) {
    g.users[userId].roles[roleId] = ts;
    saveJson(STAFF_ROLE_HISTORY_PATH, staffRoleHistory);
  }
}

function clearStaffRoleSince(guildId, userId, roleId) {
  try {
    const g = staffRoleHistory.guilds && staffRoleHistory.guilds[guildId];
    const u = g && g.users && g.users[userId];
    if (u && u.roles && u.roles[roleId]) {
      delete u.roles[roleId];
      saveJson(STAFF_ROLE_HISTORY_PATH, staffRoleHistory);
    }
  } catch (e) {}
}

function getStaffRoleSince(guildId, userId, roleId) {
  try {
    const g = staffRoleHistory.guilds && staffRoleHistory.guilds[guildId];
    const u = g && g.users && g.users[userId];
    const ts = u && u.roles && u.roles[roleId];
    return typeof ts === 'number' ? ts : null;
  } catch (e) {
    return null;
  }
}

// Automod configuration (env vars override file)
const DEFAULT_AUTOMOD = {
  blockedRoles: ['Member'],
  allowedRoles: [],
  muteMinutes: 2,
  logChannelNames: ['discord-logs', 'mod-logs', 'logs']
};

function loadAutomodConfig() {
  const cfg = Object.assign({}, DEFAULT_AUTOMOD);
  if (process.env.AUTOMOD_BLOCKED_ROLES) cfg.blockedRoles = process.env.AUTOMOD_BLOCKED_ROLES.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.AUTOMOD_ALLOWED_ROLES) cfg.allowedRoles = process.env.AUTOMOD_ALLOWED_ROLES.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.AUTOMOD_MUTE_MINUTES) { const n = parseInt(process.env.AUTOMOD_MUTE_MINUTES, 10); if (!isNaN(n)) cfg.muteMinutes = n; }
  if (process.env.AUTOMOD_LOG_CHANNELS) cfg.logChannelNames = process.env.AUTOMOD_LOG_CHANNELS.split(',').map(s => s.trim()).filter(Boolean);
  try {
    const p = path.join(DATA_DIR, 'automod.json');
    if (fs.existsSync(p)) {
      const fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(fileCfg.blockedRoles)) cfg.blockedRoles = fileCfg.blockedRoles;
      if (Array.isArray(fileCfg.allowedRoles)) cfg.allowedRoles = fileCfg.allowedRoles;
      if (typeof fileCfg.muteMinutes === 'number') cfg.muteMinutes = fileCfg.muteMinutes;
      if (Array.isArray(fileCfg.logChannelNames)) cfg.logChannelNames = fileCfg.logChannelNames;
    }
  } catch (e) { console.error('Failed to load automod.json', e); }
  return cfg;
}

const AUTOMOD_CONFIG = loadAutomodConfig();

function nextCase() {
  modlogs.lastCase += 1;
  saveJson(MODLOGS_PATH, modlogs);
  return modlogs.lastCase;
}

function parseSessionsClaim(raw) {
  // Very small parser: accepts mention (<@id>), raw id, or username#discrim
  if (!raw || typeof raw !== 'string') return null;
  raw = raw.trim();
  const m = raw.match(/^<@!?(\d+)>$/);
  if (m) return { type: 'id', id: m[1] };
  if (/^\d{6,}$/.test(raw)) return { type: 'id', id: raw };
  const ud = raw.split('#');
  if (ud.length === 2) return { type: 'tag', tag: raw };
  return { type: 'text', text: raw };
}

function getSessionsCfgByMode(mode, guildId) {
  // Minimal: read config.json and return a sessions config for the mode
  try {
    const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
    if (!cfg.sessions) return {};
    const m = mode ? String(mode) : 'default';
    const guildOverrides = guildId && cfg.guilds && cfg.guilds[String(guildId)] ? cfg.guilds[String(guildId)].sessions : null;
    if (guildOverrides && guildOverrides[m]) return guildOverrides[m];
    return cfg.sessions[m] || cfg.sessions['default'] || {};
  } catch (e) { return {}; }
}

async function sendSessionsLog(guild, payload) {
  try {
    // Reuse existing logging helper
    await sendLog(guild, Object.assign({ category: 'sessions' }, payload));
  } catch (e) { console.error('sendSessionsLog failed', e); }
}

// --- Session post parsing and reminder scheduling ---
const scheduledReminderTimeouts = new Map();

function parseSessionMessage(content, referenceDate) {
  // Parse simple session posts like in screenshots:
  // lines with `1. 17:00 - 17:15` and following line `Staff: @User` or inline `Staff: @User`
  const lines = String(content || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const sessions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const timeMatch = line.match(/^(\d+)\.\s*([0-2]?\d:[0-5]\d)\s*(?:-|–|to)\s*([0-2]?\d:[0-5]\d)/i);
    if (timeMatch) {
      const idx = parseInt(timeMatch[1], 10);
      const start = timeMatch[2];
      const end = timeMatch[3];
      // look for staff on same line
      let staff = null;
      const staffInline = line.match(/staff[:\s]*([\s\S]+)/i);
      if (staffInline) staff = staffInline[1].trim();
      else {
        // look next line
        const next = lines[i+1];
        if (next && /staff[:\s]/i.test(next)) {
          staff = next.replace(/staff[:\s]*/i, '').trim();
        }
      }
      // build Date objects using referenceDate's day
      const ref = referenceDate instanceof Date ? new Date(referenceDate) : new Date();
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      const startDt = new Date(ref);
      startDt.setHours(sh, sm, 0, 0);
      const endDt = new Date(ref);
      endDt.setHours(eh, em, 0, 0);
      // if end before start, assume next day
      if (endDt.getTime() <= startDt.getTime()) endDt.setDate(endDt.getDate() + 1);
      sessions.push({ index: idx, start: startDt.getTime(), end: endDt.getTime(), staff: staff || '' });
    }
  }
  return sessions.sort((a,b)=>a.index-b.index);
}

function persistReminders(reminders) {
  try { saveJson(SESSIONS_REMINDERS_PATH, reminders || []); } catch(e){console.error('persistReminders failed', e);} 
}

function loadPersistedReminders() {
  try { return loadJson(SESSIONS_REMINDERS_PATH, []); } catch(e) { return []; }
}

function scheduleReminderObject(rem) {
  const now = Date.now();
  const delay = Math.max(0, rem.sendAt - now);
  if (scheduledReminderTimeouts.has(rem.id)) return; // already scheduled
  const t = setTimeout(async () => {
    try {
      const userId = rem.userId;
      const content = rem.content;
      await sendSessionDm(userId, content);
    } catch (e) { console.error('scheduled reminder send failed', e); }
    // remove from persisted list
    try {
      const all = loadPersistedReminders().filter(r=>r.id !== rem.id);
      persistReminders(all);
    } catch (e) {}
    scheduledReminderTimeouts.delete(rem.id);
  }, delay);
  scheduledReminderTimeouts.set(rem.id, t);
}

function rescheduleAllReminders() {
  const all = loadPersistedReminders();
  for (const rem of all) {
    // only schedule future reminders
    if (rem.sendAt > Date.now()) scheduleReminderObject(rem);
    else {
      // if in past but within 5 minutes, send immediately
      if (Date.now() - rem.sendAt < 5 * 60 * 1000) {
        scheduleReminderObject(Object.assign({}, rem, { sendAt: Date.now() + 2000 }));
      }
    }
  }
}

// session messageCreate handler moved later (after client initialization)

function nextDestaffCase() {
  destaffs.lastCase += 1;
  saveJson(DESTAFFS_PATH, destaffs);
  return destaffs.lastCase;
}

const PREFIX = process.env.PREFIX || '!';
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

// sendSessionDm now defined after client to avoid TDZ issues
async function sendSessionDm(clientOrUserId, content) {
  try {
    if (!clientOrUserId) return null;
    let user = null;
    if (typeof clientOrUserId === 'string' || typeof clientOrUserId === 'number') {
      user = await client.users.fetch(String(clientOrUserId)).catch(()=>null);
    } else if (clientOrUserId && typeof clientOrUserId.send === 'function') {
      user = clientOrUserId;
    }
    if (!user) return null;
    return user.send(typeof content === 'string' ? { content } : content).catch(()=>null);
  } catch (e) { console.error('sendSessionDm failed', e); return null; }
}

// Watch for session posts in the Beta sessions channel and schedule DMs
client.on('messageCreate', async (message) => {
  try {
    if (!message || message.author?.bot) return;
    const targetChannelId = '1461370702895779945'; // Beta sessions claim channel
    if (String(message.channel?.id) !== targetChannelId) return;

    const sessions = parseSessionMessage(message.content, message.createdAt);
    if (!sessions || !sessions.length) return;

    // Send immediate DM for first session to the author
    const first = sessions[0];
    const formatSession = (s) => `Session ${s.index}: ${new Date(s.start).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} - ${new Date(s.end).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}\nStaff: ${s.staff || 'Unassigned'}`;
    const userId = message.author.id;
    // immediate DM for the first session
    try { await sendSessionDm(userId, `Deine Session (so sieht sie aus):\n${formatSession(first)}`); } catch (e) { /* ignore */ }

    // Schedule reminders for the rest at 30 minutes before start
    const reminders = loadPersistedReminders();
    for (let i = 1; i < sessions.length; i++) {
      const s = sessions[i];
      const sendAt = s.start - (30 * 60 * 1000);
      const now = Date.now();
      const remId = `sess_${message.id}_${s.index}_${userId}`;
      const content = `Erinnerung: Session ${s.index} startet um ${new Date(s.start).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} (Staff: ${s.staff || 'Unassigned'})`;
      if (sendAt <= now) {
        // if already within 30 minutes, send immediately
        await sendSessionDm(userId, content).catch(()=>{});
      } else {
        const rem = { id: remId, messageId: message.id, userId, sessionIndex: s.index, sendAt, content };
        reminders.push(rem);
        persistReminders(reminders);
        scheduleReminderObject(rem);
      }
    }
  } catch (e) { console.error('session post handler failed', e); }
});

function parseId(arg) {
  if (!arg) return null;
  const mention = arg.replace(/[<@!>]/g, '');
  if (/^\d+$/.test(mention)) return mention;
  return null;
}

function pad(n) { return String(n).padStart(2, '0'); }
function formatHammertime(input) {
  const d = (typeof input === 'number') ? new Date(input) : new Date(input);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDurationToMs(s) {
  if (!s) return null;
  s = String(s).toLowerCase().trim();
  const map = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
  const re = /(\d+)(d|h|m|s)/g;
  let m; let total = 0; let matched = false;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = parseInt(m[1], 10);
    const unit = m[2];
    total += n * (map[unit] || 0);
  }
  if (matched) return total;
  // fallback: plain number -> minutes
  const num = parseFloat(s.replace(',', '.'));
  if (!isNaN(num)) return Math.round(num * 60000);
  return null;
}

function humanDuration(ms) {
  if (!ms || ms <= 0) return '0s';
  const parts = [];
  const days = Math.floor(ms / 86400000); if (days) { parts.push(days + 'd'); ms -= days * 86400000; }
  const hours = Math.floor(ms / 3600000); if (hours) { parts.push(hours + 'h'); ms -= hours * 3600000; }
  const mins = Math.floor(ms / 60000); if (mins) { parts.push(mins + 'm'); ms -= mins * 60000; }
  const secs = Math.floor(ms / 1000); if (secs) { parts.push(secs + 's'); }
  return parts.join(' ');
}

function humanDurationLong(ms) {
  if (!ms || ms <= 0) return '0 seconds';
  const units = [
    { name: 'day', ms: 86400000 },
    { name: 'hour', ms: 3600000 },
    { name: 'minute', ms: 60000 },
    { name: 'second', ms: 1000 }
  ];
  for (const u of units) {
    const n = Math.floor(ms / u.ms);
    if (n > 0) return `${n} ${u.name}${n === 1 ? '' : 's'}`;
  }
  return '0 seconds';
}

client.on('interactionCreate', async (interaction) => {
  // Ticket system: create + close button interactions
  try {
    // Create ticket from panel button
    if (interaction.isButton() && typeof interaction.customId === 'string' && interaction.customId.startsWith('ticket_create_btn')) {
      await interaction.deferReply({ ephemeral: true });
      try {
        if (!interaction.guild) return interaction.editReply('Dieses Feature funktioniert nur auf einem Server.');

        // Backward compat: ticket_create_btn:<userId>
        const parts = interaction.customId.split(':');
        const forcedUserId = parts.length > 1 ? parts[1] : null;
        if (forcedUserId && interaction.user.id !== forcedUserId) {
          return interaction.editReply('Du kannst nur dein eigenes Ticket erstellen.');
        }

        const targetUserId = interaction.user.id;

        const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
        const maxOpen = Number(cfg.maxOpenPerUser) || 1;
        const existing = interaction.guild.channels.cache.filter(c => c.topic && c.topic.startsWith(`ticket:${targetUserId}:`));
        if (existing.size >= maxOpen) {
          const first = existing.first();
          return interaction.editReply(first ? `Du hast bereits ein offenes Ticket: ${first}` : 'Du hast bereits ein offenes Ticket.');
        }

        // Resolve staff role id from config: accept raw id, mention, or role name
        let staffRoleId = cfg.staffRoleId ? String(cfg.staffRoleId).trim() : null;
        if (staffRoleId) staffRoleId = staffRoleId.replace(/[<@&>]/g, '');
        if (staffRoleId && !/^\d+$/.test(staffRoleId)) {
          const byExactName = interaction.guild.roles.cache.find(r => r && r.name === String(cfg.staffRoleId).trim());
          staffRoleId = byExactName ? byExactName.id : null;
        }
        let staffRole = null;
        if (staffRoleId && /^\d+$/.test(staffRoleId)) {
          staffRole = interaction.guild.roles.cache.get(staffRoleId) || await interaction.guild.roles.fetch(staffRoleId).catch(() => null);
          if (!staffRole) staffRoleId = null;
        }
        if (!staffRoleId) {
          const byName = interaction.guild.roles.cache.find(r => isStaffLikeRoleName(r && r.name));
          if (byName) {
            staffRoleId = byName.id;
            staffRole = byName;
          }
        }
        const everyone = interaction.guild.roles.everyone;

        // Find or create a shared Tickets category
        let category = null;
        if (cfg.ticketCategoryId && String(cfg.ticketCategoryId).includes('REPLACE_WITH') === false) {
          const cid = String(cfg.ticketCategoryId).replace(/[<#>]/g, '');
          category = interaction.guild.channels.cache.get(cid) || await interaction.guild.channels.fetch(cid).catch(() => null);
        }
        if (!category) {
          category = interaction.guild.channels.cache.find(c => c && c.type === 4 && ['tickets', 'ticket', 'support', 'support-tickets'].includes(String(c.name || '').toLowerCase())) || null;
        }
        if (!category) {
          const catOverwrites = [
            { id: everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          ];
          if (staffRole) {
            catOverwrites.push({ id: staffRole, allow: [PermissionsBitField.Flags.ViewChannel] });
          }
          category = await interaction.guild.channels.create({ name: 'tickets', type: 4, permissionOverwrites: catOverwrites });
        }

        const overwrites = [
          { id: everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
        ];
        if (staffRole) {
          overwrites.push({
            id: staffRole,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages]
          });
        }

        const baseName = `ticket-${interaction.user.username || targetUserId}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .substring(0, 80) || `ticket-${targetUserId.slice(-6)}`;

        const uniqueName = interaction.guild.channels.cache.some(c => c.name === baseName)
          ? `${baseName}-${targetUserId.slice(-4)}`
          : baseName;

        const topic = `ticket:${targetUserId}:support`;
        const ticketChannel = await interaction.guild.channels.create({
          name: uniqueName,
          type: 0,
          parent: category.id,
          permissionOverwrites: overwrites,
          topic,
        });

        const embed = new EmbedBuilder()
          .setTitle('🎫 Support Ticket')
          .setDescription(`Ticket von <@${targetUserId}>\nBitte beschreibe dein Anliegen so genau wie möglich.`)
          .setColor(0x8A2BE2)
          .addFields({ name: 'Schließen', value: 'Staff kann das Ticket mit dem Button unten schließen.', inline: false })
          .setTimestamp();

          const closeBtn = new ButtonBuilder()
            .setCustomId('ticket_close_vanta')
          .setLabel('Close Ticket')
          .setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder().addComponents(closeBtn);

        await ticketChannel.send({ content: `<@${targetUserId}>`, embeds: [embed], components: [row] }).catch(() => {});

        try {
          await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setColor(0x00AAFF).setTitle('Ticket erstellt').setDescription(`Ticket ${ticketChannel} erstellt von <@${targetUserId}>`)] });
        } catch (e) { console.error('ticket log send failed', e); }

        return interaction.editReply(`✅ Ticket erstellt: ${ticketChannel}`);
      } catch (e) {
        console.error('ticket_create_btn interaction failed', e);
        return interaction.editReply('Fehler beim Erstellen des Tickets.');
      }
    }

    if (interaction.isButton() && interaction.customId === 'ticket_close_vanta') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const channel = interaction.channel;
        if (!channel || !channel.topic || !channel.topic.startsWith('ticket:')) return interaction.editReply('Dieses Knopf kann nur in Ticket-Kanälen verwendet werden.');
        const parts = channel.topic.split(':');
        const ownerId = parts[1];
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
        const cfgPath = path.join(DATA_DIR, 'config.json');
        const cfg = loadJson(cfgPath, {});
        const isOwner = interaction.user.id === ownerId;
        let staffRoleId = cfg.staffRoleId ? String(cfg.staffRoleId).replace(/[<@&>]/g, '') : null;
        if (!staffRoleId && interaction.guild) {
          const byName = interaction.guild.roles.cache.find(r => isStaffLikeRoleName(r && r.name));
          if (byName) staffRoleId = byName.id;
        }
        const isStaff = member ? (staffRoleId && member.roles.cache.has(staffRoleId)) || member.permissions.has(PermissionsBitField.Flags.ManageGuild) : false;
        if (!isOwner && !isStaff) return interaction.editReply('Nur der Ersteller oder Staff kann das Ticket schließen.');

        const reason = `Geschlossen durch ${interaction.user.tag} via Button`;

        // create transcript
        const folder = path.join(DATA_DIR, cfg.transcriptFolder || 'transcripts');
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
        const { txtPath, htmlPath } = await createTranscript(channel, folder).catch(()=>({ txtPath: null, htmlPath: null }));

        // try send transcript to log channel
        try {
          await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setTitle('Ticket geschlossen').setDescription(`Ticket ${channel.name} geschlossen von <@${interaction.user.id}>\nGrund: ${reason}`)], files: [txtPath].filter(Boolean) });
        } catch (e) { console.error('ticket log send failed', e); }

        // DM owner
        try { const owner = await interaction.client.users.fetch(ownerId).catch(()=>null); if (owner) await owner.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setTitle('Dein Ticket wurde geschlossen').setDescription(`Grund: ${reason}`)], files: [txtPath].filter(Boolean) }).catch(()=>{}); } catch (e) {}

        // remove only this ticket channel (keep shared category)
        try {
          await channel.delete().catch(()=>{});
        } catch (e) { console.error('failed to remove ticket channels/category', e); }

        try {
          await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setTitle('Ticket geschlossen').setDescription(`Ticket ${channel.name} geschlossen von <@${interaction.user.id}>\nGrund: ${reason}`)] });
        } catch (e) { console.error('ticket log send failed', e); }

        return interaction.editReply('Ticket geschlossen und entfernt.');
      } catch (e) {
        console.error('ticket_close interaction failed', e);
        return interaction.editReply('Fehler beim Schließen des Tickets.');
      }
    }
  } catch (e) { console.error('ticket_close button handler error', e); }

  // Music features disabled (requires @discordjs/voice)
});

function sendModEmbedToUser(user, type, { guild, moderatorTag, reason, caseId, durationText } = {}) {
  const color = 0x87CEFA;

  const lt = String(type || '').toLowerCase();
  const serverName = guild ? guild.name : 'this server';

  const actionPhrase = (() => {
    if (lt.includes('reason updated') || lt.includes('duration updated')) return 'received an update';
    if (lt.includes('unban')) return 'were unbanned';
    if (lt.includes('ban')) return 'were banned';
    if (lt.includes('unmute')) return 'were unmuted';
    if (lt.includes('mute')) return 'were muted';
    if (lt.includes('warn')) return 'were warned';
    if (lt.includes('kick')) return 'were kicked';
    return type ? `were ${type}` : 'received an update';
  })();

  const r = (reason && String(reason).trim()) ? String(reason).trim() : 'No reason provided';
  const desc = `You ${actionPhrase} in ${serverName} for (${r}).`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(desc)
    .setTimestamp();

  return user.send({ embeds: [embed] }).catch(() => null);
}

function buildSmallModerationEmbed({
  title,
  targetId,
  targetAvatarUrl,
  moderatorId,
  reason,
  caseId,
  durationText,
  nowTs
} = {}) {
  const ts = nowTs || Math.floor(Date.now() / 1000);
  const r = (reason && String(reason).trim()) ? String(reason).trim() : '';
  const reasonShort = r ? r.substring(0, 240) : '';
  const modText = moderatorId ? `<@${moderatorId}> (${moderatorId})` : 'Unbekannt';

  const embed = new EmbedBuilder()
    .setTitle(title || 'Moderation')
    .setDescription(targetId ? `<@${targetId}>${reasonShort ? `\nGrund: ${reasonShort}` : ''}` : (reasonShort ? `Grund: ${reasonShort}` : ''))
    .setColor(0x87CEFA);

  if (targetAvatarUrl) embed.setThumbnail(targetAvatarUrl);

  const fields = [
    { name: 'Moderator', value: modText, inline: true },
  ];

  if (durationText) fields.push({ name: 'Dauer', value: String(durationText).substring(0, 120), inline: true });
  fields.push({ name: 'Zeit', value: `<t:${ts}:R>`, inline: true });

  embed.addFields(fields);

  const footerBits = [];
  if (targetId) footerBits.push(`UserID: ${targetId}`);
  if (caseId !== undefined && caseId !== null) footerBits.push(`Fall: ${caseId}`);
  if (footerBits.length) embed.setFooter({ text: footerBits.join(' | ') });
  return embed;
}

function createChannelConfirmEmbed(text, caseId, color = 0x8A2BE2) {
  const when = Date.now();
  return new EmbedBuilder()
    .setColor(color)
    .setDescription(text)
    .setFooter({ text: `${formatFooterTime(when)}` });
}

function formatFooterTime(ts) {
  const d = new Date(ts || Date.now());
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const h = pad(d.getHours());
  const m = pad(d.getMinutes());
  if (sameDay) return `Today at ${h}:${m}`;
  return formatHammertime(d);
}

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(Date());
  console.log(`🔥 CYBRANCEE Bot is online!`);
  
  // Set the bot's presence to Do Not Disturb with custom status
  client.user.setPresence({
    status: 'dnd',
    activities: [
      {
        name: 'Sad😔',
        type: ActivityType.Custom,
      },
    ],
  });
  // reschedule session reminders persisted from previous runs
  try { rescheduleAllReminders(); } catch (e) { console.error('rescheduleAllReminders failed', e); }
});

// Moderation / audit style event logs: member joins/leaves, voice join/leave, message deletions
function findLogChannel(guild) {
  try {
    const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
    if (cfg.logChannelId) return guild.channels.cache.get(cfg.logChannelId) || null;
    // fallback to common names
    const names = ['discord-logs','mod-logs','logs','audit-logs'];
    return guild.channels.cache.find(c => names.includes(c.name)) || null;
  } catch (e) { return null; }
}

const { sendLog } = require('./utils/logger');

function isTextLike(ch) { return ch && (typeof ch.isTextBased === 'function' ? ch.isTextBased() : (ch.isText && ch.isText())); }

function buildFooter(guild) {
  if (!guild) return undefined;
  return { text: `Guild: ${guild.name} (${guild.id})` };
}

client.on('guildMemberAdd', async (member) => {
  try {
    // Auto-assign member role
    const cfg = loadGuildConfig(member.guild.id);
    const joinTs = Math.floor(Date.now() / 1000);
    try {
      const memberRoleId = process.env.MEMBER_ROLE_ID || cfg.memberRoleId;
      const rid = memberRoleId ? String(memberRoleId).replace(/[<@&>]/g, '') : null;
      const memberRole = rid
        ? (member.guild.roles.cache.get(rid) || await member.guild.roles.fetch(rid).catch(() => null))
        : (member.guild.roles.cache.find(r => String(r.name || '').toLowerCase() === 'member') || member.guild.roles.cache.find(r => String(r.name || '').toLowerCase() === 'members'));
      if (memberRole && !member.roles.cache.has(memberRole.id)) {
        await member.roles.add(memberRole, 'Auto-assigned on join').catch(() => {});
      }
    } catch (e) { console.error('Failed to assign member role', e); }

    // Send welcome message to welcome channel
    const welcomeChannelId = process.env.WELCOME_CHANNEL_ID || cfg.welcomeChannelId;
    const rulesChannelId = process.env.RULES_CHANNEL_ID || cfg.rulesChannelId || welcomeChannelId;

    if (welcomeChannelId) {
      const welcomeCh = member.guild.channels.cache.get(welcomeChannelId) || await member.guild.channels.fetch(welcomeChannelId).catch(() => null);
      if (welcomeCh && isTextLike(welcomeCh)) {
        const welcomeEmbed = new EmbedBuilder()
          .setTitle('👋 WILLKOMMEN')
          .setDescription(
            `Willkommen auf **${member.guild.name}**, <@${member.id}>!\n\n` +
            `Bitte lies unbedingt die Regeln in <#${rulesChannelId}>.\n\n` +
            `Beitritt: <t:${joinTs}:F> (<t:${joinTs}:R>)`
          )
          .setColor(0x8A2BE2)
          .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
          .addFields(
            { name: 'Member', value: `${member.user.tag}`, inline: true },
            { name: 'ID', value: `${member.id}`, inline: true },
            { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: false }
          );
        await welcomeCh.send({ embeds: [welcomeEmbed] }).catch(() => {});
      }
    }

    // Join logs (German, light blue, Hammertime)
    const joinLogChannelId = process.env.JOIN_LOG_CHANNEL_ID || cfg.joinLogChannelId;
    if (joinLogChannelId) {
      const joinLogCh = member.guild.channels.cache.get(joinLogChannelId) || await member.guild.channels.fetch(joinLogChannelId).catch(() => null);
      if (joinLogCh && isTextLike(joinLogCh)) {
        const createdTs = Math.floor(member.user.createdTimestamp / 1000);
        const joinLogEmbed = new EmbedBuilder()
          .setTitle('Mitglied beigetreten')
          .setDescription(`<@${member.id}>`) 
          .setColor(0x87CEFA)
          .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
          .addFields(
            { name: 'ID', value: `${member.id}`, inline: true },
            { name: 'Account-Alter', value: `<t:${createdTs}:R>`, inline: true }
          );
        await joinLogCh.send({ embeds: [joinLogEmbed] }).catch(() => {});
      }
    } else {
      // Fallback: log to general audit channel if joinLogChannelId is not configured
      const logCh = findLogChannel(member.guild);
      if (!logCh || !isTextLike(logCh)) return;
      const embed = new EmbedBuilder()
        .setTitle('User joined')
        .setColor(0x2ECC71)
        .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
        .addFields(
          { name: 'User', value: `<@${member.id}> (${member.user.tag})`, inline: true },
          { name: 'ID', value: `${member.id}`, inline: true },
          { name: 'Joined', value: `<t:${joinTs}:F> (<t:${joinTs}:R>)`, inline: false }
        ).setTimestamp()
        .setFooter(buildFooter(member.guild));
      await sendLog(member.guild, { embeds: [embed], category: 'mod' }).catch(()=>{});
    }
  } catch (e) { console.error('guildMemberAdd log failed', e); }
});

// Track when staff-like roles are added/removed (for duration reporting in -destaff)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (!oldMember || !newMember) return;
    if (!newMember.guild) return;

    const oldRoles = oldMember.roles ? oldMember.roles.cache : null;
    const newRoles = newMember.roles ? newMember.roles.cache : null;
    if (!oldRoles || !newRoles) return;

    // Added roles
    for (const [rid, role] of newRoles) {
      if (!oldRoles.has(rid) && isStaffLikeRoleName(role.name)) {
        setStaffRoleSince(newMember.guild.id, newMember.id, rid, Date.now());
      }
    }

    // Removed roles
    for (const [rid, role] of oldRoles) {
      if (!newRoles.has(rid) && isStaffLikeRoleName(role.name)) {
        clearStaffRoleSince(newMember.guild.id, newMember.id, rid);
      }
    }
  } catch (e) {
    console.error('guildMemberUpdate staff-role tracking failed', e);
  }
});

client.on('guildMemberRemove', async (member) => {
  try {
    // If this removal is due to a kick/ban, log it as moderation instead of a normal leave
    try {
      const now = Date.now();
      const banLogs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 6 }).catch(() => null);
      const banEntry = banLogs && banLogs.entries
        ? banLogs.entries.find(e => e && e.target && String(e.target.id) === String(member.id) && (now - e.createdTimestamp) < 15000)
        : null;
      if (banEntry) {
        // Ban is handled by guildBanAdd for a richer payload; skip leave logging
        return;
      }

      const kickLogs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 6 }).catch(() => null);
      const kickEntry = kickLogs && kickLogs.entries
        ? kickLogs.entries.find(e => e && e.target && String(e.target.id) === String(member.id) && (now - e.createdTimestamp) < 15000)
        : null;

      if (kickEntry) {
        const nowTs = Math.floor(Date.now() / 1000);
        const targetUser = member.user;
        const embed = buildSmallModerationEmbed({
          title: 'Mitglied gekickt',
          targetId: member.id,
          targetAvatarUrl: targetUser.displayAvatarURL({ extension: 'png', size: 256 }),
          moderatorId: kickEntry.executor ? kickEntry.executor.id : null,
          reason: kickEntry.reason || '—',
          nowTs
        });
        await sendLog(member.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
        return;
      }
    } catch (e) {}

    // Send leave message to welcome channel
    const cfg = loadGuildConfig(member.guild.id);
    if (cfg.welcomeChannelId) {
      const welcomeCh = member.guild.channels.cache.get(cfg.welcomeChannelId) || await member.guild.channels.fetch(cfg.welcomeChannelId).catch(() => null);
      if (welcomeCh && isTextLike(welcomeCh)) {
        const leaveEmbed = new EmbedBuilder()
          .setTitle('👋 GOODBYE')
          .setDescription(`**${member.user.tag}** has left **${member.guild.name}**.\n\nWe hope to see you again soon!`)
          .setColor(0xE74C3C)
          .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
          .addFields(
            { name: 'Member', value: `${member.user.tag}`, inline: true },
            { name: 'ID', value: `${member.id}`, inline: true }
          )
          .setFooter({ text: `Member count: ${member.guild.memberCount}` })
          .setTimestamp();
        await welcomeCh.send({ embeds: [leaveEmbed] }).catch(() => {});
      }
    }

    // Leave logs (German, light blue, Hammertime)
    const leaveLogChannelId = process.env.LEAVE_LOG_CHANNEL_ID || cfg.leaveLogChannelId;
    if (leaveLogChannelId) {
      const leaveLogCh = member.guild.channels.cache.get(leaveLogChannelId) || await member.guild.channels.fetch(leaveLogChannelId).catch(() => null);
      if (leaveLogCh && isTextLike(leaveLogCh)) {
        const createdTs = Math.floor(member.user.createdTimestamp / 1000);
        const leaveLogEmbed = new EmbedBuilder()
          .setTitle('Mitglied verlassen')
          .setDescription(`<@${member.id}>`)
          .setColor(0x87CEFA)
          .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
          .addFields(
            { name: 'ID', value: `${member.id}`, inline: true },
            { name: 'Account-Alter', value: `<t:${createdTs}:R>`, inline: true }
          );
        await leaveLogCh.send({ embeds: [leaveLogEmbed] }).catch(() => {});
      }
    } else {
      // Fallback: log to general audit channel if leaveLogChannelId is not configured
      const logCh = findLogChannel(member.guild);
      if (!logCh || !isTextLike(logCh)) return;
      const roles = member.roles ? member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name).join(', ') : '';
      const embed = new EmbedBuilder()
        .setTitle('User left')
        .setColor(0xE74C3C)
        .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
        .addFields(
          { name: 'User', value: `${member.user.tag} (<@${member.id}>)`, inline: true },
          { name: 'ID', value: `${member.id}`, inline: true },
          { name: 'Roles', value: roles || '—', inline: false }
        ).setTimestamp()
        .setFooter(buildFooter(member.guild));
      await sendLog(member.guild, { embeds: [embed], category: 'mod' }).catch(()=>{});
    }
  } catch (e) { console.error('guildMemberRemove log failed', e); }
});

client.on('guildBanAdd', async (ban) => {
  try {
    if (!ban || !ban.guild || !ban.user) return;
    const nowTs = Math.floor(Date.now() / 1000);

    let moderatorId = null;
    let reason = ban.reason || null;
    try {
      const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 6 }).catch(() => null);
      const entry = logs && logs.entries
        ? logs.entries.find(e => e && e.target && String(e.target.id) === String(ban.user.id) && (Date.now() - e.createdTimestamp) < 15000)
        : null;
      if (entry) {
        moderatorId = entry.executor ? entry.executor.id : null;
        if (!reason && entry.reason) reason = entry.reason;
      }
    } catch (e) {}

    const embed = buildSmallModerationEmbed({
      title: 'Nutzer gebannt',
      targetId: ban.user.id,
      targetAvatarUrl: ban.user.displayAvatarURL({ extension: 'png', size: 256 }),
      moderatorId,
      reason: reason || '—',
      nowTs
    });
    await sendLog(ban.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
  } catch (e) {
    console.error('guildBanAdd log failed', e);
  }
});

client.on('guildBanRemove', async (ban) => {
  try {
    if (!ban || !ban.guild || !ban.user) return;
    const nowTs = Math.floor(Date.now() / 1000);

    let moderatorId = null;
    let reason = ban.reason || null;
    try {
      const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanRemove, limit: 6 }).catch(() => null);
      const entry = logs && logs.entries
        ? logs.entries.find(e => e && e.target && String(e.target.id) === String(ban.user.id) && (Date.now() - e.createdTimestamp) < 15000)
        : null;
      if (entry) {
        moderatorId = entry.executor ? entry.executor.id : null;
        if (!reason && entry.reason) reason = entry.reason;
      }
    } catch (e) {}

    const embed = buildSmallModerationEmbed({
      title: 'Nutzer entbannt',
      targetId: ban.user.id,
      targetAvatarUrl: ban.user.displayAvatarURL({ extension: 'png', size: 256 }),
      moderatorId,
      reason: reason || '—',
      nowTs
    });
    await sendLog(ban.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
  } catch (e) {
    console.error('guildBanRemove log failed', e);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    const logCh = findLogChannel(guild);
    if (!logCh || !isTextLike(logCh)) return;
    // join
    if (!oldState.channelId && newState.channelId) {
      const embed = new EmbedBuilder().setTitle('User joined channel').setColor(0x2ECC71)
        .setThumbnail(newState.member.user.displayAvatarURL({ extension: 'png', size: 256 }))
        .addFields(
          { name: 'User', value: `${newState.member.user.tag} (<@${newState.id}>)`, inline: true },
          { name: 'Channel', value: `${newState.channel ? `${newState.channel.name}` : newState.channelId}`, inline: true }
        ).setTimestamp()
        .setFooter(buildFooter(guild));
      await sendLog(guild, { embeds: [embed], category: 'audit' }).catch(()=>{});
    }
    // leave
    if (oldState.channelId && !newState.channelId) {
      const embed = new EmbedBuilder().setTitle('User left channel').setColor(0xE74C3C)
        .setThumbnail(oldState.member.user.displayAvatarURL({ extension: 'png', size: 256 }))
        .addFields(
          { name: 'User', value: `${oldState.member.user.tag} (<@${oldState.id}>)`, inline: true },
          { name: 'Channel', value: `${oldState.channel ? `${oldState.channel.name}` : oldState.channelId}`, inline: true }
        ).setTimestamp()
        .setFooter(buildFooter(guild));
      await sendLog(guild, { embeds: [embed], category: 'audit' });
    }
  } catch (e) { console.error('voiceStateUpdate log failed', e); }
});

client.on('messageDelete', async (message) => {
  try {
    const guild = message.guild;
    if (!guild) return;

    const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
    const messageLogChannelId = process.env.MESSAGE_LOG_CHANNEL_ID || cfg.messageLogChannelId;
    const logCh = messageLogChannelId
      ? (guild.channels.cache.get(messageLogChannelId) || await guild.channels.fetch(messageLogChannelId).catch(() => null))
      : findLogChannel(guild);
    if (!logCh || !isTextLike(logCh)) return;

    // message may be partial
    let author = message.author;
    let content = message.content || '';
    try { if (message.partial) { const fetched = await message.fetch().catch(()=>null); if (fetched) { author = fetched.author; content = fetched.content; } } } catch(e){}
    const link = (guild && message.channelId) ? `https://discord.com/channels/${guild.id}/${message.channelId}/${message.id}` : 'n/a';
    const nowTs = Math.floor(Date.now() / 1000);
    const embed = new EmbedBuilder()
      .setTitle('Nachricht gelöscht')
      .setDescription(author ? `<@${author.id}>` : 'Unbekannter Autor')
      .setColor(0x87CEFA)
      .setThumbnail(author && typeof author.displayAvatarURL === 'function' ? author.displayAvatarURL({ extension: 'png', size: 256 }) : null)
      .addFields(
        { name: 'ID', value: `${message.id}`, inline: true },
        { name: 'Kanal', value: message.channelId ? `<#${message.channelId}>` : 'Unbekannt', inline: true },
        { name: 'Zeit', value: `<t:${nowTs}:R>`, inline: false },
        { name: 'Inhalt', value: content ? content.substring(0, 700) : '—', inline: false }
      );
    await logCh.send({ embeds: [embed] }).catch(() => {});
  } catch (e) { console.error('messageDelete log failed', e); }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    const guild = newMessage.guild || oldMessage.guild;
    if (!guild) return;

    // Ignore bot edits
    const author = (newMessage && newMessage.author) || (oldMessage && oldMessage.author);
    if (author && author.bot) return;

    const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
    const messageLogChannelId = process.env.MESSAGE_LOG_CHANNEL_ID || cfg.messageLogChannelId;
    const logCh = messageLogChannelId
      ? (guild.channels.cache.get(messageLogChannelId) || await guild.channels.fetch(messageLogChannelId).catch(() => null))
      : findLogChannel(guild);
    if (!logCh || !isTextLike(logCh)) return;

    // Fetch partials for reliable content
    let oldFetched = oldMessage;
    let newFetched = newMessage;
    try { if (oldFetched && oldFetched.partial) oldFetched = await oldFetched.fetch().catch(() => oldFetched); } catch (e) {}
    try { if (newFetched && newFetched.partial) newFetched = await newFetched.fetch().catch(() => newFetched); } catch (e) {}

    const before = (oldFetched && typeof oldFetched.content === 'string') ? oldFetched.content : '';
    const after = (newFetched && typeof newFetched.content === 'string') ? newFetched.content : '';
    if ((before || '') === (after || '')) return;

    const channelId = (newFetched && newFetched.channelId) || (oldFetched && oldFetched.channelId);
    const msgId = (newFetched && newFetched.id) || (oldFetched && oldFetched.id);
    const link = (guild && channelId && msgId) ? `https://discord.com/channels/${guild.id}/${channelId}/${msgId}` : 'n/a';
    const nowTs = Math.floor(Date.now() / 1000);

    const embed = new EmbedBuilder()
      .setTitle('Nachricht bearbeitet')
      .setDescription(author ? `<@${author.id}>` : 'Unbekannter Autor')
      .setColor(0x87CEFA)
      .setThumbnail(author && typeof author.displayAvatarURL === 'function' ? author.displayAvatarURL({ extension: 'png', size: 256 }) : null)
      .addFields(
        { name: 'ID', value: `${msgId || '—'}`, inline: true },
        { name: 'Kanal', value: channelId ? `<#${channelId}>` : 'Unbekannt', inline: true },
        { name: 'Zeit', value: `<t:${nowTs}:R>`, inline: false },
        { name: 'Update', value: `${before ? before.substring(0, 350) : '—'}\n→\n${after ? after.substring(0, 350) : '—'}`, inline: false }
      );
    await logCh.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.error('messageUpdate log failed', e);
  }
});

client.on('messageDeleteBulk', async (messages, channel) => {
  try {
    const guild = channel && channel.guild;
    if (!guild) return;

    const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
    const messageLogChannelId = process.env.MESSAGE_LOG_CHANNEL_ID || cfg.messageLogChannelId;
    const logCh = messageLogChannelId
      ? (guild.channels.cache.get(messageLogChannelId) || await guild.channels.fetch(messageLogChannelId).catch(() => null))
      : findLogChannel(guild);
    if (!logCh || !isTextLike(logCh)) return;

    const nowTs = Math.floor(Date.now() / 1000);
    const count = messages && typeof messages.size === 'number' ? messages.size : (Array.isArray(messages) ? messages.length : 0);
    const embed = new EmbedBuilder()
      .setTitle('Mehrere Nachrichten gelöscht')
      .setColor(0x87CEFA)
      .addFields(
        { name: 'Kanal', value: channel && channel.id ? `<#${channel.id}>` : 'Unbekannt', inline: true },
        { name: 'Anzahl', value: `${count}`, inline: true },
        { name: 'Zeit', value: `<t:${nowTs}:R>`, inline: false }
      );
    await logCh.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.error('messageDeleteBulk log failed', e);
  }
});

// Ticket system: load modular ready + interaction handlers (keeps main file unchanged)
try {
  const readyTicket = require('./events/ready.ticket.js');
  if (readyTicket && typeof readyTicket.execute === 'function') client.once('ready', () => readyTicket.execute(client));
} catch (e) { console.error('Failed to load ready.ticket.js', e); }

try {
  const interTicket = require('./events/interactionCreate.ticket.js');
  if (interTicket && typeof interTicket.execute === 'function') client.on('interactionCreate', (interaction) => { try { interTicket.execute(interaction); } catch (err) { console.error('ticket interaction handler error', err); } });
} catch (e) { console.error('Failed to load interactionCreate.ticket.js', e); }

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Prefix command: -dm / <PREFIX>dm  -> DMs a user with a purple embed
  // Usage: -dm @user <message>
  try {
    const raw = (message.content || '').trim();
    const lowered = raw.toLowerCase();
    const dmPrefixA = `${PREFIX}dm`;
    const dmPrefixB = `-dm`;
    const isDmCmd = lowered === dmPrefixA || lowered.startsWith(dmPrefixA + ' ') || lowered === dmPrefixB || lowered.startsWith(dmPrefixB + ' ');

    if (isDmCmd) {
      if (!message.guild) return message.reply('Dieses Kommando kann nur auf einem Server verwendet werden.');

      const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      const isStaff = member
        ? (cfg.staffRoleId && member.roles.cache.has(String(cfg.staffRoleId).replace(/[<@&>]/g, '')))
          || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        : false;

      if (!isStaff) return message.reply('Du hast keine Berechtigung, dieses Kommando zu nutzen.');

      const parts = raw.split(/\s+/);
      const targetArg = parts[1];
      const dmText = parts.slice(2).join(' ').trim();
      const targetId = parseId(targetArg) || (targetArg && /^\d+$/.test(targetArg) ? targetArg : null);

      if (!targetId || !dmText) {
        return message.reply(`Usage: ${PREFIX}dm @user <message>  oder  -dm @user <message>`);
      }

      const targetUser = await client.users.fetch(targetId).catch(() => null);
      if (!targetUser) return message.reply('User nicht gefunden.');

      const embed = new EmbedBuilder()
        .setColor(0x87CEFA)
        .setTitle('Nachricht')
        .setDescription(dmText.substring(0, 4000))
        .setTimestamp()
        .setFooter({ text: `Von ${message.guild.name}` });

      try {
        await targetUser.send({ embeds: [embed] });
      } catch (e) {
        return message.reply('Konnte keine DM senden (DMs deaktiviert oder User blockiert).');
      }

      appendActionMd(message.guild, message.author.tag, 'DM Sent', `Sent DM to ${targetUser.tag} (${targetUser.id}): ${dmText}`);
      try {
        await sendLog(message.guild, {
          embeds: [
            new EmbedBuilder()
              .setColor(0x87CEFA)
              .setTitle('DM gesendet')
              .setDescription(`An: <@${targetUser.id}>\nVon: ${message.author.tag}\n\n${dmText.substring(0, 3500)}`)
              .setTimestamp()
              .setFooter(buildFooter(message.guild))
          ],
          category: 'moderation'
        }).catch(() => {});
      } catch (e) {}

      return message.reply(`DM gesendet an ${targetUser.tag}.`);
    }
  } catch (e) {
    console.error('dm command failed', e);
  }

  // Prefix command: -env / <PREFIX>env -> shows environment/token diagnostics (staff only)
  try {
    const rawEnv = (message.content || '').trim();
    const loweredEnv = rawEnv.toLowerCase();
    const envCmdA = `${PREFIX}env`;
    const envCmdB = `-env`;
    const isEnvCmd = loweredEnv === envCmdA || loweredEnv === envCmdB;
    if (isEnvCmd) {
      if (!message.guild) return message.reply('This command can only be used in a server.');

      const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      const isStaff = member
        ? (cfg.staffRoleId && member.roles.cache.has(String(cfg.staffRoleId).replace(/[<@&>]/g, '')))
          || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        : false;
      if (!isStaff) return message.reply('No permission.');

      const { token: t, source: src } = resolveToken();
      const len = t ? t.length : 0;
      const masked = t ? `${String(t).slice(0, 4)}…${String(t).slice(-4)}` : '(none)';

      const embed = new EmbedBuilder()
        .setColor(0x8A2BE2)
        .setTitle('Environment Check')
        .addFields(
          { name: '.env present', value: String(DOTENV_PRESENT), inline: true },
          { name: 'dotenv loaded', value: String(DOTENV_LOADED), inline: true },
          { name: 'token source', value: src || 'none', inline: false },
          { name: 'token length', value: String(len), inline: true },
          { name: 'token preview', value: masked, inline: true },
          {
            name: 'env vars present',
            value: `TOKENSP=${!!process.env.TOKENSP}  TOKEN=${!!process.env.TOKEN}  DISCORD_TOKEN=${!!process.env.DISCORD_TOKEN}  GIT_ACCESS_TOKEN=${!!process.env.GIT_ACCESS_TOKEN}`,
            inline: false,
          }
        )
        .setTimestamp()
        .setFooter(buildFooter(message.guild));

      return message.reply({ embeds: [embed] });
    }
  } catch (e) {
    console.error('env command failed', e);
  }

  // Prefix command ticket system: !ticket (creates ticket category+channel), !close (mods only)
  try {
    if (message.content && message.content.trim().toLowerCase() === `${PREFIX}ticket`) {
      if (!message.guild) return message.reply('Dieses Kommando kann nur auf einem Server verwendet werden.');
      const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
      const maxOpen = Number(cfg.maxOpenPerUser) || 1;
      const userId = message.author.id;

      // check open tickets for this user
      const existing = message.guild.channels.cache.filter(c => c.topic && c.topic.startsWith(`ticket:${userId}:`));
      if (existing.size >= maxOpen) return message.reply('Du hast bereits ein offenes Ticket. Bitte schließe es zuerst.');

      // Send a professional ticket panel with a button (user can create their private ticket)
      const panelEmbed = new EmbedBuilder()
        .setTitle('🎫 Support Tickets')
        .setDescription('Klicke auf **Create Ticket**, um ein privates Ticket zu eröffnen.\nEin Staff-Mitglied wird dir so schnell wie möglich helfen.')
        .setColor(0x8A2BE2)
        .setTimestamp()
        .setFooter(buildFooter(message.guild));

      const createBtn = new ButtonBuilder()
        .setCustomId('ticket_create_btn')
        .setLabel('Create Ticket')
        .setStyle(ButtonStyle.Primary);
      const row = new ActionRowBuilder().addComponents(createBtn);

      message.delete().catch(() => {});
      const panelMsg = await message.channel.send({ embeds: [panelEmbed], components: [row] }).catch(() => null);
      if (panelMsg) setTimeout(() => panelMsg.delete().catch(() => {}), 60_000);
      return;
    }
  } catch (e) { console.error('ticket command check failed', e); }
  // Auto-mod: configurable: prevent users with blocked roles from posting invites/links
  if (message.guild && message.member) {
    try {
      const cfg = AUTOMOD_CONFIG;
      const isExempt = message.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || message.member.permissions.has(PermissionsBitField.Flags.ManageMessages) || message.member.permissions.has(PermissionsBitField.Flags.ManageChannels) || message.member.permissions.has(PermissionsBitField.Flags.ManageRoles);
      const hasBlocked = cfg.blockedRoles && cfg.blockedRoles.length && message.member.roles.cache.some(r => cfg.blockedRoles.includes(r.name));
      const hasAllowed = cfg.allowedRoles && cfg.allowedRoles.length && message.member.roles.cache.some(r => cfg.allowedRoles.includes(r.name));
      if (hasBlocked && !hasAllowed && !isExempt && message.content) {
        const inviteRe = /(discord(?:\.gg|app\.com\/invite)\/[A-Za-z0-9-]+)/i;
        const urlRe = /https?:\/\/[^\s]+/i;
        if (inviteRe.test(message.content) || urlRe.test(message.content)) {
          try { await message.delete().catch(() => {}); } catch (e) {}

          const muteMs = Math.max(0, (cfg.muteMinutes || 2) * 60 * 1000);
          const caseId = nextCase();
          const reason = inviteRe.test(message.content) ? 'Posting invite link' : 'Posting link';
          modlogs.cases.push({ caseId, type: 'AutoMute', user: message.author.id, moderator: 'AutoMod', reason, durationMs: muteMs, time: Date.now() });
          saveJson(MODLOGS_PATH, modlogs);

          try { await message.member.timeout(muteMs, `AutoMod: ${reason}`); } catch (e) { console.error('autmod timeout failed', e); }

          appendActionMd(message.guild, 'AutoMod', 'AutoMute', `${message.author.tag} (${message.author.id}) muted for ${cfg.muteMinutes}m for: ${reason} in #${message.channel.name}`);

          // Send a compact DM to the user (styled same as other mod DMs) and post the compact log in the log channel
          try {
            await sendModEmbedToUser(message.author, 'AutoMute', { guild: message.guild, moderatorTag: 'AutoMod', reason, caseId, durationText: `${cfg.muteMinutes} minutes` });
          } catch (e) {}

          try {
            const logChannel = message.guild.channels.cache.find(c => cfg.logChannelNames.includes(c.name));
            if (logChannel && logChannel.isText()) {
              await logChannel.send({ embeds: [createChannelConfirmEmbed(`Auto-muted <@${message.author.id}> for ${cfg.muteMinutes} minutes — Reason: ${reason}`, caseId)] }).catch(() => {});
            }
          } catch (e) {}

          return;
        }
      }
    } catch (e) {
      console.error('automod check failed', e);
    }
  }

  // Blacklist command starts with dash
  if (message.content.startsWith('-')) {
    const [cmd, ...rest] = message.content.slice(1).trim().split(/\s+/);
    const lcmd = String(cmd || '').toLowerCase();
    if (lcmd === 'purg' || lcmd === 'purge') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return message.reply('You lack permission to purge messages.');
      const want = Math.max(1, Math.min(1000, parseInt(rest[0], 10) || 1));
      const userArg = rest[1];
      // If no userArg provided: delete the last `want` messages in the channel (any author)
      if (!userArg) {
        try {
          const collected = [];
          let lastId = null;
          while (collected.length < want) {
            const fetchOpts = { limit: 100 };
            if (lastId) fetchOpts.before = lastId;
            const fetched = await message.channel.messages.fetch(fetchOpts).catch(() => null);
            if (!fetched || fetched.size === 0) break;
            for (const m of fetched.values()) {
              if (collected.length >= want) break;
              if (m.id === message.id) continue; // skip the command message
              collected.push(m);
            }
            lastId = fetched.last() ? fetched.last().id : null;
            if (!lastId || fetched.size < 100) break;
          }
          if (!collected.length) return message.reply('No recent messages found to delete.');
          const toDelete = collected.slice(0, want);
          let deletedTotal = 0;
          while (toDelete.length > 0) {
            const batch = toDelete.splice(0, 100);
            const ids = batch.map(x => x.id);
            const deleted = await message.channel.bulkDelete(ids, true).catch(() => null);
            if (deleted && deleted.size) deletedTotal += deleted.size;
            else deletedTotal += ids.length;
            await new Promise(r => setTimeout(r, 250));
          }
          const chConfirm = createChannelConfirmEmbed(`Deleted ${deletedTotal} messages from this channel.`);
          await message.channel.send({ embeds: [chConfirm] }).catch(()=>{});
          const nowTs = Math.floor(Date.now() / 1000);
          const logEmbed = new EmbedBuilder()
            .setTitle('Nachrichten gelöscht (Purge)')
            .setColor(0x87CEFA)
            .addFields(
              { name: 'Anzahl', value: `${deletedTotal}`, inline: true },
              { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
              { name: 'Zeit', value: `<t:${nowTs}:R>`, inline: true }
            );
          await sendLog(message.guild, { embeds: [logEmbed], category: 'moderation' }).catch(()=>{});
        } catch (e) {
          console.error('purg command failed', e);
          return message.reply('Failed to purge messages.');
        }
        return;
      }

      // Otherwise, target the specified user and delete their recent messages
      let targetId = (parseId(userArg) || userArg.replace(/[<@!>]/g, ''));
      if (!targetId) return message.reply('Usage: -purg <count> [user mention|id]');
      try {
        const collected = [];
        let lastId = null;
        while (collected.length < want) {
          const fetchOpts = { limit: 100 };
          if (lastId) fetchOpts.before = lastId;
          const fetched = await message.channel.messages.fetch(fetchOpts).catch(() => null);
          if (!fetched || fetched.size === 0) break;
          for (const m of fetched.values()) {
            if (collected.length >= want) break;
            if (m.author && String(m.author.id) === String(targetId) && m.id !== message.id) collected.push(m);
          }
          lastId = fetched.last() ? fetched.last().id : null;
          if (!lastId || fetched.size < 100) break;
        }
        if (!collected.length) return message.reply('No recent messages found for that user to delete.');
        const toDelete = collected.slice(0, want);
        let deletedTotal = 0;
        while (toDelete.length > 0) {
          const batch = toDelete.splice(0, 100);
          const ids = batch.map(x => x.id);
          const deleted = await message.channel.bulkDelete(ids, true).catch(() => null);
          if (deleted && deleted.size) deletedTotal += deleted.size;
          else deletedTotal += ids.length;
          await new Promise(r => setTimeout(r, 250));
        }
        const chConfirm = createChannelConfirmEmbed(`Deleted ${deletedTotal} messages from <@${targetId}>.`);
        await message.channel.send({ embeds: [chConfirm] }).catch(()=>{});
        const nowTs = Math.floor(Date.now() / 1000);
        const logEmbed = new EmbedBuilder()
          .setTitle('Nachrichten gelöscht (Purge)')
          .setColor(0x87CEFA)
          .addFields(
            { name: 'Ziel', value: `<@${targetId}>`, inline: true },
            { name: 'Anzahl', value: `${deletedTotal}`, inline: true },
            { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
            { name: 'Zeit', value: `<t:${nowTs}:R>`, inline: true }
          );
        await sendLog(message.guild, { embeds: [logEmbed], category: 'moderation' }).catch(()=>{});
      } catch (e) {
        console.error('purg command failed', e);
        return message.reply('Failed to purge messages.');
      }
      return;
    }
    if (cmd.toLowerCase() === 'blacklist') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('You lack permission to blacklist users.');
      const id = parseId(rest[0]) || rest[0];
      const reason = rest.slice(1).join(' ') || 'No reason provided';
      if (!id || !/^\d+$/.test(id)) return message.reply('Please provide a valid user ID to blacklist.');

      const existingEntry = blacklist.blacklisted.find(b => b && typeof b === 'object' && String(b.id) === String(id));

      // Ban targets (explicit list as requested)
      const targetGuildIds = [
        '1459330497938325676',
        '1459345285317791917',
        '1368527215343435826',
        '1339662600903983154',
      ];

      const banAttempts = [];
      for (const gid of targetGuildIds) {
        const g = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
        if (!g) {
          banAttempts.push({ guildId: gid, guildName: null, ok: false, error: 'Bot not in guild / cannot fetch guild' });
          continue;
        }
        try {
          await g.members.ban(id, { reason: `Blacklisted: ${reason} (by ${message.author.tag})` });
          banAttempts.push({ guildId: g.id, guildName: g.name, ok: true });
        } catch (e) {
          banAttempts.push({ guildId: g.id, guildName: g.name, ok: false, error: String(e.message || e) });
        }
      }

      const success = banAttempts.filter(a => a.ok).length;
      const failed = banAttempts.filter(a => !a.ok).length;

      if (existingEntry) {
        existingEntry.reason = reason;
        existingEntry.moderator = message.author.id;
        existingEntry.time = Date.now();
        existingEntry.banAttempts = banAttempts;
      } else {
        blacklist.blacklisted.push({ id, reason, moderator: message.author.id, time: Date.now(), banAttempts });
      }
      saveJson(BLACKLIST_PATH, blacklist);

      const embed = new EmbedBuilder()
        .setColor(0x8A2BE2)
        .setTitle('Blacklist')
        .addFields(
          { name: 'User', value: `<@${id}> (${id})`, inline: true },
          { name: 'Reason', value: reason.substring(0, 256), inline: true },
          { name: 'Moderator', value: `<@${message.author.id}>`, inline: true }
        )
        .addFields(
          { name: 'Success', value: `${success} servers`, inline: true },
          { name: 'Failed', value: `${failed} servers`, inline: true }
        )
        .setTimestamp()
        .setFooter(buildFooter(message.guild));

      if (existingEntry) {
        embed.setDescription('Already blacklisted — re-running bans in target servers.');
      }

      if (banAttempts.length) {
        const lines = banAttempts
          .map(a => `${a.ok ? '✅' : '❌'} ${a.guildName || 'Unknown'} (${a.guildId})${a.ok ? '' : ` — ${String(a.error || 'failed').substring(0, 60)}`}`)
          .join('\n');
        embed.addFields({ name: 'Ban results', value: lines.substring(0, 1024), inline: false });
      }

      return message.channel.send({ embeds: [embed] });
    }

    if (cmd.toLowerCase() === 'destaff' || cmd.toLowerCase() === 'destaffban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return message.reply('Du hast keine Berechtigung, Nutzer zu destaffen.');
      const id = parseId(rest[0]) || rest[0];
      const reason = rest.slice(1).join(' ') || 'Kein Grund angegeben';
      if (!id || !/^\d+$/.test(id)) return message.reply('Bitte gib eine gültige User-ID oder Mention an.');

      // Requested now: ONLY remove staff roles, do NOT ban.
      const shouldBan = false;
      let member = null;
      try {
        member = await message.guild.members.fetch(id).catch(() => null);
      } catch (e) {}

      if (!member) return message.reply('User not found in this guild.');

      const removedRoles = [];
      const failedRoles = [];
      const removedRoleDurations = [];
      const errors = [];
      const botMember = message.guild.members.me;
      const botHighest = botMember.roles.highest;
      const rolesToRemove = ['staff', 'admin', 'administrator', 'moderator', 'mod'];

      for (const [roleId, role] of member.roles.cache) {
        if (role.name === '@everyone') continue;
        if (!rolesToRemove.some(r => role.name.toLowerCase().includes(r))) continue;
        if (role.position >= botHighest.position) {
          failedRoles.push(role.name);
          errors.push(`Role too high to remove: ${role.name}`);
          continue;
        }
        try {
          await member.roles.remove(role, `Destaff by ${message.author.tag}: ${reason}`);
          removedRoles.push(role.name);

          // duration (if we have tracked it)
          const since = getStaffRoleSince(message.guild.id, id, roleId);
          if (since) {
            removedRoleDurations.push(`${role.name}: ${humanDuration(Date.now() - since)}`);
          } else {
            removedRoleDurations.push(`${role.name}: unknown`);
          }

          clearStaffRoleSince(message.guild.id, id, roleId);
        } catch (e) {
          failedRoles.push(role.name);
          errors.push(`Failed removing ${role.name}: ${String(e.message || e)}`);
        }
      }

      // Intentionally no ban logic here.

      // Store in destaff logs file (no case id in output)
      try {
        destaffs.cases.push({
          type: 'Destaff',
          user: id,
          moderator: message.author.id,
          reason,
          removedRoles,
          failedRoles,
          roleDurations: removedRoleDurations,
          errors,
          time: Date.now(),
        });
        saveJson(DESTAFFS_PATH, destaffs);
      } catch (e) {
        errors.push(`Failed writing destaffs.json: ${String(e.message || e)}`);
      }

      const title = 'Destaff';
      const compactRemoved = removedRoles.length ? removedRoles.join(', ').substring(0, 256) : '—';
      const compactFailed = failedRoles.length ? failedRoles.join(', ').substring(0, 256) : '—';
      const durationPreview = removedRoleDurations.length ? removedRoleDurations.join(' | ').substring(0, 1024) : '—';

      // Success means: role removals succeeded (or there were no staff roles), with no errors.
      const ok = (failedRoles.length === 0 && errors.length === 0);
      const replyColor = ok ? 0x2ECC71 : 0xE74C3C;

      const embed = new EmbedBuilder()
        .setColor(0x8A2BE2)
        .setTitle(title)
        .setDescription(`**User:** <@${id}>`)
        .addFields(
          { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
          { name: 'Reason', value: reason.substring(0, 256), inline: true },
          { name: 'Roles removed', value: `${removedRoles.length}`, inline: true },
          { name: 'Roles failed', value: `${failedRoles.length}`, inline: true },
          { name: 'Role duration', value: durationPreview, inline: false },
          { name: 'Removed (preview)', value: compactRemoved, inline: false },
          { name: 'Failed (preview)', value: compactFailed, inline: false }
        )
        .setTimestamp()
        .setFooter(buildFooter(message.guild));

      if (errors.length) {
        embed.addFields({ name: 'Errors', value: errors.join('\n').substring(0, 1024), inline: false });
      }

      // Send to dedicated destaff log channel
      try {
        const ch = message.guild.channels.cache.get(DESTAFF_LOG_CHANNEL_ID) || await message.guild.channels.fetch(DESTAFF_LOG_CHANNEL_ID).catch(() => null);
        if (ch && isTextLike(ch)) await ch.send({ embeds: [embed] }).catch(() => {});
      } catch (e) {
        console.error('destaff log channel send failed', e);
      }

      // Reply to executor: green if success, else show issues
      const replyEmbed = new EmbedBuilder()
        .setColor(replyColor)
        .setDescription(ok ? '✅ Destaff erfolgreich.' : '❌ Destaff fehlgeschlagen.');

      const issueLines = [];
      if (failedRoles.length) issueLines.push(`Failed roles: ${failedRoles.join(', ')}`);
      if (errors.length) issueLines.push(...errors);
      if (issueLines.length) {
        replyEmbed.addFields({ name: 'Issues', value: issueLines.join('\n').substring(0, 1024), inline: false });
      }

      await message.reply({ embeds: [replyEmbed] }).catch(() => {});
      return;
    }

    if (cmd.toLowerCase() === 'unbll') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('You lack permission to unblacklist users.');
      const id = parseId(rest[0]) || rest[0];
      if (!id || !/^\d+$/.test(id)) return message.reply('Please provide a valid user ID.');

      if (!blacklist || typeof blacklist !== 'object') blacklist = { blacklisted: [] };
      if (!Array.isArray(blacklist.blacklisted)) blacklist.blacklisted = [];

      const idx = blacklist.blacklisted.findIndex(b => String(b.id) === String(id));
      if (idx === -1) return message.reply('This ID is not in the blacklist.');

      blacklist.blacklisted.splice(idx, 1);
      saveJson(BLACKLIST_PATH, blacklist);

      // Unban across the same explicit target guild list as -blacklist
      const targetGuildIds = [
        '1459330497938325676',
        '1459345285317791917',
        '1368527215343435826',
        '1339662600903983154',
      ];

      const unbanAttempts = [];
      for (const gid of targetGuildIds) {
        const g = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
        if (!g) {
          unbanAttempts.push({ guildId: gid, guildName: null, ok: false, note: null, error: 'Bot not in guild / cannot fetch guild' });
          continue;
        }
        try {
          await g.bans.remove(id, `Unblacklisted by ${message.author.tag}`);
          unbanAttempts.push({ guildId: g.id, guildName: g.name, ok: true, note: null });
        } catch (e) {
          const msg = String(e && (e.message || e) || 'failed');
          // If the user isn't banned there, treat as a non-error outcome.
          if ((e && e.code === 10026) || /unknown\s+ban/i.test(msg)) {
            unbanAttempts.push({ guildId: g.id, guildName: g.name, ok: true, note: 'Not banned' });
          } else {
            unbanAttempts.push({ guildId: g.id, guildName: g.name, ok: false, note: null, error: msg });
          }
        }
      }

      const success = unbanAttempts.filter(a => a.ok).length;
      const failed = unbanAttempts.filter(a => !a.ok).length;

      const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('Unblacklist')
        .addFields(
          { name: 'User', value: id, inline: true },
          { name: 'Removed by', value: message.author.tag, inline: true },
          { name: 'Unban success', value: `${success} servers`, inline: true },
          { name: 'Unban failed', value: `${failed} servers`, inline: true }
        )
        .setTimestamp()
        .setFooter(buildFooter(message.guild));

      if (unbanAttempts.length) {
        const lines = unbanAttempts
          .map(a => {
            const base = `${a.ok ? '✅' : '❌'} ${a.guildName || 'Unknown'} (${a.guildId})`;
            if (a.ok && a.note) return `${base} — ${a.note}`;
            if (!a.ok) return `${base} — ${String(a.error || 'failed').substring(0, 80)}`;
            return base;
          })
          .join('\n');
        embed.addFields({ name: 'Unban results', value: lines.substring(0, 1024), inline: false });
      }

      return message.channel.send({ embeds: [embed] });
    }

    if (cmd.toLowerCase() === 'bll') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return message.reply('You lack permission to view blacklist.');

      if (!blacklist.blacklisted.length) return message.reply('Blacklist is empty.');

      const arg = rest[0] ? (parseId(rest[0]) || rest[0]) : null;
      if (arg && /^\d+$/.test(String(arg))) {
        const entry = blacklist.blacklisted.find(b => String(b.id) === String(arg));
        if (!entry) return message.reply('This user is not in the blacklist.');

        const embed = new EmbedBuilder()
          .setTitle('Blacklist Entry')
          .setColor(0x8A2BE2)
          .addFields(
            { name: 'User', value: `<@${entry.id}> (${entry.id})`, inline: true },
            { name: 'Moderator', value: entry.moderator ? `<@${entry.moderator}>` : 'n/a', inline: true },
            { name: 'When', value: entry.time ? `<t:${Math.floor(entry.time / 1000)}:F> (<t:${Math.floor(entry.time / 1000)}:R>)` : 'n/a', inline: false },
            { name: 'Reason', value: String(entry.reason || 'No reason provided').substring(0, 1024), inline: false }
          )
          .setTimestamp()
          .setFooter(buildFooter(message.guild));

        if (Array.isArray(entry.banAttempts) && entry.banAttempts.length) {
          const lines = entry.banAttempts
            .map(a => `${a.ok ? '✅' : '❌'} ${a.guildName || 'Unknown'} (${a.guildId})${a.ok ? '' : ` — ${String(a.error || 'failed').substring(0, 80)}`}`)
            .join('\n');
          embed.addFields({ name: 'Last ban results', value: lines.substring(0, 1024), inline: false });
        }

        return message.channel.send({ embeds: [embed] });
      }

      const embed = new EmbedBuilder()
        .setTitle('Blacklist Logs')
        .setColor(0x8A2BE2)
        .setFooter({ text: `Total: ${blacklist.blacklisted.length}` })
        .setTimestamp();

      for (const b of blacklist.blacklisted.slice(0, 10)) {
        const moderator = b.moderator ? `<@${b.moderator}>` : 'n/a';
        const reason = b.reason || 'No reason provided';
        embed.addFields({
          name: `User: ${b.id}`,
          value: `Mod: ${moderator}\nWhen: ${b.time ? `<t:${Math.floor(b.time / 1000)}:R>` : 'n/a'}\nReason: ${String(reason).substring(0, 256)}`.substring(0, 1024)
        });
      }

      if (blacklist.blacklisted.length > 10) {
        embed.setDescription(`Showing first 10 of ${blacklist.blacklisted.length} entries.`);
      }

      return message.channel.send({ embeds: [embed] });
    }
  }

  // Log blacklist action to configured channel
  if (message.content.startsWith('-') && message.content.slice(1).trim().split(/\s+/)[0].toLowerCase() === 'blacklist') {
    try {
      const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
      if (message.guild && cfg.logChannelId) {
        const logCh = message.guild.channels.cache.get(cfg.logChannelId);
          if (logCh && isTextLike(logCh)) {
          const embed = new EmbedBuilder().setTitle('Blacklist updated').setColor(0x8A2BE2)
            .setDescription(`ID blacklisted by ${message.author.tag}`)
            .addFields({ name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true });
          await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
        }
      }
    } catch (e) { console.error('blacklist log failed', e); }
  }

  // Admin modlog edits via * commands
  if (message.content.startsWith('*')) {
    const [cmd, ...rest] = message.content.slice(1).trim().split(/\s+/);
    if (!cmd) return;
    // Permission: require ManageGuild
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return message.reply('You lack permission to edit modlogs.');

    if (cmd.toLowerCase() === 'reason') {
      const caseId = parseInt(rest[0], 10);
      const newReason = rest.slice(1).join(' ');
      if (!caseId || !newReason) return message.reply('Usage: *reason <caseId> <new reason>');
      const c = modlogs.cases.find(x => Number(x.caseId) === Number(caseId));
      if (!c) return message.reply(`Case ${caseId} not found.`);
      c.reason = newReason;
      saveJson(MODLOGS_PATH, modlogs);
      // notify user if possible
      try {
        if (c.user) {
          const u = await client.users.fetch(String(c.user)).catch(() => null);
          if (u) await sendModEmbedToUser(u, `${c.type} - Reason Updated`, { guild: message.guild, moderatorTag: message.author.tag, reason: `Updated reason: ${newReason}`, caseId: c.caseId });
        }
      } catch (e) {}
      return message.channel.send({ embeds: [createChannelConfirmEmbed(`Updated reason for case ${caseId}`, caseId)] });
    }

    if (cmd.toLowerCase() === 'duration') {
      const caseId = parseInt(rest[0], 10);
      const durStr = rest.slice(1).join(' ');
      if (!caseId || !durStr) return message.reply('Usage: *duration <caseId> <duration> (e.g. 3d, 2h30m, 15m)');
      const ms = parseDurationToMs(durStr);
      if (ms === null) return message.reply('Invalid duration format. Use e.g. 3d, 2h30m, 15m');
      const c = modlogs.cases.find(x => Number(x.caseId) === Number(caseId));
      if (!c) return message.reply(`Case ${caseId} not found.`);
      c.durationMs = ms;
      // update reason for mutes for clarity
      if (c.type && c.type.toLowerCase() === 'mute') {
        c.reason = `Timeout ${humanDuration(ms)}`;
      }
      saveJson(MODLOGS_PATH, modlogs);
      try {
        if (c.user) {
          const u = await client.users.fetch(String(c.user)).catch(() => null);
          if (u) await sendModEmbedToUser(u, `${c.type} - Duration Updated`, { guild: message.guild, moderatorTag: message.author.tag, reason: `Duration changed to ${humanDuration(ms)}`, caseId: c.caseId });
        }
      } catch (e) {}
      return message.channel.send({ embeds: [createChannelConfirmEmbed(`Updated duration for case ${caseId} to ${humanDuration(ms)}`, caseId)] });
    }

    if (cmd.toLowerCase() === 'moderations') {
      const userId = rest[0];
      if (!userId) return message.reply('Usage: *moderations <userId>');
      const userCases = modlogs.cases.filter(c => String(c.user) === String(userId));
      if (userCases.length === 0) return message.reply(`No moderations found for user ${userId}.`);
      
      const embed = new EmbedBuilder()
        .setTitle(`📊 Moderations for ${userId}`)
        .setColor(0x8A2BE2)
        .setDescription(`Total: **${userCases.length}** moderation(s)`)
        .addFields(
          userCases.map(c => ({
            name: `Case #${c.caseId} — ${c.type}`,
            value: `**Reason:** ${c.reason}\n**Moderator:** <@${c.moderator}>\n**Date:** <t:${Math.floor(c.time / 1000)}:f>`,
            inline: false
          }))
        )
        .setTimestamp();
      
      return message.channel.send({ embeds: [embed] });
    }

    if (cmd.toLowerCase() === 'case') {
      const caseId = parseInt(rest[0], 10);
      if (!caseId) return message.reply('Usage: *case <caseId>');
      const c = modlogs.cases.find(x => Number(x.caseId) === Number(caseId));
      if (!c) return message.reply(`Case ${caseId} not found.`);
      
      const embed = new EmbedBuilder()
        .setTitle(`📋 Case #${c.caseId}`)
        .setColor(0x8A2BE2)
        .addFields(
          { name: 'Type', value: c.type, inline: true },
          { name: 'User', value: `<@${c.user}> (${c.user})`, inline: true },
          { name: 'Moderator', value: `<@${c.moderator}>`, inline: true },
          { name: 'Reason', value: c.reason, inline: false },
          { name: 'Date', value: `<t:${Math.floor(c.time / 1000)}:f>`, inline: true }
        );
      
      if (c.durationMs) {
        embed.addFields({ name: 'Duration', value: humanDuration(c.durationMs), inline: true });
      }
      
      embed.setTimestamp();
      
      return message.channel.send({ embeds: [embed] });
    }
  }

  if (!message.content.startsWith(PREFIX)) return;
  const [raw, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = raw.toLowerCase();

  // Intentionally do not log every command execution (e.g. !say).
  // Moderation commands create their own dedicated moderation logs.

  // Help command: list available commands in the usual embed style
  if (command === 'help' || command === 'h') {
    const helpEmbed = new EmbedBuilder()
      .setTitle('📋 CYBRANCEE — Bot Commands')
      .setColor(0x8A2BE2)
      .setDescription('Here is a complete list of all available commands:')
      .setTimestamp();

    helpEmbed.addFields(
      { name: '📋 General', value: '`!help` — Show this help message\n`!say <text>` — Bot repeats your message\n`!rules` — Show server rules', inline: false },
      { name: '🔗 Invite', value: '`!invite` — Get bot invite link', inline: false },
      { name: '🎫 Tickets', value: '`!ticket` — Create a support ticket\n`!close` — Close a ticket (staff only)', inline: false },
      { name: '⚖️ Moderation', value: '`!warn <user> [reason]` — Warn a user\n`!ban <user> [reason]` — Ban a user\n`!unban <id>` — Unban a user\n`!mute <user> <minutes>` — Timeout a user\n`!unmute <user>` — Remove timeout\n`!role <user> <role>` — Assign role to user', inline: false },
      { name: '📊 Logs & History', value: '`!md <user> [page]` — Show modlogs (5/page)\n`!mds <user> [page]` — Show destaff logs (8/page)', inline: false },
      { name: '🗑️ Cleanup & Management', value: '`-purg <count> [user]` — Purge messages\n`!del <channel>` — Delete a channel (confirmation required)', inline: false },
      { name: '🚫 Blacklist', value: '`-blacklist <id> [reason]` — Add to blacklist\n`-unbll <id>` — Remove from blacklist\n`-bll` — View blacklist logs', inline: false },
      { name: '👥 Destaff', value: '`-destaff <user> [reason]` — Remove staff roles', inline: false },
      { name: '✏️ Modlog Editing', value: '`*reason <caseId> <text>` — Update case reason\n`*duration <caseId> <time>` — Update case duration\n`*moderations <userId>` — Show all moderations for user\n`*case <caseId>` — Show details of a specific case', inline: false },
      { name: '🎮 Fun Commands', value: '`!8ball` — Magic 8Ball\n`!flip` — Coin flip\n`!dice [1-100]` — Roll dice\n`!rate [@user]` — Rate someone\n`!joke` — Dev jokes\n`!compliment [@user]` — Give compliments', inline: false }
    );

    helpEmbed.setFooter({ text: 'Use PREFIX ! for most commands, - for special commands, * for edits' });
    
    message.delete().catch(() => {});
    return message.channel.send({ embeds: [helpEmbed] });
  }

  // Invite command: provide OAuth2 bot invite link
  if (command === 'invite') {
    const clientId = client.user && client.user.id ? String(client.user.id) : null;
    if (!clientId) return message.reply('Bot not ready yet. Try again in a few seconds.');

    const scopes = 'bot%20applications.commands';
    const recommendedPerms = new PermissionsBitField([
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.EmbedLinks,
      PermissionsBitField.Flags.AttachFiles,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.ManageMessages,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.ModerateMembers,
      PermissionsBitField.Flags.BanMembers,
      PermissionsBitField.Flags.ViewAuditLog,
    ]).bitfield.toString();

    const adminPerms = '8';
    const inviteRecommended = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${recommendedPerms}&scope=${scopes}`;
    const inviteAdmin = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${adminPerms}&scope=${scopes}`;

    const embed = new EmbedBuilder()
      .setTitle('🔗 Invite this bot')
      .setColor(0x8A2BE2)
      .setDescription('Use one of the links below to add the bot to a server. You need **Manage Server** permission in the target server.')
      .addFields(
        { name: 'Recommended permissions', value: inviteRecommended.substring(0, 1024), inline: false },
        { name: 'Admin (not recommended)', value: inviteAdmin.substring(0, 1024), inline: false },
        { name: 'Client ID', value: clientId, inline: true },
        { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true }
      )
      .setTimestamp();

    return message.channel.send({ embeds: [embed] });
  }

  // Rules command
  if (command === 'rules') {
    const rulesEmbed = new EmbedBuilder()
      .setTitle('📜 SERVER-REGELN')
      .setColor(0x8A2BE2)
      .setDescription('Bitte beachte folgende Regeln für ein angenehmes Miteinander:')
      .addFields(
        { name: '1️⃣ Respekt', value: 'Behandle jeden mit Respekt – keine Beleidigungen, Provokationen oder Diskriminierung.\nKein Mobbing oder toxisches Verhalten.', inline: false },
        { name: '2️⃣ Chat-Verhalten', value: 'Kein Spam, Flooding oder Capslock-Spam.\nKeine Werbung ohne Erlaubnis.\nKeine NSFW-, Rassismus-, Gewalt- oder sonstig unangebrachten Inhalte.', inline: false },
        { name: '3️⃣ Namen & Profilbilder', value: 'Keine beleidigenden, sexuell anstößigen oder irreführenden Namen/Bilder.\nNachahmung von Teammitgliedern ist verboten.', inline: false },
        { name: '4️⃣ Voice-Chats', value: 'Kein Schreien, Stören oder Soundboard-Spam.\nMusikbots nur in den vorgesehenen Channels.', inline: false },
        { name: '5️⃣ Team & Entscheidungen', value: 'Folge den Anweisungen des Teams.\nDiskussionen über Verwarnungen oder Bans bitte privat mit einem Moderator führen.', inline: false }
      )
      .setFooter({ text: 'Vielen Dank für dein Verständnis! 🙏' })
      .setTimestamp();

    message.delete().catch(() => {});
    return message.channel.send({ embeds: [rulesEmbed] });
  }

  // 8ball command
  if (command === '8ball') {
    const responses = [
      '✅ Ja, definitiv!', '❌ Nein, unmöglich.', '🤔 Vielleicht...', '✨ Die Chancen sind gut!',
      '💫 Sieht schlecht aus.', '🎯 Sehr wahrscheinlich!', '🚫 Frag lieber nicht.', '🌟 Absolut!',
      '❓ Das ist unklar.', '💯 100% Ja!', '😅 Eher nicht.', '🎪 Niemals!', '⚡ Warte und sieh!',
      '👀 Konzentriere dich und frag erneut.', '🔮 Deutet darauf hin, ja.'
    ];
    const response = responses[Math.floor(Math.random() * responses.length)];
    const embed = new EmbedBuilder()
      .setTitle('🔮 Magic 8Ball')
      .setDescription(response)
      .setColor(0xFF6B6B)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Coin flip command
  if (command === 'flip') {
    const result = Math.random() < 0.5 ? '🪙 Kopf!' : '🪙 Zahl!';
    const embed = new EmbedBuilder()
      .setTitle('Münzwurf')
      .setDescription(result)
      .setColor(0xFFD700)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Dice roll command
  if (command === 'dice' || command === 'roll') {
    const dice = parseInt(args[0]) || 6;
    if (dice < 1 || dice > 100) return message.reply('Würfel-Bereich: 1-100');
    const result = Math.floor(Math.random() * dice) + 1;
    const embed = new EmbedBuilder()
      .setTitle(`🎲 Würfel (1-${dice})`)
      .setDescription(`**Ergebnis: ${result}**`)
      .setColor(0x4ECDC4)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Session announcements (message-based wrappers for /sa and /sb)
  if (command === 'sa' || command === 'sb' || command === 'shelp' || command === 'beta' || command === 'alpha') {
    try {
      const saCmd = require('./commands/sa.js');

      if (command === 'shelp') {
        return message.reply('Usage: !sa <regHH:MM> <gameHH:MM> [mode=beta|alpha] — Use !sb for beta-only (shortcut).');
      }

      // Map aliases
      const mode = command === 'sb' ? 'beta' : (command === 'alpha' ? 'alpha' : (args[2] ? String(args[2]).toLowerCase() : 'beta'));
      const regRaw = args[0];
      const gameRaw = args[1];
      if (!regRaw || !gameRaw) return message.reply('Usage: !sa <regHH:MM> <gameHH:MM> [mode]');

      const reg = saCmd.parseHHMM(regRaw);
      const game = saCmd.parseHHMM(gameRaw);
      if (!reg) return message.reply('Invalid `reg` time. Use `HH:MM`.');
      if (!game) return message.reply('Invalid `game` time. Use `HH:MM`.');

      const now = new Date();
      const regTs = saCmd.resolveNextTimestampSeconds(reg.hh, reg.mm, now);
      let gameTs = saCmd.resolveNextTimestampSeconds(game.hh, game.mm, now);
      if (gameTs <= regTs) gameTs = gameTs + 86400;

      const content = saCmd.buildAnnouncement({ mode, regTs, gameTs, staffMentions: '@staff', includeEveryone: false });
      const sent = await message.channel.send({ content, allowedMentions: { parse: ['roles', 'users'], roles: [], users: [] } }).catch(()=>null);
      if (!sent) return message.reply('Konnte die Ankündigung nicht senden (fehlende Berechtigung?).');
      return message.reply(`✅ Posted: ${sent.url}`);
    } catch (e) {
      console.error('session command failed', e);
      return message.reply('Fehler beim Ausführen des Session-Befehls.');
    }
  }

  // Rate command
  if (command === 'rate') {
    const target = message.mentions.members.first() || message.author;
    const rating = Math.floor(Math.random() * 101);
    const emoji = rating >= 80 ? '🌟' : rating >= 60 ? '👍' : rating >= 40 ? '😐' : '💔';
    const embed = new EmbedBuilder()
      .setTitle('⭐ Rating-System')
      .setDescription(`${target} bekommt eine Bewertung von **${rating}/100** ${emoji}`)
      .setColor(0xFF69B4)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Joke command
  if (command === 'joke') {
    const jokes = [
      'Warum sind Programmier so schlecht im Geschlechtsverkehr?\nWeil sie nur in 0 und 1 denken können!',
      'Ein SQL-Query geht in eine Bar, trifft zwei Tabellen und fragt: "Darf ich mich zu euch setzen?"',
      'Wie viele Programmierer braucht man zum Glühbirnenwechsel? Keine, das ist ein Hardware-Problem!',
      'Ein Byte geht zum Psychotherapeuten: "Ich fühle mich in Bits zerlegt!"',
      'Warum verlässt Perl seinen Partner? Weil da immer mehrere Wege zum Ziel führen!',
      'Ein Developer liest einer Frau im Schlaf etwas vor... Sie sagt: "Das ist ja langweilig!" Er: "Ist es, aber der Code ist elegant!"',
      'Wie heißt der Schüler des Lehrers? Stack Overflow!'
    ];
    const joke = jokes[Math.floor(Math.random() * jokes.length)];
    const embed = new EmbedBuilder()
      .setTitle('😂 Dev-Witz')
      .setDescription(joke)
      .setColor(0xFFB700)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Compliment command
  if (command === 'compliment') {
    const compliments = [
      'Du bist wirklich inspirierend!', 'Dein Lächeln ist ansteckend!', 'Du bist ein großartiger Freund!',
      'Du machst die Welt besser!', 'Deine Kreativität ist beeindruckend!', 'Du hast ein goldenes Herz!',
      'Du bist eine echte Inspiration!', 'Deine Intelligenz beeindruckt mich!', 'Du schaffst Großartiges!',
      'Deine Freundlichkeit ist bewunderungswürdig!', 'Du bist einfach wunderbar!', 'Die Welt braucht mehr Menschen wie dich!'
    ];
    const compliment = compliments[Math.floor(Math.random() * compliments.length)];
    const target = message.mentions.members.first() || message.author;
    const embed = new EmbedBuilder()
      .setTitle('💝 Kompliment')
      .setDescription(`${target}, ${compliment}`)
      .setColor(0xFF1493)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Modlogs pagination command: !md <user|id> [page]
  if (command === 'md' || command === 'modlogs') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return message.reply('You lack permission to view modlogs.');
    }
    const userArg = args[0];
    const pageArg = parseInt(args[1], 10) || 1;
    if (!userArg) return message.reply('Usage: !md <user|id> [page]');

    const targetId = parseId(userArg) || userArg.replace(/[<@!>]/g, '');
    if (!targetId || !/^\d+$/.test(targetId)) return message.reply('Provide a valid user ID or mention.');

    const itemsPerPage = 5;
    const allCases = modlogs.cases
      .filter(c => String(c.user) === String(targetId))
      .sort((a, b) => (b.time || 0) - (a.time || 0));

    if (!allCases.length) return message.reply('Keine Modlogs für diesen User gefunden.');

    const totalPages = Math.max(1, Math.ceil(allCases.length / itemsPerPage));
    const page = Math.max(1, Math.min(totalPages, pageArg));
    const slice = allCases.slice((page - 1) * itemsPerPage, page * itemsPerPage);

    let userTag = targetId;
    try {
      const u = await client.users.fetch(targetId).catch(() => null);
      if (u) userTag = u.tag;
    } catch (e) {}

    const embed = new EmbedBuilder()
      .setTitle(`Modlogs for ${userTag}`)
      .setColor(0x8A2BE2)
      .setFooter({ text: `Page ${page}/${totalPages}| Total Logs: ${allCases.length} | ${targetId}` });

    for (const c of slice) {
      const when = c.time ? formatHammertime(c.time) : 'n/a';

      let moderatorLabel = 'Unknown Moderator';
      if (c.moderator) {
        try {
          const mu = await client.users.fetch(String(c.moderator)).catch(() => null);
          moderatorLabel = mu ? `${mu.tag} (${mu.id})` : `Unknown Moderator (${c.moderator})`;
        } catch (e) {
          moderatorLabel = `Unknown Moderator (${c.moderator})`;
        }
      }

      const type = c.type || 'Case';
      const dur = c.durationMs ? ` (${humanDurationLong(c.durationMs)})` : '';
      const reason = c.reason || 'No reason provided';

      embed.addFields({
        name: `Case ${c.caseId}`,
        value: `Type: ${type}${dur}\nModerator: ${moderatorLabel}\nReason: ${reason} - ${when}`.substring(0, 1024)
      });
    }

    return message.channel.send({ embeds: [embed] });
  }

  // Destaff logs pagination command: !mds <user|id> [page]
  if (command === 'mds') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return message.reply('You lack permission to view destaff logs.');
    }
    const userArg = args[0];
    const pageArg = parseInt(args[1], 10) || 1;
    if (!userArg) return message.reply('Usage: !mds <user|id> [page]');

    const targetId = parseId(userArg) || userArg.replace(/[<@!>]/g, '');
    if (!targetId || !/^\d+$/.test(targetId)) return message.reply('Provide a valid user ID or mention.');

    const itemsPerPage = 8;
    const allCases = destaffs.cases
      .filter(c => String(c.user) === String(targetId))
      .sort((a, b) => (b.time || 0) - (a.time || 0));

    if (!allCases.length) return message.reply('Keine Destaff-Logs für diesen User gefunden.');

    const totalPages = Math.max(1, Math.ceil(allCases.length / itemsPerPage));
    const page = Math.max(1, Math.min(totalPages, pageArg));
    const slice = allCases.slice((page - 1) * itemsPerPage, page * itemsPerPage);

    const embed = new EmbedBuilder()
      .setTitle(`Destaff Logs — ${targetId}`)
      .setColor(0x8A2BE2)
      .setFooter({ text: `Page ${page}/${totalPages} • Total: ${allCases.length}` })
      .setTimestamp();

    for (const c of slice) {
      const when = c.time ? new Date(c.time).toLocaleString() : 'n/a';
      const moderator = c.moderator ? `<@${c.moderator}> (${c.moderator})` : 'n/a';
      const reason = c.reason || 'No reason provided';
      const removed = c.removedRoles && c.removedRoles.length ? c.removedRoles.join(', ').substring(0, 200) : 'None';
      const failed = c.failedRoles && c.failedRoles.length ? c.failedRoles.join(', ').substring(0, 200) : 'None';
      embed.addFields({
        name: `Case #${c.caseId} — ${c.type || 'Unknown'}`,
        value: `User: <@${c.user}>\nMod: ${moderator}\nWhen: ${when}\nRemoved: ${removed}\nFailed: ${failed}\nReason: ${reason}`.substring(0, 1024)
      });
    }

    return message.channel.send({ embeds: [embed] });
  }

  // Say command: bot repeats provided message (no mention pings)
  if (command === 'say') {
    const text = args.join(' ').trim();
    if (!text) return message.reply('Usage: !say <message>');
    try {
      message.delete().catch(() => {});
      await message.channel.send({ content: text, allowedMentions: { parse: [] } });
    } catch (e) {
      console.error('say command failed', e);
      return message.reply('Failed to send message.');
    }
    return;
  }

  // Moderator/Staff command to close a ticket: must be used in a ticket channel
  if (command === 'close') {
    if (!message.guild) return message.reply('Dieses Kommando muss in einem Server verwendet werden.');
    const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
    const member = message.member;
    let staffRoleId = cfg.staffRoleId ? String(cfg.staffRoleId).replace(/[<@&>]/g, '') : null;
    if (!staffRoleId && message.guild) {
      const byName = message.guild.roles.cache.find(r => isStaffLikeRoleName(r && r.name));
      if (byName) staffRoleId = byName.id;
    }
    const isStaff = (staffRoleId && member.roles.cache.has(staffRoleId)) || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
    if (!isStaff) return message.reply('Nur Moderatoren oder Server-Admins können dieses Kommando verwenden.');

    const channel = message.channel;
    if (!channel || !channel.topic || !channel.topic.startsWith('ticket:')) return message.reply('Dieses Kommando funktioniert nur in Ticket-Kanälen.');

    const parts = channel.topic.split(':');
    const ownerId = parts[1];
    const reason = args.join(' ') || `Geschlossen durch ${message.author.tag}`;

    try {
      // create transcript
      const folder = path.join(DATA_DIR, cfg.transcriptFolder || 'transcripts');
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
      const { txtPath, htmlPath } = await createTranscript(channel, folder).catch(()=>({ txtPath: null, htmlPath: null }));

      // send transcript to log
      try {
        if (cfg.logChannelId) {
          const logCh = message.guild.channels.cache.get(cfg.logChannelId);
          if (logCh) await sendLog(message.guild, { embeds: [new EmbedBuilder().setTitle('Ticket geschlossen').setDescription(`Ticket ${channel.name} geschlossen von <@${message.author.id}>\nGrund: ${reason}`)], files: [txtPath].filter(Boolean) });
        }
      } catch (e) { console.error('failed to send transcript to log channel', e); }

      // DM owner
      try { const owner = await client.users.fetch(ownerId).catch(()=>null); if (owner) await owner.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setTitle('Dein Ticket wurde geschlossen').setDescription(`Grund: ${reason}`)], files: [txtPath].filter(Boolean) }).catch(()=>{}); } catch (e) {}

      // remove only this ticket channel (keep shared category)
      try {
        await channel.delete().catch(()=>{});
      } catch (e) { console.error('failed to remove ticket channels/category', e); }

      return message.channel.send('Ticket geschlossen und entfernt.');
    } catch (e) {
      console.error('close command failed', e);
      return message.reply('Fehler beim Schließen des Tickets.');
    }
  }

  // Helper to resolve a user by mention or id
  async function resolveUser(arg) {
    const id = parseId(arg) || arg;
    if (!id) return null;
    try {
      // Try fetch from guild members first
      if (message.guild) {
        const member = await message.guild.members.fetch(id).catch(() => null);
        if (member) return member.user;
      }
      // Fallback fetch global user
      return await client.users.fetch(id).catch(() => null);
    } catch (e) {
      return null;
    }
  }

  if (command === 'warn') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return message.reply('You lack permission to warn members.');
    const targetArg = args[0];
    const reason = args.slice(1).join(' ') || 'No reason provided';
    const targetUser = await resolveUser(targetArg);
    if (!targetUser) return message.reply('User not found. Use mention or ID.');

    const caseId = nextCase();
    // Record modlog
    modlogs.cases.push({ caseId, type: 'Warn', user: targetUser.id, moderator: message.author.id, reason, time: Date.now() });
    saveJson(MODLOGS_PATH, modlogs);

    // DM the user
    await sendModEmbedToUser(targetUser, 'Warn', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId });

    try {
      const nowTs = Math.floor(Date.now() / 1000);
      const embed = buildSmallModerationEmbed({
        title: 'Nutzer verwarnt',
        targetId: targetUser.id,
        targetAvatarUrl: targetUser.displayAvatarURL({ extension: 'png', size: 256 }),
        moderatorId: message.author.id,
        reason,
        caseId,
        nowTs
      });
      await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
    } catch (e) { console.error('warn log failed', e); }

    const text = `User ${targetUser.tag} (${targetUser.id}) was warned. | ${reason}`;

    return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId)] });
  }

  if (command === 'ban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('You lack permission to ban members.');
    const targetArg = args[0];
    const reason = args.slice(1).join(' ') || 'No reason provided';
    const id = parseId(targetArg) || targetArg;
    if (!id) return message.reply('Please provide a mention or user ID to ban.');

    const caseId = nextCase();
    modlogs.cases.push({ caseId, type: 'Ban', user: id, moderator: message.author.id, reason, time: Date.now() });
    saveJson(MODLOGS_PATH, modlogs);

    // Try DM before ban
    try {
      const user = await client.users.fetch(id).catch(() => null);
      if (user) await sendModEmbedToUser(user, 'Ban', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId });
    } catch (e) {}

    // Ban in guild
    try {
      await message.guild.members.ban(id, { reason: `${message.author.tag}: ${reason}` });
      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const targetUser = await client.users.fetch(id).catch(() => null);
        const embed = buildSmallModerationEmbed({
          title: 'Nutzer gebannt',
          targetId: id,
          targetAvatarUrl: targetUser ? targetUser.displayAvatarURL({ extension: 'png', size: 256 }) : null,
          moderatorId: message.author.id,
          reason,
          caseId,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
      } catch (e) { console.error('ban log failed', e); }

      const text = `User ${id} was banned. | ${reason}`;
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId)] });
    } catch (e) {
      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const targetUser = await client.users.fetch(id).catch(() => null);
        const embed = buildSmallModerationEmbed({
          title: 'Ban fehlgeschlagen',
          targetId: id,
          targetAvatarUrl: targetUser ? targetUser.displayAvatarURL({ extension: 'png', size: 256 }) : null,
          moderatorId: message.author.id,
          reason: String(e.message || e),
          caseId,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
      } catch (err) { console.error('ban failure log failed', err); }
      return message.reply('Failed to ban user — maybe invalid ID or lack of permissions.');
    }
  }

  if (command === 'unban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('You lack permission to unban members.');
    const id = args[0];
    const reason = args.slice(1).join(' ').trim() || 'No reason provided';
    if (!id || !/^\d+$/.test(id)) return message.reply('Please provide a valid user ID to unban.');
    try {
      await message.guild.bans.remove(id, `${message.author.tag}: ${reason}`);
      const caseId = nextCase();
      modlogs.cases.push({ caseId, type: 'Unban', user: id, moderator: message.author.id, reason, time: Date.now() });
      saveJson(MODLOGS_PATH, modlogs);

      // DM the user if possible
      const user = await client.users.fetch(id).catch(() => null);
      if (user) await sendModEmbedToUser(user, 'Unban', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId });

      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const targetUser = await client.users.fetch(id).catch(() => null);
        const embed = buildSmallModerationEmbed({
          title: 'Nutzer entbannt',
          targetId: id,
          targetAvatarUrl: targetUser ? targetUser.displayAvatarURL({ extension: 'png', size: 256 }) : null,
          moderatorId: message.author.id,
          reason,
          caseId,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
      } catch (e) { console.error('unban log failed', e); }

      const text = `User ${id} was unbanned.`;
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId)] });
    } catch (e) {
      try {
        const embed = new EmbedBuilder().setTitle('Unban failed').setColor(0xE74C3C)
          .addFields(
            { name: 'Target', value: `${id}`, inline: true },
            { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
            { name: 'Error', value: `${String(e.message || e)}`, inline: false }
          ).setTimestamp();
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
      } catch (err) { console.error('unban failure log failed', err); }
      return message.reply('Failed to unban — check the ID and that the user is banned.');
    }
  }

  if (command === 'mute') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('You lack permission to mute (timeout) members.');
    const targetArg = args[0];
    const minutesArg = args[1] || '1';
    const minutes = parseInt(minutesArg.replace(/[^0-9]/g, '')) || 1;
    const reason = args.slice(2).join(' ').trim() || 'No reason provided';
    const duration = minutes * 60 * 1000;
    const member = await message.guild.members.fetch(parseId(targetArg) || targetArg).catch(() => null);
    if (!member) return message.reply('Member not found.');

    try {
      await member.timeout(duration, `${message.author.tag}: ${reason}`);
      const caseId = nextCase();
      modlogs.cases.push({ caseId, type: 'Mute', user: member.id, moderator: message.author.id, reason, durationMs: duration, time: Date.now() });
      saveJson(MODLOGS_PATH, modlogs);

      // DM user
      await sendModEmbedToUser(member.user, 'Mute', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId, durationText: `${minutes} minutes` });

      const text = `User ${member.user.tag} was muted for ${minutes} minutes.`;
      // log mute
      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const embed = buildSmallModerationEmbed({
          title: 'Nutzer getimeoutet',
          targetId: member.id,
          targetAvatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
          moderatorId: message.author.id,
          reason,
          caseId,
          durationText: `${minutes} Minuten`,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
      } catch (e) { console.error('mute log failed', e); }

      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId)] });
    } catch (e) {
      try {
        const embed = new EmbedBuilder().setTitle('Mute failed').setColor(0xF39C12)
          .addFields(
            { name: 'Target', value: `${member ? (member.user.tag + ` (${member.id})`) : String(args[0]||'unknown')}`, inline: true },
            { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
            { name: 'Duration', value: `${minutes} minutes`, inline: true },
            { name: 'Error', value: `${String(e.message || e)}`, inline: false }
          ).setTimestamp();
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
      } catch (err) { console.error('mute failure log failed', err); }
      return message.reply('Failed to mute the member — missing permissions or hierarchy issue.');
    }
  }

  if (command === 'unmute') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('You lack permission to unmute (remove timeout).');
    const targetArg = args[0];
    const reason = args.slice(1).join(' ').trim() || 'No reason provided';
    const member = await message.guild.members.fetch(parseId(targetArg) || targetArg).catch(() => null);
    if (!member) return message.reply('Member not found.');

    try {
      await member.timeout(null, `${message.author.tag}: ${reason}`);
      const caseId = nextCase();
      modlogs.cases.push({ caseId, type: 'Unmute', user: member.id, moderator: message.author.id, reason, time: Date.now() });
      saveJson(MODLOGS_PATH, modlogs);

      await sendModEmbedToUser(member.user, 'Unmute', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId });

      const text = `User ${member.user.tag} was unmuted.`;
      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const embed = buildSmallModerationEmbed({
          title: 'Timeout entfernt',
          targetId: member.id,
          targetAvatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
          moderatorId: message.author.id,
          reason,
          caseId,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
      } catch (e) { console.error('unmute log failed', e); }

      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId)] });
    } catch (e) {
      try {
        const embed = new EmbedBuilder().setTitle('Unmute failed').setColor(0xE74C3C)
          .addFields(
            { name: 'Target', value: `${member ? (member.user.tag + ` (${member.id})`) : String(args[0]||'unknown')}`, inline: true },
            { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
            { name: 'Error', value: `${String(e.message || e)}`, inline: false }
          ).setTimestamp();
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
      } catch (err) { console.error('unmute failure log failed', err); }
      return message.reply('Failed to unmute the member.');
    }
  }



  // Fun / Christmas commands
  const SANTA_PATH = path.join(DATA_DIR, 'santa_list.json');
  const ADVENT_PATH = path.join(DATA_DIR, 'advent.json');
  let santaList = loadJson(SANTA_PATH, {});
  let advent = loadJson(ADVENT_PATH, {});

  if (command === 'santa') {
    const sub = args[0] ? args[0].toLowerCase() : 'help';
    if (sub === 'help') return message.reply('Usage: !santa check <user>|nice <user>|naughty <user>|list');
    if (sub === 'list') {
      const entries = Object.entries(santaList);
      if (!entries.length) return message.reply('Santa has no entries yet.');
      const embed = new EmbedBuilder().setColor(0x8A2BE2).setTitle('Santa List');
      entries.slice(0,25).forEach(([id, v]) => embed.addFields({ name: `${v.status.toUpperCase()}`, value: `<@${id}> — ${v.note||'—'}` }));
      return message.channel.send({ embeds: [embed] });
    }
    if (['check','nice','naughty'].includes(sub)) {
      const targetArg = args[1];
      const id = parseId(targetArg) || targetArg || message.author.id;
      if (!id || !/^\d+$/.test(id)) return message.reply('Provide a valid user mention or ID.');
      if (sub === 'check') {
        if (!santaList[id]) {
          const status = Math.random() < 0.6 ? 'nice' : 'naughty';
          santaList[id] = { status, note: '' };
          saveJson(SANTA_PATH, santaList);
        }
        const e = new EmbedBuilder().setColor(0x8A2BE2).setTitle(`Santa check for ${id}`).setDescription(`Status: **${santaList[id].status.toUpperCase()}**`);
        return message.channel.send({ embeds: [e] });
      } else {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return message.reply('Only server managers can set statuses.');
        const status = sub === 'nice' ? 'nice' : 'naughty';
        const note = args.slice(2).join(' ') || '';
        santaList[id] = { status, note };
        saveJson(SANTA_PATH, santaList);
        return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setDescription(`Set <@${id}> to **${status.toUpperCase()}**${note?` — ${note}`:''}`)] });
      }
    }
    return message.reply('Unknown subcommand for !santa');
  }

  if (command === 'gift') {
    const targetArg = args[0];
    const id = parseId(targetArg) || targetArg || null;
    if (!id) return message.reply('Usage: !gift <user mention|id> [message]');
    const gifts = ['A cozy blanket','A box of cookies','A mysterious present','A warm hug emoji','A virtual snow globe'];
    const gift = gifts[Math.floor(Math.random()*gifts.length)];
    const note = args.slice(1).join(' ') || 'Happy Holidays!';
    // DM recipient
    const who = await resolveUser(id).catch(()=>null);
    const embed = new EmbedBuilder().setColor(0x87CEFA).setTitle('You received a gift!').addFields({ name: 'Gift', value: gift }, { name: 'Message', value: note });
    if (who) { try { await who.send({ embeds: [embed] }); } catch(e){} }
    return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setDescription(`Gave **${gift}** to <@${id}> — ${note}`)] });
  }

  if (command === 'snow') {
    let count = parseInt(args[0],10) || 10; if (count < 1) count = 1; if (count > 30) count = 30;
    const lines = [];
    for (let i=0;i<count;i++) lines.push(' '.repeat((i*3)%20) + '❄️'.repeat(Math.max(1, (i%5)+1)));
    return message.channel.send(lines.join('\n'));
  }

  if (command === 'joke') {
    const jokes = [
      'Why did Santa go to music school? To improve his wrapping skills!',
      'What do snowmen eat for breakfast? Frosted Flakes!',
      'Why was the Christmas tree bad at knitting? Too many needles.'
    ];
    return message.channel.send(jokes[Math.floor(Math.random()*jokes.length)]);
  }

  if (command === 'advent') {
    const sub = args[0] ? args[0].toLowerCase() : 'today';
    const day = new Date().getDate();
    if (sub === 'open') {
      const which = parseInt(args[1],10) || day;
      if (which < 1 || which > 25) return message.reply('Open days 1–25.');
      if (advent[which]) return message.reply(`Day ${which} already opened.`);
      const prizes = ['Candy cane','Hot chocolate','Gift card','Snowflake sticker','Silent night playlist'];
      const prize = prizes[which % prizes.length];
      advent[which] = { prize, time: Date.now() };
      saveJson(ADVENT_PATH, advent);
      return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setTitle(`Advent Day ${which}`).setDescription(`You found: **${prize}**`)] });
    }
    // default: show today
    return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setTitle(`Advent Today — Day ${day}`).setDescription('Use `!advent open <day>` to open a door!')] });
  }

  // Voice / Music commands
  if (command === 'join') {
    // optional channel arg
    let targetChannel = null;
    if (args[0]) {
      const chId = args[0].replace(/[<#>]/g, '');
      targetChannel = message.guild.channels.cache.get(chId) || message.guild.channels.cache.find(c => c.name === args[0]);
    }
    if (!targetChannel) targetChannel = message.member.voice.channel;
    if (!targetChannel) return message.reply('You must be in a voice channel or provide a channel to join.');
    try {
      const connection = joinVoiceChannel({ channelId: targetChannel.id, guildId: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator });
      const started = startMusicForGuild(message.guild.id, connection);
      if (started) return message.reply(`Joined ${targetChannel.name} and started autoplaying music.`);
      return message.reply(`Joined ${targetChannel.name}, but no music files found in music/christmas.`);
    } catch (e) {
      console.error('join error', e);
      return message.reply('Failed to join voice channel.');
    }
  }

  if (command === 'leave') {
    const conn = getVoiceConnection(message.guild.id);
    if (!conn) return message.reply('I am not connected to a voice channel in this guild.');
    try {
      const entry = musicPlayers.get(message.guild.id);
      if (entry) { try { entry.player.stop(); } catch {} musicPlayers.delete(message.guild.id); }
      conn.destroy();
      return message.reply('Left the voice channel and stopped music.');
    } catch (e) {
      return message.reply('Failed to leave voice channel.');
    }
  }

  if (command === 'music') {
    // Music command disabled (requires @discordjs/voice)
    return message.reply('Music commands are currently disabled.');
  }

    if (command === 'del' || command === 'delete') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return message.reply('You lack permission to delete channels.');
      const targetArg = args[0];
      if (!targetArg) return message.reply('Usage: !del <#channel|channelId|name>');

      // Try to resolve a mentioned channel first, then by id or exact name
      let channel = message.mentions.channels.first();
      if (!channel) {
        const id = targetArg.replace(/[<#>]/g, '');
        channel = message.guild.channels.cache.get(id) || message.guild.channels.cache.find(c => c.name === targetArg);
      }
      if (!channel) return message.reply('Channel not found. Provide a channel mention, ID or exact name.');

      const confirmEmbed = new EmbedBuilder().setColor(0x8A2BE2).setDescription(`Are you sure you want to delete channel **${channel.name}**? Reply with **y** to confirm within 30 seconds.`);
      await message.channel.send({ embeds: [confirmEmbed] });

      try {
        const filter = (m) => m.author.id === message.author.id && ['y','yes','n','no'].includes(m.content.toLowerCase());
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        const resp = collected.first().content.toLowerCase();
        if (resp === 'y' || resp === 'yes') {
          try {
            await channel.delete(`${message.author.tag}: requested by command`);
            appendActionMd(message.guild, message.author.tag, 'Channel Deleted', `Deleted channel ${channel.name} (${channel.id})`);
              // send log
              try {
                const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
                if (message.guild && cfg.logChannelId) {
                  const logCh = message.guild.channels.cache.get(cfg.logChannelId);
                    if (logCh && isTextLike(logCh)) {
                    const embed = new EmbedBuilder().setTitle('Channel deleted').setColor(0xE74C3C)
                      .setDescription(`Deleted channel ${channel.name} (${channel.id})`)
                      .addFields({ name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true });
                    await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
                  }
                }
              } catch (e) { console.error('del log failed', e); }

              return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setDescription(`Deleted channel ${channel.name}`)] });
          } catch (e) {
            console.error('delete channel error', e);
            appendActionMd(message.guild, message.author.tag, 'Channel Deletion Failed', `Failed to delete ${channel.name} (${channel.id}) — ${String(e)}`);
            try {
              const embed = new EmbedBuilder().setTitle('Channel deletion failed').setColor(0xE74C3C)
                .setDescription(`Failed to delete channel ${channel.name} (${channel.id})`)
                .addFields(
                  { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
                  { name: 'Error', value: `${String(e.message || e)}`, inline: false }
                ).setTimestamp();
              await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
            } catch (err) { console.error('del failure log failed', err); }
            return message.reply('Failed to delete channel — missing permissions or role hierarchy.');
          }
        } else {
          appendActionMd(message.guild, message.author.tag, 'Channel Deletion Aborted', `User aborted deletion of ${channel.name} (${channel.id})`);
          return message.channel.send('Aborted channel deletion.');
        }
      } catch (e) {
        appendActionMd(message.guild, message.author.tag, 'Channel Deletion Timeout', `No confirmation received for deletion of ${channel.name} (${channel.id})`);
        return message.reply('No confirmation received — aborting deletion.');
      }
    }

    if (command === 'role') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return message.reply('You lack permission to assign roles.');
      // Expect usage: !role @user @role  OR !role userId roleIdOrName
      const member = message.mentions.members.first() || (args[0] ? await message.guild.members.fetch(args[0].replace(/[<@!>]/g, '')).catch(() => null) : null);
      // role: try mentioned role first, then id, then name (rest of args)
      let role = message.mentions.roles.first();
      if (!role) {
        const possibleId = (args[1] || '').replace(/[<@&>]/g, '');
        role = message.guild.roles.cache.get(possibleId) || message.guild.roles.cache.find(r => r.name === args.slice(1).join(' '));
      }
      if (!member || !role) return message.reply('Usage: !role @user @role  OR  !role <userId> <roleId|roleName>');

      try {
        await member.roles.add(role, `${message.author.tag}: assigned via command`);
        appendActionMd(message.guild, message.author.tag, 'Role Assigned', `Assigned role ${role.name} (${role.id}) to ${member.user.tag} (${member.id})`);
        try {
          const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
          if (message.guild && cfg.logChannelId) {
            const logCh = message.guild.channels.cache.get(cfg.logChannelId);
              if (logCh && isTextLike(logCh)) {
              const nowTs = Math.floor(Date.now() / 1000);
              const embed = new EmbedBuilder().setTitle('Rolle vergeben').setColor(0x87CEFA)
                .setDescription(`<@${member.id}>`)
                .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
                .addFields(
                  { name: 'ID', value: `${member.id}`, inline: true },
                  { name: 'Rolle', value: `${role.name}`, inline: true },
                  { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
                  { name: 'Zeit', value: `<t:${nowTs}:R>`, inline: true }
                );
              await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
            }
          }
        } catch (e) { console.error('role assign log failed', e); }

        return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x8A2BE2).setDescription(`Assigned role **${role.name}** to ${member.user.tag}`)] });
      } catch (e) {
        console.error('role assign error', e);
        appendActionMd(message.guild, message.author.tag, 'Role Assignment Failed', `Failed to assign role ${role ? role.name : '(unknown)'} to ${member ? member.user.tag : '(unknown)'} — ${String(e)}`);
        try {
          const embed = new EmbedBuilder().setTitle('Role assignment failed').setColor(0xE74C3C)
            .addFields(
              { name: 'Role', value: `${role ? `${role.name} (${role.id})` : '(unknown)'}`, inline: true },
              { name: 'User', value: `${member ? `${member.user.tag} (${member.id})` : '(unknown)'}`, inline: true },
              { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
              { name: 'Error', value: `${String(e.message || e)}`, inline: false }
            ).setTimestamp();
          await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
        } catch (err) { console.error('role failure log failed', err); }
        return message.reply('Failed to assign role — check bot role hierarchy and permissions.');
      }
    }
});

// Resolve and validate token before login
const { token: resolvedToken, source } = resolveToken();

// Use a normal variable for login (instead of process.env.*)
const token = resolvedToken;

const tokenLen = token ? token.length : 0;
const tokenMasked = token ? `${String(token).slice(0, 4)}…${String(token).slice(-4)}` : '(none)';

console.log(`🔑 Token source: ${source || 'none'}`);
console.log(`🔎 Token length: ${tokenLen}`);
console.log(`🕵️ Token preview: ${tokenMasked}`);
console.log(`📄 .env present: ${DOTENV_PRESENT} (loaded: ${DOTENV_LOADED})`);
console.log(
  `🔧 Env vars present: TOKENSP=${!!process.env.TOKENSP} TOKEN=${!!process.env.TOKEN} DISCORD_TOKEN=${!!process.env.DISCORD_TOKEN} ` +
  `DISCORD_BOT_TOKEN=${!!process.env.DISCORD_BOT_TOKEN} BOT_TOKEN=${!!process.env.BOT_TOKEN} ` +
  `GIT_ACCESS_TOKEN=${!!process.env.GIT_ACCESS_TOKEN}`
);

if (!validateTokenFormat(token)) {
  console.error('❌ Bot token missing or malformed.');
  console.error('Fix options:');
  console.error('1) Set TOKEN (or TOKENSP / DISCORD_TOKEN / DISCORD_BOT_TOKEN / BOT_TOKEN / GIT_ACCESS_TOKEN) in Startup/Environment on your host');
  console.error('2) Upload token.txt (ONLY the token) into the root folder');
  console.error('3) Add { "discordToken": "..." } in config.json (temporary)');
  process.exit(1);
}

client.login(token).catch((e) => {
  console.error('❌ Failed to login — token invalid.');
  console.error('Tip: Regenerate the bot token in Discord Developer Portal and update your Startup variable or token.txt.');
  console.error('Error:', e.message);
  process.exit(1);
});
