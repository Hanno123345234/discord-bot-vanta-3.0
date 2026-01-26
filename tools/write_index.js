const fs = require('fs');
const path = require('path');
const target = path.join(__dirname, '..', 'index.js');
const lines = [
  '// Minimal syntactically-correct starter for Vanta Bot workspace.',
  '// The original file is preserved as index.js.corrupted and index.js.broken.',
  "const fs = require('fs');",
  "const path = require('path');",
  "require('dotenv').config();",
  "const { Client, GatewayIntentBits } = require('discord.js');",
  '',
  'function resolveTokenSimple() {',
  "  const envToken = process.env.TOKEN || process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || process.env.TOKENSP || process.env.DISCORD_BOT_TOKEN;",
  "  if (envToken && typeof envToken === 'string' && envToken.trim()) return envToken.trim();",
  "  try { const t = fs.readFileSync(path.join(__dirname, '..', 'token.txt'), 'utf8').trim(); if (t) return t; } catch (e) {}",
  '  return null;',
  '}',
  '',
  "function validateTokenFormat(t) { return !!t && typeof t === 'string' && t.split('.').length >= 2 && t.length >= 30; }",
  '',
  'const token = resolveTokenSimple();',
  "if (!validateTokenFormat(token)) {",
  "  console.error('Bot token missing or malformed. Set TOKEN env var or token.txt');",
  '  process.exit(1);',
  '}',
  '',
  "const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });",
  "client.once('ready', () => console.log('Logged in as', client.user && client.user.tag));",
  "client.on('error', (err) => console.error('Discord client error', err));",
  '',
  "client.on('messageCreate', async (message) => {",
  '  try {',
  "    if (!message || !message.content) return;",
  "    if (message.author && message.author.bot) return;",
  "    if (message.content === '!ping') return message.reply('pong');",
  "  } catch (e) { console.error('messageCreate handler error', e); }",
  '});',
  '',
  "client.login(token).catch(e => { console.error('Login failed', e && e.message); process.exit(1); });",
  '',
  "module.exports = { client };",
  ''
];

try {
  fs.writeFileSync(target, lines.join('\n'), { encoding: 'utf8' });
  console.log('Wrote', target);
} catch (e) {
  console.error('Failed to write index.js', e);
  process.exit(2);
}
