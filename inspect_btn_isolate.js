const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('btn-isolate-bgm');
console.log(indexHtml.substring(idx, idx + 4000));
