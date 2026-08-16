const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const regex = /btnLoadVideo\.addEventListener\("click"/g;
let m;
while ((m = regex.exec(html)) !== null) {
    console.log("=== MATCH AT", m.index, "===");
    console.log(html.substring(m.index, m.index + 500));
}
