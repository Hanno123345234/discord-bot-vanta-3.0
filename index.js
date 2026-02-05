const fs = require('fs');
const path = require('path');
let voiceActivity = null;
try {
  voiceActivity = require('./utils/voice_activity');
} catch (e) {
  console.warn('⚠️ Missing ./utils/voice_activity; voice activity features disabled.');
  voiceActivity = {
    disabled: true,
    VOICE_ACTIVITY_PATH: null,
    normalizeRange: (r) => String(r || '7d').toLowerCase(),
    buildVoiceActivityComponents: () => [],
    buildVoiceActivityEmbed: async () => {
      try {
        const { EmbedBuilder } = require('discord.js');
        return new EmbedBuilder()
          .setTitle('Voice Activity')
          .setDescription('Voice activity module is not deployed on this host.');
      } catch {
        return null;
      }
    },
    seedFromClient: () => {},
    handleVoiceStateUpdate: () => {},
  };
}
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
};

// (debug exit logging removed)

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

const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, AuditLogEvent, ChannelType } = require('discord.js');

// Optional voice receive support (safe import so bot still runs if package missing)
let voiceLib = null;
let joinVoiceChannel, EndBehaviorType, getVoiceConnection;
try {
  voiceLib = require('@discordjs/voice');
  joinVoiceChannel = voiceLib.joinVoiceChannel;
  EndBehaviorType = voiceLib.EndBehaviorType;
  getVoiceConnection = voiceLib.getVoiceConnection;
  console.log('✅ @discordjs/voice loaded (voice receive available)');
} catch (e) {
  // @discordjs/voice not installed on this host; voice features disabled (silent)
}
const { exec } = require('child_process');

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
const SESSIONS_WATCH_PATH = path.join(DATA_DIR, 'sessions_watch.json');
const SQLITE_DB_PATH = path.join(DATA_DIR, 'vanta_bot.sqlite');
const SESSIONS_CLAIMS_PATH = path.join(DATA_DIR, 'sessions_claims.json');
const SESSIONS_POSTS_PATH = path.join(DATA_DIR, 'sessions_posts.json');
const VOICE_CREATE_PATH = path.join(DATA_DIR, 'voice_create.json');

// Streams/watchers storage
const STREAMS_PATH = path.join(DATA_DIR, 'streams.json');

// Fixed log channels (can be overridden via env or config.json per guild)
const DEFAULT_BOT_UPDATES_CHANNEL_ID = process.env.BOT_UPDATES_CHANNEL_ID || '1467999140633120768';
const DEFAULT_SERVER_LOGS_CHANNEL_ID = process.env.SERVER_LOGS_CHANNEL_ID || '1467999947856281610';

// Recent send dedupe cache: key -> timestamp (ms)
const recentSendCache = new Map();
const RECENT_SEND_WINDOW_MS = 5000; // skip duplicate sends within 5 seconds

// Prevent duplicate log sends for the same event
function shouldSkipLogOnce(key, windowMs = RECENT_SEND_WINDOW_MS) {
  try {
    const now = Date.now();
    const prev = recentSendCache.get(key) || 0;
    if (now - prev < windowMs) return true;
    recentSendCache.set(key, now);
    return false;
  } catch (e) { return false; }
}


function loadStreams() {
  return loadJson(STREAMS_PATH, {});
}
function saveStreams(obj) {
  saveJson(STREAMS_PATH, obj || {});
}

// Simple helper to add a streamer for a guild
function addStreamerForGuild(guildId, streamerName, channelId) {
  const all = loadStreams();
  const gid = String(guildId);
  if (!all[gid]) all[gid] = [];
  const exists = all[gid].find(s => String(s.name).toLowerCase() === String(streamerName).toLowerCase());
  if (exists) return false;
  all[gid].push({ name: String(streamerName).toLowerCase(), channelId: String(channelId), live: false, lastLiveAt: null });
  saveStreams(all);
  return true;
}

function removeStreamerForGuild(guildId, streamerName) {
  const all = loadStreams();
  const gid = String(guildId);
  if (!all[gid]) return false;
  const idx = all[gid].findIndex(s => String(s.name).toLowerCase() === String(streamerName).toLowerCase());
  if (idx === -1) return false;
  all[gid].splice(idx, 1);
  saveStreams(all);
  return true;
}


// Guild IDs to exclude from cross-server blacklist/unblacklist actions
const BLACKLIST_EXCLUDE_GUILD_IDS = new Set([
  '1323668832862343219'
]);

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
  try {
    const json = JSON.stringify(obj, null, 2);
    // Atomic-ish write: write temp file, then rename into place.
    // This reduces the chance of truncated JSON if the process dies mid-write.
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    try {
      fs.renameSync(tmp, p);
    } catch (e) {
      // Fallback: direct write (e.g. on cross-device rename / permission oddities)
      try { fs.writeFileSync(p, json, 'utf8'); } catch (e2) { throw e2; }
      try { fs.unlinkSync(tmp); } catch (e3) {}
    }
    return true;
  } catch (e) {
    console.error('Failed to save JSON', p, e);
    return false;
  }
}

function reloadModlogs() {
  try {
    const loaded = loadJson(MODLOGS_PATH, { lastCase: 10000, cases: [] });
    if (!loaded || typeof loaded !== 'object') return (modlogs = { lastCase: 10000, cases: [] });
    if (typeof loaded.lastCase !== 'number') loaded.lastCase = 10000;
    if (!Array.isArray(loaded.cases)) loaded.cases = [];
    modlogs = loaded;
    return modlogs;
  } catch (e) {
    return modlogs;
  }
}

// --- Join-to-create voice channels ----------------------------------------
let voiceCreateState = loadJson(VOICE_CREATE_PATH, { channels: {} });
if (!voiceCreateState || typeof voiceCreateState !== 'object') voiceCreateState = { channels: {} };
if (!voiceCreateState.channels || typeof voiceCreateState.channels !== 'object') voiceCreateState.channels = {};

function saveVoiceCreateState() {
  try { saveJson(VOICE_CREATE_PATH, voiceCreateState); } catch (e) {}
}

function sanitizeVoiceChannelName(raw) {
  try {
    let name = String(raw || '').trim();
    if (!name) name = 'voice';
    // Discord channel name max is 100; keep a little headroom.
    if (name.length > 90) name = name.substring(0, 90).trim();
    return name;
  } catch (e) {
    return 'voice';
  }
}

function getVoiceCreateCfg(guildId) {
  const cfg = loadGuildConfig(guildId);
  const triggerChannelId = process.env.VOICE_CREATE_TRIGGER_CHANNEL_ID || cfg.voiceCreateTriggerChannelId || cfg.voice_create_trigger_channel_id || null;
  const categoryId = process.env.VOICE_CREATE_CATEGORY_ID || cfg.voiceCreateCategoryId || cfg.voice_create_category_id || null;
  const enabledEnv = process.env.VOICE_CREATE_ENABLED;
  const enabledCfg = (cfg.voiceCreateEnabled !== undefined) ? !!cfg.voiceCreateEnabled : undefined;
  const enabled = (enabledEnv !== undefined)
    ? !['0','false','no','off'].includes(String(enabledEnv).toLowerCase())
    : (enabledCfg !== undefined ? enabledCfg : true);
  const deleteWhenEmptyEnv = process.env.VOICE_CREATE_DELETE_WHEN_EMPTY;
  const deleteWhenEmpty = (deleteWhenEmptyEnv !== undefined)
    ? !['0','false','no','off'].includes(String(deleteWhenEmptyEnv).toLowerCase())
    : (cfg.voiceCreateDeleteWhenEmpty !== undefined ? !!cfg.voiceCreateDeleteWhenEmpty : true);
  const nameMode = (cfg.voiceCreateNameMode || process.env.VOICE_CREATE_NAME_MODE || 'displayName');
  const namePrefix = (cfg.voiceCreateNamePrefix || process.env.VOICE_CREATE_NAME_PREFIX || '').toString();

  return {
    enabled: !!enabled,
    triggerChannelId: triggerChannelId ? String(triggerChannelId) : null,
    categoryId: categoryId ? String(categoryId) : null,
    deleteWhenEmpty: !!deleteWhenEmpty,
    nameMode: String(nameMode || 'displayName'),
    namePrefix,
  };
}

async function maybeDeleteCreatedVoiceChannel(channel) {
  try {
    if (!channel || !channel.id) return false;
    const meta = voiceCreateState.channels[String(channel.id)];
    if (!meta) return false;
    const guildId = meta.guildId ? String(meta.guildId) : null;
    const cfg = getVoiceCreateCfg(guildId);
    if (!cfg.deleteWhenEmpty) return false;

    const nonBot = channel.members ? Array.from(channel.members.values()).filter(m => m && m.user && !m.user.bot).length : 0;
    if (nonBot > 0) return false;

    try { await channel.delete('Join-to-create voice: channel empty'); } catch (e) {}
    delete voiceCreateState.channels[String(channel.id)];
    saveVoiceCreateState();
    return true;
  } catch (e) {
    return false;
  }
}

async function handleJoinToCreateVoice(oldState, newState) {
  try {
    const guild = newState.guild;
    if (!guild) return false;
    if (!newState.member || !newState.member.user) return false;
    const cfg = getVoiceCreateCfg(guild.id);
    if (!cfg.enabled) return false;
    if (!cfg.triggerChannelId) return false;

    // Only when joining the trigger channel
    if (!newState.channelId) return false;
    if (String(newState.channelId) !== String(cfg.triggerChannelId)) return false;
    if (oldState && oldState.channelId && String(oldState.channelId) === String(newState.channelId)) return false;

    const triggerChannel = newState.channel;
    if (!triggerChannel) return false;

    // Resolve category: config override else inherit trigger channel parent
    const parentId = cfg.categoryId || triggerChannel.parentId || null;

    const baseName = (cfg.nameMode.toLowerCase() === 'username')
      ? (newState.member.user.username || newState.member.user.tag || newState.member.id)
      : (newState.member.displayName || newState.member.user.username || newState.member.user.tag || newState.member.id);
    const name = sanitizeVoiceChannelName(`${cfg.namePrefix || ''}${baseName}`);

    const created = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parentId,
      reason: `Join-to-create voice for ${newState.member.user.tag} (${newState.id})`
    });

    // Persist mapping so *dcase-like admin actions and restarts can still clean up
    voiceCreateState.channels[String(created.id)] = {
      guildId: String(guild.id),
      ownerId: String(newState.id),
      triggerChannelId: String(cfg.triggerChannelId),
      createdAt: Date.now(),
    };
    saveVoiceCreateState();

    // Move member into created channel
    try { await newState.setChannel(created, 'Join-to-create voice: move user'); } catch (e) {}
    return true;
  } catch (e) {
    return false;
  }
}

function loadWatchChannels(guildId) {
  try {
    const all = loadJson(SESSIONS_WATCH_PATH, {});
    const defaults = ['1461370812639481888', '1461370702895779945'];
    const set = new Set(defaults.map(String));
    if (all && typeof all === 'object') {
      if (all.global && Array.isArray(all.global)) for (const c of all.global) set.add(String(c));
      const gid = String(guildId || '');
      if (gid && all[gid] && Array.isArray(all[gid])) for (const c of all[gid]) set.add(String(c));
    }
    // Also include channels configured in config.json sessionAnnouncements tracks
    try {
      const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
      const tracks = cfg && cfg.sessionAnnouncements && Array.isArray(cfg.sessionAnnouncements.tracks)
        ? cfg.sessionAnnouncements.tracks
        : [];
      for (const t of tracks) {
        if (!t) continue;
        if (t.channelId) set.add(String(t.channelId));
      }
    } catch (e) {}
    return set;
  } catch (e) { return new Set(['1461370812639481888', '1461370702895779945']); }
}

function addWatchChannel(guildId, channelId) {
  try {
    const all = loadJson(SESSIONS_WATCH_PATH, {});
    const gid = String(guildId || 'global');
    if (!all[gid]) all[gid] = [];
    if (!all[gid].includes(String(channelId))) {
      all[gid].push(String(channelId));
      saveJson(SESSIONS_WATCH_PATH, all);
    }
    return true;
  } catch (e) { return false; }
}

