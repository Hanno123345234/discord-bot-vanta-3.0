const fs = require('fs');
const path = require('path');

async function fetchMessagesText(channel) {
  const fetched = [];
  let lastId = null;
  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const messages = await channel.messages.fetch(options);
    if (!messages.size) break;
    messages.sort((a,b)=>a.createdTimestamp - b.createdTimestamp).forEach(m => fetched.push(m));
    lastId = messages.last().id;
    if (messages.size < 100) break;
  }
  return fetched.sort((a,b)=>a.createdTimestamp - b.createdTimestamp);
}

function toPlainText(messages) {
  return messages.map(m => {
    const time = new Date(m.createdTimestamp).toISOString();
    const author = `${m.author.tag} (${m.author.id})`;
    const content = m.content || '';
    const attachments = m.attachments && m.attachments.size ? ` [Attachments: ${m.attachments.map(a=>a.url).join(', ')}]` : '';
    return `[${time}] ${author}: ${content}${attachments}`;
  }).join('\n');
}

function toHTML(messages) {
  const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const rows = messages.map(m => {
    const time = new Date(m.createdTimestamp).toLocaleString();
    const author = esc(`${m.author.tag} (${m.author.id})`);
    const content = esc(m.content || '');
    const atts = m.attachments && m.attachments.size ? `<div>Attachments: ${m.attachments.map(a=>`<a href="${a.url}">${a.name||a.url}</a>`).join(', ')}</div>` : '';
    return `<div class="msg"><div class="meta">[${time}] <strong>${author}</strong></div><div class="content">${content}</div>${atts}</div>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Segoe UI,Arial;background:#0f1720;color:#e6eef8} .msg{padding:6px;border-bottom:1px solid #1f2937} .meta{font-size:12px;color:#9aa6b2} .content{margin-top:4px}</style></head><body>${rows}</body></html>`;
}

async function createTranscript(channel, folderPath) {
  try {
    const messages = await fetchMessagesText(channel);
    const txt = toPlainText(messages);
    const html = toHTML(messages);
    const safeName = `${channel.guild.id}-${channel.id}-${Date.now()}`;
    const txtPath = path.join(folderPath, safeName + '.txt');
    const htmlPath = path.join(folderPath, safeName + '.html');
    fs.writeFileSync(txtPath, txt, 'utf8');
    fs.writeFileSync(htmlPath, html, 'utf8');
    return { txtPath, htmlPath };
  } catch (err) {
    console.error('Transcript creation failed:', err);
    throw err;
  }
}

module.exports = { createTranscript };
