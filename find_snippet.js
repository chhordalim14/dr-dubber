const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'frontend', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

const idx = content.indexOf('http://localhost:3001/api/transcribe');
console.log(content.substring(idx, idx + 600));
