const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const idx = indexHtml.indexOf('// C. Fire the kill signal to the backend ONLY for this specific tab\'s job');
console.log(indexHtml.substring(idx, idx + 4000));
