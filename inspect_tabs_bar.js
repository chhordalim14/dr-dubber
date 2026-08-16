const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const idx = html.indexOf('id="project-tabs-bar"');
console.log(html.substring(Math.max(0, idx - 400), idx + 1000));
