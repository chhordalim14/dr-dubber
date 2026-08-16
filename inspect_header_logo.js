const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const idx = html.indexOf('drdubberpro.png');
console.log(html.substring(Math.max(0, idx - 150), idx + 350));