function removeWatchChannel(guildId, channelId) {
  try {
    const all = loadJson(SESSIONS_WATCH_PATH, {});
    const gid = String(guildId || 'global');
    if (!all[gid]) return false;
    const idx = all[gid].indexOf(String(channelId));
    if (idx !== -1) {
      all[gid].splice(idx, 1);
      saveJson(SESSIONS_WATCH_PATH, all);
      return true;
    }
    return false;
  } catch (e) { return false; }
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

// Modlogs-style MD writer for modlog/blacklist actions
function appendModlogsMdEntry({ title, userId, type, moderatorId, reason, caseId, whenTs, guild }) {
  try {
    const mdPath = path.join(DATA_DIR, 'actions.md');
    const now = new Date().toISOString();
    const guildInfo = guild ? `${guild.name} (${guild.id})` : 'Direct Message';
    const when = whenTs ? formatHammertime(whenTs) : formatHammertime(Date.now());
    const modLine = moderatorId
      ? (/^\d+$/.test(String(moderatorId)) ? `<@${moderatorId}> (${moderatorId})` : String(moderatorId))
      : 'Unknown';
    const reasonLine = reason ? String(reason) : '—';

    const entry = [
      `## ${title} — ${now}`,
      `- Server: ${guildInfo}`,
      `- User: ${userId ? (/^\d+$/.test(String(userId)) ? `<@${userId}> (${userId})` : String(userId)) : 'Unknown'}`,
      `- Type: ${type || 'Unknown'}`,
      `- Moderator: ${modLine}`,
      `- Case: ${caseId ?? 'n/a'}`,
      `- Reason: ${reasonLine} - ${when}`,
      '',
    ].join('\n');

    fs.appendFileSync(mdPath, entry, 'utf8');
  } catch (e) {
    console.error('Failed to write modlog-style actions.md', e);
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

function isUserBlacklisted(userId) {
  try {
    if (!blacklist || !Array.isArray(blacklist.blacklisted)) return false;
    return blacklist.blacklisted.some(b => b && String(b.id) === String(userId));
  } catch (e) { return false; }
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
    console.log('Loading automod configuration from', p);
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
  // Keep modlogs in sync with disk so admin commands and multi-instance runs behave predictably.
  reloadModlogs();
  modlogs.lastCase += 1;
  saveJson(MODLOGS_PATH, modlogs);
  return modlogs.lastCase;
}

// Unified modlog helpers: store in modlogs.json + write to actions.md
const RECENT_MOD_ACTION_TTL_MS = 15_000;
const recentModActionKeys = new Map(); // key -> timestamp

function markRecentModAction(guildId, type, subjectId, moderatorId = '*') {
  try {
    const now = Date.now();
    const key = `${String(guildId || 'dm')}:${String(type || 'Unknown')}:${String(subjectId || 'unknown')}:${String(moderatorId || '*')}`;
    recentModActionKeys.set(key, now);
    // cheap cleanup
    for (const [k, ts] of recentModActionKeys) {
      if ((now - ts) > RECENT_MOD_ACTION_TTL_MS) recentModActionKeys.delete(k);
    }
  } catch (e) {}
}

function hasRecentModAction(guildId, type, subjectId, moderatorId = null) {
  try {
    const now = Date.now();
    const base = `${String(guildId || 'dm')}:${String(type || 'Unknown')}:${String(subjectId || 'unknown')}`;

    if (moderatorId) {
      const exactKey = `${base}:${String(moderatorId)}`;
      const exactTs = recentModActionKeys.get(exactKey);
      if (!!exactTs && ((now - exactTs) <= RECENT_MOD_ACTION_TTL_MS)) return true;
    }

    // Back-compat / fallback: match wildcard moderator keys
    const wildcardKey = `${base}:*`;
    const wildcardTs = recentModActionKeys.get(wildcardKey);
    return !!wildcardTs && ((now - wildcardTs) <= RECENT_MOD_ACTION_TTL_MS);
  } catch (e) {
    return false;
  }
}

function normalizeReason(reason) {
  const r = String(reason || '').trim();
  return r ? r : 'No reason provided';
}

function ensurePermBanReason(reason) {
  const r = normalizeReason(reason);
  if (/^perm\b/i.test(r)) return r;
  return `Perm ${r}`;
}

function writeModlogCaseToMd({ guild, caseId, type, userId, moderatorId, reason, whenTs }) {
  try {
    appendModlogsMdEntry({
      title: type || 'Moderation',
      userId: userId ? String(userId) : null,
      type: type || 'Unknown',
      moderatorId: moderatorId ? String(moderatorId) : null,
      reason: normalizeReason(reason),
      caseId,
      whenTs: whenTs || Date.now(),
      guild
    });
  } catch (e) {}
}

function createModlogCase({ guild, type, userId, moderatorId, reason, durationMs, extra }) {
  if (!modlogs || typeof modlogs !== 'object') modlogs = { lastCase: 10000, cases: [] };
  if (!Array.isArray(modlogs.cases)) modlogs.cases = [];
  const caseId = nextCase();
  const entry = {
    caseId,
    type: type || 'Unknown',
    user: userId ? String(userId) : null,
    moderator: moderatorId ? String(moderatorId) : null,
    reason: (String(type || '') === 'Ban') ? ensurePermBanReason(reason) : normalizeReason(reason),
    time: Date.now(),
    guildId: guild ? String(guild.id) : null,
  };
  if (typeof durationMs === 'number') entry.durationMs = durationMs;
  if (extra && typeof extra === 'object') {
    try { Object.assign(entry, extra); } catch (e) {}
  }
  modlogs.cases.push(entry);
  saveJson(MODLOGS_PATH, modlogs);
  writeModlogCaseToMd({ guild, caseId, type: entry.type, userId: entry.user, moderatorId: entry.moderator, reason: entry.reason, whenTs: entry.time });
  if (guild && entry.user) markRecentModAction(guild.id, entry.type, entry.user, entry.moderator || '*');
  return caseId;
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

// sessions log channel id (default fallback)
const SESSIONS_LOG_CHANNEL_ID = '1461475110761533451';

function resolveSessionsLogChannelId(guildId) {
  try {
    if (!guildId) return process.env.SESSIONS_LOG_CHANNEL_ID || SESSIONS_LOG_CHANNEL_ID;
    const cfg = loadGuildConfig(guildId);
    return process.env.SESSIONS_LOG_CHANNEL_ID || cfg.sessionsLogChannelId || cfg.sessions_log_channel_id || SESSIONS_LOG_CHANNEL_ID;
  } catch (e) {
    return process.env.SESSIONS_LOG_CHANNEL_ID || SESSIONS_LOG_CHANNEL_ID;
  }
}

function resolveMessageLogChannelId(guildId) {
  try {
    const cfg = guildId ? loadGuildConfig(guildId) : loadJson(path.join(DATA_DIR, 'config.json'), {});
    return process.env.MESSAGE_LOG_CHANNEL_ID || cfg.messageLogChannelId || cfg.logChannelId || process.env.LOG_CHANNEL_ID;
  } catch (e) {
    return process.env.MESSAGE_LOG_CHANNEL_ID || process.env.LOG_CHANNEL_ID;
  }
}

// sendSessionsLog: sends payload (content/embeds/files) to the configured sessions log channel
// defined after `client` below to ensure `client` exists; we provide a lightweight wrapper here
async function sendSessionsLogWrapper(payload, guildId) {
  try {
    const chId = resolveSessionsLogChannelId(guildId || (payload && payload.guildId));
    if (!chId) return;
    let ch = client.channels.cache.get(chId) || await client.channels.fetch(chId).catch(()=>null);
    if (!ch) return;
    if (guildId && ch.guildId && String(ch.guildId) !== String(guildId)) return;
    if (typeof ch.isTextBased === 'function' ? !ch.isTextBased() : !ch.isText) return;
    // Normalize payload to embeds and enforce light-blue color for all embeds
    const ensureEmbed = (e) => {
      try {
        if (e instanceof EmbedBuilder) {
          if (!e.data || !e.data.color) e.setColor(0x87CEFA);
          return e;
        }
        const nb = new EmbedBuilder(e || {});
        if (!nb.data || !nb.data.color) nb.setColor(0x87CEFA);
        return nb;
      } catch (err) {
        try { return new EmbedBuilder().setDescription(String(e)).setColor(0x87CEFA); } catch (err2) { return null; }
      }
    };

    if (payload && payload.embeds) {
      const embeds = payload.embeds.map(ensureEmbed).filter(Boolean);
      const out = Object.assign({}, payload);
      out.embeds = embeds;
      return ch.send(out).catch(()=>{});
    }
    if (payload && payload.content) {
      const embed = new EmbedBuilder().setDescription(String(payload.content)).setColor(0x87CEFA);
      return ch.send({ embeds: [embed] }).catch(()=>{});
    }
    if (payload instanceof EmbedBuilder) {
      const e = ensureEmbed(payload);
      if (e) return ch.send({ embeds: [e] }).catch(()=>{});
    }
    if (payload) {
      const e = ensureEmbed(payload);
      if (e) return ch.send({ embeds: [e] }).catch(()=>{});
    }
  } catch (e) { console.error('sendSessionsLogWrapper failed', e); }
}

// alias to use in code (defined earlier as sendSessionsLog)
const sendSessionsLog = (...args) => sendSessionsLogWrapper(...args);

// sendMessageLog: alias that posts to the configured message log channel (MESSAGE_LOG_CHANNEL_ID or config)
async function sendMessageLogWrapper(payload, guildId) {
  try {
    // Prefer explicit env var, then config keys `messageLogChannelId`, then legacy `logChannelId`.
    const chId = resolveMessageLogChannelId(guildId || (payload && payload.guildId));
    if (!chId) return;
    let ch = client.channels.cache.get(chId) || await client.channels.fetch(chId).catch(()=>null);
    if (!ch) return;
    if (guildId && ch.guildId && String(ch.guildId) !== String(guildId)) return;
    if (typeof ch.isTextBased === 'function' ? !ch.isTextBased() : !ch.isText) return;
    const ensureEmbed = (e) => {
      try {
        if (e instanceof EmbedBuilder) {
          if (!e.data || !e.data.color) e.setColor(0x87CEFA);
          return e;
        }
        const nb = new EmbedBuilder(e || {});
        if (!nb.data || !nb.data.color) nb.setColor(0x87CEFA);
        return nb;
      } catch (err) {
        try { return new EmbedBuilder().setDescription(String(e)).setColor(0x87CEFA); } catch (err2) { return null; }
      }
    };
    if (payload && payload.embeds) {
      const embeds = payload.embeds.map(ensureEmbed).filter(Boolean);
      const out = Object.assign({}, payload);
      out.embeds = embeds;
      return ch.send(out).catch(()=>{});
    }
    if (payload && payload.content) {
      const embed = new EmbedBuilder().setDescription(String(payload.content)).setColor(0x87CEFA);
      return ch.send({ embeds: [embed] }).catch(()=>{});
    }
    if (payload instanceof EmbedBuilder) {
      const e = ensureEmbed(payload);
      if (e) return ch.send({ embeds: [e] }).catch(()=>{});
    }
    if (payload) {
      const e = ensureEmbed(payload);
      if (e) return ch.send({ embeds: [e] }).catch(()=>{});
    }
  } catch (e) { console.error('sendMessageLogWrapper failed', e); }
}
const sendMessageLog = (...args) => sendMessageLogWrapper(...args);

// Ensure the latest "Session parsed" embed in a channel has Claim + Announce buttons
async function ensureParsedButtons(channel, sessions) {
  try {
    if (!channel || typeof channel.messages?.fetch !== 'function') return;
    const recent = await channel.messages.fetch({ limit: 15 }).catch(()=>null);
    if (!recent || typeof recent.filter !== 'function') return;
    const parsedMsgs = recent.filter(m =>
      m && m.author && client.user && m.author.id === client.user.id &&
      Array.isArray(m.embeds) && m.embeds[0] && String(m.embeds[0].title || '').toLowerCase() === 'session parsed'
    );
    if (!parsedMsgs.size) return;
    let keep = null;
    const countFromDesc = (m) => (String(m.embeds[0].description || '').match(/•\s*\d+\./g) || []).length;
    for (const m of parsedMsgs.values()) {
      if (!keep) keep = m;
      else {
        const a = countFromDesc(m);
        const b = countFromDesc(keep);
        if (a > b) keep = m;
        else if (a === b && m.createdTimestamp > keep.createdTimestamp) keep = m;
      }
    }
    if (!keep) return;
    const rows = buildSessionButtonRows(keep.id, sessions);
    await keep.edit({ components: rows }).catch(()=>{});
  } catch (e) {}
}

function buildSessionButtonRows(baseId, sessions) {
  const rows = [];
  const buttons = [];
  const claimBtn = new ButtonBuilder().setCustomId(`session_claim:${baseId}`).setLabel('Claim').setStyle(ButtonStyle.Primary);
  buttons.push(claimBtn);
  if (Array.isArray(sessions) && sessions.length) {
    for (const s of sessions.slice(0, 10)) {
      buttons.push(new ButtonBuilder().setCustomId(`session_announce:${baseId}:${s.index}`).setLabel(`Announce S${s.index}`).setStyle(ButtonStyle.Success));
    }
  }
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
  }
  return rows;
}

// --- Session post parsing and reminder scheduling ---
const scheduledReminderTimeouts = new Map();
// In-memory map to store parsed session post data so we can announce later
const sessionPostData = new Map();
// Map origin message id -> posted summary message id
const sessionOriginToPosted = new Map();

function parseSessionMessage(content, referenceDate) {
  // Parse simple session posts like in screenshots:
  // lines with `1. 17:00 - 17:15` and following line `Staff: @User` or inline `Staff: @User`
  // Remove invisible/unicode directionality characters that break timestamp regexes
  const raw = String(content || '');
  // Keep \n/\r/\t so numbered lines don't collapse into a single line
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  const cleaned2 = cleaned.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  try { console.log('[session-debug] parseSessionMessage cleaned2 preview:', String(cleaned2 || '').slice(0,300)); } catch (e) {}
  // Accept literal "\n" sequences as newlines (from prefix simulations) and strip wrapping quotes
  let norm = String(cleaned2 || '');
  try { norm = norm.replace(/\\n/g, '\n'); } catch (e) {}
  norm = norm.trim();
  if ((norm.startsWith('"') && norm.endsWith('"')) || (norm.startsWith("'") && norm.endsWith("'"))) {
    norm = norm.slice(1, -1).trim();
  }
  const lines = String(norm || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  try { console.log('[session-debug] parseSessionMessage lines:', lines); } catch (e) {}
  const sessions = [];

  // Global numbered-lines extractor: handles cases where line-splitting is noisy and markup is present
  try {
    const globalRe = /(?:^|\n)[>\s|│\u2502]*\s*(\d+)\s*[\.)-]?\s*[*_`~]*\s*([0-2]?\d[:.][0-5]\d)\s*[*_`~]*\s*(?:-|–|—|to)\s*[*_`~]*\s*([0-2]?\d[:.][0-5]\d)\s*[*_`~]*(?:[^\n]*)(?:\n[>\s|│\u2502]*\s*(?:Staff[:\s\*]*([^\n]+)))?/gi;
    let gm;
    while ((gm = globalRe.exec(norm)) !== null) {
      try {
        const idx = Number(gm[1]);
        const startStr = gm[2];
        const endStr = gm[3];
        const staffRaw = gm[4] ? String(gm[4]).trim() : '';
        const ref = referenceDate instanceof Date ? new Date(referenceDate) : new Date();
        const [sh, sm] = startStr.split(':').map(Number);
        const [eh, em] = endStr.split(':').map(Number);
        const sd = new Date(ref); sd.setHours(sh, sm, 0, 0);
        const ed = new Date(ref); ed.setHours(eh, em, 0, 0);
        if (ed.getTime() <= sd.getTime()) ed.setDate(ed.getDate() + 1);
        sessions.push({ index: idx, start: sd.getTime(), end: ed.getTime(), staff: normalizeStaffText(staffRaw) });
      } catch (ee) { /* ignore malformed match */ }
    }
  } catch (e) { /* ignore global extraction failures */ }

  // Additional fallback: scan each line for any HH:MM - HH:MM pairs (no number required)
  try {
    const lineFound = [];
    for (let i = 0; i < lines.length; i++) {
      const rawLine = String(lines[i] || '');
      const cleanLine = rawLine.replace(/^[>\s\|│\u2502]+/, '').trim();
      // match time pair anywhere in line
      const m = cleanLine.match(/([0-2]?\d:[0-5]\d)\s*(?:-|–|—|to)\s*([0-2]?\d:[0-5]\d)/);
      if (m) {
        // capture optional leading index
        const idxMatch = cleanLine.match(/^(?:\*+\s*)?\(?\s*(\d+)\s*[\.)\-]?/);
        const idx = idxMatch ? Number(idxMatch[1]) : null;
        const startStr = m[1];
        const endStr = m[2];
        const ref = referenceDate instanceof Date ? new Date(referenceDate) : new Date();
        const [sh, sm] = startStr.split(':').map(Number);
        const [eh, em] = endStr.split(':').map(Number);
        const sd = new Date(ref); sd.setHours(sh, sm, 0, 0);
        const ed = new Date(ref); ed.setHours(eh, em, 0, 0);
        if (ed.getTime() <= sd.getTime()) ed.setDate(ed.getDate() + 1);
        // try next line for staff
        let staff = '';
        const next = lines[i+1];
        if (next) {
          const nextClean = String(next).replace(/^[>\s\|│\u2502]+/,'').trim();
          const smt = nextClean.match(/^(?:staff in charge:|staff[:\s\-–]*)\s*([\s\S]+)/i);
          if (smt) staff = (smt[1] || '').trim();
        }
        lineFound.push({ idx, start: sd.getTime(), end: ed.getTime(), staff: normalizeStaffText(staff) });
      }
    }
    if (lineFound.length) {
      // If any indexes present, sort by index, otherwise preserve order
      const hasIndex = lineFound.some(x=>Number.isFinite(x.idx));
      let out;
      if (hasIndex) out = lineFound.slice().sort((a,b) => (a.idx||0)-(b.idx||0));
      else out = lineFound.slice();
      for (const s of out) sessions.push({ index: s.idx || (sessions.length + 1), start: s.start, end: s.end, staff: s.staff });
    }
  } catch (e) { /* ignore */ }

  // If the whole announcement collapsed into a single line, try splitting by numeric markers
  if (lines.length === 1) {
    const single = lines[0];
    const numberCount = (single.match(/\b\d+\s*[\.)-]/g) || []).length;
    if (numberCount > 1) {
      const splitLines = single
        .split(/(?=\b\d+\s*[\.)-])/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => {
          const idx = s.search(/\b\d+\s*[\.)-]/);
          return idx > 0 ? s.slice(idx).trim() : s;
        });
      try { console.log('[session-debug] parseSessionMessage numeric-split into:', splitLines); } catch (e) {}
      // replace lines with the split chunks for downstream parsing
      for (let j = 0; j < splitLines.length; j++) lines[j] = splitLines[j];
      // trim any leftover entries if split produced more than original length
      lines.length = splitLines.length;
    }
  }

  function normalizeStaffText(r) {
    if (!r) return '';
    let s = String(r || '').trim();
    // remove blockquote markers and leading asterisks/bold markers
    s = s.replace(/^>\s*/g, '');
    s = s.replace(/\*+\s*/g, '');
    // remove labels like "Staff in charge:" or "Staff:" or "- Staff:"
    s = s.replace(/^(staff in charge:\s*|staff[:\s]*)/i, '');
    // remove discord channel/message links that sometimes leak into staff text
    s = s.replace(/https?:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/gi, '').trim();
    s = s.replace(/https?:\/\/discord\.com\/channels\/\d+\/\d+/gi, '').trim();
    // collapse multiple spaces
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }
  // Announcement-style messages and the new markdown templates (blockquote + bold), e.g.:
  // > * **Registration Opens:** <Time>
  // > * **Game 1/3:** <Time>
  if (/registration opens|game\s*1\/[0-9]+|duo practice session/i.test(cleaned2)) {
    try {
      // Normalize formatting for easier matching (remove repeat asterisks and blockquote markers)
      const normForMatch = cleaned2.replace(/\*+/g, '*').replace(/^>\s*/gm, '').replace(/\s+\*\s+/g, ' ').trim();
      // Find registration opens (timestamp token or HH:MM)
      const regMatch = normForMatch.match(/registration\s*opens\D*(?:<t:(\d+):t>|([0-2]?\d:[0-5]\d))/i);
      // Find Game 1/N (capture total games and a timestamp or HH:MM)
      const gameMatch = normForMatch.match(/game\s*1\/?(\d+)\D*(?:<t:(\d+):t>|([0-2]?\d:[0-5]\d))/i);
      const staffMatch = normForMatch.match(/staff in charge:\s*([^\n\r]+)/i) || normForMatch.match(/staff[:\s]*([^\n\r]+)/i);
      const staffRaw = staffMatch ? staffMatch[1].trim() : '';

      let startTs = null;
      let totalGames = 1;
      const defaultDurationMs = 15 * 60 * 1000;

      // Parse both registration and game timestamps if present; prefer explicit Game time
      let regTsCandidate = null;
      let gameTsCandidate = null;
      try {
        if (regMatch) {
          if (regMatch[1]) regTsCandidate = Number(regMatch[1]) * 1000;
          else if (regMatch[2]) {
            const [sh, sm] = regMatch[2].split(':').map(Number);
            const sd = referenceDate instanceof Date ? new Date(referenceDate) : new Date();
            sd.setHours(sh, sm, 0, 0);
            regTsCandidate = sd.getTime();
          }
        }
        if (gameMatch) {
          totalGames = Number(gameMatch[1]) || 1;
          if (gameMatch[2]) gameTsCandidate = Number(gameMatch[2]) * 1000;
          else if (gameMatch[3]) {
            const [sh, sm] = gameMatch[3].split(':').map(Number);
            const sd = referenceDate instanceof Date ? new Date(referenceDate) : new Date();
            sd.setHours(sh, sm, 0, 0);
            gameTsCandidate = sd.getTime();
          }
        }
      } catch (ee) {
        // ignore parse errors and fall back to previous behavior
      }

      // Prefer the explicit game time when available; otherwise use registration time
      if (gameTsCandidate) startTs = gameTsCandidate;
      else if (regTsCandidate) startTs = regTsCandidate;

      if (startTs) {
        for (let g = 0; g < totalGames; g++) {
          const s = startTs + g * defaultDurationMs;
          const e = s + defaultDurationMs;
          sessions.push({ index: g + 1, start: s, end: e, staff: normalizeStaffText(staffRaw) });
        }
        return sessions;
      }
    } catch (e) {
      // fall through to numbered parsing
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // strip common blockquote/pipe markers that appear in pasted announcements
    const procLine = String(line || '').replace(/^[>\s\|│\u2502]+/,'').trim();
    const firstNumIdx = procLine.search(/\b\d+\s*[\.)-]/);
    const matchLine = firstNumIdx > 0 ? procLine.slice(firstNumIdx).trim() : procLine;
    // Support numbered lines using Discord timestamp markup: "1. <t:1769270400:t> - <t:1769271300:t>"
    // Be tolerant: accept isolates or extra chars around timestamps by extracting all <t:...:t> tokens
    const numberedMatch = matchLine.match(/^\s*\(?\s*(\d+)\s*[\.)-]/);
    if (numberedMatch) {
      const idx = parseInt(numberedMatch[1], 10);
      const tsMatches = Array.from(matchLine.matchAll(/<t:(\d+):t>/g)).map(m => m[1]);
      if (tsMatches.length >= 2) {
        const startTs = Number(tsMatches[0]) * 1000;
        const endTs = Number(tsMatches[1]) * 1000;
      // staff may be inline or on the next quoted line (e.g. "> **Staff:** <@id>")
      let staff = null;
      const staffInline = matchLine.match(/staff(?:\s+in\s+charge)?[:\s\*]*([\s\S]+)/i);
      if (staffInline) staff = staffInline[1].trim();
      else {
        const next = lines[i+1];
        if (next) {
          let nextClean = String(next).replace(/^[>\s\|│\u2502]+/,'').trim();
          nextClean = nextClean.replace(/^[*_`~\s]+/, '');
          if (/^staff/i.test(nextClean)) {
            staff = nextClean.replace(/^staff(?:\s+in\s+charge)?[:\s\*]*/i, '').trim();
          }
        }
      }
        sessions.push({ index: idx, start: startTs, end: endTs, staff: normalizeStaffText(staff) });
        continue;
      }
      // fallback to previous strict match if needed
    }
    const discordTsMatch = matchLine.match(/^(\d+)\s*[\.)-]\s*<t:(\d+):t>\s*(?:-|–|—|to)\s*<t:(\d+):t>/i);
    if (discordTsMatch) {
      const idx2 = parseInt(discordTsMatch[1], 10);
      const startTs = Number(discordTsMatch[2]) * 1000;
      const endTs = Number(discordTsMatch[3]) * 1000;
      const idx = idx2;
    }
    const timeMatch = matchLine.match(/^(\d+)\s*[\.)-]\s*([0-2]?\d[:.][0-5]\d)\s*(?:-|–|—|to)\s*([0-2]?\d[:.][0-5]\d)/i);
    if (timeMatch) {
      const idx = parseInt(timeMatch[1], 10);
      const start = timeMatch[2];
      const end = timeMatch[3];
      // look for staff on same line
      let staff = null;
      const staffInline = matchLine.match(/staff(?:\s+in\s+charge)?[:\s]*([\s\S]+)/i);
      if (staffInline) staff = staffInline[1].trim();
      else {
        // look next line
        const next = lines[i+1];
        if (next) {
          let nextClean = String(next).replace(/^[>\s\|│\u2502]+/,'').trim();
          nextClean = nextClean.replace(/^[*_`~\s]+/, '');
          if (/^staff/i.test(nextClean)) {
            staff = nextClean.replace(/^staff(?:\s+in\s+charge)?[:\s]*/i, '').trim();
          }
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
      sessions.push({ index: idx, start: startDt.getTime(), end: endDt.getTime(), staff: normalizeStaffText(staff) });
    }

    // Per-line fallback: any line with 2+ timestamp tokens
    if (!timeMatch) {
      const tsMatches = Array.from(matchLine.matchAll(/<t:(\d+):t>/g)).map(m => m[1]);
      if (tsMatches.length >= 2) {
        const idx = numberedMatch ? parseInt(numberedMatch[1], 10) : (sessions.length + 1);
        const startTs = Number(tsMatches[0]) * 1000;
        const endTs = Number(tsMatches[1]) * 1000;
        let staff = null;
        const staffInline = matchLine.match(/staff(?:\s+in\s+charge)?[:\s\*]*([\s\S]+)/i);
        if (staffInline) staff = staffInline[1].trim();
        else {
          const next = lines[i+1];
          if (next) {
            let nextClean = String(next).replace(/^[>\s\|│\u2502]+/,'').trim();
            nextClean = nextClean.replace(/^[*_`~\s]+/, '');
            if (/^staff/i.test(nextClean)) {
              staff = nextClean.replace(/^staff(?:\s+in\s+charge)?[:\s\*]*/i, '').trim();
            }
          }
        }
        sessions.push({ index: idx, start: startTs, end: endTs, staff: normalizeStaffText(staff) });
      }
    }
  }
  // Fallback: if we found nothing but there are many Discord timestamp tokens in the text,
  // group them pairwise as sessions so the parser returns entries even when line breaks are lost.
  if (sessions.length === 0) {
    try {
      const allTs = Array.from(String(norm || '').matchAll(/<t:(\d+):t>/g)).map(m => m[1]);
      if (allTs.length >= 2) {
        for (let k = 0; k + 1 < allTs.length; k += 2) {
          const startTs = Number(allTs[k]) * 1000;
          const endTs = Number(allTs[k + 1]) * 1000;
          sessions.push({ index: sessions.length + 1, start: startTs, end: endTs, staff: '' });
        }
      }
      // additional fallback: find time-pairs (either <t:...:t> tokens or HH:MM - HH:MM) anywhere
      if (sessions.length === 0) {
        const timePairRegex = /(?:(\b\d+)[\.\)\-]?\s*)?(?:<t:(\d+):t>|([0-2]?\d:[0-5]\d))\s*(?:-|–|to)\s*(?:<t:(\d+):t>|([0-2]?\d:[0-5]\d))/gi;
        let m;
        while ((m = timePairRegex.exec(norm)) !== null) {
          const idxFound = m[1] ? Number(m[1]) : (sessions.length + 1);
          let startTs = null;
          let endTs = null;
          if (m[2]) startTs = Number(m[2]) * 1000;
          else if (m[3]) {
            const [sh, sm] = m[3].split(':').map(Number);
            const sd = referenceDate instanceof Date ? new Date(referenceDate) : new Date();
            sd.setHours(sh, sm, 0, 0);
            startTs = sd.getTime();
          }
          if (m[4]) endTs = Number(m[4]) * 1000;
          else if (m[5]) {
            const [eh, em] = m[5].split(':').map(Number);
            const ed = referenceDate instanceof Date ? new Date(referenceDate) : new Date();
            ed.setHours(eh, em, 0, 0);
            if (startTs && ed.getTime() <= startTs) ed.setDate(ed.getDate() + 1);
            endTs = ed.getTime();
          }
          // extract staff by scanning a short window after the match
          let staff = '';
          try {
            const after = norm.slice(timePairRegex.lastIndex, timePairRegex.lastIndex + 200);
            const staffMatch = after.match(/(?:staff|leitung|team)[:\s]*([^\n\r]{1,120})/i);
            if (staffMatch) staff = staffMatch[1] ? staffMatch[1].trim() : staffMatch[0];
          } catch (e) {}
          if (startTs && endTs) sessions.push({ index: idxFound, start: startTs, end: endTs, staff: normalizeStaffText(staff) });
        }
      }
    } catch (e) {
      // ignore fallback errors
    }
  }
  // Sort by start time then index, dedupe identical time slots, and reindex sequentially
  let ordered = sessions.slice().sort((a, b) => {
    const sa = typeof a.start === 'number' ? a.start : 0;
    const sb = typeof b.start === 'number' ? b.start : 0;
    if (sa !== sb) return sa - sb;
    return (a.index || 0) - (b.index || 0);
  });
  const seen = new Set();
  const deduped = [];
  for (const s of ordered) {
    const key = `${s.start || 0}-${s.end || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }
  const needsReindex = deduped.some((s, i) => Number(s.index) !== i + 1);
  if (needsReindex) {
    return deduped.map((s, i) => ({ ...s, index: i + 1 }));
  }
  return deduped;
}

function persistReminders(reminders) {
  try { saveJson(SESSIONS_REMINDERS_PATH, reminders || []); } catch(e){console.error('persistReminders failed', e);} 
}

function loadPersistedReminders() {
  try { return loadJson(SESSIONS_REMINDERS_PATH, []); } catch(e) { return []; }
}

// --- SQLite reminders (optional migration) ---
let sqliteAvailable = false;
let sqlite3 = null;
try {
  sqlite3 = require('sqlite3').verbose();
  sqliteAvailable = true;
} catch (e) {
  console.warn('sqlite3 not available, falling back to JSON reminders');
}

function initSqlite() {
  if (!sqliteAvailable) return null;
  const db = new sqlite3.Database(SQLITE_DB_PATH);
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      messageId TEXT,
      channelId TEXT,
      userId TEXT,
      sessionIndex INTEGER,
      sendAt INTEGER,
      content TEXT
    )`);
    // Ensure legacy DBs get the `channelId` column (migration)
    try {
      db.all('PRAGMA table_info(reminders)', [], (err, rows) => {
        try {
          if (!err && Array.isArray(rows)) {
            const cols = rows.map(r => String(r.name).toLowerCase());
            if (!cols.includes('channelid')) {
              db.run('ALTER TABLE reminders ADD COLUMN channelId TEXT');
            }
          }
        } catch (ee) { /* ignore migration errors */ }
      });
    } catch (e) { /* ignore */ }
  });
  return db;
}

const sqliteDb = initSqlite();

// in-memory claim tracking: messageId -> Set of userIds
const sessionClaims = new Map();

function loadClaims() {
  try {
    const obj = loadJson(SESSIONS_CLAIMS_PATH, {});
    for (const k of Object.keys(obj || {})) {
      const arr = Array.isArray(obj[k]) ? obj[k] : [];
      sessionClaims.set(String(k), new Set(arr.map(String)));
    }
  } catch (e) { console.error('failed to load session claims', e); }
}

function saveClaims() {
  try {
    const out = {};
    for (const [k, s] of sessionClaims.entries()) out[k] = Array.from(s.values());
    saveJson(SESSIONS_CLAIMS_PATH, out);
  } catch (e) { console.error('failed to save session claims', e); }
}

loadClaims();

// Persisted session posts (messageId -> metadata)
function loadSessionPosts() {
  try {
    const obj = loadJson(SESSIONS_POSTS_PATH, {});
    sessionPostData.clear();
    sessionOriginToPosted.clear();
    for (const k of Object.keys(obj || {})) {
      try { sessionPostData.set(String(k), obj[k]); } catch (e) {}
      try {
        const data = obj[k];
        if (data && data.originMessageId) sessionOriginToPosted.set(String(data.originMessageId), String(k));
      } catch (e) {}
    }
  } catch (e) { console.error('failed to load session posts', e); }
}

function saveSessionPosts() {
  try {
    const out = {};
    for (const [k, v] of sessionPostData.entries()) out[k] = v;
    saveJson(SESSIONS_POSTS_PATH, out);
  } catch (e) { console.error('failed to save session posts', e); }
}

loadSessionPosts();

function sqlitePersistReminder(rem) {
  if (!sqliteDb) return;
  const stmt = sqliteDb.prepare('INSERT OR REPLACE INTO reminders (id,messageId,channelId,userId,sessionIndex,sendAt,content) VALUES (?,?,?,?,?,?,?)');
  stmt.run(rem.id, rem.messageId, rem.channelId || null, rem.userId, rem.sessionIndex, rem.sendAt, rem.content);
  stmt.finalize();
}

function sqliteRemoveReminder(id) {
  if (!sqliteDb) return;
  const stmt = sqliteDb.prepare('DELETE FROM reminders WHERE id = ?');
  stmt.run(id);
  stmt.finalize();
}

function sqliteLoadAllReminders() {
  return new Promise((resolve) => {
    if (!sqliteDb) return resolve([]);
    sqliteDb.all('SELECT * FROM reminders', [], (err, rows) => {
      if (err) return resolve([]);
      resolve(rows || []);
    });
  });
}

function scheduleReminderObject(rem) {
  if (REMINDERS_DISABLED) {
    try {
      if (sqliteDb) sqliteRemoveReminder(rem.id);
      else {
        const all = loadPersistedReminders().filter(r => r.id !== rem.id);
        persistReminders(all);
      }
    } catch (e) {}
    return;
  }
  const now = Date.now();
  const delay = Math.max(0, rem.sendAt - now);
  if (scheduledReminderTimeouts.has(rem.id)) return; // already scheduled
  const t = setTimeout(async () => {
    try {
      const chId = rem.channelId || rem.channel || null;
      if (chId) {
        const ch = client.channels.cache.get(String(chId)) || await client.channels.fetch(String(chId)).catch(()=>null);
        if (ch && (typeof ch.send === 'function')) {
          await ch.send({ content: `Reminder: session ${rem.sessionIndex ? 'S' + rem.sessionIndex : ''} starting at <t:${Math.floor(Number(rem.sendAt)/1000)}:t>.`, allowedMentions: { parse: [] } }).catch(()=>{});
        }
      }
    } catch (e) {
      console.error('scheduled reminder send failed', e);
    }
    // remove from persisted list
    try {
      if (sqliteDb) {
        sqliteRemoveReminder(rem.id);
      } else {
        const all = loadPersistedReminders().filter(r=>r.id !== rem.id);
        persistReminders(all);
      }
    } catch (e) {}
    scheduledReminderTimeouts.delete(rem.id);
  }, delay);
  scheduledReminderTimeouts.set(rem.id, t);
}

function rescheduleAllReminders() {
  (async () => {
    let all = [];
    if (sqliteDb) {
      all = await sqliteLoadAllReminders();
    } else {
      all = loadPersistedReminders();
    }
    for (const rem of all) {
      // normalize fields when coming from sqlite rows
      const rr = rem && rem.sendAt !== undefined ? rem : Object.assign({}, rem);
      if (rr.sendAt > Date.now()) scheduleReminderObject(rr);
      else {
        if (Date.now() - rr.sendAt < 5 * 60 * 1000) {
          scheduleReminderObject(Object.assign({}, rr, { sendAt: Date.now() + 2000 }));
        }
      }
    }
  })();
}

// session messageCreate handler moved later (after client initialization)

function nextDestaffCase() {
  destaffs.lastCase += 1;
  saveJson(DESTAFFS_PATH, destaffs);
  return destaffs.lastCase;
}

const PREFIX = process.env.PREFIX || '*';
const REMINDER_MINUTES = (process.env.SESSION_REMINDER_MINUTES ? parseInt(process.env.SESSION_REMINDER_MINUTES, 10) : 10) || 10; // minutes before session to send reminder
const REMINDERS_DISABLED = true;
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

// Prevent uncaught errors from crashing the process
client.on('error', (err) => {
  console.error('Discord client error', err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// Central Automod: run early to remove invite links and racist content, attempt mute, always log
client.on('messageCreate', async (message) => {
  try {
    if (!message || !message.guild || message.author?.bot) return;

    const AUTOMOD_LOG_CHANNEL_ID = '1466065677986299966';
    const text = String(message.content || '');
    console.log(`[automod] message from ${message.author.tag} (${message.author.id}) in guild ${message.guild.id} ch ${message.channel.id}: ${text.substring(0,200)}`);
    if (!text.trim()) return;

    // Fetch member info (we will enforce automod for all non-bot users)
    const member = await message.guild.members.fetch(message.author.id).catch(()=>null);

    // Detect invite links
    const inviteRe = /(https?:\/\/)?(www\.)?(discord\.gg|discordapp\.com\/invite|discord\.com\/invite)\/[A-Za-z0-9-_]+/i;
    const hasInvite = inviteRe.test(text);

    // Detect racist/blocked terms (configurable via AUTOMOD_CONFIG.blockedWords)
    const defaultBlocked = ['nigger','nigga','kike','chink','spic','coon', 'bitch', 'idiot', 'stupid', 'dumb', 'asshole', 'shit', 'fuck', 'cunt', 'twat', 'moron', 'trash'];
    const blocked = (AUTOMOD_CONFIG.blockedWords && Array.isArray(AUTOMOD_CONFIG.blockedWords)) ? AUTOMOD_CONFIG.blockedWords : defaultBlocked;
    const lc = text.toLowerCase();
    let hasRacist = false;
    const matchedWords = [];
    for (const w of blocked) {
      if (!w) continue;
      const re = new RegExp('\\b' + w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b', 'i');
      if (re.test(lc)) { hasRacist = true; matchedWords.push(w); }
    }

    if (!hasInvite && !hasRacist) {
      // no match
      return;
    }

    // Delete the message if bot has permission; record status for logging
    let deleted = false;
    try {
      const botMember = message.guild.members.me;
      const canDelete = botMember && botMember.permissions && botMember.permissions.has && botMember.permissions.has(PermissionsBitField.Flags.ManageMessages);
      const canModerate = botMember && botMember.permissions && botMember.permissions.has && botMember.permissions.has(PermissionsBitField.Flags.ModerateMembers);
      const channelPerms = botMember && typeof message.channel.permissionsFor === 'function' ? message.channel.permissionsFor(botMember) : null;
      const channelCanDelete = channelPerms && channelPerms.has && channelPerms.has(PermissionsBitField.Flags.ManageMessages);
      console.log('[automod] permission check — botManageMessages:', !!canDelete, 'botModerateMembers:', !!canModerate, 'channelAllowsDelete:', !!channelCanDelete);
      if (canDelete && channelCanDelete) {
        await message.delete().then(() => { deleted = true; }).catch((err) => { console.error('[automod] delete failed', err); deleted = false; });
      } else {
        // Try best-effort delete (may fail if no permission)
        try { await message.delete().then(() => { deleted = true; }).catch((err) => { console.error('[automod] best-effort delete failed', err); deleted = false; }); } catch (e) { deleted = false; }
      }
    } catch (e) { console.error('[automod] deletion check failed', e); deleted = false; }

    // Prepare reason parts for embed
    const reasonParts = [];
    if (hasInvite) reasonParts.push('Invite-Link');
    if (hasRacist) reasonParts.push(`Rassistische Inhalte${matchedWords.length?` (${matchedWords.slice(0,4).join(', ')})`:''}`);

    // Attempt to timeout (mute) the member for configured minutes (default 2) if bot has permission
    let muted = false;
    let muteError = null;
    const muteMinutes = (AUTOMOD_CONFIG && Number(AUTOMOD_CONFIG.muteMinutes)) ? Number(AUTOMOD_CONFIG.muteMinutes) : 2;
    try {
      const botMember = message.guild.members.me;
      const canModerate = botMember && botMember.permissions && botMember.permissions.has && botMember.permissions.has(PermissionsBitField.Flags.ModerateMembers);
      if (canModerate) {
        const mm = member || await message.guild.members.fetch(message.author.id).catch(()=>null);
        if (mm && typeof mm.timeout === 'function' && muteMinutes && muteMinutes > 0) {
          await mm.timeout(muteMinutes * 60 * 1000, `Automod enforcement: ${reasonParts.join(' + ')}`);
          muted = true;
        }
      } else {
        muted = false;
      }
    } catch (e) { muted = false; muteError = String(e && e.message ? e.message : e); }

    // Mirror automod enforcement to modlogs.json + actions.md (unified case format)
    try {
      const mdReason = reasonParts.length ? reasonParts.join(' + ') : 'No reason provided';
      if (deleted || muted) {
        const chName = message.channel && message.channel.name ? `#${message.channel.name}` : null;
        const preview = text.substring(0, 200).replace(/\s+/g, ' ').trim();
        const type = muted ? 'AutoMute' : 'AutoModDelete';
        const durationMs = muted ? (muteMinutes * 60 * 1000) : undefined;

        createModlogCase({
          guild: message.guild,
          type,
          userId: message.author.id,
          moderatorId: 'AutoMod',
          reason: mdReason,
          durationMs,
          extra: {
            channelId: message.channel ? String(message.channel.id) : null,
            channelName: chName,
            messageId: message.id ? String(message.id) : null,
            deleted: !!deleted,
            timedOut: !!muted,
            preview: preview || null,
          }
        });
      }
    } catch (e) {}

    // Log removal
    try {
      // Try configured ID first, then channel names in the guild, then fallback to findLogChannel
      let logCh = await client.channels.fetch(AUTOMOD_LOG_CHANNEL_ID).catch(()=>null);
      if (!logCh && message.guild && AUTOMOD_CONFIG.logChannelNames && Array.isArray(AUTOMOD_CONFIG.logChannelNames)) {
        for (const nm of AUTOMOD_CONFIG.logChannelNames) {
          if (!nm) continue;
          const f = message.guild.channels.cache.find(c => String(c.name).toLowerCase() === String(nm).toLowerCase());
          if (f) { logCh = f; break; }
        }
      }
      if (!logCh) logCh = findLogChannel(message.guild);

      const embed = new EmbedBuilder()
        .setTitle('Automod — Nachricht entfernt')
        .setColor(0xE74C3C)
        .addFields(
          { name: 'User', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
          { name: 'Channel', value: `${message.guild ? `${message.guild.name} / #${message.channel.name}` : message.channel.id}`, inline: true },
          { name: 'Grund', value: reasonParts.length ? reasonParts.join(' + ') : 'Unbekannt', inline: false },
          { name: 'Matched', value: matchedWords.length ? matchedWords.slice(0,8).join(', ') : '—', inline: false },
          { name: 'Inhalt', value: text.substring(0, 1900) || '(leer)', inline: false }
        ).setTimestamp();

      console.log('[automod] detected; deleted:', deleted, 'muted:', muted, 'will log to', logCh ? `${logCh.guild ? logCh.guild.id : 'unknown'}/${logCh.id}` : 'none');
      // add deletion status and timeout info to embed
      try {
        embed.addFields({ name: 'Gelöscht', value: deleted ? 'Ja' : 'Nein (fehlende Berechtigung)', inline: true });
        embed.addFields({ name: 'Timeout', value: muted ? `Ja — ${muteMinutes} Minuten` : `Nein${muteError ? ` — Fehler: ${muteError}` : ' (fehlende Berechtigung)'}`, inline: true });
      } catch (e) {}
      if (logCh && typeof logCh.send === 'function') await logCh.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => { console.error('automod send failed', err); });
    } catch (e) { console.error('automod log failed', e); }

  } catch (e) { console.error('automod early handler failed', e); }
});

async function safeReply(interaction, replyOptions) {
  try {
    if (!interaction) return null;
    if (interaction.replied || interaction.deferred) return interaction.editReply(replyOptions).catch(()=>null);
    return interaction.reply(replyOptions).catch(()=>null);
    } catch (e) {
    console.error('safeReply failed', e);
    try { if (interaction && !interaction.replied) interaction.reply({ content: 'Error sending reply.', ephemeral: true }).catch(()=>null); } catch (e) {}
    return null;
  }
}

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
    const res = await user.send(typeof content === 'string' ? { content } : content).catch(()=>null);

    // Mirror non-announcement DMs to a configured message-log channel for visibility (but not re-post announcements)
    try {
      const MIRROR_DM_CHANNEL_ID = process.env.MIRROR_DM_CHANNEL_ID || '1465397261105238100';
      if (MIRROR_DM_CHANNEL_ID) {
        // derive a textual summary of the content to decide whether it's an announcement
        let text = '';
        if (typeof content === 'string') text = content;
        else if (content && typeof content === 'object') {
          if (content.content) text = String(content.content);
          else if (Array.isArray(content.embeds) && content.embeds.length) {
            const e = content.embeds[0];
            text = (e.title ? e.title + '\n' : '') + (e.description || '');
          } else text = JSON.stringify(content).slice(0, 1900);
        }

        const isAnnouncement = /Duo Practice Session|Registration Opens|Game 1\/3|<t:\d+:t>/i.test(text || '');
        if (!isAnnouncement) {
          const ch = await client.channels.fetch(String(MIRROR_DM_CHANNEL_ID)).catch(()=>null);
          if (ch && typeof ch.send === 'function') {
            const header = `DM to <@${user.id}> (${user.tag}):`;
            // send as plain text to avoid accidental mentions
            try { await ch.send({ content: `${header}\n${text}`.slice(0, 2000), allowedMentions: { parse: [] } }).catch(()=>null); } catch (e) {}
          }
        }
      }
    } catch (e) { console.error('failed to mirror DM to log channel', e); }

    return res;
  } catch (e) { console.error('sendSessionDm failed', e); return null; }
}

// Watch for session posts in the Beta sessions channel and schedule DMs
client.on('messageCreate', async (message) => {
  try {
    if (!message) return;
    const isBot = Boolean(message.author?.bot);
    const isSelf = Boolean(client.user && message.author && message.author.id === client.user.id);
    const isWebhook = Boolean(message.webhookId);
    // Build a best-effort textual representation of the message: prefer content, fall back to embed text
    let contentText = '';
    try {
      if (typeof message.content === 'string' && message.content.trim()) contentText = message.content;
      else if (Array.isArray(message.embeds) && message.embeds.length) {
        const parts = [];
        for (const e of message.embeds) {
          try {
            if (e.title) parts.push(String(e.title));
            if (e.description) parts.push(String(e.description));
            if (Array.isArray(e.fields)) for (const f of e.fields) parts.push(String(f.name || '') + ' ' + String(f.value || ''));
          } catch (ee) {}
        }
        contentText = parts.join('\n').trim();
      }
    } catch (e) { contentText = typeof message.content === 'string' ? message.content : ''; }
    // Debug logging to trace why messages may be skipped
    try {
      console.log('[session-debug] incoming message:', {
        id: message.id,
        channelId: message.channel?.id,
        channelName: message.channel?.name,
        authorId: message.author?.id,
        authorTag: message.author?.tag,
        isBot, isSelf, isWebhook, isSeed: !!message._isSeed,
        hasContent: !!contentText,
        contentPreview: (contentText || '').slice(0,120)
      });
    } catch (e) {}
    // Ignore our own messages to avoid processing duplicates; allow other bots in watched channels
    if (isBot && !message._isSeed) {
      if (isSelf) {
        console.log('[session-debug] ignoring self-authored message to avoid duplicate processing');
        return;
      }
      const allowBotInWatch = message.channel && (String(message.channel.id) === '1461370702895779945' || String(message.channel.id) === '1461370812639481888');
      if (!allowBotInWatch && !isWebhook) {
        console.log('[session-debug] skipping other bot message');
        return;
      }
    }
    if (!message.channel) return;
    if (!contentText && !message._isSeed) {
      console.log('[session-debug] no text content to parse (no content and no embed text)');
      return;
    }

    // Message create logging removed per user request.

    const originalRawFull = String(contentText || '');

    // Global help triggered by `-help` (legacy/dash help)
    try {
      const txt = String(message.content || '').trim();
      if (txt === '-help' || txt.startsWith('-help ')) {
        const help = new EmbedBuilder()
          .setTitle('Session System — Help (Quick overview)')
          .setColor(0x87CEFA)
          .setDescription('Overview of available session commands (Slash & Prefix)')
          .addFields(
            { name: 'Slash (recommended)', value: '/session create, /session list, /session cancel, /session remindnow, /session watch add/remove, /session migrate, /session logs, /session simulate', inline: false },
            { name: 'Prefix', value: '!session help, !session list, !session cancel <id>, !session testpost <alpha|beta> "message"', inline: false },
            { name: 'Slash example', value: '/session create type:alpha registration_time:1768568400 game_time:1768569300 staff:@Rakim links:"https://..."', inline: false },
            { name: 'Prefix example', value: '!session testpost alpha "1. 17:00 - 17:15\nStaff: @Rakim"', inline: false },
            { name: 'Admin', value: 'watch/migrate/cancel/remindnow/simulate should be used by admins only.', inline: false },
            { name: 'Logs', value: 'All session logs are posted to channel <#1461475110761533451> as light-blue embeds.', inline: false }
          )
          .setFooter({ text: 'For more details: use /session help or !session help' })
          .setTimestamp();
        try { await message.channel.send({ embeds: [help] }); } catch (e) { /* ignore */ }
        return;
      }
    } catch (e) {}

    // Prefix command handler (e.g., !session help, !session testpost ...)
    if (typeof message.content === 'string' && message.content.startsWith(PREFIX)) {
      const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
      const cmd = (args.shift() || '').toLowerCase();
      // quick top-level create command: `*create <full announcement...>`
      if (cmd === 'create') {
        const rest = message.content.slice((PREFIX + 'create').length).trim();
                 if (!rest) return message.channel.send('Please paste the announcement after `*create`.');
        const processedRest = rest.replace(/\\n/g, '\n');
        const fakeMsg = { id: `sim_${Date.now()}`, author: message.author, content: processedRest, channel: message.channel, createdAt: new Date(), react: async () => {}, _isSeed: true };
                 try { client.emit('messageCreate', fakeMsg); await message.channel.send('Announcement imported and processed.'); } catch (e) { await message.channel.send('Import failed.'); }
        return;
      }
      if (cmd === 'session') {
        const sub = (args.shift() || '').toLowerCase();
        if (sub === 'create') {
          const rest = args.join(' ').trim();
                     if (!rest) return message.channel.send('Please paste the announcement after `*session create`.');
          const processedRest = rest.replace(/\\n/g, '\n');
          const fakeMsg = { id: `sim_${Date.now()}`, author: message.author, content: processedRest, channel: message.channel, createdAt: new Date(), react: async () => {}, _isSeed: true };
                     try { client.emit('messageCreate', fakeMsg); await message.channel.send('Announcement imported and processed.'); } catch (e) { await message.channel.send('Import failed.'); }
          return;
        }
           if (sub === 'help' || !sub) {
           const help = new EmbedBuilder()
             .setTitle('Session System — Help')
             .setColor(0x87CEFA)
             .setDescription('Available commands (Slash & Prefix)')
             .addFields(
               { name: '!session help', value: 'Show this help', inline: false },
               { name: '!session list', value: 'List scheduled reminders (Admin/Staff)', inline: false },
               { name: '!session cancel <id>', value: 'Remove a reminder', inline: false },
               { name: '!session testpost <alpha|beta> "message"', value: 'Simulate a channel message for testing', inline: false }
             ).setTimestamp();
           try { await message.channel.send({ embeds: [help] }); } catch (e) {}
           return;
         }
        if (sub === 'testpost') {
          const mode = (args.shift() || '').toLowerCase();
            const rest = args.join(' ');
            const processedRest = rest.replace(/\\n/g, '\n');
          const fakeChannelId = (mode === 'alpha') ? '1461370812639481888' : (mode === 'beta' ? '1461370702895779945' : message.channel.id);
          const fakeChannel = { id: fakeChannelId, send: async () => {}, isTextBased: () => true };
            const fakeMsg = { id: `sim_${Date.now()}`, author: message.author, content: processedRest, channel: fakeChannel, createdAt: new Date(), react: async () => {}, _isSeed: true };
          try {
            client.emit('messageCreate', fakeMsg);
            await message.channel.send('Simulation sent.');
            // Also parse and post the embed into the invoking channel so the user sees the parsed result
            try {
                const sessions = parseSessionMessage(processedRest, new Date());
              if (sessions && sessions.length) {
                const lines = sessions.map(s => `• ${s.index}. <t:${Math.floor(s.start/1000)}:t> - <t:${Math.floor(s.end/1000)}:t> — Staff: ${s.staff || 'Unassigned'}`);
                const simEmbed = new EmbedBuilder().setTitle('Simulated session (parsed)').setColor(0x87CEFA).setDescription(lines.join('\n')).setTimestamp();
                await message.channel.send({ embeds: [simEmbed] }).catch(()=>{});
              } else {
                await message.channel.send('No sessions detected in simulation.').catch(()=>{});
              }
            } catch (e) { console.error('failed to send simulation parsed embed', e); }
          } catch (e) { await message.channel.send('Simulation failed.'); }
          return;
        }
        if (sub === 'list') {
          try {
            const rows = sqliteDb ? await sqliteLoadAllReminders() : loadPersistedReminders();
            if (!rows || !rows.length) return message.channel.send('No scheduled reminders.');
            const parts = (rows||[]).slice(0,20).map(r => `• ${r.id} — <@${r.userId}> — <t:${Math.floor(r.sendAt/1000)}:t> — s${r.sessionIndex}`);
            await message.channel.send(parts.join('\n'));
          } catch (e) { await message.channel.send('Failed to read reminders.'); }
          return;
        }
        if (sub === 'cancel') {
          const id = args.shift();
          if (!id) return message.channel.send('Please provide a reminder ID.');
          try {
            if (sqliteDb) sqliteRemoveReminder(id);
            else {
              const all = loadPersistedReminders().filter(r => r.id !== id);
              persistReminders(all);
            }
            if (scheduledReminderTimeouts.has(id)) { clearTimeout(scheduledReminderTimeouts.get(id)); scheduledReminderTimeouts.delete(id); }
            return message.channel.send(`Reminder ${id} removed.`);
          } catch (e) { return message.channel.send('Failed to remove.'); }
        }
      }

      // Glücksrad command: *gluecksrad <opt1>|<opt2>|...  OR just *gluecksrad to use defaults
      if (cmd === 'gluecksrad' || cmd === 'gw') {
        try {
          const userId = message.author.id;
          const now = Date.now();
          const cd = Number(process.env.GLUECKSRAD_COOLDOWN_SECONDS || 30) * 1000;
          const last = wheelCooldowns.get(userId) || 0;
          if (now - last < cd) {
            const wait = Math.ceil((cd - (now - last)) / 1000);
            return message.channel.send({ embeds: [new EmbedBuilder().setColor(0xF39C12).setDescription(`Bitte warte ${wait}s bevor du erneut drehst.`)] });
          }

          const rest = message.content.slice((PREFIX + cmd).length).trim();
          const options = rest ? rest.split('|').map(s => s.trim()).filter(Boolean) : null;
          const defaults = ['10 Münzen', '50 Münzen', '100 Münzen', 'Nichts', 'Freilos', 'Spezial: Rolle'];
          const opts = options && options.length >= 2 ? options : defaults;

          // simple textual wheel frames for animation
          const frames = [];
          for (let i = 0; i < 12; i++) {
            const idx = i % opts.length;
            const line = opts.map((o, j) => (j === idx ? `➡️ ${o}` : `• ${o}`)).join('  ');
            frames.push(line);
          }

          const m = await message.channel.send({ embeds: [new EmbedBuilder().setTitle('Glücksrad — Drehe das Rad...').setDescription(frames[0]).setColor(0x00AAFF)] });
          // animate by editing message
          for (let i = 0; i < frames.length; i++) {
            // small delay
            // use increasing delay to simulate slowing
            const delay = 120 + i * 60;
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, delay));
            // eslint-disable-next-line no-await-in-loop
            await m.edit({ embeds: [new EmbedBuilder().setTitle('Glücksrad — Drehe das Rad...').setDescription(frames[i]).setColor(0x00AAFF)] }).catch(()=>{});
          }

          // pick random final
          const chosen = opts[Math.floor(Math.random() * opts.length)];
          await m.edit({ embeds: [new EmbedBuilder().setTitle('Glücksrad — Ergebnis').setDescription(`Das Rad blieb auf **${chosen}** stehen!`).setColor(0x87CEFA)] }).catch(()=>{});
          wheelCooldowns.set(userId, Date.now());

          // optional: react with confetti
          try { await m.react('🎉').catch(()=>{}); } catch (e) {}
          return;
        } catch (e) { console.error('gluecksrad failed', e); }
      }

      // --- Einrad: registration + 3 betting rounds -----------------------------
      if (cmd === 'einrad' || cmd === 'er') {
        const sub = (args.shift() || '').toLowerCase();
        const channelId = message.channel.id;
        const authorId = message.author.id;
        const now = Date.now();

        // Helper to show simple embed
        const sendEmbed = async (title, desc) => {
          return message.channel.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0x00AAFF)] });
        };

        // create/start registration: *einrad start <seconds to join> <rounds>
        if (sub === 'start') {
          if (einradGames.has(channelId)) return sendEmbed('Einrad', 'Ein Spiel läuft bereits in diesem Kanal.');
          const joinSec = parseInt(args.shift(), 10) || 30;
          const rounds = parseInt(args.shift(), 10) || 3;
          const game = {
            owner: authorId,
            state: 'joining',
            participants: new Map(), // userId -> { total: 0, bets: [] }
            rounds: rounds,
            currentRound: 0,
            joinUntil: now + joinSec * 1000
          };
          einradGames.set(channelId, game);
          // auto-close join after joinSec
          setTimeout(() => {
            const g = einradGames.get(channelId);
            if (g && g.state === 'joining') g.state = 'ready';
          }, joinSec * 1000);
          return sendEmbed('Einrad — Registrierung gestartet', `Registrierung offen für ${joinSec}s. Teilnehmer: bitte mit \`*einrad join\` beitreten.`);
        }

        if (sub === 'join') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('Einrad', 'Kein aktives Spiel. Starte eins mit `*einrad start`');
          if (g.state !== 'joining' && g.state !== 'ready') return sendEmbed('Einrad', 'Registrierung ist geschlossen.');
          if (g.participants.has(authorId)) return sendEmbed('Einrad', 'Du bist bereits angemeldet.');
          g.participants.set(authorId, { total: 0, bets: [] });
          return sendEmbed('Einrad', `Du bist angemeldet. Teilnehmeranzahl: ${g.participants.size}`);
        }

        if (sub === 'leave') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('Einrad', 'Kein aktives Spiel.');
          if (!g.participants.has(authorId)) return sendEmbed('Einrad', 'Du bist nicht angemeldet.');
          g.participants.delete(authorId);
          return sendEmbed('Einrad', `Du wurdest entfernt. Teilnehmeranzahl: ${g.participants.size}`);
        }

        // begin betting: only owner can start
        if (sub === 'begin') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('Einrad', 'Kein aktives Spiel.');
          if (g.owner !== authorId) return sendEmbed('Einrad', 'Nur der Spielstarter kann beginnen.');
          if (g.participants.size < 2) return sendEmbed('Einrad', 'Mindestens 2 Teilnehmer erforderlich.');
          if (g.state === 'playing') return sendEmbed('Einrad', 'Das Spiel läuft bereits.');
          g.state = 'playing';
          g.currentRound = 1;
          // notify
          await sendEmbed('Einrad — Runde 1 gestartet', `Teilnehmer: ${Array.from(g.participants.keys()).map(id=>`<@${id}>`).join(', ')}\nSetze jetzt mit \`*einrad bet <amount>\` (ganze Zahlen).`);
          return;
        }

        if (sub === 'bet') {
          const amount = parseInt(args.shift(), 10);
          if (isNaN(amount) || amount <= 0) return sendEmbed('Einrad', 'Bitte gib eine gültige Menge Münzen an (z. B. `*einrad bet 10`).');
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('Einrad', 'Kein aktives Spiel.');
          // If registration just ended (ready), start playing automatically on first bet
          if (g.state === 'ready') {
            if (g.participants.size < 2) return sendEmbed('Einrad', 'Mindestens 2 Teilnehmer erforderlich.');
            g.state = 'playing';
            g.currentRound = 1;
            await sendEmbed('Einrad — Runde 1 gestartet', `Teilnehmer: ${Array.from(g.participants.keys()).map(id=>`<@${id}>`).join(', ')}\nSetze jetzt mit \`*einrad bet <amount>\` (ganze Zahlen).`);
          }
          if (g.state !== 'playing') return sendEmbed('Einrad', 'Kein laufendes Spiel.');
          const p = g.participants.get(authorId);
          if (!p) return sendEmbed('Einrad', 'Du nimmst nicht teil. Trete mit `*einrad join` bei.');
          // record bet for current round
          p.total = (p.total || 0) + amount;
          p.bets.push({ round: g.currentRound, amount });
          return sendEmbed('Einrad', `Gesetzt ${amount} Münzen für Runde ${g.currentRound}. Gesamteinsätze: ${p.total}`);
        }

        if (sub === 'next') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('Einrad', 'Kein aktives Spiel.');
          if (g.owner !== authorId) return sendEmbed('Einrad', 'Nur der Spielstarter kann zur nächsten Runde wechseln.');
          if (g.state !== 'playing') return sendEmbed('Einrad', 'Spiel läuft nicht.');
          if (g.currentRound >= g.rounds) {
            // finish and announce winner (select by highest total)
            const standings = Array.from(g.participants.entries()).map(([uid, data]) => ({ uid, total: data.total || 0 }));
            standings.sort((a,b)=>b.total - a.total);
            const winner = standings[0];
            const lines = standings.map(s => `<@${s.uid}> — ${s.total} Münzen`).join('\n');

            // Wheel animation: cycle participant mentions and land on winner
            try {
              const parts = standings.map(s => `<@${s.uid}>`);
              if (parts.length === 0) {
                await sendEmbed('Einrad — Spiel beendet', 'Keine Teilnehmer.');
                einradGames.delete(channelId);
                return;
              }
              const spinMsg = await message.channel.send({ embeds: [new EmbedBuilder().setTitle('Einrad — Spin').setDescription('Das Rad dreht sich...').setColor(0x00AAFF)] });
              const roundsToSpin = 3 + Math.floor(Math.random() * 3);
              const totalSteps = roundsToSpin * parts.length + parts.indexOf(`<@${winner.uid}>`);
              for (let step = 0; step <= totalSteps; step++) {
                const idx = step % parts.length;
                const frame = parts.map((p, j) => (j === idx ? `➡️ ${p}` : `• ${p}`)).join('  ');
                const delay = 80 + Math.floor((step / totalSteps) * 600);
                // eslint-disable-next-line no-await-in-loop
                await new Promise(r => setTimeout(r, delay));
                // eslint-disable-next-line no-await-in-loop
                await spinMsg.edit({ embeds: [new EmbedBuilder().setTitle('Einrad — Spin').setDescription(frame).setColor(0x00AAFF)] }).catch(()=>{});
              }
              await spinMsg.edit({ embeds: [new EmbedBuilder().setTitle('Einrad — Spiel beendet').setDescription(`Ergebnis:\n${lines}\n\nGewinner: <@${winner.uid}> mit ${winner.total} Münzen!`).setColor(0x87CEFA)] }).catch(()=>{});
            } catch (e) {
              // fallback to text result
              await sendEmbed('Einrad — Spiel beendet', `Ergebnis:\n${lines}\n\nGewinner: <@${winner.uid}> mit ${winner.total} Münzen!`);
            }

            einradGames.delete(channelId);
            return;
          }
          g.currentRound += 1;
          await sendEmbed('Einrad', `Runde ${g.currentRound} gestartet — setzt jetzt!`);
          return;
        }

        if (sub === 'status') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('Einrad', 'Kein aktives Spiel.');
          const parts = [`Status: ${g.state}`, `Runde: ${g.currentRound}/${g.rounds}`, `Teilnehmer: ${g.participants.size}`];
          for (const [uid, data] of g.participants.entries()) parts.push(`${'<@'+uid+'> —'} ${data.total || 0} Münzen`);
          return sendEmbed('Einrad — Status', parts.join('\n'));
        }

        if (sub === 'cancel') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('Einrad', 'Kein aktives Spiel.');
          if (g.owner !== authorId && !message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return sendEmbed('Einrad', 'Nur Starter oder Moderator kann abbrechen.');
          einradGames.delete(channelId);
          return sendEmbed('Einrad', 'Spiel wurde abgebrochen.');
        }

        // help
        return sendEmbed('Einrad — Hilfe', '`*einrad start [joinSec] [rounds]` — Spiel starten\n`*einrad join` — mitmachen\n`*einrad bet <amount>` — setzt in aktueller Runde\n`*einrad next` — nächste Runde (Starter)\n`*einrad status` — Zwischenstand\n`*einrad cancel` — Abbrechen');
      }
    }

    // Only respond to the configured Alpha/Beta session channels (or likely session channels)
    const WATCH_CHANNEL_IDS = loadWatchChannels(message.guildId);
    const channelIdStr = String(message.channel.id);
    const channelName = String(message.channel?.name || '').toLowerCase();
    const isWatched = WATCH_CHANNEL_IDS.has(channelIdStr);
    const looksLikeSession = /\b\d+\.\s*[0-2]?\d:[0-5]\d\s*(?:-|–|to)\s*[0-2]?\d:[0-5]\d\b|registration\s*opens|game\s*1\/3|duo\s*practice\s*session|<t:\d+:t>/i.test(contentText);
    const nameLooksLikeSession = /(alpha|beta|session|sessions|claim|claiming)/i.test(channelName);
    // Debug info about why we might proceed or skip
    try {
      console.log('[session-debug] watch check:', { WATCH_CHANNEL_IDS: Array.from(WATCH_CHANNEL_IDS).slice(0,20), channelIdStr, channelName, isWatched, looksLikeSession, nameLooksLikeSession });
    } catch (e) {}
    if (!isWatched && !(looksLikeSession && nameLooksLikeSession)) {
      console.log('[session-debug] skipping: channel not watched and does not look like session');
      return;
    }

    const sessions = parseSessionMessage(contentText, message.createdAt);
    console.log('[session-debug] parsed sessions count:', Array.isArray(sessions) ? sessions.length : 0);
    if (!sessions || !sessions.length) {
      console.log('[session-debug] no sessions parsed from message content');
      return;
    }

    // Hard guarantee: in the two session-claiming channels, always post a fresh parsed summary with buttons
    try {
      const forceChannels = new Set(['1461370702895779945', '1461370812639481888']);
      if (message.channel && forceChannels.has(String(message.channel.id))) {
        const lines = sessions.map(s => `• ${s.index}. <t:${Math.floor(s.start/1000)}:t> - <t:${Math.floor(s.end/1000)}:t> — Staff: ${s.staff || 'Unassigned'}`);
        const sumEmbed = new EmbedBuilder()
          .setTitle('Session parsed')
          .setColor(0x87CEFA)
          .setDescription(lines.join('\n'))
          .setTimestamp();
        // remove any previous parsed summaries from the bot in this channel
        try {
          const recent = await message.channel.messages.fetch({ limit: 15 }).catch(()=>null);
          if (recent && typeof recent.filter === 'function') {
            const parsedMsgs = recent.filter(m =>
              m && m.author && client.user && m.author.id === client.user.id &&
              Array.isArray(m.embeds) && m.embeds[0] && String(m.embeds[0].title || '').toLowerCase() === 'session parsed'
            );
            for (const m of parsedMsgs.values()) await m.delete().catch(()=>{});
          }
        } catch (e) {}
        const rowsPending = buildSessionButtonRows('pending', sessions);
        const posted = await (typeof message.reply === 'function'
          ? message.reply({ embeds: [sumEmbed], components: rowsPending, allowedMentions: { parse: [] } })
          : message.channel.send({ embeds: [sumEmbed], components: rowsPending, allowedMentions: { parse: [] } })
        ).catch(()=>null);
        if (posted) {
          try {
            const rows2 = buildSessionButtonRows(posted.id, sessions);
            await posted.edit({ embeds: [sumEmbed], components: rows2 }).catch(()=>{});
          } catch (e) {}
          try {
            const rawVal = (typeof originalRawFull === 'string' && originalRawFull.length) ? originalRawFull.substring(0, 4000) : String(message.content || '').substring(0, 4000);
            sessionPostData.set(String(posted.id), { authorId: String(message.author.id), raw: rawVal, originChannelId: String(message.channel.id), originMessageId: String(message.id), guildId: message.guildId || (message.guild && message.guild.id) || null, parsed: sessions, postedAt: Date.now() });
            sessionOriginToPosted.set(String(message.id), String(posted.id));
            try { saveSessionPosts(); } catch (e) {}
          } catch (e) {}
        }
        // continue with logging, but avoid duplicate summary posting
        summaryHandled = true;
      }
    } catch (e) {}

    let summaryHandled = false;

    // If we already posted a summary for this origin message, update it instead of posting a new one
    try {
      const postedChannel = await client.channels.fetch(message.channel.id).catch(()=>null);
      if (postedChannel && typeof postedChannel.messages?.fetch === 'function') {
        const recent = await postedChannel.messages.fetch({ limit: 15 }).catch(()=>null);
        if (recent && typeof recent.filter === 'function') {
          const candidates = recent.filter(m =>
            m && m.author && client.user && m.author.id === client.user.id &&
            Array.isArray(m.embeds) && m.embeds[0] && String(m.embeds[0].title || '').toLowerCase() === 'session parsed'
          );
          if (candidates.size) {
            const countFromDesc = (m) => (String(m.embeds[0].description || '').match(/•\s*\d+\./g) || []).length;
            let keep = null;
            for (const m of candidates.values()) {
              if (!keep) keep = m;
              else {
                const a = countFromDesc(m);
                const b = countFromDesc(keep);
                if (a > b) keep = m;
                else if (a === b && m.createdTimestamp > keep.createdTimestamp) keep = m;
              }
            }
            // delete all other session-parsed embeds
            for (const m of candidates.values()) {
              if (keep && m.id !== keep.id) await m.delete().catch(()=>{});
            }
            if (keep) {
              let updated = false;
              const lines = sessions.map(s => `• ${s.index}. <t:${Math.floor(s.start/1000)}:t> - <t:${Math.floor(s.end/1000)}:t> — Staff: ${s.staff || 'Unassigned'}`);
              const sumEmbed = new EmbedBuilder()
                .setTitle('Session parsed')
                .setColor(0x87CEFA)
                .setDescription(lines.join('\n'))
                .setTimestamp();
              const components = [];
              const claimBtn = new ButtonBuilder().setCustomId(`session_claim:${keep.id}`).setLabel('Claim').setStyle(ButtonStyle.Primary);
              components.push(claimBtn);
              if (Array.isArray(sessions) && sessions.length) {
                for (const s of sessions.slice(0, 10)) {
                  const a = new ButtonBuilder().setCustomId(`session_announce:${keep.id}:${s.index}`).setLabel(`Announce S${s.index}`).setStyle(ButtonStyle.Success);
                  components.push(a);
                }
              }
              const row = new ActionRowBuilder().addComponents(...components);
              try {
                await keep.edit({ embeds: [sumEmbed], components: [row] }).catch(()=>{});
                updated = true;
              } catch (e) {}
              const rawVal = (typeof originalRawFull === 'string' && originalRawFull.length) ? originalRawFull.substring(0, 4000) : String(message.content || '').substring(0, 4000);
              sessionPostData.set(String(keep.id), { authorId: String(message.author.id), raw: rawVal, originChannelId: String(message.channel.id), originMessageId: String(message.id), guildId: message.guildId || (message.guild && message.guild.id) || null, parsed: sessions, postedAt: Date.now() });
              sessionOriginToPosted.set(String(message.id), String(keep.id));
              try { saveSessionPosts(); } catch (e) {}
              if (updated) summaryHandled = true;
            }
          }
        }
      }
    } catch (e) {}
    // Clean up stale parsed embeds in the same channel (keep only the best/latest one)
    try {
      const ch = message.channel;
      if (ch && typeof ch.messages?.fetch === 'function') {
        const recent = await ch.messages.fetch({ limit: 10 }).catch(()=>null);
        if (recent && typeof recent.filter === 'function') {
          const currentCount = sessions.length;
          const stale = recent.filter(m =>
            m && m.author && client.user && m.author.id === client.user.id &&
            Array.isArray(m.embeds) && m.embeds[0] && String(m.embeds[0].title || '').toLowerCase() === 'session parsed'
          );
          for (const m of stale.values()) {
            try {
              const desc = String(m.embeds[0].description || '');
              const count = (desc.match(/•\s*\d+\./g) || []).length;
              if (count && count < currentCount) {
                await m.delete().catch(()=>{});
              }
            } catch (ee) {}
          }
        }
      }
    } catch (e) {}
    try {
      const key = `session_parsed:${message.id}`;
      const now = Date.now();
      const last = recentSendCache.get(key);
      if (last && (now - last) < RECENT_SEND_WINDOW_MS) {
        console.log('[session-debug] recent duplicate detected, skipping parsed embed');
        return;
      }
      recentSendCache.set(key, now);
    } catch (e) {}

    const authorId = message.author.id;

    const extractMentionIds = (text) => {
      if (!text) return [];
      const ids = [];
      const re = /<@!?(\d+)>/g;
      let m;
      while ((m = re.exec(text)) !== null) ids.push(m[1]);
      return ids;
    };

    // Send a summary DM to the author listing parsed sessions and staffs
    try {
      const lines = sessions.map(s => `• ${s.index}. <t:${Math.floor(s.start/1000)}:t> - <t:${Math.floor(s.end/1000)}:t> — Staff: ${s.staff || 'Unassigned'}`);
      const sumEmbed = new EmbedBuilder()
        .setTitle('Session parsed')
        .setColor(0x87CEFA)
        .setDescription(lines.join('\n'))
        .setTimestamp();
      // Do not DM the author automatically when they post the announcement.
      // Previously the bot attempted to DM the author a parsed summary; that behavior was removed per request.
      try { await message.react('✅'); } catch (e) {}
      try {
        // Build a detailed sessions log embed containing the raw announcement and parsed sessions
        const raw = originalRawFull.substring(0, 1900);
        const parsedLines = lines.slice(0, 12).join('\n') || 'No parsed sessions';
        const safeParsed = parsedLines.length > 1000 ? parsedLines.slice(0, 1000) + '…' : parsedLines;
        const safeRaw = raw.length > 1000 ? raw.slice(0, 1000) + '…' : raw;
        const logEmbed = new EmbedBuilder()
          .setTitle('Session Announcement (full)')
          .setColor(0x87CEFA)
          .addFields(
            { name: 'Author', value: `<@${message.author.id}>`, inline: true },
            { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
            { name: 'Parsed Sessions', value: safeParsed, inline: false },
            { name: 'Raw Announcement (truncated)', value: safeRaw, inline: false }
          ).setTimestamp();
        try {
          await sendSessionsLog({ embeds: [logEmbed] }, message.guildId);
          await sendMessageLog(logEmbed, message.guildId);
        } catch(e) { console.error('failed to send sessions log', e); }
      } catch (e) { console.error('failed to send sessions log', e); }

      // Also post a light-blue embed into the same channel where the announcement was posted (helps visual confirmation)
      try {
        if (!summaryHandled && message && message.channel && typeof message.channel.send === 'function') {
          console.log('[session-debug] attempting to post parsed summary embed into origin channel', message.channel.id);
          // prepare buttons for immediate attach
          const components = [];
          const claimBtn = new ButtonBuilder().setCustomId(`session_claim:pending`).setLabel('Claim').setStyle(ButtonStyle.Primary);
          components.push(claimBtn);
          if (Array.isArray(sessions) && sessions.length) {
            for (const s of sessions.slice(0, 10)) {
              const a = new ButtonBuilder().setCustomId(`session_announce:pending:${s.index}`).setLabel(`Announce S${s.index}`).setStyle(ButtonStyle.Success);
              components.push(a);
            }
          }
          const row = new ActionRowBuilder().addComponents(...components);
          const posted = await message.channel.send({ embeds: [sumEmbed], components: [row] }).catch((err)=>{ console.error('[session-debug] failed to send parsed summary embed', err); return null; });
          // Do not send @everyone when the author posts the original announcement (avoid pinging on initial post)
                if (posted) {
            console.log('[session-debug] parsed summary embed posted, id=', posted.id);
            try {
              const claimBtn = new ButtonBuilder().setCustomId(`session_claim:${posted.id}`).setLabel('Claim').setStyle(ButtonStyle.Primary);
              const components = [claimBtn];
              // add per-session announce buttons
              try {
                if (Array.isArray(sessions) && sessions.length) {
                  for (const s of sessions.slice(0, 10)) {
                    const a = new ButtonBuilder().setCustomId(`session_announce:${posted.id}:${s.index}`).setLabel(`Announce S${s.index}`).setStyle(ButtonStyle.Success);
                    components.push(a);
                  }
                } else {
                  const a = new ButtonBuilder().setCustomId(`session_announce:${posted.id}:1`).setLabel('Announce').setStyle(ButtonStyle.Success);
                  components.push(a);
                }
              } catch (e) { const a = new ButtonBuilder().setCustomId(`session_announce:${posted.id}:1`).setLabel('Announce').setStyle(ButtonStyle.Success); components.push(a); }
              // NOTE: `Get` button removed — Announce will DM the clicking user now
              const row = new ActionRowBuilder().addComponents(...components);
              await posted.edit({ embeds: [sumEmbed], components: [row] }).catch(()=>{});
              sessionClaims.set(posted.id, new Set());
              // store original raw announcement and metadata to allow announcing later
                try {
                const rawVal = (typeof originalRawFull === 'string' && originalRawFull.length) ? originalRawFull.substring(0, 4000) : String(message.content || '').substring(0, 4000);
                sessionPostData.set(String(posted.id), { authorId: String(message.author.id), raw: rawVal, originChannelId: String(message.channel.id), originMessageId: String(message.id), guildId: message.guildId || (message.guild && message.guild.id) || null, parsed: sessions, postedAt: Date.now() });
                sessionOriginToPosted.set(String(message.id), String(posted.id));
                try { saveSessionPosts(); } catch (ee3) { console.error('failed to persist session post data', ee3); }
              } catch (ee2) { console.error('failed to store session post data', ee2); }
              // Remind buttons removed (reminders disabled)
            } catch (ee) { console.error('failed to attach claim/announce buttons', ee); }
          }
        }
      } catch (e) { console.error('failed to post parsed embed in original channel', e); }
      // Final safeguard: ensure latest parsed embed in-channel has buttons or post one if missing
      try {
        const ch = message.channel;
        if (ch && typeof ch.messages?.fetch === 'function') {
          const recent = await ch.messages.fetch({ limit: 15 }).catch(()=>null);
          if (recent && typeof recent.filter === 'function') {
            const parsedMsgs = recent.filter(m =>
              m && m.author && client.user && m.author.id === client.user.id &&
              Array.isArray(m.embeds) && m.embeds[0] && String(m.embeds[0].title || '').toLowerCase() === 'session parsed'
            );
            if (!parsedMsgs.size) {
              const components = [];
              const claimBtn = new ButtonBuilder().setCustomId(`session_claim:pending`).setLabel('Claim').setStyle(ButtonStyle.Primary);
              components.push(claimBtn);
              if (Array.isArray(sessions) && sessions.length) {
                for (const s of sessions.slice(0, 10)) {
                  const a = new ButtonBuilder().setCustomId(`session_announce:pending:${s.index}`).setLabel(`Announce S${s.index}`).setStyle(ButtonStyle.Success);
                  components.push(a);
                }
              }
              const row = new ActionRowBuilder().addComponents(...components);
              const posted = await ch.send({ embeds: [sumEmbed], components: [row] }).catch(()=>null);
              if (posted) {
                try {
                  const claimBtn2 = new ButtonBuilder().setCustomId(`session_claim:${posted.id}`).setLabel('Claim').setStyle(ButtonStyle.Primary);
                  const comps2 = [claimBtn2];
                  if (Array.isArray(sessions) && sessions.length) {
                    for (const s of sessions.slice(0, 10)) {
                      const a = new ButtonBuilder().setCustomId(`session_announce:${posted.id}:${s.index}`).setLabel(`Announce S${s.index}`).setStyle(ButtonStyle.Success);
                      comps2.push(a);
                    }
                  }
                  const row2 = new ActionRowBuilder().addComponents(...comps2);
                  await posted.edit({ embeds: [sumEmbed], components: [row2] }).catch(()=>{});
                } catch (e) {}
                try {
                  const rawVal = (typeof originalRawFull === 'string' && originalRawFull.length) ? originalRawFull.substring(0, 4000) : String(message.content || '').substring(0, 4000);
                  sessionPostData.set(String(posted.id), { authorId: String(message.author.id), raw: rawVal, originChannelId: String(message.channel.id), originMessageId: String(message.id), guildId: message.guildId || (message.guild && message.guild.id) || null, parsed: sessions, postedAt: Date.now() });
                  sessionOriginToPosted.set(String(message.id), String(posted.id));
                  try { saveSessionPosts(); } catch (e) {}
                } catch (e) {}
              }
            }
            if (parsedMsgs.size) {
              const countFromDesc = (m) => (String(m.embeds[0].description || '').match(/•\s*\d+\./g) || []).length;
              let keep = null;
              for (const m of parsedMsgs.values()) {
                if (!keep) keep = m;
                else {
                  const a = countFromDesc(m);
                  const b = countFromDesc(keep);
                  if (a > b) keep = m;
                  else if (a === b && m.createdTimestamp > keep.createdTimestamp) keep = m;
                }
              }
              if (keep) {
                const lines = sessions.map(s => `• ${s.index}. <t:${Math.floor(s.start/1000)}:t> - <t:${Math.floor(s.end/1000)}:t> — Staff: ${s.staff || 'Unassigned'}`);
                const sumEmbed = new EmbedBuilder()
                  .setTitle('Session parsed')
                  .setColor(0x87CEFA)
                  .setDescription(lines.join('\n'))
                  .setTimestamp();
                const components = [];
                const claimBtn = new ButtonBuilder().setCustomId(`session_claim:${keep.id}`).setLabel('Claim').setStyle(ButtonStyle.Primary);
                components.push(claimBtn);
                if (Array.isArray(sessions) && sessions.length) {
                  for (const s of sessions.slice(0, 10)) {
                    const a = new ButtonBuilder().setCustomId(`session_announce:${keep.id}:${s.index}`).setLabel(`Announce S${s.index}`).setStyle(ButtonStyle.Success);
                    components.push(a);
                  }
                }
                const row = new ActionRowBuilder().addComponents(...components);
                await keep.edit({ embeds: [sumEmbed], components: [row] }).catch(()=>{});
              }
            }
          }
        }
      } catch (e) {}
    } catch (e) { console.error('failed to DM author session summary', e); }

    // Reminders disabled: do not DM or schedule session reminders.
    try { await ensureParsedButtons(message.channel, sessions); } catch (e) {}
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

// Helper: parse time string (HH:MM or unix seconds) to unix seconds
function parseTimeToUnixSeconds(input, referenceDate) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{9,}$/.test(s)) return parseInt(s, 10); // already unix seconds
  const m = s.match(/^([0-2]?\d):([0-5]\d)$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    const ref = referenceDate instanceof Date ? new Date(referenceDate) : new Date();
    const d = new Date(ref);
    d.setHours(h, min, 0, 0);
    // if time already passed today, roll to next day
    if (d.getTime() + 60000 < ref.getTime()) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }
  return null;
}

