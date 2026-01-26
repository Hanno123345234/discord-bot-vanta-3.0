const fs = require('fs');
const s = fs.readFileSync('index.js','utf8');
let p=0,b=0,c=0;
for(let i=0;i<s.length;i++){
  const ch=s[i];
  if(ch==='(') p++;
  if(ch===')') p--;
  if(ch==='[') b++;
  if(ch===']') b--;
  if(ch==='{') c++;
  if(ch==='}') c--;
  if(p<0||b<0||c<0){
    const upto=s.slice(0,i);
    const line=upto.split('\n').length;
    console.log('Negative count at char',i+1,'line',line,'paren',p,'bracket',b,'brace',c);
    process.exit(0);
  }
}
console.log('final counts paren',p,'bracket',b,'brace',c);
