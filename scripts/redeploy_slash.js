const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (e) {}

function sanitizeToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let v = String(raw).trim();
  v = v.replace(/^['"]|['"]$/g, '');
  v = v.replace(/\s+#.*$/g, '');
  v = v.replace(/^(bot|bearer)\s+/i, '');
  return v.trim() || null;
}

function looksLikeToken(v) {
  if (!v) return false;
  const parts = String(v).split('.');
  return parts.length === 3 && String(v).length >= 50;
}

function resolveToken() {
  const envKeys = ['DISCORD_TOKEN', 'TOKEN', 'TOKENSP', 'DISCORD_BOT_TOKEN', 'BOT_TOKEN', 'GIT_ACCESS_TOKEN'];
  for (const key of envKeys) {
    const v = sanitizeToken(process.env[key]);
    if (looksLikeToken(v)) return v;
  }

  const root = path.join(__dirname, '..');
  const tokenTxt = path.join(root, 'token.txt');
  if (fs.existsSync(tokenTxt)) {
    const v = sanitizeToken(fs.readFileSync(tokenTxt, 'utf8'));
    if (looksLikeToken(v)) return v;
  }

  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const raw = lines.find(l => !l.startsWith('#') && !l.includes('='));
    if (raw && looksLikeToken(raw)) return sanitizeToken(raw);
    for (const line of lines) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/i);
      if (!m) continue;
      const key = m[1];
      if (!envKeys.includes(key)) continue;
      const v = sanitizeToken(String(m[2]).replace(/^['"]|['"]$/g, ''));
      if (looksLikeToken(v)) return v;
    }
  }

  return null;
}

function loadJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function getSlashCommands(rootDir) {
  const names = ['ticket', 'admin', 'sa', 'voiceactivity', 'session', 'create', 'setup', 'poll', 'claim', 'whois'];
  const out = [];
  for (const name of names) {
    try {
      const mod = require(path.join(rootDir, 'commands', `${name}.js`));
      if (mod && mod.data) out.push(mod.data);
    } catch (e) {}
  }
  return out;
}

(async () => {
  const token = resolveToken();
  if (!token) {
    console.error('No valid token found for slash redeploy.');
    process.exit(1);
  }

  const rootDir = path.join(__dirname, '..');
  const cfg = loadJsonSafe(path.join(rootDir, 'config.json'), {});
  const slashCommands = getSlashCommands(rootDir);
  if (!slashCommands.length) {
    console.error('No slash commands found to deploy.');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once('ready', async () => {
    try {
      console.log(`Logged in as ${client.user.tag}`);
      const guildIds = new Set();

      if (cfg && cfg.testGuildId) guildIds.add(String(cfg.testGuildId));
      if (cfg && cfg.guilds && typeof cfg.guilds === 'object') {
        for (const gid of Object.keys(cfg.guilds)) guildIds.add(String(gid));
      }
      for (const [gid] of client.guilds.cache) guildIds.add(String(gid));

      const forcedGuildsEnv = String(process.env.DEPLOY_GUILDS || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const gid of forcedGuildsEnv) guildIds.add(gid);

      if (!guildIds.size) {
        console.warn('No guild IDs found; skipping guild deploy.');
      }

      for (const gid of guildIds) {
        try {
          const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid);
          await guild.commands.set(slashCommands);
          console.log(`✅ Slash commands updated in guild ${guild.id} (${guild.name})`);
        } catch (e) {
          console.warn(`⚠️ Failed guild deploy ${gid}: ${e && e.message ? e.message : e}`);
        }
      }

      if (String(process.env.DEPLOY_GLOBAL || '').toLowerCase() === 'true') {
        try {
          await client.application.commands.set(slashCommands);
          console.log('✅ Global slash commands updated (can take time to appear).');
        } catch (e) {
          console.warn(`⚠️ Failed global deploy: ${e && e.message ? e.message : e}`);
        }
      }
    } catch (e) {
      console.error('Deploy failed:', e);
      process.exitCode = 1;
    } finally {
      setTimeout(() => client.destroy(), 400);
    }
  });

  client.on('error', (e) => {
    console.error('Client error:', e);
  });

  await client.login(token);
})();
