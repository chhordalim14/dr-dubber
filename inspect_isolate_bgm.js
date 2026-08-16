const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('const response = await fetch("http://localhost:3001/api/remove-vocals"');
console.log(indexHtml.substring(Math.max(0, startIdx - 1000), startIdx + 3000));
