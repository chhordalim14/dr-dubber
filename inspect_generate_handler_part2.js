const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('btnGenerateAudio.addEventListener');
console.log(indexHtml.substring(startIdx + 1500, startIdx + 5000));
