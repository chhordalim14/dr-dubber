const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('id="color-adjust-panel"');
if (idx !== -1) {
    console.log("=== #color-adjust-panel markup ===");
    console.log(indexHtml.substring(idx - 100, idx + 4000));
} else {
    console.log("Not found by ID");
}
