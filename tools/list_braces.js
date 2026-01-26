const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.js');
const lines = fs.readFileSync(p,'utf8').split(/\r?\n/);
let inS=false,inD=false,inB=false,inC=false;
for (let li=0; li<lines.length; li++){
  const line = lines[li];
  for (let i=0;i<line.length;i++){
    const ch = line[i];
    if (!inS && !inD && !inB && !inC) {
      if (ch === "'") { inS=true; continue; }
      if (ch === '"') { inD=true; continue; }
      if (ch === '`') { inB=true; continue; }
      if (ch === '/' && line[i+1] === '/') break;
      if (ch === '/' && line[i+1] === '*') { inC=true; i++; continue; }
    } else {
      if (inS && ch === "'" && line[i-1] !== '\\') { inS=false; continue; }
      if (inD && ch === '"' && line[i-1] !== '\\') { inD=false; continue; }
      if (inB && ch === '`' && line[i-1] !== '\\') { inB=false; continue; }
      if (inC && ch === '*' && line[i+1] === '/') { inC=false; i++; continue; }
      continue;
    }
    if (ch === '{' || ch === '}') console.log('line', li+1, ch, line.trim());
  }
}