client.on('interactionCreate', async (interaction) => {
  // Ticket system: create + close button interactions
  try {
    // Handle `/session` slash command centrally here (consolidated into index.js)
    if (interaction.isChatInputCommand() && interaction.commandName === 'session') {
      try {
        const sub = (() => { try { return interaction.options.getSubcommand(false); } catch (e) { return null; } })();
        if (!sub) {
          const help = new EmbedBuilder()
            .setTitle('Session System — Help')
            .setColor(0x87CEFA)
            .setDescription('Available subcommands for /session')
            .addFields(
              { name: 'create', value: 'Create a session announcement (Admin)', inline: false },
              { name: 'list', value: 'List scheduled reminders', inline: false },
              { name: 'cancel', value: 'Remove a reminder (id)', inline: false },
              { name: 'remindnow', value: 'Send a reminder immediately (id)', inline: false },
              { name: 'watch add/remove', value: 'Manage watched channels (Admin)', inline: false },
              { name: 'simulate', value: 'Simulate a channel message for E2E tests (Admin)', inline: false },
              { name: 'logs', value: 'Show recent logs from the sessions channel', inline: false }
            ).setTimestamp();
          return interaction.reply({ embeds: [help], ephemeral: true });
        }

        if (sub === 'create') {
          const type = interaction.options.getString('type', true);
          const regTime = interaction.options.getString('registration_time', true);
          const gameTime = interaction.options.getString('game_time', true);
          const staff = interaction.options.getUser('staff', true);
          const linksRaw = interaction.options.getString('links') || 'See session rules channels in server.';
          const links = linksRaw.split(',').map(l => l.trim()).slice(0,3).join(', ');
          const regTs = parseInt(regTime, 10);
          const gameTs = parseInt(gameTime, 10);
          if (isNaN(regTs) || isNaN(gameTs)) return interaction.reply({ content: 'Invalid timestamps.', ephemeral: true });
          const sessionLabel = type === 'alpha' ? ':alpha:' : ':beta:';
          let saBuilder = null;
          try { saBuilder = require(path.join(DATA_DIR, 'commands', 'sa.js')); } catch (e) { saBuilder = null; }
          let content = `### Duo Practice Session ${sessionLabel}\n\n> * **Registration Opens:** <t:${regTs}:t>\n> * **Game 1/3:** <t:${gameTs}:t>\n\nStaff in charge: <@${staff.id}>\n\n${links}`;
          if (saBuilder && typeof saBuilder.buildAnnouncement === 'function') {
            try { content = saBuilder.buildAnnouncement({ mode: type, regTs, gameTs, staffMentions: `<@${staff.id}>`, includeEveryone: true }); } catch (e) {}
          } else {
            content = content + "\n\n@everyone";
          }
          await interaction.reply({ content, allowedMentions: { parse: ['users','roles'], everyone: true } });
          return;
        }

        if (sub === 'list') {
          const rows = sqliteDb ? await sqliteLoadAllReminders() : loadPersistedReminders();
          if (!rows || !rows.length) return interaction.reply({ content: 'No scheduled reminders.', ephemeral: true });
          const parts = (rows||[]).slice(0,20).map(r => `• ${r.id} — <@${r.userId}> — <t:${Math.floor(r.sendAt/1000)}:t> — session ${r.sessionIndex}`);
          return interaction.reply({ content: parts.join('\n'), ephemeral: true });
        }

        if (sub === 'cancel') {
          const id = interaction.options.getString('id', true);
          try {
            if (sqliteDb) sqliteRemoveReminder(id);
            else { const all = loadPersistedReminders().filter(r => r.id !== id); persistReminders(all); }
            if (scheduledReminderTimeouts.has(id)) { clearTimeout(scheduledReminderTimeouts.get(id)); scheduledReminderTimeouts.delete(id); }
            return interaction.reply({ content: `Reminder ${id} removed.`, ephemeral: true });
          } catch (e) { return interaction.reply({ content: 'Failed to remove.', ephemeral: true }); }
        }

        if (sub === 'remindnow') {
          const id = interaction.options.getString('id', true);
          const rows = sqliteDb ? await sqliteLoadAllReminders() : loadPersistedReminders();
          const rem = (rows||[]).find(r => r.id === id);
          if (!rem) return interaction.reply({ content: 'Reminder not found.', ephemeral: true });
          try { const u = await client.users.fetch(String(rem.userId)).catch(()=>null); if (u) await u.send(rem.content || `Reminder for session ${rem.sessionIndex}`); } catch (e) {}
          return interaction.reply({ content: `Reminder ${id} sent.`, ephemeral: true });
        }

        const group = (() => { try { return interaction.options.getSubcommandGroup(false); } catch (e) { return null; } })();
        if (group === 'watch') {
          const op = interaction.options.getSubcommand(true);
          const ch = interaction.options.getChannel('channel', true);
          if (op === 'add') { addWatchChannel(interaction.guildId, ch.id); return interaction.reply({ content: `Channel <#${ch.id}> is now being watched.`, ephemeral: true }); }
          else { removeWatchChannel(interaction.guildId, ch.id); return interaction.reply({ content: `Channel <#${ch.id}> removed from watch.`, ephemeral: true }); }
        }

        if (sub === 'simulate') {
          const ch = interaction.options.getChannel('channel', true);
          const content = interaction.options.getString('content', true);
          const fakeMsg = { id: `sim_${Date.now()}`, author: interaction.user, content, channel: ch, createdAt: new Date(), react: async () => {}, _isSeed: true };
          try { client.emit('messageCreate', fakeMsg); return interaction.reply({ content: 'Simulation sent — check DMs/Logs.', ephemeral: true }); } catch (e) { return interaction.reply({ content: 'Simulation failed.', ephemeral: true }); }
        }

        if (sub === 'panel') {
          const ch = (() => { try { return interaction.options.getChannel('channel'); } catch (e) { return null; } })();
          const targetId = ch ? String(ch.id) : '1465130887716012117';
          try {
            const target = await client.channels.fetch(targetId).catch(() => null);
            if (!target || !target.isTextBased()) return interaction.reply({ content: 'Target channel not accessible or not a text channel.', ephemeral: true });
            const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
            // include a snapshot of current persisted reminders/sessions in the panel
            let reminderRows = [];
            try {
              reminderRows = sqliteDb ? await sqliteLoadAllReminders() : loadPersistedReminders();
            } catch (e) { reminderRows = []; }
            const total = (reminderRows && reminderRows.length) ? reminderRows.length : 0;
            const top = (reminderRows || []).slice(0, 10);
            const embed = new EmbedBuilder()
              .setTitle('Session Admin Panel')
              .setColor(0x87CEFA)
              .setDescription(`Controls to manage scheduled session reminders and posts.\n\n**Persisted reminders:** ${total} (showing up to 10)\n\n- **List Reminders** shows upcoming scheduled reminders.\n- **Reschedule All** re-schedules persisted reminders into timeouts.\n- **Purge JSON** clears JSON reminders storage (does not touch SQLite).\n- **Close Panel** removes this panel message.`)
              .setTimestamp();
            if (top && top.length) {
              for (const r of top) {
                const sendAt = r.sendAt ? Math.floor(Number(r.sendAt) / 1000) : Math.floor(Date.now() / 1000);
                const title = `${r.id} — ${r.userId ? `<@${r.userId}>` : 'unknown'}`;
                const value = `Session ${r.sessionIndex || 'n/a'} • <t:${sendAt}:f>` + (r.channelId ? ` • <#${r.channelId}>` : '');
                try { embed.addFields({ name: title.slice(0, 256), value: value.slice(0, 1024) }); } catch (e) {}
              }
            }
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('admin_list').setLabel('List Reminders').setStyle(ButtonStyle.Primary),
              new ButtonBuilder().setCustomId('admin_reschedule').setLabel('Reschedule All').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId('admin_purge_json').setLabel('Purge JSON Reminders').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId('admin_close').setLabel('Close Panel').setStyle(ButtonStyle.Secondary)
            );
            const sent = await target.send({ embeds: [embed], components: [row] });
            const link = (sent && sent.url) ? sent.url : `${target}`;
            return interaction.reply({ content: `Admin panel posted: ${link}`, ephemeral: false });
          } catch (e) {
            console.error('failed to post admin panel', e);
            return interaction.reply({ content: 'Failed to post admin panel.', ephemeral: true });
          }
        }

        if (sub === 'logs') {
          const count = 10;
          try { const chId = resolveSessionsLogChannelId(interaction.guildId); const ch = chId ? await client.channels.fetch(chId).catch(()=>null) : null; if (!ch || !ch.isTextBased()) return interaction.reply({ content: 'Log channel not accessible.', ephemeral: true }); const msgs = await ch.messages.fetch({ limit: count }); const out = Array.from(msgs.values()).slice(0,count).map(m => `• ${m.author?.tag || m.author?.id || 'bot'} — ${m.createdAt.toISOString()} — ${m.embeds?.[0]?.title || m.content || '[embed]'}`); return interaction.reply({ content: out.join('\n') || 'No logs found.', ephemeral: true }); } catch (e) { return interaction.reply({ content: 'Failed to read logs.', ephemeral: true }); }
        }
        return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
      } catch (e) {
        console.error('session slash handling failed', e);
        try { await interaction.reply({ content: 'Error executing the session command.', ephemeral: true }); } catch (e) {}
      }
    }
    // slash /create -> show modal for pasting announcement
    if (interaction.isChatInputCommand() && interaction.commandName === 'create') {
      try {
        const modal = new ModalBuilder().setCustomId('create_modal').setTitle('Paste session announcement');
        const input = new TextInputBuilder().setCustomId('announcement_text').setLabel('Announcement').setStyle(TextInputStyle.Paragraph).setRequired(true).setPlaceholder('Paste the full announcement here...').setMinLength(10).setMaxLength(4000);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
      } catch (e) { console.error('failed to show create modal', e); try { await interaction.reply({ content: 'Failed to open modal.', ephemeral: true }); } catch (e) {} }
      return;
    }

    // modal submit for create
    if (interaction.isModalSubmit() && interaction.customId === 'create_modal') {
      try {
        const text = interaction.fields.getTextInputValue('announcement_text');
        const fakeMsg = { id: `sim_${Date.now()}`, author: interaction.user, content: text, channel: interaction.channel, createdAt: new Date(), react: async () => {}, _isSeed: true };
        client.emit('messageCreate', fakeMsg);
        await interaction.reply({ content: 'Announcement received and processed.', ephemeral: true });
      } catch (e) { console.error('failed to process create_modal', e); try { await interaction.reply({ content: 'Failed to process the announcement.', ephemeral: true }); } catch (e) {} }
      return;
    }
    // Create ticket from panel button
    // session claim buttons handling (customId: session_claim:<messageId>)
    if (interaction.isButton() && typeof interaction.customId === 'string' && interaction.customId.startsWith('session_claim:')) {
      try {
        const parts = interaction.customId.split(':');
        const msgId = parts[1];
        const guild = interaction.guild;
        let member = null;
        if (guild) member = await guild.members.fetch(interaction.user.id).catch(()=>null);
        const cfg = loadGuildConfig(interaction.guildId);
        const isStaffRole = (cfg && cfg.staffRoleId) ? String(cfg.staffRoleId) : null;
        const allowed = member && (member.permissions.has(PermissionsBitField.Flags.ManageGuild) || (isStaffRole && member.roles.cache.has(isStaffRole)) || member.roles.cache.some(r=>/staff/i.test(String(r.name||''))));
        if (!allowed) {
          try { await interaction.reply({ content: 'Nur Staff oder Admins können Sessions claimen.', ephemeral: true }); } catch (e) {}
          return;
        }
        const set = sessionClaims.get(msgId) || new Set();
        const uid = interaction.user.id;
        const adding = !set.has(uid);
        if (set.has(uid)) set.delete(uid); else set.add(uid);
        sessionClaims.set(msgId, set);
        saveClaims();
        // update the embed on the message to show claimed users
        try {
          const ch = interaction.channel || await interaction.client.channels.fetch(interaction.channelId).catch(()=>null);
          const posted = ch ? await ch.messages.fetch(msgId).catch(()=>null) : null;
          if (posted) {
            const oldEmbed = posted.embeds && posted.embeds[0] ? posted.embeds[0] : null;
            const e = oldEmbed ? EmbedBuilder.from(oldEmbed) : new EmbedBuilder().setTitle('Session parsed').setColor(0x87CEFA);
            const claimedList = Array.from(set).map(id=>`<@${id}>`).join(', ') || '—';
            // remove existing Claimed field if present
            const fields = (e.data && e.data.fields) ? e.data.fields.filter(f=>String(f.name).toLowerCase() !== 'claimed') : [];
            fields.push({ name: 'Claimed', value: claimedList, inline: false });
            e.data.fields = fields;
            await posted.edit({ embeds: [e] }).catch(()=>null);
          }
        } catch (ee) { console.error('failed to update claim embed', ee); }
          try { await interaction.reply({ content: adding ? 'You have claimed the session.' : 'Your claim has been removed.', ephemeral: true }); } catch (e) {}
          // If un-claiming, remove any scheduled claim reminders for this user/message
          if (!adding) {
            try {
              const uid2 = uid;
              if (sqliteDb) {
                // remove sqlite rows matching messageId and userId
                const rows = await sqliteLoadAllReminders();
                for (const r of rows) {
                  if (String(r.messageId) === String(msgId) && String(r.userId) === String(uid2)) {
                    try { sqliteRemoveReminder(r.id); } catch (e) { /* ignore */ }
                    if (scheduledReminderTimeouts.has(r.id)) { clearTimeout(scheduledReminderTimeouts.get(r.id)); scheduledReminderTimeouts.delete(r.id); }
                  }
                }
              } else {
                const all = loadPersistedReminders() || [];
                const keep = all.filter(r => !(String(r.messageId) === String(msgId) && String(r.userId) === String(uid2)));
                persistReminders(keep);
                for (const r of all) {
                  if (String(r.messageId) === String(msgId) && String(r.userId) === String(uid2)) {
                    if (scheduledReminderTimeouts.has(r.id)) { clearTimeout(scheduledReminderTimeouts.get(r.id)); scheduledReminderTimeouts.delete(r.id); }
                  }
                }
              }
            } catch (e) { console.error('failed to remove claim reminders', e); }
          }
          try {
            const emb = new EmbedBuilder().setTitle(adding ? 'Session claimed' : 'Session unclaimed').setColor(0x87CEFA).addFields({ name: 'User', value: `<@${interaction.user.id}>`, inline: true }, { name: 'Message', value: `${msgId || 'n/a'}`, inline: true }, { name: 'Claimed', value: Array.from(set).map(id=>`<@${id}>`).join(', ') || '—', inline: false }).setTimestamp();
            await sendSessionsLog({ embeds: [emb] }, interaction.guildId);
            await sendMessageLog(emb, interaction.guildId);
          } catch (ee) { console.error('failed to log claim action', ee); }
        // DM claimer on new claim
        if (adding) {
          try {
            const dmEmbed = new EmbedBuilder().setTitle('Session claim confirmed').setColor(0x87CEFA).setDescription(`You have claimed the session.`).setTimestamp();
            await interaction.user.send({ embeds: [dmEmbed] }).catch(()=>null);
          } catch (e) { console.error('failed to DM claimer', e); }

          // Reminders disabled
        }
      } catch (e) { console.error('session claim button failed', e); try { await interaction.reply({ content: 'Failed to claim.', ephemeral: true }); } catch (e) {} }
      return;
    }

    // Announce button: DM the announcement to the clicker (author or staff)
    if (interaction.isButton() && typeof interaction.customId === 'string' && interaction.customId.startsWith('session_announce:')) {
      try {
        await interaction.deferReply({ ephemeral: true });
        const parts = interaction.customId.split(':');
        const msgId = parts[1];
        const sessionIndex = parts[2] ? parseInt(parts[2], 10) : null;
        let data = sessionPostData.get(String(msgId));
        if (!data) {
          try {
            const all = Array.from(sessionPostData.values()).filter(v => String(v.originChannelId || '') === String(interaction.channelId));
            if (all.length) {
              all.sort((a,b) => (b.postedAt || 0) - (a.postedAt || 0));
              data = all[0];
            }
          } catch (e) {}
        }
        if (!data) return interaction.editReply({ content: 'No stored announcement found (too old or not available).', ephemeral: true });

        const cfg = loadGuildConfig(interaction.guildId);
        const member = interaction.guild ? await interaction.guild.members.fetch(interaction.user.id).catch(()=>null) : null;
        const staffRoleId = cfg && cfg.staffRoleId ? String(cfg.staffRoleId).replace(/[<@&>]/g,'') : null;
        const isStaff = member ? (member.permissions.has(PermissionsBitField.Flags.ManageGuild) || (staffRoleId && member.roles.cache.has(staffRoleId)) || member.roles.cache.some(r=>/staff/i.test(String(r.name||'')))) : false;
        const isAuthor = String(interaction.user.id) === String(data.authorId);
        if (!isAuthor && !isStaff) return interaction.editReply({ content: 'Only the announcement author or staff can announce the session.', ephemeral: true });

        // build announcement text using the shared builder for consistency
        let contentToSend = String(data.raw || '').substring(0,4000);
        try {
          let saBuilder = null;
          try { saBuilder = require(path.join(DATA_DIR, 'commands', 'sa.js')); } catch (e) { saBuilder = null; }
          const sess = (data.parsed && Array.isArray(data.parsed)) ? data.parsed.find(x => Number(x.index) === Number(sessionIndex)) || data.parsed[0] : null;
          let mode = 'beta';
          try {
            const cfgAll = loadJson(path.join(DATA_DIR, 'config.json'), {});
            const tracks = (cfgAll && cfgAll.sessionAnnouncements && Array.isArray(cfgAll.sessionAnnouncements.tracks)) ? cfgAll.sessionAnnouncements.tracks : [];
            const found = tracks.find(t => String(t.channelId) === String(data.originChannelId) || String(t.channelId) === String(interaction.channelId));
            if (found && found.id) mode = String(found.id);
            else { const rawLower = String(data.raw || '').toLowerCase(); mode = /alpha/.test(rawLower) ? 'alpha' : 'beta'; }
          } catch (e) { const rawLower = String(data.raw || '').toLowerCase(); mode = /alpha/.test(rawLower) ? 'alpha' : 'beta'; }

          // Prefer the selected session timestamps to ensure Announce Sx uses the correct time
          let gameTs = null;
          let regTs = null;
          if (sess && sess.start) {
            gameTs = Math.floor(sess.start / 1000);
            // Default registration opens 15 minutes before selected session
            regTs = gameTs - (15 * 60);
          }
          try {
            if (!gameTs && data.raw) {
              const tsMatches = Array.from(String(data.raw).matchAll(/<t:(\d+):t>/g)).map(m=>parseInt(m[1],10));
              if (tsMatches.length >= 2) {
                regTs = tsMatches[0];
                gameTs = tsMatches[1];
              } else if (tsMatches.length === 1) {
                gameTs = tsMatches[0];
              }
            }
          } catch (e) { /* ignore */ }
          if (!gameTs) gameTs = Math.floor(Date.now() / 1000);
          if (!regTs) regTs = gameTs - (15 * 60);
          let staffMentions = (sess && sess.staff) ? sess.staff : '';
          if (!staffMentions) {
            const m = String(data.raw || '').match(/<@!?(\d+)>/);
            if (m) staffMentions = `<@${m[1]}>`;
          }
          if (!staffMentions) {
            const cfg2 = loadGuildConfig(data.guildId);
            if (cfg2 && cfg2.staffRoleId) staffMentions = `<@&${String(cfg2.staffRoleId).replace(/[<@&>]/g,'')}>`;
            else staffMentions = '@staff';
          }
          const includeEveryone = true;
          if (saBuilder && typeof saBuilder.buildAnnouncement === 'function') {
            try { contentToSend = saBuilder.buildAnnouncement({ mode, regTs, gameTs, staffMentions, includeEveryone }); } catch (e) { contentToSend = String(data.raw || '').substring(0,4000); }
          }
        } catch (e) { console.error('failed to build announcement', e); }

        // ensure @everyone mention present (always for alpha/beta)
        const allowEveryone = true;
        try {
          if (!String(contentToSend).includes('@everyone')) {
            contentToSend = String(contentToSend) + "\n\n@everyone";
          }
        } catch (e) {}

        // DM the announcement to the clicker
        try {
          const safeContent = String(contentToSend || '').substring(0, 4000);
          await interaction.user.send({ content: safeContent }).catch(()=>null);
          await interaction.editReply({ content: 'Announcement sent via DM.', ephemeral: true });
          try { const emb = new EmbedBuilder().setTitle('Session announced (DM)').setColor(0x87CEFA).addFields({ name: 'By', value: `<@${interaction.user.id}>`, inline: true }, { name: 'Session', value: `${sessionIndex || 'n/a'}`, inline: true }).setTimestamp(); await sendSessionsLog({ embeds: [emb] }, interaction.guildId); await sendMessageLog(emb, interaction.guildId); } catch (e) { console.error('failed to log announce DM', e); }
        } catch (e) { console.error('failed to DM announcement', e); return interaction.editReply({ content: 'Failed to send the announcement via DM.', ephemeral: true }); }

        return;
      } catch (e) {
        console.error('session announce button failed', e);
        try {
          await interaction.editReply({ content: 'Failed to announce the session.', ephemeral: true });
        } catch (err) {}
      }
    }

    // Get button: DM the formatted announcement to the user (author or staff)
    if (interaction.isButton() && typeof interaction.customId === 'string' && interaction.customId.startsWith('session_get:')) {
      try {
        await interaction.deferReply({ ephemeral: true });
        const parts = interaction.customId.split(':');
        const msgId = parts[1];
        const data = sessionPostData.get(String(msgId));
        if (!data) return interaction.editReply({ content: 'No stored announcement found.', ephemeral: true });

        const cfg = loadGuildConfig(interaction.guildId);
        const member = interaction.guild ? await interaction.guild.members.fetch(interaction.user.id).catch(()=>null) : null;
        const staffRoleId = cfg && cfg.staffRoleId ? String(cfg.staffRoleId).replace(/[<@&>]/g,'') : null;
        const isStaff = member ? (member.permissions.has(PermissionsBitField.Flags.ManageGuild) || (staffRoleId && member.roles.cache.has(staffRoleId)) || member.roles.cache.some(r=>/staff/i.test(String(r.name||'')))) : false;
        const isAuthor = String(interaction.user.id) === String(data.authorId);
        if (!isAuthor && !isStaff) return interaction.editReply({ content: 'Only the author or staff can request the announcement.', ephemeral: true });

        // Build a formatted announcement (prefer sa.buildAnnouncement)
        let contentToSend = String(data.raw || '').substring(0, 4000);
        try {
          let saBuilder = null;
          try { saBuilder = require(path.join(DATA_DIR, 'commands', 'sa.js')); } catch (e) { saBuilder = null; }
          if (saBuilder && typeof saBuilder.buildAnnouncement === 'function') {
            // Try to derive timestamps and staff from stored data, else fetch the posted message's embed
            let regTs = null;
            let gameTs = null;
            let staffMentions = '';
            if (data.raw) {
              const tsMatches = Array.from(String(data.raw).matchAll(/<t:(\d+):t>/g)).map(m=>parseInt(m[1],10));
              regTs = tsMatches[0] || null;
              gameTs = tsMatches[1] || tsMatches[0] || null;
              if (data.parsed && Array.isArray(data.parsed) && data.parsed.length && data.parsed[0].staff) staffMentions = data.parsed[0].staff;
            }
            // If missing, attempt to fetch the parsed message and extract timestamps/staff from its embed
            if ((!regTs || !gameTs || !staffMentions) && interaction.channel) {
              try {
                const postedMsg = await interaction.channel.messages.fetch(String(msgId)).catch(()=>null);
                if (postedMsg && postedMsg.embeds && postedMsg.embeds[0]) {
                  const desc = postedMsg.embeds[0].description || '';
                  const tsMatches = Array.from(String(desc).matchAll(/<t:(\d+):t>/g)).map(m=>parseInt(m[1],10));
                  if (!regTs) regTs = tsMatches[0] || null;
                  if (!gameTs) gameTs = tsMatches[1] || tsMatches[0] || null;
                  const staffMatch = String(desc).match(/Staff[:\s\-–]*([^\n\r]+)/i);
                  if (staffMatch) staffMentions = (staffMatch[1] || '').trim();
                }
              } catch (e) { /* ignore */ }
            }

            // Fallbacks
            if (!staffMentions) {
              const cfg2 = loadGuildConfig(data.guildId);
              if (cfg2 && cfg2.staffRoleId) staffMentions = `<@&${String(cfg2.staffRoleId).replace(/[<@&>]/g,'')}>`;
              else staffMentions = '@staff';
            }
            if (!regTs) regTs = Math.floor(Date.now()/1000);
            if (!gameTs) gameTs = regTs + (15 * 60);

            // determine mode (alpha|beta) using config tracks mapping, fallback to raw text
            let mode = 'beta';
            try {
              const cfgAll = loadJson(path.join(DATA_DIR, 'config.json'), {});
              const tracks = (cfgAll && cfgAll.sessionAnnouncements && Array.isArray(cfgAll.sessionAnnouncements.tracks)) ? cfgAll.sessionAnnouncements.tracks : [];
              const found = tracks.find(t => String(t.channelId) === String(data.originChannelId) || String(t.channelId) === String(interaction.channelId));
              if (found && found.id) mode = String(found.id);
              else {
                const rawLower = String(data.raw || '').toLowerCase();
                mode = /alpha/.test(rawLower) ? 'alpha' : 'beta';
              }
            } catch (e) { const rawLower = String(data.raw || '').toLowerCase(); mode = /alpha/.test(rawLower) ? 'alpha' : 'beta'; }

            const includeEveryone = true;
            const built = saBuilder.buildAnnouncement({ mode: mode, regTs, gameTs, staffMentions, includeEveryone });
            if (built) contentToSend = built;
          }
        } catch (e) { console.error('failed to build announcement for DM', e); }

        // ensure @everyone included when requested (append literal text so it appears in DM)
        try {
          if (!String(contentToSend).includes('@everyone')) contentToSend = String(contentToSend) + "\n\n@everyone";
        } catch (e) {}
        // Do not DM the clicker; post announcement into the current channel
        try {
          const safeContent = String(contentToSend || '').substring(0, 4000);
          if (interaction.channel && typeof interaction.channel.send === 'function') {
            await interaction.channel.send({ content: safeContent, allowedMentions: { parse: ['roles', 'everyone'], everyone: true } }).catch(()=>{});
            await interaction.editReply({ content: 'Announcement posted in this channel.', ephemeral: true });
          } else {
            await interaction.editReply({ content: 'Could not post announcement in channel.', ephemeral: true });
          }
        } catch (e) { console.error('session get button failed', e); try { await interaction.editReply({ content: 'Failed to post the announcement.', ephemeral: true }); } catch (err) {} }
      } catch (e) { console.error('session get button failed', e); try { await interaction.editReply({ content: 'Failed to send the announcement via DM.', ephemeral: true }); } catch (e) {} }
      return;
    }

    // Remind button disabled
    if (interaction.isButton() && typeof interaction.customId === 'string' && interaction.customId.startsWith('session_remind:')) {
      try { await interaction.reply({ content: 'Reminders are disabled.', ephemeral: true }); } catch (e) {}
      return;
    }

    // Admin panel buttons (posted via /session panel)
    if (interaction.isButton() && typeof interaction.customId === 'string' && interaction.customId.startsWith('admin_')) {
      await interaction.deferReply({ ephemeral: true }).catch(()=>{});
      try {
        const parts = interaction.customId.split(':');
        const action = parts[0];
        const cfg = loadGuildConfig(interaction.guildId);
        const member = interaction.guild ? await interaction.guild.members.fetch(interaction.user.id).catch(()=>null) : null;
        const staffRoleId = cfg && cfg.staffRoleId ? String(cfg.staffRoleId).replace(/[<@&>]/g,'') : null;
        const isStaff = member ? (member.permissions.has(PermissionsBitField.Flags.ManageGuild) || (staffRoleId && member.roles.cache.has(staffRoleId)) || member.roles.cache.some(r=>/staff/i.test(String(r.name||'')))) : false;
        if (!isStaff) return interaction.editReply({ content: 'Only staff/admins may use the admin panel.', ephemeral: true });

        if (action === 'admin_list') {
          try {
            const rows = sqliteDb ? await sqliteLoadAllReminders() : loadPersistedReminders();
            if (!rows || !rows.length) return interaction.editReply({ content: 'No scheduled reminders found.', ephemeral: true });
            const parts = (rows||[]).slice(0,30).map(r => `• ${r.id} — <@${r.userId}> — <t:${Math.floor(r.sendAt/1000)}:t> — s${r.sessionIndex} — ch:${r.channelId || r.channel || 'n/a'}`);
            return interaction.editReply({ content: parts.join('\n'), ephemeral: true });
          } catch (e) { console.error('admin_list failed', e); return interaction.editReply({ content: 'Failed to list reminders.', ephemeral: true }); }
        }

        if (action === 'admin_reschedule') {
          try {
            rescheduleAllReminders();
            return interaction.editReply({ content: 'Reschedule requested. Reminders will be rescheduled.', ephemeral: true });
          } catch (e) { console.error('admin_reschedule failed', e); return interaction.editReply({ content: 'Failed to reschedule.', ephemeral: true }); }
        }

        if (action === 'admin_purge_json') {
          try {
            saveJson(SESSIONS_REMINDERS_PATH, []);
            return interaction.editReply({ content: 'JSON reminders cleared. SQLite reminders unaffected.', ephemeral: true });
          } catch (e) { console.error('admin_purge_json failed', e); return interaction.editReply({ content: 'Failed to delete JSON reminders.', ephemeral: true }); }
        }

            if (action === 'admin_close') {
          try {
            if (interaction.message && interaction.message.deletable) await interaction.message.delete().catch(()=>{});
            return interaction.editReply({ content: 'Panel removed.', ephemeral: true });
          } catch (e) { console.error('admin_close failed', e); return interaction.editReply({ content: 'Failed to remove the panel.', ephemeral: true }); }
        }

        return interaction.editReply({ content: 'Unknown admin action.', ephemeral: true });
      } catch (e) { console.error('admin panel button handler failed', e); try { await interaction.editReply({ content: 'Failed admin action.', ephemeral: true }); } catch (e) {} }
      return;
    }

    if (interaction.isButton() && typeof interaction.customId === 'string' && interaction.customId.startsWith('ticket_create_btn')) {
      await interaction.deferReply({ ephemeral: true });
      try {
        if (!interaction.guild) return interaction.editReply('This feature only works on a server.');

        // Backward compat: ticket_create_btn:<userId>
        const parts = interaction.customId.split(':');
        const forcedUserId = parts.length > 1 ? parts[1] : null;
        if (forcedUserId && interaction.user.id !== forcedUserId) {
          return interaction.editReply('You can only create your own ticket.');
        }

        const targetUserId = interaction.user.id;

        const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
        const maxOpen = Number(cfg.maxOpenPerUser) || 1;
        const existing = interaction.guild.channels.cache.filter(c => c.topic && c.topic.startsWith(`ticket:${targetUserId}:`));
        if (existing.size >= maxOpen) {
          const first = existing.first();
          return interaction.editReply(first ? `You already have an open ticket: ${first}` : 'You already have an open ticket.');
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
          .setDescription(`Ticket from <@${targetUserId}>\nPlease describe your issue as clearly as possible.`)
          .setColor(0x87CEFA)
          .addFields({ name: 'Close', value: 'Staff can close the ticket with the button below.', inline: false })
          .setTimestamp();

          const closeBtn = new ButtonBuilder()
            .setCustomId('ticket_close_vanta')
          .setLabel('Close Ticket')
          .setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder().addComponents(closeBtn);

        await ticketChannel.send({ content: `<@${targetUserId}>`, embeds: [embed], components: [row] }).catch(() => {});

        try {
          await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setColor(0x00AAFF).setTitle('Ticket created').setDescription(`Ticket ${ticketChannel} created by <@${targetUserId}>`)] });
        } catch (e) { console.error('ticket log send failed', e); }

        return interaction.editReply(`✅ Ticket created: ${ticketChannel}`);
      } catch (e) {
        console.error('ticket_create_btn interaction failed', e);
        return interaction.editReply('Failed to create the ticket.');
      }
    }

    if (interaction.isButton() && interaction.customId === 'ticket_close_vanta') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const channel = interaction.channel;
        if (!channel || !channel.topic || !channel.topic.startsWith('ticket:')) return interaction.editReply('This button can only be used in ticket channels.');
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
        if (!isOwner && !isStaff) return interaction.editReply('Only the creator or staff can close the ticket.');

        const reason = `Closed by ${interaction.user.tag} via Button`;

        // create transcript
        const folder = path.join(DATA_DIR, cfg.transcriptFolder || 'transcripts');
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
        const { txtPath, htmlPath } = await createTranscript(channel, folder).catch(()=>({ txtPath: null, htmlPath: null }));

        // try send transcript to log channel
        try {
          await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setTitle('Ticket closed').setDescription(`Ticket ${channel.name} closed by <@${interaction.user.id}>\nReason: ${reason}`)], files: [txtPath].filter(Boolean) });
        } catch (e) { console.error('ticket log send failed', e); }

        // DM owner
        try { const owner = await interaction.client.users.fetch(ownerId).catch(()=>null); if (owner) await owner.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setTitle('Your ticket has been closed').setDescription(`Reason: ${reason}`)], files: [txtPath].filter(Boolean) }).catch(()=>{}); } catch (e) {}

        // remove only this ticket channel (keep shared category)
        try {
          await channel.delete().catch(()=>{});
        } catch (e) { console.error('failed to remove ticket channels/category', e); }

        try {
          await sendLog(interaction.guild, { embeds: [new EmbedBuilder().setTitle('Ticket closed').setDescription(`Ticket ${channel.name} closed by <@${interaction.user.id}>\nReason: ${reason}`)] });
        } catch (e) { console.error('ticket log send failed', e); }

        return interaction.editReply('Ticket closed and removed.');
      } catch (e) {
        console.error('ticket_close interaction failed', e);
        return interaction.editReply('Failed to close the ticket.');
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

  const r = (reason && String(reason).trim()) ? String(reason).trim() : '';
  const desc = r
    ? `You ${actionPhrase} in ${serverName} for ${r}.`
    : `You ${actionPhrase} in ${serverName}.`;

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

function createChannelConfirmEmbed(text, caseId, userId = null, color = 0x87CEFA) {
  const when = Date.now();
  const footerText = `${formatFooterTime(when)}${userId ? ` | UserID: ${userId}` : ''}`;
  return new EmbedBuilder()
    .setColor(color)
    .setDescription(text)
    .setFooter({ text: footerText });
}

function replyAsEmbed(message, text, caseId = null, userId = null) {
  try {
    return message.channel.send({ embeds: [createChannelConfirmEmbed(String(text), caseId, userId)] });
  } catch (e) {
    console.error('replyAsEmbed failed', e);
    return message.channel.send(String(text)).catch(() => null);
  }
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

  // Seed voice activity sessions for members already in voice.
  try { voiceActivity.seedFromClient(client); } catch (e) {}

  // Bot updates: log boot + code/package timestamps
  try {
    let version = 'unknown';
    try {
      const pkgPath = path.join(__dirname, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg && pkg.version) version = String(pkg.version);
      }
    } catch (e) {}

    let codeUpdatedAt = null;
    try {
      const st = fs.statSync(__filename);
      codeUpdatedAt = st && st.mtime ? st.mtime.toISOString() : null;
    } catch (e) {}

    const embed = new EmbedBuilder()
      .setTitle('Bot Update')
      .setColor(0x87CEFA)
      .setDescription(`Bot is online: **${client.user.tag}**`)
      .addFields(
        { name: 'Version', value: version, inline: true },
        { name: 'Node', value: process.version, inline: true },
        { name: 'Code Updated', value: codeUpdatedAt || 'unknown', inline: false }
      )
      .setTimestamp();
    sendBotUpdate({ embeds: [embed] }).catch(() => {});
  } catch (e) {}
  
  // Set the bot's presence to Do Not Disturb with custom status
  client.user.setPresence({
    status: 'dnd',
    activities: [
      {
        name: 'Grinding sessions 🔥',
        type: ActivityType.Custom,
      },
    ],
  });
  // reschedule session reminders persisted from previous runs
  try { rescheduleAllReminders(); } catch (e) { console.error('rescheduleAllReminders failed', e); }

  // (removed debug startup lines)
});

