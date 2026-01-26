const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.js');
const s = fs.readFileSync(p, 'utf8');
let line = 1;
let counts = { '(':0, ')':0, '{':0, '}':0, '[':0, ']':0 };
let issues = [];
let inSingle=false, inDouble=false, inBack=false, inSlash=false; // basic string/comment state
for (let i=0;i<s.length;i++){
  const ch = s[i];
  if (ch === '\n') { line++; inSlash=false; }
  // rudimentary skip for strings and // comments and /* */
  if (!inSingle && !inDouble && !inBack && !inSlash) {
    if (ch === "'") { inSingle=true; continue; }
    if (ch === '"') { inDouble=true; continue; }
    if (ch === '`') { inBack=true; continue; }
    if (ch === '/' && s[i+1] === '/') { inSlash = 'line'; i++; continue; }
    if (ch === '/' && s[i+1] === '*') { inSlash = 'block'; i++; continue; }
  } else {
    if (inSingle && ch === "'" && s[i-1] !== '\\') { inSingle=false; continue; }
    if (inDouble && ch === '"' && s[i-1] !== '\\') { inDouble=false; continue; }
    if (inBack && ch === '`' && s[i-1] !== '\\') { inBack=false; continue; }
    if (inSlash === 'line' && ch === '\n') { inSlash=false; continue; }
    if (inSlash === 'block' && ch === '*' && s[i+1] === '/') { inSlash=false; i++; continue; }
    continue;
  }
  if (ch in counts) {
    counts[ch]++;
    // record imbalance if any closing seen more than opening
    if ((ch === ')' && counts[')']>counts['(']) || (ch === '}' && counts['}']>counts['{']) || (ch === ']' && counts[']']>counts['['])) {
      issues.push({line, char: ch, counts: Object.assign({}, counts)});
    }
  }
}
console.log('counts', counts);
if (issues.length) console.log('first imbalance at', issues[0]);
else console.log('no early imbalance detected');
console.log('total lines', line);