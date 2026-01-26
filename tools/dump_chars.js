const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.js');
const txt = fs.readFileSync(p,'utf8').split(/\r?\n/);
for (let i=20;i<30;i++){
  const line = txt[i] || '';
  console.log('LINE', i+1, line);
  for (let j=0;j<line.length;j++){
    const ch = line[j];
    process.stdout.write(j.toString().padStart(3,' ')+':'+ch+'('+ch.charCodeAt(0)+')  ');
  }
  console.log('\n');
}