// --- Server logs: roles/channels/server settings --------------------------------
client.on('roleCreate', async (role) => {
  try {
    if (!role || !role.guild) return;
    const { executorId } = await fetchAuditExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
    const embed = new EmbedBuilder()
      .setTitle('Role created')
      .setColor(0x2ECC71)
      .addFields(
        { name: 'Role', value: `${role.name} (<@&${role.id}>)`, inline: false },
        { name: 'ID', value: String(role.id), inline: true },
        { name: 'Color', value: role.hexColor || 'n/a', inline: true },
        { name: 'Executor', value: executorId ? `<@${executorId}> (${executorId})` : 'Unknown', inline: false }
      )
      .setTimestamp();
    await sendServerLog(role.guild, { embeds: [embed] });
  } catch (e) { console.error('roleCreate server log failed', e); }
});

client.on('roleUpdate', async (oldRole, newRole) => {
  try {
    if (!newRole || !newRole.guild) return;
    const changes = [];
    try {
      if (oldRole && oldRole.name !== newRole.name) changes.push(`Name: **${oldRole.name}** → **${newRole.name}**`);
      if (oldRole && oldRole.hexColor !== newRole.hexColor) changes.push(`Color: **${oldRole.hexColor}** → **${newRole.hexColor}**`);
      if (oldRole && !!oldRole.hoist !== !!newRole.hoist) changes.push(`Hoist: **${oldRole.hoist}** → **${newRole.hoist}**`);
      if (oldRole && !!oldRole.mentionable !== !!newRole.mentionable) changes.push(`Mentionable: **${oldRole.mentionable}** → **${newRole.mentionable}**`);
      if (oldRole && String(oldRole.permissions?.bitfield || '') !== String(newRole.permissions?.bitfield || '')) {
        // show a small diff
        const before = oldRole.permissions ? oldRole.permissions.toArray() : [];
        const after = newRole.permissions ? newRole.permissions.toArray() : [];
        const added = after.filter(p => !before.includes(p)).slice(0, 10);
        const removed = before.filter(p => !after.includes(p)).slice(0, 10);
        if (added.length) changes.push(`Perms added: ${added.join(', ')}`);
        if (removed.length) changes.push(`Perms removed: ${removed.join(', ')}`);
        if (!added.length && !removed.length) changes.push('Permissions changed');
      }
    } catch (e) {}

    if (!changes.length) return;

    const { executorId } = await fetchAuditExecutor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
    const embed = new EmbedBuilder()
      .setTitle('Role updated')
      .setColor(0xF1C40F)
      .addFields(
        { name: 'Role', value: `${newRole.name} (<@&${newRole.id}>)`, inline: false },
        { name: 'ID', value: String(newRole.id), inline: true },
        { name: 'Executor', value: executorId ? `<@${executorId}> (${executorId})` : 'Unknown', inline: true },
        { name: 'Changes', value: changes.join('\n').substring(0, 1024), inline: false }
      )
      .setTimestamp();
    await sendServerLog(newRole.guild, { embeds: [embed] });
  } catch (e) { console.error('roleUpdate server log failed', e); }
});

client.on('roleDelete', async (role) => {
  try {
    if (!role || !role.guild) return;
    const { executorId } = await fetchAuditExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
    const embed = new EmbedBuilder()
      .setTitle('Role deleted')
      .setColor(0xE74C3C)
      .addFields(
        { name: 'Role', value: `${role.name} (${role.id})`, inline: false },
        { name: 'Executor', value: executorId ? `<@${executorId}> (${executorId})` : 'Unknown', inline: false }
      )
      .setTimestamp();
    await sendServerLog(role.guild, { embeds: [embed] });
  } catch (e) { console.error('roleDelete server log failed', e); }
});

