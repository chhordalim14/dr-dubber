const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const searchTerms = ['selectFolder', 'saveSrt', 'saveTextFile', 'autoSaveSrt', 'checkPathExists', 'getHardwareSpecs'];

searchTerms.forEach(term => {
    let pos = 0;
    while (true) {
        const idx = indexHtml.indexOf(term, pos);
        if (idx === -1) break;
        console.log(`\n=== MATCH FOR "${term}" AT ${idx} ===`);
        console.log(indexHtml.substring(Math.max(0, idx - 50), Math.min(indexHtml.length, idx + 300)));
        pos = idx + term.length;
    }
});
