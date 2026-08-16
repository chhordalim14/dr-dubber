const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('function restoreProjectState(');
console.log(indexHtml.substring(idx, idx + 3500));