client.on('channelCreate', async (channel) => {
  try {
    if (!channel || !channel.guild) return;
    const { executorId } = await fetchAuditExecutor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
    const embed = new EmbedBuilder()
      .setTitle('Channel created')
      .setColor(0x2ECC71)
      .addFields(
        { name: 'Channel', value: `<#${channel.id}> (${channel.name || channel.id})`, inline: false },
        { name: 'Type', value: String(channel.type), inline: true },
        { name: 'Executor', value: executorId ? `<@${executorId}> (${executorId})` : 'Unknown', inline: true }
      )
      .setTimestamp();
    await sendServerLog(channel.guild, { embeds: [embed] });
  } catch (e) { console.error('channelCreate server log failed', e); }
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  try {
    if (!newChannel || !newChannel.guild) return;
    const changes = [];
    try {
      if (oldChannel && oldChannel.name !== newChannel.name) changes.push(`Name: **${oldChannel.name}** → **${newChannel.name}**`);
      if (typeof oldChannel?.parentId !== 'undefined' && oldChannel.parentId !== newChannel.parentId) changes.push(`Category: **${oldChannel.parentId || 'none'}** → **${newChannel.parentId || 'none'}**`);
      if (typeof oldChannel?.rateLimitPerUser === 'number' && typeof newChannel?.rateLimitPerUser === 'number' && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        changes.push(`Slowmode: **${oldChannel.rateLimitPerUser}s** → **${newChannel.rateLimitPerUser}s**`);
      }
      if (typeof oldChannel?.nsfw !== 'undefined' && oldChannel.nsfw !== newChannel.nsfw) changes.push(`NSFW: **${oldChannel.nsfw}** → **${newChannel.nsfw}**`);
      if (typeof oldChannel?.topic !== 'undefined' && oldChannel.topic !== newChannel.topic) changes.push('Topic changed');
    } catch (e) {}
    if (!changes.length) return;

    const { executorId } = await fetchAuditExecutor(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
    const embed = new EmbedBuilder()
      .setTitle('Channel updated')
      .setColor(0xF1C40F)
      .addFields(
        { name: 'Channel', value: `<#${newChannel.id}> (${newChannel.name || newChannel.id})`, inline: false },
        { name: 'Executor', value: executorId ? `<@${executorId}> (${executorId})` : 'Unknown', inline: true },
        { name: 'Changes', value: changes.join('\n').substring(0, 1024), inline: false }
      )
      .setTimestamp();
    await sendServerLog(newChannel.guild, { embeds: [embed] });
  } catch (e) { console.error('channelUpdate server log failed', e); }
});

client.on('channelDelete', async (channel) => {
  try {
    if (!channel || !channel.guild) return;
    const { executorId } = await fetchAuditExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
    const embed = new EmbedBuilder()
      .setTitle('Channel deleted')
      .setColor(0xE74C3C)
      .addFields(
        { name: 'Channel', value: `${channel.name || channel.id} (${channel.id})`, inline: false },
        { name: 'Executor', value: executorId ? `<@${executorId}> (${executorId})` : 'Unknown', inline: false }
      )
      .setTimestamp();
    await sendServerLog(channel.guild, { embeds: [embed] });
  } catch (e) { console.error('channelDelete server log failed', e); }
});

client.on('guildUpdate', async (oldGuild, newGuild) => {
  try {
    if (!newGuild) return;
    const changes = [];
    try {
      if (oldGuild && oldGuild.name !== newGuild.name) changes.push(`Name: **${oldGuild.name}** → **${newGuild.name}**`);
      if (typeof oldGuild?.verificationLevel !== 'undefined' && oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(`Verification: **${oldGuild.verificationLevel}** → **${newGuild.verificationLevel}**`);
      if (typeof oldGuild?.explicitContentFilter !== 'undefined' && oldGuild.explicitContentFilter !== newGuild.explicitContentFilter) changes.push(`Content Filter: **${oldGuild.explicitContentFilter}** → **${newGuild.explicitContentFilter}**`);
      if (typeof oldGuild?.mfaLevel !== 'undefined' && oldGuild.mfaLevel !== newGuild.mfaLevel) changes.push(`MFA Level: **${oldGuild.mfaLevel}** → **${newGuild.mfaLevel}**`);
    } catch (e) {}
    if (!changes.length) return;

    const { executorId } = await fetchAuditExecutor(newGuild, AuditLogEvent.GuildUpdate, newGuild.id);
    const embed = new EmbedBuilder()
      .setTitle('Server updated')
      .setColor(0xF1C40F)
      .addFields(
        { name: 'Server', value: `${newGuild.name} (${newGuild.id})`, inline: false },
        { name: 'Executor', value: executorId ? `<@${executorId}> (${executorId})` : 'Unknown', inline: true },
        { name: 'Changes', value: changes.join('\n').substring(0, 1024), inline: false }
      )
      .setTimestamp();
    await sendServerLog(newGuild, { embeds: [embed] });
  } catch (e) { console.error('guildUpdate server log failed', e); }
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

async function sendLog(guild, payload) {
  try {
    if (!guild) return;
    const cfg = loadGuildConfig(guild.id);

    const category = payload && (payload.category || payload.type) ? String(payload.category || payload.type).toLowerCase() : null;
    let ch = null;

    const getById = async (id) => {
      if (!id) return null;
      const sid = String(id);
      let target = client.channels.cache.get(sid) || null;
      if (!target) {
        try { target = await client.channels.fetch(sid).catch(() => null); } catch (e) { target = null; }
      }
      if (!target) target = guild.channels.cache.get(sid) || null;
      return target;
    };

    const fallbackByName = (names) => guild.channels.cache.find(c => names.includes(c.name));

    if (category === 'rejected') {
      ch = await getById(cfg.rejectedLogChannelId);
      if (!ch) ch = fallbackByName(['rejected-logs','reject-logs','rejections']);
    }

    if (!ch && (category === 'audit' || category === 'audit-log')) {
      ch = await getById(cfg.auditLogChannelId);
      if (!ch) ch = fallbackByName(['audit-logs','auditlog','audit']);
    }

    if (!ch && (category === 'role' || category === 'roles')) {
      ch = await getById(cfg.roleLogChannelId) || await getById('1421523779913384027');
      if (!ch) ch = fallbackByName(['role-logs','role-log','roles','rolelogs']);
    }

    // Wheel logs (separate channel)
    if (!ch && (category === 'wheel' || category === 'glueckrad')) {
      ch = await getById('1466070767971074139');
    }

    // Automod logs: always forward to central automod channel if requested
    if (!ch && (category === 'automod' || category === 'moderation-automod')) {
      ch = await getById('1466065677986299966');
    }

    if (!ch && (category === 'voice' || category === 'voices' || category === 'voice-log')) {
      ch = await getById(cfg.voiceLogChannelId || cfg.voice_log_channel_id);
      if (!ch) ch = fallbackByName(['voice-logs','voice-log','voice_logs','voice']);
    }

    if (!ch && (category === 'moderation' || category === 'mod')) {
      ch = await getById(cfg.moderationLogChannelId || cfg.modLogChannelId);
      if (!ch) ch = fallbackByName(['mod-logs','moderation-logs','moderation','modlogs']);
    }

    if (!ch) {
      ch = await getById(cfg.logChannelId);
      if (!ch) ch = fallbackByName(['discord-logs','logs','audit-logs']);
    }

    if (!ch || !isTextLike(ch)) {
      // Try fallback to system channel or common names before giving up
      const fallback = guild.systemChannel || findLogChannel(guild);
      if (fallback && isTextLike(fallback)) {
        ch = fallback;
      } else {
        try {
          const owner = await guild.fetchOwner().catch(() => null);
          if (owner && owner.user) {
            const warn = new EmbedBuilder().setTitle('Log channel missing or inaccessible').setColor(0xFF6B6B)
              .setDescription(`I could not find a suitable log channel in **${guild.name}** (${guild.id}). Please configure a log channel in my config or ensure I have a channel named 'mod-logs' or similar.`);
            await owner.user.send({ embeds: [warn] }).catch(() => {});
          }
        } catch (e) { /* ignore */ }
        return;
      }
    }

    // Ensure bot has permission to view/send in the chosen channel; if not, try systemChannel or notify guild owner
    try {
      const botMember = (guild && guild.members && guild.members.me) ? guild.members.me : await guild.members.fetch(client.user.id).catch(() => null);
      const perms = ch && ch.permissionsFor ? ch.permissionsFor(botMember || client.user) : null;
      if (ch && ch.guild && perms && (!perms.has(PermissionsBitField.Flags.ViewChannel) || !perms.has(PermissionsBitField.Flags.SendMessages))) {
        const sys = guild.systemChannel;
        if (sys && isTextLike(sys)) {
          const permsSys = sys.permissionsFor ? sys.permissionsFor(botMember || client.user) : null;
          if (permsSys && permsSys.has(PermissionsBitField.Flags.SendMessages)) {
            try { await sys.send({ embeds: [new EmbedBuilder().setTitle('Logs delivery fallback').setColor(0xE67E22).setDescription(`I could not send logs to <#${ch.id}> (missing permissions). Falling back to this channel.`)] }).catch(() => {}); ch = sys; }
            catch (e) {}
          } else {
            try {
              const owner = await guild.fetchOwner().catch(() => null);
              if (owner && owner.user) {
                const warn = new EmbedBuilder().setTitle('Bot lacks permission to post logs').setColor(0xFF6B6B)
                  .setDescription(`I do not have permission to post logs in <#${ch.id}> in **${guild.name}** (${guild.id}). Please grant me View/Send permissions in that channel or set a different log channel.`);
                await owner.user.send({ embeds: [warn] }).catch(() => {});
              }
            } catch (e) {}
            return;
          }
        } else {
          try {
            const owner = await guild.fetchOwner().catch(() => null);
            if (owner && owner.user) {
              const warn = new EmbedBuilder().setTitle('Bot lacks permission to post logs').setColor(0xFF6B6B)
                .setDescription(`I do not have permission to post logs in <#${ch.id}> in **${guild.name}** (${guild.id}). Please grant me View/Send permissions in that channel or set a different log channel.`);
              await owner.user.send({ embeds: [warn] }).catch(() => {});
            }
          } catch (e) {}
          return;
        }
      }
    } catch (e) { /* ignore permission-check errors */ }

    // Normalize embed colors to light-blue when possible
    const LIGHT_BLUE = 0x87CEFA;
    const normalizeEmbeds = (embeds) => {
      return embeds.map(e => {
        try {
          const plain = e && typeof e.toJSON === 'function' ? e.toJSON() : Object.assign({}, e);
          if (!plain.color) plain.color = LIGHT_BLUE;
          return plain;
        } catch (ex) {
          try { if (!e.color) e.color = LIGHT_BLUE; return e; } catch (_) { return e; }
        }
      });
    };

    try {
      // Build a lightweight dedupe key for the payload to avoid double-posting
      const makeDedupeKey = (p) => {
        try {
          if (!p) return null;
          if (typeof p === 'string') return `content:${p.substring(0,200)}`;
          if (p.content) return `content:${String(p.content).substring(0,200)}`;
          if (p.embeds && p.embeds.length) {
            const e = p.embeds[0];
            const t = String(e.title || '').substring(0,120);
            const d = String(e.description || '').substring(0,200);
            const f = (e.footer && e.footer.text) ? String(e.footer.text).substring(0,120) : '';
            return `embed:${t}|${d}|${f}|cat:${String(p.category||p.type||'')}`;
          }
          return `payload:${String(JSON.stringify(p)).substring(0,300)}`;
        } catch (ex) { return null; }
      };

      const dedupeKey = makeDedupeKey(payload);
      if (dedupeKey) {
        const cacheKey = `${String(guild.id)}::${dedupeKey}`;
        const now = Date.now();
        const prev = recentSendCache.get(cacheKey) || 0;
        if (now - prev < RECENT_SEND_WINDOW_MS) {
          // skip duplicate send
          try { return; } catch (e) { /* ignore */ }
        }
        recentSendCache.set(cacheKey, now);
        // prune old keys occasionally
        try {
          if (recentSendCache.size > 2000) {
            const cutoff = Date.now() - (RECENT_SEND_WINDOW_MS * 10);
            for (const [k, v] of recentSendCache) if (v < cutoff) recentSendCache.delete(k);
          }
        } catch (e) {}
      }

      if (payload && typeof payload === 'object' && (payload.embeds || payload.content || payload.files)) {
        const out = Object.assign({}, payload);
        if (out.embeds && out.embeds.length) out.embeds = normalizeEmbeds(out.embeds);
        await ch.send(out).catch(()=>{});
      } else if (payload) {
        const emb = normalizeEmbeds([payload])[0];
        await ch.send({ embeds: [emb] }).catch(()=>{});
      }
    } catch (e) { /* ignore send errors */ }

    // (central forwarding removed) — sendLog will route specific categories (e.g. 'automod','wheel','role') to configured channels.

    // Additionally, forward ERROR-like payloads from a set of guilds to a dedicated error channel
    try {
      const ERROR_AGG_CHANNEL_ID = '1458940161264980089';
      const ERROR_GUILD_IDS = new Set([
        '1368527215343435826',
        '1339662600903983154',
        '1459330497938325676',
        '1459345285317791917'
      ]);

      const looksLikeError = (p) => {
        if (!p) return false;
        try {
          if (typeof p === 'string') {
            const s = p.toLowerCase();
            return s.includes('error') || s.includes('failed') || s.includes('exception');
          }
          if (p.embeds && p.embeds.length) {
            const t = String(p.embeds[0].title || '').toLowerCase();
            if (t.includes('error') || t.includes('failed') || t.includes('exception')) return true;
            const f = p.embeds[0].fields || [];
            for (const fld of f) {
              if (String(fld.name || '').toLowerCase().includes('error') || String(fld.value || '').toLowerCase().includes('error')) return true;
            }
          }
          if (p.content) {
            const s = String(p.content).toLowerCase();
            if (s.includes('error') || s.includes('failed') || s.includes('exception')) return true;
          }
          if (p.title && String(p.title).toLowerCase().includes('error')) return true;
        } catch (e) {}
        return false;
      };

      if (guild && ERROR_GUILD_IDS.has(String(guild.id)) && looksLikeError(payload)) {
        const errCh = await client.channels.fetch(ERROR_AGG_CHANNEL_ID).catch(()=>null);
        if (errCh && isTextLike(errCh)) {
          const origin = `${guild.name || 'Unknown Guild'} (${guild.id})`;
          if (payload && typeof payload === 'object' && payload.embeds && payload.embeds.length) {
            try {
              const copy = Object.assign({}, payload.embeds[0]);
              if (!copy.footer) copy.footer = { text: `Origin: ${origin}` };
              await errCh.send({ embeds: [copy] }).catch(()=>{});
            } catch (e) { await errCh.send(`${origin} — error (could not forward embed)`).catch(()=>{}); }
          } else if (payload && payload.content) {
            await errCh.send(`**${origin}** — ${payload.content}`).catch(()=>{});
          } else {
            await errCh.send(`**${origin}** — ${String(payload)}`).catch(()=>{});
          }
        }
      }
    } catch (e) { console.error('sendLog error-forward failed', e); }

    // Additionally, forward moderation logs from a set of guilds to a dedicated moderation channel
    try {
      const MOD_AGG_CHANNEL_ID = '1458941514142056552';
      const MOD_GUILD_IDS = new Set([
        '368527215343435826',
        '1339662600903983154',
        '1459330497938325676',
        '1459345285317791917'
      ]);
      const categoryLow = category;
      if (guild && MOD_GUILD_IDS.has(String(guild.id)) && (categoryLow === 'moderation' || categoryLow === 'mod')) {
        const modCh = await client.channels.fetch(MOD_AGG_CHANNEL_ID).catch(()=>null);
        if (modCh && isTextLike(modCh)) {
          if (payload && typeof payload === 'object' && payload.embeds && payload.embeds.length) {
            try {
              const copy = Object.assign({}, payload.embeds[0]);
              if (!copy.footer) copy.footer = { text: `From: ${guild.name || guild.id}` };
              await modCh.send({ embeds: [copy] }).catch(()=>{});
            } catch (e) { await modCh.send(`Moderation log from ${guild.id}`).catch(()=>{}); }
          } else if (payload && payload.content) {
            await modCh.send(`Moderation log from ${guild.name || guild.id}: ${payload.content}`).catch(()=>{});
          } else {
            const desc = payload && typeof payload === 'string' ? payload : (payload && payload.toString ? payload.toString().slice(0,1900) : 'Moderation event');
            await modCh.send({ embeds: [{ title: `Moderation log — ${guild.name || guild.id}`, description: desc, color: 0x87CEFA, footer: { text: `Origin: ${guild.id}` } }] }).catch(()=>{});
          }
        }
      }
    } catch (e) { console.error('sendLog mod-forward failed', e); }

    return;
  } catch (e) {
    console.error('sendLog failed', e);
  }
}

async function getChannelById(channelId) {
  try {
    if (!channelId) return null;
    const sid = String(channelId);
    let target = client.channels.cache.get(sid) || null;
    if (!target) target = await client.channels.fetch(sid).catch(() => null);
    return target || null;
  } catch (e) {
    return null;
  }
}

function getBotUpdatesChannelId() {
  return DEFAULT_BOT_UPDATES_CHANNEL_ID;
}

function getServerLogsChannelId(guild) {
  try {
    const cfg = guild ? loadGuildConfig(guild.id) : null;
    return (process.env.SERVER_LOGS_CHANNEL_ID || (cfg && cfg.serverLogsChannelId) || DEFAULT_SERVER_LOGS_CHANNEL_ID);
  } catch (e) {
    return DEFAULT_SERVER_LOGS_CHANNEL_ID;
  }
}

async function sendBotUpdate(payload) {
  try {
    const ch = await getChannelById(getBotUpdatesChannelId());
    if (!ch || !isTextLike(ch)) return false;
    await ch.send(payload).catch(() => null);
    return true;
  } catch (e) {
    return false;
  }
}

async function sendServerLog(guild, payload) {
  try {
    if (!guild) return false;
    const chId = getServerLogsChannelId(guild);
    const ch = await getChannelById(chId);
    if (!ch || !isTextLike(ch)) return false;
    // Safety: only log into that channel if it belongs to the same guild
    if (ch.guild && String(ch.guild.id) !== String(guild.id)) return false;
    await ch.send(payload).catch(() => null);
    return true;
  } catch (e) {
    return false;
  }
}

async function fetchAuditExecutor(guild, type, targetId, windowMs = 20_000) {
  try {
    if (!guild || !type || !targetId) return { executorId: null, reason: null };
    const logs = await guild.fetchAuditLogs({ type, limit: 6 }).catch(() => null);
    const entry = logs && logs.entries
      ? logs.entries.find(e => e && e.target && String(e.target.id) === String(targetId) && (Date.now() - e.createdTimestamp) < windowMs)
      : null;
    if (!entry) return { executorId: null, reason: null };
    return {
      executorId: entry.executor ? (entry.executor.id || null) : null,
      reason: entry.reason || null
    };
  } catch (e) {
    return { executorId: null, reason: null };
  }
}

function isTextLike(ch) { return ch && (typeof ch.isTextBased === 'function' ? ch.isTextBased() : (ch.isText && ch.isText())); }

function buildFooter(guild) {
  if (!guild) return undefined;
  return { text: `Guild: ${guild.name} (${guild.id})` };
}

// Anti-raid basics: join-rate detection + new-account restriction
const antiRaidJoinTimes = new Map(); // guildId -> number[] timestamps
const antiRaidState = new Map(); // guildId -> { activeUntil: number, originalSlowmodes: Map<string, number>, timer: any }

function getAntiRaidCfg(cfg) {
  const ar = (cfg && cfg.antiRaid && typeof cfg.antiRaid === 'object') ? cfg.antiRaid : {};
  return {
    enabled: ar.enabled !== false,
    windowSeconds: Number(ar.windowSeconds || 60),
    maxJoins: Number(ar.maxJoins || 8),
    slowmodeSeconds: Number(ar.slowmodeSeconds || 10),
    slowmodeDurationMinutes: Number(ar.slowmodeDurationMinutes || 10),
    slowmodeChannels: ar.slowmodeChannels || 'all', // 'all' or string[] channelIds
    verificationRoleId: ar.verificationRoleId ? String(ar.verificationRoleId).replace(/[<@&>]/g, '') : null,
    minAccountAgeDays: Number(ar.minAccountAgeDays || 3),
    newAccountRoleId: ar.newAccountRoleId ? String(ar.newAccountRoleId).replace(/[<@&>]/g, '') : null,
  };
}

async function enableRaidMode(guild, cfg) {
  try {
    if (!guild) return;
    const anti = getAntiRaidCfg(cfg);
    if (!anti.enabled) return;

    const gid = String(guild.id);
    const existing = antiRaidState.get(gid);
    const now = Date.now();
    const durationMs = Math.max(60_000, anti.slowmodeDurationMinutes * 60_000);
    const activeUntil = now + durationMs;

    if (existing && existing.activeUntil && existing.activeUntil > now) {
      existing.activeUntil = activeUntil;
      return;
    }

    const originalSlowmodes = new Map();
    const shouldAll = anti.slowmodeChannels === 'all';
    const allowIds = Array.isArray(anti.slowmodeChannels) ? anti.slowmodeChannels.map(String) : [];

    const channels = guild.channels && guild.channels.cache ? Array.from(guild.channels.cache.values()) : [];
    for (const ch of channels) {
      try {
        if (!ch) continue;
        if (!isTextLike(ch)) continue;
        if (typeof ch.setRateLimitPerUser !== 'function') continue;
        if (!shouldAll && !allowIds.includes(String(ch.id))) continue;

        const current = typeof ch.rateLimitPerUser === 'number' ? ch.rateLimitPerUser : 0;
        originalSlowmodes.set(String(ch.id), current);
        await ch.setRateLimitPerUser(anti.slowmodeSeconds, 'Anti-Raid: join spike detected').catch(() => {});
      } catch (e) {}
    }

    const st = { activeUntil, originalSlowmodes, timer: null };
    const scheduleDisable = () => {
      const remaining = Math.max(1_000, (st.activeUntil || 0) - Date.now());
      st.timer = setTimeout(async () => {
        try {
          const cur = antiRaidState.get(gid);
          if (!cur) return;
          if (Date.now() < cur.activeUntil) {
            // extended; re-schedule using the updated timestamp
            st.activeUntil = cur.activeUntil;
            return scheduleDisable();
          }
          for (const [cid, prev] of cur.originalSlowmodes) {
            try {
              const ch = guild.channels.cache.get(cid) || await guild.channels.fetch(cid).catch(() => null);
              if (ch && typeof ch.setRateLimitPerUser === 'function') {
                await ch.setRateLimitPerUser(prev, 'Anti-Raid: raid mode ended').catch(() => {});
              }
            } catch (e) {}
          }
          antiRaidState.delete(gid);
        } catch (e) {}
      }, remaining);
    };
    scheduleDisable();
    antiRaidState.set(gid, st);

    // Log raid-mode activation as a modlog case
    createModlogCase({
      guild,
      type: 'RaidMode',
      userId: `guild:${guild.id}`,
      moderatorId: 'AutoMod',
      reason: `Join spike detected — slowmode ${anti.slowmodeSeconds}s for ${anti.slowmodeDurationMinutes}m` ,
      durationMs
    });
  } catch (e) {}
}

client.on('guildMemberAdd', async (member) => {
  try {
    // Auto-assign member role
    const cfg = loadGuildConfig(member.guild.id);
    const anti = getAntiRaidCfg(cfg);
    const joinTs = Math.floor(Date.now() / 1000);

    // Anti-raid: join-rate detection
    try {
      if (anti.enabled) {
        const gid = String(member.guild.id);
        const now = Date.now();
        const windowMs = Math.max(10_000, anti.windowSeconds * 1000);
        const list = antiRaidJoinTimes.get(gid) || [];
        list.push(now);
        while (list.length && (now - list[0]) > windowMs) list.shift();
        antiRaidJoinTimes.set(gid, list);
        if (list.length >= anti.maxJoins) {
          await enableRaidMode(member.guild, cfg);
        }
      }
    } catch (e) {}

    // Anti-raid: new-account restriction and raid-mode verification role
    try {
      if (anti.enabled) {
        const now = Date.now();
        const ageDays = (now - (member.user ? member.user.createdTimestamp : now)) / 86400000;
        const raidActive = (() => {
          const st = antiRaidState.get(String(member.guild.id));
          return !!(st && st.activeUntil && st.activeUntil > now);
        })();

        const roleIdsToAdd = [];
        if (anti.minAccountAgeDays > 0 && ageDays < anti.minAccountAgeDays) {
          if (anti.newAccountRoleId) roleIdsToAdd.push(anti.newAccountRoleId);
          else if (anti.verificationRoleId) roleIdsToAdd.push(anti.verificationRoleId);
        }
        if (raidActive && anti.verificationRoleId) {
          if (!roleIdsToAdd.includes(anti.verificationRoleId)) roleIdsToAdd.push(anti.verificationRoleId);
        }

        for (const rid of roleIdsToAdd) {
          try {
            if (!rid) continue;
            const role = member.guild.roles.cache.get(rid) || await member.guild.roles.fetch(rid).catch(() => null);
            if (role && !member.roles.cache.has(role.id)) {
              try {
                await member.roles.add(role, 'Anti-Raid: verification/restriction on join');
                createModlogCase({
                  guild: member.guild,
                  type: 'AutoRestrict',
                  userId: member.id,
                  moderatorId: 'AutoMod',
                  reason: `Assigned role ${role.name} (${role.id}) on join (accountAge=${ageDays.toFixed(1)}d, raidActive=${raidActive})`
                });
              } catch (e) {}
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
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
    const welcomeChannelId = process.env.WELCOME_CHANNEL_ID || cfg.welcomeChannelId || '1370410824539312129';
    const rulesChannelId = process.env.RULES_CHANNEL_ID || cfg.rulesChannelId || welcomeChannelId;

    if (welcomeChannelId) {
      const welcomeCh = member.guild.channels.cache.get(welcomeChannelId) || await member.guild.channels.fetch(welcomeChannelId).catch(() => null);
      if (welcomeCh && isTextLike(welcomeCh)) {
        const createdTs = Math.floor(member.user.createdTimestamp / 1000);
        const welcomeEmbed = new EmbedBuilder()
          .setTitle('👋 WELCOME')
          .setDescription(
            `Welcome to **${member.guild.name}**, <@${member.id}>!\n\n` +
            `We're glad to have you here. Make sure to read the rules and have fun!`
          )
          .setColor(0x87CEFA)
          .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
          .addFields(
            { name: 'Member', value: `${member.user.username}`, inline: true },
            { name: 'ID', value: `${member.id}`, inline: true },
            { name: 'Account Created', value: `<t:${createdTs}:R>`, inline: false }
          )
          .setFooter({ text: `Member #${member.guild.memberCount} • ${formatFooterTime(Date.now())}` })
          .setTimestamp();
        await welcomeCh.send({ embeds: [welcomeEmbed] }).catch(() => {});
      }
    }

    // Join logs (German, light blue, Hammertime)
    const joinLogChannelId = process.env.JOIN_LOG_CHANNEL_ID || cfg.joinLogChannelId || '1421523660929237192';
    if (joinLogChannelId) {
      // try guild cache/fetch first, then global client fetch as fallback
      let joinLogCh = member.guild.channels.cache.get(joinLogChannelId) || await member.guild.channels.fetch(joinLogChannelId).catch(() => null);
      if (!joinLogCh) {
        const maybe = await client.channels.fetch(joinLogChannelId).catch(() => null);
        if (maybe && maybe.guild && String(maybe.guild.id) === String(member.guild.id)) joinLogCh = maybe;
      }
      if (joinLogCh && isTextLike(joinLogCh)) {
        const createdTs = Math.floor(member.user.createdTimestamp / 1000);
        const joinLogEmbed = new EmbedBuilder()
          .setTitle('Member joined')
          .setDescription(`<@${member.id}>`)
          .setColor(0x87CEFA)
          .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
          .addFields(
            { name: 'ID', value: `${member.id}`, inline: true },
            { name: 'Account-Alter', value: `<t:${createdTs}:R>`, inline: true }
          );
        await joinLogCh.send({ embeds: [joinLogEmbed] }).catch((err) => { console.error('joinLog send failed', err); });
      } else {
        // fallback to generic audit logging
        const logCh = findLogChannel(member.guild);
        if (logCh && isTextLike(logCh)) {
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
          await sendLog(member.guild, { embeds: [embed], category: 'mod' }).catch((err) => { console.error('fallback joinLog send failed', err); });
        }
      }
    }
  } catch (e) { console.error('guildMemberAdd log failed', e); }
});

// Track when staff-like roles are added/removed (for duration reporting in -destaff)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (!oldMember || !newMember) return;
    if (!newMember.guild) return;

    // Track manual timeouts (right-click mute/unmute) and log to actions.md
    try {
      const oldTs = oldMember.communicationDisabledUntilTimestamp || 0;
      const newTs = newMember.communicationDisabledUntilTimestamp || 0;
      if (oldTs !== newTs) {
        const now = Date.now();
        const isTimedOut = !!newTs && newTs > now;

        let moderatorId = null;
        let reason = null;
        try {
          const logs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 10 }).catch(() => null);
          const entry = logs && logs.entries
            ? logs.entries.find(e => {
                try {
                  if (!e || !e.target || String(e.target.id) !== String(newMember.id)) return false;
                  if ((Date.now() - e.createdTimestamp) >= 20_000) return false;
                  const changes = Array.isArray(e.changes) ? e.changes : [];
                  return changes.some(c => c && String(c.key) === 'communication_disabled_until');
                } catch (err) {
                  return false;
                }
              })
            : null;
          if (entry) {
            const ex = entry.executor;
            if (ex) moderatorId = ex.id || null;
            if (entry.reason) reason = entry.reason;
          }
        } catch (e) {}
        if (!reason) reason = 'No reason provided';

        // Avoid duplicates when the bot executed the mute/unmute command (that already created a case)
        const dedupeType = isTimedOut ? 'Mute' : 'Unmute';
        if (!hasRecentModAction(newMember.guild.id, dedupeType, newMember.id, moderatorId)) {
          const nowTs = Math.floor(Date.now() / 1000);
          const targetUser = newMember.user;
          if (isTimedOut) {
            const durationMs = (newTs - now);
            const durationText = `${Math.max(1, Math.ceil(durationMs / 60000))} Minuten`;
            const caseId = createModlogCase({
              guild: newMember.guild,
              type: 'Mute',
              userId: newMember.id,
              moderatorId,
              reason,
              durationMs
            });
            const embed = buildSmallModerationEmbed({
              title: 'Nutzer gemutet (Timeout)',
              targetId: newMember.id,
              targetAvatarUrl: targetUser.displayAvatarURL({ extension: 'png', size: 256 }),
              moderatorId,
              reason,
              caseId,
              durationText,
              nowTs
            });
            await sendLog(newMember.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
          } else {
            const caseId = createModlogCase({
              guild: newMember.guild,
              type: 'Unmute',
              userId: newMember.id,
              moderatorId,
              reason
            });
            const embed = buildSmallModerationEmbed({
              title: 'Nutzer entmutet',
              targetId: newMember.id,
              targetAvatarUrl: targetUser.displayAvatarURL({ extension: 'png', size: 256 }),
              moderatorId,
              reason,
              caseId,
              nowTs
            });
            await sendLog(newMember.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
          }
        }
      }
    } catch (e) {}

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
        // Ban is handled by guildBanAdd for a richer payload.
        // Still continue so the normal leave message/log is posted (requested behavior).
      } else {
        const kickLogs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.MemberKick, limit: 6 }).catch(() => null);
        const kickEntry = kickLogs && kickLogs.entries
          ? kickLogs.entries.find(e => e && e.target && String(e.target.id) === String(member.id) && (now - e.createdTimestamp) < 15000)
          : null;

        if (kickEntry) {
          // Right-click kick: create a modlog case + actions.md entry (deduped against prefix command)
          let caseId = null;
          try {
            const dedupeType = 'Kick';
            const moderatorId = kickEntry.executor ? (kickEntry.executor.id || null) : null;
            if (!hasRecentModAction(member.guild.id, dedupeType, member.id, moderatorId)) {
              caseId = createModlogCase({
                guild: member.guild,
                type: 'Kick',
                userId: member.id,
                moderatorId,
                reason: kickEntry.reason || 'No reason provided'
              });
            }
          } catch (e) {}
          const nowTs = Math.floor(Date.now() / 1000);
          const targetUser = member.user;
          const embed = buildSmallModerationEmbed({
            title: 'Member kicked',
            targetId: member.id,
            targetAvatarUrl: targetUser.displayAvatarURL({ extension: 'png', size: 256 }),
            moderatorId: kickEntry.executor ? kickEntry.executor.id : null,
            reason: kickEntry.reason || '—',
            caseId,
            nowTs
          });
          await sendLog(member.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
          // Continue so the normal leave message/log is also posted.
        }
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
    const leaveLogChannelId = process.env.LEAVE_LOG_CHANNEL_ID || cfg.leaveLogChannelId || '1421523660929237192';
    const joinLogChannelId = process.env.JOIN_LOG_CHANNEL_ID || cfg.joinLogChannelId || '1421523660929237192';
    if (leaveLogChannelId) {
      // try guild cache/fetch first, then global client fetch as fallback
      let leaveLogCh = member.guild.channels.cache.get(leaveLogChannelId) || await member.guild.channels.fetch(leaveLogChannelId).catch(() => null);
      if (!leaveLogCh) {
        const maybe = await client.channels.fetch(leaveLogChannelId).catch(() => null);
        if (maybe && maybe.guild && String(maybe.guild.id) === String(member.guild.id)) leaveLogCh = maybe;
      }
      if (leaveLogCh && isTextLike(leaveLogCh)) {
        const createdTs = Math.floor(member.user.createdTimestamp / 1000);
        const leaveLogEmbed = new EmbedBuilder()
          .setTitle('Member left')
          .setDescription(`<@${member.id}>`)
          .setColor(0x87CEFA)
          .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
          .addFields(
            { name: 'ID', value: `${member.id}`, inline: true },
            { name: 'Account-Alter', value: `<t:${createdTs}:R>`, inline: true }
          );
        await leaveLogCh.send({ embeds: [leaveLogEmbed] }).catch((err) => { console.error('leaveLog send failed', err); });
          // Also send to the join-log channel (member-logs) so leaves appear in the same channel as joins
          try {
            let joinLogCh = member.guild.channels.cache.get(joinLogChannelId) || await member.guild.channels.fetch(joinLogChannelId).catch(() => null);
            if (!joinLogCh) {
              const maybe = await client.channels.fetch(joinLogChannelId).catch(() => null);
              if (maybe && maybe.guild && String(maybe.guild.id) === String(member.guild.id)) joinLogCh = maybe;
            }
            if (joinLogCh && isTextLike(joinLogCh)) {
                  try {
                    // Avoid sending twice when join and leave channels are configured to the same ID
                    const joinId = String(joinLogChannelId || (joinLogCh && joinLogCh.id) || '');
                    const leaveId = String(leaveLogChannelId || (leaveLogCh && leaveLogCh.id) || '');
                    if (joinId && leaveId && joinId === leaveId) {
                      // same channel configured; skip duplicate send
                    } else {
                      await joinLogCh.send({ embeds: [leaveLogEmbed] }).catch(() => {});
                    }
                  } catch (e) { /* ignore join-log send errors */ }
                }
          } catch (e) { /* ignore join-log send errors */ }
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
        await sendLog(member.guild, { embeds: [embed], category: 'mod' }).catch((err) => { console.error('fallback leaveLog send failed', err); });
      }
    }
  } catch (e) { console.error('guildMemberRemove log failed', e); }
});

client.on('guildBanAdd', async (ban) => {
  try {
    if (!ban || !ban.guild || !ban.user) return;
    const nowTs = Math.floor(Date.now() / 1000);

    let moderatorId = null;
    let moderatorTag = 'Unknown';
    let reason = ban.reason || null;
    try {
      const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 6 }).catch(() => null);
      const entry = logs && logs.entries
        ? logs.entries.find(e => e && e.target && String(e.target.id) === String(ban.user.id) && (Date.now() - e.createdTimestamp) < 15000)
        : null;
      if (entry) {
        moderatorId = entry.executor ? entry.executor.id : null;
        if (entry.executor) moderatorTag = entry.executor.tag || entry.executor.username || entry.executor.id || moderatorTag;
        if (!reason && entry.reason) reason = entry.reason;
      }
    } catch (e) {}

    // Right-click ban logging: create a case unless the bot just banned via command (dedupe)
    let caseId = null;
    try {
      if (!hasRecentModAction(ban.guild.id, 'Ban', ban.user.id, moderatorId)) {
        caseId = createModlogCase({
          guild: ban.guild,
          type: 'Ban',
          userId: ban.user.id,
          moderatorId: moderatorId,
          reason: reason || 'No reason provided'
        });
      }
    } catch (e) {}

    const embed = buildSmallModerationEmbed({
      title: 'Nutzer gebannt',
      targetId: ban.user.id,
      targetAvatarUrl: ban.user.displayAvatarURL({ extension: 'png', size: 256 }),
      moderatorId,
      reason: reason || '—',
      caseId,
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

// --- Voice recording manager -------------------------------------------------
const recordingManager = new Map(); // key: `${guildId}:${channelId}` -> { connection, dir, files: Map }
// Glücksrad cooldowns (userId -> timestamp)
const wheelCooldowns = new Map();
// Einrad games per channel: channelId -> game state
const einradGames = new Map();

function ensureVoiceDir(guildId, channelId) {
  const base = path.join(DATA_DIR, 'voice_logs');
  const dir = path.join(base, String(guildId), String(channelId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function startVoiceRecording(guild, channel) {
  try {
    if (!voiceLib || !joinVoiceChannel) return false;
    const key = `${guild.id}:${channel.id}`;
    if (recordingManager.has(key)) return true;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    const dir = ensureVoiceDir(guild.id, channel.id);
    const rec = { connection, dir, files: new Map(), createdAt: Date.now() };
    recordingManager.set(key, rec);

    const receiver = connection.receiver;
    if (!receiver) return true;

    const startForUser = (userId) => {
      try {
        if (!rec || rec.files.has(userId)) return;
        const ts = Date.now();
        const filename = path.join(dir, `${ts}-${userId}.opus`);
        const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
        const out = fs.createWriteStream(filename);
        opusStream.pipe(out);
        rec.files.set(userId, { file: filename, stream: out, opusStream });
        opusStream.on('end', () => { try { out.end(); } catch(e){} });
      } catch (e) { console.warn('startForUser failed', e); }
    };

    // subscribe to currently speaking members
    try {
      const channelMembers = channel.members ? Array.from(channel.members.values()).filter(m => !m.user.bot) : [];
      for (const m of channelMembers) startForUser(m.id);
    } catch (e) {}

    // when someone starts speaking, create a stream
    try {
      receiver.speaking.on('start', (userId) => startForUser(userId));
    } catch (e) {}

    return true;
  } catch (e) { console.error('startVoiceRecording failed', e); return false; }
}

async function stopVoiceRecording(guild, channel) {
  try {
    if (!voiceLib) return false;
    const key = `${guild.id}:${channel.id}`;
    const rec = recordingManager.get(key);
    if (!rec) return false;
    // close opus streams
    try {
      for (const [userId, entry] of rec.files.entries()) {
        try { if (entry.opusStream && typeof entry.opusStream.destroy === 'function') entry.opusStream.destroy(); } catch (e) {}
        try { if (entry.stream && !entry.stream.destroyed) entry.stream.end(); } catch (e) {}
      }
    } catch (e) {}

    // disconnect
    try {
      const conn = rec.connection;
      if (conn && typeof conn.destroy === 'function') conn.destroy();
      else if (getVoiceConnection) {
        const c = getVoiceConnection(guild.id);
        if (c && typeof c.destroy === 'function') c.destroy();
      }
    } catch (e) {}

    // upload files to configured voice log channel
    try {
      const cfg = loadGuildConfig(guild.id);
      const voiceLogChannelId = process.env.VOICE_LOG_CHANNEL_ID || cfg.voiceLogChannelId || '1465791613488988194';
      let logCh = voiceLogChannelId ? (guild.channels.cache.get(String(voiceLogChannelId)) || await guild.channels.fetch(String(voiceLogChannelId)).catch(()=>null)) : null;
      if (!logCh) logCh = findLogChannel(guild);
      if (logCh && isTextLike(logCh)) {
        const files = [];
        for (const [userId, entry] of rec.files.entries()) {
          if (fs.existsSync(entry.file)) files.push(entry.file);
        }
        if (files.length) {
          const caption = `Voice logs from ${channel.name} — ${new Date(rec.createdAt).toISOString()}`;
          await logCh.send({ content: caption, files }).catch(()=>{});

          // optional transcription command (env TRANSCRIBE_CMD expects a template with {in} and {out})
          const cmdTemplate = process.env.TRANSCRIBE_CMD;
          if (cmdTemplate) {
            for (const f of files) {
              try {
                const outTxt = `${f}.txt`;
                const cmd = cmdTemplate.replace(/{in}/g, f).replace(/{out}/g, outTxt);
                await new Promise((resolve) => exec(cmd, { windowsHide: true }, () => resolve()));
                if (fs.existsSync(outTxt)) {
                  await logCh.send({ content: `Transcription for ${path.basename(f)}`, files: [outTxt] }).catch(()=>{});
                }
              } catch (e) { console.warn('transcription failed', e); }
            }
          }
        }
      }
    } catch (e) { console.error('upload voice logs failed', e); }

    recordingManager.delete(key);
    return true;
  } catch (e) { console.error('stopVoiceRecording failed', e); return false; }
}

// --- end voice recording manager -------------------------------------------

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    // Voice activity tracker (time in voice by member/channel)
    try { voiceActivity.handleVoiceStateUpdate(oldState, newState); } catch (e) {}

    // Join-to-create voice channels
    try {
      const didCreate = await handleJoinToCreateVoice(oldState, newState);
      if (didCreate) return; // skip logging the trigger-channel join; the move will emit another event
    } catch (e) {}

    // Delete created channels when they become empty
    try {
      if (oldState && oldState.channelId && (!newState || String(newState.channelId || '') !== String(oldState.channelId))) {
        const oldCh = oldState.channel;
        if (oldCh && voiceCreateState && voiceCreateState.channels && voiceCreateState.channels[String(oldCh.id)]) {
          await maybeDeleteCreatedVoiceChannel(oldCh);
        }
      }
    } catch (e) {}

    // Prefer explicit voice log channel if configured (env or guild config), fallback to generic log
    const cfg = loadGuildConfig(guild.id);
    const voiceLogChannelId = process.env.VOICE_LOG_CHANNEL_ID || cfg.voiceLogChannelId || '1466170115895591117';
    let logCh = voiceLogChannelId ? (guild.channels.cache.get(String(voiceLogChannelId)) || await guild.channels.fetch(String(voiceLogChannelId)).catch(()=>null)) : null;
    if (!logCh) logCh = findLogChannel(guild);
    if (!logCh || !isTextLike(logCh)) return;

    // join
    if (!oldState.channelId && newState.channelId) {
      const embed = new EmbedBuilder().setTitle('User joined channel').setColor(0x87CEFA)
        .setThumbnail(newState.member.user.displayAvatarURL({ extension: 'png', size: 256 }))
        .addFields(
          { name: 'User', value: `${newState.member.user.tag} (<@${newState.id}>)`, inline: true },
          { name: 'Channel', value: `${newState.channel ? `${newState.channel.name}` : newState.channelId}`, inline: true }
        ).setTimestamp()
        .setFooter(buildFooter(guild));
      await sendLog(guild, { embeds: [embed], category: 'voice' }).catch(()=>{});
      try { await startVoiceRecording(guild, newState.channel).catch(()=>{}); } catch (e) {}
    }

    // leave
    if (oldState.channelId && !newState.channelId) {
      const embed = new EmbedBuilder().setTitle('User left channel').setColor(0x87CEFA)
        .setThumbnail(oldState.member.user.displayAvatarURL({ extension: 'png', size: 256 }))
        .addFields(
          { name: 'User', value: `${oldState.member.user.tag} (<@${oldState.id}>)`, inline: true },
          { name: 'Channel', value: `${oldState.channel ? `${oldState.channel.name}` : oldState.channelId}`, inline: true }
        ).setTimestamp()
        .setFooter(buildFooter(guild));
      await sendLog(guild, { embeds: [embed], category: 'voice' }).catch(()=>{});
      try {
        const ch = oldState.channel;
        const nonBot = ch ? Array.from(ch.members.values()).filter(m => !m.user.bot).length : 0;
        if (nonBot === 0) await stopVoiceRecording(guild, ch).catch(()=>{});
      } catch (e) {}
    }
  } catch (e) { console.error('voiceStateUpdate log failed', e); }
});

client.on('messageDelete', async (message) => {
  try {
    const guild = message.guild;
    if (!guild) return;
    // Ignore seeded/simulated messages (ids like "sim_...")
    if (message && message._isSeed) return;
    if (String(message.id || '').startsWith('sim_')) return;

    const cfg = loadGuildConfig(guild.id);
    const messageLogChannelId = process.env.MESSAGE_LOG_CHANNEL_ID || cfg.messageLogChannelId || '1421523629044142252';
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
    // removed erroneous check against undefined `count`

    const embed = new EmbedBuilder()
      .setTitle('Message deleted')
      .setDescription(author ? `<@${author.id}>` : 'Unknown author')
      .setColor(0x87CEFA)
      .setThumbnail(author && typeof author.displayAvatarURL === 'function' ? author.displayAvatarURL({ extension: 'png', size: 256 }) : null)
      .addFields(
        { name: 'ID', value: `${message.id}`, inline: true },
        { name: 'Channel', value: message.channelId ? `<#${message.channelId}>` : 'Unknown', inline: true },
        { name: 'Time', value: `<t:${nowTs}:R>`, inline: false },
        { name: 'Content', value: content ? content.substring(0, 700) : '—', inline: false }
      );
    await logCh.send({ embeds: [embed] }).catch(() => {});
    // If this deleted message was an original announcement we tracked, cancel related posted summaries
    try {
      const deletedId = String(message.id || '');
      for (const [postedId, data] of Array.from(sessionPostData.entries())) {
        try {
          if (String(data.originMessageId || '') === deletedId) {
            // Attempt to fetch the channel/message where we posted the parsed summary
            const postedChannel = data && data.originChannelId ? await client.channels.fetch(String(data.originChannelId)).catch(()=>null) : null;
            let postedMsg = null;
            if (postedChannel && typeof postedChannel.messages?.fetch === 'function') {
              postedMsg = await postedChannel.messages.fetch(String(postedId)).catch(()=>null);
            }
            if (postedMsg) {
              try {
                // Edit embed to indicate cancellation and disable buttons
                const emb = postedMsg.embeds && postedMsg.embeds[0] ? EmbedBuilder.from(postedMsg.embeds[0]) : new EmbedBuilder().setTitle('Session parsed').setColor(0x87CEFA);
                emb.setDescription('Original announcement was deleted — sessions canceled.');
                // build a disabled row with only Claim (disabled)
                const claimBtn = new ButtonBuilder().setCustomId(`session_claim:${postedId}`).setLabel('Claim').setStyle(ButtonStyle.Primary).setDisabled(true);
                const comps = [claimBtn];
                if (data.parsed && Array.isArray(data.parsed)) {
                  for (const s of data.parsed.slice(0,10)) {
                    const b = new ButtonBuilder().setCustomId(`session_announce:${postedId}:${s.index}`).setLabel(`Announce S${s.index}`).setStyle(ButtonStyle.Secondary).setDisabled(true);
                    comps.push(b);
                  }
                }
                const row = new ActionRowBuilder().addComponents(...comps);
                await postedMsg.edit({ embeds: [emb], components: [row] }).catch(()=>{});
              } catch (ee) { /* ignore edit errors */ }
            }
            // cleanup in-memory/persisted records
            try { sessionPostData.delete(String(postedId)); saveSessionPosts(); } catch (ee) {}
            try { sessionClaims.delete(String(postedId)); saveClaims(); } catch (ee) {}
          }
        } catch (ee) {}
      }
    } catch (e) { console.error('failed to cancel sessions after original message delete', e); }
  } catch (e) { console.error('messageDelete log failed', e); }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    const guild = newMessage.guild || oldMessage.guild;
    if (!guild) return;

    // Ignore bot edits
    const author = (newMessage && newMessage.author) || (oldMessage && oldMessage.author);
    if (author && author.bot) return;

    const cfg = loadGuildConfig(guild.id);
    const messageLogChannelId = process.env.MESSAGE_LOG_CHANNEL_ID || cfg.messageLogChannelId || '1421523629044142252';
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
      .setTitle('Message edited')
      .setDescription(author ? `<@${author.id}>` : 'Unknown author')
      .setColor(0x87CEFA)
      .setThumbnail(author && typeof author.displayAvatarURL === 'function' ? author.displayAvatarURL({ extension: 'png', size: 256 }) : null)
      .addFields(
        { name: 'ID', value: `${msgId || '—'}`, inline: true },
        { name: 'Channel', value: channelId ? `<#${channelId}>` : 'Unknown', inline: true },
        { name: 'Time', value: `<t:${nowTs}:R>`, inline: false },
        { name: 'Update', value: `${before ? before.substring(0, 350) : '—'}\n→\n${after ? after.substring(0, 350) : '—'}`, inline: false }
      );
    await logCh.send({ embeds: [embed] }).catch(() => {});
    // If an original announcement message was edited, update the corresponding session embed
    try {
      const editedContent = (newFetched && typeof newFetched.content === 'string') ? newFetched.content : '';
      const editedId = (newFetched && newFetched.id) || (oldFetched && oldFetched.id);
      if (editedId && editedContent) {
        // If no prior parsed summary exists, trigger a fresh parse via messageCreate flow
        try {
          const existing = sessionOriginToPosted.get(String(editedId)) || Array.from(sessionPostData.values()).find(v => String(v.originMessageId || '') === String(editedId));
          const channelId = (newFetched && newFetched.channelId) || (oldFetched && oldFetched.channelId);
          const channelName = String(newFetched?.channel?.name || oldFetched?.channel?.name || '').toLowerCase();
          const isWatched = channelId ? loadWatchChannels(guild.id).has(String(channelId)) : false;
          const looksLikeSession = /\b\d+\s*[\.)-]\s*[0-2]?\d[:.][0-5]\d\s*(?:-|–|—|to)\s*[0-2]?\d[:.][0-5]\d\b|registration\s*opens|game\s*1\/3|duo\s*practice\s*session|<t:\d+:t>/i.test(editedContent);
          const nameLooksLikeSession = /(alpha|beta|session|sessions|claim|claiming)/i.test(channelName);
          if (!existing && (isWatched || (looksLikeSession && nameLooksLikeSession))) {
            const seedMsg = Object.assign({}, newFetched || oldFetched, { content: editedContent, _isSeed: true });
            try { client.emit('messageCreate', seedMsg); } catch (ee) {}
          }
        } catch (ee) {}
        for (const [postedId, data] of sessionPostData.entries()) {
          try {
            if (String(data.originMessageId || '') === String(editedId)) {
              // Re-parse the edited announcement and update stored parsed data
              const newSessions = parseSessionMessage(editedContent, new Date());
              data.parsed = newSessions || [];
              data.raw = String(editedContent || '').substring(0, 4000);
              // try to update the bot-posted embed
              try {
                const postedChannel = await client.channels.fetch(data.originChannelId).catch(()=>null);
                if (postedChannel && typeof postedChannel.messages?.fetch === 'function') {
                  const postedMsg = await postedChannel.messages.fetch(postedId).catch(()=>null);
                  if (postedMsg && postedMsg.embeds && postedMsg.embeds[0]) {
                    const oldEmbed = postedMsg.embeds[0];
                    const e = EmbedBuilder.from(oldEmbed);
                    // update description to show parsed sessions
                    const lines = (newSessions || []).map(s => `• ${s.index}. <t:${Math.floor(s.start/1000)}:t> - <t:${Math.floor(s.end/1000)}:t> — Staff: ${s.staff || 'Unassigned'}`);
                    if (lines.length) e.setDescription(lines.slice(0,12).join('\n'));
                    // rebuild components (announce buttons) preserving claim button and disabled state per session
                    try {
                      const rows = buildSessionButtonRows(postedId, data.parsed || []);
                      await postedMsg.edit({ embeds: [e], components: rows }).catch(()=>{});
                    } catch (ee) { /* ignore component rebuild errors */ }
                  }
                }
              } catch (ee) { console.error('failed to update posted session embed after edit', ee); }
              try { saveSessionPosts(); } catch (ee) { console.error('failed to save session posts after edit', ee); }
            }
          } catch (ee) { /* continue */ }
        }
        try {
          const channelId = (newFetched && newFetched.channelId) || (oldFetched && oldFetched.channelId);
          const ch = channelId ? await client.channels.fetch(channelId).catch(()=>null) : null;
          if (ch) await ensureParsedButtons(ch, newSessions || []);
        } catch (ee) {}
      }
    } catch (e) { console.error('failed to propagate message edit to session embeds', e); }
  } catch (e) {
    console.error('messageUpdate log failed', e);
  }
});

client.on('messageDeleteBulk', async (messages, channel) => {
  try {
    const guild = channel && channel.guild;
    if (!guild) return;

    const cfg = loadGuildConfig(guild.id);
    const messageLogChannelId = process.env.MESSAGE_LOG_CHANNEL_ID || cfg.messageLogChannelId || '1421523629044142252';
    const logCh = messageLogChannelId
      ? (guild.channels.cache.get(messageLogChannelId) || await guild.channels.fetch(messageLogChannelId).catch(() => null))
      : findLogChannel(guild);
    if (!logCh || !isTextLike(logCh)) return;

    const nowTs = Math.floor(Date.now() / 1000);
    // Exclude seeded/simulated messages from bulk delete counts
    let count = 0;
    try {
      if (messages && typeof messages.filter === 'function') count = messages.filter(m => !(m && m._isSeed) && !String(m.id || '').startsWith('sim_')).size;
      else if (Array.isArray(messages)) count = messages.filter(m => !(m && m._isSeed) && !String(m.id || '').startsWith('sim_')).length;
      else count = 0;
    } catch (e) { count = 0; }
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
  if (interTicket && typeof interTicket.execute === 'function') client.on('interactionCreate', async (interaction) => { try { await interTicket.execute(interaction); } catch (err) { console.error('ticket interaction handler error', err); } });
} catch (e) { console.error('Failed to load interactionCreate.ticket.js', e); }

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  

  // Prefix command: *va / *voiceactivity [1d|7d|30d]
  try {
    const rawVa = (message.content || '').trim();
    if (message.guild && rawVa.startsWith(PREFIX)) {
      const parts = rawVa.slice(PREFIX.length).trim().split(/\s+/);
      const cmd = String(parts.shift() || '').toLowerCase();
      if (cmd === 'va' || cmd === 'voiceactivity' || cmd === 'voice-activity') {
        const range = String(parts.shift() || '7d').toLowerCase();
        const embed = await voiceActivity.buildVoiceActivityEmbed(message.guild, { range, viewerId: message.author.id });
        const components = voiceActivity.buildVoiceActivityComponents(range);
        await message.channel.send({ embeds: [embed], components }).catch(() => null);
        return;
      }
    }
  } catch (e) { console.error('va prefix command failed', e); }


  // Prefix command: -dm / <PREFIX>dm  -> DMs a user with a purple embed
  // Usage: -dm @user <message>
  try {
    const raw = (message.content || '').trim();
    const lowered = raw.toLowerCase();
    const dmPrefixA = `${PREFIX}dm`;
    const dmPrefixB = `-dm`;
    const isDmCmd = lowered === dmPrefixA || lowered.startsWith(dmPrefixA + ' ') || lowered === dmPrefixB || lowered.startsWith(dmPrefixB + ' ');

    if (isDmCmd) {
      if (!message.guild) return replyAsEmbed(message, 'Dieses Kommando kann nur auf einem Server verwendet werden.');

      const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      const isStaff = member
        ? (cfg.staffRoleId && member.roles.cache.has(String(cfg.staffRoleId).replace(/[<@&>]/g, '')))
          || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        : false;

      if (!isStaff) return;

      const parts = raw.split(/\s+/);
      const targetArg = parts[1];
      const dmText = parts.slice(2).join(' ').trim();
      const targetId = parseId(targetArg) || (targetArg && /^\d+$/.test(targetArg) ? targetArg : null);

      if (!targetId || !dmText) {
        return replyAsEmbed(message, `Usage: ${PREFIX}dm @user <message>  oder  -dm @user <message>`);
      }

      const targetUser = await client.users.fetch(targetId).catch(() => null);
      if (!targetUser) return replyAsEmbed(message, 'User nicht gefunden.');

      const embed = new EmbedBuilder()
        .setColor(0x87CEFA)
        .setTitle('Nachricht')
        .setDescription(dmText.substring(0, 4000))
        .setTimestamp()
        .setFooter({ text: `Von ${message.guild.name}` });

      try {
        await targetUser.send({ embeds: [embed] });
      } catch (e) {
        return replyAsEmbed(message, 'Could not send DM (DMs disabled or user blocked).');
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

      return replyAsEmbed(message, `DM gesendet an ${targetUser.tag}.`);
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
      if (!message.guild) return replyAsEmbed(message, 'This command can only be used in a server.');

      const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      const isStaff = member
        ? (cfg.staffRoleId && member.roles.cache.has(String(cfg.staffRoleId).replace(/[<@&>]/g, '')))
          || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        : false;
      if (!isStaff) return;

      const { token: t, source: src } = resolveToken();
      const len = t ? t.length : 0;
      const masked = t ? `${String(t).slice(0, 4)}…${String(t).slice(-4)}` : '(none)';

      const embed = new EmbedBuilder()
        .setColor(0x87CEFA)
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
      if (!message.guild) return replyAsEmbed(message, 'Dieses Kommando kann nur auf einem Server verwendet werden.');
      const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
      const maxOpen = Number(cfg.maxOpenPerUser) || 1;
      const userId = message.author.id;

      // check open tickets for this user
      const existing = message.guild.channels.cache.filter(c => c.topic && c.topic.startsWith(`ticket:${userId}:`));
      if (existing.size >= maxOpen) return replyAsEmbed(message, 'You already have an open ticket. Please close it first.');

      // Send a professional ticket panel with a button (user can create their private ticket)
      const panelEmbed = new EmbedBuilder()
        .setTitle('🎫 Support Tickets')
        .setDescription('Click **Create Ticket** to open a private ticket.\nA staff member will assist you as soon as possible.')
        .setColor(0x87CEFA)
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
          const reason = inviteRe.test(message.content) ? 'Posting invite link' : 'Posting link';

          let timedOut = false;
          try {
            await message.member.timeout(muteMs, `AutoMod: ${reason}`);
            timedOut = true;
          } catch (e) {
            timedOut = false;
            console.error('autmod timeout failed', e);
          }

          const type = timedOut ? 'AutoMute' : 'AutoModDelete';
          const caseId = createModlogCase({
            guild: message.guild,
            type,
            userId: message.author.id,
            moderatorId: 'AutoMod',
            reason,
            durationMs: timedOut ? muteMs : undefined,
            extra: {
              channelId: message.channel ? String(message.channel.id) : null,
              messageId: message.id ? String(message.id) : null,
              timedOut,
            }
          });

          if (timedOut) markRecentModAction(message.guild?.id, 'Mute', message.author.id, 'AutoMod');

          // Send a compact DM to the user (only if we actually timed out)
          if (timedOut) {
            try {
              await sendModEmbedToUser(message.author, 'AutoMute', { guild: message.guild, moderatorTag: 'AutoMod', reason, caseId, durationText: `${cfg.muteMinutes} minutes` });
            } catch (e) {}
          }

          try {
            const logChannel = message.guild.channels.cache.find(c => cfg.logChannelNames.includes(c.name));
            if (logChannel && logChannel.isText()) {
              if (timedOut) {
                await logChannel.send({ embeds: [createChannelConfirmEmbed(`Auto-muted <@${message.author.id}> for ${cfg.muteMinutes} minutes — Reason: ${reason}`, caseId)] }).catch(() => {});
              } else {
                await logChannel.send({ embeds: [createChannelConfirmEmbed(`Auto-deleted a message from <@${message.author.id}> — Reason: ${reason}`, caseId)] }).catch(() => {});
              }
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
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
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
          if (!collected.length) return replyAsEmbed(message, 'No recent messages found to delete.');
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
          try {
            const confMsg = await message.channel.send({ embeds: [chConfirm] }).catch(()=>null);
            // remove confirmation and the original command after a short delay
            setTimeout(() => {
              try { if (confMsg && typeof confMsg.delete === 'function') confMsg.delete().catch(()=>{}); } catch (e) {}
              try { if (message && typeof message.delete === 'function') message.delete().catch(()=>{}); } catch (e) {}
            }, 5000);
          } catch (e) {}
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
          return replyAsEmbed(message, 'Failed to purge messages.');
        }
        return;
      }

      // Otherwise, target the specified user and delete their recent messages
      let targetId = (parseId(userArg) || userArg.replace(/[<@!>]/g, ''));
      if (!targetId) return replyAsEmbed(message, 'Usage: -purg <count> [user mention|id]');
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
        if (!collected.length) return replyAsEmbed(message, 'No recent messages found for that user to delete.');
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
        try {
          const confMsg = await message.channel.send({ embeds: [chConfirm] }).catch(()=>null);
          setTimeout(() => {
            try { if (confMsg && typeof confMsg.delete === 'function') confMsg.delete().catch(()=>{}); } catch (e) {}
            try { if (message && typeof message.delete === 'function') message.delete().catch(()=>{}); } catch (e) {}
          }, 5000);
        } catch (e) {}
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
        return replyAsEmbed(message, 'Failed to purge messages.');
      }
      return;
    }
    if (cmd.toLowerCase() === 'blacklist') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
      const id = parseId(rest[0]) || rest[0];
      const reason = rest.slice(1).join(' ') || 'No reason provided';
      if (!id || !/^\d+$/.test(id)) return replyAsEmbed(message, 'Please provide a valid user ID to blacklist.');

      const existingEntry = blacklist.blacklisted.find(b => b && typeof b === 'object' && String(b.id) === String(id));

      // If the provided ID is actually a guild, treat this as blacklisting a server
      const maybeGuild = client.guilds.cache.get(id) || await client.guilds.fetch(id).catch(() => null);
      if (maybeGuild) {
        const existingGuildEntry = blacklist.blacklisted.find(b => String(b.id) === String(id) && b.type === 'guild');
        if (existingGuildEntry) {
          existingGuildEntry.moderator = message.author.id;
          existingGuildEntry.time = Date.now();
          existingGuildEntry.reason = reason;
        } else {
          blacklist.blacklisted.push({ id, type: 'guild', reason, moderator: message.author.id, time: Date.now() });
        }
        saveJson(BLACKLIST_PATH, blacklist);

        // Unified modlog + actions.md
        createModlogCase({
          guild: message.guild,
          type: 'GuildBlacklist',
          userId: `guild:${id}`,
          moderatorId: message.author.id,
          reason,
          extra: { guildId: id, guildName: maybeGuild.name }
        });

        const embed = new EmbedBuilder()
          .setColor(0x87CEFA)
          .setTitle('Blacklist')
          .addFields(
            { name: 'Server', value: `${maybeGuild.name} (${id})`, inline: true },
            { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
            { name: 'Success', value: `1 server`, inline: true },
            { name: 'Failed', value: `0 servers`, inline: true }
          )
          .setTimestamp()
          .setFooter(buildFooter(message.guild));

        if (existingGuildEntry) embed.setDescription('Server already blacklisted.');
        return message.channel.send({ embeds: [embed] });
      }

      // Ban targets (explicit list as requested) — user ID blacklist path
      const targetGuildIds = [
        '1459330497938325676',
        '1459345285317791917',
        '1368527215343435826',
        '1339662600903983154',
      ];

      const banAttempts = [];
      for (const gid of targetGuildIds) {
        if (BLACKLIST_EXCLUDE_GUILD_IDS.has(String(gid))) {
          banAttempts.push({ guildId: gid, guildName: null, ok: false, error: 'Excluded from blacklist by config' });
          continue;
        }
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

      // Unified modlog + actions.md
      createModlogCase({
        guild: message.guild,
        type: 'Blacklist',
        userId: id,
        moderatorId: message.author.id,
        reason,
        extra: { success, failed }
      });

      const embed = new EmbedBuilder()
        .setColor(0x87CEFA)
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

      // Do not list individual server results here; only counts are shown.
      return message.channel.send({ embeds: [embed] });
    }

    if (cmd.toLowerCase() === 'destaff' || cmd.toLowerCase() === 'destaffban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
      const id = parseId(rest[0]) || rest[0];
      const reason = rest.slice(1).join(' ') || 'Kein Grund angegeben';
      if (!id || !/^\d+$/.test(id)) return replyAsEmbed(message, 'Bitte gib eine gültige User-ID oder Mention an.');

      // Requested now: ONLY remove staff roles, do NOT ban.
      const shouldBan = false;
      let member = null;
      try {
        member = await message.guild.members.fetch(id).catch(() => null);
      } catch (e) {}

      if (!member) return replyAsEmbed(message, 'User not found in this guild.');

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
        .setColor(0x87CEFA)
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
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
      const id = parseId(rest[0]) || rest[0];
      if (!id || !/^\d+$/.test(id)) return replyAsEmbed(message, 'Please provide a valid user ID.');

      if (!blacklist || typeof blacklist !== 'object') blacklist = { blacklisted: [] };
      if (!Array.isArray(blacklist.blacklisted)) blacklist.blacklisted = [];

      const idx = blacklist.blacklisted.findIndex(b => String(b.id) === String(id));
      if (idx === -1) return replyAsEmbed(message, 'This ID is not in the blacklist.');

      const removed = blacklist.blacklisted.splice(idx, 1)[0];
      saveJson(BLACKLIST_PATH, blacklist);

      // If the removed entry was a server (guild) blacklist, just report and stop — no unban attempts
      if (removed && removed.type === 'guild') {
        const maybeGuild = client.guilds.cache.get(id) || await client.guilds.fetch(id).catch(() => null);
        const serverLabel = maybeGuild ? `${maybeGuild.name} (${id})` : id;

        // Unified modlog + actions.md
        createModlogCase({
          guild: message.guild,
          type: 'GuildUnblacklist',
          userId: `guild:${id}`,
          moderatorId: message.author.id,
          reason: `Removed from blacklist${removed && removed.reason ? ` (was: ${String(removed.reason).slice(0, 128)})` : ''}`,
          extra: { guildId: id, guildName: maybeGuild ? maybeGuild.name : null }
        });

        const embed = new EmbedBuilder()
          .setColor(0x87CEFA)
          .setTitle('Unblacklist')
          .addFields(
            { name: 'Server', value: serverLabel, inline: true },
            { name: 'Removed by', value: message.author.tag, inline: true },
            { name: 'Result', value: 'Removed from blacklist', inline: true }
          )
          .setTimestamp()
          .setFooter(buildFooter(message.guild));
        return message.channel.send({ embeds: [embed] });
      }

      // Unban across the same explicit target guild list as -blacklist
      const targetGuildIds = [
        '1459330497938325676',
        '1459345285317791917',
        '1368527215343435826',
        '1339662600903983154',
      ];

      const unbanAttempts = [];
      for (const gid of targetGuildIds) {
        if (BLACKLIST_EXCLUDE_GUILD_IDS.has(String(gid))) {
          unbanAttempts.push({ guildId: gid, guildName: null, ok: false, note: null, error: 'Excluded from unblacklist by config' });
          continue;
        }
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

      // Unified modlog + actions.md
      createModlogCase({
        guild: message.guild,
        type: 'Unblacklist',
        userId: id,
        moderatorId: message.author.id,
        reason: `Removed from blacklist; unban attempts: ${success} ok, ${failed} failed`,
        extra: { success, failed }
      });

      const embed = new EmbedBuilder()
        .setColor(0x87CEFA)
        .setTitle('Unblacklist')
        .addFields(
          { name: 'User', value: id, inline: true },
          { name: 'Removed by', value: message.author.tag, inline: true },
          { name: 'Unban success', value: `${success} servers`, inline: true },
          { name: 'Unban failed', value: `${failed} servers`, inline: true }
        )
        .setTimestamp()
        .setFooter(buildFooter(message.guild));

      // Do not list individual server results here; only counts are shown.
      return message.channel.send({ embeds: [embed] });
    }

    if (cmd.toLowerCase() === 'bll') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;

      if (!blacklist.blacklisted.length) return replyAsEmbed(message, 'Blacklist is empty.');

      const arg = rest[0] ? (parseId(rest[0]) || rest[0]) : null;
      if (arg && /^\d+$/.test(String(arg))) {
        const entry = blacklist.blacklisted.find(b => String(b.id) === String(arg));
        if (!entry) return replyAsEmbed(message, 'This user is not in the blacklist.');

        const embed = new EmbedBuilder()
          .setTitle('Blacklist Entry')
            .setColor(0x87CEFA)
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
        .setColor(0x87CEFA)
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
          const embed = new EmbedBuilder().setTitle('Blacklist updated').setColor(0x87CEFA)
            .setDescription(`ID blacklisted by ${message.author.tag}`)
            .addFields({ name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true });
          await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
        }
      }
    } catch (e) { console.error('blacklist log failed', e); }
  }

  // -invite <userId|mention> : create a single-use invite for this guild and DM it to the user
  if (message.content.startsWith('-invite')) {
    const [cmd, ...rest] = message.content.slice(1).trim().split(/\s+/);
    if (!cmd || cmd.toLowerCase() !== 'invite') return;
    const targetArg = rest[0];
    const id = parseId(targetArg) || targetArg;
    if (!id || !/^\d+$/.test(String(id))) return message.channel.send({ embeds: [createChannelConfirmEmbed('Usage: -invite <userId|mention>')] });

    try {
      if (!message.guild) return message.channel.send({ embeds: [createChannelConfirmEmbed('This command must be run in a server channel.')] });
      // create single-use, non-expiring invite for this channel
      const invite = await message.channel.createInvite({ maxAge: 0, maxUses: 1, unique: true, reason: `${message.author.tag}: invite` });
      const targetUser = await client.users.fetch(String(id)).catch(() => null);
      const dmEmbed = new EmbedBuilder()
        .setTitle(`Invite to ${message.guild.name}`)
        .setDescription(`You have been invited to join **${message.guild.name}**.\n\n[Click here to join](${invite.url})`)
        .setColor(0x87CEFA)
        .setTimestamp();

      if (targetUser) {
        await targetUser.send({ embeds: [dmEmbed] }).catch((err) => { console.error('failed to DM invite', err); });
        return message.channel.send({ embeds: [createChannelConfirmEmbed(`Invite sent to <@${id}>`, null, id)] });
      }

      return message.channel.send({ embeds: [createChannelConfirmEmbed('Could not find the user to DM the invite.', null, id)] });
    } catch (e) {
      console.error('invite command failed', e);
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Failed to create or send invite — check permissions.', null, id)] });
    }
  }

  // Admin modlog edits via * commands
  // Public modlog viewer: *md <user> [page]
  if (message.content.startsWith('*md') || message.content.startsWith('*mds')) {
    try {
      reloadModlogs();
      const parts = message.content.slice(1).trim().split(/\s+/);
      // parts[0] is md or mds
      const cmd = parts[0].toLowerCase();
      const userArg = parts[1] || message.author.id;
      const pageArg = parseInt(parts[2], 10) || 1;
      const perPage = cmd === 'mds' ? 8 : 5;
      // resolve simple id/mention
      const uid = (userArg || '').replace(/[<@!>]/g, '').trim();
      const targetId = uid || message.author.id;

      // Only show logs for the server where *md is executed
      if (!message.guild) {
        return message.channel.send({ embeds: [createChannelConfirmEmbed('Dieses Kommando kann nur auf einem Server verwendet werden.')] });
      }
      const currentGuildId = String(message.guild.id);

      let cases = (modlogs && modlogs.cases) ? Array.from(modlogs.cases) : [];
      cases = cases.filter(c => String(c.user) === String(targetId) && c.guildId && String(c.guildId) === currentGuildId);

      // Latest first
      cases.sort((a, b) => {
        const ta = Number(a && a.time ? a.time : 0);
        const tb = Number(b && b.time ? b.time : 0);
        if (tb !== ta) return tb - ta;
        return Number(b && b.caseId ? b.caseId : 0) - Number(a && a.caseId ? a.caseId : 0);
      });
      
      if (!cases.length) return message.channel.send({ embeds: [createChannelConfirmEmbed('No modlogs found for that user.')] });

      const totalPages = Math.max(1, Math.ceil(cases.length / perPage));
      const page = Math.max(1, Math.min(totalPages, pageArg));
      const start = (page - 1) * perPage;
      const pageCases = cases.slice(start, start + perPage);
      const embed = new EmbedBuilder()
        .setTitle(`Modlogs for ${targetId}`)
        .setColor(0x87CEFA)
        .setTimestamp()
        .setDescription(`Server: **${message.guild.name}** (${currentGuildId})`);
      for (const c of pageCases) {
        const ts = c.time ? Math.floor(Number(c.time)/1000) : null;
        const date = ts ? `<t:${ts}:f>` : '';

        // Build moderator display: prefer username + id when available, avoid pinging
        let moderatorDisplay = 'Unknown';
        try {
          if (c.moderator) {
            if (/^\d+$/.test(String(c.moderator))) {
              const mu = await client.users.fetch(String(c.moderator)).catch(() => null);
              moderatorDisplay = mu ? `${mu.username} (${c.moderator})` : `${c.moderator}`;
            } else {
              moderatorDisplay = String(c.moderator);
            }
          }
        } catch (e) { moderatorDisplay = String(c.moderator || 'Unknown'); }

        const dur = c.durationMs ? ` (${humanDurationLong(c.durationMs)})` : '';
        const typeLine = `Type: ${String(c.type || 'Unknown')}${dur}`;
        const reasonLine = `Reason: ${String(c.reason || '—')}${date ? ' - ' + date : ''}`;

        embed.addFields({ name: `Case ${c.caseId}`, value: `${typeLine}\nModerator: ${moderatorDisplay}\n${reasonLine}`, inline: false });
      }
      embed.setFooter({ text: `Page ${page}/${totalPages} — Showing ${pageCases.length} of ${cases.length}` });
      return message.channel.send({ embeds: [embed] });
    } catch (e) { console.error('md viewer failed', e); }
  }

  if (message.content.startsWith('*')) {
    const [cmd, ...rest] = message.content.slice(1).trim().split(/\s+/);
    if (!cmd) return;
    // Permission: require ManageGuild
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;

    // Always operate on persisted data for admin edits.
    reloadModlogs();

    if (cmd.toLowerCase() === 'reason') {
      const caseId = parseInt(rest[0], 10);
      const newReason = rest.slice(1).join(' ');
      if (!caseId || !newReason) return replyAsEmbed(message, 'Usage: *reason <caseId> <new reason>');
      const c = modlogs.cases.find(x => Number(x.caseId) === Number(caseId));
      if (!c) return replyAsEmbed(message, `Case ${caseId} not found.`);
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
      if (!caseId || !durStr) return replyAsEmbed(message, 'Usage: *duration <caseId> <duration> (e.g. 3d, 2h30m, 15m)');
      const ms = parseDurationToMs(durStr);
      if (ms === null) return replyAsEmbed(message, 'Invalid duration format. Use e.g. 3d, 2h30m, 15m');
      const c = modlogs.cases.find(x => Number(x.caseId) === Number(caseId));
      if (!c) return replyAsEmbed(message, `Case ${caseId} not found.`);
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

    if (cmd.toLowerCase() === 'dcase' || cmd.toLowerCase() === 'delcase' || cmd.toLowerCase() === 'deletecase') {
      const caseId = parseInt(rest[0], 10);
      if (!caseId) return replyAsEmbed(message, 'Usage: *dcase <caseId>');
      if (!modlogs || typeof modlogs !== 'object') modlogs = { lastCase: 10000, cases: [] };
      if (!Array.isArray(modlogs.cases)) modlogs.cases = [];

      const idx = modlogs.cases.findIndex(x => Number(x && x.caseId) === Number(caseId));
      if (idx === -1) return replyAsEmbed(message, `Case ${caseId} not found.`);

      const c = modlogs.cases[idx];
      // Safety: if case has a guildId, only allow deletion from within that same guild.
      if (message.guild && c && c.guildId && String(c.guildId) !== String(message.guild.id)) {
        return replyAsEmbed(message, `Case ${caseId} belongs to another guild (${c.guildId}) and can't be deleted here.`);
      }

      modlogs.cases.splice(idx, 1);
      saveJson(MODLOGS_PATH, modlogs);

      // Optional: log the deletion to moderation logs
      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const embed = buildSmallModerationEmbed({
          title: 'Case gelöscht',
          targetId: c && c.user ? String(c.user) : null,
          targetAvatarUrl: null,
          moderatorId: message.author.id,
          reason: `Deleted case ${caseId}${c && c.type ? ` (${c.type})` : ''}`,
          caseId,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
      } catch (e) {}

      return message.channel.send({ embeds: [createChannelConfirmEmbed(`Deleted case ${caseId}`, caseId, c && c.user ? String(c.user) : null)] });
    }

    if (cmd.toLowerCase() === 'moderations') {
      const userId = rest[0];
      if (!userId) return replyAsEmbed(message, 'Usage: *moderations <userId>');
      const userCases = modlogs.cases.filter(c => String(c.user) === String(userId));
      if (userCases.length === 0) return replyAsEmbed(message, `No moderations found for user ${userId}.`);
      
      const embed = new EmbedBuilder()
        .setTitle(`📊 Moderations for ${userId}`)
        .setColor(0x87CEFA)
        .setDescription(`Total: **${userCases.length}** moderation(s)`)
        .setTimestamp();

      // Discord limits embeds to 25 fields; cap and indicate if more exist
      const maxFields = 25;
      const fieldsToShow = userCases.slice(0, maxFields).map(c => {
        const ts = c.time ? Math.floor(Number(c.time) / 1000) : null;
        const dateStr = ts ? `${formatHammertime(c.time)} (<t:${ts}:f>)` : 'n/a';
        return ({
          name: `Case #${c.caseId} — ${c.type}`,
          value: `Reason: ${String(c.reason || 'No reason provided')}\nModerator: <@${c.moderator}>\nDate: ${dateStr}`,
          inline: false
        });
      });

      if (fieldsToShow.length) embed.addFields(fieldsToShow);
      if (userCases.length > maxFields) {
        embed.addFields({ name: 'Note', value: `Showing first ${maxFields} of ${userCases.length} entries. Use pagination to view more.`, inline: false });
      }
      
      return message.channel.send({ embeds: [embed] });
    }

    if (cmd.toLowerCase() === 'case') {
      const caseId = parseInt(rest[0], 10);
      if (!caseId) return replyAsEmbed(message, 'Usage: *case <caseId>');
      const c = modlogs.cases.find(x => Number(x.caseId) === Number(caseId));
      if (!c) return replyAsEmbed(message, `Case ${caseId} not found.`);
      
      // prepare reason and date (use hammertime). If reason contains a trailing date, extract it.
      let reasonText = String(c.reason || 'No reason provided');
      let when = c.time ? formatHammertime(c.time) : 'n/a';
      try {
        const m = reasonText.match(/\s*-\s*(\d{1,2} [A-Za-z]+ \d{4} \d{2}:\d{2})$/);
        if (!c.time && m && m[1]) {
          const parsed = new Date(m[1]);
          if (!isNaN(parsed.getTime())) {
            when = formatHammertime(parsed);
            reasonText = reasonText.replace(/\s*-\s*\d{1,2} [A-Za-z]+ \d{4} \d{2}:\d{2}$/, '').trim();
          }
        }
      } catch (e) {}

      const embed = new EmbedBuilder()
        .setTitle(`📋 Case #${c.caseId}`)
        .setColor(0x87CEFA)
        .addFields(
            { name: 'Type', value: `${c.type || 'Unknown'}`, inline: true },
            { name: 'User', value: `<@${c.user}> (${c.user})`, inline: true },
            { name: 'Moderator', value: `${c.moderator ? `<@${c.moderator}>` : 'n/a'}`, inline: true },
            { name: 'Reason', value: `${reasonText}`, inline: false },
            { name: 'Date', value: `${when}`, inline: true }
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

  // Re-ban all currently banned users and log to modlogs (*md)
  if (command === 'allban' || command === 'rebanall' || command === 'reban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
    if (!message.guild) return replyAsEmbed(message, 'Dieses Kommando kann nur auf einem Server verwendet werden.');

    const reason = 'Perm';
    let total = 0;
    let ok = 0;
    let failed = 0;
    let pruned = 0;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    try {
      const bans = await message.guild.bans.fetch().catch(() => null);
      const list = bans ? Array.from(bans.values()) : [];
      total = list.length;
      if (!total) return replyAsEmbed(message, 'Keine gebannten User gefunden.');

      await replyAsEmbed(message, `Starte *allban für ${total} bereits gebannte User… (Reason: ${reason})`);

      for (const b of list) {
        const uid = b && b.user ? b.user.id : null;
        if (!uid) { failed++; continue; }

        // Prevent double logging from audit/event handlers during bulk actions
        markRecentModAction(message.guild.id, 'Unban', uid, '*');
        markRecentModAction(message.guild.id, 'Ban', uid, '*');

        try {
          // Unban first, then ban again so audit-log reason becomes exactly "Perm".
          await message.guild.bans.remove(uid, reason).catch(() => {});
          await sleep(900);
          await message.guild.members.ban(uid, { reason }).catch(() => { throw new Error('ban failed'); });

          // Prune modlogs for this user in this guild so only one case remains
          try {
            const gid = String(message.guild.id);
            const beforeLen = Array.isArray(modlogs.cases) ? modlogs.cases.length : 0;
            modlogs.cases = (Array.isArray(modlogs.cases) ? modlogs.cases : []).filter(c => {
              try {
                if (!c) return false;
                if (String(c.user || '') !== String(uid)) return true;
                if (!c.guildId) return true; // safety: don't delete cases without guildId
                return String(c.guildId) !== gid;
              } catch (e) {
                return true;
              }
            });
            const afterLen = modlogs.cases.length;
            if (afterLen !== beforeLen) pruned += (beforeLen - afterLen);

            const caseId = createModlogCase({
              guild: message.guild,
              type: 'Ban',
              userId: uid,
              moderatorId: message.author.id,
              reason
            });

            // Dedupe against guildBanAdd audit executor = bot
            markRecentModAction(message.guild.id, 'Ban', uid, '*');
            // Ensure file state is consistent after prune + insert
            saveJson(MODLOGS_PATH, modlogs);
            // createModlogCase already wrote actions.md

          } catch (e) {}

          ok++;
        } catch (e) {
          failed++;
        }

        // Gentle pacing to avoid rate limits
        await sleep(900);
      }
    } catch (e) {
      return replyAsEmbed(message, 'allban fehlgeschlagen.');
    }

    return replyAsEmbed(message, `allban abgeschlossen. Gebannte (vorher): ${total}, Erfolg: ${ok}, Fehler: ${failed}, Gelöschte Cases (nur diese Guild): ${pruned}.`);
  }

  // Member count command
  if (command === 'membercount' || command === 'mc') {
    if (!message.guild) return replyAsEmbed(message, 'Dieses Kommando kann nur auf einem Server verwendet werden.');
    const total = message.guild.memberCount || 0;
    const bots = message.guild.members?.cache?.filter(m => m.user?.bot).size || 0;
    const humans = Math.max(0, total - bots);
    const embed = new EmbedBuilder()
      .setTitle('Member Count')
      .setColor(0x87CEFA)
      .addFields(
        { name: 'Total', value: String(total), inline: true },
        { name: 'Humans', value: String(humans), inline: true },
        { name: 'Bots', value: String(bots), inline: true }
      )
      .setTimestamp()
      .setFooter(buildFooter(message.guild));
    return message.channel.send({ embeds: [embed] });
  }

  // Intentionally do not log every command execution (e.g. !say).
  // Moderation commands create their own dedicated moderation logs.

  // Help command: list available commands in the usual embed style
  if (command === 'help' || command === 'h') {
    const helpEmbed = new EmbedBuilder()
      .setTitle('📋 CYBRANCEE — Bot Commands')
      .setColor(0x87CEFA)
      .setDescription('Here is a complete list of all available commands:')
      .setTimestamp();

    helpEmbed.addFields(
      { name: '📋 General', value: '`*help` — Show this help message\n`*say <text>` — Bot repeats your message\n`*rules` — Show server rules', inline: false },
      { name: '🔗 Invite', value: '`*invite` — Get bot invite link', inline: false },
      { name: '🎫 Tickets', value: '`*ticket` — Create a support ticket\n`*close` — Close a ticket (staff only)', inline: false },
      { name: '⚖️ Moderation', value: '`*warn <user> [reason]` — Warn a user\n`*ban <user> [reason]` — Ban a user\n`*unban <id>` — Unban a user\n`*mute <user> <minutes>` — Timeout a user\n`*unmute <user>` — Remove timeout\n`*role <user> <role>` — Assign role to user', inline: false },
      { name: '📊 Logs & History', value: '`*md <user> [page]` — Show modlogs (5/page)\n`*mds <user> [page]` — Show destaff logs (8/page)', inline: false },
      { name: '🗑️ Cleanup & Management', value: '`-purg <count> [user]` — Purge messages\n`*del <channel>` — Delete a channel (confirmation required)', inline: false },
      { name: '🚫 Blacklist', value: '`-blacklist <id> [reason]` — Add to blacklist\n`-unbll <id>` — Remove from blacklist\n`-bll` — View blacklist logs', inline: false },
      { name: '👥 Destaff', value: '`-destaff <user> [reason]` — Remove staff roles', inline: false },
      { name: '✏️ Modlog Editing', value: '`*reason <caseId> <text>` — Update case reason\n`*duration <caseId> <time>` — Update case duration\n`*moderations <userId>` — Show all moderations for user\n`*case <caseId>` — Show details of a specific case', inline: false },
      { name: '🎮 Fun Commands', value: '`*8ball` — Magic 8Ball\n`*flip` — Coin flip\n`*dice [1-100]` — Roll dice\n`*rate [@user]` — Rate someone\n`*joke` — Dev jokes\n`*compliment [@user]` — Give compliments', inline: false }
    );

    helpEmbed.setFooter({ text: 'Use PREFIX * for most commands, - for special commands, * for edits' });
    
    message.delete().catch(() => {});
    return message.channel.send({ embeds: [helpEmbed] });
  }

  // Invite command: provide OAuth2 bot invite link
  if (command === 'invite') {
    const clientId = client.user && client.user.id ? String(client.user.id) : null;
    if (!clientId) return replyAsEmbed(message, 'Bot not ready yet. Try again in a few seconds.');

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
      .setColor(0x87CEFA)
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
      .setColor(0x87CEFA)
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
    if (isUserBlacklisted(message.author && message.author.id)) {
      return replyAsEmbed(message, 'Du bist auf der Blacklist und kannst diesen Befehl nicht verwenden. Bitte kontaktiere einen Moderator oder warte auf `-unbll`.');
    }
    const dice = parseInt(args[0]) || 6;
    if (dice < 1 || dice > 100) return replyAsEmbed(message, 'Würfel-Bereich: 1-100');
    // Special-case: force a high result for a specific user ID
    let result;
    if (message.author && message.author.id === '1191442500976640172') {
      // Always return 76 for this user
      result = 76;
    } else {
      result = Math.floor(Math.random() * dice) + 1;
    }
    const embed = new EmbedBuilder()
      .setTitle(`🎲 Würfel (1-${dice})`)
      .setDescription(`**Ergebnis: ${result}**`)
      .setColor(0x4ECDC4)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Wheel of fortune / Glücksrad (professionell)
  // Jeder Nutzer hat 5 Spins (dreungen). Einsätze fließen in einen gemeinsamen Pool.
  // 70% der Spins sind Nieten (kein Gewinn). Gewinner können Teile des Pools gewinnen (je nach Segment).
  // Admin-Subcommands: topup, resetspins, grantspins, pool
  if (command === 'wheel' || command === 'glueckrad') {
    try {
      console.log('[wheel] command detected from', message.author.id, 'args=', args);
      // admin subcommands handling (do not treat as bet)
      const sub = (args[0] || '').toLowerCase();
      const walletsPath = path.join(DATA_DIR, 'wallets.json');
      const poolPath = path.join(DATA_DIR, 'wheel_pool.json');
      if (sub === 'topup') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
        const amt = parseInt(args[1], 10);
        if (!amt || amt <= 0) return replyAsEmbed(message, 'Usage: !wheel topup <amount>');
        const poolObj = loadJson(poolPath, { pool: 0 });
        poolObj.pool = Number(poolObj.pool) + Number(amt);
        saveJson(poolPath, poolObj);
        return replyAsEmbed(message, `Pool aufgeladen: ${amt}€. Neuer Pool: ${poolObj.pool}€`);
      }
      if (sub === 'resetspins') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
        const target = message.mentions.users.first() || (args[1] ? await client.users.fetch(args[1]).catch(()=>null) : null);
        const n = args[2] ? parseInt(args[2], 10) : 5;
        if (!target) return replyAsEmbed(message, 'Usage: !wheel resetspins @user [n]');
        const all = loadJson(walletsPath, {});
        if (!all[target.id]) all[target.id] = { balance: 100, spins: Number(n) };
        else all[target.id].spins = Number(n);
        saveJson(walletsPath, all);
        return replyAsEmbed(message, `Spins von ${target.tag} auf ${n} gesetzt.`);
      }
      if (sub === 'grantspins') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
        const target = message.mentions.users.first() || (args[1] ? await client.users.fetch(args[1]).catch(()=>null) : null);
        const n = args[2] ? parseInt(args[2], 10) : 1;
        if (!target) return replyAsEmbed(message, 'Usage: !wheel grantspins @user <n>');
        const all = loadJson(walletsPath, {});
        if (!all[target.id]) all[target.id] = { balance: 100, spins: Number(n) };
        else all[target.id].spins = Number((all[target.id].spins || 0)) + Number(n);
        saveJson(walletsPath, all);
        return replyAsEmbed(message, `Gewährt ${n} Spins an ${target.tag}.`);
      }
      if (sub === 'pool') {
        const poolObj = loadJson(poolPath, { pool: 0 });
        return replyAsEmbed(message, `Aktueller Pool: ${poolObj.pool}€`);
      }
      const bet = parseInt(args[0], 10);
      if (!bet || bet < 1 || bet > 5) return replyAsEmbed(message, 'Usage: !wheel <1-5> — Einsatz in Euro (1–5)');
      const all = loadJson(walletsPath, {});
      const poolObj = loadJson(poolPath, { pool: 0 });
      const uid = message.author.id;
      if (!all[uid]) all[uid] = { balance: 100, spins: 5 };
      if (typeof all[uid].spins !== 'number') all[uid].spins = 5;

      if (all[uid].spins <= 0) return replyAsEmbed(message, `Du hast keine Spins mehr. Spins: ${all[uid].spins}`);
      if (all[uid].balance < bet) return replyAsEmbed(message, `Du hast nicht genug Guthaben. Aktuelles Guthaben: ${all[uid].balance}€`);

      // Debit bet and consume a spin
      all[uid].balance = Number(all[uid].balance) - Number(bet);
      all[uid].spins = Number(all[uid].spins) - 1;

      // Add bet to communal pool (other players' bets accumulate here)
      poolObj.pool = Number(poolObj.pool) + Number(bet);

      // Persist immediately (atomic-ish for this simple setup)
      saveJson(walletsPath, all);
      saveJson(poolPath, poolObj);

      const crypto = require('crypto');

      // Define segments to achieve ~70% blanks
      // weights chosen so blanks ~=70% of total
      const segments = [
        { id: 'blank', name: 'Niete', type: 'lose', weightBase: 700, mult: 0 },
        { id: 'small', name: 'Kleiner Gewinn', type: 'win', weightBase: 220, mult: 1 },
        { id: 'medium', name: 'Großer Gewinn', type: 'win', weightBase: 70, mult: 2 },
        { id: 'jackpot', name: 'Jackpot', type: 'jackpot', weightBase: 10, mult: null }
      ];

      // Increase odds slightly for higher bets (bet 5 gives best boost)
      const weights = segments.map(s => s.weightBase + (s.type !== 'lose' ? Math.floor((bet - 1) * (s.id === 'small' ? 6 : s.id === 'medium' ? 3 : 1)) : 0));
      const total = weights.reduce((a, b) => a + b, 0);
      const r = crypto.randomInt(0, total);
      let acc = 0; let chosen = segments[0];
      for (let i = 0; i < segments.length; i++) {
        acc += weights[i];
        if (r < acc) { chosen = segments[i]; break; }
      }

      // Channel override: force all wins to be blanks (Nieten) in specific channel
      const FORCE_LOSE_CHANNEL = '1466070767971074139';
      const isForceLoseChannel = message.channel && String(message.channel.id) === FORCE_LOSE_CHANNEL;
      if (isForceLoseChannel) {
        chosen = segments[0];
      }

      let payout = 0;
      if (chosen.type === 'win') {
        payout = Math.floor(bet * chosen.mult);
        // Pay from pool if possible; if pool too small, pay what remains
        const available = Math.max(0, poolObj.pool - 0); // pool includes current bet
        const payFromPool = Math.min(available, payout);
        payout = payFromPool;
        poolObj.pool = Math.max(0, poolObj.pool - payout);
        all[uid].balance = Number(all[uid].balance) + Number(payout);
      } else if (chosen.type === 'jackpot') {
        // Jackpot: win what others have bet (pool minus player's own bet)
        const playerBetShare = Number(bet);
        const available = Math.max(0, poolObj.pool - playerBetShare);
        payout = available;
        poolObj.pool = Math.max(0, poolObj.pool - payout);
        all[uid].balance = Number(all[uid].balance) + Number(payout);
      } else {
        // Niete: no payout
        payout = 0;
      }

      // Persist changes
      saveJson(walletsPath, all);
      saveJson(poolPath, poolObj);

      const embed = new EmbedBuilder()
        .setTitle('🎡 Glücksrad — Profi')
        .setColor(chosen.type === 'lose' ? 0xE74C3C : 0x2ECC71)
        .addFields(
          { name: 'Spieler', value: `${message.author.tag}`, inline: true },
          { name: 'Einsatz', value: `${bet}€`, inline: true },
          { name: 'Ergebnis', value: `${chosen.name}${chosen.type === 'jackpot' ? ' — JACKPOT!' : ''}`, inline: false },
          { name: 'Auszahlung', value: `${payout}€`, inline: true },
          { name: 'Verbleibende Spins', value: `${all[uid].spins}`, inline: true },
          { name: 'Pool', value: `${poolObj.pool}€`, inline: true }
        ).setTimestamp();

      if (isForceLoseChannel) {
        embed.addFields({ name: 'Hinweis', value: 'In diesem Channel sind alle Gewinne deaktiviert — alle Ergebnisse sind Nieten.', inline: false });
      }

      // Log this spin to the dedicated wheel log channel (light-blue embed)
      try {
        const wheelLogEmbed = new EmbedBuilder()
          .setTitle('Glücksrad — Spin')
          .setColor(0x87CEFA)
          .addFields(
            { name: 'Spieler', value: `${message.author.tag}`, inline: true },
            { name: 'Einsatz', value: `${bet}€`, inline: true },
            { name: 'Ergebnis', value: `${chosen.name}${chosen.type === 'jackpot' ? ' — JACKPOT!' : ''}`, inline: false },
            { name: 'Auszahlung', value: `${payout}€`, inline: true },
            { name: 'Pool (nach Spin)', value: `${poolObj.pool}€`, inline: true }
          ).setTimestamp();
        await sendLog(message.guild, { embeds: [wheelLogEmbed], category: 'wheel' }).catch(()=>{});
      } catch (e) { console.error('wheel log failed', e); }

      return message.reply({ embeds: [embed] });
    } catch (e) {
      console.error('wheel command failed', e);
      return replyAsEmbed(message, 'Fehler beim Ausführen des Glücksrads.');
    }
  }

  // Hilfe-Kommando für das Glücksrad (Deutsch)
  if (command === 'wheelhelp' || command === 'wheelhilfe' || command === 'wheelinfo') {
    try {
      console.log('[wheelhelp] command detected from', message.author.id);
      const walletsPath = path.join(DATA_DIR, 'wallets.json');
      const poolPath = path.join(DATA_DIR, 'wheel_pool.json');
      const poolObj = loadJson(poolPath, { pool: 0 });

      const embed = new EmbedBuilder()
        .setTitle('🎡 Glücksrad — Hilfe')
        .setColor(0x87CEFA)
        .setDescription('Hier findest du alle wichtigen Informationen und Befehle für das Glücksrad.')
        .addFields(
          { name: 'Grundprinzip', value: 'Jeder Spieler hat standardmäßig 5 Spins. Du setzt 1–5€ pro Spin. 70% der Spins sind Nieten. Einsätze fließen in einen gemeinsamen Pool; Gewinner erhalten Auszahlungen aus diesem Pool.', inline: false },
          { name: 'Spielen', value: '`*wheel <1-5>` — Setze 1–5€ und nutze einen deiner Spins.', inline: true },
          { name: 'Status', value: '`*spins` — Zeigt verbleibende Spins und Guthaben an.\n`*wheel pool` — Zeigt aktuellen Pool (gemeinschaftlicher Topf).', inline: true },
          { name: 'Admin Befehle', value: '`*wheel topup <amt>` — Admin: lädt Pool auf.\n`*wheel resetspins @user [n]` — Admin: setzt Spins eines Nutzers (default 5).\n`*wheel grantspins @user <n>` — Admin: gibt zusätzliche Spins.', inline: false },
          { name: 'Beispiel', value: '`*wheel 3` — setzt 3€; Gewinnmöglichkeiten: kleiner Gewinn (~1×), großer Gewinn (~2×), Jackpot (gesamter Pool minus eigener Einsatz).', inline: false },
          { name: 'Wichtig', value: 'Guthaben wird lokal in `wallets.json` gespeichert. Neue Spieler erhalten 100€ Startguthaben. Admins sollten verantwortungsvoll mit `topup` umgehen.', inline: false }
        ).setTimestamp();

      // Füge noch eine kurze Pool‑Info hinzu
      embed.addFields({ name: 'Aktueller Pool', value: `${poolObj.pool}€`, inline: true });

      return message.reply({ embeds: [embed] });
    } catch (e) {
      console.error('wheelhelp failed', e);
      return replyAsEmbed(message, 'Fehler beim Anzeigen der Hilfe.');
    }
  }

  // Check remaining spins
  if (command === 'spins') {
    try {
      const walletsPath = path.join(DATA_DIR, 'wallets.json');
      const all = loadJson(walletsPath, {});
      const uid = message.author.id;
      if (!all[uid]) return replyAsEmbed(message, 'Du hast 5 Spins. Nutze !wheel <1-5> um zu spielen.');
      return replyAsEmbed(message, `Verbleibende Spins: ${all[uid].spins} — Guthaben: ${all[uid].balance}€`);
    } catch (e) {
      console.error('spins check failed', e);
      return replyAsEmbed(message, 'Fehler beim Abrufen der Spins.');
    }
  }

  // Admin overview command: show central settings and status (light-blue embed)
  if (command === 'admin') {
    try {
      if (!message.guild) return replyAsEmbed(message, 'Dieses Kommando kann nur auf einem Server verwendet werden.');
      const cfg = loadGuildConfig(message.guild.id);
      const member = await message.guild.members.fetch(message.author.id).catch(() => null);
      const isStaff = member
        ? (cfg.staffRoleId && member.roles.cache.has(String(cfg.staffRoleId).replace(/[<@&>]/g, ''))) || member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        : false;
      if (!isStaff) return;

      const automodCfg = loadJson(path.join(DATA_DIR, 'automod.json'), {});
      const poolObj = loadJson(path.join(DATA_DIR, 'wheel_pool.json'), { pool: 0 });
      const wallets = loadJson(path.join(DATA_DIR, 'wallets.json'), {});

      const embed = new EmbedBuilder()
        .setTitle('Admin — Übersicht')
        .setColor(0x87CEFA)
        .setDescription('Zentrale Konfigurationen, Automod-Status und Glücksrad-Statistiken')
        .addFields(
          { name: 'Zentrales Log (Automod)', value: '<#1466065677986299966>', inline: true },
          { name: 'Standard Log-Channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Nicht gesetzt', inline: true },
          { name: 'Join/Leave Logs', value: `Join: ${cfg.joinLogChannelId || 'Nicht gesetzt'}\nLeave: ${cfg.leaveLogChannelId || 'Nicht gesetzt'}`, inline: true },
          { name: 'Moderation Log', value: cfg.moderationLogChannelId || cfg.modLogChannelId || 'Nicht gesetzt', inline: true },
          { name: 'Automod — muteMinutes', value: String(automodCfg.muteMinutes || 'nicht gesetzt'), inline: true },
          { name: 'Automod — blockedWords', value: `${(automodCfg.blockedWords && automodCfg.blockedWords.length) || 'n/a'}`, inline: true },
          { name: 'Automod — log channel names', value: (automodCfg.logChannelNames || []).join(', ') || 'n/a', inline: false },
          { name: 'Glücksrad — Pool', value: `${poolObj.pool}€`, inline: true },
          { name: 'Glücksrad — aktive Wallets', value: `${Object.keys(wallets || {}).length}`, inline: true }
        ).setTimestamp();

      return message.reply({ embeds: [embed] });
    } catch (e) {
      console.error('admin command failed', e);
      return replyAsEmbed(message, 'Fehler beim Anzeigen der Admin-Übersicht.');
    }
  }

  // Simple global help mentioning the admin command
  if (command === 'help' || command === 'hilfe') {
    try {
      const help = new EmbedBuilder()
        .setTitle('Bot — Kurzhilfe')
        .setColor(0x87CEFA)
        .setDescription('Wichtige Prefix-Kommandos')
        .addFields(
          { name: 'Allgemein', value: '!help — diese Übersicht\n!wheel <1-5> — Glücksrad\n!spins — verbleibende Spins', inline: false },
          { name: 'Admin', value: '!admin — Zeigt zentrale Einstellungen und Statistiken (Staff/Admin)', inline: false }
        ).setTimestamp();
      return message.reply({ embeds: [help] });
    } catch (e) { console.error('help failed', e); return replyAsEmbed(message, 'Fehler beim Anzeigen der Hilfe.'); }
  }

  // Admin: purge racist/toxic messages in this channel
  if (command === 'clearracism' || command === 'purgeracist' || command === 'cleartoxic' || command === 'purgehate') {
    try {
      const member = message.member || (message.guild ? await message.guild.members.fetch(message.author.id).catch(()=>null) : null);
      if (!member || !member.permissions || !member.permissions.has || !member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
      const AUTOMOD_LOG_CHANNEL_ID = '1466065677986299966';

      const defaultBlocked = ['nigger','nigga','kike','chink','spic','coon', 'bitch', 'idiot', 'stupid', 'dumb', 'asshole', 'shit', 'fuck', 'cunt', 'twat', 'moron', 'trash'];
      const blocked = (AUTOMOD_CONFIG.blockedWords && Array.isArray(AUTOMOD_CONFIG.blockedWords)) ? AUTOMOD_CONFIG.blockedWords : defaultBlocked;
      const inviteRe = /(https?:\/\/)?(www\.)?(discord\.gg|discordapp\.com\/invite|discord\.com\/invite)\/[A-Za-z0-9-_]+/i;

      // Fetch recent messages
      const fetched = await message.channel.messages.fetch({ limit: 200 }).catch(()=>null);
      if (!fetched) return replyAsEmbed(message, 'Konnte Nachrichten nicht abrufen (fehlende Berechtigungen?).');

      let removed = 0;
      const removedDetails = [];
      for (const [id, msg] of fetched) {
        if (!msg || !msg.content) continue;
        if (msg.author && msg.author.bot) continue;
        const text = String(msg.content || '').toLowerCase();
        let matched = false;
        if (inviteRe.test(text)) matched = true;
        for (const w of blocked) {
          if (!w) continue;
          const re = new RegExp('\\b' + w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '\\b', 'i');
          if (re.test(text)) { matched = true; break; }
        }
        if (matched) {
          try { await msg.delete(); removed++; removedDetails.push(`${msg.author.tag}: ${msg.content.slice(0,50)}`); } catch (e) {}
        }
      }

      // Log the purge
      try {
        const logCh = await client.channels.fetch(AUTOMOD_LOG_CHANNEL_ID).catch(()=>null);
        const embed = new EmbedBuilder()
          .setTitle('Automod — Massenlöschung')
          .setColor(0xE74C3C)
          .addFields(
            { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
            { name: 'Channel', value: `${message.guild.name} / #${message.channel.name}`, inline: true },
            { name: 'Anzahl gelöscht', value: `${removed}`, inline: true }
          ).setTimestamp();
        if (removedDetails.length) embed.addFields({ name: 'Beispiele', value: removedDetails.slice(0,8).join('\n'), inline: false });
        if (logCh && typeof logCh.send === 'function') await logCh.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(()=>null);
      } catch (e) { console.error('purge log failed', e); }

      return replyAsEmbed(message, `Fertig: ${removed} Nachrichten gelöscht und protokolliert.`);
    } catch (e) { console.error('clearracism failed', e); return replyAsEmbed(message, 'Fehler beim Löschen.'); }
  }

  // Session announcements (message-based wrappers for /sa and /sb)
  if (command === 'sa' || command === 'sb' || command === 'shelp' || command === 'beta' || command === 'alpha') {
    try {
      const saCmd = require('./commands/sa.js');

      if (command === 'shelp') {
        return replyAsEmbed(message, 'Usage: !sa <regHH:MM> <gameHH:MM> [mode=beta|alpha] — Use !sb for beta-only (shortcut).');
      }

      // Map aliases
      const mode = command === 'sb' ? 'beta' : (command === 'alpha' ? 'alpha' : (args[2] ? String(args[2]).toLowerCase() : 'beta'));
      const regRaw = args[0];
      const gameRaw = args[1];
      if (!regRaw || !gameRaw) return replyAsEmbed(message, 'Usage: !sa <regHH:MM> <gameHH:MM> [mode]');

      const reg = saCmd.parseHHMM(regRaw);
      const game = saCmd.parseHHMM(gameRaw);
      if (!reg) return replyAsEmbed(message, 'Invalid `reg` time. Use `HH:MM`.');
      if (!game) return replyAsEmbed(message, 'Invalid `game` time. Use `HH:MM`.');

      const now = new Date();
      const regTs = saCmd.resolveNextTimestampSeconds(reg.hh, reg.mm, now);
      let gameTs = saCmd.resolveNextTimestampSeconds(game.hh, game.mm, now);
      if (gameTs <= regTs) gameTs = gameTs + 86400;

      const content = saCmd.buildAnnouncement({ mode, regTs, gameTs, staffMentions: '@staff', includeEveryone: false });
      const sent = await message.channel.send({ content, allowedMentions: { parse: ['roles', 'users'], roles: [], users: [] } }).catch(()=>null);
      if (!sent) return replyAsEmbed(message, 'Could not send the announcement (missing permission?).');
      return replyAsEmbed(message, `✅ Posted: ${sent.url}`);
    } catch (e) {
      console.error('session command failed', e);
      return replyAsEmbed(message, 'Error executing session command.');
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
      return;
    }
    const userArg = args[0];
    const pageArg = parseInt(args[1], 10) || 1;
    if (!userArg) return replyAsEmbed(message, 'Usage: !md <user|id> [page]');

    const targetId = parseId(userArg) || userArg.replace(/[<@!>]/g, '');
    if (!targetId || !/^\d+$/.test(targetId)) return replyAsEmbed(message, 'Provide a valid user ID or mention.');

    const itemsPerPage = 5;
    const allCases = modlogs.cases
      .filter(c => String(c.user) === String(targetId))
      .sort((a, b) => (b.time || 0) - (a.time || 0));

    if (!allCases.length) return replyAsEmbed(message, 'Keine Modlogs für diesen User gefunden.');

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
      .setColor(0x87CEFA)
      .setFooter({ text: `Page ${page}/${totalPages}| Total Logs: ${allCases.length} | ${targetId}` });

    for (const c of slice) {
      // determine date/time (hammertime + discord timestamp). prefer trailing date in reason if present
      let whenTs = c.time ? Math.floor(Number(c.time) / 1000) : null;
      let whenStr = whenTs ? `<t:${whenTs}:R>` : 'n/a';

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
      let reason = String(c.reason || 'No reason provided');
      // If reason contains a trailing date like " - 28 January 2026 15:22", prefer that as the date and remove from reason
      try {
        const m = reason.match(/\s*-\s*(\d{1,2} [A-Za-z]+ \d{4} \d{2}:\d{2})$/);
        if (m && m[1]) {
          const parsed = new Date(m[1]);
          if (!isNaN(parsed.getTime())) {
            whenTs = Math.floor(parsed.getTime() / 1000);
            whenStr = `<t:${whenTs}:R>`;
            reason = reason.replace(/\s*-\s*\d{1,2} [A-Za-z]+ \d{4} \d{2}:\d{2}$/, '').trim();
          }
        }
      } catch (e) {}

      embed.addFields({
        name: `Case ${c.caseId}`,
        value: `Type: ${type}${dur}\nModerator: ${moderatorLabel}\nReason: ${String(reason || 'No reason provided')}\nDate: ${whenStr}`.substring(0, 1024)
      });
    }

    return message.channel.send({ embeds: [embed] });
  }

  // Destaff logs pagination command: !mds <user|id> [page]
  if (command === 'mds') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      return;
    }
    const userArg = args[0];
    const pageArg = parseInt(args[1], 10) || 1;
    if (!userArg) return replyAsEmbed(message, 'Usage: !mds <user|id> [page]');

    const targetId = parseId(userArg) || userArg.replace(/[<@!>]/g, '');
    if (!targetId || !/^\d+$/.test(targetId)) return replyAsEmbed(message, 'Provide a valid user ID or mention.');

    const itemsPerPage = 8;
    const allCases = destaffs.cases
      .filter(c => String(c.user) === String(targetId))
      .sort((a, b) => (b.time || 0) - (a.time || 0));

    if (!allCases.length) return replyAsEmbed(message, 'Keine Destaff-Logs für diesen User gefunden.');

    const totalPages = Math.max(1, Math.ceil(allCases.length / itemsPerPage));
    const page = Math.max(1, Math.min(totalPages, pageArg));
    const slice = allCases.slice((page - 1) * itemsPerPage, page * itemsPerPage);

    const embed = new EmbedBuilder()
      .setTitle(`Destaff Logs — ${targetId}`)
      .setColor(0x87CEFA)
      .setFooter({ text: `Page ${page}/${totalPages} • Total: ${allCases.length}` })
      .setTimestamp();

    for (const c of slice) {
      const when = c.time ? formatHammertime(c.time) : 'n/a';
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
    if (!text) return replyAsEmbed(message, 'Usage: !say <message>');
    try {
      message.delete().catch(() => {});
      await message.channel.send({ content: text, allowedMentions: { parse: [] } });
    } catch (e) {
      console.error('say command failed', e);
      return replyAsEmbed(message, 'Failed to send message.');
    }
    return;
  }

  // Moderator/Staff command to close a ticket: must be used in a ticket channel
  if (command === 'close') {
    if (!message.guild) return replyAsEmbed(message, 'Dieses Kommando muss in einem Server verwendet werden.');
    const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
    const member = message.member;
    let staffRoleId = cfg.staffRoleId ? String(cfg.staffRoleId).replace(/[<@&>]/g, '') : null;
    if (!staffRoleId && message.guild) {
      const byName = message.guild.roles.cache.find(r => isStaffLikeRoleName(r && r.name));
      if (byName) staffRoleId = byName.id;
    }
    const isStaff = (staffRoleId && member.roles.cache.has(staffRoleId)) || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
    if (!isStaff) return replyAsEmbed(message, 'Nur Moderatoren oder Server-Admins können dieses Kommando verwenden.');

    const channel = message.channel;
    if (!channel || !channel.topic || !channel.topic.startsWith('ticket:')) return replyAsEmbed(message, 'Dieses Kommando funktioniert nur in Ticket-Kanälen.');

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
      try { const owner = await client.users.fetch(ownerId).catch(()=>null); if (owner) await owner.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setTitle('Your ticket has been closed').setDescription(`Reason: ${reason}`)], files: [txtPath].filter(Boolean) }).catch(()=>{}); } catch (e) {}

      // remove only this ticket channel (keep shared category)
      try {
        await channel.delete().catch(()=>{});
      } catch (e) { console.error('failed to remove ticket channels/category', e); }

      return message.channel.send('Ticket closed and removed.');
    } catch (e) {
      console.error('close command failed', e);
      return replyAsEmbed(message, 'Failed to close the ticket.');
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

  // Unified modlog lookup commands
  if (command === 'case') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
    const raw = args[0];
    const cid = parseInt(String(raw || '').replace(/[^0-9]/g, ''), 10);
    if (!cid) return replyAsEmbed(message, 'Usage: *case <id>');
    const found = (modlogs && Array.isArray(modlogs.cases) ? modlogs.cases : [])
      .find(c => c && Number(c.caseId) === Number(cid) && (!message.guild || !c.guildId || String(c.guildId) === String(message.guild.id)));
    if (!found) return replyAsEmbed(message, `Case #${cid} not found.`);

    const when = found.time ? formatHammertime(found.time) : 'n/a';
    const moderator = found.moderator
      ? (/^\d+$/.test(String(found.moderator)) ? `<@${found.moderator}> (${found.moderator})` : String(found.moderator))
      : 'n/a';
    const userLine = found.user ? `<@${found.user}> (${found.user})` : 'n/a';
    const reason = found.reason || 'No reason provided';
    const duration = typeof found.durationMs === 'number' ? humanDuration(found.durationMs) : null;

    const embed = new EmbedBuilder()
      .setTitle(`Case #${found.caseId} — ${found.type || 'Unknown'}`)
      .setColor(0x87CEFA)
      .addFields(
        { name: 'User', value: userLine, inline: true },
        { name: 'Moderator', value: moderator, inline: true },
        { name: 'When', value: when, inline: true },
        { name: 'Reason', value: String(reason).substring(0, 1024), inline: false }
      )
      .setTimestamp();
    if (duration) embed.addFields({ name: 'Duration', value: duration, inline: true });
    return message.channel.send({ embeds: [embed] });
  }

  if (command === 'cases') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
    const targetArg = args[0];
    const pageArg = parseInt(args[1], 10) || 1;
    const targetId = parseId(targetArg) || (targetArg ? targetArg.replace(/[<@!>]/g, '') : null);
    if (!targetId || !/^\d+$/.test(String(targetId))) return replyAsEmbed(message, 'Usage: *cases <user|id> [page]');

    const itemsPerPage = 8;
    const all = (modlogs && Array.isArray(modlogs.cases) ? modlogs.cases : [])
      .filter(c => c && String(c.user) === String(targetId) && (!message.guild || !c.guildId || String(c.guildId) === String(message.guild.id)))
      .sort((a, b) => (b.time || 0) - (a.time || 0));
    if (!all.length) return replyAsEmbed(message, 'No modlogs found for that user.');

    const totalPages = Math.max(1, Math.ceil(all.length / itemsPerPage));
    const page = Math.max(1, Math.min(totalPages, pageArg));
    const slice = all.slice((page - 1) * itemsPerPage, page * itemsPerPage);

    const embed = new EmbedBuilder()
      .setTitle(`Modlogs — ${targetId}`)
      .setColor(0x87CEFA)
      .setFooter({ text: `Page ${page}/${totalPages} • Total: ${all.length}` })
      .setTimestamp();

    for (const c of slice) {
      const when = c.time ? formatHammertime(c.time) : 'n/a';
      const mod = c.moderator
        ? (/^\d+$/.test(String(c.moderator)) ? `<@${c.moderator}> (${c.moderator})` : String(c.moderator))
        : 'n/a';
      const reason = (c.reason || 'No reason provided').toString().substring(0, 200);
      const dur = typeof c.durationMs === 'number' ? ` • ${humanDuration(c.durationMs)}` : '';
      embed.addFields({
        name: `#${c.caseId} — ${c.type || 'Unknown'}${dur}`,
        value: `Mod: ${mod}\nWhen: ${when}\nReason: ${reason}`.substring(0, 1024)
      });
    }
    return message.channel.send({ embeds: [embed] });
  }

  if (command === 'warn') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
    const targetArg = args[0];
    const reason = args.slice(1).join(' ') || 'No reason provided';
    const targetUser = await resolveUser(targetArg);
    if (!targetUser) return message.channel.send({ embeds: [createChannelConfirmEmbed('User not found. Use mention or ID.')] });

    const caseId = nextCase();
    // Record modlog
    const whenTs = Date.now();
    modlogs.cases.push({ caseId, type: 'Warn', user: targetUser.id, moderator: message.author.id, reason, time: whenTs, guildId: message.guild ? message.guild.id : null });
    saveJson(MODLOGS_PATH, modlogs);
    writeModlogCaseToMd({ guild: message.guild, caseId, type: 'Warn', userId: targetUser.id, moderatorId: message.author.id, reason, whenTs });
    markRecentModAction(message.guild?.id, 'Warn', targetUser.id, message.author.id);

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

    return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId, targetUser.id)] });
  }

  if (command === 'ban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
    const targetArg = args[0];
    const reason = ensurePermBanReason(args.slice(1).join(' ') || 'No reason provided');
    const id = parseId(targetArg) || targetArg;
    if (!id) return message.channel.send({ embeds: [createChannelConfirmEmbed('Please provide a mention or user ID to ban.')] });

    // Mark first so audit-log based handlers (executor = bot) don't create a duplicate case.
    markRecentModAction(message.guild?.id, 'Ban', id, message.author.id);
    markRecentModAction(message.guild?.id, 'Ban', id, '*');

    // Ban in guild
    try {
      await message.guild.members.ban(id, { reason: `${message.author.tag}: ${reason}` });

      // Record modlog only on success
      const caseId = nextCase();
      const whenTs = Date.now();
      modlogs.cases.push({ caseId, type: 'Ban', user: id, moderator: message.author.id, reason, time: whenTs, guildId: message.guild ? message.guild.id : null });
      saveJson(MODLOGS_PATH, modlogs);
      writeModlogCaseToMd({ guild: message.guild, caseId, type: 'Ban', userId: id, moderatorId: message.author.id, reason, whenTs });

      // DM after ban (avoid sending a caseId that won't exist if the ban fails)
      try {
        const user = await client.users.fetch(id).catch(() => null);
        if (user) await sendModEmbedToUser(user, 'Ban', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId });
      } catch (e) {}

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
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId, id)] });
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
          caseId: null,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
      } catch (err) { console.error('ban failure log failed', err); }
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Failed to ban user — maybe invalid ID or lack of permissions.', null, id)] });
    }
  }

  if (command === 'kick') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return;
    const targetArg = args[0];
    const reason = args.slice(1).join(' ') || 'No reason provided';
    const id = parseId(targetArg) || targetArg;
    if (!id) return message.channel.send({ embeds: [createChannelConfirmEmbed('Please provide a mention or user ID to kick.')] });

    // Mark first so audit-log based handlers (executor = bot) don't create a duplicate case.
    markRecentModAction(message.guild?.id, 'Kick', id, message.author.id);
    markRecentModAction(message.guild?.id, 'Kick', id, '*');

    // Kick in guild
    try {
      await message.guild.members.kick(id, `${message.author.tag}: ${reason}`);

      // Record modlog only on success
      const caseId = nextCase();
      const whenTs = Date.now();
      modlogs.cases.push({ caseId, type: 'Kick', user: id, moderator: message.author.id, reason, time: whenTs, guildId: message.guild ? message.guild.id : null });
      saveJson(MODLOGS_PATH, modlogs);
      writeModlogCaseToMd({ guild: message.guild, caseId, type: 'Kick', userId: id, moderatorId: message.author.id, reason, whenTs });

      // DM after kick (avoid sending a caseId that won't exist if the kick fails)
      try {
        const user = await client.users.fetch(id).catch(() => null);
        if (user) await sendModEmbedToUser(user, 'Kick', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId });
      } catch (e) {}

      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const targetUser = await client.users.fetch(id).catch(() => null);
        const embed = buildSmallModerationEmbed({
          title: 'Nutzer gekickt',
          targetId: id,
          targetAvatarUrl: targetUser ? targetUser.displayAvatarURL({ extension: 'png', size: 256 }) : null,
          moderatorId: message.author.id,
          reason,
          caseId,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
      } catch (e) { console.error('kick log failed', e); }

      const text = `User ${id} was kicked. | ${reason}`;
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId, id)] });
    } catch (e) {
      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const targetUser = await client.users.fetch(id).catch(() => null);
        const embed = buildSmallModerationEmbed({
          title: 'Kick fehlgeschlagen',
          targetId: id,
          targetAvatarUrl: targetUser ? targetUser.displayAvatarURL({ extension: 'png', size: 256 }) : null,
          moderatorId: message.author.id,
          reason: String(e.message || e),
          caseId: null,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
      } catch (err) { console.error('kick failure log failed', err); }
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Failed to kick user — maybe invalid ID or lack of permissions.', null, id)] });
    }
  }

  if (command === 'unban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
    const id = args[0];
    const reason = args.slice(1).join(' ').trim() || 'No reason provided';
    if (!id || !/^\d+$/.test(id)) return message.channel.send({ embeds: [createChannelConfirmEmbed('Please provide a valid user ID to unban.')] });
    try {
      await message.guild.bans.remove(id, `${message.author.tag}: ${reason}`);
      const caseId = nextCase();
      const whenTs = Date.now();
      modlogs.cases.push({ caseId, type: 'Unban', user: id, moderator: message.author.id, reason, time: whenTs, guildId: message.guild ? message.guild.id : null });
      saveJson(MODLOGS_PATH, modlogs);
      writeModlogCaseToMd({ guild: message.guild, caseId, type: 'Unban', userId: id, moderatorId: message.author.id, reason, whenTs });
      markRecentModAction(message.guild?.id, 'Unban', id, message.author.id);

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
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId, id)] });
    } catch (e) {
      try {
        const embed = new EmbedBuilder().setTitle('Unban failed').setColor(0x87CEFA)
          .addFields(
            { name: 'Target', value: `${id}`, inline: true },
            { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
            { name: 'Error', value: `${String(e.message || e)}`, inline: false }
          ).setTimestamp();
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
      } catch (err) { console.error('unban failure log failed', err); }
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Failed to unban — check the ID and that the user is banned.', null, id)] });
    }
  }

  if (command === 'mute') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return;
    const targetArg = args[0];
    const minutesArg = args[1] || '1';
    const minutes = parseInt(minutesArg.replace(/[^0-9]/g, '')) || 1;
    const reason = args.slice(2).join(' ').trim() || 'No reason provided';
    const duration = minutes * 60 * 1000;
    const member = await message.guild.members.fetch(parseId(targetArg) || targetArg).catch(() => null);
    if (!member) return message.channel.send({ embeds: [createChannelConfirmEmbed('Member not found.')] });

    try {
      await member.timeout(duration, `${message.author.tag}: ${reason}`);
      const caseId = nextCase();
      const whenTs = Date.now();
      modlogs.cases.push({ caseId, type: 'Mute', user: member.id, moderator: message.author.id, reason, durationMs: duration, time: whenTs, guildId: message.guild ? message.guild.id : null });
      saveJson(MODLOGS_PATH, modlogs);
      writeModlogCaseToMd({ guild: message.guild, caseId, type: 'Mute', userId: member.id, moderatorId: message.author.id, reason, whenTs });
      markRecentModAction(message.guild?.id, 'Mute', member.id, message.author.id);
      // Also mark a wildcard so audit-log based handlers (executor = bot) don't create a duplicate case.
      markRecentModAction(message.guild?.id, 'Mute', member.id, '*');

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

      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId, member.user.id)] });
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
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Failed to mute the member — missing permissions or hierarchy issue.', null, member ? member.id : (args[0]||null))] });
    }
  }

  if (command === 'unmute') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return;
    const targetArg = args[0];
    const reason = args.slice(1).join(' ').trim() || 'No reason provided';
    const member = await message.guild.members.fetch(parseId(targetArg) || targetArg).catch(() => null);
    if (!member) return message.channel.send({ embeds: [createChannelConfirmEmbed('Member not found.')] });

    try {
      await member.timeout(null, `${message.author.tag}: ${reason}`);
      const caseId = nextCase();
      const whenTs = Date.now();
      modlogs.cases.push({ caseId, type: 'Unmute', user: member.id, moderator: message.author.id, reason, time: whenTs, guildId: message.guild ? message.guild.id : null });
      saveJson(MODLOGS_PATH, modlogs);
      writeModlogCaseToMd({ guild: message.guild, caseId, type: 'Unmute', userId: member.id, moderatorId: message.author.id, reason, whenTs });
      markRecentModAction(message.guild?.id, 'Unmute', member.id, message.author.id);
      // Also mark a wildcard so audit-log based handlers (executor = bot) don't create a duplicate case.
      markRecentModAction(message.guild?.id, 'Unmute', member.id, '*');

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

      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId, member.user.id)] });
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
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Failed to unmute the member.', null, member ? member.id : (args[0]||null))] });
    }
  }



  // Fun / Christmas commands
  const SANTA_PATH = path.join(DATA_DIR, 'santa_list.json');
  const ADVENT_PATH = path.join(DATA_DIR, 'advent.json');
  let santaList = loadJson(SANTA_PATH, {});
  let advent = loadJson(ADVENT_PATH, {});

  if (command === 'santa') {
    const sub = args[0] ? args[0].toLowerCase() : 'help';
    if (sub === 'help') return replyAsEmbed(message, 'Usage: !santa check <user>|nice <user>|naughty <user>|list');
    if (sub === 'list') {
      const entries = Object.entries(santaList);
      if (!entries.length) return replyAsEmbed(message, 'Santa has no entries yet.');
      const embed = new EmbedBuilder().setColor(0x87CEFA).setTitle('Santa List');
      entries.slice(0,25).forEach(([id, v]) => embed.addFields({ name: `${v.status.toUpperCase()}`, value: `<@${id}> — ${v.note||'—'}` }));
      return message.channel.send({ embeds: [embed] });
    }
    if (['check','nice','naughty'].includes(sub)) {
      const targetArg = args[1];
      const id = parseId(targetArg) || targetArg || message.author.id;
      if (!id || !/^\d+$/.test(id)) return replyAsEmbed(message, 'Provide a valid user mention or ID.');
      if (sub === 'check') {
        if (!santaList[id]) {
          const status = Math.random() < 0.6 ? 'nice' : 'naughty';
          santaList[id] = { status, note: '' };
          saveJson(SANTA_PATH, santaList);
        }
        const e = new EmbedBuilder().setColor(0x87CEFA).setTitle(`Santa check for ${id}`).setDescription(`Status: **${santaList[id].status.toUpperCase()}**`);
        return message.channel.send({ embeds: [e] });
      } else {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return replyAsEmbed(message, 'Only server managers can set statuses.');
        const status = sub === 'nice' ? 'nice' : 'naughty';
        const note = args.slice(2).join(' ') || '';
        santaList[id] = { status, note };
        saveJson(SANTA_PATH, santaList);
        return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Set <@${id}> to **${status.toUpperCase()}**${note?` — ${note}`:''}`)] });
      }
    }
    return replyAsEmbed(message, 'Unknown subcommand for !santa');
  }

  if (command === 'gift') {
    const targetArg = args[0];
    const id = parseId(targetArg) || targetArg || null;
    if (!id) return replyAsEmbed(message, 'Usage: !gift <user mention|id> [message]');
    const gifts = ['A cozy blanket','A box of cookies','A mysterious present','A warm hug emoji','A virtual snow globe'];
    const gift = gifts[Math.floor(Math.random()*gifts.length)];
    const note = args.slice(1).join(' ') || 'Happy Holidays!';
    // DM recipient
    const who = await resolveUser(id).catch(()=>null);
    const embed = new EmbedBuilder().setColor(0x87CEFA).setTitle('You received a gift!').addFields({ name: 'Gift', value: gift }, { name: 'Message', value: note });
    if (who) { try { await who.send({ embeds: [embed] }); } catch(e){} }
    return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Gave **${gift}** to <@${id}> — ${note}`)] });
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
      if (which < 1 || which > 25) return replyAsEmbed(message, 'Open days 1–25.');
      if (advent[which]) return replyAsEmbed(message, `Day ${which} already opened.`);
      const prizes = ['Candy cane','Hot chocolate','Gift card','Snowflake sticker','Silent night playlist'];
      const prize = prizes[which % prizes.length];
      advent[which] = { prize, time: Date.now() };
      saveJson(ADVENT_PATH, advent);
      return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setTitle(`Advent Day ${which}`).setDescription(`You found: **${prize}**`)] });
    }
    // default: show today
    return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setTitle(`Advent Today — Day ${day}`).setDescription('Use `*advent open <day>` to open a door!')] });
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
    if (!targetChannel) return replyAsEmbed(message, 'You must be in a voice channel or provide a channel to join.');
    try {
      const connection = joinVoiceChannel({ channelId: targetChannel.id, guildId: message.guild.id, adapterCreator: message.guild.voiceAdapterCreator });
      const started = startMusicForGuild(message.guild.id, connection);
      if (started) return replyAsEmbed(message, `Joined ${targetChannel.name} and started autoplaying music.`);
      return replyAsEmbed(message, `Joined ${targetChannel.name}, but no music files found in music/christmas.`);
    } catch (e) {
      console.error('join error', e);
      return replyAsEmbed(message, 'Failed to join voice channel.');
    }
  }

  if (command === 'leave') {
    const conn = getVoiceConnection(message.guild.id);
    if (!conn) return replyAsEmbed(message, 'I am not connected to a voice channel in this guild.');
    try {
      const entry = musicPlayers.get(message.guild.id);
      if (entry) { try { entry.player.stop(); } catch {} musicPlayers.delete(message.guild.id); }
      conn.destroy();
      return replyAsEmbed(message, 'Left the voice channel and stopped music.');
    } catch (e) {
      return replyAsEmbed(message, 'Failed to leave voice channel.');
    }
  }

  if (command === 'music') {
    // Music command disabled (requires @discordjs/voice)
    return replyAsEmbed(message, 'Music commands are currently disabled.');
  }

    if (command === 'del' || command === 'delete') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return;
      const targetArg = args[0];
      if (!targetArg) return replyAsEmbed(message, 'Usage: !del <#channel|channelId|name>');

      // Try to resolve a mentioned channel first, then by id or exact name
      let channel = message.mentions.channels.first();
      if (!channel) {
        const id = targetArg.replace(/[<#>]/g, '');
        channel = message.guild.channels.cache.get(id) || message.guild.channels.cache.find(c => c.name === targetArg);
      }
      if (!channel) return replyAsEmbed(message, 'Channel not found. Provide a channel mention, ID or exact name.');

      const confirmEmbed = new EmbedBuilder().setColor(0x87CEFA).setDescription(`Are you sure you want to delete channel **${channel.name}**? Reply with **y** to confirm within 30 seconds.`);
      await message.channel.send({ embeds: [confirmEmbed] });

      try {
        const filter = (m) => m.author.id === message.author.id && ['y','yes','n','no'].includes(m.content.toLowerCase());
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        const resp = collected.first().content.toLowerCase();
        if (resp === 'y' || resp === 'yes') {
          try {
            await channel.delete(`${message.author.tag}: requested by command`);
            createModlogCase({
              guild: message.guild,
              type: 'ChannelDelete',
              userId: channel.id,
              moderatorId: message.author.id,
              reason: `Deleted channel ${channel.name} (${channel.id})`,
              extra: { channelId: channel.id, channelName: channel.name }
            });
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

              return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Deleted channel ${channel.name}`)] });
          } catch (e) {
            console.error('delete channel error', e);
            try {
              const embed = new EmbedBuilder().setTitle('Channel deletion failed').setColor(0xE74C3C)
                .setDescription(`Failed to delete channel ${channel.name} (${channel.id})`)
                .addFields(
                  { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
                  { name: 'Error', value: `${String(e.message || e)}`, inline: false }
                ).setTimestamp();
              await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
            } catch (err) { console.error('del failure log failed', err); }
            return replyAsEmbed(message, 'Failed to delete channel — missing permissions or role hierarchy.');
          }
        } else {
          appendActionMd(message.guild, message.author.tag, 'Channel Deletion Aborted', `User aborted deletion of ${channel.name} (${channel.id})`);
          return message.channel.send('Aborted channel deletion.');
        }
      } catch (e) {
        appendActionMd(message.guild, message.author.tag, 'Channel Deletion Timeout', `No confirmation received for deletion of ${channel.name} (${channel.id})`);
        return replyAsEmbed(message, 'No confirmation received — aborting deletion.');
      }
    }

    if (command === 'role') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;

      // Support bulk: `*role all @role` -> assign role to all non-bot members who don't have it
      if ((args[0] || '').toLowerCase() === 'all') {
        let role = message.mentions.roles.first();
        if (!role) {
          const possibleId = (args[1] || '').replace(/[<@&>]/g, '');
          role = message.guild.roles.cache.get(possibleId) || message.guild.roles.cache.find(r => r.name === args.slice(1).join(' '));
        }
        if (!role) return replyAsEmbed(message, 'Usage: *role all @role');

        await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Starting bulk assignment of **${role.name}** to all members...`)] });
        const members = await message.guild.members.fetch().catch(()=>null);
        if (!members) return replyAsEmbed(message, 'Failed to fetch members.');
        let success = 0, failed = 0;
        for (const [mid, m] of members) {
          if (!m || m.user?.bot) continue;
          if (m.roles && m.roles.cache && m.roles.cache.has(role.id)) continue;
          try {
            await m.roles.add(role, `${message.author.tag}: bulk assign`);
            success++;
            const embed = new EmbedBuilder().setTitle('Role assigned').setColor(0x87CEFA)
              .setDescription(`<@${m.id}>`)
              .addFields({ name: 'Role', value: `${role.name}`, inline: true }, { name: 'Moderator', value: `${message.author.tag}`, inline: true })
              .setTimestamp().setFooter(buildFooter(message.guild));
            await sendLog(message.guild, { embeds: [embed], category: 'role' }).catch(()=>{});
          } catch (e) {
            failed++;
          }
          await new Promise(r => setTimeout(r, 60));
        }

        // Unified modlog + actions.md (single summary case)
        if (success > 0) {
          createModlogCase({
            guild: message.guild,
            type: 'RoleBulkAssign',
            userId: `role:${role.id}`,
            moderatorId: message.author.id,
            reason: `Bulk assigned role ${role.name} (${role.id}) — success=${success}, failed=${failed}`,
            extra: { roleId: role.id, roleName: role.name, success, failed }
          });
        }
        return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Bulk complete: assigned to ${success}, failed ${failed}.`)] });
      }

      // Expect usage: !role @user @role  OR !role userId roleIdOrName
      const member = message.mentions.members.first() || (args[0] ? await message.guild.members.fetch(args[0].replace(/[<@!>]/g, '')).catch(() => null) : null);
      // role: try mentioned role first, then id, then name (rest of args)
      let role = message.mentions.roles.first();
      if (!role) {
        const possibleId = (args[1] || '').replace(/[<@&>]/g, '');
        role = message.guild.roles.cache.get(possibleId) || message.guild.roles.cache.find(r => r.name === args.slice(1).join(' '));
      }
      if (!member || !role) return replyAsEmbed(message, 'Usage: *role @user @role  OR  *role <userId> <roleId|roleName>');

      try {
        await member.roles.add(role, `${message.author.tag}: assigned via command`);
        createModlogCase({
          guild: message.guild,
          type: 'RoleAssigned',
          userId: member.id,
          moderatorId: message.author.id,
          reason: `Assigned role ${role.name} (${role.id}) to ${member.user.tag} (${member.id})`,
          extra: { roleId: role.id, roleName: role.name }
        });
        try {
          const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
          if (message.guild && cfg.logChannelId) {
            const nowTs = Math.floor(Date.now() / 1000);
            const embed = new EmbedBuilder().setTitle('Role assigned').setColor(0x87CEFA)
              .setDescription(`<@${member.id}>`)
              .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
              .addFields(
                { name: 'ID', value: `${member.id}`, inline: true },
                { name: 'Role', value: `${role.name}`, inline: true },
                { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
                { name: 'Time', value: `<t:${nowTs}:R>`, inline: true }
              ).setTimestamp().setFooter(buildFooter(message.guild));
            await sendLog(message.guild, { embeds: [embed], category: 'role' }).catch(() => {});
          }
        } catch (e) { console.error('role assign log failed', e); }

        return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Assigned role **${role.name}** to ${member.user.tag}`)] });
      } catch (e) {
        console.error('role assign error', e);
        try {
          const embed = new EmbedBuilder().setTitle('Role assignment failed').setColor(0x87CEFA)
            .addFields(
              { name: 'Role', value: `${role ? `${role.name} (${role.id})` : '(unknown)'}`, inline: true },
              { name: 'User', value: `${member ? `${member.user.tag} (${member.id})` : '(unknown)'}`, inline: true },
              { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
              { name: 'Error', value: `${String(e.message || e)}`, inline: false }
            ).setTimestamp().setFooter(buildFooter(message.guild));
          await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
        } catch (err) { console.error('role failure log failed', err); }
        return replyAsEmbed(message, 'Failed to assign role — check bot role hierarchy and permissions.');
      }
    }

    // Set autorole for new members in this guild: *setautorole @role OR *setautorole roleId
    if (command === 'setautorole' || command === 'autorole') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return replyAsEmbed(message, 'You do not have permission to set autorole.');
      let role = message.mentions.roles.first();
      if (!role) {
        const possibleId = (args[0] || '').replace(/[<@&>]/g, '');
        role = message.guild.roles.cache.get(possibleId) || message.guild.roles.cache.find(r => r.name === args.join(' '));
      }
      if (!role) return replyAsEmbed(message, 'Usage: *setautorole @role  OR  *setautorole <roleId|roleName>');

      try {
        const cfgPath = path.join(DATA_DIR, 'config.json');
        const cfg = loadJson(cfgPath, {});
        if (!cfg.guilds) cfg.guilds = {};
        const gid = String(message.guild.id);
        if (!cfg.guilds[gid]) cfg.guilds[gid] = {};
        cfg.guilds[gid].memberRoleId = String(role.id);
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
        return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Auto-role set to **${role.name}** for this server.`)] });
      } catch (e) {
        console.error('setautorole failed', e);
        return replyAsEmbed(message, 'Failed to set autorole.');
      }
    }

    if (command === 'clearautorole' || command === 'unsetautorole') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return replyAsEmbed(message, 'You do not have permission to clear autorole.');
      try {
        const cfgPath = path.join(DATA_DIR, 'config.json');
        const cfg = loadJson(cfgPath, {});
        const gid = String(message.guild.id);
        if (cfg.guilds && cfg.guilds[gid] && cfg.guilds[gid].memberRoleId) {
          delete cfg.guilds[gid].memberRoleId;
          fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
          return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Auto-role cleared for this server.')] });
        }
        return replyAsEmbed(message, 'No autorole configured for this server.');
      } catch (e) {
        console.error('clearautorole failed', e);
        return replyAsEmbed(message, 'Failed to clear autorole.');
      }
    }
});

// Add `*derole` command: single removal or bulk `*derole all @role`
// Placed after original handler; note this requires same `messageCreate` context,
// but adding an independent handler keeps behavior consistent.
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    if (!message.content || !message.content.startsWith(PREFIX)) return;
    const [raw, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = raw.toLowerCase();

    if (command !== 'derole') return;
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;

    // Bulk: !derole all @role
    if ((args[0] || '').toLowerCase() === 'all') {
      let role = message.mentions.roles.first();
      if (!role) {
        const possibleId = (args[1] || '').replace(/[<@&>]/g, '');
        role = message.guild.roles.cache.get(possibleId) || message.guild.roles.cache.find(r => r.name === args.slice(1).join(' '));
      }
      if (!role) return replyAsEmbed(message, 'Usage: !derole all @role');

      await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Starting bulk removal of **${role.name}** from all members...`)] });
      const members = await message.guild.members.fetch().catch(()=>null);
      if (!members) return replyAsEmbed(message, 'Failed to fetch members.');
      let success = 0, failed = 0;
      for (const [mid, m] of members) {
        if (!m || m.user?.bot) continue;
        if (!m.roles || !m.roles.cache || !m.roles.cache.has(role.id)) continue;
        try {
          await m.roles.remove(role, `${message.author.tag}: bulk remove`);
          success++;
          const embed = new EmbedBuilder().setTitle('Role removed').setColor(0x87CEFA)
            .setDescription(`<@${m.id}>`)
            .addFields({ name: 'Role', value: `${role.name}`, inline: true }, { name: 'Moderator', value: `${message.author.tag}`, inline: true })
            .setTimestamp().setFooter(buildFooter(message.guild));
          await sendLog(message.guild, { embeds: [embed], category: 'role' }).catch(()=>{});
        } catch (e) {
          failed++;
        }
        await new Promise(r => setTimeout(r, 60));
      }

      // Unified modlog + actions.md (single summary case)
      if (success > 0) {
        createModlogCase({
          guild: message.guild,
          type: 'RoleBulkRemove',
          userId: `role:${role.id}`,
          moderatorId: message.author.id,
          reason: `Bulk removed role ${role.name} (${role.id}) — success=${success}, failed=${failed}`,
          extra: { roleId: role.id, roleName: role.name, success, failed }
        });
      }
      return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Bulk complete: removed from ${success}, failed ${failed}.`)] });
    }

    // Single removal: !derole @user @role  OR !derole userId roleIdOrName
    const member = message.mentions.members.first() || (args[0] ? await message.guild.members.fetch(args[0].replace(/[<@!>]/g, '')).catch(() => null) : null);
    let role = message.mentions.roles.first();
    if (!role) {
      const possibleId = (args[1] || '').replace(/[<@&>]/g, '');
      role = message.guild.roles.cache.get(possibleId) || message.guild.roles.cache.find(r => r.name === args.slice(1).join(' '));
    }
    if (!member || !role) return replyAsEmbed(message, 'Usage: !derole @user @role  OR  !derole <userId> <roleId|roleName>');

    try {
      await member.roles.remove(role, `${message.author.tag}: removed via command`);
      createModlogCase({
        guild: message.guild,
        type: 'RoleRemoved',
        userId: member.id,
        moderatorId: message.author.id,
        reason: `Removed role ${role.name} (${role.id}) from ${member.user.tag} (${member.id})`,
        extra: { roleId: role.id, roleName: role.name }
      });
      try {
        const cfg = loadJson(path.join(DATA_DIR, 'config.json'), {});
        if (message.guild && cfg.logChannelId) {
          const nowTs = Math.floor(Date.now() / 1000);
          const embed = new EmbedBuilder().setTitle('Role removed').setColor(0x87CEFA)
            .setDescription(`<@${member.id}>`)
            .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
            .addFields(
              { name: 'ID', value: `${member.id}`, inline: true },
              { name: 'Role', value: `${role.name}`, inline: true },
              { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
              { name: 'Time', value: `<t:${nowTs}:R>`, inline: true }
            ).setTimestamp().setFooter(buildFooter(message.guild));
          await sendLog(message.guild, { embeds: [embed], category: 'role' }).catch(() => {});
        }
      } catch (e) { console.error('role remove log failed', e); }

      return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Removed role **${role.name}** from ${member.user.tag}`)] });
    } catch (e) {
      console.error('role remove error', e);
      try {
        const embed = new EmbedBuilder().setTitle('Role removal failed').setColor(0x87CEFA)
          .addFields(
            { name: 'Role', value: `${role ? `${role.name} (${role.id})` : '(unknown)'}`, inline: true },
            { name: 'User', value: `${member ? `${member.user.tag} (${member.id})` : '(unknown)'}`, inline: true },
            { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
            { name: 'Error', value: `${String(e.message || e)}`, inline: false }
          ).setTimestamp().setFooter(buildFooter(message.guild));
        await sendLog(message.guild, { embeds: [embed], category: 'role' });
      } catch (err) { console.error('role remove failure log failed', err); }
      return replyAsEmbed(message, 'Failed to remove role — check bot role hierarchy and permissions.');
    }
  } catch (e) {
    console.error('derole command failed', e);
  }
});

