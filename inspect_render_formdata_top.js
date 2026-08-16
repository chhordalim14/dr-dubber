const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('const response = await fetch("http://localhost:3001/api/render"');
console.log(indexHtml.substring(Math.max(0, idx - 3500), idx - 1500));
