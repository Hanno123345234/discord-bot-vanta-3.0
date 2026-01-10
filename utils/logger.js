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

    const category = payload && (payload.category || payload.type) ? String(payload.category || payload.type).toLowerCase() : null;
    let ch = null;

    const getById = async (id) => {
      if (!id) return null;
      const sid = String(id);
      let target = guild.client ? guild.client.channels.cache.get(sid) : null;
      if (!target && guild.client) {
        try { target = await guild.client.channels.fetch(sid).catch(() => null); } catch (e) { target = null; }
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

    if (!ch && (category === 'moderation' || category === 'mod')) {
      ch = await getById(cfg.moderationLogChannelId || cfg.modLogChannelId);
      if (!ch) ch = fallbackByName(['mod-logs','moderation-logs','moderation','modlogs']);
    }

    if (!ch) {
      ch = await getById(cfg.logChannelId);
      if (!ch) ch = fallbackByName(['discord-logs','logs','audit-logs']);
    }

    if (!ch || !isTextLike(ch)) return;

    if (payload && typeof payload === 'object' && (payload.embeds || payload.content || payload.files)) return await ch.send(payload).catch(()=>{});
    if (payload) return await ch.send({ embeds: [payload] }).catch(()=>{});
    return;
  } catch (e) {
    console.error('utils.logger sendLog failed', e);
  }
}

module.exports = { sendLog };
