const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.js');
const txt = fs.readFileSync(p,'utf8').split(/\r?\n/);
let inSingle=false,inDouble=false,inBack=false,inSlash=false;
let paren=0,curly=0,sq=0;
let maxCurly = 0, maxParen = 0, maxSq=0;
for (let li=0; li<txt.length; li++){
  const line = txt[li];
  let lineCurlyBefore = curly;
  for (let i=0;i<line.length;i++){
    const ch = line[i];
    // naive skip strings/comments
    if (!inSingle && !inDouble && !inBack && !inSlash) {
      if (ch === "'") { inSingle=true; continue; }
      if (ch === '"') { inDouble=true; continue; }
      if (ch === '`') { inBack=true; continue; }
      if (ch === '/' && line[i+1] === '/') { break; }
      if (ch === '/' && line[i+1] === '*') { inSlash=true; i++; continue; }
    } else {
      if (inSingle && ch === "'" && line[i-1] !== '\\') { inSingle=false; continue; }
      if (inDouble && ch === '"' && line[i-1] !== '\\') { inDouble=false; continue; }
      if (inBack && ch === '`' && line[i-1] !== '\\') { inBack=false; continue; }
      if (inSlash && ch === '*' && line[i+1] === '/') { inSlash=false; i++; continue; }
      continue;
    }
    if (ch === '{') { curly++; if (curly>maxCurly) maxCurly=curly; }
    else if (ch === '}') { curly--; }
    else if (ch === '(') { paren++; if (paren>maxParen) maxParen=paren; }
    else if (ch === ')') { paren--; }
    else if (ch === '[') { sq++; if (sq>maxSq) maxSq=sq; }
    else if (ch === ']') { sq--; }
  }
    if (curly !== lineCurlyBefore) {
      console.log('line', li+1, 'curly', curly, 'paren', paren, 'sq', sq, '--', txt[li].trim().slice(0,120));
    }
}
console.log('FINAL counts -> curly', curly, 'paren', paren, 'sq', sq);
console.log('MAX depths -> curly', maxCurly, 'paren', maxParen, 'sq', maxSq);
