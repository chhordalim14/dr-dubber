const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const regex = /function _lucideCreateIcons|_lucideCreateIcons\s*=/g;
let m;
let foundInHtml = false;
while ((m = regex.exec(html)) !== null) {
    foundInHtml = true;
    console.log("Found definition in index.html at", m.index);
}
if (!foundInHtml) {
    console.log("NOT defined in index.html! (Only in app.js)");
}
