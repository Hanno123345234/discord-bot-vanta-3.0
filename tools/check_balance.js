const fs=require('fs');
const s=fs.readFileSync('index.js','utf8');
let l=1, braces=0, parens=0, brackets=0, backticks=0;
for(let i=0;i<s.length;i++){
	const ch=s[i];
	if(ch=='\n') l++;
	if(ch=='{') braces++;
	if(ch=='}') braces--;
	if(ch=='(') parens++;
	if(ch==')') parens--;
	if(ch=='[') brackets++;
	if(ch==']') brackets--;
	if(ch=='`') backticks++;
	if(braces<0||parens<0||brackets<0){
		console.log('Negative at line',l, 'counts', {braces,parens,brackets,backticks}, 'index', i);
		process.exit(0);
	}
}
console.log('final counts', {braces,parens,brackets,backticks});