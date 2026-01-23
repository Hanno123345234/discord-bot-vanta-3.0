const fs=require('fs');
const path = require('path');
const s=fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
function uptoLine(n){return s.split('\n').slice(0,n).join('\n')}
const p=uptoLine(1680);
const parOpen=(p.match(/\(/g)||[]).length;
const parClose=(p.match(/\)/g)||[]).length;
const sqOpen=(p.match(/\[/g)||[]).length;
const sqClose=(p.match(/\]/g)||[]).length;
const bt=(p.match(/`/g)||[]).length;
console.log('up to 1680: (',parOpen,')',parClose,' [',sqOpen,']',sqClose,' `',bt);
fs.writeFileSync(path.join(__dirname,'diag_prefix.json'), JSON.stringify({parOpen,parClose,sqOpen,sqClose,bt},null,2));
