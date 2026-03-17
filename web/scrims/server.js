const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const port = Number(process.env.PORT || 4173);
const base = __dirname;
const projectRoot = path.resolve(__dirname, '..', '..');
const DROP_MAP_STATE_PATH = path.join(projectRoot, 'dropmap_web_marks.json');
const CREATE_HISTORY_PATH = path.join(projectRoot, 'scrims_create_history.json');
const DISCORD_CLIENT_ID = String(process.env.DISCORD_CLIENT_ID || '').trim();
const DISCORD_CLIENT_SECRET = String(process.env.DISCORD_CLIENT_SECRET || '').trim();
const DISCORD_REDIRECT_URI = String(process.env.DISCORD_REDIRECT_URI || `http://localhost:${port}/auth/discord/callback`).trim();
const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || '').trim();
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (FRONTEND_ORIGIN && !CORS_ORIGINS.includes(FRONTEND_ORIGIN)) CORS_ORIGINS.push(FRONTEND_ORIGIN);
const CROSS_SITE_COOKIES = String(process.env.CROSS_SITE_COOKIES || '').trim() === '1';
const webSessions = new Map();
const webOAuthStates = new Map();
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const OAUTH_STATE_MAX_AGE_MS = 1000 * 60 * 10;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function corsHeadersFor(req) {
  const origin = String(req && req.headers && req.headers.origin || '').trim();
  if (!origin) return null;
  if (!CORS_ORIGINS.length) return null;
  if (!CORS_ORIGINS.includes(origin) && !CORS_ORIGINS.includes('*')) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    Vary: 'Origin',
  };
}

function sendRedirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...extraHeaders });
  res.end();
}

