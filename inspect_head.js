const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const headIdx = indexHtml.indexOf('</head>');
console.log(indexHtml.substring(0, headIdx + 7));
