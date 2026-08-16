const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('const colorAdjDefaults');
if (idx !== -1) {
    console.log(indexHtml.substring(idx, idx + 2500));
} else {
    const idx2 = indexHtml.indexOf('videoColorAdj');
    console.log(indexHtml.substring(idx2, idx2 + 2500));
}
