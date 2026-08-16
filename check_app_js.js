const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

// Check if app.js is referenced
console.log("Includes app.js in head:", html.includes('<script src="app.js"></script>'));
