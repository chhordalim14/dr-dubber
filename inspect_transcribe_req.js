const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('http://localhost:3001/api/transcribe');
console.log(indexHtml.substring(Math.max(0, startIdx - 500), startIdx + 2000));