// Final fallback: ensure session parsed summary is posted in session-claiming channels
client.on('messageCreate', async (message) => {
  try {
    if (!message || !message.channel || !message.author) return;
    const channelId = String(message.channel.id || '');
    if (channelId !== '1461370702895779945' && channelId !== '1461370812639481888') return;
    const isSelf = Boolean(client.user && message.author.id === client.user.id);
    if (isSelf) return;
    let content = String(message.content || '').trim();
    if (!content && Array.isArray(message.embeds) && message.embeds.length) {
      const parts = [];
      for (const e of message.embeds) {
        try {
          if (e.title) parts.push(String(e.title));
          if (e.description) parts.push(String(e.description));
          if (Array.isArray(e.fields)) for (const f of e.fields) parts.push(String(f.name || '') + ' ' + String(f.value || ''));
        } catch (ee) {}
      }
      content = parts.join('\n').trim();
    }
    if (!content) return;
    if (!(/<t:\d+:t>/.test(content) || /\b\d+\s*[\.)-]\s*[0-2]?\d[:.][0-5]\d\s*(?:-|–|—|to)\s*[0-2]?\d[:.][0-5]\d\b/i.test(content))) return;

    const key = `force_summary:${message.id}`;
    const now = Date.now();
    const last = recentSendCache.get(key);
    if (last && (now - last) < RECENT_SEND_WINDOW_MS) return;
    recentSendCache.set(key, now);

    const sessions = parseSessionMessage(content, message.createdAt);
    if (!sessions || !sessions.length) return;

    const lines = sessions.map(s => `• ${s.index}. <t:${Math.floor(s.start/1000)}:t> - <t:${Math.floor(s.end/1000)}:t> — Staff: ${s.staff || 'Unassigned'}`);
    const sumEmbed = new EmbedBuilder()
      .setTitle('Session parsed')
      .setColor(0x87CEFA)
      .setDescription(lines.join('\n'))
      .setTimestamp();

    // remove previous parsed summaries in this channel
    try {
      const recent = await message.channel.messages.fetch({ limit: 10 }).catch(()=>null);
      if (recent && typeof recent.filter === 'function') {
        const parsedMsgs = recent.filter(m =>
          m && m.author && client.user && m.author.id === client.user.id &&
          Array.isArray(m.embeds) && m.embeds[0] && String(m.embeds[0].title || '').toLowerCase() === 'session parsed'
        );
        for (const m of parsedMsgs.values()) await m.delete().catch(()=>{});
      }
    } catch (e) {}

    const rowsPending = buildSessionButtonRows('pending', sessions);

    const posted = await (typeof message.reply === 'function'
      ? message.reply({ embeds: [sumEmbed], components: rowsPending, allowedMentions: { parse: [] } })
      : message.channel.send({ embeds: [sumEmbed], components: rowsPending, allowedMentions: { parse: [] } })
    ).catch(()=>null);
    if (posted) {
      try {
        const rows2 = buildSessionButtonRows(posted.id, sessions);
        await posted.edit({ embeds: [sumEmbed], components: rows2 }).catch(()=>{});
      } catch (e) {}
      try {
        const rawVal = content.substring(0, 4000);
        sessionPostData.set(String(posted.id), { authorId: String(message.author.id), raw: rawVal, originChannelId: String(message.channel.id), originMessageId: String(message.id), guildId: message.guildId || (message.guild && message.guild.id) || null, parsed: sessions, postedAt: Date.now() });
        sessionOriginToPosted.set(String(message.id), String(posted.id));
        try { saveSessionPosts(); } catch (e) {}
      } catch (e) {}
    }
  } catch (e) { console.error('final session parsed fallback failed', e); }
});

