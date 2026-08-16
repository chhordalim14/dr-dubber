const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const lines = html.split('\n');
lines.forEach((line, idx) => {
    if (line.includes('openFile') || line.includes('openMultiFile') || line.includes('selectFolder')) {
        console.log(`Line ${idx + 1}: ${line.trim()}`);
    }
});
