const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

// Find audio playback logic during video timeupdate / playing
const terms = ['audioStatus', 'textEnd', 'textStart', 'playAudio', 'playSubtitleAudio', 'syncEnd', 'autoFit', 'pauseAllAudio'];

terms.forEach(t => {
    let pos = 0;
    let count = 0;
    while (count < 3) {
        const idx = indexHtml.indexOf(t, pos);
        if (idx === -1) break;
        console.log(`\n=== MATCH: ${t} at ${idx} ===`);
        console.log(indexHtml.substring(Math.max(0, idx - 50), Math.min(indexHtml.length, idx + 300)));
        pos = idx + t.length;
        count++;
    }
});