// Streamer watch commands (add/remove/list)
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    if (!message.content || !message.content.startsWith(PREFIX)) return;
    const [raw, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = raw.toLowerCase();
    if (command !== 'stream' && command !== 'streams' && command !== 'watch') return;

    const sub = (args.shift() || '').toLowerCase();
    if (sub === 'add') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return replyAsEmbed(message, 'You do not have permission.');
      const name = (args.shift() || '').toLowerCase();
      if (!name) return replyAsEmbed(message, 'Usage: *stream add <streamer_login> [#channel]');
      let ch = message.mentions.channels.first();
      if (!ch && args.length) {
        const possible = args.shift().replace(/[<#>]/g, '');
        ch = message.guild.channels.cache.get(possible) || message.guild.channels.cache.find(c => c.name === possible);
      }
      const channelId = ch ? ch.id : message.channel.id;
      const ok = addStreamerForGuild(message.guild.id, name, channelId);
      if (!ok) return replyAsEmbed(message, 'That streamer is already configured for this server.');
      return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Added streamer **${name}** -> <#${channelId}>`)] });
    }

    if (sub === 'remove' || sub === 'rm') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && !message.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) return replyAsEmbed(message, 'You do not have permission.');
      const name = (args.shift() || '').toLowerCase();
      if (!name) return replyAsEmbed(message, 'Usage: *stream remove <streamer_login>');
      const ok = removeStreamerForGuild(message.guild.id, name);
      if (!ok) return replyAsEmbed(message, 'Streamer not found for this server.');
      return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Removed streamer **${name}**`)] });
    }

    if (sub === 'list' || sub === 'ls' || sub === '') {
      const all = loadStreams();
      const list = all[String(message.guild.id)] || [];
      if (!list || !list.length) return replyAsEmbed(message, 'No streamers configured for this server.');
      const lines = list.map(s => `• ${s.name} -> <#${s.channelId}>`).join('\n');
      return message.channel.send({ embeds: [new EmbedBuilder().setTitle('Configured Streamers').setDescription(lines).setColor(0x87CEFA)] });
    }

    return replyAsEmbed(message, 'Stream commands: `*stream add <login> [#channel]`, `*stream remove <login>`, `*stream list`');
  } catch (e) { console.error('stream command failed', e); }
});

