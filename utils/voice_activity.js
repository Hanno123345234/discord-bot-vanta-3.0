const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const DATA_DIR = path.resolve(__dirname, '..');
const VOICE_ACTIVITY_PATH = path.join(DATA_DIR, 'voice_activity.json');

function loadJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('voice_activity: failed to load', p, e);
    return fallback;
  }
}

function saveJson(p, obj) {
  try {
    const json = JSON.stringify(obj, null, 2);
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    try {
      fs.renameSync(tmp, p);
    } catch (e) {
      try { fs.writeFileSync(p, json, 'utf8'); } catch (e2) { throw e2; }
      try { fs.unlinkSync(tmp); } catch (e3) {}
    }
    return true;
  } catch (e) {
    console.error('voice_activity: failed to save', p, e);
    return false;
  }
}

function utcDayKey(ts) {
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function formatDurationShort(ms) {
  ms = Math.max(0, Number(ms) || 0);
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m}m`;
  if (m <= 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function buildQuickChartUrl(labels, values, title) {
  try {
    const safeLabels = (labels || []).map(s => String(s).replace(/[@<>]/g, '').slice(0, 32));
    const safeValues = (values || []).map(v => Math.max(0, Math.round(Number(v) || 0)));
    const cfg = {
      type: 'bar',
      data: {
        labels: safeLabels,
        datasets: [
          {
            label: String(title || 'Voice minutes'),
            data: safeValues,
            backgroundColor: 'rgba(135, 206, 250, 0.85)',
            borderColor: 'rgba(135, 206, 250, 1)',
            borderWidth: 1,
          },
        ],
      },
      options: {
        legend: { display: false },
        plugins: {
          datalabels: { display: false },
        },
        scales: {
          xAxes: [{ ticks: { fontColor: '#ffffff' }, gridLines: { color: 'rgba(255,255,255,0.08)' } }],
          yAxes: [{ ticks: { fontColor: '#ffffff', beginAtZero: true }, gridLines: { color: 'rgba(255,255,255,0.08)' } }],
        },
      },
    };
    const encoded = encodeURIComponent(JSON.stringify(cfg));
    return `https://quickchart.io/chart?backgroundColor=transparent&c=${encoded}`;
  } catch (e) {
    return null;
  }
}

function parseRangeToDays(range) {
  const r = String(range || '').trim().toLowerCase();
  if (r === '1d' || r === '24h' || r === 'day') return 1;
  if (r === '30d' || r === 'month') return 30;
  return 7;
}

function normalizeRange(range) {
  const r = String(range || '').trim().toLowerCase();
  if (r === '1d' || r === '24h' || r === 'day') return '1d';
  if (r === '30d' || r === 'month') return '30d';
  return '7d';
}

function buildVoiceActivityComponents(currentRange) {
  const r = normalizeRange(currentRange);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('va_range:1d')
      .setLabel('1d')
      .setStyle(r === '1d' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(r === '1d'),
    new ButtonBuilder()
      .setCustomId('va_range:7d')
      .setLabel('7d')
      .setStyle(r === '7d' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(r === '7d'),
    new ButtonBuilder()
      .setCustomId('va_range:30d')
      .setLabel('30d')
      .setStyle(r === '30d' ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(r === '30d'),
    new ButtonBuilder()
      .setCustomId('va_refresh')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Success)
  );
  return [row];
}

function dayKeysForLastNDays(days, nowTs) {
  const keys = [];
  const now = new Date(nowTs);
  // midnight UTC
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = 0; i < days; i += 1) {
    const ts = midnight - (i * 86400000);
    keys.push(new Date(ts).toISOString().slice(0, 10));
  }
  return keys;
}

let store = loadJson(VOICE_ACTIVITY_PATH, { version: 1, guilds: {} });
if (!store || typeof store !== 'object') store = { version: 1, guilds: {} };
if (!store.guilds || typeof store.guilds !== 'object') store.guilds = {};

// Active voice sessions in this process.
// key: `${guildId}:${userId}` -> { channelId, joinedAt }
const activeSessions = new Map();

let saveTimer = null;
let dirty = false;

function ensureGuild(guildId) {
  const gid = String(guildId);
  if (!store.guilds[gid] || typeof store.guilds[gid] !== 'object') {
    store.guilds[gid] = { users: {}, channels: {}, lastPruneAt: 0 };
  }
  const g = store.guilds[gid];
  if (!g.users || typeof g.users !== 'object') g.users = {};
  if (!g.channels || typeof g.channels !== 'object') g.channels = {};
  if (typeof g.lastPruneAt !== 'number') g.lastPruneAt = 0;
  return g;
}

