const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

let pos = 0;
while (true) {
    const idx = html.indexOf('VOXCMP2_KEY', pos);
    if (idx === -1) break;
    console.log(`\n=== MATCH AT ${idx} ===`);
    console.log(html.substring(Math.max(0, idx - 150), Math.min(html.length, idx + 400)));
    pos = idx + 11;
}
