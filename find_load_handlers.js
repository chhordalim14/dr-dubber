const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

// Find Load Video and Import SRT buttons and event listeners
const searchTerms = ['Load Video', 'Import (SRT)', 'btn-load-video', 'btn-import-srt', 'load-video', 'import-srt', 'openFile', 'openMultiFile'];

searchTerms.forEach(term => {
    let pos = 0;
    while (true) {
        const idx = indexHtml.indexOf(term, pos);
        if (idx === -1) break;
        console.log(`\n=== MATCH FOR "${term}" AT ${idx} ===`);
        console.log(indexHtml.substring(Math.max(0, idx - 100), Math.min(indexHtml.length, idx + 400)));
        pos = idx + term.length;
    }
});
