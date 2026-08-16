const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('// 2. A1 Track (Generated Voices) Sync');
console.log(indexHtml.substring(startIdx, startIdx + 2500));
