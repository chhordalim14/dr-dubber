const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const target = `// Delete on ✕ button
          chip.querySelector(".ca-preset-del").addEventListener("click", (e) => {
            e.stopPropagation();
            const idx = parseInt(e.currentTarget.dataset.index, 10);
            const updated = caLoadPresets();
            updated.splice(idx, 1);
            caSavePresets(updated);
            caRenderPresets();
            _lucideCreateIcons({ root: container });
          });`;

const replacement = `// Delete on ✕ button (only for custom presets)
          const delBtn = chip.querySelector(".ca-preset-del");
          if (delBtn) {
            delBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              const idx = parseInt(e.currentTarget.dataset.index, 10);
              const updated = caLoadPresets();
              updated.splice(idx, 1);
              caSavePresets(updated);
              caRenderPresets();
              _lucideCreateIcons({ root: container });
            });
          }`;

if (html.includes(target)) {
    html = html.replace(target, replacement);
    fs.writeFileSync(indexHtmlPath, html, 'utf8');
    console.log("Successfully fixed null delBtn addEventListener crash in index.html!");
} else {
    console.log("Warning: exact string not matched, applying regex replacement...");
    const regex = /chip\.querySelector\("\.ca-preset-del"\)\.addEventListener\("click",/g;
    html = html.replace(regex, `const delBtn = chip.querySelector(".ca-preset-del");\n          if (delBtn) delBtn.addEventListener("click",`);
    fs.writeFileSync(indexHtmlPath, html, 'utf8');
    console.log("Applied regex fix!");
}
