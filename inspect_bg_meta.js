const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('// Default speed/end — will be refined by background metadata load below');
console.log(indexHtml.substring(startIdx, startIdx + 3000));
