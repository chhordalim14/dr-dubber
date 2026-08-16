const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const regex = /window\.electronAPI\.([a-zA-Z0-9_]+)/g;
let match;
const methods = new Set();
while ((match = regex.exec(indexHtml)) !== null) {
    methods.add(match[1]);
}
console.log('All window.electronAPI methods used in index.html:');
console.log([...methods]);
