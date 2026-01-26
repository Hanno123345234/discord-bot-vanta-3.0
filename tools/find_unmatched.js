const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.js');
const s = fs.readFileSync(p, 'utf8');
let line = 1;
let inSingle=false, inDouble=false, inBack=false, inSlash=false;
const stack = [];
for (let i=0;i<s.length;i++){
  const ch = s[i];
  if (ch === '\n') { line++; if (inSlash === 'line') inSlash = false; }
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
    if (inSlash === 'block' && ch === '*' && s[i+1] === '/') { inSlash=false; i++; continue; }
    continue;
  }
  if (ch === '(' || ch === '{' || ch === '[') {
    stack.push({ch, line});
  } else if (ch === ')' || ch === '}' || ch === ']') {
    const expected = ch === ')' ? '(' : (ch === '}' ? '{' : '[');
    if (stack.length && stack[stack.length-1].ch === expected) {
      stack.pop();
    } else {
      console.log('Unmatched closing', ch, 'at line', line);
      // try to find matching earlier in stack
      let foundIdx = -1;
      for (let j = stack.length-1; j>=0; j--) if (stack[j].ch === expected) { foundIdx = j; break; }
      if (foundIdx>=0) {
        stack.splice(foundIdx,1);
      } else {
        // nothing to match
      }
    }
  }
}
if (stack.length) {
  console.log('Unmatched openings count:', stack.length);
  console.log(JSON.stringify(stack, null, 2));
  const txt = require('fs').readFileSync(p,'utf8').split(/\r?\n/);
  for (const it of stack) {
    const start = Math.max(0, it.line-3);
    const end = Math.min(txt.length, it.line+3);
    console.log('\n--- Context around line', it.line, '---');
    for (let i=start;i<end;i++) console.log((i+1).toString().padStart(5,' ')+': '+txt[i]);
  }
} else console.log('No unmatched openings');
