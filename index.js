const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const CLAIMING_CONFIG = require('./claiming.config');
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
    handleVoiceStateUpdate: () => {},
  };
}

let DOTENV_PRESENT = false;
let DOTENV_LOADED = false;
try {
  const envPath = path.join(__dirname, '.env');
  DOTENV_PRESENT = fs.existsSync(envPath);
  if (DOTENV_PRESENT) {
    require('dotenv').config({ path: envPath });
    DOTENV_LOADED = true;
  }
} catch (e) {
  console.warn('⚠️ dotenv not available or .env not found');
}

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
let createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior;
try {
  voiceLib = require('@discordjs/voice');
  joinVoiceChannel = voiceLib.joinVoiceChannel;
  EndBehaviorType = voiceLib.EndBehaviorType;
  getVoiceConnection = voiceLib.getVoiceConnection;
  createAudioPlayer = voiceLib.createAudioPlayer;
  createAudioResource = voiceLib.createAudioResource;
  AudioPlayerStatus = voiceLib.AudioPlayerStatus;
  NoSubscriberBehavior = voiceLib.NoSubscriberBehavior;
  console.log('✅ @discordjs/voice loaded (voice receive available)');
} catch (e) {
  // @discordjs/voice not installed on this host; voice features disabled (silent)
}
let playDl = null;
try {
  playDl = require('play-dl');
  console.log('✅ play-dl loaded (YouTube audio available)');
} catch (e) {
  // play-dl missing: *play will return a user-facing error
}
let ytDlpExec = null;
try {
  ytDlpExec = require('yt-dlp-exec');
  console.log('✅ yt-dlp fallback loaded');
} catch (e) {
  // optional fallback
}
try {
  const ffmpegStaticPath = require('ffmpeg-static');
  if (ffmpegStaticPath && !process.env.FFMPEG_PATH) {
    process.env.FFMPEG_PATH = ffmpegStaticPath;
    process.env.FFPLAY_PATH = ffmpegStaticPath;
    console.log('✅ ffmpeg-static configured');
  }
} catch (e) {
  // ffmpeg-static missing: playback may fail for non-opus streams
}

const guildVoicePlayers = new Map();
const guildMusicQueues = new Map();
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
const CM_FIXED_BAN_USER_ID = '1191442500976640172';
const SESSIONS_REMINDERS_PATH = path.join(DATA_DIR, 'sessions_reminders.json');
const SESSIONS_WATCH_PATH = path.join(DATA_DIR, 'sessions_watch.json');
const SQLITE_DB_PATH = path.join(DATA_DIR, 'vanta_bot.sqlite');
const SESSIONS_CLAIMS_PATH = path.join(DATA_DIR, 'sessions_claims.json');
const SESSIONS_POSTS_PATH = path.join(DATA_DIR, 'sessions_posts.json');
const VOICE_CREATE_PATH = path.join(DATA_DIR, 'voice_create.json');
const DROPMAP_MARKS_PATH = path.join(DATA_DIR, 'dropmap_marks.json');
const APPEAL_STATE_PATH = path.join(DATA_DIR, 'appeal_states.json');
const APPEAL_REVIEW_CHANNEL_ID = process.env.APPEAL_REVIEW_CHANNEL_ID || '1482105356233605191';
const DYNAMIC_COMMANDS_LOCAL_PATH = path.join(DATA_DIR, 'dynamic_commands.json');
const DYNAMIC_COMMANDS_URL = String(process.env.DYNAMIC_COMMANDS_URL || 'https://hanno-s-website.onrender.com/api/discord-commands').trim();
const DYNAMIC_COMMANDS_BOT_KEY = String(process.env.DYNAMIC_COMMANDS_BOT_KEY || '').trim();
const DYNAMIC_COMMANDS_REFRESH_MS = Math.max(15_000, Number(process.env.DYNAMIC_COMMANDS_REFRESH_MS || 60_000));
const DYNAMIC_COMMANDS_ALLOW_OVERRIDE = String(process.env.DYNAMIC_COMMANDS_ALLOW_OVERRIDE || 'false').toLowerCase() === 'true';
const DYNAMIC_COMMANDS_WEBHOOK_PORT = Number(process.env.DYNAMIC_COMMANDS_WEBHOOK_PORT || 0);
const DYNAMIC_COMMANDS_WEBHOOK_HOST = String(process.env.DYNAMIC_COMMANDS_WEBHOOK_HOST || '0.0.0.0').trim();
const DYNAMIC_COMMANDS_WEBHOOK_KEY = String(process.env.DYNAMIC_COMMANDS_WEBHOOK_KEY || '').trim();

// Streams/watchers storage
const STREAMS_PATH = path.join(DATA_DIR, 'streams.json');
const TEMP_BANS_PATH = path.join(DATA_DIR, 'temp_bans.json');

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

const RESERVED_PREFIX_COMMANDS = new Set([
  'help','h','allban','rebanall','reban','clearmodlogs','membercount','mc','invite','rules','8ball','flip',
  'dice','roll','wheel','wheelhelp','wheelinfo','spins','admin','clearracism','purgeracist','cleartoxic','purgehate',
  'sa','sb','shelp','beta','alpha','rate','joke','compliment','md','modlogs','mds','say','close','case','cases',
  'warn','ban','bancm','kick','unban','sgrief','softgrief','miss','lmiss','mute','unmute','santa','gift','snow',
  'advent','join','play','pause','resume','stop','queue','leave','music','del','delete','role','setautorole','autorole',
  'reason','duration','dcase','stream','streams','watch','ticket','dp','db','uploads','env','session','create'
]);

const dynamicCommandsState = {
  byTrigger: new Map(),
  lastSyncAt: 0,
  lastMissSyncAt: 0,
  lastError: null,
  source: 'none',
};
let dynamicCommandsRefreshTimer = null;
let dynamicCommandsWebhookServer = null;

function normalizeDynamicCommandEntry(entry) {
  const trigger = String(entry && entry.trigger ? entry.trigger : '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(trigger)) return null;
  const response = String(entry && (entry.response || entry.content) ? (entry.response || entry.content) : '').trim();
  if (!response || response.length > 1800) return null;
  const modeRaw = String(entry && entry.mode ? entry.mode : 'text').trim().toLowerCase();
  const mode = (modeRaw === 'embed') ? 'embed' : 'text';
  const embedTitle = String(entry && entry.embedTitle ? entry.embedTitle : '').trim().slice(0, 120);
  const colorRaw = String(entry && entry.embedColor ? entry.embedColor : '#87CEFA').trim();
  const embedColor = /^#?[0-9a-fA-F]{6}$/.test(colorRaw) ? `#${colorRaw.replace(/^#/, '').toUpperCase()}` : '#87CEFA';
  return {
    trigger,
    response,
    enabled: entry && entry.enabled === false ? false : true,
    mode,
    embedTitle,
    embedColor,
  };
}

function applyDynamicCommandList(list, source = 'unknown') {
  const next = new Map();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const item = normalizeDynamicCommandEntry(raw);
    if (!item || !item.enabled) continue;
    if (next.has(item.trigger)) continue;
    next.set(item.trigger, item);
  }
  dynamicCommandsState.byTrigger = next;
  dynamicCommandsState.lastSyncAt = Date.now();
  dynamicCommandsState.lastError = null;
  dynamicCommandsState.source = source;
}

function loadDynamicCommandsFromLocalFile() {
  try {
    const raw = loadJson(DYNAMIC_COMMANDS_LOCAL_PATH, { commands: [] });
    const list = Array.isArray(raw && raw.commands) ? raw.commands : [];
    applyDynamicCommandList(list, `local:${path.basename(DYNAMIC_COMMANDS_LOCAL_PATH)}`);
    return true;
  } catch (e) {
    return false;
  }
}

async function refreshDynamicCommands(force = false) {
  try {
    const now = Date.now();
    if (!force && (now - Number(dynamicCommandsState.lastSyncAt || 0)) < DYNAMIC_COMMANDS_REFRESH_MS) return;

    if (!DYNAMIC_COMMANDS_URL) {
      loadDynamicCommandsFromLocalFile();
      return;
    }

    const headers = {};
    if (DYNAMIC_COMMANDS_BOT_KEY) headers['x-bot-key'] = DYNAMIC_COMMANDS_BOT_KEY;
    const response = await fetch(DYNAMIC_COMMANDS_URL, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload || !Array.isArray(payload.commands)) {
      throw new Error(String((payload && payload.error) || `HTTP ${response.status}`));
    }
    applyDynamicCommandList(payload.commands, 'remote');
  } catch (e) {
    dynamicCommandsState.lastError = String(e && e.message ? e.message : e);
    if (!dynamicCommandsState.byTrigger.size) loadDynamicCommandsFromLocalFile();
  }
}

function renderDynamicCommandTemplate(input, ctx) {
  const src = String(input || '');
  if (!src) return '';
  const args = Array.isArray(ctx && ctx.args) ? ctx.args : [];
  const map = {
    user: ctx && ctx.userMention ? ctx.userMention : '',
    username: ctx && ctx.username ? ctx.username : '',
    server: ctx && ctx.serverName ? ctx.serverName : '',
    channel: ctx && ctx.channelMention ? ctx.channelMention : '',
    args: args.join(' '),
    prefix: PREFIX,
    command: ctx && ctx.command ? ctx.command : '',
    arg1: args[0] || '',
    arg2: args[1] || '',
    arg3: args[2] || '',
    arg4: args[3] || '',
    arg5: args[4] || '',
  };
  return src.replace(/\{(user|username|server|channel|args|prefix|command|arg1|arg2|arg3|arg4|arg5)\}/gi, (m, k) => map[String(k || '').toLowerCase()] || '');
}

async function tryExecuteDynamicPrefixCommand(message, command, args) {
  try {
    if (!message || !message.channel || !command) return false;
    await refreshDynamicCommands(false);
    if (!DYNAMIC_COMMANDS_ALLOW_OVERRIDE && RESERVED_PREFIX_COMMANDS.has(String(command).toLowerCase())) return false;

    const key = String(command).toLowerCase();
    let entry = dynamicCommandsState.byTrigger.get(key);
    if (!entry) {
      const now = Date.now();
      // If a new command was just created in the panel, do one forced refresh
      // so users don't need to wait for the normal polling interval.
      if ((now - Number(dynamicCommandsState.lastMissSyncAt || 0)) > 4000) {
        dynamicCommandsState.lastMissSyncAt = now;
        await refreshDynamicCommands(true);
        entry = dynamicCommandsState.byTrigger.get(key);
      }
    }
    if (!entry) return false;

    const rendered = renderDynamicCommandTemplate(entry.response, {
      command,
      args,
      userMention: `<@${message.author.id}>`,
      username: message.author.username || '',
      serverName: (message.guild && message.guild.name) ? message.guild.name : '',
      channelMention: (message.channel && message.channel.id) ? `<#${message.channel.id}>` : '',
    }).slice(0, 1900);

    if (!rendered) return false;
    if (entry.mode === 'embed') {
      const colorNum = parseInt(String(entry.embedColor || '#87CEFA').replace('#', ''), 16);
      const emb = new EmbedBuilder()
        .setColor(Number.isFinite(colorNum) ? colorNum : 0x87CEFA)
        .setDescription(rendered)
        .setTimestamp();
      if (entry.embedTitle) emb.setTitle(String(entry.embedTitle));
      await message.channel.send({ embeds: [emb], allowedMentions: { parse: ['users', 'roles'] } }).catch(() => null);
      return true;
    }

    await message.channel.send({ content: rendered, allowedMentions: { parse: ['users', 'roles'] } }).catch(() => null);
    return true;
  } catch (e) {
    return false;
  }
}

function startDynamicCommandsWebhookServer() {
  try {
    if (!DYNAMIC_COMMANDS_WEBHOOK_PORT || DYNAMIC_COMMANDS_WEBHOOK_PORT < 1) return;
    if (!DYNAMIC_COMMANDS_WEBHOOK_KEY) {
      console.warn('dynamic commands webhook disabled: DYNAMIC_COMMANDS_WEBHOOK_KEY missing');
      return;
    }
    if (dynamicCommandsWebhookServer) return;

    dynamicCommandsWebhookServer = http.createServer(async (req, res) => {
      try {
        const url = String(req.url || '').split('?')[0];
        if (req.method !== 'POST' || url !== '/internal/dynamic-commands/refresh') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Not found' }));
          return;
        }

        const providedKey = String(req.headers['x-refresh-key'] || '').trim();
        if (!providedKey || providedKey !== DYNAMIC_COMMANDS_WEBHOOK_KEY) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
          return;
        }

        await refreshDynamicCommands(true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          source: dynamicCommandsState.source,
          count: dynamicCommandsState.byTrigger.size,
          lastSyncAt: dynamicCommandsState.lastSyncAt,
          error: dynamicCommandsState.lastError || null,
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
      }
    });

    dynamicCommandsWebhookServer.listen(DYNAMIC_COMMANDS_WEBHOOK_PORT, DYNAMIC_COMMANDS_WEBHOOK_HOST, () => {
      console.log(`dynamic commands webhook listening on ${DYNAMIC_COMMANDS_WEBHOOK_HOST}:${DYNAMIC_COMMANDS_WEBHOOK_PORT}`);
    });
  } catch (e) {
    console.error('failed to start dynamic commands webhook server', e);
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
    // Defaults (fallback) for session-claiming channels
    const defaults = ['1469754683760316614', '1469754640777347176'];
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
  } catch (e) { return new Set(['1469754683760316614', '1469754640777347176']); }
}

  function loadDropmapMarks() {
    return loadJson(DROPMAP_MARKS_PATH, {});
  }

  function saveDropmapMarks(obj) {
    saveJson(DROPMAP_MARKS_PATH, obj || {});
  }

  function getDropmapClaims(guildId, channelId) {
    const all = loadDropmapMarks();
    const gid = String(guildId || '');
    const cid = String(channelId || '');
    if (!gid || !cid) return {};
    if (!all[gid] || !all[gid][cid] || typeof all[gid][cid].claims !== 'object' || !all[gid][cid].claims) return {};
    return all[gid][cid].claims;
  }

  function setDropmapClaim(guildId, channelId, userId, zone) {
    const all = loadDropmapMarks();
    const gid = String(guildId || '');
    const cid = String(channelId || '');
    const uid = String(userId || '');
    if (!gid || !cid || !uid) return false;
    if (!all[gid]) all[gid] = {};
    if (!all[gid][cid]) all[gid][cid] = { claims: {}, updatedAt: Date.now() };
    if (!all[gid][cid].claims || typeof all[gid][cid].claims !== 'object') all[gid][cid].claims = {};
    all[gid][cid].claims[uid] = String(zone || '').trim().slice(0, 64);
    all[gid][cid].updatedAt = Date.now();
    saveDropmapMarks(all);
    return true;
  }

  function removeDropmapClaim(guildId, channelId, userId) {
    const all = loadDropmapMarks();
    const gid = String(guildId || '');
    const cid = String(channelId || '');
    const uid = String(userId || '');
    if (!gid || !cid || !uid || !all[gid] || !all[gid][cid] || !all[gid][cid].claims) return false;
    if (!Object.prototype.hasOwnProperty.call(all[gid][cid].claims, uid)) return false;
    delete all[gid][cid].claims[uid];
    all[gid][cid].updatedAt = Date.now();
    saveDropmapMarks(all);
    return true;
  }

  function buildDropmapPanelEmbed(guildId, channelId) {
    const claims = getDropmapClaims(guildId, channelId);
    const cfg = loadGuildConfig(guildId);
    const rows = Object.entries(claims)
      .filter(([uid, zone]) => uid && zone)
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'de', { sensitivity: 'base' }));

    const lines = rows.map(([uid, zone]) => `• **${String(zone)}** — <@${uid}>`);
    const desc = lines.length
      ? lines.slice(0, 40).join('\n')
      : 'No marks yet. Click **Mark** to claim your spot.';

    const embed = new EmbedBuilder()
      .setColor(0x1E90FF)
      .setTitle('Dropmap — Marks')
      .setDescription(desc)
      .setFooter({ text: 'Mark = claim spot • Unmark = remove spot' })
      .setTimestamp();

    const imageUrl = cfg && typeof cfg.dropmapImageUrl === 'string' ? String(cfg.dropmapImageUrl).trim() : '';
    if (/^https?:\/\//i.test(imageUrl)) {
      embed.setImage(imageUrl);
    }

    return embed;
  }

  function buildDropmapPanelRow() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('dropmap_mark').setLabel('Mark').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('dropmap_unmark').setLabel('Unmark').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('dropmap_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    );
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
let tempBansState = loadJson(TEMP_BANS_PATH, { entries: [] });
if (!tempBansState || typeof tempBansState !== 'object') tempBansState = { entries: [] };
if (!Array.isArray(tempBansState.entries)) tempBansState.entries = [];
const tempBanTimeouts = new Map();
let tempBanSchedulerHydrated = false;

function tempBanKey(guildId, userId) {
  return `${String(guildId || '')}:${String(userId || '')}`;
}

function saveTempBansState() {
  try { saveJson(TEMP_BANS_PATH, tempBansState); } catch (e) {}
}

function removeTempBanEntry(guildId, userId, { clearTimer = true, persist = true } = {}) {
  const key = tempBanKey(guildId, userId);
  if (clearTimer && tempBanTimeouts.has(key)) {
    try { clearTimeout(tempBanTimeouts.get(key)); } catch (e) {}
    tempBanTimeouts.delete(key);
  }

  const before = tempBansState.entries.length;
  tempBansState.entries = tempBansState.entries.filter(e => tempBanKey(e && e.guildId, e && e.userId) !== key);
  const removed = before !== tempBansState.entries.length;
  if (removed && persist) saveTempBansState();
  return removed;
}

async function executeTempBanExpiry(entry) {
  try {
    if (!entry || !entry.guildId || !entry.userId) return;
    const guildId = String(entry.guildId);
    const userId = String(entry.userId);

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const durationText = humanDuration(Number(entry.durationMs) || 0);
    const unbanReason = `Temp ban expired${durationText ? ` (${durationText})` : ''}${entry.caseId ? ` - Case ${entry.caseId}` : ''}`;

    markRecentModAction(guildId, 'Unban', userId, '*');

    try {
      await guild.bans.remove(userId, unbanReason);
    } catch (e) {
      const msg = String((e && (e.message || e.code)) || e || '').toLowerCase();
      if (!msg.includes('unknown ban') && !msg.includes('10026')) throw e;
      return;
    }

    const caseId = nextCase();
    const whenTs = Date.now();
    if (!modlogs || typeof modlogs !== 'object') modlogs = { lastCase: 10000, cases: [] };
    if (!Array.isArray(modlogs.cases)) modlogs.cases = [];
    modlogs.cases.push({
      caseId,
      type: 'Unban',
      user: userId,
      moderator: client && client.user ? String(client.user.id) : 'system',
      reason: unbanReason,
      time: whenTs,
      guildId
    });
    saveJson(MODLOGS_PATH, modlogs);
    writeModlogCaseToMd({ guild, caseId, type: 'Unban', userId, moderatorId: client && client.user ? String(client.user.id) : 'system', reason: unbanReason, whenTs });

    try {
      const targetUser = await client.users.fetch(userId).catch(() => null);
      if (targetUser) {
        await sendModEmbedToUser(targetUser, 'Unban', { guild, moderatorTag: client && client.user ? client.user.tag : 'System', reason: unbanReason, caseId });
      }
    } catch (e) {}

    try {
      const nowTs = Math.floor(Date.now() / 1000);
      const targetUser = await client.users.fetch(userId).catch(() => null);
      const embed = buildSmallModerationEmbed({
        title: 'Temp ban expired',
        targetId: userId,
        targetAvatarUrl: targetUser ? targetUser.displayAvatarURL({ extension: 'png', size: 256 }) : null,
        moderatorId: client && client.user ? String(client.user.id) : 'system',
        reason: unbanReason,
        caseId,
        nowTs
      });
      await sendLog(guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
    } catch (e) {}
  } catch (e) {
    console.error('temp ban expiry failed', e);
  } finally {
    try { removeTempBanEntry(entry && entry.guildId, entry && entry.userId, { clearTimer: false, persist: true }); } catch (e) {}
  }
}

function scheduleTempBanEntry(entry, { persist = true } = {}) {
  if (!entry || !entry.guildId || !entry.userId || !entry.unbanAt) return;
  const key = tempBanKey(entry.guildId, entry.userId);

  removeTempBanEntry(entry.guildId, entry.userId, { clearTimer: true, persist: false });

  if (persist) {
    tempBansState.entries.push(entry);
    saveTempBansState();
  }

  const delay = Math.max(0, Number(entry.unbanAt) - Date.now());
  const t = setTimeout(async () => {
    try {
      await executeTempBanExpiry(entry);
    } catch (e) {
      console.error('scheduled temp ban expiry failed', e);
    } finally {
      tempBanTimeouts.delete(key);
    }
  }, delay);
  tempBanTimeouts.set(key, t);
}

function initTempBanScheduler() {
  try {
    if (tempBanSchedulerHydrated) return;
    tempBanSchedulerHydrated = true;

    const now = Date.now();
    const keep = [];
    for (const raw of tempBansState.entries || []) {
      if (!raw || !raw.guildId || !raw.userId || !raw.unbanAt) continue;
      let unbanAt = Number(raw.unbanAt);
      if (!Number.isFinite(unbanAt) || unbanAt <= 0) continue;
      if (unbanAt <= now) unbanAt = now + 1500;
      const fixed = {
        guildId: String(raw.guildId),
        userId: String(raw.userId),
        moderatorId: raw.moderatorId ? String(raw.moderatorId) : null,
        caseId: raw.caseId ? Number(raw.caseId) : null,
        reason: String(raw.reason || ''),
        durationMs: Number(raw.durationMs || 0),
        unbanAt
      };
      keep.push(fixed);
      scheduleTempBanEntry(fixed, { persist: false });
    }
    tempBansState.entries = keep;
    saveTempBansState();
  } catch (e) {
    console.error('initTempBanScheduler failed', e);
  }
}

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

function isUserDiceBlacklisted(userId) {
  try {
    if (!blacklist || !Array.isArray(blacklist.diceBlacklisted)) return false;
    return blacklist.diceBlacklisted.some(b => b && String(b.id) === String(userId));
  } catch (e) { return false; }
}

// Automod configuration (env vars override file)
// NOTE: Keep this list reasonably sized and maintain it in automod.json when possible.
// We intentionally avoid printing the raw matched words in logs; they get masked.
const DEFAULT_AUTOMOD_BLOCKED_WORDS = [
  'nigger',
  'nigga',
  'kike',
  'chink',
  'spic',
  'coon',
  'raghead',
  'wetback',
  'zipperhead',
  'gook',
  'wog',
  'sandnigger',
  'kaffir',
  'porch monkey'
];

const DEFAULT_AUTOMOD = {
  blockedRoles: ['Member'],
  allowedRoles: [],
  muteMinutes: 2,
  logChannelNames: ['discord-logs', 'mod-logs', 'logs'],
  // Link automod toggle: set true to delete/timeout Discord invite links.
  // User request (2026-02-07): disable link automod.
  blockInviteLinks: false
};

function automodStripDiacritics(s) {
  try {
    return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  } catch (e) {
    return String(s || '');
  }
}

function automodNormalizeText(s) {
  let t = automodStripDiacritics(String(s || '').toLowerCase());
  // common leetspeak / symbol substitutions
  t = t
    .replace(/[@]/g, 'a')
    .replace(/[\$]/g, 's')
    .replace(/[0]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4]/g, 'a')
    .replace(/[5]/g, 's')
    .replace(/[7]/g, 't');

  // turn punctuation into spaces, keep letters and spaces
  t = t.replace(/[^a-z\s]/g, ' ');
  // collapse long repeats (e.g. "niiiigga" -> "niigga")
  t = t.replace(/([a-z])\1{2,}/g, '$1$1');
  // normalize whitespace
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function automodMaskWord(w) {
  const s = String(w || '').trim();
  if (!s) return '';
  if (s.length <= 2) return '*'.repeat(s.length);
  return `${s[0]}${'*'.repeat(Math.min(8, s.length - 2))}${s[s.length - 1]}`;
}

function automodFindBlockedMatches(text, blockedWords) {
  const list = Array.isArray(blockedWords) ? blockedWords : [];
  const normText = ` ${automodNormalizeText(text)} `;
  const matches = [];
  for (const raw of list) {
    if (raw == null) continue;
    const w = automodNormalizeText(raw);
    if (!w) continue;
    if (normText.includes(` ${w} `)) matches.push(String(raw));
  }
  return matches;
}

function parseEnvBool(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return null;
}

function loadAutomodConfig() {
  const cfg = Object.assign({}, DEFAULT_AUTOMOD);
  if (process.env.AUTOMOD_BLOCKED_ROLES) cfg.blockedRoles = process.env.AUTOMOD_BLOCKED_ROLES.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.AUTOMOD_ALLOWED_ROLES) cfg.allowedRoles = process.env.AUTOMOD_ALLOWED_ROLES.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.AUTOMOD_MUTE_MINUTES) { const n = parseInt(process.env.AUTOMOD_MUTE_MINUTES, 10); if (!isNaN(n)) cfg.muteMinutes = n; }
  if (process.env.AUTOMOD_LOG_CHANNELS) cfg.logChannelNames = process.env.AUTOMOD_LOG_CHANNELS.split(',').map(s => s.trim()).filter(Boolean);
  {
    const b = parseEnvBool(process.env.AUTOMOD_BLOCK_INVITE_LINKS);
    if (typeof b === 'boolean') cfg.blockInviteLinks = b;
  }
  try {
    const p = path.join(DATA_DIR, 'automod.json'); 
    console.log('Loading automod configuration from', p);
    if (fs.existsSync(p)) {
      const fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(fileCfg.blockedRoles)) cfg.blockedRoles = fileCfg.blockedRoles;
      if (Array.isArray(fileCfg.allowedRoles)) cfg.allowedRoles = fileCfg.allowedRoles;
      if (typeof fileCfg.muteMinutes === 'number') cfg.muteMinutes = fileCfg.muteMinutes;
      if (Array.isArray(fileCfg.logChannelNames)) cfg.logChannelNames = fileCfg.logChannelNames;
      if (typeof fileCfg.blockInviteLinks === 'boolean') cfg.blockInviteLinks = fileCfg.blockInviteLinks;
      if (Array.isArray(fileCfg.blockedWords)) cfg.blockedWords = fileCfg.blockedWords;
    }
  } catch (e) { console.error('Failed to load automod.json', e); }
  // Always allow links; invite-link automod is disabled.
  cfg.blockInviteLinks = false;
  return cfg;
}

const AUTOMOD_CONFIG = loadAutomodConfig();
const AUTOMOD_DISABLED_GUILD_IDS = new Set([
  '1236461630372450384'
]);

function isAutomodDisabledForGuild(guildId) {
  return AUTOMOD_DISABLED_GUILD_IDS.has(String(guildId || ''));
}

const APPEAL_WINDOW_MS = 10 * 60 * 1000;

function getAppealPenaltyLabel(actionType) {
  const t = String(actionType || '').toLowerCase();
  if (t.includes('ban')) return 'Ban';
  if (t.includes('mute')) return 'Mute';
  return 'Punishment';
}

function getAppealQuestions(actionType) {
  const penaltyBase = getAppealPenaltyLabel(actionType).toLowerCase();
  const penaltyVerb = penaltyBase === 'mute' ? 'muted' : (penaltyBase === 'ban' ? 'banned' : 'punished');
  return [
    `Why did you get ${penaltyVerb}?`,
    'Why do you believe your appeal should be accepted?',
    'Is there anything else you would like for us to know?',
    `Clip for Un${getAppealPenaltyLabel(actionType)} (link)`
  ];
}

function buildAppealQuestionEmbed(actionType, step, expiresAt = null) {
  const questions = getAppealQuestions(actionType);
  const idx = Math.max(0, Math.min(questions.length - 1, Number(step) || 0));
  const leftTs = Math.floor((Number(expiresAt) > 0 ? Number(expiresAt) : (Date.now() + APPEAL_WINDOW_MS)) / 1000);
  return new EmbedBuilder()
    .setColor(0x87CEFA)
    .setTitle(`Appeal Question ${idx + 1}/${questions.length}`)
    .setDescription(`**${idx + 1}. ${questions[idx]}**\n\nTime left: <t:${leftTs}:R>`);
}

function loadAppealState() {
  const st = loadJson(APPEAL_STATE_PATH, { nextId: 1, invites: {}, pending: {}, submissions: {} });
  if (!st || typeof st !== 'object') return { nextId: 1, pending: {}, submissions: {} };
  if (!Number.isFinite(Number(st.nextId)) || Number(st.nextId) < 1) st.nextId = 1;
  if (!st.invites || typeof st.invites !== 'object') st.invites = {};
  if (!st.pending || typeof st.pending !== 'object') st.pending = {};
  if (!st.submissions || typeof st.submissions !== 'object') st.submissions = {};
  return st;
}

function saveAppealState(st) {
  try { saveJson(APPEAL_STATE_PATH, st || { nextId: 1, invites: {}, pending: {}, submissions: {} }); } catch (e) {}
}

let appealState = loadAppealState();

async function startAppealQuestionnaire(user, { guildId = null, actionType = 'Moderation', caseId = null } = {}) {
  try {
    if (!user || !user.id) return;
    appealState = loadAppealState();
    const uid = String(user.id);

    const kind = String(actionType || 'Moderation').toLowerCase().includes('ban') ? 'b' : (String(actionType || 'Moderation').toLowerCase().includes('mute') ? 'm' : 'o');
    const safeCase = (caseId !== null && caseId !== undefined && /^\d+$/.test(String(caseId))) ? String(caseId) : '0';
    appealState.invites[uid] = {
      guildId: guildId ? String(guildId) : null,
      actionType: String(actionType || 'Moderation'),
      caseId: caseId || null,
      createdAt: Date.now(),
    };
    saveAppealState(appealState);

    const intro = new EmbedBuilder()
      .setColor(0x87CEFA)
      .setTitle('Appeal Form')
      .setDescription('You can submit an appeal in 4 short questions.\n\nPress **Start Appeal** to begin.\nYou have **10 minutes** to complete the appeal after starting.');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`appeal_begin:${uid}:${kind}:${safeCase}`)
        .setLabel('Start Appeal')
        .setStyle(ButtonStyle.Primary)
    );

    await user.send({ embeds: [intro], components: [row] }).catch(() => null);
  } catch (e) {
    console.error('startAppealQuestionnaire failed', e);
  }
}

function canReviewAppealsFromMember(member) {
  try {
    if (!member) return false;
    if (member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;
    if (member.roles?.cache?.has?.(ADMIN_COMMAND_ROLE_ID)) return true;
    if (member.roles?.cache?.has?.(HEAD_STAFF_COMMAND_ROLE_ID)) return true;
    if (member.roles?.cache?.has?.(STAFF_COMMAND_ROLE_ID)) return true;
    return false;
  } catch (e) {
    return false;
  }
}

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
    const base = `${String(guildId || 'dm')}:${String(type || 'Unknown')}:${String(subjectId || 'unknown')}`;
    const modKey = `${base}:${String(moderatorId || '*')}`;
    recentModActionKeys.set(modKey, now);
    // Always also store a wildcard moderator key so audit-log based dedupe works even when
    // executor IDs differ (bot vs label) or are missing.
    const wildcardKey = `${base}:*`;
    recentModActionKeys.set(wildcardKey, now);
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
  const raw = String(reason || '').trim();
  if (!raw || raw.toLowerCase() === 'no reason provided') return 'Perm';
  const r = normalizeReason(raw);
  if (/^perm\b/i.test(r)) return r;
  return r;
}

function displayCaseType(type) {
  const t = String(type || '').trim();
  const lt = t.toLowerCase();
  if (lt === 'blacklist') return 'Blacklisted';
  if (lt === 'unblacklist') return 'Unblacklisted';
  if (lt === 'guildblacklist') return 'Server Blacklisted';
  if (lt === 'guildunblacklist') return 'Server Unblacklisted';
  return t || 'Unknown';
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
    return cfg.sessions[m] || cfg.sessions['default'] || {};d
  } catch (e) { return {}; }
}

// sessions log channel id (default fallback)
const SESSIONS_LOG_CHANNEL_ID = '1469760090151063754';
const NO_LOGS_GUILD_IDS = new Set(['1236461630372450384']);

function isLogsDisabledForGuildId(guildId) {
  try {
    return !!(guildId && NO_LOGS_GUILD_IDS.has(String(guildId)));
  } catch (e) {
    return false;
  }
}

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
    const resolvedGuildId = String(guildId || (payload && payload.guildId) || '');
    if (isLogsDisabledForGuildId(resolvedGuildId)) return;
    const chId = resolveSessionsLogChannelId(resolvedGuildId);
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
    const resolvedGuildId = String(guildId || (payload && payload.guildId) || '');
    if (isLogsDisabledForGuildId(resolvedGuildId)) return;
    // Prefer explicit env var, then config keys `messageLogChannelId`, then legacy `logChannelId`.
    const chId = resolveMessageLogChannelId(resolvedGuildId);
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
// Auto-post one hour before registration in a specific channel
const PRE_REG_ANNOUNCE_CHANNEL_ID = String(CLAIMING_CONFIG.channels.announceNormal);
const PRE_REG_RELOAD_ANNOUNCE_CHANNEL_ID = String(CLAIMING_CONFIG.channels.announceReload);
const PRE_REG_ANNOUNCE_SOURCE_CHANNEL_IDS = new Set([
  PRE_REG_ANNOUNCE_CHANNEL_ID,
  PRE_REG_RELOAD_ANNOUNCE_CHANNEL_ID,
]);
const PRE_REG_STAFF_CLAIM_CHANNEL_ID = String(CLAIMING_CONFIG.channels.claimStaff);
const PRE_REG_HEAD_STAFF_CLAIM_CHANNEL_ID = String(CLAIMING_CONFIG.channels.claimHead);
const PRE_REG_CLAIM_CHANNEL_ID = PRE_REG_HEAD_STAFF_CLAIM_CHANNEL_ID;
const PRE_REG_STAFF_ROLE_ID = String(CLAIMING_CONFIG.roles.staff);
const PRE_REG_HEAD_STAFF_ROLE_ID = String(CLAIMING_CONFIG.roles.head);
const PRE_REG_CLAIM_ROLE_ID = PRE_REG_HEAD_STAFF_ROLE_ID;
const PRE_REG_CLAIM_TARGETS = [
  { channelId: PRE_REG_STAFF_CLAIM_CHANNEL_ID, roleId: PRE_REG_STAFF_ROLE_ID, maxClaimsPerUser: Number(CLAIMING_CONFIG.limits.staffMaxClaims), key: 'staff' },
  { channelId: PRE_REG_HEAD_STAFF_CLAIM_CHANNEL_ID, roleId: PRE_REG_HEAD_STAFF_ROLE_ID, maxClaimsPerUser: Number(CLAIMING_CONFIG.limits.headMaxClaims), key: 'head' },
];
const PRE_REG_HEAD_STAFF_IMMEDIATE = CLAIMING_CONFIG.behavior.headImmediate === true;
const PRE_REG_ANNOUNCE_LEAD_MS = Number(CLAIMING_CONFIG.timing.preRegLeadMs);
const PRE_REG_LATE_CATCHUP_MAX_MS = Number(CLAIMING_CONFIG.timing.catchupMs);
const PRE_REG_JOBS_PATH = path.join(DATA_DIR, 'pre_reg_staff_jobs.json');
const PRE_REG_PANEL_STATES_PATH = path.join(DATA_DIR, 'claim_panel_states.json');
const preRegAnnouncementTimeouts = new Map();
const preRegStaffPanels = new Map();
let preRegJobsHydrated = false;

function loadPreRegPanelStates() {
  try {
    const rows = loadJson(PRE_REG_PANEL_STATES_PATH, []);
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}

function savePreRegPanelStates(rows) {
  try { saveJson(PRE_REG_PANEL_STATES_PATH, Array.isArray(rows) ? rows : []); } catch (e) {}
}

function sanitizePreRegPanelState(panelId, panelState) {
  const state = panelState && typeof panelState === 'object' ? panelState : {};
  const sessions = Array.isArray(state.sessions)
    ? state.sessions.map(s => ({
      sessionIndex: Number(s && s.sessionIndex ? s.sessionIndex : 1),
      regTs: Number(s && s.regTs ? s.regTs : 0),
      gameTs: Number(s && s.gameTs ? s.gameTs : 0),
      supervisorId: String(s && s.supervisorId ? s.supervisorId : ''),
    }))
    : [];

  return {
    panelId: String(panelId || ''),
    panelType: String(state.panelType || 'head-supervisor'),
    sessionIndex: Number(state.sessionIndex || 1),
    regTs: Number(state.regTs || 0),
    gameTs: Number(state.gameTs || 0),
    isReload: !!state.isReload,
    claimRoleId: String(state.claimRoleId || ''),
    maxClaimsPerUser: Math.max(1, Number(state.maxClaimsPerUser || 1)),
    supervisorId: String(state.supervisorId || ''),
    claims: Array.isArray(state.claims) ? state.claims.map(x => String(x)) : [],
    sessions,
    updatedAt: Date.now(),
  };
}

function upsertPreRegPanelState(panelId, panelState) {
  try {
    const id = String(panelId || '');
    if (!id || id.startsWith('pending:')) return;
    const clean = sanitizePreRegPanelState(id, panelState);
    const all = loadPreRegPanelStates();
    const idx = all.findIndex(x => String(x && x.panelId ? x.panelId : '') === id);
    if (idx >= 0) all[idx] = clean;
    else all.push(clean);
    savePreRegPanelStates(all);
  } catch (e) {}
}

function initPreRegPanelStates() {
  try {
    const rows = loadPreRegPanelStates();
    const keep = [];
    for (const row of rows) {
      const panelId = String(row && row.panelId ? row.panelId : '');
      if (!panelId) continue;
      const clean = sanitizePreRegPanelState(panelId, row);
      preRegStaffPanels.set(panelId, clean);
      keep.push(clean);
    }
    savePreRegPanelStates(keep);
  } catch (e) {
    console.error('initPreRegPanelStates failed', e);
  }
}

function buildPreRegPanelEmbed(panelState) {
  const panelType = String(panelState.panelType || 'head-supervisor');
  if (panelType === 'staff-lobby') {
    const claims = Array.isArray(panelState.claims) ? panelState.claims : [];
    const sessionNo = Number(panelState.sessionIndex || 1);
    const regTs = Number(panelState.regTs || 0);
    const gameTs = Number(panelState.gameTs || 0);
    const isReload = !!panelState.isReload;
    const embed = new EmbedBuilder()
      .setColor(0x87CEFA)
      .setTitle(isReload ? `Reload Session ${sessionNo} Staff Panel` : `Duos Session ${sessionNo} Staff Panel`)
      .setDescription(`**Registration:** <t:${regTs}:t>\n**First Game:** <t:${gameTs}:t>`)
      .setFooter({ text: `Session ID: auto_${sessionNo}_${regTs}` });

    const fields = [];
    if (!claims.length) {
      fields.push({ name: 'Lobby 1', value: '—', inline: true });
      fields.push({ name: '\u200B', value: '\u200B', inline: true });
      fields.push({ name: '\u200B', value: '\u200B', inline: true });
    } else {
      const shown = claims.slice(0, 24);
      for (let i = 0; i < shown.length; i += 2) {
        fields.push({ name: `Lobby ${i + 1}`, value: `<@${shown[i]}>`, inline: true });
        if (shown[i + 1]) fields.push({ name: `Lobby ${i + 2}`, value: `<@${shown[i + 1]}>`, inline: true });
        else fields.push({ name: '\u200B', value: '\u200B', inline: true });
        fields.push({ name: '\u200B', value: '\u200B', inline: true });
      }
    }
    embed.addFields(fields);
    return embed;
  }

  const isReload = !!panelState.isReload;
  const sessions = Array.isArray(panelState.sessions) && panelState.sessions.length
    ? panelState.sessions.slice().sort((a, b) => Number(a.sessionIndex || 0) - Number(b.sessionIndex || 0))
    : [{
      sessionIndex: Number(panelState.sessionIndex || 1),
      regTs: Number(panelState.regTs || 0),
      gameTs: Number(panelState.gameTs || 0),
      supervisorId: String(panelState.supervisorId || ((Array.isArray(panelState.claims) && panelState.claims[0]) ? panelState.claims[0] : '') || ''),
    }];

  const lines = [];
  for (const s of sessions) {
    const sup = String(s.supervisorId || '');
    lines.push(`**${isReload ? 'Reload Session' : 'Session'} ${s.sessionIndex}**`);
    lines.push(`> Time: <t:${Number(s.regTs || 0)}:t>`);
    lines.push(`> Supervisor: ${sup ? `<@${sup}>` : '—'}`);
    lines.push('');
  }

  const embed = new EmbedBuilder()
    .setColor(0x8A2BE2)
    .setTitle(isReload ? 'Supervisor Panel - Reload Duos' : 'Supervisor Panel - Duos')
    .setDescription(lines.join('\n').trim())
    .setFooter({ text: `Session ID: auto_${sessions.map(s => `${s.sessionIndex}_${s.regTs}`).join('__')}` });
  return embed;
}

function buildPreRegPanelRow(messageId) {
  const state = preRegStaffPanels.get(String(messageId));
  if (state && String(state.panelType || '') === 'staff-lobby') {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`staffpanel_lobby_claim:${messageId}`).setLabel('🖐 Claim Lobby').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`staffpanel_lobby_unclaim:${messageId}`).setLabel('Unclaim').setStyle(ButtonStyle.Danger)
    )];
  }

  const sessions = state && Array.isArray(state.sessions) && state.sessions.length
    ? state.sessions.slice().sort((a, b) => Number(a.sessionIndex || 0) - Number(b.sessionIndex || 0))
    : [{
      sessionIndex: Number(state && state.sessionIndex ? state.sessionIndex : 1),
      supervisorId: String((state && (state.supervisorId || (Array.isArray(state.claims) ? state.claims[0] : null))) || ''),
    }];

  const rows = [];
  const buttons = sessions.slice(0, 10).map((s) => {
    const sessionNo = Number(s && s.sessionIndex ? s.sessionIndex : 1);
    const hasSupervisor = !!String(s && s.supervisorId ? s.supervisorId : '');
    return new ButtonBuilder()
      .setCustomId(`staffpanel_toggle:${messageId}:${sessionNo}`)
      .setLabel(`S${sessionNo} ${hasSupervisor ? 'Unclaim' : 'Claim'}`)
      .setStyle(ButtonStyle.Success);
  });

  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
  }
  return rows;
}

function loadPreRegJobs() {
  try {
    const rows = loadJson(PRE_REG_JOBS_PATH, []);
    return Array.isArray(rows) ? rows : [];
  } catch (e) { return []; }
}

function savePreRegJobs(rows) {
  try { saveJson(PRE_REG_JOBS_PATH, Array.isArray(rows) ? rows : []); } catch (e) {}
}

function upsertPreRegJob(job) {
  try {
    const key = String(job && job.timerKey ? job.timerKey : '');
    if (!key) return;
    const all = loadPreRegJobs();
    const idx = all.findIndex(x => String(x && x.timerKey ? x.timerKey : '') === key);
    if (idx >= 0) all[idx] = job;
    else all.push(job);
    savePreRegJobs(all);
  } catch (e) {}
}

function removePreRegJob(timerKey) {
  try {
    const key = String(timerKey || '');
    if (!key) return;
    const all = loadPreRegJobs();
    savePreRegJobs(all.filter(x => String(x && x.timerKey ? x.timerKey : '') !== key));
  } catch (e) {}
}

function removePreRegJobsByOrigin(originMessageId) {
  try {
    const prefix = `${String(originMessageId)}:`;
    const all = loadPreRegJobs();
    savePreRegJobs(all.filter(x => !String(x && x.timerKey ? x.timerKey : '').startsWith(prefix)));
  } catch (e) {}
}

async function postPreRegStaffPanel(job) {
  const sessionsFromJob = Array.isArray(job.sessions) ? job.sessions : null;
  const jobTargetKey = String(job && job.targetKey ? job.targetKey : '');
  const uniqueTargets = Array.from(new Map(PRE_REG_CLAIM_TARGETS.map(t => [String(t.channelId), t])).values())
    .filter(t => !jobTargetKey || String(t.key || '') === jobTargetKey);
  let postedCount = 0;

  for (const target of uniqueTargets) {
    const targetChannelId = String(target.channelId || '');
    const ch = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId).catch((e) => {
      console.warn('[pre-reg] failed to fetch target channel', { targetChannelId, error: String(e && (e.message || e)) });
      return null;
    });
    if (!ch) {
      console.warn('[pre-reg] target channel not found', { targetChannelId });
      continue;
    }
    if (typeof ch.isTextBased === 'function' && !ch.isTextBased()) {
      console.warn('[pre-reg] target channel is not text-based', { targetChannelId, type: String(ch.type) });
      continue;
    }
    if (typeof ch.send !== 'function') {
      console.warn('[pre-reg] target channel has no send()', { targetChannelId, type: String(ch.type) });
      continue;
    }

    const sessionsList = sessionsFromJob && sessionsFromJob.length
      ? sessionsFromJob.map(s => ({
        sessionIndex: Number(s && s.sessionIndex ? s.sessionIndex : 1),
        regTs: Number(s && s.regTs ? s.regTs : 0),
        gameTs: Number(s && s.gameTs ? s.gameTs : 0),
      }))
      : [{
        sessionIndex: Number(job.sessionIndex || 1),
        regTs: Number(job.regTs || 0),
        gameTs: Number(job.gameTs || 0),
      }];

    const panelStates = (String(target.key || '') === 'staff')
      ? sessionsList.map(s => ({
        panelType: 'staff-lobby',
        sessionIndex: Number(s.sessionIndex || 1),
        regTs: Number(s.regTs || 0),
        gameTs: Number(s.gameTs || 0),
        isReload: !!job.isReload,
        claimRoleId: String(target.roleId || ''),
        maxClaimsPerUser: Number(target.maxClaimsPerUser || 1),
        claims: [],
      }))
      : [{
        panelType: 'head-supervisor',
        sessionIndex: Number(job.sessionIndex || 1),
        regTs: Number(job.regTs || 0),
        gameTs: Number(job.gameTs || 0),
        isReload: !!job.isReload,
        claimRoleId: String(target.roleId || ''),
        maxClaimsPerUser: Number(target.maxClaimsPerUser || 1),
        supervisorId: null,
        claims: [],
        sessions: sessionsList.map(s => ({
          sessionIndex: Number(s.sessionIndex || 1),
          regTs: Number(s.regTs || 0),
          gameTs: Number(s.gameTs || 0),
          supervisorId: null,
        })),
      }];

    for (const panelState of panelStates) {
      const pendingKey = `pending:${String(target.key || target.channelId)}:${String(panelState.sessionIndex || 'bundle')}`;
      preRegStaffPanels.set(pendingKey, panelState);
      const pendingRows = buildPreRegPanelRow(pendingKey);
      const sent = await ch.send({ embeds: [buildPreRegPanelEmbed(panelState)], components: pendingRows, allowedMentions: { parse: ['users'] } }).catch((e) => {
        console.warn('[pre-reg] failed to send panel message', { targetChannelId, error: String(e && (e.message || e)) });
        return null;
      });
      preRegStaffPanels.delete(pendingKey);
      if (!sent) continue;
      postedCount += 1;

      preRegStaffPanels.set(String(sent.id), panelState);
      upsertPreRegPanelState(String(sent.id), panelState);
      const rows = buildPreRegPanelRow(String(sent.id));
      await sent.edit({ embeds: [buildPreRegPanelEmbed(panelState)], components: rows, allowedMentions: { parse: ['users'] } }).catch((e) => {
        console.warn('[pre-reg] failed to finalize panel message', { targetChannelId, messageId: String(sent.id), error: String(e && (e.message || e)) });
      });
    }

    const pingRoleId = String(target.roleId || '');
    if (pingRoleId) {
      const pingMsg = await ch.send({ content: `<@&${pingRoleId}>`, allowedMentions: { roles: [pingRoleId] } }).catch((e) => {
        console.warn('[pre-reg] failed to ping role', { targetChannelId, roleId: pingRoleId, error: String(e && (e.message || e)) });
        return null;
      });
      if (pingMsg) setTimeout(() => { try { pingMsg.delete().catch(() => {}); } catch (e) {} }, 1800);
    }
  }

  if (postedCount === 0) {
    console.error('[pre-reg] panel was not posted to any target channel', {
      targets: uniqueTargets.map(t => String(t.channelId || '')),
      originMessageId: String(job && job.originMessageId ? job.originMessageId : ''),
      timerKey: String(job && job.timerKey ? job.timerKey : ''),
    });
  }
}

function schedulePreRegJob(job, { persist = true } = {}) {
  const timerKey = String(job && job.timerKey ? job.timerKey : '');
  if (!timerKey) return;

  if (preRegAnnouncementTimeouts.has(timerKey)) {
    try { clearTimeout(preRegAnnouncementTimeouts.get(timerKey)); } catch (e) {}
    preRegAnnouncementTimeouts.delete(timerKey);
  }

  if (persist) upsertPreRegJob(job);

  let delay = Math.max(0, Number(job.sendAtMs || Date.now()) - Date.now());
  if (!Number.isFinite(delay)) delay = 0;

  const t = setTimeout(async () => {
    try {
      await postPreRegStaffPanel(job);
    } catch (e) {
      console.error('pre-registration auto announcement failed', e);
    } finally {
      preRegAnnouncementTimeouts.delete(timerKey);
      removePreRegJob(timerKey);
    }
  }, delay);
  preRegAnnouncementTimeouts.set(timerKey, t);
}

function initPreRegScheduler() {
  try {
    if (preRegJobsHydrated) return;
    preRegJobsHydrated = true;

    const now = Date.now();
    const all = loadPreRegJobs();
    const keep = [];
    for (const job of all) {
      if (!job || !job.timerKey) continue;
      let sendAtMs = Number(job.sendAtMs || 0);
      let gameEndMs = 0;
      if (Array.isArray(job.sessions) && job.sessions.length) {
        const maxGameTs = Math.max(...job.sessions.map(s => Number(s && s.gameTs ? s.gameTs : 0)));
        gameEndMs = (maxGameTs * 1000) + PRE_REG_LATE_CATCHUP_MAX_MS;
      } else {
        if (!job.regTs || !job.gameTs) continue;
        gameEndMs = (Number(job.gameTs) * 1000) + PRE_REG_LATE_CATCHUP_MAX_MS;
      }
      if (!Number.isFinite(sendAtMs) || sendAtMs <= 0) continue;
      if (now > gameEndMs) continue;
      if (sendAtMs < now) sendAtMs = now + 1500;
      const fixed = Object.assign({}, job, { sendAtMs });
      keep.push(fixed);
      schedulePreRegJob(fixed, { persist: false });
    }
    savePreRegJobs(keep);
  } catch (e) {
    console.error('initPreRegScheduler failed', e);
  }
}

function clearPreRegAnnouncementsForOrigin(originMessageId) {
  try {
    const prefix = `${String(originMessageId)}:`;
    for (const [k, t] of preRegAnnouncementTimeouts.entries()) {
      if (!String(k).startsWith(prefix)) continue;
      try { clearTimeout(t); } catch (e) {}
      preRegAnnouncementTimeouts.delete(k);
    }
    removePreRegJobsByOrigin(originMessageId);
  } catch (e) {}
}

function resolveAnnouncementModeFromRawAndChannel(raw, channelId) {
  try {
    const cfgAll = loadJson(path.join(DATA_DIR, 'config.json'), {});
    const tracks = (cfgAll && cfgAll.sessionAnnouncements && Array.isArray(cfgAll.sessionAnnouncements.tracks))
      ? cfgAll.sessionAnnouncements.tracks
      : [];
    const found = tracks.find(t => String(t.channelId) === String(channelId));
    if (found && found.id) return String(found.id);
  } catch (e) {}
  const rawLower = String(raw || '').toLowerCase();
  if (/(champ|champion|trio)/.test(rawLower)) return 'champ';
  return /alpha/.test(rawLower) ? 'alpha' : 'beta';
}

function resolveAnnouncementModeForSession(raw, channelId, sessionIndex) {
  const baseMode = resolveAnnouncementModeFromRawAndChannel(raw, channelId);
  if (baseMode !== 'champ') return baseMode;

  try {
    const txt = String(raw || '');
    const normalized = txt
      .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
      .replace(/[*_`~]/g, '');
    const idx = Number(sessionIndex || 0);
    const pickFrom = (line) => {
      const m = String(line || '').match(/\b(duo|trio|solo)\b/i);
      return m ? String(m[1]).toLowerCase() : null;
    };

    if (idx > 0) {
      const re1 = new RegExp(`(?:^|\\n)\\s*${idx}\\s*[.)\\-:]?[^\\n]{0,180}`, 'i');
      const m1 = normalized.match(re1);
      if (m1 && pickFrom(m1[0])) return pickFrom(m1[0]);

      const re2 = new RegExp(`(?:^|\\n)\\s*(?:session|sess)\\s*${idx}\\b[^\\n]{0,180}`, 'i');
      const m2 = normalized.match(re2);
      if (m2 && pickFrom(m2[0])) return pickFrom(m2[0]);

      const re3 = new RegExp(`(?:^|\\n)[^\\n]{0,120}\\b${idx}\\b[^\\n]{0,120}`, 'i');
      const m3 = normalized.match(re3);
      if (m3 && pickFrom(m3[0])) return pickFrom(m3[0]);
    }

    const hasDuo = /\bduo\b/i.test(normalized);
    const hasTrio = /\btrio\b/i.test(normalized);
    const hasSolo = /\bsolo\b/i.test(normalized);
    if (hasTrio && !hasDuo && !hasSolo) return 'trio';
    if (hasSolo && !hasDuo && !hasTrio) return 'solo';
    if (hasDuo && !hasTrio && !hasSolo) return 'duo';
  } catch (e) {}

  return 'duo';
}

function normalizeStaffMentions(staffRaw) {
  try {
    const txt = String(staffRaw || '');
    const tokens = txt.match(/<@!?\d+>|<@&\d+>/g) || [];
    if (tokens.length) return Array.from(new Set(tokens)).join(' ');
    return '@Staff';
  } catch (e) {
    return '@Staff';
  }
}

function isGenericStaffPlaceholder(staffRaw) {
  try {
    const s = String(staffRaw || '').toLowerCase().trim();
    if (!s) return true;
    const compact = s.replace(/[\s_*`~()[\]{}:;,.\-]/g, '');
    if (!compact) return true;
    if (compact === 'staff' || compact === '@staff') return true;
    if (compact === 'unassigned' || compact === 'none' || compact === 'tbd') return true;
    return false;
  } catch (e) {
    return true;
  }
}

function schedulePreRegistrationAnnouncements({ originMessageId, originChannelId, guildId, raw, sessions }) {
  try {
    const sourceChannelId = String(originChannelId || '');
    const isReload = sourceChannelId === PRE_REG_RELOAD_ANNOUNCE_CHANNEL_ID;
    if (!PRE_REG_ANNOUNCE_SOURCE_CHANNEL_IDS.has(sourceChannelId)) return;
    if (!Array.isArray(sessions) || !sessions.length) return;
    clearPreRegAnnouncementsForOrigin(originMessageId);

    const normalized = [];
    for (let idx = 0; idx < sessions.length; idx++) {
      const sess = sessions[idx];
      const regTs = Math.floor(Number(sess && sess.start ? sess.start : 0) / 1000);
      if (!Number.isFinite(regTs) || regTs <= 0) continue;
      const endTs = Math.floor(Number(sess && sess.end ? sess.end : 0) / 1000);
      const gameTs = (Number.isFinite(endTs) && endTs > regTs) ? endTs : (regTs + 10 * 60);
      normalized.push({ sessionIndex: Number(sess && sess.index ? sess.index : (idx + 1)), regTs, gameTs });
    }
    if (!normalized.length) return;

    const nowMs = Date.now();
    const relevant = normalized.filter(s => nowMs <= ((s.gameTs * 1000) + PRE_REG_LATE_CATCHUP_MAX_MS));
    if (!relevant.length) return;

    if (PRE_REG_HEAD_STAFF_IMMEDIATE) {
      const timerKey = `${String(originMessageId)}:head:bundle`;
      const job = {
        timerKey,
        targetKey: 'head',
        originMessageId: String(originMessageId),
        isReload,
        sessions: relevant,
        sendAtMs: Date.now() + 1200,
        createdAt: Date.now(),
      };
      schedulePreRegJob(job, { persist: true });
    }

    // Staff panels: 1 hour before each session registration time
    for (const s of relevant) {
      const sendAt = (s.regTs * 1000) - PRE_REG_ANNOUNCE_LEAD_MS;
      let delay = sendAt - nowMs;
      if (delay <= 0) delay = 1200;

      const timerKey = `${String(originMessageId)}:staff:${s.sessionIndex}`;
      const job = {
        timerKey,
        targetKey: 'staff',
        originMessageId: String(originMessageId),
        isReload,
        sessionIndex: Number(s.sessionIndex || 1),
        regTs: Number(s.regTs || 0),
        gameTs: Number(s.gameTs || 0),
        sendAtMs: Date.now() + delay,
        createdAt: Date.now(),
      };
      schedulePreRegJob(job, { persist: true });
    }
  } catch (e) {
    console.error('schedulePreRegistrationAnnouncements failed', e);
  }
}

function splitDiscordMessage(content, maxLen = 2000) {
  const text = String(content ?? '');
  if (!text) return [''];
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen * 0.5)) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut < Math.floor(maxLen * 0.5)) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length) chunks.push(remaining);
  return chunks.length ? chunks : [''];
}

function isClaimPanelLikeMessage(message, contentText) {
  try {
    const text = String(contentText || '').toLowerCase();
    const titleText = String(message && message.embeds && message.embeds[0] && message.embeds[0].title ? message.embeds[0].title : '').toLowerCase();
    const fromBot = !!(message && message.author && message.author.bot);

    const hasClaimEmbedTitle = fromBot && /session\s*parsed|staff\s*panel|supervisor\s*panel/.test(titleText);
    const hasClaimText = fromBot && /press\s+the\s+button\s+to\s+claim\/unclaim|claim\s+lobby/.test(text);

    let hasClaimButtons = false;
    const rows = Array.isArray(message && message.components) ? message.components : [];
    for (const row of rows) {
      const comps = Array.isArray(row && row.components) ? row.components : [];
      for (const comp of comps) {
        const customId = String(comp && comp.customId ? comp.customId : '').toLowerCase();
        if (customId.startsWith('staffpanel_') || customId.startsWith('duo_claim_') || customId.startsWith('session_claim:')) {
          hasClaimButtons = true;
          break;
        }
      }
      if (hasClaimButtons) break;
    }

    return hasClaimButtons || hasClaimEmbedTitle || hasClaimText;
  } catch (e) {
    return false;
  }
}

async function sendChunkedDM(user, content, maxLen = 2000) {
  const parts = splitDiscordMessage(content, maxLen);
  for (const part of parts) {
    if (!part) continue;
    await user.send({ content: part });
  }
}

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
  const sessionModeByIndex = new Map();

  try {
    for (const rawLine of lines) {
      const line = String(rawLine || '')
        .replace(/^[>\s\|│\u2502]+/, '')
        .replace(/[*_`~]/g, '')
        .trim();
      if (!line) continue;

      const m1 = line.match(/^session\s*(\d+)\s*[:\-–—]?\s*(duo|trio|solo)\b/i);
      if (m1) {
        sessionModeByIndex.set(Number(m1[1]), String(m1[2]).toLowerCase());
        continue;
      }

      const m2 = line.match(/^(\d+)\s*[.)\-:]\s*(duo|trio|solo)\b/i);
      if (m2) {
        sessionModeByIndex.set(Number(m2[1]), String(m2[2]).toLowerCase());
      }
    }
  } catch (e) { /* ignore mode hint parse failures */ }

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
          const smt = nextClean.match(/^(?:(?:session\s*)?staff in charge:|(?:session\s*)?staff[:\s\-–]*)\s*([\s\S]+)/i);
          if (smt) staff = (smt[1] || '').trim();
        }
        lineFound.push({ idx, start: sd.getTime(), end: ed.getTime(), staff: normalizeStaffText(staff), mode: Number.isFinite(idx) ? (sessionModeByIndex.get(Number(idx)) || '') : '' });
      }
    }
    if (lineFound.length) {
      // If any indexes present, sort by index, otherwise preserve order
      const hasIndex = lineFound.some(x=>Number.isFinite(x.idx));
      let out;
      if (hasIndex) out = lineFound.slice().sort((a,b) => (a.idx||0)-(b.idx||0));
      else out = lineFound.slice();
      for (const s of out) {
        const outIndex = s.idx || (sessions.length + 1);
        sessions.push({ index: outIndex, start: s.start, end: s.end, staff: s.staff, mode: s.mode || sessionModeByIndex.get(Number(outIndex)) || '' });
      }
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
    s = s.replace(/^(?:(?:session\s*)?staff in charge:\s*|(?:session\s*)?staff[:\s]*)/i, '');
    // Strip channel mentions/names that may leak into parsed staff lines
    s = s.replace(/<#\d+>/g, '').trim();
    // If this is the footer line ("ping me to claim"), treat as not-a-staff assignment
    if (/\bping\s+me\s+to\s+claim\b/i.test(s) || /\bclaim\s+in\b/i.test(s)) return '';
    // remove discord channel/message links that sometimes leak into staff text
    s = s.replace(/https?:\/\/discord\.com\/channels\/\d+\/\d+\/\d+/gi, '').trim();
    s = s.replace(/https?:\/\/discord\.com\/channels\/\d+\/\d+/gi, '').trim();
    // collapse multiple spaces
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  // Format support:
  // Session 1
  // Registration: 15:30
  // First Game: 15:40
  // (with optional bullets/markup)
  try {
    const sessionBlocks = [];
    let current = null;

    const parseTimeTokenMs = (token) => {
      const t = String(token || '').trim();
      const tsMatch = t.match(/^<t:(\d+):t>$/i);
      if (tsMatch) return Number(tsMatch[1]) * 1000;
      const hhmm = t.match(/^([0-2]?\d):([0-5]\d)$/);
      if (!hhmm) return null;
      const ref = referenceDate instanceof Date ? new Date(referenceDate) : new Date();
      const d = new Date(ref);
      d.setHours(Number(hhmm[1]), Number(hhmm[2]), 0, 0);
      return d.getTime();
    };

    for (const rawLine of lines) {
      const line = String(rawLine || '')
        .replace(/^[\s>*•◦\-–—]+/, '')
        .replace(/[*_`~]/g, '')
        .trim();
      if (!line) continue;

      const sessionHeader = line.match(/^session\s*(\d+)/i);
      if (sessionHeader) {
        if (current && current.reg != null && current.game != null) sessionBlocks.push(current);
        current = { index: Number(sessionHeader[1]), reg: null, game: null, staff: '' };
        continue;
      }

      if (!current) continue;

      const regMatch = line.match(/registration\D*(<t:\d+:t>|[0-2]?\d:[0-5]\d)/i);
      if (regMatch) {
        const ms = parseTimeTokenMs(regMatch[1]);
        if (ms != null) current.reg = ms;
        continue;
      }

      const gameMatch = line.match(/first\s*game\D*(<t:\d+:t>|[0-2]?\d:[0-5]\d)/i);
      if (gameMatch) {
        const ms = parseTimeTokenMs(gameMatch[1]);
        if (ms != null) current.game = ms;
        continue;
      }
    }
    if (current && current.reg != null && current.game != null) sessionBlocks.push(current);

    if (sessionBlocks.length) {
      for (const b of sessionBlocks) {
        let reg = Number(b.reg);
        let game = Number(b.game);
        if (game <= reg) game += 24 * 60 * 60 * 1000;
        sessions.push({ index: Number(b.index), start: reg, end: game, staff: normalizeStaffText(b.staff || '') });
      }
    }
  } catch (e) { /* ignore block parse failures */ }

  // Announcement-style messages and the new markdown templates (blockquote + bold), e.g.:
  // > * **Registration Opens:** <Time>
  // > * **Game 1/3:** <Time>
  if (/registration opens|game\s*1\/[0-9]+|duo practice session|trio practice session|champ/i.test(cleaned2)) {
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
          if (/^(?:session\s*)?staff/i.test(nextClean)) {
            staff = nextClean.replace(/^(?:session\s*)?staff(?:\s+in\s+charge)?[:\s\*]*/i, '').trim();
          }
        }
      }
        sessions.push({ index: idx, start: startTs, end: endTs, staff: normalizeStaffText(staff), mode: sessionModeByIndex.get(Number(idx)) || '' });
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
          if (/^(?:session\s*)?staff/i.test(nextClean)) {
            staff = nextClean.replace(/^(?:session\s*)?staff(?:\s+in\s+charge)?[:\s]*/i, '').trim();
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
      sessions.push({ index: idx, start: startDt.getTime(), end: endDt.getTime(), staff: normalizeStaffText(staff), mode: sessionModeByIndex.get(Number(idx)) || '' });
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
            if (/^(?:session\s*)?staff/i.test(nextClean)) {
              staff = nextClean.replace(/^(?:session\s*)?staff(?:\s+in\s+charge)?[:\s\*]*/i, '').trim();
            }
          }
        }
        sessions.push({ index: idx, start: startTs, end: endTs, staff: normalizeStaffText(staff), mode: sessionModeByIndex.get(Number(idx)) || '' });
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
            // Require a label like "Staff:" (avoid matching words like "#staff-chat")
            const staffMatch = after.match(/\b(?:staff|leitung|team)\b\s*[:\-–]\s*([^\n\r]{1,120})/i);
            if (staffMatch) staff = staffMatch[1] ? staffMatch[1].trim() : staffMatch[0];
          } catch (e) {}
          if (startTs && endTs) sessions.push({ index: idxFound, start: startTs, end: endTs, staff: normalizeStaffText(staff), mode: sessionModeByIndex.get(Number(idxFound)) || '' });
        }
      }
    } catch (e) {
      // ignore fallback errors
    }
  }
  // Order + normalize across midnight.
  // For numbered session lists we want to preserve the original 1..N order,
  // and if times go "backwards" (e.g. 22:45 then 00:45) treat the later ones as next-day.
  const hasIndex = sessions.some(s => Number.isFinite(Number(s && s.index)));
  let ordered;
  if (hasIndex) {
    ordered = sessions.slice().sort((a, b) => {
      const ia = Number.isFinite(Number(a && a.index)) ? Number(a.index) : 9999;
      const ib = Number.isFinite(Number(b && b.index)) ? Number(b.index) : 9999;
      if (ia !== ib) return ia - ib;
      const sa = typeof a.start === 'number' ? a.start : 0;
      const sb = typeof b.start === 'number' ? b.start : 0;
      return sa - sb;
    });

    const DAY = 24 * 60 * 60 * 1000;
    let dayOffset = 0;
    let prevStart = null;
    ordered = ordered.map((s) => {
      if (!s || typeof s.start !== 'number' || typeof s.end !== 'number') return s;
      let start = s.start + dayOffset;
      let end = s.end + dayOffset;
      // If the next slot would be earlier than the previous, roll it to the next day.
      if (typeof prevStart === 'number' && (start + 60_000) < prevStart) {
        dayOffset += DAY;
        start += DAY;
        end += DAY;
      }
      prevStart = start;
      return Object.assign({}, s, { start, end });
    });
  } else {
    // No reliable numbering: sort by time.
    ordered = sessions.slice().sort((a, b) => {
      const sa = typeof a.start === 'number' ? a.start : 0;
      const sb = typeof b.start === 'number' ? b.start : 0;
      if (sa !== sb) return sa - sb;
      return (a.index || 0) - (b.index || 0);
    });
  }

  // Dedupe identical time slots (preserve first occurrence in the chosen order)
  const seen = new Set();
  const keyToPos = new Map();
  const deduped = [];
  for (const s of ordered) {
    const key = `${s && s.start ? s.start : 0}-${s && s.end ? s.end : 0}`;
    if (!seen.has(key)) {
      seen.add(key);
      keyToPos.set(key, deduped.length);
      deduped.push(s);
      continue;
    }
    // If we already have the slot but the existing one has no staff,
    // prefer the duplicate that includes staff info.
    const pos = keyToPos.get(key);
    if (typeof pos === 'number' && deduped[pos]) {
      const existingStaff = String(deduped[pos].staff || '').trim();
      const incomingStaff = String(s && s.staff ? s.staff : '').trim();
      if (!existingStaff && incomingStaff) {
        deduped[pos] = { ...deduped[pos], staff: s.staff };
      }
      const existingMode = String(deduped[pos].mode || '').trim();
      const incomingMode = String(s && s.mode ? s.mode : '').trim();
      if (!existingMode && incomingMode) {
        deduped[pos] = { ...deduped[pos], mode: incomingMode };
      }
    }
  }

  for (let i = 0; i < deduped.length; i++) {
    const idx = Number(deduped[i] && deduped[i].index ? deduped[i].index : i + 1);
    if (!deduped[i].mode && sessionModeByIndex.has(idx)) {
      deduped[i] = { ...deduped[i], mode: sessionModeByIndex.get(idx) };
    }
  }

  const needsReindex = deduped.some((s, i) => Number(s && s.index) !== i + 1);
  if (needsReindex) return deduped.map((s, i) => ({ ...s, index: i + 1 }));
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
const ROLE_COMMAND_SERVER_ID = '1236461630372450384';
const MODLOGS_SERVER_ONLY_ID = '1236461630372450384';
const EXTRA_BLACKLIST_TARGET_GUILD_ID = '1236461630372450384';
const ROLE_COMMAND_ALL_CMDS_ROLE_IDS = new Set([
  '1461922573095801000',
  '1462081326424391915',
  '1461896534772945092',
]);
const ROLE_COMMAND_DICE_ONLY_ROLE_ID = '1466119165227171951';
const ROLE_COMMAND_DICE_ALIASES = new Set(['dice', 'roll']);
const MOD_CMD_PERMS_PATH = path.join(DATA_DIR, 'mod_command_perms.json');

function loadModCommandPerms() {
  try {
    const all = loadJson(MOD_CMD_PERMS_PATH, {});
    if (!all || typeof all !== 'object') return { guilds: {} };
    if (!all.guilds || typeof all.guilds !== 'object') all.guilds = {};
    return all;
  } catch (e) {
    return { guilds: {} };
  }
}

function saveModCommandPerms(all) {
  try { saveJson(MOD_CMD_PERMS_PATH, all || { guilds: {} }); } catch (e) {}
}

function getGuildModCommandPerms(guildId) {
  try {
    const all = loadModCommandPerms();
    const gid = String(guildId || '');
    const g = (all.guilds && all.guilds[gid] && typeof all.guilds[gid] === 'object') ? all.guilds[gid] : {};
    const allowedRoleIds = Array.isArray(g.allowedRoleIds) ? g.allowedRoleIds.map(String) : [];
    const deniedRoleIds = Array.isArray(g.deniedRoleIds) ? g.deniedRoleIds.map(String) : [];
    return { allowedRoleIds, deniedRoleIds };
  } catch (e) {
    return { allowedRoleIds: [], deniedRoleIds: [] };
  }
}

function getRoleCommandAccess(message, commandName) {
  try {
    if (!message || !message.guild || !message.member) return { allowed: true };

    // Global gate: only Staff / Head Staff / Admin role (or Administrator permission)
    if (!hasStaffCommandAccess(message)) return { allowed: false };

    const roles = message.member.roles && message.member.roles.cache;
    if (!roles) return { allowed: true };

    const guildCfg = getGuildModCommandPerms(message.guild.id);
    const hasCustomRules = (guildCfg.allowedRoleIds && guildCfg.allowedRoleIds.length) || (guildCfg.deniedRoleIds && guildCfg.deniedRoleIds.length);

    // Allow admin-level access regardless of role setup
    try {
      const perms = message.member.permissions;
      if (perms?.has?.(PermissionsBitField.Flags.Administrator)) return { allowed: true };
    } catch (e) {}

    if (hasCustomRules) {
      const denied = new Set((guildCfg.deniedRoleIds || []).map(String));
      const allowed = new Set((guildCfg.allowedRoleIds || []).map(String));

      if (denied.size) {
        for (const roleId of denied.values()) {
          if (roles.has(roleId)) return { allowed: false, reason: 'Your role is blocked from moderation commands on this server.' };
        }
      }

      if (allowed.size) {
        for (const roleId of allowed.values()) {
          if (roles.has(roleId)) return { allowed: true };
        }
        return { allowed: false, reason: 'You are missing a required role for moderation commands.' };
      }

      return { allowed: true };
    }

    // Legacy default restriction (only on designated server)
    if (String(message.guild.id) !== ROLE_COMMAND_SERVER_ID) return { allowed: true };

    for (const roleId of ROLE_COMMAND_ALL_CMDS_ROLE_IDS) {
      if (roles.has(roleId)) return { allowed: true };
    }

    if (roles.has(ROLE_COMMAND_DICE_ONLY_ROLE_ID)) {
      const cmd = String(commandName || '').toLowerCase();
      if (ROLE_COMMAND_DICE_ALIASES.has(cmd)) return { allowed: true };
      return { allowed: false, reason: 'With your role you can only use `*dice`.' };
    }

    // If user has none of the configured command roles on this server:
    // - allow ONLY dice/roll when they have the dice role
    // - otherwise deny
    {
      const cmd = String(commandName || '').toLowerCase();
      if (ROLE_COMMAND_DICE_ALIASES.has(cmd)) {
        return { allowed: false, reason: `You need the role <@&${ROLE_COMMAND_DICE_ONLY_ROLE_ID}> for \`*dice\`.` };
      }
      return { allowed: false, reason: 'You are not allowed to use this command.' };
    }
  } catch (e) {
    return { allowed: true };
  }
}

async function enforceRoleCommandAccess(message, commandName) {
  const access = getRoleCommandAccess(message, commandName);
  if (access.allowed) return true;
  return false;
}

const STAFF_COMMAND_ROLE_ID = '1461922573095801000';
const HEAD_STAFF_COMMAND_ROLE_ID = '1462081326424391915';
const ADMIN_COMMAND_ROLE_ID = '1461896534772945092';
const PROTECTED_MODERATION_ROLE_IDS = new Set([
  STAFF_COMMAND_ROLE_ID,
  HEAD_STAFF_COMMAND_ROLE_ID,
  ADMIN_COMMAND_ROLE_ID,
]);

function hasAdminCommandAccess(message) {
  try {
    const member = message && message.member;
    if (!member) return false;
    const perms = member.permissions;
    if (perms?.has?.(PermissionsBitField.Flags.Administrator)) return true;
    return !!member.roles?.cache?.has?.(ADMIN_COMMAND_ROLE_ID);
  } catch (e) {
    return false;
  }
}

function hasHeadStaffCommandAccess(message) {
  try {
    const member = message && message.member;
    if (!member) return false;
    if (hasAdminCommandAccess(message)) return true;
    return !!member.roles?.cache?.has?.(HEAD_STAFF_COMMAND_ROLE_ID);
  } catch (e) {
    return false;
  }
}

function hasStaffCommandAccess(message) {
  try {
    const member = message && message.member;
    if (!member) return false;
    if (hasHeadStaffCommandAccess(message)) return true;
    return !!member.roles?.cache?.has?.(STAFF_COMMAND_ROLE_ID);
  } catch (e) {
    return false;
  }
}

function memberHasProtectedModerationRole(member) {
  try {
    if (!member || !member.roles || !member.roles.cache) return false;
    for (const roleId of PROTECTED_MODERATION_ROLE_IDS.values()) {
      if (member.roles.cache.has(roleId)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function userHasProtectedModerationRoleInGuilds(userId, guildIds) {
  try {
    const uid = String(userId || '').trim();
    if (!uid || !/^\d+$/.test(uid)) return false;
    const ids = Array.from(new Set((Array.isArray(guildIds) ? guildIds : []).map(x => String(x || '')).filter(Boolean)));
    for (const gid of ids) {
      try {
        const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
        if (!guild) continue;
        const member = await guild.members.fetch(uid).catch(() => null);
        if (member && memberHasProtectedModerationRole(member)) return true;
      } catch (e) {}
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function replyCannotModerateUser(message, userOrId) {
  try {
    let userId = null;
    let username = null;
    if (userOrId && typeof userOrId === 'object') {
      userId = userOrId.id ? String(userOrId.id) : null;
      username = userOrId.username || userOrId.tag || (userOrId.user && (userOrId.user.username || userOrId.user.tag)) || null;
    } else if (userOrId) {
      userId = String(userOrId);
    }
    if (!username && userId && /^\d+$/.test(userId)) {
      const fetched = await client.users.fetch(userId).catch(() => null);
      if (fetched) username = fetched.username;
    }
    const targetLabel = username && userId ? `${username} (${userId})` : (userId || 'unknown');
    return replyAsEmbed(message, `You cannot moderate user ${targetLabel}.`);
  } catch (e) {
    return replyAsEmbed(message, 'You cannot moderate this user.');
  }
}

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

// Anti-spam: if a user sends >5 messages in a row in the same channel, delete them and timeout for 1 minute.
const SPAM_STREAK_LIMIT = 5; // "more than 5" => 6 triggers
const SPAM_STREAK_RESET_MS = 15_000;
const SPAM_TIMEOUT_MS = 60_000;
const spamStreakByChannel = new Map(); // key guildId:channelId -> { lastAuthorId, lastTs, ids: [] }

client.on('messageCreate', async (message) => {
  try {
    if (!message || !message.guild || message.author?.bot) return;
    if (!message.channelId) return;
    if (!message.member) return;

    // Exempt staff/mods
    try {
      if (message.member.permissions?.has?.(PermissionsBitField.Flags.ManageMessages)) return;
      if (message.member.permissions?.has?.(PermissionsBitField.Flags.ManageGuild)) return;
      if (message.member.permissions?.has?.(PermissionsBitField.Flags.ModerateMembers)) return;
    } catch (e) {}

    const now = Date.now();
    const key = `${message.guild.id}:${message.channelId}`;
    const st = spamStreakByChannel.get(key) || { lastAuthorId: null, lastTs: 0, ids: [] };

    const sameAuthor = (st.lastAuthorId && String(st.lastAuthorId) === String(message.author.id));
    const withinWindow = st.lastTs && ((now - st.lastTs) <= SPAM_STREAK_RESET_MS);

    if (!sameAuthor || !withinWindow) {
      st.lastAuthorId = message.author.id;
      st.ids = [];
    }

    st.lastAuthorId = message.author.id;
    st.lastTs = now;
    st.ids.push(String(message.id));
    if (st.ids.length > 20) st.ids = st.ids.slice(-20);

    spamStreakByChannel.set(key, st);

    if (st.ids.length <= (SPAM_STREAK_LIMIT + 1)) {
      // still below trigger (or exactly 6 will trigger below)
    }

    if (st.ids.length > SPAM_STREAK_LIMIT) {
      // Trigger: delete the whole streak we tracked
      const idsToDelete = Array.from(new Set(st.ids));

      // best-effort delete
      try {
        if (typeof message.channel?.bulkDelete === 'function') {
          await message.channel.bulkDelete(idsToDelete, true).catch(() => null);
        } else {
          for (const mid of idsToDelete) {
            try {
              const m = await message.channel.messages.fetch(mid).catch(() => null);
              if (m) await m.delete().catch(() => {});
            } catch (e) {}
          }
        }
      } catch (e) {}

      // timeout 1 minute
      let timedOut = false;
      try {
        const mm = await message.guild.members.fetch(message.author.id).catch(() => null);
        if (mm && typeof mm.timeout === 'function') {
          await mm.timeout(SPAM_TIMEOUT_MS, `AutoMod: Spam (${idsToDelete.length} messages in a row)`);
          timedOut = true;
          try { markRecentModAction(message.guild.id, 'Mute', message.author.id, '*'); } catch (e) {}
        }
      } catch (e) {}

      // Unified modlog + actions.md
      try {
        if (timedOut) {
          const caseId = createModlogCase({
            guild: message.guild,
            type: 'AutoMute',
            userId: message.author.id,
            moderatorId: 'AutoMod',
            reason: `Spam: ${idsToDelete.length} messages in a row`,
            durationMs: SPAM_TIMEOUT_MS,
            extra: { channelId: String(message.channelId) }
          });

          const embed = buildSmallModerationEmbed({
            title: 'User muted (Spam)',
            targetId: message.author.id,
            targetAvatarUrl: message.author.displayAvatarURL ? message.author.displayAvatarURL({ extension: 'png', size: 256 }) : null,
            moderatorId: 'AutoMod',
            reason: `Spam: ${idsToDelete.length} messages in a row`,
            caseId,
            durationText: '1 minute',
            nowTs: Math.floor(now / 1000)
          });
          await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
        }
      } catch (e) {}

      // reset state for this channel
      spamStreakByChannel.set(key, { lastAuthorId: null, lastTs: 0, ids: [] });
    }
  } catch (e) {
    console.error('anti-spam handler failed', e);
  }
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

// Central Automod: run early to remove racist/blocked content, attempt mute, always log
client.on('messageCreate', async (message) => {
  try {
    if (!message || !message.guild || message.author?.bot) return;
    if (isAutomodDisabledForGuild(message.guild.id)) return;

    const AUTOMOD_LOG_CHANNEL_ID = '1466065677986299966';
    const text = String(message.content || '');
    console.log(`[automod] message from ${message.author.tag} (${message.author.id}) in guild ${message.guild.id} ch ${message.channel.id}: ${text.substring(0,200)}`);
    if (!text.trim()) return;

    // Fetch member info (we will enforce automod for all non-bot users)
    const member = await message.guild.members.fetch(message.author.id).catch(()=>null);

    // Invite-link automod is intentionally disabled: do not delete/timeout just for links.
    const hasInvite = false;

    // Detect racist/blocked terms (configurable via AUTOMOD_CONFIG.blockedWords)
    const blocked = (AUTOMOD_CONFIG && Array.isArray(AUTOMOD_CONFIG.blockedWords))
      ? AUTOMOD_CONFIG.blockedWords
      : DEFAULT_AUTOMOD_BLOCKED_WORDS;
    const matchedWords = automodFindBlockedMatches(text, blocked);
    const hasRacist = matchedWords.length > 0;

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
    if (hasInvite) reasonParts.push('Invite link');
    if (hasRacist) reasonParts.push(`Racist content${matchedWords.length ? ` (${matchedWords.length})` : ''}`);

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
          try { markRecentModAction(message.guild?.id, 'Mute', message.author.id, '*'); } catch (e) {}
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
        .setTitle('Automod — Message removed')
        .setColor(0xE74C3C)
        .addFields(
          {
            name: 'Meta',
            value: `User: ${message.author.tag} (<@${message.author.id}>)\nChannel: ${message.guild ? `${message.guild.name} / #${message.channel.name}` : message.channel.id}\nReason: ${reasonParts.length ? reasonParts.join(' + ') : 'Unknown'}\nMatched: ${matchedWords.length ? matchedWords.slice(0, 8).map(automodMaskWord).join(', ') : '—'}`,
            inline: false
          },
          { name: 'Content', value: text.substring(0, 1900) || '(empty)', inline: false }
        )
        .setTimestamp();

      console.log('[automod] detected; deleted:', deleted, 'muted:', muted, 'will log to', logCh ? `${logCh.guild ? logCh.guild.id : 'unknown'}/${logCh.id}` : 'none');
      // add deletion status and timeout info to embed
      try {
        embed.addFields({ name: 'Action', value: `Deleted: ${deleted ? 'Yes' : 'No (missing permission)'}\nTimeout: ${muted ? `Yes — ${muteMinutes} minutes` : `No${muteError ? ` — Error: ${muteError}` : ' (missing permission)'}`}`, inline: false });
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

        const isAnnouncement = /Duo Practice Session|Trio Practice Session|Registration Opens|Game 1\/[0-9]+|<t:\d+:t>|champ/i.test(text || '');
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

// DM Appeal collector: users answer 4 questions in DM and bot posts a review embed in the appeal channel.
client.on('messageCreate', async (message) => {
  try {
    if (!message || message.author?.bot) return;
    if (message.guild) return;

    const uid = String(message.author.id || '');
    if (!uid) return;

    appealState = loadAppealState();
    const pending = appealState.pending[uid] || null;
    const invite = appealState.invites[uid] || null;
    const text = String(message.content || '').trim();
    if (!pending) {
      if (/^!?(appeal|apell|apeal)$/i.test(text)) {
        await startAppealQuestionnaire(message.author, { actionType: 'Appeal' });
      }
      if (invite && /^(start|begin|yes)$/i.test(text)) {
        // user typed a quick confirm instead of pressing button
        appealState.pending[uid] = {
          step: 0,
          answers: [],
          openedAt: Date.now(),
          expiresAt: Date.now() + APPEAL_WINDOW_MS,
          guildId: invite.guildId || null,
          actionType: invite.actionType || 'Moderation',
          caseId: invite.caseId || null,
        };
        saveAppealState(appealState);
        await message.channel.send({ embeds: [buildAppealQuestionEmbed(invite.actionType || 'Moderation', 0, appealState.pending[uid].expiresAt)] }).catch(() => null);
      }
      return;
    }

    if (!text) return;

    if (Number(pending.expiresAt || 0) > 0 && Date.now() > Number(pending.expiresAt)) {
      delete appealState.pending[uid];
      delete appealState.invites[uid];
      saveAppealState(appealState);
      const expiredEmbed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('Appeal expired')
        .setDescription('Your 10-minute appeal window expired. Type `appeal` to start again.');
      await message.channel.send({ embeds: [expiredEmbed] }).catch(() => null);
      return;
    }

    const questionList = getAppealQuestions(pending.actionType || 'Moderation');
    const step = Math.max(0, Math.min(questionList.length - 1, Number(pending.step) || 0));
    pending.answers[step] = text.substring(0, 1800);
    pending.step = step + 1;

    if (pending.step < questionList.length) {
      appealState.pending[uid] = pending;
      saveAppealState(appealState);
      await message.channel.send({ embeds: [buildAppealQuestionEmbed(pending.actionType || 'Moderation', pending.step, pending.expiresAt)] }).catch(() => null);
      return;
    }

    const submissionId = Number(appealState.nextId) || 1;
    appealState.nextId = submissionId + 1;

    const submission = {
      id: submissionId,
      userId: uid,
      guildId: pending.guildId || null,
      actionType: pending.actionType || 'Moderation',
      caseId: pending.caseId || null,
      answers: Array.isArray(pending.answers) ? pending.answers.slice(0, questionList.length) : [],
      createdAt: Date.now(),
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
    };

    appealState.submissions[String(submissionId)] = submission;
    delete appealState.pending[uid];
    delete appealState.invites[uid];
    saveAppealState(appealState);

    const reviewChannel = await client.channels.fetch(String(APPEAL_REVIEW_CHANNEL_ID)).catch(() => null);
    if (reviewChannel && typeof reviewChannel.send === 'function') {
      const t = Math.floor(Date.now() / 1000);
      const avatarUrl = message.author.displayAvatarURL ? message.author.displayAvatarURL({ extension: 'png', size: 256 }) : null;
      const questionSet = getAppealQuestions(submission.actionType || 'Moderation');
      const penaltyLabel = getAppealPenaltyLabel(submission.actionType || 'Moderation');
      let serverLine = 'Unknown server';
      try {
        const gid = submission.guildId ? String(submission.guildId) : '';
        if (gid) {
          const g = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
          serverLine = g ? `${g.name} (${gid})` : gid;
        }
      } catch (e) {}
      const appealEmbed = new EmbedBuilder()
        .setColor(0x87CEFA)
        .setTitle(`PredCord ${penaltyLabel} Appeal (#${submissionId})`)
        .setDescription(
          `**Server:** ${serverLine}\n<@${uid}>\n**User ID:** ${uid} • <t:${t}:f>`
        )
        .addFields(
          { name: `1. ${questionSet[0]}`, value: (submission.answers[0] || '—').substring(0, 1000), inline: false },
          { name: `2. ${questionSet[1]}`, value: (submission.answers[1] || '—').substring(0, 1000), inline: false },
          { name: `3. ${questionSet[2]}`, value: (submission.answers[2] || '—').substring(0, 1000), inline: false },
          { name: `4. ${questionSet[3]}`, value: (submission.answers[3] || '—').substring(0, 1000), inline: false }
        )
        .setThumbnail(avatarUrl)
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`appeal_approve:${submissionId}:${uid}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`appeal_reject:${submissionId}:${uid}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`appeal_history:${submissionId}:${uid}`).setLabel('View History').setStyle(ButtonStyle.Secondary)
      );

      await reviewChannel.send({ embeds: [appealEmbed], components: [row], allowedMentions: { users: [uid] } }).catch(() => null);
      const submittedEmbed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('Appeal submitted')
        .setDescription('Your appeal was submitted to staff. You will be contacted with the result.');
      await message.channel.send({ embeds: [submittedEmbed] }).catch(() => null);
    } else {
      const failedEmbed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('Appeal submit failed')
        .setDescription('Appeal channel is currently unavailable. Please try again later.');
      await message.channel.send({ embeds: [failedEmbed] }).catch(() => null);
    }
  } catch (e) {
    console.error('appeal DM collector failed', e);
  }
});

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
    // Ignore bot messages (except seeded messages) to avoid accidental parsing from other bots.
    if (isBot && !message._isSeed) {
      if (isSelf) {
        console.log('[session-debug] ignoring self-authored message to avoid duplicate processing');
        return;
      }
      console.log('[session-debug] skipping other bot message');
      return;
    }
    if (!message.channel) return;
    if (!contentText && !message._isSeed) {
      console.log('[session-debug] no text content to parse (no content and no embed text)');
      return;
    }
    if (isClaimPanelLikeMessage(message, contentText)) {
      console.log('[session-debug] skipping claim-panel-like message');
      return;
    }

    // Message create logging removed per user request.

    const originalRawFull = String(contentText || '');

    // Global help triggered by `-help` (legacy/dash help)
    try {
      const txt = String(message.content || '').trim();
      if (txt === '-help' || txt.startsWith('-help ')) {
        if (!(await enforceRoleCommandAccess(message, 'help'))) return;
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
            { name: 'Logs', value: 'All session logs are posted to channel <#1469760090151063754> as light-blue embeds.', inline: false }
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
      if (!(await enforceRoleCommandAccess(message, cmd))) return;
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
          const fakeChannelId = (mode === 'alpha') ? '1469754683760316614' : (mode === 'beta' ? '1469754640777347176' : message.channel.id);
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

      // Wheel pick command: *wheelpick <opt1>|<opt2>|...  OR just *wheelpick to use defaults
      if (cmd === 'wheelpick' || cmd === 'gw') {
        try {
          const userId = message.author.id;
          const now = Date.now();
          const cd = Number(process.env.GLUECKSRAD_COOLDOWN_SECONDS || 30) * 1000;
          const last = wheelCooldowns.get(userId) || 0;
          if (now - last < cd) {
            const wait = Math.ceil((cd - (now - last)) / 1000);
            return message.channel.send({ embeds: [new EmbedBuilder().setColor(0xF39C12).setDescription(`Please wait ${wait}s before spinning again.`)] });
          }

          const rest = message.content.slice((PREFIX + cmd).length).trim();
          const options = rest ? rest.split('|').map(s => s.trim()).filter(Boolean) : null;
          const defaults = ['10 Coins', '50 Coins', '100 Coins', 'Nothing', 'Free Spin', 'Special: Role'];
          const opts = options && options.length >= 2 ? options : defaults;

          // simple textual wheel frames for animation
          const frames = [];
          for (let i = 0; i < 12; i++) {
            const idx = i % opts.length;
            const line = opts.map((o, j) => (j === idx ? `➡️ ${o}` : `• ${o}`)).join('  ');
            frames.push(line);
          }

          const m = await message.channel.send({ embeds: [new EmbedBuilder().setTitle('Wheel — Spinning...').setDescription(frames[0]).setColor(0x00AAFF)] });
          // animate by editing message
          for (let i = 0; i < frames.length; i++) {
            // small delay
            // use increasing delay to simulate slowing
            const delay = 120 + i * 60;
            // eslint-disable-next-line no-await-in-loop
            await new Promise(r => setTimeout(r, delay));
            // eslint-disable-next-line no-await-in-loop
            await m.edit({ embeds: [new EmbedBuilder().setTitle('Wheel — Spinning...').setDescription(frames[i]).setColor(0x00AAFF)] }).catch(()=>{});
          }

          // pick random final
          const chosen = opts[Math.floor(Math.random() * opts.length)];
          await m.edit({ embeds: [new EmbedBuilder().setTitle('Wheel — Result').setDescription(`The wheel landed on **${chosen}**!`).setColor(0x87CEFA)] }).catch(()=>{});
          wheelCooldowns.set(userId, Date.now());

          // optional: react with confetti
          try { await m.react('🎉').catch(()=>{}); } catch (e) {}
          return;
        } catch (e) { console.error('wheelpick failed', e); }
      }

      // --- WheelGame: registration + 3 betting rounds -----------------------------
      if (cmd === 'wheelgame' || cmd === 'wg') {
        const sub = (args.shift() || '').toLowerCase();
        const channelId = message.channel.id;
        const authorId = message.author.id;
        const now = Date.now();

        // Helper to show simple embed
        const sendEmbed = async (title, desc) => {
          return message.channel.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0x00AAFF)] });
        };

        // create/start registration: *wheelgame start <seconds to join> <rounds>
        if (sub === 'start') {
          if (einradGames.has(channelId)) return sendEmbed('WheelGame', 'A game is already running in this channel.');
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
          return sendEmbed('WheelGame — Registration Started', `Registration open for ${joinSec}s. Participants can join with \`*wheelgame join\`.`);
        }

        if (sub === 'join') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('WheelGame', 'No active game. Start one with `*wheelgame start`.');
          if (g.state !== 'joining' && g.state !== 'ready') return sendEmbed('WheelGame', 'Registration is closed.');
          if (g.participants.has(authorId)) return sendEmbed('WheelGame', 'You are already registered.');
          g.participants.set(authorId, { total: 0, bets: [] });
          return sendEmbed('WheelGame', `You are registered. Participants: ${g.participants.size}`);
        }

        if (sub === 'leave') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('WheelGame', 'No active game.');
          if (!g.participants.has(authorId)) return sendEmbed('WheelGame', 'You are not registered.');
          g.participants.delete(authorId);
          return sendEmbed('WheelGame', `You were removed. Participants: ${g.participants.size}`);
        }

        // begin betting: only owner can start
        if (sub === 'begin') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('WheelGame', 'No active game.');
          if (g.owner !== authorId) return sendEmbed('WheelGame', 'Only the game starter can begin.');
          if (g.participants.size < 2) return sendEmbed('WheelGame', 'At least 2 participants are required.');
          if (g.state === 'playing') return sendEmbed('WheelGame', 'The game is already running.');
          g.state = 'playing';
          g.currentRound = 1;
          // notify
          await sendEmbed('WheelGame — Round 1 Started', `Participants: ${Array.from(g.participants.keys()).map(id=>`<@${id}>`).join(', ')}\nPlace your bet now with \`*wheelgame bet <amount>\` (integers only).`);
          return;
        }

        if (sub === 'bet') {
          const amount = parseInt(args.shift(), 10);
          if (isNaN(amount) || amount <= 0) return sendEmbed('WheelGame', 'Please provide a valid coin amount (e.g. `*wheelgame bet 10`).');
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('WheelGame', 'No active game.');
          // If registration just ended (ready), start playing automatically on first bet
          if (g.state === 'ready') {
            if (g.participants.size < 2) return sendEmbed('WheelGame', 'At least 2 participants are required.');
            g.state = 'playing';
            g.currentRound = 1;
            await sendEmbed('WheelGame — Round 1 Started', `Participants: ${Array.from(g.participants.keys()).map(id=>`<@${id}>`).join(', ')}\nPlace your bet now with \`*wheelgame bet <amount>\` (integers only).`);
          }
          if (g.state !== 'playing') return sendEmbed('WheelGame', 'No game currently running.');
          const p = g.participants.get(authorId);
          if (!p) return sendEmbed('WheelGame', 'You are not participating. Join with `*wheelgame join`.');
          // record bet for current round
          p.total = (p.total || 0) + amount;
          p.bets.push({ round: g.currentRound, amount });
          return sendEmbed('WheelGame', `Bet ${amount} coins for round ${g.currentRound}. Total bets: ${p.total}`);
        }

        if (sub === 'next') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('WheelGame', 'No active game.');
          if (g.owner !== authorId) return sendEmbed('WheelGame', 'Only the game starter can move to the next round.');
          if (g.state !== 'playing') return sendEmbed('WheelGame', 'Game is not running.');
          if (g.currentRound >= g.rounds) {
            // finish and announce winner (select by highest total)
            const standings = Array.from(g.participants.entries()).map(([uid, data]) => ({ uid, total: data.total || 0 }));
            standings.sort((a,b)=>b.total - a.total);
            const winner = standings[0];
            const lines = standings.map(s => `<@${s.uid}> — ${s.total} coins`).join('\n');

            // Wheel animation: cycle participant mentions and land on winner
            try {
              const parts = standings.map(s => `<@${s.uid}>`);
              if (parts.length === 0) {
                await sendEmbed('WheelGame — Game Ended', 'No participants.');
                einradGames.delete(channelId);
                return;
              }
              const spinMsg = await message.channel.send({ embeds: [new EmbedBuilder().setTitle('WheelGame — Spin').setDescription('The wheel is spinning...').setColor(0x00AAFF)] });
              const roundsToSpin = 3 + Math.floor(Math.random() * 3);
              const totalSteps = roundsToSpin * parts.length + parts.indexOf(`<@${winner.uid}>`);
              for (let step = 0; step <= totalSteps; step++) {
                const idx = step % parts.length;
                const frame = parts.map((p, j) => (j === idx ? `➡️ ${p}` : `• ${p}`)).join('  ');
                const delay = 80 + Math.floor((step / totalSteps) * 600);
                // eslint-disable-next-line no-await-in-loop
                await new Promise(r => setTimeout(r, delay));
                // eslint-disable-next-line no-await-in-loop
                await spinMsg.edit({ embeds: [new EmbedBuilder().setTitle('WheelGame — Spin').setDescription(frame).setColor(0x00AAFF)] }).catch(()=>{});
              }
              await spinMsg.edit({ embeds: [new EmbedBuilder().setTitle('WheelGame — Game Ended').setDescription(`Result:\n${lines}\n\nWinner: <@${winner.uid}> with ${winner.total} coins!`).setColor(0x87CEFA)] }).catch(()=>{});
            } catch (e) {
              // fallback to text result
              await sendEmbed('WheelGame — Game Ended', `Result:\n${lines}\n\nWinner: <@${winner.uid}> with ${winner.total} coins!`);
            }

            einradGames.delete(channelId);
            return;
          }
          g.currentRound += 1;
          await sendEmbed('WheelGame', `Round ${g.currentRound} started — place your bets now!`);
          return;
        }

        if (sub === 'status') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('WheelGame', 'No active game.');
          const parts = [`Status: ${g.state}`, `Round: ${g.currentRound}/${g.rounds}`, `Participants: ${g.participants.size}`];
          for (const [uid, data] of g.participants.entries()) parts.push(`${'<@'+uid+'> —'} ${data.total || 0} coins`);
          return sendEmbed('WheelGame — Status', parts.join('\n'));
        }

        if (sub === 'cancel') {
          const g = einradGames.get(channelId);
          if (!g) return sendEmbed('WheelGame', 'No active game.');
          if (g.owner !== authorId && !message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return sendEmbed('WheelGame', 'Only the starter or a moderator can cancel.');
          einradGames.delete(channelId);
          return sendEmbed('WheelGame', 'Game was canceled.');
        }

        // help
        return sendEmbed('WheelGame — Help', '`*wheelgame start [joinSec] [rounds]` — start game\n`*wheelgame join` — join\n`*wheelgame bet <amount>` — bet in current round\n`*wheelgame next` — next round (starter)\n`*wheelgame status` — current status\n`*wheelgame cancel` — cancel');
      }
    }

    // Only respond to the configured Alpha/Beta session channels (or likely session channels)
    const WATCH_CHANNEL_IDS = loadWatchChannels(message.guildId);
    const channelIdStr = String(message.channel.id);
    const channelName = String(message.channel?.name || '').toLowerCase();
    const isPreRegSource = PRE_REG_ANNOUNCE_SOURCE_CHANNEL_IDS.has(channelIdStr);
    const isWatched = WATCH_CHANNEL_IDS.has(channelIdStr);
    const looksLikeSession = /\b\d+\.\s*[0-2]?\d:[0-5]\d\s*(?:-|–|to)\s*[0-2]?\d:[0-5]\d\b|registration\s*opens|game\s*1\/3|duo\s*practice\s*session|<t:\d+:t>/i.test(contentText);
    const nameLooksLikeSession = /(alpha|beta|session|sessions|claim|claiming)/i.test(channelName);
    // Debug info about why we might proceed or skip
    try {
      console.log('[session-debug] watch check:', { WATCH_CHANNEL_IDS: Array.from(WATCH_CHANNEL_IDS).slice(0,20), channelIdStr, channelName, isWatched, looksLikeSession, nameLooksLikeSession });
    } catch (e) {}
    if (!isWatched && !isPreRegSource && !(looksLikeSession && nameLooksLikeSession)) {
      console.log('[session-debug] skipping: channel not watched and does not look like session');
      return;
    }

    const sessions = parseSessionMessage(contentText, message.createdAt);
    console.log('[session-debug] parsed sessions count:', Array.isArray(sessions) ? sessions.length : 0);
    if (!sessions || !sessions.length) {
      console.log('[session-debug] no sessions parsed from message content');
      return;
    }

    // Special flow: when sessions are posted in the configured channel,
    // automatically send the announcement 1 hour before registration.
    try {
      schedulePreRegistrationAnnouncements({
        originMessageId: message.id,
        originChannelId: message.channel && message.channel.id,
        guildId: message.guildId || (message.guild && message.guild.id) || null,
        raw: originalRawFull,
        sessions
      });
    } catch (e) {}

    // In announcement source channel we only schedule auto-claim panels.
    // Do not post any in-channel "Session parsed" summaries/buttons there.
    if (PRE_REG_ANNOUNCE_SOURCE_CHANNEL_IDS.has(channelIdStr)) {
      return;
    }

    let summaryHandled = false;

    // Hard guarantee: in the two session-claiming channels, always post a fresh parsed summary with buttons
    try {
      const forceChannels = loadWatchChannels(message.guildId);
      if (message.channel && forceChannels && forceChannels.has(String(message.channel.id))) {
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
    if (interaction.isButton() && typeof interaction.customId === 'string' && interaction.customId.startsWith('appeal_open:')) {
      try {
        const parts = String(interaction.customId).split(':');
        const targetUserId = String(parts[1] || '');
        const kind = String(parts[2] || 'o');
        const caseToken = String(parts[3] || '0');
        if (String(interaction.user?.id || '') !== targetUserId) {
          return interaction.reply({ content: 'This button is not for you.', ephemeral: true }).catch(() => null);
        }

        const intro = new EmbedBuilder()
          .setColor(0x87CEFA)
          .setTitle('Appeal Form')
          .setDescription('You can submit an appeal in 4 short questions.\n\nPress **Start Appeal** to begin.\nYou have **10 minutes** to complete the appeal after starting.');

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`appeal_begin:${targetUserId}:${kind}:${caseToken}`)
            .setLabel('Start Appeal')
            .setStyle(ButtonStyle.Primary)
        );

        return interaction.update({ embeds: [intro], components: [row] }).catch(() => null);
      } catch (e) {
        return interaction.reply({ content: 'Could not open appeal form.', ephemeral: true }).catch(() => null);
      }
    }

    if (interaction.isButton() && typeof interaction.customId === 'string' && interaction.customId.startsWith('appeal_begin:')) {
      try {
        const parts = String(interaction.customId).split(':');
        const targetUserId = String(parts[1] || '');
        const kind = String(parts[2] || 'o');
        const caseToken = String(parts[3] || '0');
        if (String(interaction.user?.id || '') !== targetUserId) {
          return interaction.reply({ content: 'This button is not for you.', ephemeral: true }).catch(() => null);
        }

        appealState = loadAppealState();
        const currentInvite = appealState.invites[targetUserId] || {};
        const actionType = currentInvite.actionType || (kind === 'b' ? 'Ban' : (kind === 'm' ? 'Mute' : 'Moderation'));
        const parsedCase = /^\d+$/.test(caseToken) && caseToken !== '0' ? Number(caseToken) : (currentInvite.caseId || null);

        appealState.pending[targetUserId] = {
          step: 0,
          answers: [],
          openedAt: Date.now(),
          expiresAt: Date.now() + APPEAL_WINDOW_MS,
          guildId: currentInvite.guildId || null,
          actionType,
          caseId: parsedCase,
        };
        saveAppealState(appealState);

        const startedEmbed = buildAppealQuestionEmbed(actionType, 0, appealState.pending[targetUserId].expiresAt);
        return interaction.update({ embeds: [startedEmbed], components: [] }).catch(() => null);
      } catch (e) {
        return interaction.reply({ content: 'Could not start appeal confirmation.', ephemeral: true }).catch(() => null);
      }
    }

    if (interaction.isButton() && typeof interaction.customId === 'string' && (interaction.customId.startsWith('appeal_yes:') || interaction.customId.startsWith('appeal_no:'))) {
      try {
        const parts = String(interaction.customId).split(':');
        const yes = String(parts[0] || '') === 'appeal_yes';
        const targetUserId = String(parts[1] || '');
        const kind = String(parts[2] || 'o');
        const caseToken = String(parts[3] || '0');
        if (String(interaction.user?.id || '') !== targetUserId) {
          return interaction.reply({ content: 'This button is not for you.', ephemeral: true }).catch(() => null);
        }

        appealState = loadAppealState();
        if (!yes) {
          const canceledEmbed = new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle('Appeal canceled')
            .setDescription('You can start again anytime by typing `appeal` in this DM.');
          return interaction.update({ embeds: [canceledEmbed], components: [] }).catch(() => null);
        }

        const currentInvite = appealState.invites[targetUserId] || {};
        const actionType = currentInvite.actionType || (kind === 'b' ? 'Ban' : (kind === 'm' ? 'Mute' : 'Moderation'));
        const parsedCase = /^\d+$/.test(caseToken) && caseToken !== '0' ? Number(caseToken) : (currentInvite.caseId || null);

        appealState.pending[targetUserId] = {
          step: 0,
          answers: [],
          openedAt: Date.now(),
          expiresAt: Date.now() + APPEAL_WINDOW_MS,
          guildId: currentInvite.guildId || null,
          actionType,
          caseId: parsedCase,
        };
        saveAppealState(appealState);

        const startedEmbed = buildAppealQuestionEmbed(actionType, 0, appealState.pending[targetUserId].expiresAt);
        return interaction.update({ embeds: [startedEmbed], components: [] }).catch(() => null);
      } catch (e) {
        return interaction.reply({ content: 'Could not confirm appeal start.', ephemeral: true }).catch(() => null);
      }
    }

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

        if (sub === 'migrate') {
          const target = (() => { try { return interaction.options.getString('target', true); } catch (e) { return null; } })();
          if (!target) return interaction.reply({ content: 'Missing target (sqlite|json).', ephemeral: true });

          if (target === 'sqlite') {
            if (!sqliteDb) return interaction.reply({ content: 'SQLite is not available on this host.', ephemeral: true });
            const rows = loadPersistedReminders();
            let moved = 0;
            for (const r of (rows || [])) {
              if (!r || !r.id) continue;
              sqlitePersistReminder({
                id: String(r.id),
                messageId: r.messageId ? String(r.messageId) : null,
                channelId: r.channelId ? String(r.channelId) : (r.channel ? String(r.channel) : null),
                userId: r.userId ? String(r.userId) : null,
                sessionIndex: Number(r.sessionIndex || 0),
                sendAt: Number(r.sendAt || 0),
                content: r.content ? String(r.content) : null,
              });
              moved += 1;
            }
            return interaction.reply({ content: `Migrated ${moved} reminder(s) from JSON to SQLite.`, ephemeral: true });
          }

          if (target === 'json') {
            if (!sqliteDb) return interaction.reply({ content: 'SQLite is not available on this host.', ephemeral: true });
            const rows = await sqliteLoadAllReminders();
            const normalized = (rows || []).map(r => ({
              id: String(r.id),
              messageId: r.messageId ? String(r.messageId) : null,
              channelId: r.channelId ? String(r.channelId) : null,
              userId: r.userId ? String(r.userId) : null,
              sessionIndex: Number(r.sessionIndex || 0),
              sendAt: Number(r.sendAt || 0),
              content: r.content ? String(r.content) : null,
            }));
            persistReminders(normalized);
            return interaction.reply({ content: `Migrated ${normalized.length} reminder(s) from SQLite to JSON.`, ephemeral: true });
          }

          return interaction.reply({ content: 'Invalid target. Use sqlite or json.', ephemeral: true });
        }

        if (sub === 'logs') {
          const count = (() => {
            try {
              const n = interaction.options.getInteger('count');
              if (!n || !Number.isFinite(n)) return 10;
              return Math.max(1, Math.min(20, Number(n)));
            } catch (e) {
              return 10;
            }
          })();
          try { const chId = resolveSessionsLogChannelId(interaction.guildId); const ch = chId ? await client.channels.fetch(chId).catch(()=>null) : null; if (!ch || !ch.isTextBased()) return interaction.reply({ content: 'Log channel not accessible.', ephemeral: true }); const msgs = await ch.messages.fetch({ limit: count }); const out = Array.from(msgs.values()).slice(0,count).map(m => `• ${m.author?.tag || m.author?.id || 'bot'} — ${m.createdAt.toISOString()} — ${m.embeds?.[0]?.title || m.content || '[embed]'}`); return interaction.reply({ content: out.join('\n') || 'No logs found.', ephemeral: true }); } catch (e) { return interaction.reply({ content: 'Failed to read logs.', ephemeral: true }); }
        }
        return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
      } catch (e) {
        console.error('session slash handling failed', e);
        try { await interaction.reply({ content: 'Error executing the session command.', ephemeral: true }); } catch (e) {}
      }
    }
    // slash /create -> create fixed lobby category + channels
    if (interaction.isChatInputCommand() && interaction.commandName === 'create') {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: 'This command is disabled. Use `&setup` inside the target lobby channel.' });
        } else {
          await interaction.reply({ content: 'This command is disabled. Use `&setup` inside the target lobby channel.', ephemeral: true });
        }
      } catch (e) {}
      return;
      try {
        if (!interaction.guild) return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        const memberCanManage = !!(interaction.memberPermissions && interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels));
        if (!memberCanManage) return interaction.reply({ content: 'You need Manage Channels permission for this command.', ephemeral: true });

        const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
        const botCanManageChannels = !!(botMember && botMember.permissions.has(PermissionsBitField.Flags.ManageChannels));
        const botCanManageRoles = !!(botMember && botMember.permissions.has(PermissionsBitField.Flags.ManageRoles));
        if (!botCanManageChannels || !botCanManageRoles) {
          return interaction.reply({ content: 'I need Manage Channels and Manage Roles permissions for this command.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const parseHHMM = (input) => {
          const s = String(input || '').trim();
          const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
          if (!m) return null;
          return { hh: Number(m[1]), mm: Number(m[2]) };
        };
        const resolveNextTimestampSeconds = (hh, mm, now = new Date()) => {
          const d = new Date(now);
          d.setSeconds(0, 0);
          d.setHours(hh, mm, 0, 0);
          if (d.getTime() + 60_000 < now.getTime()) d.setDate(d.getDate() + 1);
          return Math.floor(d.getTime() / 1000);
        };
        const getStringOpt = (name) => {
          try { return interaction.options.getString(name); } catch (e) { return null; }
        };
        const getIntOpt = (name) => {
          try { return interaction.options.getInteger(name); } catch (e) { return null; }
        };
        const now = new Date();

        const sessionNo = Math.max(1, Number(getIntOpt('session') || 5));
        const lobbyNo = Math.max(1, Number(getIntOpt('lobby') || 1));
        const regOpensRaw = String(getStringOpt('registration_opens') || '').trim();
        const regOpensParsed = parseHHMM(regOpensRaw);
        if (!regOpensParsed) {
          return interaction.editReply({ content: 'Invalid `registration_opens`. Use HH:MM (example: 00:17).' });
        }
        const regBaseTs = resolveNextTimestampSeconds(regOpensParsed.hh, regOpensParsed.mm, now);

        const lobbyTemplate = String(getStringOpt('lobby_template') || '').trim();
        if (!lobbyTemplate) {
          return interaction.editReply({ content: 'Please set `lobby_template`.' });
        }

        const categoryInput = String(getStringOpt('category') || '').trim();
        const defaultCategoryName = `Duo Session ${sessionNo} Lobby ${lobbyNo}`;
        let categoryName = categoryInput || defaultCategoryName;

        const supportTs = regBaseTs + 60;
        const boosterTs = regBaseTs + 120;
        const verifiedTs = regBaseTs + 180;
        const fillsOpenTs = regBaseTs + (5 * 60);
        const unregCloseTs = regBaseTs + (5 * 60);

        const lobbyRoleName = `Lobby${lobbyNo}`;
        const lobbyStaffRoleName = `${lobbyRoleName} Staffs`;
        const lobbyPrefix = `lobby-${lobbyNo}`;
        const channelNames = {
          registration: `${lobbyPrefix}-registration`,
          dropmap: `${lobbyPrefix}-dropmap`,
          code: `${lobbyPrefix}-code`,
          chat: `${lobbyPrefix}-chat`,
          unreg: `${lobbyPrefix}-unreg`,
          fills: `${lobbyPrefix}-fills`,
          staff: `${lobbyPrefix}-staff`,
        };
        const fixedNames = [
          channelNames.registration,
          channelNames.dropmap,
          channelNames.code,
          channelNames.chat,
          channelNames.unreg,
          channelNames.fills,
          channelNames.staff,
        ];

        let lobbyRole = interaction.guild.roles.cache.find(r => String(r.name || '').toLowerCase() === lobbyRoleName.toLowerCase()) || null;
        if (!lobbyRole) {
          lobbyRole = await interaction.guild.roles.create({ name: lobbyRoleName, mentionable: true, reason: `Auto-created by /create for ${lobbyRoleName} registration` });
        }

        let lobbyStaffRole = interaction.guild.roles.cache.find(r => String(r.name || '').toLowerCase() === lobbyStaffRoleName.toLowerCase()) || null;
        if (!lobbyStaffRole) {
          lobbyStaffRole = await interaction.guild.roles.create({ name: lobbyStaffRoleName, mentionable: true, reason: `Auto-created by /create for ${lobbyStaffRoleName} write access` });
        }

        try {
          const lobbyRoleMapPath = path.join(DATA_DIR, 'lobby_role_map.json');
          const roleMap = loadJson(lobbyRoleMapPath, {});
          const gid = String(interaction.guild.id);
          if (!roleMap[gid]) roleMap[gid] = {};
          roleMap[gid][String(lobbyNo)] = {
            roleId: String(lobbyRole.id),
            staffRoleId: String(lobbyStaffRole.id),
            updatedAt: Date.now(),
          };
          saveJson(lobbyRoleMapPath, roleMap);
        } catch (e) {}

        const categoryIdMaybe = categoryInput.replace(/[<#>]/g, '');
        let category = null;
        if (/^\d+$/.test(categoryIdMaybe)) {
          category = interaction.guild.channels.cache.get(categoryIdMaybe) || await interaction.guild.channels.fetch(categoryIdMaybe).catch(() => null);
          if (category && category.type !== 4) category = null;
        }
        if (!category) {
          category = interaction.guild.channels.cache.find(c => c && c.type === 4 && String(c.name || '').toLowerCase() === String(categoryName).toLowerCase()) || null;
        }
        if (!category) {
          category = await interaction.guild.channels.create({ name: categoryName, type: 4 });
        }
        categoryName = String(category.name || categoryName);
        try { await category.setPosition(0); } catch (e) {}

        const created = [];
        const existing = [];
        for (const name of fixedNames) {
          const found = interaction.guild.channels.cache.find(c => c && c.type === 0 && String(c.name) === name && c.parentId === category.id) || null;
          if (found) {
            existing.push(found);
            continue;
          }
          const ch = await interaction.guild.channels.create({ name, type: 0, parent: category.id });
          created.push(ch);
        }

        const byName = {};
        for (const name of fixedNames) {
          byName[name] = interaction.guild.channels.cache.find(c => c && c.type === 0 && String(c.name) === name && c.parentId === category.id) || null;
        }

        const everyoneId = interaction.guild.roles.everyone.id;
        const hiddenForUnregistered = [
          { id: everyoneId, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: lobbyRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AddReactions], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: lobbyStaffRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages] },
        ];
        const registrationOverwrites = [
          { id: everyoneId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: lobbyRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: lobbyStaffRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages] },
        ];

        const chatChannel = byName[channelNames.chat];
        if (chatChannel) {
          await chatChannel.edit({
            permissionOverwrites: [
              ...hiddenForUnregistered,
              { id: lobbyRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages] },
            ],
          }).catch(() => null);
        }

        const staffChannel = byName[channelNames.staff];
        if (staffChannel) {
          await staffChannel.edit({
            permissionOverwrites: [
              { id: everyoneId, deny: [PermissionsBitField.Flags.ViewChannel] },
              { id: lobbyRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
              { id: lobbyStaffRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages] },
            ],
          }).catch(() => null);
        }

        for (const name of [channelNames.dropmap, channelNames.code, channelNames.unreg, channelNames.fills]) {
          const ch = byName[name];
          if (!ch) continue;
          await ch.edit({ permissionOverwrites: hiddenForUnregistered }).catch(() => null);
        }
        const registrationChannel = byName[channelNames.registration];
        if (registrationChannel) {
          await registrationChannel.edit({ permissionOverwrites: registrationOverwrites }).catch(() => null);
        }

        // Ensure channel order inside the category: registration first, staff last.
        const ordered = [
          channelNames.registration,
          channelNames.dropmap,
          channelNames.code,
          channelNames.chat,
          channelNames.unreg,
          channelNames.fills,
          channelNames.staff,
        ];
        for (let i = 0; i < ordered.length; i++) {
          const ch = byName[ordered[i]];
          if (ch) {
            try { await ch.setPosition(i); } catch (e) {}
          }
        }

        if (registrationChannel) {
          const hasPanel = await registrationChannel.messages.fetch({ limit: 20 }).then(msgs => {
            return msgs.some(m => m && m.author && m.author.id === client.user.id && Array.isArray(m.components) && m.components.some(row => Array.isArray(row.components) && row.components.some(comp => String(comp.customId || '') === 'lobby1_register')));
          }).catch(() => false);

          if (!hasPanel) {
            const registerEmbed = new EmbedBuilder()
              .setColor(0x1E90FF)
              .setTitle('Registered Players:')
              .setDescription(`@Supporter can register at <t:${supportTs}:t> (<t:${supportTs}:R>)\n@Server Booster @CC Priority can register at <t:${boosterTs}:t> (<t:${boosterTs}:R>)\n@Verified can register at <t:${verifiedTs}:t> (<t:${verifiedTs}:R>)`)
              .setThumbnail(interaction.client.user.displayAvatarURL());
            const registerRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('lobby1_register').setLabel('Register').setStyle(ButtonStyle.Success)
            );
            await registrationChannel.send({ embeds: [registerEmbed], components: [registerRow] }).catch(() => null);
          }
        }

        const dropmapChannel = byName[channelNames.dropmap];
        if (dropmapChannel) {
          const hasDropmapPanel = await dropmapChannel.messages.fetch({ limit: 30 }).then(msgs => {
            return msgs.some(m => m && m.author && m.author.id === client.user.id && Array.isArray(m.components) && m.components.some(row => Array.isArray(row.components) && row.components.some(comp => String(comp.customId || '') === 'dropmap_mark')));
          }).catch(() => false);

          if (!hasDropmapPanel) {
            await dropmapChannel.send({
              embeds: [buildDropmapPanelEmbed(interaction.guild.id, dropmapChannel.id)],
              components: [buildDropmapPanelRow()],
            }).catch(() => null);
          }
        }

        if (chatChannel) {
          const hasChatInfo = await chatChannel.messages.fetch({ limit: 20 }).then(msgs => {
            return msgs.some(m => m && m.author && m.author.id === client.user.id && m.embeds && m.embeds[0] && String(m.embeds[0].title || '') === 'Please use English in this chat');
          }).catch(() => false);
          if (!hasChatInfo) {
            const chatEmbed = new EmbedBuilder()
              .setColor(0x1E90FF)
              .setTitle('Please use English in this chat')
              .setDescription('We want everyone to feel comfortable here. Thank you for understanding!');
            await chatChannel.send({ embeds: [chatEmbed] }).catch(() => null);
          }
        }

        const fillsChannel = byName[channelNames.fills];
        if (fillsChannel) {
          const existingFillsMsg = await fillsChannel.messages.fetch({ limit: 20 }).then(msgs => {
            return msgs.find(m => m && m.author && m.author.id === client.user.id && m.embeds && m.embeds[0] && String(m.embeds[0].title || '').startsWith('Fills will open at')) || null;
          }).catch(() => null);
          if (!existingFillsMsg) {
            const fillsEmbed = new EmbedBuilder()
              .setColor(0x1E90FF)
              .setTitle(`Fills will open at <t:${fillsOpenTs}:t>`)
              .setDescription('Please do not DM or ping staff; they will unlock this channel and request new teams when needed.\n\nReact below to show interest for a 2nd lobby.');
            const fillsMsg = await fillsChannel.send({ embeds: [fillsEmbed] }).catch(() => null);
            if (fillsMsg) {
              await fillsMsg.react('✅').catch(() => null);
            }
          } else {
            await existingFillsMsg.react('✅').catch(() => null);
            const oldTwoReaction = existingFillsMsg.reactions?.cache?.find(r => ['2️⃣', '2⃣', '2'].includes(String(r?.emoji?.name || '')));
            if (oldTwoReaction) await oldTwoReaction.remove().catch(() => null);
          }
        }

        const unregChannel = byName[channelNames.unreg];
        if (unregChannel) {
          const hasUnregInfo = await unregChannel.messages.fetch({ limit: 20 }).then(msgs => {
            return msgs.some(m => m && m.author && m.author.id === client.user.id && m.embeds && m.embeds[0] && String(m.embeds[0].title || '').startsWith('Getting off closes at'));
          }).catch(() => false);
          if (!hasUnregInfo) {
            const unregEmbed = new EmbedBuilder()
              .setColor(0x1E90FF)
              .setTitle(`Getting off closes at <t:${unregCloseTs}:t>`)
              .setDescription('Late unregistrations will result in a punishment!\nType `unreg` in this channel to unregister.');
            await unregChannel.send({ embeds: [unregEmbed] }).catch(() => null);
          }
        }

        if (registrationChannel && lobbyRole && lobbyRole.id) {
          const pingAtMs = Number(regBaseTs) * 1000;
          const sendRolePing = async () => {
            try {
              const pingMsg = await registrationChannel.send({
                content: `<@&${lobbyRole.id}> Registration is now open.`,
                allowedMentions: { roles: [lobbyRole.id] },
              }).catch(() => null);
              if (pingMsg) setTimeout(() => { try { pingMsg.delete().catch(() => {}); } catch (e) {} }, 5000);
            } catch (e) {}
          };

          const delayMs = Math.max(0, pingAtMs - Date.now());
          if (delayMs <= 2500) {
            await sendRolePing();
          } else {
            setTimeout(() => { sendRolePing().catch(() => {}); }, delayMs);
          }
        }

        const createdText = created.length ? created.map(c => `#${c.name}`).join(', ') : 'none';
        const existingText = existing.length ? existing.map(c => `#${c.name}`).join(', ') : 'none';
        await interaction.editReply({ content: `Done. Category: **${category.name}**\nTemplate: **${lobbyTemplate}**\nRoles: ${lobbyRole} / ${lobbyStaffRole}\nCreated: ${createdText}\nAlready existed: ${existingText}` });
      } catch (e) { console.error('failed to create fixed lobby channels', e); try { if (interaction.deferred || interaction.replied) await interaction.editReply({ content: 'Failed to create channels.' }); else await interaction.reply({ content: 'Failed to create channels.', ephemeral: true }); } catch (e) {} }
      return;
    }

    // slash /setup -> post all standard lobby messages into existing channels
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
      try {
        if (!interaction.guild) return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
        const memberCanManage = !!(interaction.memberPermissions && interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels));
        if (!memberCanManage) return interaction.reply({ content: 'You need Manage Channels permission for this command.', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        const parseHHMM = (input) => {
          const s = String(input || '').trim();
          const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
          if (!m) return null;
          return { hh: Number(m[1]), mm: Number(m[2]) };
        };
        const resolveNextTimestampSeconds = (hh, mm, now = new Date()) => {
          const d = new Date(now);
          d.setSeconds(0, 0);
          d.setHours(hh, mm, 0, 0);
          if (d.getTime() + 60_000 < now.getTime()) d.setDate(d.getDate() + 1);
          return Math.floor(d.getTime() / 1000);
        };
        const getStringOpt = (name) => {
          try { return interaction.options.getString(name); } catch (e) { return null; }
        };
        const getIntOpt = (name) => {
          try { return interaction.options.getInteger(name); } catch (e) { return null; }
        };

        const sessionNo = Math.max(1, Number(getIntOpt('session') || 5));
        const lobbyNo = Math.max(1, Number(getIntOpt('lobby') || 1));

        const regOpensRaw = String(getStringOpt('registration_opens') || '').trim();
        const regOpensParsed = parseHHMM(regOpensRaw);
        if (!regOpensParsed) {
          return interaction.editReply({ content: 'Invalid `registration_opens`. Use HH:MM (example: 00:17).' });
        }

        const regBaseTs = resolveNextTimestampSeconds(regOpensParsed.hh, regOpensParsed.mm, new Date());
        const supportTs = regBaseTs + 60;
        const boosterTs = regBaseTs + 120;
        const verifiedTs = regBaseTs + 180;
        const fillsOpenTs = regBaseTs + (5 * 60);
        const unregCloseTs = regBaseTs + (5 * 60);

        const categoryInput = String(getStringOpt('category') || '').trim();
        const defaultCategoryName = `Duo Session ${sessionNo} Lobby ${lobbyNo}`;
        const lobbyPrefix = `lobby-${lobbyNo}`;
        const channelNames = {
          registration: `${lobbyPrefix}-registration`,
          dropmap: `${lobbyPrefix}-dropmap`,
          code: `${lobbyPrefix}-code`,
          chat: `${lobbyPrefix}-chat`,
          unreg: `${lobbyPrefix}-unreg`,
          fills: `${lobbyPrefix}-fills`,
          staff: `${lobbyPrefix}-staff`,
        };

        const categoryIdMaybe = categoryInput.replace(/[<#>]/g, '');
        let category = null;
        if (/^\d+$/.test(categoryIdMaybe)) {
          category = interaction.guild.channels.cache.get(categoryIdMaybe) || await interaction.guild.channels.fetch(categoryIdMaybe).catch(() => null);
          if (category && category.type !== 4) category = null;
        }
        if (!category) {
          category = interaction.guild.channels.cache.find(c => c && c.type === 4 && String(c.name || '').toLowerCase() === String(categoryInput || defaultCategoryName).toLowerCase()) || null;
        }

        const findTextChannel = (name) => {
          const lname = String(name || '').toLowerCase();
          return interaction.guild.channels.cache.find(c => c && c.type === 0 && String(c.name || '').toLowerCase() === lname && (!category || c.parentId === category.id)) || null;
        };

        const byName = {
          registration: findTextChannel(channelNames.registration),
          dropmap: findTextChannel(channelNames.dropmap),
          code: findTextChannel(channelNames.code),
          chat: findTextChannel(channelNames.chat),
          unreg: findTextChannel(channelNames.unreg),
          fills: findTextChannel(channelNames.fills),
          staff: findTextChannel(channelNames.staff),
        };

        const missing = Object.entries(byName).filter(([, ch]) => !ch).map(([k]) => channelNames[k]);
        const postedIn = [];

        if (byName.registration) {
          const registerEmbed = new EmbedBuilder()
            .setColor(0x1E90FF)
            .setTitle('Registered Players:')
            .setDescription(`@Supporter can register at <t:${supportTs}:t> (<t:${supportTs}:R>)\n@Server Booster @CC Priority can register at <t:${boosterTs}:t> (<t:${boosterTs}:R>)\n@Verified can register at <t:${verifiedTs}:t> (<t:${verifiedTs}:R>)`)
            .setThumbnail(interaction.client.user.displayAvatarURL());
          const registerRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('lobby1_register').setLabel('Register').setStyle(ButtonStyle.Success)
          );
          await byName.registration.send({ embeds: [registerEmbed], components: [registerRow] }).catch(() => null);
          postedIn.push(`#${byName.registration.name}`);
        }

        if (byName.dropmap) {
          await byName.dropmap.send({
            embeds: [buildDropmapPanelEmbed(interaction.guild.id, byName.dropmap.id)],
            components: [buildDropmapPanelRow()],
          }).catch(() => null);
          postedIn.push(`#${byName.dropmap.name}`);
        }

        if (byName.chat) {
          const chatEmbed = new EmbedBuilder()
            .setColor(0x1E90FF)
            .setTitle('Please use English in this chat')
            .setDescription('We want everyone to feel comfortable here. Thank you for understanding!');
          await byName.chat.send({ embeds: [chatEmbed] }).catch(() => null);
          postedIn.push(`#${byName.chat.name}`);
        }

        if (byName.fills) {
          const fillsEmbed = new EmbedBuilder()
            .setColor(0x1E90FF)
            .setTitle(`Fills will open at <t:${fillsOpenTs}:t>`)
            .setDescription('Please do not DM or ping staff; they will unlock this channel and request new teams when needed.\n\nReact below to show interest for a 2nd lobby.');
          const fillsMsg = await byName.fills.send({ embeds: [fillsEmbed] }).catch(() => null);
          if (fillsMsg) {
            await fillsMsg.react('✅').catch(() => null);
          }
          postedIn.push(`#${byName.fills.name}`);
        }

        if (byName.unreg) {
          const unregEmbed = new EmbedBuilder()
            .setColor(0x1E90FF)
            .setTitle(`Getting off closes at <t:${unregCloseTs}:t>`)
            .setDescription('Late unregistrations will result in a punishment!\nType `unreg` in this channel to unregister.');
          await byName.unreg.send({ embeds: [unregEmbed] }).catch(() => null);
          postedIn.push(`#${byName.unreg.name}`);
        }

        if (byName.code) {
          const codeEmbed = new EmbedBuilder()
            .setColor(0x1E90FF)
            .setTitle('Code Channel Setup')
            .setDescription('Post your lobby code here only when staff opens code sharing.\nDo not spam or share old codes.');
          await byName.code.send({ embeds: [codeEmbed] }).catch(() => null);
          postedIn.push(`#${byName.code.name}`);
        }

        if (byName.staff) {
          const staffEmbed = new EmbedBuilder()
            .setColor(0x1E90FF)
            .setTitle('Lobby Staff Channel')
            .setDescription('Use this channel for staff coordination and reports for this lobby.');
          await byName.staff.send({ embeds: [staffEmbed] }).catch(() => null);
          postedIn.push(`#${byName.staff.name}`);
        }

        const summary = [
          `Setup done for **${category ? category.name : defaultCategoryName}**.`,
          `Posted in: ${postedIn.length ? postedIn.join(', ') : 'none'}`,
          `Missing channels: ${missing.length ? missing.map(n => `#${n}`).join(', ') : 'none'}`,
        ].join('\n');

        await interaction.editReply({ content: summary });
      } catch (e) {
        console.error('failed to setup lobby messages', e);
        try {
          if (interaction.deferred || interaction.replied) await interaction.editReply({ content: 'Failed to send setup messages.' });
          else await interaction.reply({ content: 'Failed to send setup messages.', ephemeral: true });
        } catch (ee) {}
      }
      return;
    }

    if (interaction.isButton() && (String(interaction.customId || '') === 'lobby1_register' || String(interaction.customId || '').startsWith('lobby_register:'))) {
      try {
        if (!interaction.guild) return interaction.reply({ content: 'This button only works in a server.', ephemeral: true });
        const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
        const customId = String(interaction.customId || '');
        const customLobbyMatch = customId.match(/^lobby_register:(\d+)$/i);
        const channelLobbyMatch = String(interaction.channel?.name || '').match(/lobby[\s_-]*(\d+)/i);
        const lobbyNo = Number(customLobbyMatch?.[1] || channelLobbyMatch?.[1] || 1);
        const lobbyRoleName = `Lobby${lobbyNo}`;
        if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          return interaction.reply({ content: `I need Manage Roles permission to assign ${lobbyRoleName}.`, ephemeral: true });
        }

        const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'Could not find your member profile in this server.', ephemeral: true });

        const findRoleByNames = (names) => {
          const wanted = (Array.isArray(names) ? names : []).map(n => String(n || '').toLowerCase());
          return interaction.guild.roles.cache.find(r => wanted.includes(String(r.name || '').toLowerCase())) || null;
        };

        const supporterRole = findRoleByNames(['supporter', 'support']);
        const boosterRole = findRoleByNames(['server booster', 'booster']);
        const ccPriorityRole = findRoleByNames(['cc priority', 'cc-priority', 'ccpriority']);
        const verifiedRole = findRoleByNames(['verified', 'verify']);

        const hasSupporter = !!(supporterRole && member.roles.cache.has(supporterRole.id));
        const hasBoosterOrCc = !!((boosterRole && member.roles.cache.has(boosterRole.id)) || (ccPriorityRole && member.roles.cache.has(ccPriorityRole.id)));
        const hasVerified = !!(verifiedRole && member.roles.cache.has(verifiedRole.id));

        let supportTs = null;
        let boosterTs = null;
        let verifiedTs = null;
        try {
          const desc = String(interaction.message?.embeds?.[0]?.description || '');
          const ts = Array.from(desc.matchAll(/<t:(\d+):t>/g)).map(m => Number(m[1])).filter(n => Number.isFinite(n));
          supportTs = ts[0] || null;
          boosterTs = ts[1] || null;
          verifiedTs = ts[2] || null;
        } catch (e) {}

        let allowedAtTs = null;
        if (hasSupporter && supportTs) allowedAtTs = supportTs;
        else if (hasBoosterOrCc && boosterTs) allowedAtTs = boosterTs;
        else if (hasVerified && verifiedTs) allowedAtTs = verifiedTs;

        if (!allowedAtTs) {
          return interaction.reply({ content: 'You need one of these roles to register: Supporter, Server Booster/CC Priority, or Verified.', ephemeral: true });
        }

        const nowTs = Math.floor(Date.now() / 1000);
        if (nowTs < allowedAtTs) {
          return interaction.reply({ content: `You can register at <t:${allowedAtTs}:t> (<t:${allowedAtTs}:R>).`, ephemeral: true });
        }

        let lobbyRole = interaction.guild.roles.cache.find(r => String(r.name || '').toLowerCase() === String(lobbyRoleName).toLowerCase()) || null;
        if (!lobbyRole) {
          lobbyRole = await interaction.guild.roles.create({ name: lobbyRoleName, mentionable: true, reason: `Auto-created from Register button (${lobbyRoleName})` });
        }

        const lobbyNoFromChannel = Number(channelLobbyMatch?.[1] || lobbyNo || 1);
        const lobbyDropmapRe = new RegExp(`lobby[\\s_-]*${lobbyNoFromChannel}(?:[\\s_-]|$)`, 'i');
        let dropmapChannel = null;
        dropmapChannel = interaction.guild.channels.cache.find(c => c && c.type === ChannelType.GuildText && c.parentId === interaction.channel?.parentId && lobbyDropmapRe.test(String(c.name || '')) && String(c.name || '').toLowerCase().includes('dropmap')) || null;
        const dropmapHint = dropmapChannel
          ? `Drop mark: ${dropmapChannel} -> click **Mark**.`
          : 'Drop mark: go to the dropmap channel and click **Mark**.';

        if (member.roles.cache.has(lobbyRole.id)) {
          return interaction.reply({ content: `You already have ${lobbyRole}.\n${dropmapHint}`, ephemeral: true });
        }

        await member.roles.add(lobbyRole, `${lobbyRoleName} registration button`);
        return interaction.reply({ content: `✅ You got ${lobbyRole}.\n${dropmapHint}`, ephemeral: true });
      } catch (e) {
        console.error('lobby register button failed', e);
        return interaction.reply({ content: 'Failed to assign role. Check role hierarchy and permissions.', ephemeral: true }).catch(() => null);
      }
    }

    if (interaction.isButton() && (String(interaction.customId || '') === 'lobby1_unregister' || String(interaction.customId || '').startsWith('lobby_unregister:'))) {
      try {
        if (!interaction.guild) return interaction.reply({ content: 'This button only works in a server.', ephemeral: true });
        const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
        const customId = String(interaction.customId || '');
        const customLobbyMatch = customId.match(/^lobby_unregister:(\d+)$/i);
        const channelLobbyMatch = String(interaction.channel?.name || '').match(/lobby[\s_-]*(\d+)/i);
        const lobbyNo = Number(customLobbyMatch?.[1] || channelLobbyMatch?.[1] || 1);
        const lobbyRoleName = `Lobby${lobbyNo}`;
        if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          return interaction.reply({ content: `I need Manage Roles permission to remove ${lobbyRoleName}.`, ephemeral: true });
        }

        const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'Could not find your member profile in this server.', ephemeral: true });

        const lobbyRole = interaction.guild.roles.cache.find(r => String(r.name || '').toLowerCase() === String(lobbyRoleName).toLowerCase()) || null;
        if (!lobbyRole || !member.roles.cache.has(lobbyRole.id)) {
          return interaction.reply({ content: `You are not registered in ${lobbyRoleName}.`, ephemeral: true });
        }

        await member.roles.remove(lobbyRole, `${lobbyRoleName} unregister button`);
        return interaction.reply({ content: `✅ Removed ${lobbyRole}.`, ephemeral: true });
      } catch (e) {
        console.error('lobby unregister button failed', e);
        return interaction.reply({ content: 'Failed to remove role. Check role hierarchy and permissions.', ephemeral: true }).catch(() => null);
      }
    }

    if (interaction.isButton() && String(interaction.customId || '') === 'staff_apply_open') {
      try {
        const modal = new ModalBuilder()
          .setCustomId('staff_apply_modal')
          .setTitle('Staff Application');

        const ageInput = new TextInputBuilder()
          .setCustomId('age')
          .setLabel('Age')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(20)
          .setPlaceholder('e.g. 18');

        const expInput = new TextInputBuilder()
          .setCustomId('experience')
          .setLabel('Staff Experience')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(700)
          .setPlaceholder('What have you done so far?');

        const availInput = new TextInputBuilder()
          .setCustomId('availability')
          .setLabel('Availability')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(120)
          .setPlaceholder('e.g. daily 18:00-22:00');

        const motivationInput = new TextInputBuilder()
          .setCustomId('motivation')
          .setLabel('Why do you want to become staff?')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1200)
          .setPlaceholder('Tell us your motivation briefly');

        modal.addComponents(
          new ActionRowBuilder().addComponents(ageInput),
          new ActionRowBuilder().addComponents(expInput),
          new ActionRowBuilder().addComponents(availInput),
          new ActionRowBuilder().addComponents(motivationInput),
        );

        return interaction.showModal(modal);
      } catch (e) {
        console.error('staff apply modal open failed', e);
        return interaction.reply({ content: 'Could not open the application form.', ephemeral: true }).catch(() => null);
      }
    }

    if (interaction.isButton() && String(interaction.customId || '').startsWith('staff_apply_')) {
      try {
        const customId = String(interaction.customId || '');
        if (!customId.startsWith('staff_apply_accept:') && !customId.startsWith('staff_apply_decline:') && !customId.startsWith('staff_apply_info:')) {
          // handled elsewhere (e.g. staff_apply_open)
        } else {
          if (!interaction.guild) return interaction.reply({ content: 'This only works in a server.', ephemeral: true }).catch(() => null);

          const reviewer = interaction.member || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
          const canReview = !!(reviewer && (
            reviewer.permissions?.has?.(PermissionsBitField.Flags.Administrator) ||
            reviewer.roles?.cache?.has?.(ADMIN_COMMAND_ROLE_ID)
          ));
          if (!canReview) {
            return interaction.reply({ content: 'Only admins can review applications.', ephemeral: true }).catch(() => null);
          }

          const isAccept = customId.startsWith('staff_apply_accept:');
          const isInfo = customId.startsWith('staff_apply_info:');
          const applicantId = customId.split(':')[1] || '';
          if (!/^\d+$/.test(applicantId)) {
            return interaction.reply({ content: 'Invalid applicant ID.', ephemeral: true }).catch(() => null);
          }

          if (isInfo) {
            const applicantUser = await client.users.fetch(applicantId).catch(() => null);
            const applicantMember = await interaction.guild.members.fetch(applicantId).catch(() => null);

            const createdTs = applicantUser && applicantUser.createdTimestamp ? Math.floor(applicantUser.createdTimestamp / 1000) : null;
            const joinedTs = applicantMember && applicantMember.joinedTimestamp ? Math.floor(applicantMember.joinedTimestamp / 1000) : null;
            const roleList = applicantMember
              ? applicantMember.roles.cache
                  .filter(r => r && r.id !== interaction.guild.roles.everyone.id)
                  .sort((a, b) => b.position - a.position)
                  .map(r => `<@&${r.id}>`)
                  .slice(0, 15)
              : [];

            const infoEmbed = new EmbedBuilder()
              .setColor(0x1E90FF)
              .setTitle('Applicant Info')
              .setDescription(applicantUser ? `${applicantUser} (${applicantUser.tag})` : `<@${applicantId}> (${applicantId})`)
              .addFields(
                { name: 'User ID', value: String(applicantId), inline: true },
                { name: 'In Server', value: applicantMember ? 'Yes' : 'No', inline: true },
                { name: 'Bot', value: applicantUser?.bot ? 'Yes' : 'No', inline: true },
                { name: 'Account Created', value: createdTs ? `<t:${createdTs}:f>\n(<t:${createdTs}:R>)` : 'Unknown', inline: false },
                { name: 'Joined Server', value: joinedTs ? `<t:${joinedTs}:f>\n(<t:${joinedTs}:R>)` : 'Unknown / not in server', inline: false },
                { name: `Roles (${roleList.length})`, value: roleList.length ? roleList.join(' ') : 'No roles', inline: false }
              )
              .setThumbnail(applicantUser ? applicantUser.displayAvatarURL() : null)
              .setTimestamp();

            return interaction.reply({ embeds: [infoEmbed], ephemeral: true }).catch(() => null);
          }

          let statusLine = '';
          if (isAccept) {
            const staffRoleId = '1464609137316069500';
            const staffRole = interaction.guild.roles.cache.get(staffRoleId) || await interaction.guild.roles.fetch(staffRoleId).catch(() => null);
            if (!staffRole) {
              return interaction.reply({ content: `Staff role not found: ${staffRoleId}`, ephemeral: true }).catch(() => null);
            }

            const applicantMember = await interaction.guild.members.fetch(applicantId).catch(() => null);
            if (!applicantMember) {
              return interaction.reply({ content: 'Applicant is not in this server.', ephemeral: true }).catch(() => null);
            }

            if (!applicantMember.roles.cache.has(staffRole.id)) {
              await applicantMember.roles.add(staffRole, `Staff application accepted by ${interaction.user.tag}`).catch(() => null);
            }
            statusLine = `✅ Accepted by ${interaction.user} — role granted: ${staffRole}`;
          } else {
            statusLine = `❌ Declined by ${interaction.user}`;
          }

          const newEmbeds = (interaction.message.embeds || []).map((e, idx) => {
            if (idx !== 0) return EmbedBuilder.from(e);
            const b = EmbedBuilder.from(e);
            const existingFields = Array.isArray(e.fields) ? e.fields.map(f => ({ name: f.name, value: f.value, inline: !!f.inline })) : [];
            const filtered = existingFields.filter(f => String(f.name || '').toLowerCase() !== 'status');
            b.setFields(...filtered, { name: 'Status', value: statusLine, inline: false });
            return b;
          });

          const disabledRows = (interaction.message.components || []).map(row => {
            const built = ActionRowBuilder.from(row);
            const disabledComps = built.components.map(comp => ButtonBuilder.from(comp).setDisabled(true));
            return new ActionRowBuilder().addComponents(...disabledComps);
          });

          return interaction.update({ embeds: newEmbeds, components: disabledRows }).catch(() => null);
        }
      } catch (e) {
        console.error('staff apply review failed', e);
        return interaction.reply({ content: 'Could not process this application review.', ephemeral: true }).catch(() => null);
      }
    }

    if (interaction.isButton() && /^(appeal_approve|appeal_reject|appeal_history):/.test(String(interaction.customId || ''))) {
      try {
        if (!interaction.guild) return interaction.reply({ content: 'This only works in a server.', ephemeral: true }).catch(() => null);
        const reviewer = interaction.member || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!canReviewAppealsFromMember(reviewer)) {
          return interaction.reply({ content: 'Only staff/admin can review appeals.', ephemeral: true }).catch(() => null);
        }

        const parts = String(interaction.customId || '').split(':');
        const action = String(parts[0] || '');
        const submissionId = String(parts[1] || '');
        const userId = String(parts[2] || '');
        if (!/^\d+$/.test(submissionId) || !/^\d+$/.test(userId)) {
          return interaction.reply({ content: 'Invalid appeal payload.', ephemeral: true }).catch(() => null);
        }

        appealState = loadAppealState();
        const sub = appealState.submissions[submissionId] || null;

        if (action === 'appeal_history') {
          await interaction.deferReply({ ephemeral: true }).catch(() => null);
          const cases = (modlogs && Array.isArray(modlogs.cases) ? modlogs.cases : [])
            .filter(c => c && String(c.user || '') === userId && String(c.guildId || '') === String(interaction.guild.id || ''))
            .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))
            .slice(0, 10);

          if (!cases.length) {
            return interaction.editReply({ content: 'No modlogs found for this user.' }).catch(() => null);
          }

          const hist = new EmbedBuilder()
            .setColor(0x87CEFA)
            .setTitle(`Modlogs — ${userId}`)
            .setTimestamp();

          for (const c of cases) {
            const when = c.time ? `<t:${Math.floor(Number(c.time) / 1000)}:f>` : 'n/a';
            const modLine = c.moderator ? `<@${c.moderator}> (${c.moderator})` : 'n/a';
            hist.addFields({
              name: `#${c.caseId || '?'} — ${c.type || 'Unknown'}`,
              value: `Reason: ${(c.reason || 'No reason provided').toString().substring(0, 240)}\nModerator: ${modLine}\nWhen: ${when}`.substring(0, 1024),
              inline: false,
            });
          }
          return interaction.editReply({ embeds: [hist] }).catch(() => null);
        }

        await interaction.deferUpdate().catch(() => null);

        if (!sub) {
          return interaction.followUp({ content: 'Appeal submission not found.', ephemeral: true }).catch(() => null);
        }
        if (sub.status !== 'pending') {
          return interaction.followUp({ content: `This appeal is already ${sub.status}.`, ephemeral: true }).catch(() => null);
        }

        const isApprove = action === 'appeal_approve';
        const actor = `<@${interaction.user.id}>`;
        let resolutionText = '';

        if (isApprove) {
          let unmuted = false;
          let unbanned = false;
          let inviteUrl = null;

          try {
            const member = await interaction.guild.members.fetch(userId).catch(() => null);
            if (member && typeof member.timeout === 'function') {
              const isTimedOut = Number(member.communicationDisabledUntilTimestamp || 0) > Date.now();
              if (isTimedOut) {
                await member.timeout(null, `Appeal approved by ${interaction.user.tag}`).catch(() => null);
                unmuted = true;
              }
            }
          } catch (e) {}

          try {
            await interaction.guild.bans.remove(userId, `Appeal approved by ${interaction.user.tag}`).catch((err) => { throw err; });
            unbanned = true;
          } catch (e) {}

          if (unbanned) {
            try {
              const me = interaction.guild.members.me || await interaction.guild.members.fetch(client.user.id).catch(() => null);
              const botPerms = (ch) => {
                try { return me && ch && ch.permissionsFor && ch.permissionsFor(me); } catch (e) { return null; }
              };

              const candidates = [];
              const systemCh = interaction.guild.systemChannel || null;
              if (systemCh && systemCh.isTextBased && systemCh.isTextBased()) candidates.push(systemCh);

              for (const ch of interaction.guild.channels.cache.values()) {
                if (!ch || ch.type !== ChannelType.GuildText) continue;
                if (systemCh && String(ch.id) === String(systemCh.id)) continue;
                candidates.push(ch);
              }

              for (const ch of candidates) {
                const perms = botPerms(ch);
                if (!perms || !perms.has(PermissionsBitField.Flags.CreateInstantInvite)) continue;
                const inv = await ch.createInvite({ maxAge: 0, maxUses: 1, unique: true, reason: `Appeal approved by ${interaction.user.tag}` }).catch(() => null);
                if (inv && inv.url) {
                  inviteUrl = inv.url;
                  break;
                }
              }
            } catch (e) {}
          }

          const resultParts = [];
          if (unmuted) resultParts.push('unmuted');
          if (unbanned) resultParts.push('unbanned');
          const resultText = resultParts.length ? resultParts.join(' + ') : 'no active mute/ban found';

          resolutionText = `✅ Approved by ${actor} — ${resultText}`;

          try {
            const targetUser = await client.users.fetch(userId).catch(() => null);
            if (targetUser) {
              const resultSuccessful = (unmuted || unbanned);
              const resultColor = resultSuccessful ? 0x2ECC71 : 0xE74C3C;
              const inviteLine = inviteUrl ? `\n\nServer invite: ${inviteUrl}` : '';
              const dmEmbed = new EmbedBuilder()
                .setColor(resultColor)
                .setTitle('Appeal Result')
                .setDescription(
                  resultSuccessful
                    ? `Your appeal was approved. Your punishment was lifted.${inviteLine}`
                    : 'Your appeal was approved, but no active mute/ban was found to lift.'
                )
                .setTimestamp();
              await targetUser.send({ embeds: [dmEmbed] }).catch(() => null);
            }
          } catch (e) {}
        } else if (action === 'appeal_reject') {
          resolutionText = `❌ Rejected by ${actor}`;

          try {
            const targetUser = await client.users.fetch(userId).catch(() => null);
            if (targetUser) {
              const dmEmbed = new EmbedBuilder()
                .setColor(0xE74C3C)
                .setTitle('Appeal Result')
                .setDescription('Your appeal was rejected.')
                .setTimestamp();
              await targetUser.send({ embeds: [dmEmbed] }).catch(() => null);
            }
          } catch (e) {}
        } else {
          return interaction.reply({ content: 'Unknown appeal action.', ephemeral: true }).catch(() => null);
        }

        sub.status = isApprove ? 'approved' : 'rejected';
        sub.reviewedBy = interaction.user.id;
        sub.reviewedAt = Date.now();
        appealState.submissions[submissionId] = sub;
        saveAppealState(appealState);

        const newEmbeds = (interaction.message.embeds || []).map((e, idx) => {
          if (idx !== 0) return EmbedBuilder.from(e);
          const b = EmbedBuilder.from(e);
          if (isApprove) {
            b.setColor(0x2ECC71);
          } else {
            b.setColor(0xE74C3C);
          }
          const existingFields = Array.isArray(e.fields) ? e.fields.map(f => ({ name: f.name, value: f.value, inline: !!f.inline })) : [];
          const filtered = existingFields.filter(f => String(f.name || '').toLowerCase() !== 'status');
          b.setFields(...filtered, { name: 'Status', value: resolutionText, inline: false });
          return b;
        });

        const updatedRows = (interaction.message.components || []).map(row => {
          const built = ActionRowBuilder.from(row);
          const mapped = built.components.map(comp => {
            const button = ButtonBuilder.from(comp);
            const cid = String(button.data?.custom_id || '');
            if (cid.startsWith('appeal_approve:') || cid.startsWith('appeal_reject:')) {
              button.setDisabled(true);
            }
            return button;
          });
          return new ActionRowBuilder().addComponents(...mapped);
        });

        await interaction.message.edit({ embeds: newEmbeds, components: updatedRows }).catch(() => null);
      } catch (e) {
        console.error('appeal button handler failed', e);
        try {
          if (interaction.deferred || interaction.replied) {
            return interaction.followUp({ content: 'Could not process appeal action.', ephemeral: true }).catch(() => null);
          }
          return interaction.reply({ content: 'Could not process appeal action.', ephemeral: true }).catch(() => null);
        } catch (err) {
          return null;
        }
      }
    }

    if (interaction.isButton() && (String(interaction.customId || '') === 'dropmap_mark' || String(interaction.customId || '') === 'dropmap_unmark' || String(interaction.customId || '') === 'dropmap_refresh')) {
      try {
        if (!interaction.guild || !interaction.channel) return interaction.reply({ content: 'This only works in a server channel.', ephemeral: true });
        const isDropmapChannel = String(interaction.channel.name || '').toLowerCase().includes('dropmap');
        if (!isDropmapChannel) {
          return interaction.reply({ content: 'This only works in the dropmap channel.', ephemeral: true });
        }

        const member = interaction.member || await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true });

        const channelLobbyMatch = String(interaction.channel?.name || '').match(/lobby[\s_-]*(\d+)/i);
        const lobbyNo = Number(channelLobbyMatch?.[1] || 1);
        const lobbyRoleName = `Lobby${lobbyNo}`;
        const staffRoleName = `${lobbyRoleName} Staffs`;
        const lobbyRole = interaction.guild.roles.cache.find(r => String(r.name || '').toLowerCase() === String(lobbyRoleName).toLowerCase()) || null;
        const staffRole = interaction.guild.roles.cache.find(r => String(r.name || '').toLowerCase() === String(staffRoleName).toLowerCase()) || null;
        const hasLobby = !!(lobbyRole && member.roles.cache.has(lobbyRole.id));
        const hasStaff = !!(staffRole && member.roles.cache.has(staffRole.id));
        const isManager = !!(member.permissions && member.permissions.has(PermissionsBitField.Flags.ManageChannels));
        if (!hasLobby && !hasStaff && !isManager) {
          return interaction.reply({ content: `You need ${lobbyRoleName} (or ${staffRoleName}) to mark in dropmap.`, ephemeral: true });
        }

        if (String(interaction.customId) === 'dropmap_refresh') {
          await interaction.message.edit({
            embeds: [buildDropmapPanelEmbed(interaction.guild.id, interaction.channel.id)],
            components: [buildDropmapPanelRow()],
          }).catch(() => null);
          return interaction.reply({ content: 'Dropmap refreshed.', ephemeral: true });
        }

        if (String(interaction.customId) === 'dropmap_unmark') {
          const removed = removeDropmapClaim(interaction.guild.id, interaction.channel.id, interaction.user.id);
          await interaction.message.edit({
            embeds: [buildDropmapPanelEmbed(interaction.guild.id, interaction.channel.id)],
            components: [buildDropmapPanelRow()],
          }).catch(() => null);
          return interaction.reply({ content: removed ? 'Your mark was removed.' : 'You had no mark set.', ephemeral: true });
        }

        const modal = new ModalBuilder()
          .setCustomId(`dropmap_mark_modal:${interaction.channel.id}:${interaction.message.id}`)
          .setTitle('Dropmap Mark');
        const input = new TextInputBuilder()
          .setCustomId('dropmap_zone')
          .setLabel('Your spot / zone name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('e.g. 2 max / C4 / Pleasant South')
          .setMinLength(1)
          .setMaxLength(40);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      } catch (e) {
        console.error('dropmap button failed', e);
        return interaction.reply({ content: 'Dropmap action failed.', ephemeral: true }).catch(() => null);
      }
    }

    if (interaction.isModalSubmit() && String(interaction.customId || '') === 'staff_apply_modal') {
      try {
        if (!interaction.guild) return interaction.reply({ content: 'This only works in a server.', ephemeral: true });
        const cfg = loadGuildConfig(interaction.guildId);
        const targetId = String(cfg.staffApplyChannelId || interaction.channelId || '').trim();
        const target = (targetId ? (interaction.guild.channels.cache.get(targetId) || await interaction.guild.channels.fetch(targetId).catch(() => null)) : null) || interaction.channel;

        const age = String(interaction.fields.getTextInputValue('age') || '').trim();
        const experience = String(interaction.fields.getTextInputValue('experience') || '').trim();
        const availability = String(interaction.fields.getTextInputValue('availability') || '').trim();
        const motivation = String(interaction.fields.getTextInputValue('motivation') || '').trim();

        const emb = new EmbedBuilder()
          .setColor(0x1E90FF)
          .setTitle('New Staff Application')
          .setDescription(`Applicant: ${interaction.user} (${interaction.user.tag})`)
          .addFields(
            { name: 'Age', value: age || '—', inline: true },
            { name: 'Availability', value: availability || '—', inline: true },
            { name: 'Experience', value: experience || '—', inline: false },
            { name: 'Motivation', value: motivation || '—', inline: false }
          )
          .setThumbnail(interaction.user.displayAvatarURL())
          .setTimestamp();

        const reviewRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`staff_apply_accept:${interaction.user.id}`)
            .setLabel('Accept')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`staff_apply_decline:${interaction.user.id}`)
            .setLabel('Decline')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`staff_apply_info:${interaction.user.id}`)
            .setLabel('User Info')
            .setStyle(ButtonStyle.Primary)
        );

        if (target && target.isTextBased && target.isTextBased()) {
          await target.send({ embeds: [emb], components: [reviewRow] }).catch(() => null);
        }

        return interaction.reply({ content: '✅ Your application has been submitted.', ephemeral: true });
      } catch (e) {
        console.error('staff apply submit failed', e);
        return interaction.reply({ content: 'Application could not be sent.', ephemeral: true }).catch(() => null);
      }
    }

    if (interaction.isModalSubmit() && String(interaction.customId || '').startsWith('dropmap_mark_modal:')) {
      try {
        if (!interaction.guild) return interaction.reply({ content: 'This only works in a server.', ephemeral: true });
        const parts = String(interaction.customId).split(':');
        const channelId = String(parts[1] || interaction.channelId || '');
        const messageId = String(parts[2] || '');
        if (!channelId || !messageId) return interaction.reply({ content: 'Invalid dropmap target.', ephemeral: true });
        const targetChannel = interaction.guild.channels.cache.get(channelId) || await interaction.guild.channels.fetch(channelId).catch(() => null);
        const isDropmapChannel = !!(targetChannel && String(targetChannel.name || '').toLowerCase().includes('dropmap'));
        if (!isDropmapChannel) return interaction.reply({ content: 'Dropmap marks are only allowed in the dropmap channel.', ephemeral: true });

        const zoneRaw = String(interaction.fields.getTextInputValue('dropmap_zone') || '').trim();
        if (!zoneRaw) return interaction.reply({ content: 'Please enter a zone name.', ephemeral: true });
        const zone = zoneRaw.slice(0, 40);

        const claims = getDropmapClaims(interaction.guild.id, channelId);
        const takenBy = Object.entries(claims).find(([uid, z]) => String(uid) !== String(interaction.user.id) && String(z || '').toLowerCase() === zone.toLowerCase());
        if (takenBy) {
          return interaction.reply({ content: `This spot is already marked by <@${takenBy[0]}>.`, ephemeral: true });
        }

        setDropmapClaim(interaction.guild.id, channelId, interaction.user.id, zone);

        const ch = targetChannel;
        if (ch && ch.isTextBased()) {
          const panelMsg = await ch.messages.fetch(messageId).catch(() => null);
          if (panelMsg) {
            await panelMsg.edit({
              embeds: [buildDropmapPanelEmbed(interaction.guild.id, channelId)],
              components: [buildDropmapPanelRow()],
            }).catch(() => null);
          }
        }

        return interaction.reply({ content: `✅ Marked: **${zone}**`, ephemeral: true });
      } catch (e) {
        console.error('dropmap modal failed', e);
        return interaction.reply({ content: 'Failed to save your dropmap mark.', ephemeral: true }).catch(() => null);
      }
    }

    // Create ticket from panel button
    if (interaction.isButton() && typeof interaction.customId === 'string' && (interaction.customId.startsWith('staffpanel_lobby_claim:') || interaction.customId.startsWith('staffpanel_lobby_unclaim:') || interaction.customId.startsWith('staffpanel_toggle:') || interaction.customId.startsWith('staffpanel_claim:') || interaction.customId.startsWith('staffpanel_unclaim:'))) {
      try {
        await interaction.deferReply({ ephemeral: true });
        const parts = String(interaction.customId || '').split(':');
        const isLobbyMode = parts[0] === 'staffpanel_lobby_claim' || parts[0] === 'staffpanel_lobby_unclaim';
        const isToggle = parts[0] === 'staffpanel_toggle';
        const legacyUnclaim = parts[0] === 'staffpanel_unclaim';
        const msgId = String(parts[1] || interaction.message?.id || '');
        const targetSession = isToggle ? Number(parts[2] || 0) : 0;
        if (!msgId || msgId === 'pending') return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Panel not ready yet.')], ephemeral: true });

        const state = preRegStaffPanels.get(msgId);
        if (!state) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Panel expired or not found.')], ephemeral: true });

        const member = interaction.guild ? await interaction.guild.members.fetch(interaction.user.id).catch(() => null) : null;
        const requiredRoleId = String(state.claimRoleId || PRE_REG_CLAIM_ROLE_ID);
        const hasHSRole = !!(member && member.roles && member.roles.cache && member.roles.cache.has(requiredRoleId));
        const isAdmin = !!(member && member.permissions && member.permissions.has(PermissionsBitField.Flags.ManageGuild));
        if (!hasHSRole && !isAdmin) {
          return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Only HS can claim this session.')], ephemeral: true });
        }

        if (!Array.isArray(state.claims)) state.claims = [];

        if (isLobbyMode || String(state.panelType || '') === 'staff-lobby') {
          const uid = String(interaction.user.id);
          const isUnclaim = parts[0] === 'staffpanel_lobby_unclaim';
          const idx = state.claims.indexOf(uid);
          let info = '';

          if (isUnclaim) {
            if (idx === -1) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('You have no claimed lobby to unclaim.')], ephemeral: true });
            state.claims.splice(idx, 1);
            info = 'You unclaimed your lobby.';
          } else {
            if (idx !== -1) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('You already claimed a lobby. Use Unclaim first.')], ephemeral: true });
            state.claims.push(uid);
            info = `You claimed Lobby ${state.claims.length}.`;
          }

          const rows = buildPreRegPanelRow(msgId);
          upsertPreRegPanelState(msgId, state);
          try { await interaction.message.edit({ embeds: [buildPreRegPanelEmbed(state)], components: rows, allowedMentions: { parse: ['users'] } }); } catch (e) {}
          return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(info)], ephemeral: true });
        }

        if (!Array.isArray(state.sessions) || !state.sessions.length) {
          state.sessions = [{
            sessionIndex: Number(state.sessionIndex || 1),
            regTs: Number(state.regTs || 0),
            gameTs: Number(state.gameTs || 0),
            supervisorId: String(state.supervisorId || ((state.claims && state.claims[0]) ? state.claims[0] : '') || ''),
          }];
        }

        const uid = String(interaction.user.id);
        const sessionsSorted = state.sessions.slice().sort((a, b) => Number(a.sessionIndex || 0) - Number(b.sessionIndex || 0));
        const sessionObj = targetSession
          ? sessionsSorted.find(s => Number(s.sessionIndex || 0) === Number(targetSession))
          : sessionsSorted[0];
        if (!sessionObj) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Session not found in this panel.')], ephemeral: true });

        const currentSupervisor = String(sessionObj.supervisorId || '');
        const claimedByUser = sessionsSorted.filter(s => String(s.supervisorId || '') === uid);
        const alreadyClaimedAny = claimedByUser[0] || null;
        const claimedCount = claimedByUser.length;
        const maxClaimsPerUser = Math.max(1, Number(state.maxClaimsPerUser || 1));
        const isUnclaim = isToggle ? !!currentSupervisor : legacyUnclaim;
        let info = '';

        if (isUnclaim) {
          if (!currentSupervisor) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('No HS claimed this session yet.')], ephemeral: true });
          if (currentSupervisor !== uid) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Session already claimed by <@${currentSupervisor}>.`)], ephemeral: true });
          }
          sessionObj.supervisorId = null;
          state.supervisorId = null;
          state.claims = sessionsSorted.filter(s => s.supervisorId).map(s => String(s.supervisorId));
          info = `Session ${sessionObj.sessionIndex} unclaimed.`;
        } else {
          if (currentSupervisor && currentSupervisor !== uid) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Session already claimed by <@${currentSupervisor}>.`)], ephemeral: true });
          }
          if (claimedCount >= maxClaimsPerUser && String(currentSupervisor || '') !== String(uid || '')) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`You can claim maximum ${maxClaimsPerUser} sessions.`)], ephemeral: true });
          }
          if (currentSupervisor === uid || (alreadyClaimedAny && Number(alreadyClaimedAny.sessionIndex || 0) === Number(sessionObj.sessionIndex || 0))) {
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`You already claimed Session ${sessionObj.sessionIndex}.`)], ephemeral: true });
          }
          sessionObj.supervisorId = uid;
          state.supervisorId = uid;
          state.claims = sessionsSorted.filter(s => s.supervisorId).map(s => String(s.supervisorId));
          info = `You claimed Session ${sessionObj.sessionIndex}.`;
        }

        const rows = buildPreRegPanelRow(msgId);
        upsertPreRegPanelState(msgId, state);
        try { await interaction.message.edit({ embeds: [buildPreRegPanelEmbed(state)], components: rows, allowedMentions: { parse: ['users'] } }); } catch (e) {}
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(info)], ephemeral: true });
      } catch (e) {
        console.error('staff panel button failed', e);
        try { return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription('Failed to update staff panel.')], ephemeral: true }); } catch (ee) { return; }
      }
    }

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
            const serverName = interaction.guild && interaction.guild.name ? String(interaction.guild.name) : 'this server';
            const dmEmbed = new EmbedBuilder().setTitle('Session claim confirmed').setColor(0x87CEFA).setDescription(`You have claimed the session in **${serverName}**.`).setTimestamp();
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
          const mode = (sess && sess.mode)
            ? String(sess.mode).toLowerCase()
            : resolveAnnouncementModeForSession(data.raw, data.originChannelId || interaction.channelId, sessionIndex);

          // Prefer the selected session timestamps to ensure Announce Sx uses the correct time
          let gameTs = null;
          let regTs = null;
          if (sess && sess.start) {
            regTs = Math.floor(sess.start / 1000);
            const maybeEndTs = Math.floor(Number(sess.end || 0) / 1000);
            gameTs = (Number.isFinite(maybeEndTs) && maybeEndTs > regTs) ? maybeEndTs : (regTs + (10 * 60));
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
          let staffMentions = normalizeStaffMentions((sess && sess.staff) ? sess.staff : '');
          if (isGenericStaffPlaceholder(staffMentions)) {
            const m = String(data.raw || '').match(/<@!?(\d+)>/);
            if (m) staffMentions = `<@${m[1]}>`;
          }
          if (isGenericStaffPlaceholder(staffMentions)) {
            staffMentions = `<@${interaction.user.id}>`;
          }
          if (isGenericStaffPlaceholder(staffMentions)) {
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

        // DM the announcement to the clicker (chunked to respect Discord 2000-char limit)
        try {
          const safeContent = String(contentToSend || '').substring(0, 8000);
          await sendChunkedDM(interaction.user, safeContent, 2000);
          await interaction.editReply({ content: 'Announcement sent via DM.', ephemeral: true });
          try {
            const emb = new EmbedBuilder()
              .setTitle('Session announced (DM)')
              .setColor(0x87CEFA)
              .addFields(
                { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
                { name: 'Session', value: `${sessionIndex || 'n/a'}`, inline: true }
              )
              .setTimestamp();
            await sendSessionsLog({ embeds: [emb] }, interaction.guildId);
            await sendMessageLog(emb, interaction.guildId);
          } catch (e) { console.error('failed to log announce DM', e); }
        } catch (e) {
          console.error('failed to DM announcement', e);
          // Fallback: show the content ephemerally (no mention parsing) so it can be copied
          try {
            const safeContent = String(contentToSend || '').substring(0, 8000);
            const parts = splitDiscordMessage(safeContent, 2000);
            await interaction.editReply({
              content: 'Could not send you a DM (DMs might be closed or the bot is blocked). Here is the text to copy:',
              ephemeral: true,
              allowedMentions: { parse: [] }
            });
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i];
              if (!part) continue;
              await interaction.followUp({ content: part, ephemeral: true, allowedMentions: { parse: [] } }).catch(()=>null);
            }
          } catch (ee) {
            return interaction.editReply({ content: 'Failed to send the announcement via DM.', ephemeral: true });
          }
        }

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
            if (isGenericStaffPlaceholder(staffMentions)) {
              staffMentions = `<@${interaction.user.id}>`;
            }
            if (isGenericStaffPlaceholder(staffMentions)) {
              const cfg2 = loadGuildConfig(data.guildId);
              if (cfg2 && cfg2.staffRoleId) staffMentions = `<@&${String(cfg2.staffRoleId).replace(/[<@&>]/g,'')}>`;
              else staffMentions = '@staff';
            }
            if (!regTs) regTs = Math.floor(Date.now()/1000);
            if (!gameTs) gameTs = regTs + (15 * 60);

            // determine mode (alpha|beta|champ) using config tracks mapping, fallback to raw text
            const mode = (data.parsed && Array.isArray(data.parsed) && data.parsed[0] && data.parsed[0].mode)
              ? String(data.parsed[0].mode).toLowerCase()
              : resolveAnnouncementModeForSession(data.raw, data.originChannelId || interaction.channelId, null);

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

        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`ticket_close_vanta_confirm:${channel.id}`)
            .setLabel('Yes, close ticket')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`ticket_close_vanta_cancel:${channel.id}`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
        );

        return interaction.editReply({ content: 'Are you sure you want to close this ticket? This will delete all channels in this ticket category and the category itself.', components: [confirmRow] });
      } catch (e) {
        console.error('ticket_close confirm prompt failed', e);
        return interaction.editReply('Failed to open close confirmation.');
      }
    }

    if (interaction.isButton() && String(interaction.customId || '').startsWith('ticket_close_vanta_cancel:')) {
      const expectedChannelId = String(interaction.customId || '').split(':')[1] || '';
      if (expectedChannelId && String(interaction.channelId || '') !== String(expectedChannelId)) {
        return interaction.reply({ content: 'This confirmation is no longer valid for this channel.', ephemeral: true });
      }
      return interaction.reply({ content: 'Ticket close canceled.', ephemeral: true });
    }

    if (interaction.isButton() && String(interaction.customId || '').startsWith('ticket_close_vanta_confirm:')) {
      await interaction.deferReply({ ephemeral: true });
      try {
        const channel = interaction.channel;
        if (!channel || !channel.topic || !channel.topic.startsWith('ticket:')) return interaction.editReply('This button can only be used in ticket channels.');
        const expectedChannelId = String(interaction.customId || '').split(':')[1] || '';
        if (expectedChannelId && String(channel.id) !== String(expectedChannelId)) {
          return interaction.editReply('This confirmation is no longer valid for this channel.');
        }
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
        try { const owner = await interaction.client.users.fetch(ownerId).catch(()=>null); if (owner) await owner.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setTitle('Your ticket has been closed').setDescription(`In **${interaction.guild && interaction.guild.name ? interaction.guild.name : 'this server'}**\nReason: ${reason}`)], files: [txtPath].filter(Boolean) }).catch(()=>{}); } catch (e) {}

        // remove all channels in ticket category and remove category itself
        try {
          const parent = channel.parent && channel.parent.type === 4 ? channel.parent : null;
          if (parent) {
            const children = interaction.guild.channels.cache.filter(c => c && c.parentId === parent.id);
            for (const child of children.values()) {
              await child.delete().catch(()=>{});
            }
            await parent.delete().catch(()=>{});
          } else {
            await channel.delete().catch(()=>{});
          }
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
  const serverName = (guild && guild.name) ? String(guild.name) : 'this server';

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
  const reasonLooksPermanent = /(^|\b)perm(?:anent)?\b/i.test(r);
  const durationLooksPermanent = /(\bperm(?:anent)?\b)/i.test(String(durationText || ''));
  const isPermanent = reasonLooksPermanent || durationLooksPermanent;

  const inferredDuration = (() => {
    if (durationText && String(durationText).trim()) return String(durationText).trim();
    if (!r) return '';
    const m = r.match(/\b(\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|year|years))\b/i);
    return m ? String(m[1]).trim() : '';
  })();

  const reasonText = r ? String(r).trim() : '';
  const reasonWithPunctuation = reasonText
    ? (/[.!?]$/.test(reasonText) ? reasonText : `${reasonText}.`)
    : '';
  const hideReasonForAction = lt.includes('unmute') || lt.includes('unban');

  let desc = `You ${actionPhrase} in **${serverName}**`;
  if (!isPermanent && inferredDuration) desc += ` for ${inferredDuration}`;
  if (!hideReasonForAction && reasonWithPunctuation) {
    desc += ` for the reason: ${reasonWithPunctuation}`;
  } else {
    desc += '.';
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(desc)
    .setTimestamp();

  const isBanAction = lt.includes('ban') && !lt.includes('unban');
  const isMuteAction = lt.includes('mute') && !lt.includes('unmute');

  if (isBanAction || isMuteAction) {
    try {
      appealState = loadAppealState();
      const uid = String(user.id);
      appealState.invites[uid] = {
        guildId: guild && guild.id ? String(guild.id) : null,
        actionType: isBanAction ? 'Ban' : 'Mute',
        caseId: caseId || null,
        createdAt: Date.now(),
      };
      saveAppealState(appealState);

      const kind = isBanAction ? 'b' : 'm';
      const safeCase = (caseId !== null && caseId !== undefined && /^\d+$/.test(String(caseId))) ? String(caseId) : '0';
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`appeal_open:${uid}:${kind}:${safeCase}`)
          .setLabel('Appeal')
          .setStyle(ButtonStyle.Primary)
      );
      return user.send({ embeds: [embed], components: [row] }).catch(() => null);
    } catch (e) {
      return user.send({ embeds: [embed] }).catch(() => null);
    }
  }

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
  const modText = moderatorId ? `<@${moderatorId}> (${moderatorId})` : 'Unknown';

  const metaBits = [];
  metaBits.push(`Moderator: ${modText}`);
  if (durationText) metaBits.push(`Duration: ${String(durationText).substring(0, 120)}`);
  metaBits.push(`Time: <t:${ts}:R>`);

  const embed = new EmbedBuilder()
    .setTitle(title || 'Moderation')
    .setDescription(
      targetId
        ? `<@${targetId}>${reasonShort ? `\nReason: ${reasonShort}` : ''}\n${metaBits.join(' | ')}`
        : `${reasonShort ? `Reason: ${reasonShort}\n` : ''}${metaBits.join(' | ')}`
    )
    .setColor(0x87CEFA);

  if (targetAvatarUrl) embed.setThumbnail(targetAvatarUrl);

  const footerBits = [];
  if (targetId) footerBits.push(`UserID: ${targetId}`);
  if (caseId !== undefined && caseId !== null) footerBits.push(`Case: ${caseId}`);
  if (footerBits.length) embed.setFooter({ text: footerBits.join(' | ') });
  return embed;
}

function createChannelConfirmEmbed(text, caseId, userId = null, color = 0x87CEFA) {
  const when = Date.now();
  const footerText = `${formatFooterTime(when)}${userId ? ` | UserID: ${userId}` : ''}`;
  const raw = String(text || '');
  const isFailureText = /(^\s*usage\s*:|\bfailed\b|\berror\b|cannot\s+moderate|\bcannot\b|not\s+found|no\s+permission|only\s+admins\s+can|not\s+allowed|must\s+be\s+used|provide\s+a\s+valid|please\s+provide|invalid|unknown\s+subcommand|unknown\s+command|disabled|missing\s+permissions?)/i.test(raw);
  const effectiveColor = (color === 0x87CEFA && isFailureText) ? 0xE74C3C : color;
  return new EmbedBuilder()
    .setColor(effectiveColor)
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
  try { initPreRegScheduler(); } catch (e) {}
  try { initPreRegPanelStates(); } catch (e) {}
  try { initTempBanScheduler(); } catch (e) {}
  try { refreshDynamicCommands(true).catch(() => {}); } catch (e) {}
  try {
    if (dynamicCommandsRefreshTimer) clearInterval(dynamicCommandsRefreshTimer);
    dynamicCommandsRefreshTimer = setInterval(() => {
      refreshDynamicCommands(false).catch(() => {});
    }, DYNAMIC_COMMANDS_REFRESH_MS);
  } catch (e) {}
  try { startDynamicCommandsWebhookServer(); } catch (e) {}

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
    if (isLogsDisabledForGuildId(guild.id)) return;
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
    if (!ch && category === 'wheel') {
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
    if (isLogsDisabledForGuildId(guild.id)) return false;
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

        // Do not create cases/logs for Discord AutoMod "Posting link". This is server-side automod
        // and should be disabled in Discord settings if you want to stop the timeout itself.
        try {
          if (/\bposting\s+link\b/i.test(String(reason || ''))) {
            return;
          }
        } catch (e) {}

        // Avoid duplicates when the bot executed the mute/unmute command (that already created a case)
        const dedupeType = isTimedOut ? 'Mute' : 'Unmute';
        if (!hasRecentModAction(newMember.guild.id, dedupeType, newMember.id, moderatorId)) {
          const nowTs = Math.floor(Date.now() / 1000);
          const targetUser = newMember.user;
          if (isTimedOut) {
            let durationMs = (newTs - now);
            let caseId = null;

            // If this timeout was executed by AutoMod (common for link/racism automod),
            // we already created an AutoMute case elsewhere. Reuse it to avoid duplicate cases.
            try {
              if (reason && /\bautomod\b/i.test(String(reason))) {
                const nowMs = Date.now();
                const cases = (modlogs && Array.isArray(modlogs.cases)) ? modlogs.cases : [];
                for (let i = cases.length - 1; i >= 0; i--) {
                  const c = cases[i];
                  if (!c) continue;
                  if (String(c.guildId || '') !== String(newMember.guild.id)) continue;
                  if (String(c.user || '') !== String(newMember.id)) continue;
                  if (!['AutoMute', 'Mute'].includes(String(c.type || ''))) continue;
                  if (!c.time || (nowMs - Number(c.time)) > 30_000) break;
                  caseId = c.caseId ?? null;
                  if (typeof c.durationMs === 'number' && c.durationMs > 0) durationMs = c.durationMs;
                  break;
                }
              }
            } catch (e) {}

            if (!caseId) {
              caseId = createModlogCase({
                guild: newMember.guild,
                type: 'Mute',
                userId: newMember.id,
                moderatorId,
                reason,
                durationMs
              });
            }

            const durationText = `${Math.max(1, Math.ceil(durationMs / 60000))} minutes`;
            const embed = buildSmallModerationEmbed({
              title: 'User timed out',
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
              title: 'User unmuted',
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
      let entry = null;
      if (logs && logs.entries) {
        entry = logs.entries.find(e => e && e.target && String(e.target.id) === String(ban.user.id) && (Date.now() - e.createdTimestamp) < 15000);
      }
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
      title: 'User banned',
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
      title: 'User unbanned',
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
// WheelGame instances per channel: channelId -> game state
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
        {
          name: 'Meta',
          value: `ID: ${message.id}\nChannel: ${message.channelId ? `<#${message.channelId}>` : 'Unknown'}\nTime: <t:${nowTs}:R>`,
          inline: false
        },
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
          const isPreRegSource = PRE_REG_ANNOUNCE_SOURCE_CHANNEL_IDS.has(String(channelId || ''));
          const isWatched = channelId ? loadWatchChannels(guild.id).has(String(channelId)) : false;
          const looksLikeSession = /\b\d+\s*[\.)-]\s*[0-2]?\d[:.][0-5]\d\s*(?:-|–|—|to)\s*[0-2]?\d[:.][0-5]\d\b|registration\s*opens|game\s*1\/3|duo\s*practice\s*session|<t:\d+:t>/i.test(editedContent);
          const nameLooksLikeSession = /(alpha|beta|session|sessions|claim|claiming)/i.test(channelName);
          if (!existing && (isWatched || isPreRegSource || (looksLikeSession && nameLooksLikeSession))) {
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
      .setTitle('Multiple messages deleted')
      .setColor(0x87CEFA)
      .addFields(
        { name: 'Channel', value: channel && channel.id ? `<#${channel.id}>` : 'Unknown', inline: true },
        { name: 'Count', value: `${count}`, inline: true },
        { name: 'Time', value: `<t:${nowTs}:R>`, inline: false }
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

  try {
    const rawPrefixGate = String(message.content || '').trim();
    if (rawPrefixGate && /^[*!&-]/.test(rawPrefixGate)) {
      if (!hasStaffCommandAccess(message)) return;
    }
  } catch (e) {}

  // Natural-language helper: users ask where to put Discord bot token
  try {
    const rawMsg = String(message.content || '').trim();
    if (rawMsg) {
      const norm = rawMsg.toLowerCase();
      const asksToken = /\b(token|bot\s*token|discord\s*token)\b/i.test(norm);
      const asksLocation = /\b(where|wo|ist|is|env|\.env|token\.txt|config\.json|direct|direction|put|rein|eintragen|paste)\b/i.test(norm);
      const mentionsBot = Boolean(client?.user?.id) && Boolean(message.mentions?.users?.has?.(client.user.id));

      if (asksToken && (asksLocation || mentionsBot)) {
        const guide = new EmbedBuilder()
          .setColor(0x87CEFA)
          .setTitle('Discord Bot Token Setup')
          .setDescription('Use one of these methods:')
          .addFields(
            { name: '1) .env (preferred)', value: 'Create `.env` in project root and add:\n`DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN`', inline: false },
            { name: '2) token.txt', value: 'Create `token.txt` in project root with only the token in one line.', inline: false },
            { name: '3) Optional env vars', value: '`TOKEN`, `TOKENSP`, `DISCORD_BOT_TOKEN`, `BOT_TOKEN` also work.', inline: false },
            { name: 'After change', value: 'Restart bot (`npm start`). Staff can run `*env` to see token source.', inline: false },
          )
          .setFooter({ text: 'Never post your real token in chat. Regenerate it if leaked.' })
          .setTimestamp();

        await message.reply({ embeds: [guide], allowedMentions: { parse: [] } }).catch(() => null);
        return;
      }
    }
  } catch (e) {
    console.error('token helper failed', e);
  }

  // Prefix command: *va / *voiceactivity [1d|7d|30d]
  try {
    const rawVa = (message.content || '').trim();
    if (message.guild && rawVa.startsWith(PREFIX)) {
      const parts = rawVa.slice(PREFIX.length).trim().split(/\s+/);
      const cmd = String(parts.shift() || '').toLowerCase();
      if (!(await enforceRoleCommandAccess(message, cmd))) return;
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
      if (!message.guild) return replyAsEmbed(message, 'This command can only be used in a server.');

      const isStaff = hasStaffCommandAccess(message);

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
        .setDescription(`Server: **${message.guild.name}**\n\n${dmText.substring(0, 3800)}`)
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

      const isStaff = hasStaffCommandAccess(message);
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
      if (!message.guild) return replyAsEmbed(message, 'This command can only be used in a server.');
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

  // Prefix command: !dp -> quick help ping
  try {
    const rawDp = String(message.content || '').trim().toLowerCase();
    if (rawDp === '!dp' || rawDp === '.!dp') {
      try { await message.delete().catch(() => null); } catch (e) {}
      return message.channel.send({
        content: `Need help? DM or ping <@${message.author.id}>`,
        allowedMentions: { users: [message.author.id] }
      });
    }
  } catch (e) { console.error('dp command failed', e); }

  // Prefix command: !db -> Yunite dashboard link
  try {
    const rawDb = String(message.content || '').trim().toLowerCase();
    if (rawDb === '!db' || rawDb === '.!db') {
      const dbEmbed = new EmbedBuilder()
        .setColor(0x1E90FF)
        .setTitle('Yunite Dashboard')
        .setDescription('Here is the link:\nhttps://dash.yunite.xyz/guilds')
        .setTimestamp();

      return message.channel.send({ embeds: [dbEmbed] });
    }
  } catch (e) { console.error('db command failed', e); }

  // Prefix command: !uploads (or <PREFIX>uploads) -> post replay upload panel
  try {
    const rawUploads = String(message.content || '').trim().toLowerCase();
    const uploadsCmdA = `${String(PREFIX || '*').toLowerCase()}uploads`;
    const uploadsCmdB = '!uploads';
    const uploadsCmdC = '!upload';
    if (rawUploads === uploadsCmdA || rawUploads === uploadsCmdB || rawUploads === uploadsCmdC || rawUploads === '.!uploads' || rawUploads === '.!upload') {
      try { await message.delete().catch(() => null); } catch (e) {}
      const uploadEmbed = new EmbedBuilder()
        .setColor(0x1E90FF)
        .setTitle('Upload Your Replay')
        .setDescription('If you want to appear in the leaderboard, please upload your replay')
        .setTimestamp();

      const uploadBtn = new ButtonBuilder()
        .setLabel('Upload Replay')
        .setStyle(ButtonStyle.Link)
        .setURL('https://yunite.xyz/replays');

      const row = new ActionRowBuilder().addComponents(uploadBtn);
      return message.channel.send({ embeds: [uploadEmbed], components: [row] });
    }
  } catch (e) { console.error('uploads command failed', e); }

  // Prefix command: !invite (or <PREFIX>invite) -> post community invite panel
  try {
    const rawInvite = String(message.content || '').trim().toLowerCase();
    const inviteCmdA = `${String(PREFIX || '*').toLowerCase()}invite`;
    const inviteCmdB = '!invite';
    if (rawInvite === inviteCmdA || rawInvite === inviteCmdB || rawInvite === '.!invite') {
      const inviteEmbed = new EmbedBuilder()
        .setColor(0x1E90FF)
        .setTitle('Invite Your Friends')
        .setDescription('Invite your friends and grow the community together!\nhttps://discord.gg/SGg8dMpq55')
        .setTimestamp();

      const inviteBtn = new ButtonBuilder()
        .setLabel('Invite Friends')
        .setStyle(ButtonStyle.Link)
        .setURL('https://discord.gg/SGg8dMpq55');

      const row = new ActionRowBuilder().addComponents(inviteBtn);
      return message.channel.send({ embeds: [inviteEmbed], components: [row] });
    }
  } catch (e) { console.error('invite panel command failed', e); }

  // Auto-mod (legacy path): prevent users with blocked roles from posting *invite links*.
  // Link automod is disabled by default; do not delete messages just for containing generic URLs.
  if (message.guild && message.member) {
    try {
      if (isAutomodDisabledForGuild(message.guild.id)) {
        // Automod disabled for this guild.
      } else {
      const cfg = AUTOMOD_CONFIG;
      if (!cfg || !cfg.blockInviteLinks) {
        // Explicitly disabled: do nothing here.
        // (Racist-content deletion is handled in the central automod handler.)
      } else {
        const isExempt = message.member.permissions.has(PermissionsBitField.Flags.ManageGuild) || message.member.permissions.has(PermissionsBitField.Flags.ManageMessages) || message.member.permissions.has(PermissionsBitField.Flags.ManageChannels) || message.member.permissions.has(PermissionsBitField.Flags.ManageRoles);
        const hasBlocked = cfg.blockedRoles && cfg.blockedRoles.length && message.member.roles.cache.some(r => cfg.blockedRoles.includes(r.name));
        const hasAllowed = cfg.allowedRoles && cfg.allowedRoles.length && message.member.roles.cache.some(r => cfg.allowedRoles.includes(r.name));
        if (hasBlocked && !hasAllowed && !isExempt && message.content) {
          const inviteRe = /(discord(?:\.gg|app\.com\/invite)\/[A-Za-z0-9-]+)/i;
          if (inviteRe.test(message.content)) {
            try { await message.delete().catch(() => {}); } catch (e) {}

            const muteMs = Math.max(0, (cfg.muteMinutes || 2) * 60 * 1000);
            const reason = 'Posting invite link';

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

            if (timedOut) markRecentModAction(message.guild?.id, 'Mute', message.author.id, '*');

            // Send a compact DM to the user (only if we actually timed out)
            if (timedOut) {
      }
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
      }
    } catch (e) {
      console.error('automod check failed', e);
    }
  }

  // Blacklist command starts with dash
  if (message.content.startsWith('-')) {
    const [cmd, ...rest] = message.content.slice(1).trim().split(/\s+/);
    const lcmd = String(cmd || '').toLowerCase();
    if (!(await enforceRoleCommandAccess(message, lcmd))) return;
    if (lcmd === 'purg' || lcmd === 'purge') {
      if (!message.member?.roles?.cache?.has?.(ADMIN_COMMAND_ROLE_ID)) return replyAsEmbed(message, 'Only admins can use `-purg`/`-purge`.');
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
            .setTitle('Messages deleted (Purge)')
            .setColor(0x87CEFA)
            .addFields(
              { name: 'Count', value: `${deletedTotal}`, inline: true },
              { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
              { name: 'Time', value: `<t:${nowTs}:R>`, inline: true }
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
      {
        const targetMember = message.guild ? await message.guild.members.fetch(String(targetId)).catch(() => null) : null;
        if (memberHasProtectedModerationRole(targetMember)) return replyCannotModerateUser(message, targetMember.user || targetId);
      }
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
          .setTitle('Messages deleted (Purge)')
          .setColor(0x87CEFA)
          .addFields(
            { name: 'Target', value: `<@${targetId}>`, inline: true },
            { name: 'Count', value: `${deletedTotal}`, inline: true },
            { name: 'Moderator', value: `<@${message.author.id}>`, inline: true },
            { name: 'Time', value: `<t:${nowTs}:R>`, inline: true }
          );
        await sendLog(message.guild, { embeds: [logEmbed], category: 'moderation' }).catch(()=>{});
      } catch (e) {
        console.error('purg command failed', e);
        return replyAsEmbed(message, 'Failed to purge messages.');
      }
      return;
    }
    if (cmd.toLowerCase() === 'blacklist') {
      if (!hasAdminCommandAccess(message)) return replyAsEmbed(message, 'Only admins can use `-blacklist`.');
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
      const targetGuildIds = Array.from(new Set([
        String(message.guild && message.guild.id ? message.guild.id : ''),
        '1236461630372450384',
        EXTRA_BLACKLIST_TARGET_GUILD_ID,
      ].filter(Boolean)));

      if (await userHasProtectedModerationRoleInGuilds(id, targetGuildIds)) {
        return replyCannotModerateUser(message, id);
      }

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
        .setColor(0xED4245)
        .setTitle('Blacklist')
        .setDescription(
          `**User:** ${id}\n` +
          `**Reason:** ${reason.substring(0, 256)}\n` +
          `**Banned by:** <@${message.author.id}>\n\n` +
          `**Success:** ${success} servers\n` +
          `**Failed:** ${failed} servers`
        )
        .setTimestamp()
        .setFooter(buildFooter(message.guild));

      if (existingEntry) {
        embed.setDescription('Already blacklisted — re-running bans in target servers.');
      }

      // Do not list individual server results here; only counts are shown.
      return message.channel.send({ embeds: [embed] });
    }

    if (cmd.toLowerCase() === 'dblacklist' || cmd.toLowerCase() === 'dbacklist') {
      if (!hasAdminCommandAccess(message)) return;
      const id = parseId(rest[0]) || rest[0];
      const reason = rest.slice(1).join(' ') || 'No reason provided';
      if (!id || !/^\d+$/.test(id)) return replyAsEmbed(message, 'Please provide a valid user ID to dice-blacklist.');
      if (await userHasProtectedModerationRoleInGuilds(id, [String(message.guild && message.guild.id ? message.guild.id : '')])) return replyCannotModerateUser(message, id);

      if (!blacklist || typeof blacklist !== 'object') blacklist = { blacklisted: [] };
      if (!Array.isArray(blacklist.diceBlacklisted)) blacklist.diceBlacklisted = [];

      const existing = blacklist.diceBlacklisted.find(b => b && String(b.id) === String(id));
      if (existing) {
        existing.reason = reason;
        existing.moderator = message.author.id;
        existing.time = Date.now();
      } else {
        blacklist.diceBlacklisted.push({ id, reason, moderator: message.author.id, time: Date.now() });
      }
      saveJson(BLACKLIST_PATH, blacklist);

      const embed = new EmbedBuilder()
        .setColor(0x87CEFA)
        .setTitle('Dice Blacklist')
        .setDescription(`User <@${id}> (${id}) kann *dice nicht mehr nutzen.`)
        .addFields(
          { name: 'Reason', value: reason.substring(0, 256), inline: true },
          { name: 'Moderator', value: `<@${message.author.id}>`, inline: true }
        )
        .setTimestamp()
        .setFooter(buildFooter(message.guild));

      return message.channel.send({ embeds: [embed] });
    }

    if (cmd.toLowerCase() === 'destaff' || cmd.toLowerCase() === 'destaffban') {
      if (!hasAdminCommandAccess(message)) return;
      const id = parseId(rest[0]) || rest[0];
      const reason = rest.slice(1).join(' ') || 'No reason provided';
      if (!id || !/^\d+$/.test(id)) return replyAsEmbed(message, 'Please provide a valid user ID or mention.');

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

      const hasAnyRemoved = removedRoles.length > 0;
      const hasAnyFailure = failedRoles.length > 0 || errors.length > 0;
      const status = hasAnyRemoved && !hasAnyFailure
        ? 'success'
        : (hasAnyRemoved && hasAnyFailure ? 'partial' : 'failed');
      const replyColor = status === 'success' ? 0x2ECC71 : 0xE74C3C;

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

      // Reply to executor: only fully successful removals are shown as success
      const replyEmbed = new EmbedBuilder()
        .setColor(replyColor)
        .setDescription(
          status === 'success'
            ? '✅ Destaff successful.'
            : (status === 'partial' ? '❌ Destaff partially failed (not all roles were removed).' : '❌ Destaff failed.')
        );

      const issueLines = [];
      if (!hasAnyRemoved) issueLines.push('No matching staff/admin roles were removed.');
      if (failedRoles.length) issueLines.push(`Failed roles: ${failedRoles.join(', ')}`);
      if (errors.length) issueLines.push(...errors);
      if (issueLines.length) {
        replyEmbed.addFields({ name: 'Issues', value: issueLines.join('\n').substring(0, 1024), inline: false });
      }

      await message.reply({ embeds: [replyEmbed] }).catch(() => {});
      return;
    }

    if (cmd.toLowerCase() === 'unbll') {
      if (!hasAdminCommandAccess(message)) return;
      const id = parseId(rest[0]) || rest[0];
      if (!id || !/^\d+$/.test(id)) return replyAsEmbed(message, 'Please provide a valid user ID.');

      const targetGuildIds = Array.from(new Set([
        String(message.guild && message.guild.id ? message.guild.id : ''),
        '1236461630372450384',
        EXTRA_BLACKLIST_TARGET_GUILD_ID,
      ].filter(Boolean)));
      if (await userHasProtectedModerationRoleInGuilds(id, targetGuildIds)) return replyCannotModerateUser(message, id);

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

    if (cmd.toLowerCase() === 'dunbll' || cmd.toLowerCase() === 'dunblacklist') {
      if (!hasAdminCommandAccess(message)) return;
      const id = parseId(rest[0]) || rest[0];
      if (!id || !/^\d+$/.test(id)) return replyAsEmbed(message, 'Please provide a valid user ID.');
      if (await userHasProtectedModerationRoleInGuilds(id, [String(message.guild && message.guild.id ? message.guild.id : '')])) return replyCannotModerateUser(message, id);

      if (!blacklist || typeof blacklist !== 'object') blacklist = { blacklisted: [] };
      if (!Array.isArray(blacklist.diceBlacklisted)) blacklist.diceBlacklisted = [];

      const idx = blacklist.diceBlacklisted.findIndex(b => String(b.id) === String(id));
      if (idx === -1) return replyAsEmbed(message, 'This ID is not in the dice blacklist.');

      blacklist.diceBlacklisted.splice(idx, 1);
      saveJson(BLACKLIST_PATH, blacklist);

      const embed = new EmbedBuilder()
        .setColor(0x87CEFA)
        .setTitle('Dice Unblacklist')
        .setDescription(`User <@${id}> (${id}) kann *dice wieder nutzen.`)
        .addFields({ name: 'Removed by', value: `<@${message.author.id}>`, inline: true })
        .setTimestamp()
        .setFooter(buildFooter(message.guild));

      return message.channel.send({ embeds: [embed] });
    }

    if (cmd.toLowerCase() === 'bll') {
      if (!hasStaffCommandAccess(message)) return;
      if (!blacklist.blacklisted.length) return replyAsEmbed(message, 'Blacklist is empty.');

      const arg = rest[0] ? (parseId(rest[0]) || rest[0]) : null;
      if (arg && /^\d+$/.test(String(arg))) {
        const entry = blacklist.blacklisted.find(b => String(b.id) === String(arg));
        if (!entry) return replyAsEmbed(message, 'This user is not in the blacklist.');

        const embed = new EmbedBuilder()
          .setTitle('Blacklist Log')
          .setColor(0xF1C40F)
          .setDescription(
            `**User ID:** ${entry.id}\n` +
            `**Reason:** ${String(entry.reason || 'No reason provided').substring(0, 256)}\n` +
            `**Staff:** ${entry.moderator ? `<@${entry.moderator}>` : 'n/a'}${entry.moderator ? ` - ${entry.moderator}` : ''}\n` +
            `**Date:** ${entry.time ? `<t:${Math.floor(entry.time / 1000)}:F>` : 'n/a'}`
          )
          .setTimestamp()
          .setFooter(buildFooter(message.guild));

        return message.channel.send({ embeds: [embed] });
      }

      const embed = new EmbedBuilder()
        .setTitle('Blacklist Logs')
        .setColor(0xF1C40F)
        .setFooter({ text: `Total: ${blacklist.blacklisted.length}` })
        .setTimestamp();

      for (const b of blacklist.blacklisted.slice(0, 10)) {
        const moderator = b.moderator ? `<@${b.moderator}>` : 'n/a';
        const reason = b.reason || 'No reason provided';
        embed.addFields({
          name: `User: ${b.id}`,
          value: `Reason: ${String(reason).substring(0, 256)}\nStaff: ${moderator}\nDate: ${b.time ? `<t:${Math.floor(b.time / 1000)}:F>` : 'n/a'}`.substring(0, 1024)
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
      if (!hasStaffCommandAccess(message)) return;
      reloadModlogs();
      const parts = message.content.slice(1).trim().split(/\s+/);
      // parts[0] is md or mds
      const cmd = parts[0].toLowerCase();
      if (cmd === 'mds') return;
      if (!message.guild || String(message.guild.id) !== MODLOGS_SERVER_ONLY_ID) return;
      const userArg = parts[1] || message.author.id;
      const pageArg = parseInt(parts[2], 10) || 1;
      const perPage = cmd === 'mds' ? 8 : 5;
      // resolve simple id/mention
      const uid = (userArg || '').replace(/[<@!>]/g, '').trim();
      const targetId = uid || message.author.id;

      // Only show logs for the allowed server.
      const currentGuildId = String(message.guild.id);

      let cases = (modlogs && modlogs.cases) ? Array.from(modlogs.cases) : [];
      cases = cases.filter(c => c && String(c.user) === String(targetId) && c.guildId && String(c.guildId) === currentGuildId);

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
      let userLabel = String(targetId);
      try {
        const tu = await client.users.fetch(String(targetId)).catch(() => null);
        if (tu) userLabel = `${tu.username}.`;
      } catch (e) {}
      const embed = new EmbedBuilder()
        .setTitle(`Modlogs for ${userLabel}`)
        .setColor(0x87CEFA)
        .setTimestamp();
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
        const typeLine = `Type: ${displayCaseType(c.type)}${dur}`;
        const reasonLine = `Reason: ${String(c.reason || '—')}${date ? ' - ' + date : ''}`;

        // If this case came from another guild, show origin server.
        let originLine = '';
        try {
          const gid = c.guildId ? String(c.guildId) : '';
          if (gid && gid !== currentGuildId) {
            const g = client.guilds.cache.get(gid) || null;
            originLine = `Server: ${g ? `${g.name} (${gid})` : gid}`;
          }
        } catch (e) {}

        embed.addFields({ name: `Case ${c.caseId}`, value: `${typeLine}${originLine ? `\n${originLine}` : ''}\nModerator: ${moderatorDisplay}\n${reasonLine}`, inline: false });
      }
      embed.setFooter({ text: `Page ${page}/${totalPages} — Showing ${pageCases.length} of ${cases.length}` });
      return message.channel.send({ embeds: [embed] });
    } catch (e) { console.error('md viewer failed', e); }
  }

  // Admin modlog edits / views via * commands
  // Important: do NOT swallow unrelated *commands (e.g. *dice) — let the main prefix handler process them.
  if (message.content.startsWith('*')) {
    const [cmd, ...rest] = message.content.slice(1).trim().split(/\s+/);
    if (!cmd) return;
    const cmdLower = String(cmd).toLowerCase();

    const MODLOG_STAR_COMMANDS = new Set([
      'reason',
      'duration',
      'dcase',
      'delcase',
      'deletecase',
      'moderations',
      'case',
    ]);

    if (!MODLOG_STAR_COMMANDS.has(cmdLower)) {
      // Not handled here; continue to other handlers.
    } else {
      if (!message.guild || String(message.guild.id) !== MODLOGS_SERVER_ONLY_ID) return;
      const needsAdmin = (cmdLower === 'dcase' || cmdLower === 'delcase' || cmdLower === 'deletecase');
      if (needsAdmin) {
        if (!hasAdminCommandAccess(message)) return;
      } else {
        if (!hasStaffCommandAccess(message)) return;
      }

      // Always operate on persisted data for admin edits.
      reloadModlogs();

    if (cmdLower === 'reason') {
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

    if (cmdLower === 'duration') {
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

    if (cmdLower === 'dcase' || cmdLower === 'delcase' || cmdLower === 'deletecase') {
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

    if (cmdLower === 'moderations') {
      const userArg = rest[0];
      const userId = parseId(userArg) || String(userArg || '').replace(/[<@!>]/g, '');
      if (!userId || !/^\d+$/.test(String(userId))) return replyAsEmbed(message, 'Usage: *moderations <userId>');
      const userCases = modlogs.cases
        .filter(c => String(c.user) === String(userId) && (!message.guild || !c.guildId || String(c.guildId) === String(message.guild.id)))
        .sort((a, b) => (Number(b && b.time || 0) - Number(a && a.time || 0)));

      let userLabel = String(userId);
      try {
        const u = await client.users.fetch(String(userId)).catch(() => null);
        if (u) userLabel = `${u.username} (${u.id})`;
      } catch (e) {}

      let banLine = 'No';
      try {
        const activeBan = await message.guild.bans.fetch(String(userId)).catch(() => null);
        if (activeBan) {
          const latestBanCase = userCases.find(c => String(c.type || '').toLowerCase() === 'ban');
          if (latestBanCase && latestBanCase.time) {
            const banTs = Math.floor(Number(latestBanCase.time) / 1000);
            const banFor = humanDurationLong(Math.max(0, Date.now() - Number(latestBanCase.time)));
            banLine = `Yes — since <t:${banTs}:f> (${banFor})`;
          } else {
            banLine = 'Yes — currently banned';
          }
        }
      } catch (e) {}

      let muteLine = 'No';
      try {
        const targetMember = await message.guild.members.fetch(String(userId)).catch(() => null);
        const untilMs = targetMember && targetMember.communicationDisabledUntilTimestamp ? Number(targetMember.communicationDisabledUntilTimestamp) : 0;
        if (untilMs > Date.now()) {
          const left = humanDurationLong(untilMs - Date.now());
          const untilTs = Math.floor(untilMs / 1000);
          muteLine = `Yes — until <t:${untilTs}:f> (left: ${left})`;
        }
      } catch (e) {}

      if (banLine === 'No' && muteLine === 'No') {
        return replyAsEmbed(message, `${userLabel} is currently not banned or muted.`);
      }
      
      const embed = new EmbedBuilder()
        .setTitle(`📊 Moderations for ${userLabel}`)
        .setColor(0x87CEFA)
        .setDescription(`Banned: ${banLine}\nMuted: ${muteLine}`)
        .setTimestamp();
      
      return message.channel.send({ embeds: [embed] });
    }

    if (cmdLower === 'case') {
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
  }

  if (!message.content.startsWith(PREFIX)) return;
  const [raw, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = raw.toLowerCase();

  // Execute website-managed dynamic commands before staff-role gating,
  // so simple public commands (e.g. *hello) work for normal members.
  if (await tryExecuteDynamicPrefixCommand(message, command, args)) {
    return;
  }

  if (!(await enforceRoleCommandAccess(message, command))) return;

  if (!command) return replyAsEmbed(message, 'Usage: *help');

  if (command === 'cmdsync' || command === 'cmdstatus') {
    if (!hasStaffCommandAccess(message)) return;
    const fields = [
      `Source: ${dynamicCommandsState.source || 'n/a'}`,
      `Count: ${dynamicCommandsState.byTrigger ? dynamicCommandsState.byTrigger.size : 0}`,
      `Last Sync: ${dynamicCommandsState.lastSyncAt ? new Date(dynamicCommandsState.lastSyncAt).toISOString() : 'never'}`,
      `URL Set: ${DYNAMIC_COMMANDS_URL ? 'yes' : 'no'}`,
      `Key Set: ${DYNAMIC_COMMANDS_BOT_KEY ? 'yes' : 'no'}`,
      `Last Error: ${dynamicCommandsState.lastError || 'none'}`,
    ];
    return replyAsEmbed(message, fields.join('\n'));
  }

  if (command === 'cmdrefresh') {
    if (!hasStaffCommandAccess(message)) return;
    try {
      await refreshDynamicCommands(true);
      return replyAsEmbed(message, `Refreshed. Source=${dynamicCommandsState.source || 'n/a'} Count=${dynamicCommandsState.byTrigger ? dynamicCommandsState.byTrigger.size : 0} Error=${dynamicCommandsState.lastError || 'none'}`);
    } catch (e) {
      return replyAsEmbed(message, `Refresh failed: ${String(e && e.message ? e.message : e)}`);
    }
  }

  const usageByCommand = {
    say: '*say <message>',
    md: '*md <user|id> [page]',
    modlogs: '*md <user|id> [page]',
    case: '*case <caseId>',
    cases: '*cases <user|id> [page]',
    moderations: '*moderations <userId>',
    warn: '*warn <user> [reason]',
    ban: '*ban <user> [duration] [reason] (e.g. *ban @user 7d spam)',
    bancm: '*bancm [duration] [reason]  OR  *ban cm [duration] [reason]',
    kick: '*kick <user> [reason]',
    unban: '*unban <id> [reason]',
    mute: '*mute <user> <time> [reason] (e.g. 15m, 3h, 1d)',
    unmute: '*unmute <user> [reason]',
    sgrief: '*sgrief <user> <proof>',
    softgrief: '*sgrief <user> <proof>',
    miss: '*miss <user> <proof>',
    lmiss: '*lmiss <user> <proof>',
    role: '*role @user @role  OR  *role <userId> <roleId|roleName>',
    setautorole: '*setautorole @role  OR  *setautorole <roleId|roleName>',
    autorole: '*setautorole @role  OR  *setautorole <roleId|roleName>',
    del: '*del <#channel|channelId|name>',
    delete: '*del <#channel|channelId|name>',
    gift: '*gift <user mention|id> [message]',
    reason: '*reason <caseId> <new reason>',
    duration: '*duration <caseId> <duration> (e.g. 3d, 2h30m, 15m)',
    dcase: '*dcase <caseId>',
    stream: '*stream add <streamer_login> [#channel] | *stream remove <streamer_login>',
  };
  if (usageByCommand[command] && args.length === 0) {
    return replyAsEmbed(message, `Usage: ${usageByCommand[command]}`);
  }

  // Re-ban all currently banned users and log to modlogs (*md)
  if (command === 'allban' || command === 'rebanall' || command === 'reban') {
    return replyAsEmbed(message, 'This command has been removed.');

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
      if (!total) return replyAsEmbed(message, 'No banned users found.');

      await replyAsEmbed(message, `Starting *allban for ${total} already banned users… (Reason: ${reason})`);

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
      return replyAsEmbed(message, 'allban failed.');
    }

    return replyAsEmbed(message, `allban completed. Previously banned: ${total}, Success: ${ok}, Failed: ${failed}, Deleted cases (this guild only): ${pruned}.`);
  }

  if (command === 'clearmodlogs') {
    if (!hasAdminCommandAccess(message)) return;

    const targetArg = args[0];
    const targetId = parseId(targetArg) || String(targetArg || '').trim();
    if (!targetId || !/^\d+$/.test(targetId)) {
      return replyAsEmbed(message, 'Usage: *clearmodlogs <userId|@mention>');
    }

    try {
      reloadModlogs();
      if (!modlogs || typeof modlogs !== 'object') modlogs = { lastCase: 10000, cases: [] };
      const list = Array.isArray(modlogs.cases) ? modlogs.cases : [];
      const before = list.length;
      modlogs.cases = list.filter(c => String(c && c.user ? c.user : '') !== String(targetId));
      const removed = before - modlogs.cases.length;
      saveJson(MODLOGS_PATH, modlogs);

      return replyAsEmbed(message, `Removed ${removed} modlog case(s) for user ${targetId}.`);
    } catch (e) {
      console.error('clearmodlogs failed', e);
      return replyAsEmbed(message, 'Failed to clear modlogs for that user.');
    }
  }

  // Member count command
  if (command === 'membercount' || command === 'mc') {
    if (!message.guild) return replyAsEmbed(message, 'This command can only be used in a server.');
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
      { name: '📋 General', value: '`*help` — Help\n`*say <text>` — Repeat\n`*rules` — Rules\n`*membercount|*mc` — Member count\n`*invite` — Bot invite', inline: false },
      { name: '🎫 Tickets', value: '`*ticket` — Create ticket\n`*close` — Close ticket (staff)', inline: false },
      { name: '📅 Sessions', value: '`*sa <reg> <game> [mode]` — Session announce\n`*sb <reg> <game>` — Beta announce\n`*shelp` — Session help\n`*create <announcement>` — Import announcement\n`*session help|list|cancel|testpost`', inline: false },
      { name: '🎧 Voice', value: '`*va [1d|7d|30d]` — Voice activity\n`/voiceactivity` — Slash version', inline: false },
      { name: '⚖️ Moderation', value: '`*warn <user> [reason]` — Staff\n`*ban <user> [reason]` — Head Staff\n`*unban <id>` — Staff\n`*mute <user> <minutes>` — Staff\n`*unmute <user>` — Staff\n`*role <user> <role>` — Admin\n`*admin` — Overview', inline: false },
      { name: '📊 Logs & History', value: '`*md <user> [page]` — Modlogs\n`*moderations <userId>`\n`*case <caseId>`', inline: false },
      { name: '✏️ Modlog Editing', value: '`*reason <caseId> <text>` — Staff\n`*duration <caseId> <time>` — Staff\n`*dcase <caseId>` — Admin (Delete case)', inline: false },
      { name: '🗑️ Cleanup', value: '`-purg <count> [user]` — Purge (Admin only)\n`*del <channel>` — Delete channel (Admin only)', inline: false },
      { name: '🚫 Blacklist', value: '`-blacklist <id> [reason]` — Admin\n`-unbll <id>` — Admin\n`-bll` — Staff (View logs)\n`-dblacklist <id> [reason]` — Staff (*dice)\n`-dunbll <id>` — Staff (*dice)', inline: false },
      { name: '👥 Destaff', value: '`-destaff <user> [reason]` — Remove staff roles (Admin only)', inline: false },
      { name: '🎮 Fun', value: '`*8ball`\n`*flip`\n`*dice [1-100]`\n`*rate [@user]`\n`*joke`\n`*compliment [@user]`\n`*santa`', inline: false },
      { name: '🎡 Game', value: '`*wheel <1-5>`\n`*wheelhelp`\n`*spins`\n`*wheelpick [opt1|opt2|...]`\n`*wheelgame ...`', inline: false }
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
      .setTitle('📜 SERVER RULES')
      .setColor(0x87CEFA)
      .setDescription('Please follow these rules to keep the server friendly and safe:')
      .addFields(
        { name: '1️⃣ Respect', value: 'Treat everyone with respect — no insults, provocation, or discrimination.\nNo bullying or toxic behavior.', inline: false },
        { name: '2️⃣ Chat Behavior', value: 'No spam, flooding, or caps spam.\nNo advertising without permission.\nNo NSFW, racist, violent, or otherwise inappropriate content.', inline: false },
        { name: '3️⃣ Names & Avatars', value: 'No offensive, sexual, or misleading names/avatars.\nImpersonating team members is forbidden.', inline: false },
        { name: '4️⃣ Voice Chats', value: 'No screaming, disturbing others, or soundboard spam.\nMusic bots only in designated channels.', inline: false },
        { name: '5️⃣ Team Decisions', value: 'Follow staff instructions.\nDiscuss warnings or bans privately with a moderator.', inline: false }
      )
      .setFooter({ text: 'Thanks for your understanding! 🙏' })
      .setTimestamp();

    message.delete().catch(() => {});
    return message.channel.send({ embeds: [rulesEmbed] });
  }

  // 8ball command
  if (command === '8ball') {
    const responses = [
      '✅ Yes, definitely!', '❌ No, impossible.', '🤔 Maybe...', '✨ Chances look good!',
      '💫 Outlook is not so good.', '🎯 Very likely!', '🚫 Better not ask now.', '🌟 Absolutely!',
      '❓ It is unclear right now.', '💯 100% Yes!', '😅 Probably not.', '🎪 Never!', '⚡ Wait and see!',
      '👀 Focus and ask again.', '🔮 Signs point to yes.'
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
    const result = Math.random() < 0.5 ? '🪙 Heads!' : '🪙 Tails!';
    const embed = new EmbedBuilder()
      .setTitle('Coin Flip')
      .setDescription(result)
      .setColor(0xFFD700)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Dice roll command
  if (command === 'dice' || command === 'roll') {
    if (isUserDiceBlacklisted(message.author && message.author.id)) {
      return replyAsEmbed(message, 'You are blocked from *dice. Please wait for `-dunbll` or contact a moderator.');
    }
    const dice = parseInt(args[0], 10) || 100;
    if (dice < 1 || dice > 100) return replyAsEmbed(message, 'Dice range: 1-100');
    const result = crypto.randomInt(1, dice + 1);
    const embed = new EmbedBuilder()
      .setTitle(`🎲 Dice (1-${dice})`)
      .setDescription(`**Result: ${result}**`)
      .setColor(0x4ECDC4)
      .setTimestamp();
    try {
      return await message.channel.send({ embeds: [embed] });
    } catch (e) {
      return message.channel.send(`🎲 Dice (1-${dice}) — Result: ${result}`).catch(() => null);
    }
  }

  // Wheel of fortune (professional)
  // Each user has 5 spins. Bets go into a shared pool.
  // 70% of spins are blanks (no win). Winners can receive parts of the pool.
  // Admin-Subcommands: topup, resetspins, grantspins, pool
  if (command === 'wheel') {
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
        return replyAsEmbed(message, `Pool topped up: ${amt}€. New pool: ${poolObj.pool}€`);
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
        return replyAsEmbed(message, `Set ${target.tag}'s spins to ${n}.`);
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
        return replyAsEmbed(message, `Granted ${n} spins to ${target.tag}.`);
      }
      if (sub === 'pool') {
        const poolObj = loadJson(poolPath, { pool: 0 });
        return replyAsEmbed(message, `Current pool: ${poolObj.pool}€`);
      }
      const bet = parseInt(args[0], 10);
      if (!bet || bet < 1 || bet > 5) return replyAsEmbed(message, 'Usage: !wheel <1-5> — Einsatz in Euro (1–5)');
      const all = loadJson(walletsPath, {});
      const poolObj = loadJson(poolPath, { pool: 0 });
      const uid = message.author.id;
      if (!all[uid]) all[uid] = { balance: 100, spins: 5 };
      if (typeof all[uid].spins !== 'number') all[uid].spins = 5;

      if (all[uid].spins <= 0) return replyAsEmbed(message, `You have no spins left. Spins: ${all[uid].spins}`);
      if (all[uid].balance < bet) return replyAsEmbed(message, `You do not have enough balance. Current balance: ${all[uid].balance}€`);

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
        { id: 'blank', name: 'Blank', type: 'lose', weightBase: 700, mult: 0 },
        { id: 'small', name: 'Small Win', type: 'win', weightBase: 220, mult: 1 },
        { id: 'medium', name: 'Big Win', type: 'win', weightBase: 70, mult: 2 },
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
        .setTitle('🎡 Wheel — Pro')
        .setColor(chosen.type === 'lose' ? 0xE74C3C : 0x2ECC71)
        .addFields(
          { name: 'Player', value: `${message.author.tag}`, inline: true },
          { name: 'Bet', value: `${bet}€`, inline: true },
          { name: 'Result', value: `${chosen.name}${chosen.type === 'jackpot' ? ' — JACKPOT!' : ''}`, inline: false },
          { name: 'Payout', value: `${payout}€`, inline: true },
          { name: 'Spins Left', value: `${all[uid].spins}`, inline: true },
          { name: 'Pool', value: `${poolObj.pool}€`, inline: true }
        ).setTimestamp();

      if (isForceLoseChannel) {
        embed.addFields({ name: 'Note', value: 'In this channel, all wins are disabled — all results are blanks.', inline: false });
      }

      // Log this spin to the dedicated wheel log channel (light-blue embed)
      try {
        const wheelLogEmbed = new EmbedBuilder()
          .setTitle('Wheel — Spin')
          .setColor(0x87CEFA)
          .addFields(
            { name: 'Player', value: `${message.author.tag}`, inline: true },
            { name: 'Bet', value: `${bet}€`, inline: true },
            { name: 'Result', value: `${chosen.name}${chosen.type === 'jackpot' ? ' — JACKPOT!' : ''}`, inline: false },
            { name: 'Payout', value: `${payout}€`, inline: true },
            { name: 'Pool (after spin)', value: `${poolObj.pool}€`, inline: true }
          ).setTimestamp();
        await sendLog(message.guild, { embeds: [wheelLogEmbed], category: 'wheel' }).catch(()=>{});
      } catch (e) { console.error('wheel log failed', e); }

      return message.reply({ embeds: [embed] });
    } catch (e) {
      console.error('wheel command failed', e);
      return replyAsEmbed(message, 'Error while executing the wheel command.');
    }
  }

  // Help command for the wheel
  if (command === 'wheelhelp' || command === 'wheelinfo') {
    try {
      console.log('[wheelhelp] command detected from', message.author.id);
      const walletsPath = path.join(DATA_DIR, 'wallets.json');
      const poolPath = path.join(DATA_DIR, 'wheel_pool.json');
      const poolObj = loadJson(poolPath, { pool: 0 });

      const embed = new EmbedBuilder()
        .setTitle('🎡 Wheel — Help')
        .setColor(0x87CEFA)
        .setDescription('Important information and commands for the wheel.')
        .addFields(
          { name: 'Core', value: 'Each player has 5 spins by default. Bet 1–5€ per spin. About 70% are blanks. Bets go into a shared pool; winners get paid from this pool.', inline: false },
          { name: 'Play', value: '`*wheel <1-5>` — Bet 1–5€ and use one spin.', inline: true },
          { name: 'Status', value: '`*spins` — Shows remaining spins and balance.\n`*wheel pool` — Shows current shared pool.', inline: true },
          { name: 'Admin Commands', value: '`*wheel topup <amount>` — Top up pool.\n`*wheel resetspins @user [n]` — Set spins for a user (default 5).\n`*wheel grantspins @user <n>` — Grant extra spins.', inline: false },
          { name: 'Example', value: '`*wheel 3` — Bet 3€; possible outcomes: small win (~1×), big win (~2×), jackpot (whole pool minus own bet).', inline: false },
          { name: 'Important', value: 'Balances are stored in `wallets.json`. New players start with 100€. Use `topup` responsibly.', inline: false }
        ).setTimestamp();

      embed.addFields({ name: 'Current Pool', value: `${poolObj.pool}€`, inline: true });

      return message.reply({ embeds: [embed] });
    } catch (e) {
      console.error('wheelhelp failed', e);
      return replyAsEmbed(message, 'Failed to display wheel help.');
    }
  }

  // Check remaining spins
  if (command === 'spins') {
    try {
      const walletsPath = path.join(DATA_DIR, 'wallets.json');
      const all = loadJson(walletsPath, {});
      const uid = message.author.id;
      if (!all[uid]) return replyAsEmbed(message, 'You have 5 spins. Use !wheel <1-5> to play.');
      return replyAsEmbed(message, `Spins left: ${all[uid].spins} — Balance: ${all[uid].balance}€`);
    } catch (e) {
      console.error('spins check failed', e);
      return replyAsEmbed(message, 'Failed to fetch spins.');
    }
  }

  // Admin overview command: show central settings and status (light-blue embed)
  if (command === 'admin') {
    try {
      if (!message.guild) return replyAsEmbed(message, 'This command can only be used in a server.');
      const cfg = loadGuildConfig(message.guild.id);
      const isStaff = hasStaffCommandAccess(message);
      if (!isStaff) return;

      const automodCfg = loadJson(path.join(DATA_DIR, 'automod.json'), {});
      const poolObj = loadJson(path.join(DATA_DIR, 'wheel_pool.json'), { pool: 0 });
      const wallets = loadJson(path.join(DATA_DIR, 'wallets.json'), {});

      const embed = new EmbedBuilder()
        .setTitle('Admin — Overview')
        .setColor(0x87CEFA)
        .setDescription('Central configurations, automod status, and wheel stats')
        .addFields(
          { name: 'Central Log (Automod)', value: '<#1466065677986299966>', inline: true },
          { name: 'Default Log Channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not set', inline: true },
          { name: 'Join/Leave Logs', value: `Join: ${cfg.joinLogChannelId || 'Not set'}\nLeave: ${cfg.leaveLogChannelId || 'Not set'}`, inline: true },
          { name: 'Moderation Log', value: cfg.moderationLogChannelId || cfg.modLogChannelId || 'Not set', inline: true },
          { name: 'Automod — muteMinutes', value: String(automodCfg.muteMinutes || 'Not set'), inline: true },
          { name: 'Automod — blockedWords', value: `${(automodCfg.blockedWords && automodCfg.blockedWords.length) || 'n/a'}`, inline: true },
          { name: 'Automod — log channel names', value: (automodCfg.logChannelNames || []).join(', ') || 'n/a', inline: false },
          { name: 'Wheel — Pool', value: `${poolObj.pool}€`, inline: true },
          { name: 'Wheel — active wallets', value: `${Object.keys(wallets || {}).length}`, inline: true }
        ).setTimestamp();

      return message.reply({ embeds: [embed] });
    } catch (e) {
      console.error('admin command failed', e);
      return replyAsEmbed(message, 'Failed to display admin overview.');
    }
  }

  // Simple global help mentioning the admin command
  if (command === 'help') {
    try {
      const help = new EmbedBuilder()
        .setTitle('Bot — Quick Help')
        .setColor(0x87CEFA)
        .setDescription('Important prefix commands')
        .addFields(
          { name: 'General', value: '!help — this overview\n!wheel <1-5> — wheel\n!spins — remaining spins', inline: false },
          { name: 'Admin', value: '!admin — shows central settings and stats (Staff/Admin)', inline: false }
        ).setTimestamp();
      return message.reply({ embeds: [help] });
    } catch (e) { console.error('help failed', e); return replyAsEmbed(message, 'Failed to display help.'); }
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
      if (!fetched) return replyAsEmbed(message, 'Could not fetch messages (missing permissions?).');

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
          .setTitle('Automod — Bulk Deletion')
          .setColor(0xE74C3C)
          .addFields(
            { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
            { name: 'Channel', value: `${message.guild.name} / #${message.channel.name}`, inline: true },
            { name: 'Deleted Count', value: `${removed}`, inline: true }
          ).setTimestamp();
        if (removedDetails.length) embed.addFields({ name: 'Examples', value: removedDetails.slice(0,8).join('\n'), inline: false });
        if (logCh && typeof logCh.send === 'function') await logCh.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(()=>null);
      } catch (e) { console.error('purge log failed', e); }

      return replyAsEmbed(message, `Done: ${removed} messages deleted and logged.`);
    } catch (e) { console.error('clearracism failed', e); return replyAsEmbed(message, 'Deletion failed.'); }
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
      .setTitle('⭐ Rating System')
      .setDescription(`${target} gets a rating of **${rating}/100** ${emoji}`)
      .setColor(0xFF69B4)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Joke command
  if (command === 'joke') {
    const jokes = [
      'Why are programmers bad at relationships?\nBecause they only think in 0 and 1!',
      'Ein SQL-Query geht in eine Bar, trifft zwei Tabellen und fragt: "Darf ich mich zu euch setzen?"',
      'How many programmers does it take to change a light bulb? None, that is a hardware problem!',
      'A byte goes to therapy: "I feel split into bits!"',
      'Why did Perl leave its partner? Because there are always too many ways to do it!',
      'Ein Developer liest einer Frau im Schlaf etwas vor... Sie sagt: "Das ist ja langweilig!" Er: "Ist es, aber der Code ist elegant!"',
      'What is the teacher\'s student called? Stack Overflow!'
    ];
    const joke = jokes[Math.floor(Math.random() * jokes.length)];
    const embed = new EmbedBuilder()
      .setTitle('😂 Dev Joke')
      .setDescription(joke)
      .setColor(0xFFB700)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Compliment command
  if (command === 'compliment') {
    const compliments = [
      'You are truly inspiring!', 'Your smile is contagious!', 'You are a great friend!',
      'You make the world better!', 'Your creativity is impressive!', 'You have a golden heart!',
      'You are a real inspiration!', 'Your intelligence is impressive!', 'You achieve great things!',
      'Your kindness is admirable!', 'You are simply wonderful!', 'The world needs more people like you!'
    ];
    const compliment = compliments[Math.floor(Math.random() * compliments.length)];
    const target = message.mentions.members.first() || message.author;
    const embed = new EmbedBuilder()
      .setTitle('💝 Compliment')
      .setDescription(`${target}, ${compliment}`)
      .setColor(0xFF1493)
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // Modlogs pagination command: !md <user|id> [page]
  if (command === 'md' || command === 'modlogs') {
    if (!hasAdminCommandAccess(message)) return;
    if (!message.guild || String(message.guild.id) !== MODLOGS_SERVER_ONLY_ID) return;
    const userArg = args[0];
    const pageArg = parseInt(args[1], 10) || 1;
    if (!userArg) return replyAsEmbed(message, 'Usage: !md <user|id> [page]');

    const targetId = parseId(userArg) || userArg.replace(/[<@!>]/g, '');
    if (!targetId || !/^\d+$/.test(targetId)) return replyAsEmbed(message, 'Provide a valid user ID or mention.');

    const itemsPerPage = 5;
    const allCases = modlogs.cases
      .filter(c => String(c.user) === String(targetId))
      .sort((a, b) => (b.time || 0) - (a.time || 0));

    if (!allCases.length) return replyAsEmbed(message, 'No modlogs found for this user.');

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

      const type = displayCaseType(c.type || 'Case');
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
    return;
    const userArg = args[0];
    const pageArg = parseInt(args[1], 10) || 1;
    if (!userArg) return replyAsEmbed(message, 'Usage: !mds <user|id> [page]');

    const targetId = parseId(userArg) || userArg.replace(/[<@!>]/g, '');
    if (!targetId || !/^\d+$/.test(targetId)) return replyAsEmbed(message, 'Provide a valid user ID or mention.');

    const itemsPerPage = 8;
    const allCases = destaffs.cases
      .filter(c => String(c.user) === String(targetId))
      .sort((a, b) => (b.time || 0) - (a.time || 0));

    if (!allCases.length) return replyAsEmbed(message, 'No destaff logs found for this user.');

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
    if (!message.guild) return replyAsEmbed(message, 'This command must be used in a server.');
    const isStaff = hasStaffCommandAccess(message);
    if (!isStaff) return replyAsEmbed(message, 'Only moderators or server admins can use this command.');

    const channel = message.channel;
    if (!channel || !channel.topic || !channel.topic.startsWith('ticket:')) return replyAsEmbed(message, 'This command works only in ticket channels.');

    const parts = channel.topic.split(':');
    const ownerId = parts[1];
    const reason = args.join(' ') || `Closed by ${message.author.tag}`;

    try {
      // create transcript
      const folder = path.join(DATA_DIR, cfg.transcriptFolder || 'transcripts');
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
      const { txtPath, htmlPath } = await createTranscript(channel, folder).catch(()=>({ txtPath: null, htmlPath: null }));

      // send transcript to log
      try {
        if (cfg.logChannelId) {
          const logCh = message.guild.channels.cache.get(cfg.logChannelId);
          if (logCh) await sendLog(message.guild, { embeds: [new EmbedBuilder().setTitle('Ticket Closed').setDescription(`Ticket ${channel.name} closed by <@${message.author.id}>\nReason: ${reason}`)], files: [txtPath].filter(Boolean) });
        }
      } catch (e) { console.error('failed to send transcript to log channel', e); }

      // DM owner
      try { const owner = await client.users.fetch(ownerId).catch(()=>null); if (owner) await owner.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setTitle('Your ticket has been closed').setDescription(`In **${message.guild && message.guild.name ? message.guild.name : 'this server'}**\nReason: ${reason}`)], files: [txtPath].filter(Boolean) }).catch(()=>{}); } catch (e) {}

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
    if (!hasStaffCommandAccess(message)) return;
    if (!message.guild || String(message.guild.id) !== MODLOGS_SERVER_ONLY_ID) return;
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
    if (!hasStaffCommandAccess(message)) return;
    if (!message.guild || String(message.guild.id) !== MODLOGS_SERVER_ONLY_ID) return;
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
    if (!hasStaffCommandAccess(message)) return;
    const targetArg = args[0];
    const reason = args.slice(1).join(' ') || 'No reason provided';
    const targetUser = await resolveUser(targetArg);
    if (!targetUser) return message.channel.send({ embeds: [createChannelConfirmEmbed('User not found. Use mention or ID.')] });
    const protectedMember = message.guild ? await message.guild.members.fetch(targetUser.id).catch(() => null) : null;
    if (memberHasProtectedModerationRole(protectedMember)) return replyCannotModerateUser(message, targetUser);

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
        title: 'User warned',
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

  if (command === 'ban' || command === 'bancm') {
    if (!hasHeadStaffCommandAccess(message)) return;
    const isBanCmShortcut = command === 'bancm' || String(args[0] || '').toLowerCase() === 'cm';
    const targetArg = isBanCmShortcut ? CM_FIXED_BAN_USER_ID : args[0];
    const postTargetArgIndex = isBanCmShortcut ? (command === 'bancm' ? 0 : 1) : 1;
    const id = parseId(targetArg) || targetArg;
    if (!id) return message.channel.send({ embeds: [createChannelConfirmEmbed('Please provide a mention or user ID to ban.')] });

    const durationToken = String(args[postTargetArgIndex] || '').trim();
    const hasDurationToken = /^(\d+[dhms])+$/i.test(durationToken);
    const durationMs = hasDurationToken ? parseDurationToMs(durationToken) : null;
    if (hasDurationToken && (!durationMs || durationMs <= 0)) {
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Invalid duration. Example: *ban @user 7d reason')] });
    }

    const reasonStart = hasDurationToken ? (postTargetArgIndex + 1) : postTargetArgIndex;
    const rawReason = args.slice(reasonStart).join(' ').trim();
    const reason = hasDurationToken
      ? normalizeReason(rawReason || `Temporary ban (${humanDuration(durationMs)})`)
      : ensurePermBanReason(rawReason || 'No reason provided');

    const protectedMember = message.guild ? await message.guild.members.fetch(String(id)).catch(() => null) : null;
    if (memberHasProtectedModerationRole(protectedMember)) return replyCannotModerateUser(message, protectedMember.user || id);

    // If a new ban is issued for the same user, replace/remove any old temp-ban schedule.
    removeTempBanEntry(message.guild && message.guild.id, id);

    // Mark first so audit-log based handlers (executor = bot) don't create a duplicate case.
    markRecentModAction(message.guild?.id, 'Ban', id, message.author.id);
    markRecentModAction(message.guild?.id, 'Ban', id, '*');

    // Ban in guild
    try {
      await message.guild.members.ban(id, { reason: `${message.author.tag}: ${reason}` });

      // Record modlog only on success
      const caseId = nextCase();
      const whenTs = Date.now();
      const modlogEntry = {
        caseId,
        type: 'Ban',
        user: id,
        moderator: message.author.id,
        reason,
        time: whenTs,
        guildId: message.guild ? message.guild.id : null
      };
      if (hasDurationToken && durationMs) modlogEntry.durationMs = durationMs;
      modlogs.cases.push(modlogEntry);
      saveJson(MODLOGS_PATH, modlogs);
      writeModlogCaseToMd({ guild: message.guild, caseId, type: 'Ban', userId: id, moderatorId: message.author.id, reason, whenTs });

      if (hasDurationToken && durationMs) {
        scheduleTempBanEntry({
          guildId: String(message.guild.id),
          userId: String(id),
          moderatorId: String(message.author.id),
          caseId: Number(caseId),
          reason: String(reason),
          durationMs: Number(durationMs),
          unbanAt: Date.now() + Number(durationMs)
        }, { persist: true });
      }

      // DM after ban (avoid sending a caseId that won't exist if the ban fails)
      try {
        const user = await client.users.fetch(id).catch(() => null);
        if (user) {
          const dmReason = hasDurationToken && durationMs
            ? `${reason}\nDuration: ${humanDuration(durationMs)}`
            : reason;
          await sendModEmbedToUser(user, 'Ban', { guild: message.guild, moderatorTag: message.author.tag, reason: dmReason, caseId });
        }
      } catch (e) {}

      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const targetUser = await client.users.fetch(id).catch(() => null);
        const embed = buildSmallModerationEmbed({
          title: hasDurationToken && durationMs ? 'User temp-banned' : 'User banned',
          targetId: id,
          targetAvatarUrl: targetUser ? targetUser.displayAvatarURL({ extension: 'png', size: 256 }) : null,
          moderatorId: message.author.id,
          reason: hasDurationToken && durationMs ? `${reason} (Duration: ${humanDuration(durationMs)})` : reason,
          caseId,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
      } catch (e) { console.error('ban log failed', e); }

      const text = hasDurationToken && durationMs
        ? `User ${id} was banned for ${humanDuration(durationMs)}. | ${reason}`
        : `User ${id} was banned. | ${reason}`;
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId, id)] });
    } catch (e) {
      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const targetUser = await client.users.fetch(id).catch(() => null);
        const embed = buildSmallModerationEmbed({
          title: 'Ban failed',
          targetId: id,
          targetAvatarUrl: targetUser ? targetUser.displayAvatarURL({ extension: 'png', size: 256 }) : null,
          moderatorId: message.author.id,
          reason: String(e.message || e),
          caseId: null,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
      } catch (err) { console.error('ban failure log failed', err); }
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Failed to ban user — maybe invalid ID or lack of permissions.', null, id, 0xE74C3C)] });
    }
  }

  if (command === 'kick') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return;
    const targetArg = args[0];
    const reason = args.slice(1).join(' ') || 'No reason provided';
    const id = parseId(targetArg) || targetArg;
    if (!id) return message.channel.send({ embeds: [createChannelConfirmEmbed('Please provide a mention or user ID to kick.')] });
    const protectedMember = message.guild ? await message.guild.members.fetch(String(id)).catch(() => null) : null;
    if (memberHasProtectedModerationRole(protectedMember)) return replyCannotModerateUser(message, protectedMember.user || id);

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
          title: 'User kicked',
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
          title: 'Kick failed',
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
    if (!hasStaffCommandAccess(message)) return;
    const id = args[0];
    const reason = args.slice(1).join(' ').trim() || 'No reason provided';
    if (!id || !/^\d+$/.test(id)) return message.channel.send({ embeds: [createChannelConfirmEmbed('Please provide a valid user ID to unban.')] });
    if (await userHasProtectedModerationRoleInGuilds(id, [String(message.guild && message.guild.id ? message.guild.id : '')])) return replyCannotModerateUser(message, id);

    // Manual unban should cancel any pending temp-ban scheduler for this user.
    removeTempBanEntry(message.guild && message.guild.id, id);

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
          title: 'User unbanned',
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
        const embed = new EmbedBuilder().setTitle('Unban failed').setColor(0xE74C3C)
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

  if (command === 'sgrief' || command === 'softgrief') {
    if (!hasStaffCommandAccess(message)) return;
    const targetArg = args[0];
    const proof = args.slice(1).join(' ').trim();
    if (!targetArg) return message.channel.send({ embeds: [createChannelConfirmEmbed('Usage: *sgrief <user> <proof>')] });
    if (!proof) return message.channel.send({ embeds: [createChannelConfirmEmbed('Please provide proof/reason. Usage: *sgrief <user> <proof>')] });

    const duration = 14 * 24 * 60 * 60 * 1000;
    const durationText = '14 days';
    const reason = `Soft Grief - ${proof}`;
    const member = await message.guild.members.fetch(parseId(targetArg) || targetArg).catch(() => null);
    if (!member) return message.channel.send({ embeds: [createChannelConfirmEmbed('Member not found.')] });
    if (memberHasProtectedModerationRole(member)) return replyCannotModerateUser(message, member.user || member.id);

    try {
      await member.timeout(duration, `${message.author.tag}: ${reason}`);
      const caseId = nextCase();
      const whenTs = Date.now();
      modlogs.cases.push({ caseId, type: 'Mute', user: member.id, moderator: message.author.id, reason, durationMs: duration, time: whenTs, guildId: message.guild ? message.guild.id : null });
      saveJson(MODLOGS_PATH, modlogs);
      writeModlogCaseToMd({ guild: message.guild, caseId, type: 'Mute', userId: member.id, moderatorId: message.author.id, reason, whenTs });
      markRecentModAction(message.guild?.id, 'Mute', member.id, message.author.id);
      markRecentModAction(message.guild?.id, 'Mute', member.id, '*');

      await sendModEmbedToUser(member.user, 'Mute', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId, durationText });

      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const embed = buildSmallModerationEmbed({
          title: 'User timed out',
          targetId: member.id,
          targetAvatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
          moderatorId: message.author.id,
          reason,
          caseId,
          durationText,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
      } catch (e) { console.error('sgrief log failed', e); }

      const text = `User ${member.user.tag} (${member.user.id}) was muted. | Duration: ${durationText} | ${reason}`;
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId, member.user.id)] });
    } catch (e) {
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Failed to mute the member — missing permissions or hierarchy issue.', null, member ? member.id : (args[0] || null), 0xE74C3C)] });
    }
  }

  if (command === 'miss') {
    if (!hasStaffCommandAccess(message)) return;
    const targetArg = args[0];
    const proof = args.slice(1).join(' ').trim();
    if (!targetArg) return message.channel.send({ embeds: [createChannelConfirmEmbed('Usage: *miss <user> <proof>')] });

    const duration = 7 * 24 * 60 * 60 * 1000;
    const durationText = '7 days';
    const reason = proof || 'Missing a game during a session.';
    const member = await message.guild.members.fetch(parseId(targetArg) || targetArg).catch(() => null);
    if (!member) return message.channel.send({ embeds: [createChannelConfirmEmbed('Member not found.')] });
    if (memberHasProtectedModerationRole(member)) return replyCannotModerateUser(message, member.user || member.id);

    try {
      await member.timeout(duration, `${message.author.tag}: ${reason}`);
      const caseId = nextCase();
      const whenTs = Date.now();
      modlogs.cases.push({ caseId, type: 'Mute', user: member.id, moderator: message.author.id, reason, durationMs: duration, time: whenTs, guildId: message.guild ? message.guild.id : null });
      saveJson(MODLOGS_PATH, modlogs);
      writeModlogCaseToMd({ guild: message.guild, caseId, type: 'Mute', userId: member.id, moderatorId: message.author.id, reason, whenTs });
      markRecentModAction(message.guild?.id, 'Mute', member.id, message.author.id);
      markRecentModAction(message.guild?.id, 'Mute', member.id, '*');

      await sendModEmbedToUser(member.user, 'Mute', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId, durationText });

      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const embed = buildSmallModerationEmbed({
          title: 'User timed out',
          targetId: member.id,
          targetAvatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
          moderatorId: message.author.id,
          reason,
          caseId,
          durationText,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
      } catch (e) { console.error('miss log failed', e); }

      const text = `User ${member.user.tag} (${member.user.id}) was muted. | Duration: ${durationText} | ${reason}`;
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId, member.user.id)] });
    } catch (e) {
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Failed to mute the member — missing permissions or hierarchy issue.', null, member ? member.id : (args[0] || null), 0xE74C3C)] });
    }
  }

  if (command === 'lmiss') {
    if (!hasStaffCommandAccess(message)) return;
    const targetArg = args[0];
    const proof = args.slice(1).join(' ').trim();
    if (!targetArg) return message.channel.send({ embeds: [createChannelConfirmEmbed('Usage: *lmiss <user> <proof>')] });

    const duration = 9 * 24 * 60 * 60 * 1000;
    const durationText = '9 days';
    const reason = proof || 'Missing the last game of the session.';
    const member = await message.guild.members.fetch(parseId(targetArg) || targetArg).catch(() => null);
    if (!member) return message.channel.send({ embeds: [createChannelConfirmEmbed('Member not found.')] });
    if (memberHasProtectedModerationRole(member)) return replyCannotModerateUser(message, member.user || member.id);

    try {
      await member.timeout(duration, `${message.author.tag}: ${reason}`);
      const caseId = nextCase();
      const whenTs = Date.now();
      modlogs.cases.push({ caseId, type: 'Mute', user: member.id, moderator: message.author.id, reason, durationMs: duration, time: whenTs, guildId: message.guild ? message.guild.id : null });
      saveJson(MODLOGS_PATH, modlogs);
      writeModlogCaseToMd({ guild: message.guild, caseId, type: 'Mute', userId: member.id, moderatorId: message.author.id, reason, whenTs });
      markRecentModAction(message.guild?.id, 'Mute', member.id, message.author.id);
      markRecentModAction(message.guild?.id, 'Mute', member.id, '*');

      await sendModEmbedToUser(member.user, 'Mute', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId, durationText });

      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const embed = buildSmallModerationEmbed({
          title: 'User timed out',
          targetId: member.id,
          targetAvatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
          moderatorId: message.author.id,
          reason,
          caseId,
          durationText,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
      } catch (e) { console.error('lmiss log failed', e); }

      const text = `User ${member.user.tag} (${member.user.id}) was muted. | Duration: ${durationText} | ${reason}`;
      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId, member.user.id)] });
    } catch (e) {
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Failed to mute the member — missing permissions or hierarchy issue.', null, member ? member.id : (args[0] || null), 0xE74C3C)] });
    }
  }

  if (command === 'mute') {
    if (!hasStaffCommandAccess(message)) return;
    const targetArg = args[0];
    if (!targetArg) {
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Usage: *mute <user> <time> [reason] (e.g. 15m, 3h, 1d)')] });
    }
    const durationArg = args[1] || '1m';
    const duration = parseDurationToMs(durationArg);
    if (!duration || duration <= 0) return message.channel.send({ embeds: [createChannelConfirmEmbed('Usage: *mute <user> <time> [reason] (e.g. 15m, 3h, 1d)')] });
    const maxTimeoutMs = 28 * 24 * 60 * 60 * 1000;
    if (duration > maxTimeoutMs) return message.channel.send({ embeds: [createChannelConfirmEmbed('Mute duration cannot be more than 28d.')] });
    const durationText = humanDurationLong(duration);
    const reason = args.slice(2).join(' ').trim() || 'No reason provided';
    const member = await message.guild.members.fetch(parseId(targetArg) || targetArg).catch(() => null);
    if (!member) return message.channel.send({ embeds: [createChannelConfirmEmbed('Member not found.')] });
    if (memberHasProtectedModerationRole(member)) return replyCannotModerateUser(message, member.user || member.id);

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
      await sendModEmbedToUser(member.user, 'Mute', { guild: message.guild, moderatorTag: message.author.tag, reason, caseId, durationText });

      const text = `User ${member.user.tag} was muted for ${durationText}.`;
      // log mute
      try {
        const nowTs = Math.floor(Date.now() / 1000);
        const embed = buildSmallModerationEmbed({
          title: 'User timed out',
          targetId: member.id,
          targetAvatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
          moderatorId: message.author.id,
          reason,
          caseId,
          durationText,
          nowTs
        });
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' }).catch(() => {});
      } catch (e) { console.error('mute log failed', e); }

      return message.channel.send({ embeds: [createChannelConfirmEmbed(text, caseId, member.user.id)] });
    } catch (e) {
      try {
        const embed = new EmbedBuilder().setTitle('Mute failed').setColor(0xE74C3C)
          .addFields(
            { name: 'Target', value: `${member ? (member.user.tag + ` (${member.id})`) : String(args[0]||'unknown')}`, inline: true },
            { name: 'Moderator', value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
            { name: 'Duration', value: `${durationText}`, inline: true },
            { name: 'Error', value: `${String(e.message || e)}`, inline: false }
          ).setTimestamp();
        await sendLog(message.guild, { embeds: [embed], category: 'moderation' });
      } catch (err) { console.error('mute failure log failed', err); }
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Failed to mute the member — missing permissions or hierarchy issue.', null, member ? member.id : (args[0]||null))] });
    }
  }

  if (command === 'unmute') {
    if (!hasStaffCommandAccess(message)) return;
    const targetArg = args[0];
    if (!targetArg) {
      return message.channel.send({ embeds: [createChannelConfirmEmbed('Usage: *unmute <user> [reason]')] });
    }
    const reason = args.slice(1).join(' ').trim() || 'No reason provided';
    const member = await message.guild.members.fetch(parseId(targetArg) || targetArg).catch(() => null);
    if (!member) return message.channel.send({ embeds: [createChannelConfirmEmbed('Member not found.')] });
    if (memberHasProtectedModerationRole(member)) return replyCannotModerateUser(message, member.user || member.id);

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
          title: 'Timeout removed',
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
    const embed = new EmbedBuilder().setColor(0x87CEFA).setTitle('You received a gift!').setDescription(`From **${message.guild && message.guild.name ? message.guild.name : 'this server'}**`).addFields({ name: 'Gift', value: gift }, { name: 'Message', value: note });
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
  const ensureGuildPlayer = (guildId) => {
    const key = String(guildId || '');
    if (!key) return null;
    const existing = guildVoicePlayers.get(key);
    if (existing) return existing;
    if (!createAudioPlayer || !NoSubscriberBehavior) return null;
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });
    guildVoicePlayers.set(key, player);
    player.on('error', (err) => {
      try { console.error('voice player error', err); } catch (e) {}
    });
    if (AudioPlayerStatus && typeof player.on === 'function') {
      player.on(AudioPlayerStatus.Idle, () => {});
    }
    return player;
  };

  const getQueueState = (guildId) => {
    const key = String(guildId || '');
    if (!key) return null;
    let state = guildMusicQueues.get(key);
    if (!state) {
      state = { tracks: [], current: null, playing: false, lastError: null };
      guildMusicQueues.set(key, state);
    }
    return state;
  };

  const normalizeYoutubeUrl = (rawInput) => {
    let input = String(rawInput || '').trim();
    if (!input) return null;
    input = input.replace(/^<+|>+$/g, '').trim();
    input = input.replace(/[\u200B-\u200D\uFEFF]/g, '');
    input = input.replace(/[)\],.;!?]+$/g, '');
    if (!/^https?:\/\//i.test(input)) {
      if (/^(www\.)?(youtube\.com|youtu\.be)\//i.test(input)) input = `https://${input}`;
    }

    try {
      const parsed = new URL(input);
      const host = String(parsed.hostname || '').toLowerCase();
      const isYoutube = host === 'youtu.be' || host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com');
      if (!isYoutube) return input;

      if (host === 'youtu.be') {
        const id = String(parsed.pathname || '').replace(/^\//, '').split('/')[0];
        if (id) return `https://www.youtube.com/watch?v=${id}`;
      }

      const shorts = String(parsed.pathname || '').match(/^\/shorts\/([^/?#]+)/i);
      if (shorts && shorts[1]) return `https://www.youtube.com/watch?v=${shorts[1]}`;

      const v = parsed.searchParams.get('v');
      if (v) return `https://www.youtube.com/watch?v=${v}`;
      return input;
    } catch (e) {
      return input;
    }
  };

  const playNextFromQueue = async (guild, announceChannel = null) => {
    try {
      if (!guild || !playDl || !createAudioResource) return false;
      const gid = String(guild.id);
      const state = getQueueState(gid);
      if (!state) return false;
      if (state.playing) return true;
      const next = state.tracks.shift();
      if (!next) {
        state.current = null;
        state.playing = false;
        state.lastError = null;
        return false;
      }

      const connection = getVoiceConnection ? getVoiceConnection(gid) : null;
      if (!connection) {
        state.lastError = 'No voice connection available.';
        state.current = null;
        state.playing = false;
        state.tracks.unshift(next);
        return false;
      }

      const player = ensureGuildPlayer(gid);
      if (!player) {
        state.lastError = 'Audio player could not be initialized.';
        state.current = null;
        state.playing = false;
        state.tracks.unshift(next);
        return false;
      }

      connection.subscribe(player);
      state.current = next;
      state.playing = true;
      state.lastError = null;

      let streamTarget = normalizeYoutubeUrl(next.url) || String(next.url || '').trim();
      let stream;
      try {
        stream = await playDl.stream(streamTarget, { discordPlayerCompatibility: true });
      } catch (e1) {
        const firstErr = String(e1 && e1.message ? e1.message : e1 || 'stream error');
        if (/invalid url/i.test(firstErr)) {
          const idMatch = String(streamTarget).match(/[?&]v=([A-Za-z0-9_-]{6,})|youtu\.be\/([A-Za-z0-9_-]{6,})|\/shorts\/([A-Za-z0-9_-]{6,})/i);
          const videoId = (idMatch && (idMatch[1] || idMatch[2] || idMatch[3])) ? String(idMatch[1] || idMatch[2] || idMatch[3]) : null;
          if (videoId) {
            streamTarget = `https://www.youtube.com/watch?v=${videoId}`;
            try {
              stream = await playDl.stream(streamTarget, { discordPlayerCompatibility: true });
            } catch (e2) {
              const secondErr = String(e2 && e2.message ? e2.message : e2 || 'stream error');
              if (/invalid url/i.test(secondErr) && ytDlpExec) {
                const rawOut = await ytDlpExec(streamTarget, {
                  getUrl: true,
                  format: 'bestaudio/best',
                  noWarnings: true,
                  noCheckCertificates: true,
                  quiet: true,
                });
                const directUrl = String(rawOut || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
                if (!directUrl) throw new Error('yt-dlp did not return a playable URL');
                const readable = await new Promise((resolve, reject) => {
                  const req = https.get(directUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                    const code = Number(res.statusCode || 0);
                    if (code >= 400) return reject(new Error(`yt-dlp stream HTTP ${code}`));
                    resolve(res);
                  });
                  req.on('error', reject);
                });
                stream = { stream: readable };
              } else {
                throw e2;
              }
            }
          } else {
            throw new Error(`${firstErr} (url=${String(streamTarget).slice(0, 180)})`);
          }
        } else {
          throw e1;
        }
      }
      const resource = stream && stream.type
        ? createAudioResource(stream.stream, { inputType: stream.type })
        : createAudioResource(stream.stream);

      const onIdle = async () => {
        try {
          state.playing = false;
          state.current = null;
          player.removeListener('error', onError);
          await playNextFromQueue(guild, announceChannel);
        } catch (e) {}
      };

      const onError = async (err) => {
        try {
          console.error('voice playback error', err);
          state.lastError = String(err && err.message ? err.message : err || 'unknown playback error');
          state.playing = false;
          state.current = null;
          if (AudioPlayerStatus) player.removeListener(AudioPlayerStatus.Idle, onIdle);
          if (announceChannel && typeof announceChannel.send === 'function') {
            await announceChannel.send({ embeds: [new EmbedBuilder().setColor(0xE74C3C).setDescription(`Failed to play: **${next.title || next.url}**. Skipping...`)] }).catch(() => null);
          }
          await playNextFromQueue(guild, announceChannel);
        } catch (e) {}
      };

      if (AudioPlayerStatus) player.once(AudioPlayerStatus.Idle, onIdle);
      player.once('error', onError);
      player.play(resource);

      if (announceChannel && typeof announceChannel.send === 'function') {
        await announceChannel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`▶️ Now playing: **${next.title || next.url}**`)] }).catch(() => null);
      }

      return true;
    } catch (e) {
      console.error('playNextFromQueue failed', e);
      try {
        const gid = String(guild && guild.id ? guild.id : '');
        const state = gid ? getQueueState(gid) : null;
        if (state) state.lastError = String(e && e.message ? e.message : e || 'unknown error');
      } catch (ee) {}
      return false;
    }
  };

  if (command === 'join') {
    if (!voiceLib || !joinVoiceChannel) return replyAsEmbed(message, 'Voice module is not available on this host. Install `@discordjs/voice`.');
    let targetChannel = null;
    if (args[0]) {
      const chId = args[0].replace(/[<#>]/g, '');
      targetChannel = message.guild.channels.cache.get(chId) || message.guild.channels.cache.find(c => c.name === args[0]);
    }
    if (!targetChannel) targetChannel = message.member.voice.channel;
    if (!targetChannel) return replyAsEmbed(message, 'You must be in a voice channel or provide a channel to join.');
    try {
      const connection = joinVoiceChannel({
        channelId: targetChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      const player = ensureGuildPlayer(message.guild.id);
      if (player) connection.subscribe(player);
      return replyAsEmbed(message, `Joined ${targetChannel.name}.`);
    } catch (e) {
      console.error('join error', e);
      return replyAsEmbed(message, 'Failed to join voice channel.');
    }
  }

  if (command === 'play') {
    if (!voiceLib || !joinVoiceChannel || !createAudioResource) {
      return replyAsEmbed(message, 'Voice module is not available on this host. Install `@discordjs/voice`.');
    }
    if (!playDl) {
      return replyAsEmbed(message, 'YouTube playback module is missing. Install `play-dl`.');
    }
    const rawUrlInput = String(args.join(' ') || '').trim();
    const url = normalizeYoutubeUrl(rawUrlInput);
    if (!url) return replyAsEmbed(message, 'Usage: `*play <youtube_link>`');
    const memberChannel = message.member && message.member.voice ? message.member.voice.channel : null;
    if (!memberChannel) return replyAsEmbed(message, 'You must be in a voice channel first.');

    try {
      let connection = getVoiceConnection ? getVoiceConnection(message.guild.id) : null;
      const currentChannelId = connection && connection.joinConfig ? String(connection.joinConfig.channelId || '') : '';
      if (connection && currentChannelId && currentChannelId !== String(memberChannel.id)) {
        return replyAsEmbed(message, 'I am already in another voice channel. Join that channel or use `*leave` first.');
      }
      if (!connection) {
        connection = joinVoiceChannel({
          channelId: memberChannel.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator,
          selfDeaf: true,
        });
      }

      const player = ensureGuildPlayer(message.guild.id);
      if (!player) return replyAsEmbed(message, 'Audio player could not be initialized.');
      connection.subscribe(player);

      const ytValid = (typeof playDl.yt_validate === 'function') ? playDl.yt_validate(url) : false;
      if (!ytValid || (ytValid !== 'video' && ytValid !== 'playlist')) {
        return replyAsEmbed(message, 'Please provide a valid YouTube video or playlist link.');
      }

      let streamUrl = url;
      if (ytValid === 'playlist' && typeof playDl.playlist_info === 'function') {
        try {
          const playlist = await playDl.playlist_info(url, { incomplete: true });
          const videos = playlist && typeof playlist.all_videos === 'function' ? await playlist.all_videos() : [];
          const first = Array.isArray(videos) ? videos.find(v => v && v.url) : null;
          if (first && first.url) streamUrl = normalizeYoutubeUrl(first.url) || first.url;
        } catch (e) {}
      }

      let title = url;
      try {
        const info = await playDl.video_basic_info(streamUrl);
        if (info && info.video_details && info.video_details.title) title = String(info.video_details.title);
      } catch (e) {}

      const state = getQueueState(message.guild.id);
      if (!state) return replyAsEmbed(message, 'Queue could not be initialized.');
      state.lastError = null;
      state.tracks.push({ url: streamUrl, title, requestedBy: String(message.author.id) });

      if (state.playing) {
        const position = state.tracks.length;
        return replyAsEmbed(message, `✅ Queued: **${title}** (position ${position})`);
      }

      const started = await playNextFromQueue(message.guild, message.channel);
      if (!started) {
        const details = state && state.lastError ? `\n\nDetails: ${String(state.lastError).slice(0, 250)}` : '';
        return replyAsEmbed(message, `Failed to start playback.${details}`);
      }
      return null;
    } catch (e) {
      console.error('play error', e);
      const details = String(e && e.message ? e.message : e || 'unknown error').slice(0, 250);
      return replyAsEmbed(message, `Failed to play this YouTube link.\n\nDetails: ${details}`);
    }
  }

  if (command === 'pause') {
    const player = guildVoicePlayers.get(String(message.guild.id));
    if (!player || !AudioPlayerStatus) return replyAsEmbed(message, 'Nothing is currently playing.');
    if (player.state.status !== AudioPlayerStatus.Playing) return replyAsEmbed(message, 'Nothing is currently playing.');
    const ok = player.pause(true);
    if (!ok) return replyAsEmbed(message, 'Failed to pause playback.');
    return replyAsEmbed(message, '⏸️ Playback paused.');
  }

  if (command === 'resume') {
    const player = guildVoicePlayers.get(String(message.guild.id));
    if (!player) return replyAsEmbed(message, 'Nothing to resume.');
    const ok = player.unpause();
    if (!ok) return replyAsEmbed(message, 'Nothing to resume.');
    return replyAsEmbed(message, '▶️ Playback resumed.');
  }

  if (command === 'stop') {
    const gid = String(message.guild.id);
    const player = guildVoicePlayers.get(gid);
    const state = getQueueState(gid);
    if (state) {
      state.tracks = [];
      state.current = null;
      state.playing = false;
    }
    if (player) {
      try { player.stop(); } catch (e) {}
    }
    return replyAsEmbed(message, '⏹️ Playback stopped and queue cleared.');
  }

  if (command === 'queue') {
    const state = getQueueState(message.guild.id);
    if (!state) return replyAsEmbed(message, 'Queue is unavailable.');
    const lines = [];
    if (state.current) lines.push(`Now: **${state.current.title || state.current.url}**`);
    if (state.tracks.length) {
      const next = state.tracks.slice(0, 10).map((t, i) => `${i + 1}. ${t.title || t.url}`);
      lines.push('', '**Up next:**', ...next);
      if (state.tracks.length > 10) lines.push(`...and ${state.tracks.length - 10} more`);
    }
    if (!state.current && !state.tracks.length) return replyAsEmbed(message, 'Queue is empty.');
    return replyAsEmbed(message, lines.join('\n'));
  }

  if (command === 'leave') {
    const gid = String(message.guild.id);
    const conn = getVoiceConnection ? getVoiceConnection(gid) : null;
    if (!conn) return replyAsEmbed(message, 'I am not connected to a voice channel in this guild.');
    try {
      const player = guildVoicePlayers.get(gid);
      if (player) {
        try { player.stop(); } catch (e) {}
        guildVoicePlayers.delete(gid);
      }
      const state = getQueueState(gid);
      if (state) {
        state.tracks = [];
        state.current = null;
        state.playing = false;
      }
      conn.destroy();
      return replyAsEmbed(message, 'Left the voice channel and stopped music.');
    } catch (e) {
      return replyAsEmbed(message, 'Failed to leave voice channel.');
    }
  }

  if (command === 'music') {
    return replyAsEmbed(message, 'Music commands: `*join`, `*play <youtube_link>`, `*pause`, `*resume`, `*stop`, `*queue`, `*leave`');
  }

    if (command === 'del' || command === 'delete') {
      if (!hasAdminCommandAccess(message)) return;
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
      if (!hasAdminCommandAccess(message)) return;

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
        let success = 0, failed = 0, skippedProtected = 0;
        for (const [mid, m] of members) {
          if (!m || m.user?.bot) continue;
          if (memberHasProtectedModerationRole(m)) { skippedProtected++; continue; }
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
            reason: `Bulk assigned role ${role.name} (${role.id}) — success=${success}, failed=${failed}, skippedProtected=${skippedProtected}`,
            extra: { roleId: role.id, roleName: role.name, success, failed, skippedProtected }
          });
        }
        return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x87CEFA).setDescription(`Bulk complete: assigned to ${success}, failed ${failed}, skipped protected ${skippedProtected}.`)] });
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
      if (memberHasProtectedModerationRole(member)) return replyCannotModerateUser(message, member.user || member.id);

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
          const embed = new EmbedBuilder().setTitle('Role assignment failed').setColor(0xE74C3C)
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
    if (!(await enforceRoleCommandAccess(message, command))) return;

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
        const embed = new EmbedBuilder().setTitle('Role removal failed').setColor(0xE74C3C)
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
    if (PRE_REG_ANNOUNCE_SOURCE_CHANNEL_IDS.has(channelId)) return;
    try {
      const watch = loadWatchChannels(message.guildId);
      if (!watch || !watch.has(channelId)) return;
    } catch (e) { return; }
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
    if (isClaimPanelLikeMessage(message, content)) return;
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
    if (!(await enforceRoleCommandAccess(message, command))) return;
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

// Scrim-style ampersand commands (e.g. &help, &add, &mf ...)
client.on('messageCreate', async (message) => {
  try {
    if (!message || !message.guild || !message.content || message.author?.bot) return;
    const txt = String(message.content || '').trim();
    if (!txt.startsWith('&')) return;
    if (!hasStaffCommandAccess(message)) return;

    const [raw, ...args] = txt.slice(1).trim().split(/\s+/);
    const cmd = String(raw || '').toLowerCase();
    if (!cmd) return;

    const guild = message.guild;
    const parentCategory = (message.channel && message.channel.parentId)
      ? (guild.channels.cache.get(String(message.channel.parentId)) || null)
      : null;
    const fromChannelMatch = String(message.channel?.name || '').match(/lobby[\s_-]*(\d+)/i);
    const fromCategoryMatch = String(parentCategory?.name || '').match(/^duo\s+session\s+\d+\s+lobby\s+(\d+)$/i);
    const currentLobbyNo = Math.max(1, Number(fromChannelMatch?.[1] || fromCategoryMatch?.[1] || 1));
    const lobbyBaseRe = new RegExp(`^lobby[\\s_-]*${currentLobbyNo}(?:[\\s_-]|$)`, 'i');
    const lobbyRoleName = `Lobby${currentLobbyNo}`;
    const lobbyStaffRoleName = `${lobbyRoleName} Staffs`;

    const everyoneId = guild.roles.everyone.id;
    const lobbyRole = guild.roles.cache.find(r => String(r.name || '').toLowerCase() === String(lobbyRoleName).toLowerCase()) || null;
    const lobbyStaffRole = guild.roles.cache.find(r => String(r.name || '').toLowerCase() === String(lobbyStaffRoleName).toLowerCase()) || null;

    const findLobbyTextChannel = (aliases = []) => {
      const wanted = aliases.map(a => String(a || '').toLowerCase()).filter(Boolean);
      return guild.channels.cache.find(c => {
        if (!c || c.type !== ChannelType.GuildText) return false;
        const name = String(c.name || '').toLowerCase();
        if (!lobbyBaseRe.test(name)) return false;
        return wanted.some(token => name.includes(token));
      }) || null;
    };

    const channels = {
      registration: findLobbyTextChannel(['registration', 'register']) || null,
      chat: findLobbyTextChannel(['chat']) || null,
      fills: findLobbyTextChannel(['fills', 'fill-req', 'fill-requests', 'fillreq']) || null,
      unreg: findLobbyTextChannel(['unreg', 'unregister', 'getting-off', 'gettingoff', 'getting']) || null,
      code: findLobbyTextChannel(['code']) || null,
      staff: findLobbyTextChannel(['staff', 'admin']) || null,
      category: parentCategory || guild.channels.cache.find(c => c && c.type === ChannelType.GuildCategory && new RegExp(`^duo\\s+session\\s+\\d+\\s+lobby\\s+${currentLobbyNo}$`, 'i').test(String(c.name || ''))) || null,
    };

    const hasStaffRole = !!(message.member && lobbyStaffRole && message.member.roles.cache.has(lobbyStaffRole.id));
    const isManager = !!(message.member && message.member.permissions && message.member.permissions.has(PermissionsBitField.Flags.ManageChannels));
    const isAdmin = hasStaffRole || isManager;

    const parseUserId = (input) => {
      const s = String(input || '').trim();
      if (!s) return null;
      const m = s.match(/^<@!?(\d+)>$/);
      if (m) return m[1];
      if (/^\d+$/.test(s)) return s;
      return null;
    };

    async function replyEmbed(title, description, color = 0x87CEFA) {
      const emb = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: `${client.user?.username || 'Nova Practice'} APP` })
        .setTitle(title)
        .setDescription(description || '')
        .setTimestamp();
      return message.reply({ embeds: [emb], allowedMentions: { repliedUser: false } });
    }

    const setReadOnlyForChannel = async (ch, { hide = false, allowLobbyWrite = false, visibleForEveryone = false } = {}) => {
      if (!ch) return false;
      const overwrites = [];
      if (hide) {
        overwrites.push({ id: everyoneId, deny: [PermissionsBitField.Flags.ViewChannel] });
        if (lobbyRole) overwrites.push({ id: lobbyRole.id, deny: [PermissionsBitField.Flags.ViewChannel] });
      } else {
        if (visibleForEveryone) {
          overwrites.push({ id: everyoneId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] });
        } else {
          overwrites.push({ id: everyoneId, deny: [PermissionsBitField.Flags.ViewChannel] });
        }
        if (lobbyRole) {
          overwrites.push({
            id: lobbyRole.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AddReactions].concat(allowLobbyWrite ? [PermissionsBitField.Flags.SendMessages] : []),
            deny: allowLobbyWrite ? [] : [PermissionsBitField.Flags.SendMessages],
          });
        }
      }
      if (lobbyStaffRole) {
        overwrites.push({ id: lobbyStaffRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages] });
      }
      await ch.edit({ permissionOverwrites: overwrites }).catch(() => null);
      return true;
    };

    const requireAdmin = async () => {
      if (isAdmin) return true;
      await replyEmbed('No Permission', `Only members with **${lobbyStaffRoleName}** (or Manage Channels) can use this command.`, 0xE74C3C);
      return false;
    };

    const statePath = path.join(DATA_DIR, 'scrim_cmd_state.json');
    const loadState = () => {
      const all = loadJson(statePath, {});
      const gid = String(guild.id);
      if (!all[gid]) all[gid] = { autoReactPing: false };
      return all;
    };
    const saveState = (all) => { try { saveJson(statePath, all || {}); } catch (e) {} };

    const getFillsControlMessage = async () => {
      if (!channels.fills) return null;
      const msgs = await channels.fills.messages.fetch({ limit: 50 }).catch(() => null);
      if (!msgs) return null;
      return msgs.find(m => m && m.author && client.user && m.author.id === client.user.id && m.embeds && m.embeds[0] && String(m.embeds[0].title || '').startsWith('Fills will open at')) || null;
    };

    const getUnregControlMessage = async () => {
      if (!channels.unreg) return null;
      const msgs = await channels.unreg.messages.fetch({ limit: 50 }).catch(() => null);
      if (!msgs) return null;
      return msgs.find(m => m && m.author && client.user && m.author.id === client.user.id && m.embeds && m.embeds[0] && String(m.embeds[0].title || '').startsWith('Getting off closes at')) || null;
    };

    if (cmd === 'help') {
      const emb = new EmbedBuilder()
        .setColor(0x1E90FF)
        .setTitle('Scrim Commands')
        .addFields(
          { name: 'Player Management', value: '`&add` - Register a user\n`&remove` - Unregister a user\n`&pl` - List registered players\n`&um` - List unmarked players\n`&con` - List contested marks\n`&react` - Toggle auto-ping for missing reactions\n`&rlist` - List missing reactions', inline: false },
          { name: 'Channel Controls', value: '`&mf` - Mute the fills channel\n`&uf` - Unmute the fills channel\n`&hf` - Hide the fills channel\n`&sf` - Show the fills channel\n`&hu` - Hide the unreg channel\n`&su` - Show the unreg channel\n`&unreg` - Set unreg close time', inline: false },
          { name: 'Utilities', value: '`&report` - Match report\n`&link` - Link Yunite tournament\n`&setup` - Setup code channel\n`&staffapply` - Post panel (current ch)\n`&staffapply #applications` - Set submit channel\n`&staffapply #panel #applications` - Choose both\n`&staffapply show` - Show current setup', inline: false },
          { name: 'Admin Commands', value: '`&create` - Create lobby (all options selectable)\nExamples: `&create 2` (Lobby 2) | `&create 5 2 14:40` | `&create session:5 lobby:2 reg:14:40`\n`&testlobby` - Create admin-only test lobby\n`&setlogs` - Configure all log channels for this server\n`&clearlogs` - Remove all log channel settings for this server\n`&setmodperms` - Configure role access for moderation commands\n`&reg` - Open registration\n`&creg` - Close registration\n`&hr` - Hide the registration channel\n`&sr` - Show the registration channel\n`&close` - Close lobby', inline: false },
        )
        .setTimestamp();
      return message.channel.send({ embeds: [emb] });
    }

    if (cmd === 'setmodperms') {
      const canManageGuild = !!(message.member && message.member.permissions && (
        message.member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)
      ));
      if (!canManageGuild) {
        return replyEmbed('No Permission', 'You need **Administrator** or **Manage Server** permission for `&setmodperms`.', 0xE74C3C);
      }

      const action = String((args[0] || 'show')).toLowerCase();
      const mentionRoles = Array.from(message.mentions.roles.values());
      const rawRoleIdArgs = args.slice(1).map(x => String(x || '').replace(/[<@&>]/g, '').trim()).filter(x => /^\d+$/.test(x));
      const explicitRoles = rawRoleIdArgs
        .map(id => guild.roles.cache.get(id))
        .filter(Boolean);
      const rolesInput = [...mentionRoles, ...explicitRoles].filter((role, idx, arr) => role && arr.findIndex(r => String(r.id) === String(role.id)) === idx);

      try {
        const all = loadModCommandPerms();
        if (!all.guilds || typeof all.guilds !== 'object') all.guilds = {};
        const gid = String(guild.id);
        if (!all.guilds[gid] || typeof all.guilds[gid] !== 'object') all.guilds[gid] = {};
        if (!Array.isArray(all.guilds[gid].allowedRoleIds)) all.guilds[gid].allowedRoleIds = [];
        if (!Array.isArray(all.guilds[gid].deniedRoleIds)) all.guilds[gid].deniedRoleIds = [];

        const g = all.guilds[gid];
        const addUnique = (arr, roleIds) => {
          const set = new Set((arr || []).map(String));
          for (const id of roleIds) set.add(String(id));
          return Array.from(set);
        };
        const removeMany = (arr, roleIds) => {
          const remove = new Set((roleIds || []).map(String));
          return (arr || []).map(String).filter(id => !remove.has(id));
        };

        const selectedIds = rolesInput.map(r => String(r.id));

        if (action === 'allow') {
          if (!selectedIds.length) return replyEmbed('Usage', '`&setmodperms allow @Role1 @Role2`', 0xE74C3C);
          g.allowedRoleIds = addUnique(g.allowedRoleIds, selectedIds);
          g.deniedRoleIds = removeMany(g.deniedRoleIds, selectedIds);
          saveModCommandPerms(all);
          return replyEmbed('Mod Perms Updated', `Allowed roles: ${rolesInput.map(r => `<@&${r.id}>`).join(', ')}`);
        }

        if (action === 'deny' || action === 'block') {
          if (!selectedIds.length) return replyEmbed('Usage', '`&setmodperms deny @Role1 @Role2`', 0xE74C3C);
          g.deniedRoleIds = addUnique(g.deniedRoleIds, selectedIds);
          g.allowedRoleIds = removeMany(g.allowedRoleIds, selectedIds);
          saveModCommandPerms(all);
          return replyEmbed('Mod Perms Updated', `Denied roles: ${rolesInput.map(r => `<@&${r.id}>`).join(', ')}`);
        }

        if (action === 'unallow') {
          if (!selectedIds.length) return replyEmbed('Usage', '`&setmodperms unallow @Role`', 0xE74C3C);
          g.allowedRoleIds = removeMany(g.allowedRoleIds, selectedIds);
          saveModCommandPerms(all);
          return replyEmbed('Mod Perms Updated', 'Removed role(s) from allow list.');
        }

        if (action === 'undeny' || action === 'unblock') {
          if (!selectedIds.length) return replyEmbed('Usage', '`&setmodperms undeny @Role`', 0xE74C3C);
          g.deniedRoleIds = removeMany(g.deniedRoleIds, selectedIds);
          saveModCommandPerms(all);
          return replyEmbed('Mod Perms Updated', 'Removed role(s) from deny list.');
        }

        if (action === 'clear') {
          g.allowedRoleIds = [];
          g.deniedRoleIds = [];
          saveModCommandPerms(all);
          return replyEmbed('Mod Perms Cleared', 'Custom moderation command role rules were removed for this server.');
        }

        const allowedText = (g.allowedRoleIds && g.allowedRoleIds.length)
          ? g.allowedRoleIds.map(id => `<@&${id}>`).join(', ')
          : 'none';
        const deniedText = (g.deniedRoleIds && g.deniedRoleIds.length)
          ? g.deniedRoleIds.map(id => `<@&${id}>`).join(', ')
          : 'none';
        return replyEmbed('Moderation Command Permissions', `Allowed roles: ${allowedText}\nDenied roles: ${deniedText}\n\nUsage:\n• \`&setmodperms allow @Role\`\n• \`&setmodperms deny @Role\`\n• \`&setmodperms unallow @Role\`\n• \`&setmodperms undeny @Role\`\n• \`&setmodperms clear\``);
      } catch (e) {
        console.error('setmodperms failed', e);
        return replyEmbed('Error', 'Failed to update moderation command permissions.', 0xE74C3C);
      }
    }

    if (cmd === 'setlogs') {
      const canManageGuild = !!(message.member && message.member.permissions && (
        message.member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)
      ));
      if (!canManageGuild) {
        return replyEmbed('No Permission', 'You need **Administrator** or **Manage Server** permission for `&setlogs`.', 0xE74C3C);
      }

      const resolveChannel = (token) => {
        const t = String(token || '').trim();
        if (!t) return null;
        const cleaned = t.replace(/[<#>]/g, '');
        if (/^\d+$/.test(cleaned)) {
          const byId = guild.channels.cache.get(cleaned);
          if (byId && byId.isTextBased && byId.isTextBased()) return byId;
        }
        const byMention = message.mentions.channels.find(ch => ch && ch.isTextBased && ch.isTextBased());
        if (byMention) return byMention;
        const byName = guild.channels.cache.find(ch => ch && ch.isTextBased && ch.isTextBased() && String(ch.name || '').toLowerCase() === t.toLowerCase().replace(/^#/, ''));
        return byName || null;
      };

      const raw = String(txt || '').replace(/^&setlogs\b/i, '').trim();
      const pick = {};
      const optRx = /(all|message|sessions|role|ticket|modlog|voice|blacklist|mod)\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/gi;
      let m;
      while ((m = optRx.exec(raw)) !== null) {
        const key = String(m[1] || '').toLowerCase();
        const val = String(m[2] || m[3] || m[4] || '').trim();
        if (key && val) pick[key] = val;
      }

      const mentions = Array.from(message.mentions.channels.values()).filter(ch => ch && ch.isTextBased && ch.isTextBased());
      const firstMention = mentions.length ? mentions[0] : null;

      const allTarget = resolveChannel(pick.all) || firstMention;
      const messageCh = resolveChannel(pick.message) || allTarget;
      const sessionsCh = resolveChannel(pick.sessions) || allTarget;
      const roleCh = resolveChannel(pick.role) || allTarget;
      const ticketCh = resolveChannel(pick.ticket) || allTarget;
      const modlogCh = resolveChannel(pick.modlog || pick.mod) || allTarget;
      const voiceCh = resolveChannel(pick.voice) || allTarget;
      const blacklistCh = resolveChannel(pick.blacklist) || allTarget;

      if (!messageCh && !sessionsCh && !roleCh && !ticketCh && !modlogCh && !voiceCh && !blacklistCh) {
        return replyEmbed('Usage', '`&setlogs #channel` (all logs)\noder z. B. `&setlogs message:#msg-log sessions:#sessions-log role:#role-log ticket:#ticket-log`', 0xE74C3C);
      }

      try {
        const cfgPath = path.join(DATA_DIR, 'config.json');
        const cfg = loadJson(cfgPath, {});
        if (!cfg.guilds || typeof cfg.guilds !== 'object') cfg.guilds = {};
        const gid = String(guild.id);
        if (!cfg.guilds[gid] || typeof cfg.guilds[gid] !== 'object') cfg.guilds[gid] = {};

        const g = cfg.guilds[gid];
        if (messageCh) {
          g.messageLogChannelId = String(messageCh.id);
          g.logChannelId = String(messageCh.id);
        }
        if (sessionsCh) g.sessionsLogChannelId = String(sessionsCh.id);
        if (roleCh) g.roleLogChannelId = String(roleCh.id);
        if (ticketCh) g.ticketLogChannelId = String(ticketCh.id);
        if (modlogCh) g.modLogChannelId = String(modlogCh.id);
        if (voiceCh) g.voiceLogChannelId = String(voiceCh.id);
        if (blacklistCh) g.blacklistLogChannelId = String(blacklistCh.id);

        saveJson(cfgPath, cfg);

        const lines = [];
        if (messageCh) lines.push(`Message: ${messageCh}`);
        if (sessionsCh) lines.push(`Sessions: ${sessionsCh}`);
        if (roleCh) lines.push(`Role: ${roleCh}`);
        if (ticketCh) lines.push(`Ticket: ${ticketCh}`);
        if (modlogCh) lines.push(`Modlog: ${modlogCh}`);
        if (voiceCh) lines.push(`Voice: ${voiceCh}`);
        if (blacklistCh) lines.push(`Blacklist: ${blacklistCh}`);

        return replyEmbed('Logs Updated', lines.join('\n'));
      } catch (e) {
        console.error('setlogs failed', e);
        return replyEmbed('Error', 'Failed to save log channel config.', 0xE74C3C);
      }
    }

    if (cmd === 'clearlogs') {
      const canManageGuild = !!(message.member && message.member.permissions && (
        message.member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)
      ));
      if (!canManageGuild) {
        return replyEmbed('No Permission', 'You need **Administrator** or **Manage Server** permission for `&clearlogs`.', 0xE74C3C);
      }

      try {
        const cfgPath = path.join(DATA_DIR, 'config.json');
        const cfg = loadJson(cfgPath, {});
        if (!cfg.guilds || typeof cfg.guilds !== 'object') cfg.guilds = {};
        const gid = String(guild.id);
        if (!cfg.guilds[gid] || typeof cfg.guilds[gid] !== 'object') cfg.guilds[gid] = {};

        const g = cfg.guilds[gid];
        const keys = [
          'messageLogChannelId',
          'logChannelId',
          'sessionsLogChannelId',
          'sessions_log_channel_id',
          'roleLogChannelId',
          'ticketLogChannelId',
          'modLogChannelId',
          'voiceLogChannelId',
          'blacklistLogChannelId',
        ];
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(g, key)) delete g[key];
        }

        saveJson(cfgPath, cfg);
        return replyEmbed('Logs Cleared', 'All configured log channels for this server were removed from config.');
      } catch (e) {
        console.error('clearlogs failed', e);
        return replyEmbed('Error', 'Failed to clear log channel config.', 0xE74C3C);
      }
    }

    if (cmd === 'staffapply' || cmd === 'staffbewerbung') {
      const canManageGuild = !!(message.member && message.member.permissions && (
        message.member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)
      ));
      if (!canManageGuild) {
        return replyEmbed('No Permission', 'You need **Administrator** or **Manage Server** permission for `&staffapply`.', 0xE74C3C);
      }

      try {
        const cfgPath = path.join(DATA_DIR, 'config.json');
        const cfg = loadJson(cfgPath, {});
        if (!cfg.guilds || typeof cfg.guilds !== 'object') cfg.guilds = {};
        const gid = String(guild.id);
        if (!cfg.guilds[gid] || typeof cfg.guilds[gid] !== 'object') cfg.guilds[gid] = {};

        const gcfg = cfg.guilds[gid];
        const rawTail = String(txt || '').replace(/^&staff(?:apply|bewerbung)\b/i, '').trim();
        const sub = String(args[0] || '').toLowerCase();

        const resolveTextChannel = (token) => {
          const t = String(token || '').trim();
          if (!t) return null;
          const cleaned = t.replace(/[<#>]/g, '');
          if (/^\d+$/.test(cleaned)) {
            const byId = guild.channels.cache.get(cleaned);
            if (byId && byId.isTextBased && byId.isTextBased()) return byId;
          }
          const byName = guild.channels.cache.find(ch => ch && ch.isTextBased && ch.isTextBased() && String(ch.name || '').toLowerCase() === t.toLowerCase().replace(/^#/, ''));
          return byName || null;
        };

        if (sub === 'show' || sub === 'status') {
          const panelId = String(gcfg.staffApplyPanelChannelId || '').trim();
          const submitId = String(gcfg.staffApplyChannelId || '').trim();
          const panelTxt = panelId ? `<#${panelId}>` : 'not set';
          const submitTxt = submitId ? `<#${submitId}>` : 'not set';
          return replyEmbed('Staff Apply Setup', `Panel channel: ${panelTxt}\nApplication channel: ${submitTxt}\n\nUsage:\n• \`&staffapply\`\n• \`&staffapply #applications\`\n• \`&staffapply #panel #applications\`\n• \`&staffapply panel:#panel submit:#applications\``);
        }

        const mentions = Array.from(message.mentions.channels.values()).filter(ch => ch && ch.isTextBased && ch.isTextBased());
        const panelMatch = rawTail.match(/\bpanel\s*:\s*(<#\d+>|\d+|#[^\s]+|[^\s]+)\b/i);
        const submitMatch = rawTail.match(/\bsubmit\s*:\s*(<#\d+>|\d+|#[^\s]+|[^\s]+)\b/i);
        const panelFromOpt = panelMatch ? resolveTextChannel(panelMatch[1]) : null;
        const submitFromOpt = submitMatch ? resolveTextChannel(submitMatch[1]) : null;

        let panelChannel = null;
        let submitChannel = null;

        if (panelFromOpt || submitFromOpt) {
          panelChannel = panelFromOpt || message.channel;
          submitChannel = submitFromOpt || panelChannel;
        } else if (mentions.length >= 2) {
          panelChannel = mentions[0];
          submitChannel = mentions[1];
        } else if (mentions.length === 1) {
          panelChannel = message.channel;
          submitChannel = mentions[0];
        } else {
          const existingPanel = resolveTextChannel(gcfg.staffApplyPanelChannelId);
          const existingSubmit = resolveTextChannel(gcfg.staffApplyChannelId);
          panelChannel = existingPanel || message.channel;
          submitChannel = existingSubmit || panelChannel;
        }

        if (!panelChannel || !submitChannel) {
          return replyEmbed('Usage', '`&staffapply`\n`&staffapply #applications`\n`&staffapply #panel #applications`\n`&staffapply panel:#panel submit:#applications`', 0xE74C3C);
        }

        gcfg.staffApplyPanelChannelId = String(panelChannel.id);
        gcfg.staffApplyChannelId = String(submitChannel.id);
        saveJson(cfgPath, cfg);

        const serverIconUrl = guild.iconURL({ extension: 'png', size: 256 }) || null;
        const panelEmbed = new EmbedBuilder()
          .setColor(0x1E90FF)
          .setTitle('PredCord Staff Application <:arena2:1476232477965160590>')
          .setDescription(
            '> __**Requirements:**__\n' +
            '• Speak *fluent english*\n' +
            '• Be atleast __14 years old__ and mature\n' +
            '• Be *active, fast and responsible*\n' +
            '• Have a bit experience with <@1122310434700148826> <@155149108183695360> & <@468459655929266176>\n' +
            '> Don\'t be shy and apply now, Good Luck <:_pepelove_:1469853241717162190>'
          )
          .setTimestamp();
        if (serverIconUrl) panelEmbed.setThumbnail(serverIconUrl);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('staff_apply_open').setLabel('Apply Now').setStyle(ButtonStyle.Primary)
        );

        await panelChannel.send({ embeds: [panelEmbed], components: [row] }).catch(() => null);
        return replyEmbed('Staff Apply Panel', `Panel posted in: ${panelChannel}\nApplications are sent to: ${submitChannel}`);
      } catch (e) {
        console.error('staffapply panel failed', e);
        return replyEmbed('Error', 'Failed to create staff application panel.', 0xE74C3C);
      }
    }

    if (cmd === 'testlobby') {
      const hasAdminPerm = !!(message.member && message.member.permissions && message.member.permissions.has(PermissionsBitField.Flags.Administrator));
      if (!hasAdminPerm) {
        return replyEmbed('No Permission', 'Only members with **Administrator** permission can use `&testlobby`.', 0xE74C3C);
      }

      try {
        const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
        const botCanManageChannels = !!(botMember && botMember.permissions.has(PermissionsBitField.Flags.ManageChannels));
        if (!botCanManageChannels) {
          return replyEmbed('Missing Permissions', 'I need **Manage Channels** for `&testlobby`.', 0xE74C3C);
        }

        const suffix = Date.now().toString().slice(-4);
        const categoryName = `test-lobby-${suffix}`;
        const category = await guild.channels.create({
          name: categoryName,
          type: ChannelType.GuildCategory,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          ],
        });

        const channelNames = ['test-registration', 'test-dropmap', 'test-code', 'test-chat', 'test-staff'];
        const created = [];
        for (const name of channelNames) {
          const ch = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: [
              { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            ],
          });
          created.push(ch);
        }

        return replyEmbed('Test Lobby Created', `Category: **${category.name}**\nChannels: ${created.map(c => `#${c.name}`).join(', ')}\nVisible only for users with admin permissions.`);
      } catch (e) {
        console.error('test lobby create failed', e);
        return replyEmbed('Error', 'Failed to create admin-only test lobby.', 0xE74C3C);
      }
    }

    if (cmd === 'create') {
      if (!(await requireAdmin())) return;
      try {
        const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
        const botCanManageChannels = !!(botMember && botMember.permissions.has(PermissionsBitField.Flags.ManageChannels));
        const botCanManageRoles = !!(botMember && botMember.permissions.has(PermissionsBitField.Flags.ManageRoles));
        if (!botCanManageChannels || !botCanManageRoles) {
          return replyEmbed('Missing Permissions', 'I need **Manage Channels** and **Manage Roles** for `&create`.', 0xE74C3C);
        }

        const parseHHMM = (input) => {
          const s = String(input || '').trim();
          const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
          if (!m) return null;
          return { hh: Number(m[1]), mm: Number(m[2]) };
        };
        const resolveNextTimestampSeconds = (hh, mm, now = new Date()) => {
          const d = new Date(now);
          d.setSeconds(0, 0);
          d.setHours(hh, mm, 0, 0);
          if (d.getTime() + 60_000 < now.getTime()) d.setDate(d.getDate() + 1);
          return Math.floor(d.getTime() / 1000);
        };
        const now = new Date();

        const createRaw = String(txt || '').replace(/^&create\b/i, '').trim();
        const createRawNormalized = createRaw.replace(/([^\s])((?:session|lobby|reg|template|category|lobbyrole|staffrole)\s*:)/gi, '$1 $2');
        const pick = {};
        const optionPattern = /(session|lobby|reg|template|category|lobbyrole|staffrole)\s*:\s*(?:"([^"]+)"|'([^']+)'|(.+?))(?=\s+(?:session|lobby|reg|template|category|lobbyrole|staffrole)\s*:|$)/gi;
        let mOpt;
        while ((mOpt = optionPattern.exec(createRawNormalized)) !== null) {
          const key = String(mOpt[1] || '').toLowerCase();
          const val = String(mOpt[2] || mOpt[3] || mOpt[4] || '').trim();
          if (key && val) pick[key] = val;
        }

        const plainArgs = args.filter(a => !String(a || '').includes(':'));
        const a0Num = Number(plainArgs[0]);
        const a1Num = Number(plainArgs[1]);
        const hasA0Num = Number.isFinite(a0Num) && a0Num > 0;
        const hasA1Num = Number.isFinite(a1Num) && a1Num > 0;
        const toPositiveInt = (value, fallback) => {
          const n = Number(value);
          if (!Number.isFinite(n) || n <= 0) return fallback;
          return Math.floor(n);
        };
        const lobbyWasExplicit = !!pick.lobby || hasA0Num || hasA1Num;
        if (!lobbyWasExplicit) {
          return replyEmbed('Usage', 'Please specify a lobby: `&create 2` or `&create session:5 lobby:2 reg:14:40`.', 0xE74C3C);
        }

        const sessionNo = toPositiveInt(
          pick.session ||
          (pick.lobby ? (hasA0Num ? a0Num : 5) : (hasA1Num ? a0Num : 5))
        , 5);
        const lobbyNo = toPositiveInt(
          pick.lobby ||
          (hasA1Num ? a1Num : (hasA0Num ? a0Num : 1))
        , 1);

        let regOpensRaw = String(pick.reg || args[2] || '').trim();
        const regLoose = regOpensRaw.match(/^([01]?\d|2[0-3])\s*[:;.,\s]\s*([0-5]?\d)$/);
        if (regLoose) {
          const hh = String(Number(regLoose[1])).padStart(2, '0');
          const mm = String(Number(regLoose[2])).padStart(2, '0');
          regOpensRaw = `${hh}:${mm}`;
        }
        if (!parseHHMM(regOpensRaw)) {
          const plusTwoMin = new Date(Date.now() + (2 * 60 * 1000));
          const hh = String(plusTwoMin.getHours()).padStart(2, '0');
          const mm = String(plusTwoMin.getMinutes()).padStart(2, '0');
          regOpensRaw = `${hh}:${mm}`;
        }
        const regOpensParsed = parseHHMM(regOpensRaw);
        if (!regOpensParsed) {
          return replyEmbed('Invalid Time', 'Use `reg:HH:MM` (example: `&create session:6 lobby:2 reg:14:40 template:"Pro Lobby" category:"Duo Session 6 Lobby 2" lobbyrole:"Lobby2" staffrole:"Lobby2 Staffs"`).', 0xE74C3C);
        }
        const regBaseTs = resolveNextTimestampSeconds(regOpensParsed.hh, regOpensParsed.mm, now);

        const lobbyTemplate = String(pick.template || args.slice(3).join(' ').trim() || `Lobby ${lobbyNo}`);

        const defaultCategoryName = `Duo Session ${sessionNo} Lobby ${lobbyNo}`;
        let categoryName = String(pick.category || defaultCategoryName).trim() || defaultCategoryName;

        const supportTs = regBaseTs + 60;
        const boosterTs = regBaseTs + 120;
        const verifiedTs = regBaseTs + 180;
        const fillsOpenTs = regBaseTs + (5 * 60);
        const unregCloseTs = regBaseTs + (5 * 60);

        const lobbyRoleName = String(pick.lobbyrole || `Lobby${lobbyNo}`).trim() || `Lobby${lobbyNo}`;
        const lobbyStaffRoleName = String(pick.staffrole || `${lobbyRoleName} Staffs`).trim() || `${lobbyRoleName} Staffs`;
        const lobbyPrefix = `lobby-${lobbyNo}`;
        const channelNames = {
          registration: `${lobbyPrefix}-registration`,
          dropmap: `${lobbyPrefix}-dropmap`,
          code: `${lobbyPrefix}-code`,
          chat: `${lobbyPrefix}-chat`,
          unreg: `${lobbyPrefix}-unreg`,
          fills: `${lobbyPrefix}-fills`,
          staff: `${lobbyPrefix}-staff`,
        };
        const fixedNames = [
          channelNames.registration,
          channelNames.dropmap,
          channelNames.code,
          channelNames.chat,
          channelNames.unreg,
          channelNames.fills,
          channelNames.staff,
        ];

        let createdLobbyRole = guild.roles.cache.find(r => String(r.name || '').toLowerCase() === lobbyRoleName.toLowerCase()) || null;
        if (!createdLobbyRole) {
          createdLobbyRole = await guild.roles.create({ name: lobbyRoleName, mentionable: true, reason: `Auto-created by &create for ${lobbyRoleName}` });
        }

        let createdLobbyStaffRole = guild.roles.cache.find(r => String(r.name || '').toLowerCase() === lobbyStaffRoleName.toLowerCase()) || null;
        if (!createdLobbyStaffRole) {
          createdLobbyStaffRole = await guild.roles.create({ name: lobbyStaffRoleName, mentionable: true, reason: `Auto-created by &create for ${lobbyStaffRoleName}` });
        }

        try {
          const lobbyRoleMapPath = path.join(DATA_DIR, 'lobby_role_map.json');
          const roleMap = loadJson(lobbyRoleMapPath, {});
          const gid = String(guild.id);
          if (!roleMap[gid]) roleMap[gid] = {};
          roleMap[gid][String(lobbyNo)] = {
            roleId: String(createdLobbyRole.id),
            staffRoleId: String(createdLobbyStaffRole.id),
            updatedAt: Date.now(),
          };
          saveJson(lobbyRoleMapPath, roleMap);
        } catch (e) {}

        let category = guild.channels.cache.find(c => c && c.type === 4 && String(c.name || '').toLowerCase() === String(categoryName).toLowerCase()) || null;
        if (!category) {
          category = await guild.channels.create({ name: categoryName, type: 4 });
        }
        categoryName = String(category.name || categoryName);
        try { await category.setPosition(0); } catch (e) {}

        const created = [];
        const existing = [];
        for (const name of fixedNames) {
          const found = guild.channels.cache.find(c => c && c.type === 0 && String(c.name) === name && c.parentId === category.id) || null;
          if (found) {
            existing.push(found);
            continue;
          }
          const ch = await guild.channels.create({ name, type: 0, parent: category.id });
          created.push(ch);
        }

        const byName = {};
        for (const name of fixedNames) {
          byName[name] = guild.channels.cache.find(c => c && c.type === 0 && String(c.name) === name && c.parentId === category.id) || null;
        }

        const everyoneRoleId = guild.roles.everyone.id;
        const hiddenForUnregistered = [
          { id: everyoneRoleId, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: createdLobbyRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AddReactions], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: createdLobbyStaffRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages] },
        ];
        const registrationOverwrites = [
          { id: everyoneRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: createdLobbyRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: createdLobbyStaffRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages] },
        ];

        const chatChannel = byName[channelNames.chat];
        if (chatChannel) {
          await chatChannel.edit({
            permissionOverwrites: [
              ...hiddenForUnregistered,
              { id: createdLobbyRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages] },
            ],
          }).catch(() => null);
        }

        const staffChannel = byName[channelNames.staff];
        if (staffChannel) {
          await staffChannel.edit({
            permissionOverwrites: [
              { id: everyoneRoleId, deny: [PermissionsBitField.Flags.ViewChannel] },
              { id: createdLobbyRole.id, deny: [PermissionsBitField.Flags.ViewChannel] },
              { id: createdLobbyStaffRole.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.SendMessages] },
            ],
          }).catch(() => null);
        }

        for (const name of [channelNames.dropmap, channelNames.code, channelNames.unreg, channelNames.fills]) {
          const ch = byName[name];
          if (!ch) continue;
          await ch.edit({ permissionOverwrites: hiddenForUnregistered }).catch(() => null);
        }
        const registrationChannel = byName[channelNames.registration];
        if (registrationChannel) {
          await registrationChannel.edit({ permissionOverwrites: registrationOverwrites }).catch(() => null);
        }

        const ordered = [
          channelNames.registration,
          channelNames.dropmap,
          channelNames.code,
          channelNames.chat,
          channelNames.unreg,
          channelNames.fills,
          channelNames.staff,
        ];
        for (let i = 0; i < ordered.length; i++) {
          const ch = byName[ordered[i]];
          if (ch) {
            try { await ch.setPosition(i); } catch (e) {}
          }
        }

        if (registrationChannel) {
          const hasPanel = await registrationChannel.messages.fetch({ limit: 20 }).then(msgs => {
            return msgs.some(m => m && m.author && m.author.id === client.user.id && Array.isArray(m.components) && m.components.some(row => Array.isArray(row.components) && row.components.some(comp => String(comp.customId || '') === 'lobby1_register')));
          }).catch(() => false);

          if (!hasPanel) {
            const registerEmbed = new EmbedBuilder()
              .setColor(0x1E90FF)
              .setTitle('Registered Players:')
              .setDescription(`@Supporter can register at <t:${supportTs}:t> (<t:${supportTs}:R>)\n@Server Booster @CC Priority can register at <t:${boosterTs}:t> (<t:${boosterTs}:R>)\n@Verified can register at <t:${verifiedTs}:t> (<t:${verifiedTs}:R>)`)
              .setThumbnail(client.user.displayAvatarURL());
            const registerRow = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId('lobby1_register').setLabel('Register').setStyle(ButtonStyle.Success)
            );
            await registrationChannel.send({ embeds: [registerEmbed], components: [registerRow] }).catch(() => null);
          }
        }

        const dropmapChannel = byName[channelNames.dropmap];
        if (dropmapChannel) {
          const hasDropmapPanel = await dropmapChannel.messages.fetch({ limit: 30 }).then(msgs => {
            return msgs.some(m => m && m.author && m.author.id === client.user.id && Array.isArray(m.components) && m.components.some(row => Array.isArray(row.components) && row.components.some(comp => String(comp.customId || '') === 'dropmap_mark')));
          }).catch(() => false);

          if (!hasDropmapPanel) {
            await dropmapChannel.send({
              embeds: [buildDropmapPanelEmbed(guild.id, dropmapChannel.id)],
              components: [buildDropmapPanelRow()],
            }).catch(() => null);
          }
        }

        if (chatChannel) {
          const hasChatInfo = await chatChannel.messages.fetch({ limit: 20 }).then(msgs => {
            return msgs.some(m => m && m.author && m.author.id === client.user.id && m.embeds && m.embeds[0] && String(m.embeds[0].title || '') === 'Please use English in this chat');
          }).catch(() => false);
          if (!hasChatInfo) {
            const chatEmbed = new EmbedBuilder()
              .setColor(0x1E90FF)
              .setTitle('Please use English in this chat')
              .setDescription('We want everyone to feel comfortable here. Thank you for understanding!');
            await chatChannel.send({ embeds: [chatEmbed] }).catch(() => null);
          }
        }

        const fillsChannel = byName[channelNames.fills];
        if (fillsChannel) {
          const existingFillsMsg = await fillsChannel.messages.fetch({ limit: 20 }).then(msgs => {
            return msgs.find(m => m && m.author && m.author.id === client.user.id && m.embeds && m.embeds[0] && String(m.embeds[0].title || '').startsWith('Fills will open at')) || null;
          }).catch(() => null);
          if (!existingFillsMsg) {
            const fillsEmbed = new EmbedBuilder()
              .setColor(0x1E90FF)
              .setTitle(`Fills will open at <t:${fillsOpenTs}:t>`)
              .setDescription('Please do not DM or ping staff; they will unlock this channel and request new teams when needed.\n\nReact below to show interest for a 2nd lobby.');
            const fillsMsg = await fillsChannel.send({ embeds: [fillsEmbed] }).catch(() => null);
            if (fillsMsg) {
              await fillsMsg.react('✅').catch(() => null);
            }
          } else {
            await existingFillsMsg.react('✅').catch(() => null);
            const oldTwoReaction = existingFillsMsg.reactions?.cache?.find(r => ['2️⃣', '2⃣', '2'].includes(String(r?.emoji?.name || '')));
            if (oldTwoReaction) await oldTwoReaction.remove().catch(() => null);
          }
        }

        const unregChannel = byName[channelNames.unreg];
        if (unregChannel) {
          const hasUnregInfo = await unregChannel.messages.fetch({ limit: 20 }).then(msgs => {
            return msgs.some(m => m && m.author && m.author.id === client.user.id && m.embeds && m.embeds[0] && String(m.embeds[0].title || '').startsWith('Getting off closes at'));
          }).catch(() => false);
          if (!hasUnregInfo) {
            const unregEmbed = new EmbedBuilder()
              .setColor(0x1E90FF)
              .setTitle(`Getting off closes at <t:${unregCloseTs}:t>`)
              .setDescription('Late unregistrations will result in a punishment!\nType `unreg` in this channel to unregister.');
            await unregChannel.send({ embeds: [unregEmbed] }).catch(() => null);
          }
        }

        if (registrationChannel && createdLobbyRole && createdLobbyRole.id) {
          const pingAtMs = Number(regBaseTs) * 1000;
          const sendRolePing = async () => {
            try {
              const pingMsg = await registrationChannel.send({
                content: `<@&${createdLobbyRole.id}> Registration is now open.`,
                allowedMentions: { roles: [createdLobbyRole.id] },
              }).catch(() => null);
              if (pingMsg) setTimeout(() => { try { pingMsg.delete().catch(() => {}); } catch (e) {} }, 5000);
            } catch (e) {}
          };

          const delayMs = Math.max(0, pingAtMs - Date.now());
          if (delayMs <= 2500) {
            await sendRolePing();
          } else {
            setTimeout(() => { sendRolePing().catch(() => {}); }, delayMs);
          }
        }

        const createdText = created.length ? created.map(c => `#${c.name}`).join(', ') : 'none';
        const existingText = existing.length ? existing.map(c => `#${c.name}`).join(', ') : 'none';
        return replyEmbed('Lobby Created', `Category: **${categoryName}**\nTemplate: **${lobbyTemplate}**\nRoles: ${createdLobbyRole} / ${createdLobbyStaffRole}\nCreated: ${createdText}\nAlready existed: ${existingText}`);
      } catch (e) {
        console.error('ampersand create failed', e);
        return replyEmbed('Error', 'Failed to create channels with `&create`.', 0xE74C3C);
      }
    }

    if (cmd === 'add') {
      if (!(await requireAdmin())) return;
      if (!lobbyRole) return replyEmbed('Missing Role', 'Role **Lobby1** not found. Run `/create` first.', 0xE74C3C);
      const id = parseUserId(args[0]) || (message.mentions.users.first() ? message.mentions.users.first().id : null);
      if (!id) return replyEmbed('Usage', '`&add @user`');
      const member = await guild.members.fetch(String(id)).catch(() => null);
      if (!member) return replyEmbed('Error', 'User not found in this server.', 0xE74C3C);
      if (member.roles.cache.has(lobbyRole.id)) return replyEmbed('Info', `${member} already has ${lobbyRole}.`);
      await member.roles.add(lobbyRole, `&add by ${message.author.id}`).catch(() => null);
      return replyEmbed('Registered', `${member} got ${lobbyRole}.`);
    }

    if (cmd === 'remove') {
      if (!(await requireAdmin())) return;
      if (!lobbyRole) return replyEmbed('Missing Role', 'Role **Lobby1** not found.', 0xE74C3C);
      const id = parseUserId(args[0]) || (message.mentions.users.first() ? message.mentions.users.first().id : null);
      if (!id) return replyEmbed('Usage', '`&remove @user`');
      const member = await guild.members.fetch(String(id)).catch(() => null);
      if (!member) return replyEmbed('Error', 'User not found in this server.', 0xE74C3C);
      if (!member.roles.cache.has(lobbyRole.id)) return replyEmbed('Info', `${member} does not have ${lobbyRole}.`);
      await member.roles.remove(lobbyRole, `&remove by ${message.author.id}`).catch(() => null);
      return replyEmbed('Unregistered', `${member} removed from ${lobbyRole}.`);
    }

    if (cmd === 'pl') {
      if (!lobbyRole) return replyEmbed('Registered Players', 'Role **Lobby1** not found.');
      const members = guild.members.cache.filter(m => m && !m.user.bot && m.roles.cache.has(lobbyRole.id));
      if (!members.size) return replyEmbed('Registered Players', 'No registered players yet.');
      const lines = Array.from(members.values()).slice(0, 80).map(m => `• ${m}`);
      return replyEmbed('Registered Players', lines.join('\n'));
    }

    if (cmd === 'rlist' || cmd === 'um' || cmd === 'con') {
      if (!(await requireAdmin())) return;
      if (!lobbyRole) return replyEmbed('Error', 'Role **Lobby1** not found.', 0xE74C3C);
      const fillsMsg = await getFillsControlMessage();
      if (!fillsMsg) return replyEmbed('Reactions', 'No fills control message found in #lobby-1-fills.', 0xE74C3C);

      const registered = guild.members.cache
        .filter(m => m && !m.user.bot && m.roles.cache.has(lobbyRole.id))
        .map(m => String(m.id));

      const userToReactionKinds = new Map();
      for (const reaction of fillsMsg.reactions.cache.values()) {
        try {
          const users = await reaction.users.fetch();
          for (const u of users.values()) {
            if (!u || u.bot) continue;
            const key = String(u.id);
            if (!userToReactionKinds.has(key)) userToReactionKinds.set(key, new Set());
            userToReactionKinds.get(key).add(String(reaction.emoji.id || reaction.emoji.name || 'emoji'));
          }
        } catch (e) {}
      }

      const missing = registered.filter(id => !userToReactionKinds.has(String(id)));
      const contested = registered.filter(id => {
        const set = userToReactionKinds.get(String(id));
        return set && set.size > 1;
      });

      if (cmd === 'um') {
        if (!missing.length) return replyEmbed('Unmarked Players', 'No unmarked players.');
        return replyEmbed('Unmarked Players', missing.slice(0, 80).map(id => `• <@${id}>`).join('\n'));
      }
      if (cmd === 'con') {
        if (!contested.length) return replyEmbed('Contested Marks', 'No contested marks.');
        return replyEmbed('Contested Marks', contested.slice(0, 80).map(id => `• <@${id}>`).join('\n'));
      }

      const totalReacts = Array.from(userToReactionKinds.values()).reduce((n, set) => n + (set ? set.size : 0), 0);
      return replyEmbed('Reaction List', `Registered: **${registered.length}**\nMarked: **${registered.length - missing.length}**\nMissing: **${missing.length}**\nContested: **${contested.length}**\nTotal reaction marks: **${totalReacts}**`);
    }

    if (cmd === 'react') {
      if (!(await requireAdmin())) return;
      const all = loadState();
      const gid = String(guild.id);
      const prev = !!(all[gid] && all[gid].autoReactPing);
      all[gid].autoReactPing = !prev;
      saveState(all);
      return replyEmbed('Auto-Ping', `Auto-ping for missing reactions is now **${all[gid].autoReactPing ? 'ON' : 'OFF'}**.`);
    }

    if (cmd === 'mf') {
      if (!(await requireAdmin())) return;
      if (!channels.fills) return replyEmbed('Error', '#lobby-1-fills not found.', 0xE74C3C);
      await channels.fills.permissionOverwrites.edit(everyoneId, { SendMessages: false, ViewChannel: false }).catch(() => null);
      if (lobbyRole) await channels.fills.permissionOverwrites.edit(lobbyRole.id, { SendMessages: false, ViewChannel: true, ReadMessageHistory: true, AddReactions: true }).catch(() => null);
      return replyEmbed('Fills Channel', 'Muted #lobby-1-fills for members.');
    }

    if (cmd === 'uf') {
      if (!(await requireAdmin())) return;
      if (!channels.fills) return replyEmbed('Error', '#lobby-1-fills not found.', 0xE74C3C);
      await channels.fills.permissionOverwrites.edit(everyoneId, { SendMessages: false, ViewChannel: false }).catch(() => null);
      if (lobbyRole) await channels.fills.permissionOverwrites.edit(lobbyRole.id, { SendMessages: true, ViewChannel: true, ReadMessageHistory: true, AddReactions: true }).catch(() => null);
      return replyEmbed('Fills Channel', 'Unmuted #lobby-1-fills for Lobby1 members.');
    }

    if (cmd === 'hf') {
      if (!(await requireAdmin())) return;
      if (!channels.fills) return replyEmbed('Error', '#lobby-1-fills not found.', 0xE74C3C);
      await setReadOnlyForChannel(channels.fills, { hide: true, allowLobbyWrite: false });
      return replyEmbed('Fills Channel', 'Hidden #lobby-1-fills from members.');
    }

    if (cmd === 'sf') {
      if (!(await requireAdmin())) return;
      if (!channels.fills) return replyEmbed('Error', '#lobby-1-fills not found.', 0xE74C3C);
      await setReadOnlyForChannel(channels.fills, { hide: false, allowLobbyWrite: false });
      return replyEmbed('Fills Channel', 'Shown #lobby-1-fills (read-only for members).');
    }

    if (cmd === 'hu') {
      if (!(await requireAdmin())) return;
      if (!channels.unreg) return replyEmbed('Error', '#lobby-1-unreg not found.', 0xE74C3C);
      await setReadOnlyForChannel(channels.unreg, { hide: true, allowLobbyWrite: false });
      return replyEmbed('Unreg Channel', 'Hidden #lobby-1-unreg from members.');
    }

    if (cmd === 'su') {
      if (!(await requireAdmin())) return;
      if (!channels.unreg) return replyEmbed('Error', '#lobby-1-unreg not found.', 0xE74C3C);
      await setReadOnlyForChannel(channels.unreg, { hide: false, allowLobbyWrite: false });
      return replyEmbed('Unreg Channel', 'Shown #lobby-1-unreg (read-only for members).');
    }

    if (cmd === 'hr') {
      if (!(await requireAdmin())) return;
      if (!channels.registration) return replyEmbed('Error', '#lobby-1-registration not found.', 0xE74C3C);
      await setReadOnlyForChannel(channels.registration, { hide: true, allowLobbyWrite: false });
      return replyEmbed('Registration Channel', 'Hidden #lobby-1-registration from members.');
    }

    if (cmd === 'sr') {
      if (!(await requireAdmin())) return;
      if (!channels.registration) return replyEmbed('Error', '#lobby-1-registration not found.', 0xE74C3C);
      await setReadOnlyForChannel(channels.registration, { hide: false, allowLobbyWrite: false, visibleForEveryone: true });
      return replyEmbed('Registration Channel', 'Shown #lobby-1-registration (read-only for members).');
    }

    if (cmd === 'reg') {
      if (!(await requireAdmin())) return;
      if (!channels.registration) return replyEmbed('Error', '#lobby-1-registration not found.', 0xE74C3C);
      await setReadOnlyForChannel(channels.registration, { hide: false, allowLobbyWrite: false, visibleForEveryone: true });
      return replyEmbed('Registration', 'Registration opened (channel visible). Players can use the Register button.');
    }

    if (cmd === 'creg') {
      if (!(await requireAdmin())) return;
      if (!channels.registration) return replyEmbed('Error', '#lobby-1-registration not found.', 0xE74C3C);
      await setReadOnlyForChannel(channels.registration, { hide: true, allowLobbyWrite: false });
      return replyEmbed('Registration', 'Registration closed (channel hidden).');
    }

    if (cmd === 'unreg') {
      if (!(await requireAdmin())) return;
      const timeText = (args[0] || '').trim();
      if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(timeText)) return replyEmbed('Usage', '`&unreg HH:MM` (example: `&unreg 00:05`)');
      const msg = await getUnregControlMessage();
      if (!msg) return replyEmbed('Error', 'Unregister panel message not found in #lobby-1-unreg.', 0xE74C3C);
      const [hh, mm] = timeText.split(':').map(Number);
      const d = new Date();
      d.setSeconds(0, 0);
      d.setHours(hh, mm, 0, 0);
      if (d.getTime() + 60_000 < Date.now()) d.setDate(d.getDate() + 1);
      const unregTs = Math.floor(d.getTime() / 1000);
      const emb = new EmbedBuilder()
        .setColor(0x1E90FF)
        .setTitle(`Getting off closes at <t:${unregTs}:t>`)
        .setDescription('Late unregistrations will result in a punishment!\nType `unreg` in this channel to unregister.');
      await msg.edit({ embeds: [emb], components: [] }).catch(() => null);
      return replyEmbed('Unreg Time', `Updated unreg close time to **${timeText}**.`);
    }

    if (cmd === 'setup') {
      if (!(await requireAdmin())) return;

      const setupRaw = String(txt || '').replace(/^&setup\b/i, '').trim();
      const channelLobbyMatch = String(message.channel?.name || '').match(/lobby[\s_-]*(\d+)/i);
      const parentCategory = (message.channel && message.channel.parentId)
        ? (guild.channels.cache.get(String(message.channel.parentId)) || null)
        : null;
      const categoryLobbyMatch = String(parentCategory?.name || '').match(/^duo\s+session\s+\d+\s+lobby\s+(\d+)$/i);
      if (!channelLobbyMatch && !categoryLobbyMatch) {
        return replyEmbed('Error', '`&setup` works only inside lobby channels/categories (for example `#lobby-1-code`).', 0xE74C3C);
      }
      const targetLobbyNo = Number(channelLobbyMatch?.[1] || categoryLobbyMatch?.[1] || 1);
      const targetLobbyBaseRe = new RegExp(`^lobby[\\s_-]*${Math.max(1, targetLobbyNo)}(?:[\\s_-]|$)`, 'i');
      const findTargetLobbyTextChannel = (aliases = []) => {
        const wanted = aliases.map(a => String(a || '').toLowerCase()).filter(Boolean);
        return guild.channels.cache.find(c => {
          if (!c || c.type !== ChannelType.GuildText) return false;
          const name = String(c.name || '').toLowerCase();
          if (!targetLobbyBaseRe.test(name)) return false;
          return wanted.some(token => name.includes(token));
        }) || null;
      };

      const targetDropmapName = `lobby-${Math.max(1, targetLobbyNo)}-dropmap`;
      const targetDropmapChannel = findTargetLobbyTextChannel(['dropmap']) || null;
      const targetChatName = `lobby-${Math.max(1, targetLobbyNo)}-chat`;
      const targetChatChannel = findTargetLobbyTextChannel(['chat']) || channels.chat || null;
      const targetCodeName = `lobby-${Math.max(1, targetLobbyNo)}-code`;
      const targetCodeChannel = findTargetLobbyTextChannel(['code']) || channels.code || null;
      if (!targetCodeChannel) return replyEmbed('Error', `#${targetCodeName} not found.`, 0xE74C3C);

      const urlArgs = args.filter(a => /^https?:\/\//i.test(String(a || ''))).map(a => String(a || '').trim()).filter(Boolean);
      const maybeUrl = urlArgs[0] || '';
      const maybeDropmapUrl = urlArgs[1] || '';
      const timeParts = args
        .filter(a => !/^https?:\/\//i.test(String(a || '')))
        .filter(a => !/^lobby\s*:\s*\d+$/i.test(String(a || '')))
        .map(a => String(a || '').trim())
        .filter(Boolean);

      const timeRaw = String(timeParts.join(' ') || '40').trim();
      const now = new Date();
      let gameDate = new Date(now);

      if (/^\d{1,2}$/.test(timeRaw)) {
        const minute = Math.max(0, Math.min(59, Number(timeRaw)));
        gameDate.setSeconds(0, 0);
        gameDate.setMinutes(minute, 0, 0);
        if (gameDate.getTime() <= now.getTime()) gameDate.setHours(gameDate.getHours() + 1);
      } else if (/^([01]?\d|2[0-3]):([0-5]\d)$/.test(timeRaw)) {
        const [hh, mm] = timeRaw.split(':').map(Number);
        gameDate.setSeconds(0, 0);
        gameDate.setHours(hh, mm, 0, 0);
        if (gameDate.getTime() <= now.getTime()) gameDate.setDate(gameDate.getDate() + 1);
      } else {
        return replyEmbed('Usage', 'Time format: `&setup 40` (next :40) or `&setup 16:40`.', 0xE74C3C);
      }

      const gameTs = Math.floor(gameDate.getTime() / 1000);
      const preGameTs = gameTs - (5 * 60);
      const gameTimeText = `<t:${gameTs}:t>`;

      const dropmapText = targetDropmapChannel ? `${targetDropmapChannel}` : `#${targetDropmapName}`;
      const leaderboardText = maybeUrl ? `[Yunite Leaderboard](${maybeUrl})` : 'Leaderboard link will be shared by staff.';
      const setupContact = `<@${message.author.id}>`;

      const infoEmbed = new EmbedBuilder()
        .setColor(0x1E90FF)
        .setTitle('Information')
        .setDescription(`You have 5 minutes to mark your dropspot in ${dropmapText}. Need help? Follow this guide.\n\nThe leaderboard of the session is here: ${leaderboardText}. To track points correctly please upload replays there.\n\nIf you face any issues during the session, contact ${setupContact}.`);

      const gameEmbed = new EmbedBuilder()
        .setColor(0x1E90FF)
        .setTitle(`First game at ${gameTimeText}`)
        .setDescription(`Starts ${`<t:${gameTs}:R>`}`);

      await targetCodeChannel.send({ embeds: [infoEmbed, gameEmbed] }).catch(() => null);

      if (targetDropmapChannel) {
        const dropmapEmbed = new EmbedBuilder()
          .setColor(0x1E90FF)
          .setTitle('Dropmap Marking')
          .setDescription(
            `Mark your spot on the map:\n` +
            `https://www.landingtutorial.com/lobby_watch.php?id=T8JRLKSH\n\n` +
            `• Max **4 cons**.\n` +
            `• **No** Triple con.\n` +
            `• You **can't go** in other spots until 2nd zone.\n\n` +
            `If you have a problem ping ${setupContact}`
          );
        await targetDropmapChannel.send({ embeds: [dropmapEmbed] }).catch(() => null);
      }

      let chatStatus = 'missing';
      if (targetChatChannel) {
        try {
          const hasChatInfo = await targetChatChannel.messages.fetch({ limit: 30 }).then(msgs => {
            return msgs.some(m => m && m.author && client.user && m.author.id === client.user.id && m.embeds && m.embeds[0] && String(m.embeds[0].title || '') === 'Please use English in this chat');
          }).catch(() => false);

          if (!hasChatInfo) {
            const chatEmbed = new EmbedBuilder()
              .setColor(0x1E90FF)
              .setTitle('Please use English in this chat')
              .setDescription('We want everyone to feel comfortable here. Thank you for understanding!');
            await targetChatChannel.send({ embeds: [chatEmbed] }).catch(() => null);
          }
          chatStatus = 'updated';
        } catch (e) {}
      }

      const targetFillsName = `lobby-${Math.max(1, targetLobbyNo)}-fills`;
      const targetUnregName = `lobby-${Math.max(1, targetLobbyNo)}-unreg`;
      const findLobbyTextChannel = (exactNames = [], partialNames = []) => {
        const exactSet = new Set(exactNames.map(n => String(n || '').toLowerCase()).filter(Boolean));
        const partialSet = partialNames.map(n => String(n || '').toLowerCase()).filter(Boolean);
        return guild.channels.cache.find(c => {
          if (!c || c.type !== ChannelType.GuildText) return false;
          const name = String(c.name || '').toLowerCase();
          if (!targetLobbyBaseRe.test(name)) return false;
          if (exactSet.has(name)) return true;
          return partialSet.some(p => name.includes(p));
        }) || null;
      };
      const targetFillsChannel = findLobbyTextChannel(
        [targetFillsName, `lobby-${Math.max(1, targetLobbyNo)}-fill-requests`, `lobby-${Math.max(1, targetLobbyNo)}-fill-req`],
        ['fill-req', 'fill', 'fills']
      );
      const targetUnregChannel = findLobbyTextChannel(
        [targetUnregName, `lobby-${Math.max(1, targetLobbyNo)}-getting-off`, `lobby-${Math.max(1, targetLobbyNo)}-gettingoff`],
        ['getting-off', 'getting', 'unreg', 'unregister']
      );
      let fillsStatus = 'missing';
      let unregStatus = 'missing';

      if (targetFillsChannel) {
        try {
          const fillsEmbed = new EmbedBuilder()
            .setColor(0x1E90FF)
            .setTitle(`Fills will open at <t:${preGameTs}:t>`)
            .setDescription('Please do not DM or ping staff; they will unlock this channel and request new teams when needed.\n\nReact below to show interest for a 2nd lobby.');

          const existingFillsMsg = await targetFillsChannel.messages.fetch({ limit: 50 }).then(msgs => {
            return msgs.find(m => m && m.author && client.user && m.author.id === client.user.id && m.embeds && m.embeds[0] && String(m.embeds[0].title || '').startsWith('Fills will open at')) || null;
          }).catch(() => null);

          if (existingFillsMsg) {
            await existingFillsMsg.edit({ embeds: [fillsEmbed], components: [] }).catch(() => null);
            await existingFillsMsg.react('✅').catch(() => null);
            const oldTwoReaction = existingFillsMsg.reactions?.cache?.find(r => ['2️⃣', '2⃣', '2'].includes(String(r?.emoji?.name || '')));
            if (oldTwoReaction) await oldTwoReaction.remove().catch(() => null);
          } else {
            const fillsMsg = await targetFillsChannel.send({ embeds: [fillsEmbed] }).catch(() => null);
            if (fillsMsg) {
              await fillsMsg.react('✅').catch(() => null);
            }
          }
          fillsStatus = 'updated';
        } catch (e) {}
      }

      if (targetUnregChannel) {
        try {
          const unregEmbed = new EmbedBuilder()
            .setColor(0x1E90FF)
            .setTitle(`Getting off closes at <t:${preGameTs}:t>`)
            .setDescription('Late unregistrations will result in a punishment!\nType `unreg` in this channel to unregister.');

          const existingUnregMsg = await targetUnregChannel.messages.fetch({ limit: 50 }).then(msgs => {
            return msgs.find(m => m && m.author && client.user && m.author.id === client.user.id && m.embeds && m.embeds[0] && String(m.embeds[0].title || '').startsWith('Getting off closes at')) || null;
          }).catch(() => null);

          if (existingUnregMsg) {
            await existingUnregMsg.edit({ embeds: [unregEmbed], components: [] }).catch(() => null);
          } else {
            await targetUnregChannel.send({ embeds: [unregEmbed] }).catch(() => null);
          }
          unregStatus = 'updated';
        } catch (e) {}
      }

      const fillsResult = fillsStatus === 'updated' ? `${targetFillsChannel}` : `not found (${targetFillsName} / fill-req...)`;
      const unregResult = unregStatus === 'updated' ? `${targetUnregChannel}` : `not found (${targetUnregName} / getting-off...)`;
      const chatResult = chatStatus === 'updated' ? `${targetChatChannel}` : `not found (${targetChatName})`;
      const yuniteLine = maybeUrl ? '\nYunite link added.' : '';
      const dropmapLine = maybeDropmapUrl
        ? `\nDropmap link posted in ${targetDropmapChannel ? `${targetDropmapChannel}` : `#${targetDropmapName}`}.`
        : '';
      return replyEmbed('Setup Complete', `Code message sent in ${targetCodeChannel}. First game: **${gameTimeText}**\nChat: ${chatResult}\nFills: ${fillsResult}\nUnreg: ${unregResult}\nTarget time: **<t:${preGameTs}:t>** (5 minutes before game).${yuniteLine}${dropmapLine}`);
    }

    if (cmd === 'link') {
      if (!(await requireAdmin())) return;
      const url = (args[0] || '').trim();
      if (!/^https?:\/\//i.test(url)) return replyEmbed('Usage', '`&link https://...`');
      const target = channels.code || message.channel;
      const emb = new EmbedBuilder().setColor(0x1E90FF).setTitle('Yunite Tournament Link').setDescription(url);
      await target.send({ embeds: [emb] }).catch(() => null);
      return replyEmbed('Link', 'Tournament link posted.');
    }

    if (cmd === 'report') {
      if (!(await requireAdmin())) return;
      const body = args.join(' ').trim();
      if (!body) return replyEmbed('Usage', '`&report <text>`');
      const target = channels.staff || message.channel;
      const emb = new EmbedBuilder().setColor(0x1E90FF).setTitle('Match Report').setDescription(body).addFields({ name: 'By', value: `${message.author}` });
      await target.send({ embeds: [emb] }).catch(() => null);
      return replyEmbed('Report', `Report posted in ${target}.`);
    }

    if (cmd === 'close') {
      if (!(await requireAdmin())) return;
      const toDelete = new Map();
      const categoryIdsToDelete = new Set();

      const argLobbyNo = Number(args[0] || 0);
      const hasArgLobbyNo = Number.isFinite(argLobbyNo) && argLobbyNo > 0;
      const fromChannelMatch = String(message.channel?.name || '').match(/lobby[\s_-]*(\d+)/i);
      const parentCategory = (message.channel && message.channel.parentId)
        ? (guild.channels.cache.get(String(message.channel.parentId)) || null)
        : null;
      const fromCategoryMatch = String(parentCategory?.name || '').match(/^duo\s+session\s+\d+\s+lobby\s+(\d+)$/i);

      const lobbyNoTarget = Number(
        hasArgLobbyNo ? argLobbyNo : (fromChannelMatch?.[1] || fromCategoryMatch?.[1] || 0)
      );
      if (!lobbyNoTarget || lobbyNoTarget < 1) {
        return replyEmbed('Usage', 'Use `&close` inside a lobby channel, or `&close <lobbyNo>` (example: `&close 2`).', 0xE74C3C);
      }

      const lobbyPrefixRe = new RegExp(`^lobby[\\s_-]*${lobbyNoTarget}(?:[\\s_-]|$)`, 'i');

      if (fromCategoryMatch && Number(fromCategoryMatch[1]) === lobbyNoTarget && parentCategory) {
        categoryIdsToDelete.add(String(parentCategory.id));
      } else if (hasArgLobbyNo) {
        const matchingCats = guild.channels.cache.filter(c => c && c.type === ChannelType.GuildCategory && new RegExp(`^duo\\s+session\\s+\\d+\\s+lobby\\s+${lobbyNoTarget}$`, 'i').test(String(c.name || '')));
        for (const c of matchingCats.values()) categoryIdsToDelete.add(String(c.id));
      }

      const lobbyPrefixChannels = guild.channels.cache.filter(c => c && c.type === ChannelType.GuildText && lobbyPrefixRe.test(String(c.name || '')));
      for (const ch of lobbyPrefixChannels.values()) toDelete.set(String(ch.id), ch);

      for (const catId of categoryIdsToDelete.values()) {
        const children = guild.channels.cache.filter(c => c && String(c.parentId || '') === String(catId));
        for (const ch of children.values()) toDelete.set(String(ch.id), ch);
      }

      const startedMsg = await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x1E90FF).setTitle('Lobby Close').setDescription('Deleting lobby channels...')] }).catch(() => null);

      let deletedCount = 0;
      for (const ch of toDelete.values()) {
        try {
          await ch.delete(`Lobby close by ${message.author.id}`);
          deletedCount += 1;
        } catch (e) {}
      }

      let deletedCategories = 0;
      for (const catId of categoryIdsToDelete.values()) {
        const cat = guild.channels.cache.get(String(catId));
        if (!cat) continue;
        try {
          await cat.delete(`Lobby close by ${message.author.id}`);
          deletedCategories += 1;
        } catch (e) {}
      }

      const roleName = `Lobby${lobbyNoTarget}`;
      const roleStaffName = `${roleName} Staffs`;
      const mappedRoleIds = new Set();
      let roleMap = {};
      const lobbyRoleMapPath = path.join(DATA_DIR, 'lobby_role_map.json');
      try {
        roleMap = loadJson(lobbyRoleMapPath, {});
        const mapped = roleMap?.[String(guild.id)]?.[String(lobbyNoTarget)] || null;
        if (mapped && mapped.roleId) mappedRoleIds.add(String(mapped.roleId));
        if (mapped && mapped.staffRoleId) mappedRoleIds.add(String(mapped.staffRoleId));
      } catch (e) {}

      const rolesToDelete = guild.roles.cache.filter(r => {
        const rn = String(r?.name || '').toLowerCase();
        return mappedRoleIds.has(String(r.id)) || rn === roleName.toLowerCase() || rn === roleStaffName.toLowerCase();
      });
      let deletedRoles = 0;
      for (const role of rolesToDelete.values()) {
        try {
          await role.delete(`Lobby close by ${message.author.id}`);
          deletedRoles += 1;
        } catch (e) {}
      }

      try {
        const gid = String(guild.id);
        if (roleMap && roleMap[gid] && roleMap[gid][String(lobbyNoTarget)]) {
          delete roleMap[gid][String(lobbyNoTarget)];
          saveJson(lobbyRoleMapPath, roleMap);
        }
      } catch (e) {}

      const summary = `Closed Lobby **${lobbyNoTarget}**\nDeleted channels: **${deletedCount}**\nDeleted categories: **${deletedCategories}**\nDeleted roles: **${deletedRoles}**.`;
      if (startedMsg && startedMsg.editable) {
        return startedMsg.edit({ embeds: [new EmbedBuilder().setColor(0x1E90FF).setTitle('Lobby Closed').setDescription(summary)] }).catch(() => null);
      }
      return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x1E90FF).setTitle('Lobby Closed').setDescription(summary)] }).catch(() => null);
    }
  } catch (e) {
    console.error('ampersand scrim commands failed', e);
  }
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
        const channelId = String(cfg.channel || '1469754683760316614');
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

