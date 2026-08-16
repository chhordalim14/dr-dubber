const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('btn-video-preset');
console.log(indexHtml.substring(Math.max(0, idx - 800), idx + 2000));
