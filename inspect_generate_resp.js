const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('http://localhost:3001/api/generate-audio');
console.log(indexHtml.substring(startIdx, startIdx + 3000));
