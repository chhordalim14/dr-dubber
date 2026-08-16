const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

// Find all <script> tags and check for syntax errors
const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let count = 0;
while ((match = scriptRegex.exec(indexHtml)) !== null) {
    const srcMatch = match[0].match(/src=["']([^"']+)["']/i);
    if (!srcMatch) {
        count++;
        const code = match[1];
        try {
            new Function(code);
            console.log(`Inline Script #${count}: Syntax OK (${code.length} chars)`);
        } catch (e) {
            console.error(`Inline Script #${count} SYNTAX ERROR:`, e.message);
        }
    }
}
