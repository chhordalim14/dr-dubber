const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

let pos = 0;
while (true) {
    const idx = indexHtml.indexOf('daidubberpro.png', pos);
    if (idx === -1) break;
    console.log(`\n=== MATCH AT ${idx} ===`);
    console.log(indexHtml.substring(Math.max(0, idx - 50), Math.min(indexHtml.length, idx + 200)));
    pos = idx + 16;
}
