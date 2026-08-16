const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('function smoothVisualLoop');
if (startIdx !== -1) {
    console.log("=== function smoothVisualLoop ===");
    console.log(indexHtml.substring(startIdx, startIdx + 3000));
} else {
    const idx2 = indexHtml.indexOf('const smoothVisualLoop');
    console.log("=== const smoothVisualLoop ===");
    console.log(indexHtml.substring(idx2, idx2 + 3000));
}