function nowMs() {
  return Date.now();
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

function pruneExpiredEntries() {
  const now = nowMs();
  for (const [sid, session] of webSessions.entries()) {
    if (!session || Number(session.expiresAt || 0) <= now) webSessions.delete(sid);
  }
  for (const [state, meta] of webOAuthStates.entries()) {
    if (!meta || Number(meta.expiresAt || 0) <= now) webOAuthStates.delete(state);
  }
}

function isSecureRequest(req) {
  const proto = String(req && req.headers && req.headers['x-forwarded-proto'] || '').toLowerCase();
  if (proto) return proto === 'https';
  return !!(req && req.socket && req.socket.encrypted);
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(String(value || ''))}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push('Secure');
  if (Number.isFinite(options.maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  return parts.join('; ');
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function saveJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function appendCreateHistory(entry) {
  const maxEntries = 2000;
  const state = loadJson(CREATE_HISTORY_PATH, { entries: [] });
  const entries = Array.isArray(state && state.entries) ? state.entries : [];
  entries.push({ at: new Date().toISOString(), ...entry });
  if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
  return saveJson(CREATE_HISTORY_PATH, { entries });
}

function loadDropMapState() {
  const obj = loadJson(DROP_MAP_STATE_PATH, {});
  if (!obj || typeof obj !== 'object') return { lobbies: {} };
  if (!obj.lobbies || typeof obj.lobbies !== 'object') obj.lobbies = {};
  return obj;
}

function lobbyKey(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 1) return '1';
  return String(Math.floor(n));
}

function normalizePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Number(n.toFixed(3));
}

function sanitizeText(input, max = 80) {
  return String(input || '').trim().slice(0, max);
}

function parseCookies(req) {
  const out = {};
  const raw = String((req && req.headers && req.headers.cookie) || '');
  if (!raw) return out;
  for (const chunk of raw.split(';')) {
    const i = chunk.indexOf('=');
    if (i < 0) continue;
    const k = chunk.slice(0, i).trim();
    const v = chunk.slice(i + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function getSession(req) {
  pruneExpiredEntries();
  const cookies = parseCookies(req);
  const sid = String(cookies.sid || '');
  if (!sid) return null;
  const session = webSessions.get(sid) || null;
  if (!session) return null;
  if (Number(session.expiresAt || 0) <= nowMs()) {
    webSessions.delete(sid);
    return null;
  }
  return session;
}

function discordAvatarUrl(user) {
  if (!user || !user.id) return '';
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  let idx = 0;
  try { idx = Number(BigInt(String(user.id)) % 5n); } catch (e) {}
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function sanitizeBotToken(raw) {
  const token = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/\uFFFD/g, '')
    .replace(/[\r\n\t\0]/g, '')
    .replace(/^['\"]+|['\"]+$/g, '')
    .trim();
  return token;
}

function validateBotToken(token) {
  if (!token) throw new Error('Missing bot token. Add DISCORD_TOKEN env or token.txt.');
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code > 255) {
      throw new Error('Bot token contains invalid characters. Re-copy the token into token.txt or DISCORD_TOKEN using plain text.');
    }
  }
  return token;
}

function resolveToken() {
  const envToken = process.env.DISCORD_TOKEN || process.env.TOKEN || process.env.BOT_TOKEN || process.env.DISCORD_BOT_TOKEN;
  if (envToken && String(envToken).trim()) return validateBotToken(sanitizeBotToken(envToken));
  try {
    const tokenTxt = path.join(projectRoot, 'token.txt');
    if (fs.existsSync(tokenTxt)) {
      const raw = sanitizeBotToken(fs.readFileSync(tokenTxt, 'utf8'));
      if (raw) return validateBotToken(raw);
    }
  } catch (e) {}
  return '';
}

async function discordApi(method, apiPath, token, body) {
  const url = `https://discord.com/api/v10${apiPath}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!response.ok) {
    const msg = data && (data.message || data.raw) ? String(data.message || data.raw) : `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return data;
}

async function ensureRole(guildId, token, roleName) {
  const roles = await discordApi('GET', `/guilds/${guildId}/roles`, token);
  let role = Array.isArray(roles)
    ? roles.find(r => String(r.name || '').toLowerCase() === String(roleName).toLowerCase())
    : null;
  if (role) return role;
  role = await discordApi('POST', `/guilds/${guildId}/roles`, token, { name: roleName, mentionable: false, hoist: false });
  return role;
}

async function ensureChannel(guildId, token, allChannels, { name, type, parentId, permission_overwrites }) {
  const existing = Array.isArray(allChannels)
    ? allChannels.find(ch => String(ch.name || '').toLowerCase() === String(name).toLowerCase() && String(ch.parent_id || '') === String(parentId || ''))
    : null;
  if (existing) return existing;
  const created = await discordApi('POST', `/guilds/${guildId}/channels`, token, {
    name,
    type,
    parent_id: parentId || null,
    permission_overwrites: Array.isArray(permission_overwrites) ? permission_overwrites : [],
  });
  return created;
}

function parseNextTimestamp(hhmm) {
  const raw = String(hhmm || '').trim();
  const m = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  const now = new Date();
  const target = new Date(now);
  target.setSeconds(0, 0);
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (target.getTime() + 60_000 < now.getTime()) target.setDate(target.getDate() + 1);
  return Math.floor(target.getTime() / 1000);
}

function allowBits(...bits) {
  return String(bits.reduce((acc, bit) => acc | (1n << BigInt(bit)), 0n));
}

async function updateChannel(channelId, token, body) {
  return discordApi('PATCH', `/channels/${channelId}`, token, body);
}

async function createChannelMessage(channelId, token, body) {
  return discordApi('POST', `/channels/${channelId}/messages`, token, body);
}

async function getChannelMessages(channelId, token, limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const rows = await discordApi('GET', `/channels/${channelId}/messages?limit=${safeLimit}`, token);
  return Array.isArray(rows) ? rows : [];
}

async function ensureMessage(channelId, token, matcher, body) {
  const messages = await getChannelMessages(channelId, token, 20).catch(() => []);
  const existing = messages.find(matcher);
  if (existing) return existing;
  return createChannelMessage(channelId, token, body);
}

async function addMessageReaction(channelId, messageId, token, emoji) {
  const encoded = encodeURIComponent(String(emoji || ''));
  return discordApi('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, token);
}

async function reorderChannels(guildId, token, orderedChannels) {
  const payload = orderedChannels
    .map((ch, index) => (ch && ch.id ? { id: ch.id, position: index } : null))
    .filter(Boolean);
  if (!payload.length) return null;
  return discordApi('PATCH', `/guilds/${guildId}/channels`, token, payload);
}

async function handleCreateLobby(body) {
  const configPath = path.join(projectRoot, 'config.json');
  const cfg = loadJson(configPath, {});
  const firstGuildId = cfg && cfg.guilds && typeof cfg.guilds === 'object' ? Object.keys(cfg.guilds)[0] : '';
  const guildId = String(process.env.SCRIMS_GUILD_ID || cfg.scrimsGuildId || firstGuildId || '').trim();
  if (!guildId) throw new Error('Missing scrimsGuildId in config.json (or SCRIMS_GUILD_ID env).');

  const token = resolveToken();
  if (!token) throw new Error('Missing bot token. Add DISCORD_TOKEN env or token.txt.');

  const sessionNo = Number(body && body.session);
  const lobbyNo = Number(body && body.lobby);
  const registrationOpens = String(body && body.registrationOpens || '00:48').trim();
  const lobbyTemplate = String(body && body.lobbyTemplate || 'duo-default').trim().toLowerCase();
  if (!Number.isFinite(sessionNo) || sessionNo < 1) throw new Error('Invalid session number.');
  if (!Number.isFinite(lobbyNo) || lobbyNo < 1) throw new Error('Invalid lobby number.');

  const regBaseTs = parseNextTimestamp(registrationOpens);
  if (!regBaseTs) throw new Error('Invalid registration time. Use HH:MM.');
  const supportTs = regBaseTs + 60;
  const boosterTs = regBaseTs + 120;
  const verifiedTs = regBaseTs + 180;
  const fillsOpenTs = regBaseTs + 300;
  const unregCloseTs = regBaseTs + 300;
  const mode = lobbyTemplate.startsWith('trio') ? 'trio' : 'duo';
  const sessionLabel = mode === 'trio' ? 'Trio' : 'Duo';

  const lobbyRoleName = `Lobby${lobbyNo}`;
  const staffRoleName = `Lobby${lobbyNo} Staffs`;
  const categoryName = `${sessionLabel} Session ${sessionNo} Lobby ${lobbyNo}`;
  const prefix = `lobby-${lobbyNo}`;
  const channelNames = {
    registration: `${prefix}-registration`,
    dropmap: `${prefix}-dropmap`,
    code: `${prefix}-code`,
    chat: `${prefix}-chat`,
    unreg: `${prefix}-unreg`,
    fills: mode === 'trio' ? `${prefix}-trio-fills` : `${prefix}-fills`,
    staff: `${prefix}-staff`,
  };

  const [roles, channels] = await Promise.all([
    discordApi('GET', `/guilds/${guildId}/roles`, token),
    discordApi('GET', `/guilds/${guildId}/channels`, token),
  ]);

  const everyoneRole = Array.isArray(roles) ? roles.find(r => String(r.id) === String(guildId)) : null;
  if (!everyoneRole) throw new Error('Failed to resolve @everyone role.');

  const lobbyRole = await ensureRole(guildId, token, lobbyRoleName);
  const staffRole = await ensureRole(guildId, token, staffRoleName);

  let category = Array.isArray(channels)
    ? channels.find(ch => Number(ch.type) === 4 && String(ch.name || '').toLowerCase() === String(categoryName).toLowerCase())
    : null;

  if (!category) {
    category = await discordApi('POST', `/guilds/${guildId}/channels`, token, { name: categoryName, type: 4 });
  }

  const hiddenForUnregistered = [
    {
      id: everyoneRole.id,
      type: 0,
      deny: String((1n << 10n) | (1n << 11n)),
      allow: '0',
    },
    {
      id: lobbyRole.id,
      type: 0,
      allow: String((1n << 10n) | (1n << 16n) | (1n << 6n) | (1n << 11n)),
      deny: '0',
    },
    {
      id: staffRole.id,
      type: 0,
      allow: String((1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 6n) | (1n << 3n)),
      deny: '0',
    },
  ];

  const registrationOverwrites = [
    {
      id: everyoneRole.id,
      type: 0,
      allow: allowBits(10, 16),
      deny: allowBits(11),
    },
    {
      id: lobbyRole.id,
      type: 0,
      allow: allowBits(10, 16),
      deny: allowBits(11),
    },
    {
      id: staffRole.id,
      type: 0,
      allow: allowBits(10, 11, 16),
      deny: '0',
    },
  ];

  const chatOverwrites = [
    {
      id: everyoneRole.id,
      type: 0,
      deny: allowBits(10),
      allow: '0',
    },
    {
      id: lobbyRole.id,
      type: 0,
      allow: allowBits(10, 11, 16),
      deny: '0',
    },
    {
      id: staffRole.id,
      type: 0,
      allow: allowBits(10, 11, 16),
      deny: '0',
    },
  ];

  const staffOverwrites = [
    {
      id: everyoneRole.id,
      type: 0,
      deny: allowBits(10),
      allow: '0',
    },
    {
      id: lobbyRole.id,
      type: 0,
      deny: allowBits(10),
      allow: '0',
    },
    {
      id: staffRole.id,
      type: 0,
      allow: allowBits(10, 11, 16),
      deny: '0',
    },
  ];

  const created = [];
  const refreshedChannels = await discordApi('GET', `/guilds/${guildId}/channels`, token);
  for (const channelName of Object.values(channelNames)) {
    const ch = await ensureChannel(guildId, token, refreshedChannels, {
      name: channelName,
      type: 0,
      parentId: category.id,
      permission_overwrites: hiddenForUnregistered,
    });
    created.push(ch.name);
  }

  const latestChannels = await discordApi('GET', `/guilds/${guildId}/channels`, token);
  const byName = {};
  for (const [key, name] of Object.entries(channelNames)) {
    byName[key] = latestChannels.find(ch => Number(ch.type) === 0 && String(ch.name || '') === name && String(ch.parent_id || '') === String(category.id)) || null;
  }

  if (byName.registration) await updateChannel(byName.registration.id, token, { permission_overwrites: registrationOverwrites }).catch(() => null);
  if (byName.fills) await updateChannel(byName.fills.id, token, { permission_overwrites: registrationOverwrites }).catch(() => null);
  if (byName.unreg) await updateChannel(byName.unreg.id, token, { permission_overwrites: registrationOverwrites }).catch(() => null);
  if (byName.chat) await updateChannel(byName.chat.id, token, { permission_overwrites: chatOverwrites }).catch(() => null);
  if (byName.staff) await updateChannel(byName.staff.id, token, { permission_overwrites: staffOverwrites }).catch(() => null);
  for (const key of ['dropmap', 'code']) {
    if (byName[key]) await updateChannel(byName[key].id, token, { permission_overwrites: hiddenForUnregistered }).catch(() => null);
  }

  await reorderChannels(guildId, token, [
    byName.registration,
    byName.dropmap,
    byName.code,
    byName.chat,
    byName.unreg,
    byName.fills,
    byName.staff,
  ]).catch(() => null);

  if (byName.registration) {
    await ensureMessage(byName.registration.id, token, m => {
      const embeds = Array.isArray(m && m.embeds) ? m.embeds : [];
      return embeds.some(e => String(e && e.title || '') === 'Registered Players:');
    }, {
      embeds: [{
        color: 0x1E90FF,
        title: 'Registered Players:',
        description: `@Supporter can register at <t:${supportTs}:t> (<t:${supportTs}:R>)\n@Server Booster @CC Priority can register at <t:${boosterTs}:t> (<t:${boosterTs}:R>)\n@Verified can register at <t:${verifiedTs}:t> (<t:${verifiedTs}:R>)`,
      }],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 3,
          custom_id: `lobby_register:${lobbyNo}`,
          label: 'Register',
        }],
      }],
    }).catch(() => null);
  }

  if (byName.fills) {
    const fillsMsg = await ensureMessage(byName.fills.id, token, m => {
      const embeds = Array.isArray(m && m.embeds) ? m.embeds : [];
      return embeds.some(e => String(e && e.title || '').startsWith('Fills will open at'));
    }, {
      embeds: [{
        color: 0x1E90FF,
        title: `Fills will open at <t:${fillsOpenTs}:t>`,
        description: 'Please do not DM or ping staff; they will unlock this channel and request new teams when needed.\n\nReact below to show interest for a 2nd lobby.',
      }],
    }).catch(() => null);
    if (fillsMsg && fillsMsg.id) await addMessageReaction(byName.fills.id, fillsMsg.id, token, '✅').catch(() => null);
  }

  if (byName.unreg) {
    await ensureMessage(byName.unreg.id, token, m => {
      const embeds = Array.isArray(m && m.embeds) ? m.embeds : [];
      return embeds.some(e => String(e && e.title || '').startsWith('Getting off closes at'));
    }, {
      embeds: [{
        color: 0x1E90FF,
        title: `Getting off closes at <t:${unregCloseTs}:t>`,
        description: 'Late unregistrations will result in a punishment!\nUse the button below to unregister.',
      }],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 4,
          custom_id: `lobby_unregister:${lobbyNo}`,
          label: 'Unregister',
        }],
      }],
    }).catch(() => null);
  }

  if (byName.chat) {
    await ensureMessage(byName.chat.id, token, m => {
      const embeds = Array.isArray(m && m.embeds) ? m.embeds : [];
      return embeds.some(e => String(e && e.title || '') === 'Please use English in this chat');
    }, {
      embeds: [{
        color: 0x1E90FF,
        title: 'Please use English in this chat',
        description: 'We want everyone to feel comfortable here. Thank you for understanding!',
      }],
    }).catch(() => null);
  }

  return {
    ok: true,
    categoryName,
    roles: [lobbyRoleName, staffRoleName],
    channels: created,
    setup: {
      registration: byName.registration ? byName.registration.name : null,
      fills: byName.fills ? byName.fills.name : null,
      unreg: byName.unreg ? byName.unreg.name : null,
    },
  };
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(String(req.url || '/'), 'http://localhost');
  const reqPath = urlObj.pathname;
  pruneExpiredEntries();
  const corsHeaders = corsHeadersFor(req);
  if (corsHeaders) {
    for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && reqPath === '/auth/discord') {
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
      return sendJson(res, 500, { ok: false, error: 'Missing DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET in env.' });
    }
    const oauthState = randomToken(18);
    webOAuthStates.set(oauthState, { expiresAt: nowMs() + OAUTH_STATE_MAX_AGE_MS });
    const q = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      response_type: 'code',
      redirect_uri: DISCORD_REDIRECT_URI,
      scope: 'identify',
      state: oauthState,
      prompt: 'none',
    });
    const cookie = serializeCookie('oauth_state', oauthState, {
      maxAge: Math.floor(OAUTH_STATE_MAX_AGE_MS / 1000),
      sameSite: CROSS_SITE_COOKIES ? 'None' : 'Lax',
      secure: CROSS_SITE_COOKIES ? true : isSecureRequest(req),
    });
    return sendRedirect(res, `https://discord.com/oauth2/authorize?${q.toString()}`, { 'Set-Cookie': cookie });
  }

  if (req.method === 'GET' && reqPath === '/auth/discord/callback') {
    const code = String(urlObj.searchParams.get('code') || '').trim();
    const state = String(urlObj.searchParams.get('state') || '').trim();
    const cookies = parseCookies(req);
    const cookieState = String(cookies.oauth_state || '').trim();
    const stateMeta = state ? webOAuthStates.get(state) : null;
    const clearStateCookie = serializeCookie('oauth_state', '', {
      maxAge: 0,
      sameSite: CROSS_SITE_COOKIES ? 'None' : 'Lax',
      secure: CROSS_SITE_COOKIES ? true : isSecureRequest(req),
    });
    if (!code || !state || !cookieState || state !== cookieState || !stateMeta || Number(stateMeta.expiresAt || 0) <= nowMs()) {
      if (state) webOAuthStates.delete(state);
      return sendRedirect(res, '/dropmap.html?auth=failed', { 'Set-Cookie': clearStateCookie });
    }
    webOAuthStates.delete(state);
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) return sendRedirect(res, '/dropmap.html?auth=failed');

    (async () => {
      try {
        const tokenBody = new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: DISCORD_REDIRECT_URI,
        });

        const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody.toString(),
        });
        const tokenJson = await tokenRes.json().catch(() => ({}));
        const accessToken = String(tokenJson && tokenJson.access_token ? tokenJson.access_token : '');
        if (!tokenRes.ok || !accessToken) return sendRedirect(res, '/dropmap.html?auth=failed');

        const meRes = await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const me = await meRes.json().catch(() => ({}));
        if (!meRes.ok || !me || !me.id) return sendRedirect(res, '/dropmap.html?auth=failed');

        const sid = randomToken(24);
        webSessions.set(sid, {
          id: String(me.id),
          username: String(me.global_name || me.username || 'User'),
          avatarUrl: discordAvatarUrl(me),
          createdAt: nowMs(),
          expiresAt: nowMs() + SESSION_MAX_AGE_MS,
        });
        const setCookies = [
          serializeCookie('sid', sid, {
            maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
            sameSite: CROSS_SITE_COOKIES ? 'None' : 'Lax',
            secure: CROSS_SITE_COOKIES ? true : isSecureRequest(req),
          }),
          clearStateCookie,
        ];
        return sendRedirect(res, '/dropmap.html?auth=ok', {
          'Set-Cookie': setCookies,
        });
      } catch (e) {
        return sendRedirect(res, '/dropmap.html?auth=failed', { 'Set-Cookie': clearStateCookie });
      }
    })();
    return;
  }

  if (req.method === 'GET' && reqPath === '/auth/logout') {
    const cookies = parseCookies(req);
    const sid = String(cookies.sid || '');
    if (sid) webSessions.delete(sid);
    const clearCookies = [
      serializeCookie('sid', '', { maxAge: 0, sameSite: CROSS_SITE_COOKIES ? 'None' : 'Lax', secure: CROSS_SITE_COOKIES ? true : isSecureRequest(req) }),
      serializeCookie('oauth_state', '', { maxAge: 0, sameSite: CROSS_SITE_COOKIES ? 'None' : 'Lax', secure: CROSS_SITE_COOKIES ? true : isSecureRequest(req) }),
    ];
    return sendRedirect(res, '/dropmap.html', {
      'Set-Cookie': clearCookies,
    });
  }

  if (req.method === 'GET' && reqPath === '/api/me') {
    const session = getSession(req);
    return sendJson(res, 200, { ok: true, user: session ? { id: session.id, username: session.username, avatarUrl: session.avatarUrl } : null });
  }

  if (req.method === 'GET' && reqPath === '/api/dropmap/state') {
    try {
      const lobby = lobbyKey(urlObj.searchParams.get('lobby') || '1');
      const state = loadDropMapState();
      if (!state.lobbies[lobby] || !Array.isArray(state.lobbies[lobby].marks)) {
        state.lobbies[lobby] = { marks: [], updatedAt: Date.now() };
      }
      return sendJson(res, 200, { ok: true, lobby, marks: state.lobbies[lobby].marks });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'Failed to load dropmap state.' });
    }
  }

  if (req.method === 'POST' && reqPath === '/api/dropmap/mark') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { ok: false, error: 'Please connect Discord first.' });

        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : {};
        const lobby = lobbyKey(body && body.lobby);
        const label = sanitizeText(body && body.label, 80);
        const x = normalizePercent(body && body.x);
        const y = normalizePercent(body && body.y);
        if (!label) return sendJson(res, 400, { ok: false, error: 'Spot label is required.' });
        if (x === null || y === null) return sendJson(res, 400, { ok: false, error: 'Invalid map coordinates.' });

        const state = loadDropMapState();
        if (!state.lobbies[lobby] || !Array.isArray(state.lobbies[lobby].marks)) {
          state.lobbies[lobby] = { marks: [], updatedAt: Date.now() };
        }

        const marks = state.lobbies[lobby].marks;
        const existingIndex = marks.findIndex(m => String(m.userId || '') === String(session.id));
        const mark = {
          id: existingIndex >= 0 ? marks[existingIndex].id : `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          userId: String(session.id),
          player: String(session.username),
          avatarUrl: String(session.avatarUrl || ''),
          label,
          x,
          y,
          updatedAt: Date.now(),
        };

        if (existingIndex >= 0) marks[existingIndex] = mark;
        else marks.push(mark);

        state.lobbies[lobby].updatedAt = Date.now();
        if (!saveJson(DROP_MAP_STATE_PATH, state)) {
          return sendJson(res, 500, { ok: false, error: 'Failed to persist dropmap state.' });
        }
        return sendJson(res, 200, { ok: true, lobby, marks: marks });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e && e.message ? e.message : 'Invalid request.') });
      }
    });
    return;
  }

  if (req.method === 'POST' && reqPath === '/api/dropmap/delete') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const session = getSession(req);
        if (!session) return sendJson(res, 401, { ok: false, error: 'Please connect Discord first.' });

        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : {};
        const lobby = lobbyKey(body && body.lobby);
        const id = sanitizeText(body && body.id, 120);
        if (!id) return sendJson(res, 400, { ok: false, error: 'Mark id is required.' });

        const state = loadDropMapState();
        if (!state.lobbies[lobby] || !Array.isArray(state.lobbies[lobby].marks)) {
          state.lobbies[lobby] = { marks: [], updatedAt: Date.now() };
        }

        state.lobbies[lobby].marks = state.lobbies[lobby].marks.filter(m => !(String(m.id) === id && String(m.userId || '') === String(session.id)));
        state.lobbies[lobby].updatedAt = Date.now();
        if (!saveJson(DROP_MAP_STATE_PATH, state)) {
          return sendJson(res, 500, { ok: false, error: 'Failed to persist dropmap state.' });
        }
        return sendJson(res, 200, { ok: true, lobby, marks: state.lobbies[lobby].marks });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e && e.message ? e.message : 'Invalid request.') });
      }
    });
    return;
  }

  if (req.method === 'POST' && reqPath === '/api/dropmap/clear') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : {};
        const lobby = lobbyKey(body && body.lobby);
        const state = loadDropMapState();
        state.lobbies[lobby] = { marks: [], updatedAt: Date.now() };
        if (!saveJson(DROP_MAP_STATE_PATH, state)) {
          return sendJson(res, 500, { ok: false, error: 'Failed to persist dropmap state.' });
        }
        return sendJson(res, 200, { ok: true, lobby, marks: [] });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e && e.message ? e.message : 'Invalid request.') });
      }
    });
    return;
  }

  if (req.method === 'POST' && reqPath === '/api/create-lobby') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const session = getSession(req);
        if (!session) {
          return sendJson(res, 401, { ok: false, error: 'Please connect your Discord account first.' });
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : {};
        const out = await handleCreateLobby(body);
        appendCreateHistory({
          ok: true,
          userId: session.id,
          username: session.username,
          payload: body,
          result: out,
        });
        return sendJson(res, 200, out);
      } catch (e) {
        appendCreateHistory({
          ok: false,
          reason: String(e && e.message ? e.message : e),
        });
        return sendJson(res, 400, { ok: false, error: String(e && e.message ? e.message : e) });
      }
    });
    return;
  }

  if (req.method === 'GET' && reqPath === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  const target = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.normalize(path.join(base, target));
  if (!filePath.startsWith(base)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, () => {
  console.log(`Scrims dashboard running on http://localhost:${port}`);
});
