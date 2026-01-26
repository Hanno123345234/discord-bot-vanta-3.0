const fs = require('fs');
const vm = require('vm');
const path = require('path');
const p = process.argv[2] || path.join(__dirname, '..', 'index.js');
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
let lo = 1, hi = lines.length, failAt = null;
while (lo <= hi) {
  const mid = Math.floor((lo + hi) / 2);
  const code = lines.slice(0, mid).join('\n');
  try {
    new vm.Script(code, { filename: p });
    // parsed OK up to mid
    lo = mid + 1;
  } catch (e) {
    failAt = mid;
    hi = mid - 1;
  }
}
if (failAt) {
  console.log('First failing line (approx):', failAt);
  console.log('Context:');
  const start = Math.max(1, failAt - 8);
  const end = Math.min(lines.length, failAt + 8);
  for (let i = start; i <= end; i++) {
    const mark = i === failAt ? '>>' : '  ';
    console.log(`${mark} ${i}: ${lines[i-1]}`);
  }
} else {
  console.log('Parsed OK for entire file.');
}
