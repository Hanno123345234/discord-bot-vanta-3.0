const fs = require('fs');
const path = require('path');

function loadConfig() {
  try {
    const base = path.resolve(__dirname, '..');
    const cfgPath = path.join(base, 'config.json');
    if (fs.existsSync(cfgPath)) return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {}
  return {};
}

function isTextLike(ch) {
  return ch && (typeof ch.isTextBased === 'function' ? ch.isTextBased() : (ch.isText && ch.isText()));
}

async function sendLog(guild, payload) {
  try {
    if (!guild) return;
    const cfg = loadConfig();

    // Determine destination channel by category: moderation logs go to modLogChannelId
    const category = payload && (payload.category || payload.type) ? String(payload.category || payload.type).toLowerCase() : null;
    let ch = null;

    if (category === 'moderation' || category === 'mod') {
      // Try global channel by ID first (across all guilds)
      if (cfg.modLogChannelId && guild && guild.client) ch = guild.client.channels.cache.get(String(cfg.modLogChannelId));
      // If not cached, try to fetch
      if (!ch && cfg.modLogChannelId && guild && guild.client) {
        try { ch = await guild.client.channels.fetch(String(cfg.modLogChannelId)).catch(()=>null); } catch(e) { ch = null; }
      }
      // Fallback to a channel in this guild
      if (!ch && guild) ch = guild.channels.cache.get(String(cfg.modLogChannelId)) || guild.channels.cache.find(c => ['mod-logs','moderation-logs','moderation','modlogs'].includes(c.name));
    }

    // Fallback to general log channel (global first)
    if (!ch) {
      if (cfg.logChannelId && guild && guild.client) ch = guild.client.channels.cache.get(String(cfg.logChannelId));
      if (!ch && cfg.logChannelId && guild && guild.client) {
        try { ch = await guild.client.channels.fetch(String(cfg.logChannelId)).catch(()=>null); } catch(e) { ch = null; }
      }
      if (!ch && guild) ch = guild.channels.cache.get(String(cfg.logChannelId)) || guild.channels.cache.find(c => ['discord-logs','logs','audit-logs'].includes(c.name));
    }

    if (!ch || !isTextLike(ch)) return;

    // If payload is already a proper send object, send it; otherwise wrap embeds
    if (payload && typeof payload === 'object' && (payload.embeds || payload.content || payload.files)) return await ch.send(payload).catch(()=>{});
    if (payload) return await ch.send({ embeds: [payload] }).catch(()=>{});
    return;
  } catch (e) {
    console.error('utils.logger sendLog failed', e);
  }
}

module.exports = { sendLog };
