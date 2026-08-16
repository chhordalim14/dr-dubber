const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

// Find all occurrences of .addEventListener(
const matches = [];
const regex = /([a-zA-Z0-9_$]+)\.addEventListener\(/g;
let m;
while ((m = regex.exec(html)) !== null) {
    matches.push({ varName: m[1], index: m.index, snippet: html.substring(Math.max(0, m.index - 50), m.index + 50) });
}

console.log(`Found ${matches.length} addEventListener calls.`);
