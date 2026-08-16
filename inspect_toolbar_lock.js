const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('btn-add-video-overlay');
console.log(indexHtml.substring(Math.max(0, idx - 400), idx + 1200));