function pruneOldBucketsForMap(mapObj, cutoffDayKey) {
  try {
    if (!mapObj || typeof mapObj !== 'object') return;
    for (const id of Object.keys(mapObj)) {
      const entry = mapObj[id];
      if (!entry || typeof entry !== 'object') { delete mapObj[id]; continue; }
      const d = entry.d;
      if (!d || typeof d !== 'object') { entry.d = {}; continue; }
      for (const day of Object.keys(d)) {
        if (day < cutoffDayKey) delete d[day];
      }
      if (!Object.keys(entry.d).length) delete mapObj[id];
    }
  } catch (e) {}
}

function pruneGuild(guildId, keepDays = 45) {
  try {
    const g = ensureGuild(guildId);
    const now = Date.now();
    if (now - (g.lastPruneAt || 0) < 6 * 60 * 60 * 1000) return; // every 6h

    const cutoffTs = now - (keepDays * 86400000);
    const cutoffKey = utcDayKey(cutoffTs);

    pruneOldBucketsForMap(g.users, cutoffKey);
    pruneOldBucketsForMap(g.channels, cutoffKey);

    g.lastPruneAt = now;
  } catch (e) {}
}

function markDirty() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try { saveJson(VOICE_ACTIVITY_PATH, store); } catch (e) {}
  }, 5000);
}

function addVoiceMs(guildId, userId, channelId, ms, ts) {
  try {
    ms = Math.max(0, Number(ms) || 0);
    if (!ms) return;
    const gid = String(guildId);
    const uid = String(userId);
    const cid = String(channelId);

    const g = ensureGuild(gid);
    const dayKey = utcDayKey(ts);

    if (!g.users[uid]) g.users[uid] = { d: {} };
    if (!g.users[uid].d || typeof g.users[uid].d !== 'object') g.users[uid].d = {};
    g.users[uid].d[dayKey] = (Number(g.users[uid].d[dayKey]) || 0) + ms;

    if (!g.channels[cid]) g.channels[cid] = { d: {} };
    if (!g.channels[cid].d || typeof g.channels[cid].d !== 'object') g.channels[cid].d = {};
    g.channels[cid].d[dayKey] = (Number(g.channels[cid].d[dayKey]) || 0) + ms;

    pruneGuild(gid);
    markDirty();
  } catch (e) {}
}

function handleVoiceStateUpdate(oldState, newState) {
  try {
    const guild = (newState && newState.guild) || (oldState && oldState.guild);
    const guildId = guild ? String(guild.id) : null;
    if (!guildId) return;

    const member = (newState && newState.member) || (oldState && oldState.member) || null;
    if (!member || !member.user || member.user.bot) return;

    const userId = String(member.id);
    const oldChannelId = oldState ? (oldState.channelId ? String(oldState.channelId) : null) : null;
    const newChannelId = newState ? (newState.channelId ? String(newState.channelId) : null) : null;

    // Only track actual channel moves/joins/leaves.
    if (oldChannelId === newChannelId) return;

    const key = `${guildId}:${userId}`;
    const now = Date.now();

    // Close old session if present.
    if (oldChannelId) {
      const active = activeSessions.get(key);
      const joinedAt = active && active.joinedAt ? Number(active.joinedAt) : now;
      const prevChannelId = active && active.channelId ? String(active.channelId) : oldChannelId;
      const delta = Math.max(0, now - joinedAt);
      if (delta > 0) addVoiceMs(guildId, userId, prevChannelId, delta, now);
      activeSessions.delete(key);
    }

    // Start new session.
    if (newChannelId) {
      activeSessions.set(key, { channelId: newChannelId, joinedAt: now });
    }
  } catch (e) {
    console.error('voice_activity: handleVoiceStateUpdate failed', e);
  }
}

