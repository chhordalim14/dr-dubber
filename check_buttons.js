const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

// Check if button elements exist and are attached
const hasBtnLoadVideo = html.includes('id="btn-load-video"');
const hasBtnLoadBgm = html.includes('id="btn-load-bgm"');
const hasBtnImportSrt = html.includes('id="btn-import-srt"');

console.log("Button check in HTML:", {
    hasBtnLoadVideo,
    hasBtnLoadBgm,
    hasBtnImportSrt
});
