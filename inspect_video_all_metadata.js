const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('mainVideo.addEventListener("loadedmetadata"');
console.log(indexHtml.substring(Math.max(0, idx - 500), idx + 2000));
