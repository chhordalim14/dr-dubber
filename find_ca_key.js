const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const idx = html.indexOf('const CA_PRESET_KEY = "aiDubber_colorPresets";');
console.log(html.substring(Math.max(0, idx - 100), idx + 300));
