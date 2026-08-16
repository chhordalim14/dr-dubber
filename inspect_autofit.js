const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('function applyAutoFitCore');
if (startIdx !== -1) {
    console.log("=== function applyAutoFitCore ===");
    console.log(indexHtml.substring(startIdx, startIdx + 3000));
} else {
    const idx2 = indexHtml.indexOf('const applyAutoFitCore');
    console.log("=== const applyAutoFitCore ===");
    console.log(indexHtml.substring(idx2, idx2 + 3000));
}
