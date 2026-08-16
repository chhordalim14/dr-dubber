const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('if (data.success) {');
console.log(indexHtml.substring(startIdx, startIdx + 3000));
