const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const idx = html.indexOf('btnImportSrt.addEventListener("click"');
console.log(html.substring(idx, idx + 2500));
