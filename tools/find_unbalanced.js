const fs = require('fs');
const s = fs.readFileSync('index.js','utf8');
let p=0,b=0,c=0; // parentheses, brackets, braces
const lines = s.split('\n');
for (let li=0; li<lines.length; li++){
  const line = lines[li];
  for (let i=0;i<line.length;i++){
    const ch = line[i];
    if (ch==='(') p++;
    if (ch===')') p--;
    if (ch==='[') b++;
    if (ch===']') b--;
    if (ch==='{') c++;
    if (ch==='}') c--;
    if (p<0||b<0||c<0){
      console.log('Negative at line', li+1, 'char', i+1, 'counts paren',p,'bracket',b,'brace',c);
      process.exit(0);
    }
  }
}
console.log('End counts paren',p,'bracket',b,'brace',c);

// print around the reported error area
const areaStart = Math.max(0,2362-10);
const areaEnd = Math.min(lines.length,2362+10);
console.log('\nContext around line 2362:');
for (let i=areaStart;i<areaEnd;i++) console.log((i+1)+': '+lines[i]);
