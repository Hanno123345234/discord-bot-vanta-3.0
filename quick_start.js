const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
function readToken() {
  const sanitize = (s) => { if(!s || typeof s !== 'string') return null; let v=s.trim(); v=v.replace(/^['"]|['"]$/g,''); v=v.replace(/^(bot|bearer)\s+/i,'').trim(); return v||null; };
  const envVars = ['DISCORD_TOKEN','TOKEN','TOKENSP','DISCORD_BOT_TOKEN','BOT_TOKEN'];
  for (const k of envVars) {
    const v = sanitize(process.env[k]); if (v && v.split('.').length===3 && v.length>50) return v;
  }
  try { const p = path.join(__dirname, 'token.txt'); if (fs.existsSync(p)) { const t = sanitize(fs.readFileSync(p,'utf8')); if (t) return t; } } catch(e){}
  try { const p = path.join(__dirname, '.env'); if (fs.existsSync(p)) { const lines = fs.readFileSync(p,'utf8').split(/\r?\n/).map(l=>l.trim()).filter(Boolean); const first = lines[0]; if (first && !first.includes('=')) return sanitize(first); } } catch(e){}
  return null;
}

(async () => {
  const token = readToken();
  if (!token) { console.error('No token found; set DISCORD_TOKEN in environment or token.txt/.env'); process.exit(1); }
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.once('ready', () => {
    console.log('Quick-start bot logged in as', client.user.tag);
    client.user.setActivity('Quick online check');
  });
  client.on('error', (e)=>{ console.error('Client error', e); });
  try {
    await client.login(token);
  } catch (e) { console.error('Login failed', e && e.message); process.exit(1); }
})();
