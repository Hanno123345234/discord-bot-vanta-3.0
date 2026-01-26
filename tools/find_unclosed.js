const fs = require('fs');
const s = fs.readFileSync('index.js','utf8');
let inS=false,inD=false,inB=false,inLine=false,inBlock=false;
let line=1;
const stack=[];
for(let i=0;i<s.length;i++){
  const ch = s[i];
  const next = s[i+1];
  if (ch === '\n') { line++; if (inLine) inLine=false; }
  if (inS || inD || inB || inLine || inBlock) {
    if (inS && ch === "'" && s[i-1] !== '\\') inS = false;
    if (inD && ch === '"' && s[i-1] !== '\\') inD = false;
    if (inB && ch === '`' && s[i-1] !== '\\') inB = false;
    if (inBlock && ch === '*' && next === '/') { inBlock = false; i++; }
    continue;
  }
  if (ch === '/' && next === '/') { inLine = true; i++; continue; }
  if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
  if (ch === "'") { inS = true; continue; }
  if (ch === '"') { inD = true; continue; }
  if (ch === '`') { inB = true; continue; }
  if (ch === '(' || ch === '{' || ch === '[') stack.push({ch, line, pos:i});
  else if (ch === ')' || ch === '}' || ch === ']'){
    const expected = ch === ')' ? '(' : (ch === '}' ? '{' : '[');
    if (stack.length && stack[stack.length-1].ch === expected) stack.pop();
    else {
      console.log('Unmatched closing', ch, 'at line', line);
    }
  }
}
if (!stack.length) return console.log('All matched');
console.log('Unclosed openings count:', stack.length);
const txt = s.split(/\r?\n/);
for (const it of stack) {
  console.log('\n--- Context around line', it.line, '---');
  const start = Math.max(0, it.line-4);
  const end = Math.min(txt.length, it.line+4);
  for (let i=start;i<end;i++) console.log((i+1).toString().padStart(5,' ')+': '+txt[i]);
}
console.log('\nLast 50 chars of file:\n', s.slice(-200));
