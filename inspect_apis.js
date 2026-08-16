const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, 'frontend', 'app.js'), 'utf8');

const regex = /\/api\/[a-zA-Z0-9_\-\/]+/g;
const set = new Set(appJs.match(regex) || []);
console.log('API endpoints referenced in app.js:');
console.log([...set]);

// Let's also check index.html
const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');
const indexSet = new Set(indexHtml.match(regex) || []);
console.log('API endpoints in index.html:');
console.log([...indexSet]);
