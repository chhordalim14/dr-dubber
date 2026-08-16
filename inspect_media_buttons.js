const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const search = ['btnLoadBgm.addEventListener', 'btnImportSrt', 'srtUploadInput.addEventListener', 'btn-import-srt'];

search.forEach(s => {
    let pos = 0;
    while (true) {
        const idx = indexHtml.indexOf(s, pos);
        if (idx === -1) break;
        console.log(`\n=== MATCH FOR "${s}" AT ${idx} ===`);
        console.log(indexHtml.substring(Math.max(0, idx - 50), Math.min(indexHtml.length, idx + 500)));
        pos = idx + s.length;
    }
});
