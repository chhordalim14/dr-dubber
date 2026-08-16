const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const scriptRegex = /<script\b[^>]*>/gi;
let m;
while ((m = scriptRegex.exec(indexHtml)) !== null) {
    console.log(m[0]);
}
