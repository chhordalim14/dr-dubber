const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('/api/transcribe');
console.log(indexHtml.substring(startIdx - 100, startIdx + 1200));
