const fs = require('fs');
const vm = require('vm');
const path = require('path');
const p = path.join(__dirname, '..', 'index.js');
const code = fs.readFileSync(p, 'utf8');
try {
  new vm.Script(code, { filename: p });
  console.log('Parsed OK');
} catch (e) {
  console.error('Parse failed:');
  console.error(e && e.stack ? e.stack : e);
}