function seedFromClient(client) {
  try {
    const now = Date.now();
    for (const [, guild] of (client && client.guilds && client.guilds.cache ? client.guilds.cache : [])) {
      try {
        if (!guild || !guild.voiceStates || !guild.voiceStates.cache) continue;
        for (const [, vs] of guild.voiceStates.cache) {
          try {
            if (!vs || !vs.channelId) continue;
            const m = vs.member;
            if (!m || !m.user || m.user.bot) continue;
            const key = `${guild.id}:${m.id}`;
            if (!activeSessions.has(key)) activeSessions.set(key, { channelId: String(vs.channelId), joinedAt: now });
          } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error('voice_activity: seedFromClient failed', e);
  }
}

function computeSums(guildId, days, nowTs) {
  const gid = String(guildId);
  const now = nowTs || Date.now();
  const keys = dayKeysForLastNDays(days, now);

  const users = new Map();
  const channels = new Map();

  const g = store.guilds[gid];
  if (g && g.users) {
    for (const uid of Object.keys(g.users)) {
      const entry = g.users[uid];
      const d = entry && entry.d ? entry.d : {};
      let sum = 0;
      for (const k of keys) sum += Number(d[k] || 0);
      if (sum > 0) users.set(uid, sum);
    }
  }

  if (g && g.channels) {
    for (const cid of Object.keys(g.channels)) {
      const entry = g.channels[cid];
      const d = entry && entry.d ? entry.d : {};
      let sum = 0;
      for (const k of keys) sum += Number(d[k] || 0);
      if (sum > 0) channels.set(cid, sum);
    }
  }

  // Add currently active sessions (not yet persisted)
  for (const [key, sess] of activeSessions.entries()) {
    if (!key.startsWith(gid + ':')) continue;
    const uid = key.slice((gid + ':').length);
    const joinedAt = Number(sess && sess.joinedAt ? sess.joinedAt : now);
    const cid = sess && sess.channelId ? String(sess.channelId) : null;
    if (!cid) continue;
    const delta = Math.max(0, now - joinedAt);
    if (!delta) continue;
    users.set(uid, (users.get(uid) || 0) + delta);
    channels.set(cid, (channels.get(cid) || 0) + delta);
  }

  let total = 0;
  for (const v of users.values()) total += v;

  return { users, channels, total };
}

async function buildVoiceActivityEmbed(guild, options = {}) {
  const range = options.range || options.days || '7d';
  const normalizedRange = typeof range === 'string' ? normalizeRange(range) : range;
  const days = typeof normalizedRange === 'number' ? normalizedRange : parseRangeToDays(normalizedRange);
  const viewerId = options.viewerId ? String(options.viewerId) : null;
  const now = Date.now();
  const endUnix = Math.floor(now / 1000);
  const startUnix = Math.floor((now - (days * 86400000)) / 1000);

  const { users, channels, total } = computeSums(guild.id, days, now);

  const embed = new EmbedBuilder()
    .setTitle('Voice Activity')
    .setColor(0x87CEFA)
    .setTimestamp(new Date(now));

  embed.setDescription(
    `Range: <t:${startUnix}:f> → <t:${endUnix}:f> (<t:${startUnix}:R>)\n` +
    `Total voice time: **${formatDurationShort(total)}**`
  );

  const topUsers = Array.from(users.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topChannels = Array.from(channels.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);

  if (viewerId) {
    const viewerMs = users.get(viewerId) || 0;
    embed.addFields({ name: 'Your Voice Time', value: `**${formatDurationShort(viewerMs)}**`, inline: false });
  }

  if (!topUsers.length && !topChannels.length) {
    embed.addFields({ name: 'No data yet', value: 'No voice activity tracked yet. Join a voice channel and try again in a few minutes.', inline: false });
    return embed;
  }

  const userLines = [];
  for (let i = 0; i < topUsers.length; i += 1) {
    const [uid, ms] = topUsers[i];
    userLines.push(`${i + 1}. <@${uid}> — **${formatDurationShort(ms)}**`);
  }

  // Add a chart image (minutes) like Statbot-style panels
  try {
    const labels = [];
    for (const [uid] of topUsers) {
      let label = uid;
      try {
        const cached = guild && guild.members && guild.members.cache ? guild.members.cache.get(uid) : null;
        const member = cached || (guild && guild.members && typeof guild.members.fetch === 'function' ? await guild.members.fetch(uid).catch(() => null) : null);
        if (member && member.displayName) label = String(member.displayName);
        else if (member && member.user && member.user.username) label = String(member.user.username);
      } catch (e) {}
      labels.push(label);
    }
    const values = topUsers.map(([, ms]) => Math.max(0, Math.round(ms / 60000)));
    const url = buildQuickChartUrl(labels, values, `Voice minutes (last ${days}d)`);
    if (url) embed.setImage(url);
  } catch (e) {}

  const channelLines = [];
  for (let i = 0; i < topChannels.length; i += 1) {
    const [cid, ms] = topChannels[i];
    let chName = null;
    try {
      const ch = guild.channels && guild.channels.cache ? guild.channels.cache.get(cid) : null;
      if (ch && ch.name) chName = `#${ch.name}`;
    } catch (e) {}
    channelLines.push(`${i + 1}. ${chName || `<#${cid}>`} — **${formatDurationShort(ms)}**`);
  }

  embed.addFields(
    { name: 'Top Voice Members', value: userLines.join('\n').slice(0, 1024) || '—', inline: true },
    { name: 'Top Voice Channels', value: channelLines.join('\n').slice(0, 1024) || '—', inline: true },
  );

  return embed;
}

module.exports = {
  VOICE_ACTIVITY_PATH,
  handleVoiceStateUpdate,
  seedFromClient,
  buildVoiceActivityEmbed,
  buildVoiceActivityComponents,
  normalizeRange,
  parseRangeToDays,
};
