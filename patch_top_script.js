const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

// Replace const VOXCMP2_KEY = "voxcmp2_settings"; with var VOXCMP2_KEY = "voxcmp2_settings"; everywhere
html = html.replace(/const VOXCMP2_KEY = "voxcmp2_settings";/g, 'var VOXCMP2_KEY = "voxcmp2_settings";');

// Also inject var VOXCMP2_KEY and safe _lucideCreateIcons at top of main script
const scriptStartIdx = html.indexOf('<script>');
if (scriptStartIdx !== -1) {
    const injection = `<script>
      var VOXCMP2_KEY = "voxcmp2_settings";
      function _lucideCreateIcons(opts) {
        try {
          if (window.lucide && typeof window.lucide.createIcons === 'function') {
            window.lucide.createIcons(opts);
          }
        } catch (e) {}
      }
      window._lucideCreateIcons = _lucideCreateIcons;
    `;
    html = html.substring(0, scriptStartIdx) + injection + html.substring(scriptStartIdx + 8);
    fs.writeFileSync(indexHtmlPath, html, 'utf8');
    console.log("Successfully patched index.html with top-level VOXCMP2_KEY and _lucideCreateIcons!");
}
