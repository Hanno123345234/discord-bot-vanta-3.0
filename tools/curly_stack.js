const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.js');
const s = fs.readFileSync(p,'utf8');
let stack = [];
let line = 1;
let i=0;
let inSingle=false,inDouble=false,inBack=false,inBlock=false,inLine=false;
while (i<s.length){
  const ch = s[i];
  const next = s[i+1];
  if (ch === '\n') { line++; inLine=false; i++; continue; }
  if (inLine) { i++; continue; }
  if (inBlock) {
    if (ch === '*' && next === '/') { inBlock=false; i+=2; continue; }
    i++; continue;
  }
  if (inSingle) {
    if (ch === "'" && s[i-1] !== '\\') inSingle=false;
    i++; continue;
  }
  if (inDouble) {
    if (ch === '"' && s[i-1] !== '\\') inDouble=false;
    i++; continue;
  }
  if (inBack) {
    if (ch === '`' && s[i-1] !== '\\') inBack=false;
    i++; continue;
  }
  // not in string/comment
  if (ch === '/' && next === '/') { inLine=true; i+=2; continue; }
  if (ch === '/' && next === '*') { inBlock=true; i+=2; continue; }
  if (ch === "'") { inSingle=true; i++; continue; }
  if (ch === '"') { inDouble=true; i++; continue; }
  if (ch === '`') { inBack=true; i++; continue; }
  if (ch === '{') { stack.push({line, pos:i}); }
  else if (ch === '}') {
    if (stack.length) stack.pop();
    else console.log('Unmatched } at line', line);
  }
  i++;
}
if (stack.length) {
  console.log('Unclosed { count', stack.length);
  for (const it of stack) {
    const ctx = s.slice(Math.max(0,it.pos-60), Math.min(s.length,it.pos+60));
    console.log('Opened at line', it.line, '\n...', ctx.replace(/\n/g,'\\n'), '\n---');
  }
} else console.log('All curly braces balanced');
