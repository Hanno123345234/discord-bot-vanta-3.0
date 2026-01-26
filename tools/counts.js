const fs=require('fs');
const s=fs.readFileSync('index.js','utf8');
const lines=s.split('\n');
const upto=lines.slice(0,716).join('\n');
const count=(re,str)=> (str.match(re)||[]).length;
console.log('openParen',count(/\(/g,upto),'closeParen',count(/\)/g,upto),'openBrace',count(/{/g,upto),'closeBrace',count(/}/g,upto));
