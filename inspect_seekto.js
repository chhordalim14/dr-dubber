const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('const seekTo = (offset > 0 ? offset : 0) * actualSpeed;');
console.log(indexHtml.substring(startIdx, startIdx + 2500));
