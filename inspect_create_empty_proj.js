const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('function createEmptyProjectState');
console.log(indexHtml.substring(idx - 50, idx + 1500));
