const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('const pickedFiles = result.files');
if (startIdx !== -1) {
    console.log("=== pickedFiles usage ===");
    console.log(indexHtml.substring(startIdx, startIdx + 1500));
}

const startIdx2 = indexHtml.indexOf('btnLoadVideo.addEventListener');
if (startIdx2 !== -1) {
    console.log("=== btnLoadVideo usage ===");
    console.log(indexHtml.substring(startIdx2, startIdx2 + 1500));
}
