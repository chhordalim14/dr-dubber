const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const regex = /sub\.audioEnd/g;
let match;
while ((match = regex.exec(indexHtml)) !== null) {
    const idx = match.index;
    console.log(`\n=== MATCH audioEnd at ${idx} ===`);
    console.log(indexHtml.substring(Math.max(0, idx - 100), Math.min(indexHtml.length, idx + 400)));
}
