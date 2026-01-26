const fs = require('fs');
const s = fs.readFileSync('index.js','utf8');
const lines = s.split('\n');
function test(n) {
  const code = lines.slice(0,n).join('\n');
  try {
    new Function(code);
    return true;
  } catch (e) {
    return e.message;
  }
}
for (let i=50;i<=lines.length;i+=50) {
  const res = test(i);
  if (res !== true) { console.log('failed at approx line', i, res); break; }
  if (i+50>lines.length) console.log('no failure up to end');
}
