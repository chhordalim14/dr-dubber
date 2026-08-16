const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const regex = /DAI Dubber|DAI-Dubber|Dai Dubber/gi;
let match;
const matches = [];
while ((match = regex.exec(indexHtml)) !== null) {
    matches.push({ index: match.index, text: match[0], context: indexHtml.substring(Math.max(0, match.index - 30), Math.min(indexHtml.length, match.index + 60)) });
}

console.log(`Found ${matches.length} occurrences in index.html:`);
console.log(matches.slice(0, 10));
