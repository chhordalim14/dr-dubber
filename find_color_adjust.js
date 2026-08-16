const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

let pos = 0;
while (true) {
    const idx = indexHtml.indexOf('color-adjust', pos);
    if (idx === -1) break;
    console.log(`\n=== MATCH at ${idx} ===`);
    console.log(indexHtml.substring(Math.max(0, idx - 50), Math.min(indexHtml.length, idx + 600)));
    pos = idx + 12;
}
