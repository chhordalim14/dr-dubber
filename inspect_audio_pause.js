const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('// Keep audio perfectly in sync even while playing');
console.log(indexHtml.substring(startIdx, startIdx + 2000));
