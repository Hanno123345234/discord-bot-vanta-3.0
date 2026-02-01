const fs = require('fs');
const path = require('path');
function sanitize(raw){ if(!raw||typeof raw!=='string') return null; let v=raw.trim(); if(!v) return null; v=v.replace(/^['"]|['"]$/g,''); v=v.replace(/^(bot|bearer)\s+/i,'').trim(); return v||null; }
function looksLike(v){ if(!v) return false; const parts=v.split('.'); return parts.length===3 && v.length>=50; }
const envs=['TOKENSP','TOKEN','DISCORD_TOKEN','DISCORD_BOT_TOKEN','BOT_TOKEN','GIT_ACCESS_TOKEN'];
let found=null; for(const k of envs){ const v=sanitize(process.env[k]); if(v && looksLike(v)){ found={source:'env:'+k, token:v}; break; } }
if(!found){ try{ const p=path.join(__dirname,'..','token.txt'); if(fs.existsSync(p)){ const raw=fs.readFileSync(p,'utf8'); const t=sanitize(raw); if(t&&looksLike(t)) found={source:'token.txt', token:t}; } }catch(e){} }
if(!found){ try{ const p=path.join(__dirname,'..','.env'); if(fs.existsSync(p)){ const lines=String(fs.readFileSync(p,'utf8')).split(/\r?\n/).map(l=>l.trim()).filter(l=>l && !l.startsWith('#')); const first=lines[0]; if(first && !first.includes('=') && looksLike(first)) found={source:'.env:raw', token:sanitize(first)}; } }catch(e){} }
console.log('Token found:', !!found, found?{source:found.source, len:found.token.length, preview:found.token.slice(0,4)+'…'+found.token.slice(-4)}:null);
process.exit(found?0:2);
