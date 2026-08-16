const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('document.getElementById("btn-isolate-bgm")');
if (idx !== -1) {
    console.log(indexHtml.substring(idx, idx + 4000));
} else {
    const idx2 = indexHtml.indexOf('btnIsolate');
    console.log(indexHtml.substring(idx2, idx2 + 4000));
}
