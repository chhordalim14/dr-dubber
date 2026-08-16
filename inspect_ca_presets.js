const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('const CA_PRESET_KEY');
console.log(indexHtml.substring(idx - 200, idx + 2500));
