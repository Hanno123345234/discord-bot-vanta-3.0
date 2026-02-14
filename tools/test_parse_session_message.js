const fs = require('fs');
const path = require('path');
const vm = require('vm');

const indexPath = path.join(__dirname, '..', 'index.js');
const code = fs.readFileSync(indexPath, 'utf8');

// Extract parseSessionMessage() without executing the whole bot.
const re = /function\s+parseSessionMessage\s*\([^)]*\)\s*\{[\s\S]*?\n\}\n\nfunction\s+persistReminders\s*\(/m;
const match = code.match(re);
if (!match) {
  console.error('Could not locate parseSessionMessage() block');
  process.exit(1);
}

const extracted = match[0].replace(/\n\nfunction\s+persistReminders\s*\($/m, '\n');

const context = {
  console,
  Date,
  String,
  Number,
  Array,
  RegExp,
  Map,
  Set,
};
vm.createContext(context);
vm.runInContext(`${extracted}; this.parseSessionMessage = parseSessionMessage;`, context, { filename: 'extract_parseSessionMessage.vm.js' });

function fmt(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

const samples = [
  {
    name: 'with header/footer',
    text: `**Beta Sessions Claim**\n\n1. 22:45 - 23:00\nStaff: <@111>\n2. 23:00 - 23:15\nStaff: <@222>\n3. 00:45 - 01:00\nStaff: <@333>\n\nPing me to claim in <#123>`,
  },
  {
    name: 'minimal',
    text: `1. 22:45 - 23:00\nStaff: <@111>\n2. 23:00 - 23:15\nStaff: <@222>\n3. 00:45 - 01:00\nStaff: <@333>`,
  },
];

const ref = new Date('2026-02-01T12:00:00.000Z');

for (const sample of samples) {
  const sessions = context.parseSessionMessage(sample.text, ref);
  console.log(`\n=== Sample: ${sample.name} ===`);
  console.log(`Returned count: ${Array.isArray(sessions) ? sessions.length : 'n/a'}`);
  console.log('Returned raw:', JSON.stringify(sessions, null, 2));
  console.log('Formatted:');
  for (const s of sessions || []) {
    console.log(`#${s.index} ${fmt(s.start)} -> ${fmt(s.end)} staff=${JSON.stringify(s.staff)}`);
  }
}
