const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('btnLoadVideo.addEventListener');
console.log(indexHtml.substring(idx - 100, idx + 2500));
