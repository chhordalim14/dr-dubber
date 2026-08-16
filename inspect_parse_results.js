const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('// PHASE 3: PARSE RESULTS AND BUILD TIMELINE');
console.log(indexHtml.substring(startIdx, startIdx + 2500));
