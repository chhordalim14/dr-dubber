const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const searchTerms = ['ca-panel', 'video-preset', 'colorAdjustment', 'brightness', 'filter'];

searchTerms.forEach(term => {
    let pos = 0;
    let count = 0;
    while (count < 3) {
        const idx = indexHtml.indexOf(term, pos);
        if (idx === -1) break;
        console.log(`\n=== MATCH FOR "${term}" AT ${idx} ===`);
        console.log(indexHtml.substring(Math.max(0, idx - 50), Math.min(indexHtml.length, idx + 300)));
        pos = idx + term.length;
        count++;
    }
});
