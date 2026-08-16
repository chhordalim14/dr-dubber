const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('const proj = createEmptyProjectState');
console.log(indexHtml.substring(idx + 1000, idx + 4000));
