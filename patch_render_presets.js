const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const startMarker = 'function caRenderPresets() {';
const endMarker = '// Apply preset with smooth animation';

const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker, startIdx);

if (startIdx !== -1 && endIdx !== -1) {
  const replacement = `function caRenderPresets() {
        const list = caLoadPresets();
        const container = document.getElementById("ca-preset-list");
        if (!container) return;
        if (list.length === 0) {
          container.innerHTML = \`<span class="text-[10px] text-[var(--text-muted)] italic">No presets yet</span>\`;
          return;
        }
        container.innerHTML = "";
        list.forEach((preset, i) => {
          const chip = document.createElement("div");
          chip.className = "group relative flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--border-light)] bg-[var(--bg-panel)] cursor-pointer hover:border-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/15 transition-all duration-150 select-none shadow-sm";
          const iconHtml = preset.icon ? \`<span class="text-xs shrink-0">\${preset.icon}</span>\` : \`<img src="assets/icons/color-preset.svg" class="w-3.5 h-3.5 shrink-0 opacity-70 group-hover:opacity-100 transition-opacity ca-preset-icon" />\`;
          const delHtml = preset.isDefault ? '' : \`<button class="ca-preset-del hidden group-hover:flex items-center justify-center w-3.5 h-3.5 rounded-full bg-red-500/80 hover:bg-red-500 text-white transition-all ml-0.5 shrink-0" data-index="\${i}" title="Delete"><i data-lucide="x" class="w-2 h-2 pointer-events-none"></i></button>\`;

          chip.innerHTML = \`
  \${iconHtml}
  <span class="relative group/tip flex items-center">
    <span class="text-[11px] font-medium text-[var(--text-bright)] whitespace-nowrap">\${preset.name}</span>
    <span class="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5
      whitespace-nowrap text-[10px] font-medium text-[var(--text-bright)]
      bg-[var(--bg-panel)] border border-[var(--border-light)]
      px-2 py-1 rounded-lg shadow-xl
      opacity-0 scale-95 group-hover/tip:opacity-100 group-hover/tip:scale-100
      transition-all duration-150 z-50">
      \${preset.name} (1-Click Filter)
    </span>
  </span>
  \${delHtml}
\`;

          `;

  html = html.substring(0, startIdx) + replacement + html.substring(endIdx);
  fs.writeFileSync(indexHtmlPath, html, 'utf8');
  console.log("Successfully updated caRenderPresets markup!");
} else {
  console.log("Markers not found");
}