// Twitch poller: optional (requires TWITCH_CLIENT_ID & TWITCH_CLIENT_SECRET)
client.on('ready', async () => {
  try {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) return;

    let token = null;
    async function fetchToken() {
      try {
        const res = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`, { method: 'POST' });
        const j = await res.json();
        token = j.access_token;
        return token;
      } catch (e) { console.error('twitch token fetch failed', e); return null; }
    }

    await fetchToken();

    async function pollStreams() {
      try {
        const all = loadStreams();
        const names = [];
        for (const gid of Object.keys(all)) for (const s of (all[gid]||[])) if (s && s.name) names.push(s.name);
        const uniq = Array.from(new Set(names)).slice(0, 100); // limit
        if (!uniq.length) return;
        const params = uniq.map(n => `user_login=${encodeURIComponent(n)}`).join('&');
        const url = `https://api.twitch.tv/helix/streams?${params}`;
        const res = await fetch(url, { headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}` } });
        if (res.status === 401) { await fetchToken(); return; }
        const j = await res.json();
        const liveNow = new Set((j.data||[]).map(d => String(d.user_login).toLowerCase()));

        // iterate guilds and entries
        for (const gid of Object.keys(all)) {
          const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(()=>null);
          if (!guild) continue;
          for (const s of all[gid]) {
            const n = String(s.name).toLowerCase();
            const wasLive = !!s.live;
            const isLive = liveNow.has(n);
            if (isLive && !wasLive) {
              // went live -> notify
              const ch = guild.channels.cache.get(String(s.channelId)) || await guild.channels.fetch(String(s.channelId)).catch(()=>null);
              if (ch && isTextLike(ch)) {
                try {
                  await ch.send({ embeds: [new EmbedBuilder().setTitle(`${s.name} is live on Twitch`).setDescription(`Come watch: https://twitch.tv/${s.name}`).setColor(0x9146FF).setTimestamp()] });
                } catch (e) {}
              }
            }
            // update state
            s.live = !!isLive;
            if (isLive) s.lastLiveAt = Date.now();
          }
        }
        saveStreams(all);
      } catch (e) { console.error('pollStreams failed', e); }
    }

    // start polling every 60s
    setInterval(pollStreams, Number(process.env.STREAM_POLL_SECONDS || 60) * 1000);
    // initial poll
    setTimeout(() => pollStreams().catch(()=>{}), 5000);
  } catch (e) { console.error('stream poller init failed', e); }
});

    // Role change logs (added/removed)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
      const cfg = loadGuildConfig(newMember.guild.id);
      const addedRoles = [];
      const removedRoles = [];
      for (const [rid, role] of newRoles) {
        if (!oldRoles.has(rid) && role && role.name !== '@everyone') addedRoles.push(role);
      }
      for (const [rid, role] of oldRoles) {
        if (!newRoles.has(rid) && role && role.name !== '@everyone') removedRoles.push(role);
      }

      if (addedRoles.length || removedRoles.length) {
        // try to resolve moderator via audit logs (best-effort)
        let moderatorId = null;
        try {
          const logs = await newMember.guild.fetchAuditLogs({ limit: 6, type: AuditLogEvent.MemberUpdate }).catch(() => null);
          const entry = logs && logs.entries
            ? logs.entries.find(e => e && e.target && String(e.target.id) === String(newMember.id) && (Date.now() - e.createdTimestamp) < 15000)
            : null;
          if (entry && entry.executor) moderatorId = entry.executor.id;
        } catch (e) {}

        const nowTs = Math.floor(Date.now() / 1000);

        if (addedRoles.length) {
          const embed = new EmbedBuilder()
            .setTitle('Role(s) added')
            .setColor(0x00AAFF)
            .setThumbnail(newMember.user.displayAvatarURL({ extension: 'png', size: 256 }))
            .addFields(
              { name: 'User', value: `<@${newMember.id}> (${newMember.user.tag})`, inline: true },
              { name: 'Roles', value: addedRoles.map(r => `<@&${r.id}>`).join(', '), inline: false },
              { name: 'Moderator', value: moderatorId ? `<@${moderatorId}>` : '—', inline: true }
            ).setTimestamp()
            .setFooter(buildFooter(newMember.guild));

          const roleLogChannelId = process.env.ROLE_LOG_CHANNEL_ID || cfg.roleLogChannelId || '1421523779913384027';
          let roleCh = newMember.guild.channels.cache.get(roleLogChannelId) || await newMember.guild.channels.fetch(roleLogChannelId).catch(()=>null);
          if (!roleCh) {
            const maybe = await client.channels.fetch(roleLogChannelId).catch(()=>null);
            if (maybe && maybe.guild && String(maybe.guild.id) === String(newMember.guild.id)) roleCh = maybe;
          }
          if (roleCh && isTextLike(roleCh)) {
            await roleCh.send({ embeds: [embed] }).catch(() => {});
          } else {
            await sendLog(newMember.guild, { embeds: [embed], category: 'role' }).catch(() => {});
          }
        }

        if (removedRoles.length) {
          const embed = new EmbedBuilder()
            .setTitle('Role(s) removed')
            .setColor(0xE74C3C)
            .setThumbnail(newMember.user.displayAvatarURL({ extension: 'png', size: 256 }))
            .addFields(
              { name: 'User', value: `<@${newMember.id}> (${newMember.user.tag})`, inline: true },
              { name: 'Roles', value: removedRoles.map(r => `<@&${r.id}>`).join(', '), inline: false },
              { name: 'Moderator', value: moderatorId ? `<@${moderatorId}>` : '—', inline: true }
            ).setTimestamp()
            .setFooter(buildFooter(newMember.guild));

          const roleLogChannelId = process.env.ROLE_LOG_CHANNEL_ID || cfg.roleLogChannelId || '1421523779913384027';
          let roleCh = newMember.guild.channels.cache.get(roleLogChannelId) || await newMember.guild.channels.fetch(roleLogChannelId).catch(()=>null);
          if (!roleCh) {
            const maybe = await client.channels.fetch(roleLogChannelId).catch(()=>null);
            if (maybe && maybe.guild && String(maybe.guild.id) === String(newMember.guild.id)) roleCh = maybe;
          }
          if (roleCh && isTextLike(roleCh)) {
            await roleCh.send({ embeds: [embed] }).catch(() => {});
          } else {
            await sendLog(newMember.guild, { embeds: [embed], category: 'role' }).catch(() => {});
          }
        }
      }
  } catch (e) { /* ignore role-log errors */ }
});

// Resolve and validate token before login
const { token: resolvedToken, source } = resolveToken();

// Optional: auto git-pull on startup (set GIT_AUTO_PULL=true)
function maybeAutoGitPull() {
  try {
    if (!process.env.GIT_AUTO_PULL || String(process.env.GIT_AUTO_PULL).toLowerCase() !== 'true') return Promise.resolve(false);
    const remote = process.env.GIT_PULL_REMOTE || 'origin';
    const branch = process.env.GIT_PULL_BRANCH || 'main';
    return new Promise((resolve) => {
      exec(`git pull ${remote} ${branch}`, { cwd: __dirname, windowsHide: true }, (err, stdout, stderr) => {
        if (err) console.warn('git pull failed:', err.message || err);
        if (stdout) console.log(stdout.trim());
        if (stderr) console.warn(stderr.trim());
        resolve(true);
      });
    });
  } catch (e) {
    console.warn('git pull skipped:', e);
    return Promise.resolve(false);
  }
}

const startupPull = maybeAutoGitPull();

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

Promise.resolve(startupPull).finally(() => {
  client.login(token).catch((e) => {
    console.error('❌ Failed to login — token invalid.');
    console.error('Tip: Regenerate the bot token in Discord Developer Portal and update your Startup variable or token.txt.');
    console.error('Error:', e.message);
    process.exit(1);
  });
});

// One-time startup simulation: if a file `simulate_session.json` exists in the data dir,
// read it and emit a synthetic `messageCreate` event so the session flow runs once.
try {
  const simPath = path.join(DATA_DIR, 'simulate_session.json');
  if (fs.existsSync(simPath)) {
    setTimeout(async () => {
      try {
        const raw = fs.readFileSync(simPath, 'utf8');
        const cfg = JSON.parse(raw || '{}');
        const channelId = String(cfg.channel || '1461370812639481888');
        const content = String(cfg.content || '1. 17:00 - 17:15\nStaff: @Rakim');
        const fakeChannel = { id: channelId, send: async () => {}, isTextBased: () => true };
        const fakeAuthor = { id: String(cfg.authorId || '999999999999999999'), tag: cfg.authorTag || 'SimUser#0001' };
        const fakeMsg = { id: `sim_${Date.now()}`, author: fakeAuthor, content, channel: fakeChannel, createdAt: new Date(), react: async () => {}, _isSeed: true };
        try {
          client.emit('messageCreate', fakeMsg);
          console.log('🔁 Startup simulation emitted (simulate_session.json)');
        } catch (e) { console.error('Startup simulation failed', e); }
      } catch (e) { console.error('Failed to read simulate_session.json', e); }
      try { fs.unlinkSync(simPath); } catch (e) {}
    }, 2000); 
    }
  } catch (e) { console.error('startup simulation check failed', e); }

