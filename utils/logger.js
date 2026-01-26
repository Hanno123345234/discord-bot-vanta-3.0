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

function mergeGuildConfig(cfg, guildId) {
  try {
    if (!cfg || !guildId) return cfg || {};
    const gid = String(guildId);
    const overrides = cfg.guilds && cfg.guilds[gid] && typeof cfg.guilds[gid] === 'object' ? cfg.guilds[gid] : null;
    return overrides ? Object.assign({}, cfg, overrides) : cfg;
  } catch (e) {
    return cfg || {};
  }
}

function isTextLike(ch) {
  return ch && (typeof ch.isTextBased === 'function' ? ch.isTextBased() : (ch.isText && ch.isText()));
}

async function sendLog(guild, payload) {
  try {
    if (!guild) return;
    const cfg = mergeGuildConfig(loadConfig(), guild.id);

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

    // send to the guild's chosen channel
    try {
      if (payload && typeof payload === 'object' && (payload.embeds || payload.content || payload.files)) await ch.send(payload).catch(()=>{});
      else if (payload) await ch.send({ embeds: [payload] }).catch(()=>{});
    } catch (e) { /* ignore send errors */ }

    // Forward logs from specific guilds to a central aggregator channel
    try {
      const AGGREGATE_CHANNEL_ID = '1458941365902639271';
      const FORWARD_GUILD_IDS = new Set([
        '1339662600903983154',
        '1317453317177212950',
        '1459330497938325676',
        '1459345285317791917'
      ]);
      if (guild && FORWARD_GUILD_IDS.has(String(guild.id))) {
        const client = guild.client || (guild.members && guild.members.client) || null;
        if (client) {
          const aggCh = await client.channels.fetch(AGGREGATE_CHANNEL_ID).catch(()=>null);
          if (aggCh && isTextLike(aggCh)) {
            // Build a compact embed describing origin and payload
            const origin = `${guild.name || 'Unknown Guild'} (${guild.id})`;
            const infoEmbed = {
              title: `Log from ${origin}`,
              color: 0x87CEFA,
              timestamp: new Date(),
            };
            // include category if present
            if (payload && payload.category) infoEmbed.fields = [{ name: 'Category', value: String(payload.category), inline: true }];
            // Try to forward embeds/content succinctly
            if (payload && typeof payload === 'object') {
              // If there are embeds, forward the first embed with an origin footer
              if (payload.embeds && payload.embeds.length) {
                const copy = Object.assign({}, payload.embeds[0]);
                if (!copy.footer) copy.footer = { text: `From: ${origin}` };
                await aggCh.send({ embeds: [copy] }).catch(()=>{});
              } else if (payload.content) {
                await aggCh.send(`[${origin}] ${payload.content}`).catch(()=>{});
              } else {
                await aggCh.send({ embeds: [infoEmbed, { description: payload && typeof payload === 'string' ? payload : (payload && payload.toString ? payload.toString() : 'No content') } ]}).catch(()=>{});
              }
            } else if (payload) {
              await aggCh.send(`[${origin}] ${String(payload)}`).catch(()=>{});
            }
          }
        }
      }
    } catch (e) { console.error('utils.logger forward failed', e); }

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
        // payload can be embed object or plain string
        try {
          if (typeof p === 'string') {
            const s = p.toLowerCase();
            return s.includes('error') || s.includes('failed') || s.includes('exception');
          }
          if (p.embeds && p.embeds.length) {
            const t = String(p.embeds[0].title || '').toLowerCase();
            if (t.includes('error') || t.includes('failed') || t.includes('exception')) return true;
            // check fields for Error
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
        const client = guild.client || (guild.members && guild.members.client) || null;
        if (client) {
          const errCh = await client.channels.fetch(ERROR_AGG_CHANNEL_ID).catch(()=>null);
          if (errCh && isTextLike(errCh)) {
            // Forward embeds directly when present, else send content prefixed with origin
            const origin = `${guild.name || 'Unknown Guild'} (${guild.id})`;
            if (payload && typeof payload === 'object' && payload.embeds && payload.embeds.length) {
              // annotate footer
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
      }
    } catch (e) { console.error('utils.logger error-forward failed', e); }

    // Additionally, forward moderation logs from a set of guilds to a dedicated moderation channel
    try {
      const MOD_AGG_CHANNEL_ID = '1458941514142056552';
      const MOD_GUILD_IDS = new Set([
        '368527215343435826',
        '1339662600903983154',
        '1459330497938325676',
        '1459345285317791917'
      ]);
      const category = payload && (payload.category || payload.type) ? String(payload.category || payload.type).toLowerCase() : null;
      if (guild && MOD_GUILD_IDS.has(String(guild.id)) && (category === 'moderation' || category === 'mod')) {
        const client = guild.client || (guild.members && guild.members.client) || null;
        if (client) {
          const modCh = await client.channels.fetch(MOD_AGG_CHANNEL_ID).catch(()=>null);
          if (modCh && isTextLike(modCh)) {
            // Forward embed(s) or content
            if (payload && typeof payload === 'object' && payload.embeds && payload.embeds.length) {
              // forward first embed with origin footer
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
      }
    } catch (e) { console.error('utils.logger mod-forward failed', e); }

    return;
  } catch (e) {
    console.error('utils.logger sendLog failed', e);
  }
}

module.exports = { sendLog };
