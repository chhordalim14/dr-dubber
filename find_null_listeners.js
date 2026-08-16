const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

// 1. Move VOXCMP2_KEY definition to the very top or var
// 2. Find all getElementById and addEventListener
const idRegex = /id=["']([^"']+)["']/g;
const allIds = new Set();
let idMatch;
while ((idMatch = idRegex.exec(html)) !== null) {
    allIds.add(idMatch[1]);
}

console.log(`Total HTML element IDs: ${allIds.size}`);

// Search for getElementById("...").addEventListener
const listenerRegex = /document\.getElementById\(["']([^"']+)["']\)\.addEventListener/g;
let lMatch;
const missing = [];
while ((lMatch = listenerRegex.exec(html)) !== null) {
    const targetId = lMatch[1];
    if (!allIds.has(targetId)) {
        missing.push(targetId);
    }
}

console.log("Missing elements being attached with .addEventListener without optional chaining (?):", missing);
