const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('function loadVideoFiles');
if (startIdx !== -1) {
    console.log("=== function loadVideoFiles ===");
    console.log(indexHtml.substring(startIdx, startIdx + 3000));
} else {
    const startIdx2 = indexHtml.indexOf('const loadVideoFiles');
    console.log("=== const loadVideoFiles ===");
    console.log(indexHtml.substring(startIdx2, startIdx2 + 3000));
}
