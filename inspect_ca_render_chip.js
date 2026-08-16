const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const startMarker = 'function caRenderPresets() {';
const endMarker = '// Apply preset with smooth animation';

const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker, startIdx);

console.log(html.substring(startIdx, endIdx));
