const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const startIdx = indexHtml.indexOf('Browser failed to download extracted audio');
if (startIdx !== -1) {
    console.log(indexHtml.substring(Math.max(0, startIdx - 500), startIdx + 1500));
} else {
    const idx2 = indexHtml.indexOf('Extracting audio via Node server');
    console.log(indexHtml.substring(Math.max(0, idx2 - 500), idx2 + 1500));
}
