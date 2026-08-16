const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

// Remove security.js script tag
html = html.replace(/<script[^>]*src=["']security\.js["'][^>]*><\/script>/gi, '');

fs.writeFileSync(indexHtmlPath, html, 'utf8');
console.log('Successfully cleaned index.html');
