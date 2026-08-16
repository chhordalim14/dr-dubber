const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

// Replace the round circle container with sleek squircle container for the DR Dubber logo
const oldLogoContainer = `<div class="w-10 h-10 rounded-full overflow-hidden flex items-center justify-center bg-[var(--bg-base)] border border-[var(--border-light)] shadow-sm shrink-0">
          <img src="drdubberpro.png" alt="DR Dubber Pro Logo" class="w-full h-full object-cover" />
        </div>`;

const newLogoContainer = `<div class="w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center bg-[var(--bg-base)] border border-[var(--border-light)] shadow-md shrink-0 p-0.5">
          <img src="drdubberpro.png" alt="DR Dubber Pro Logo" class="w-full h-full object-cover rounded-lg" />
        </div>`;

if (html.includes(oldLogoContainer)) {
    html = html.replace(oldLogoContainer, newLogoContainer);
    fs.writeFileSync(indexHtmlPath, html, 'utf8');
    console.log('Successfully updated logo container to squircle in index.html');
} else {
    console.log('Old logo container pattern not matched, attempting regex replacement...');
    html = html.replace(/<div class="w-10 h-10 rounded-full[^>]*>[\s\S]*?<img src="drdubberpro\.png"[^>]*>[\s\S]*?<\/div>/, newLogoContainer);
    fs.writeFileSync(indexHtmlPath, html, 'utf8');
    console.log('Applied regex replacement for logo container');
}
