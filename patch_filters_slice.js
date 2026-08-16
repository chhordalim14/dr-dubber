const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const startMarker = 'const CA_PRESET_KEY = "aiDubber_colorPresets";';
const endMarker = 'function caSavePresets(list) {';

const startIdx = html.indexOf(startMarker);
const endIdx = html.indexOf(endMarker, startIdx);

if (startIdx !== -1 && endIdx !== -1) {
  const replacement = `const CA_PRESET_KEY = "aiDubber_colorPresets";

      const DEFAULT_COLOR_FILTERS = [
        {
          name: "Cinematic Warm",
          icon: "🎬",
          adj: { brightness: 106, contrast: 116, saturation: 112, sharpness: 1.5, hue: -6 },
          isDefault: true,
        },
        {
          name: "Teal & Orange",
          icon: "🌊",
          adj: { brightness: 104, contrast: 122, saturation: 128, sharpness: 2.0, hue: 14 },
          isDefault: true,
        },
        {
          name: "Vivid HDR",
          icon: "✨",
          adj: { brightness: 108, contrast: 125, saturation: 130, sharpness: 2.5, hue: 0 },
          isDefault: true,
        },
        {
          name: "Vintage Retro",
          icon: "🎞️",
          adj: { brightness: 98, contrast: 95, saturation: 82, sharpness: 0.5, hue: -14 },
          isDefault: true,
        },
        {
          name: "Classic Noir",
          icon: "🖤",
          adj: { brightness: 104, contrast: 132, saturation: 0, sharpness: 2.0, hue: 0 },
          isDefault: true,
        },
      ];

      function caLoadPresets() {
        try {
          const raw = localStorage.getItem(CA_PRESET_KEY);
          if (!raw) return DEFAULT_COLOR_FILTERS;
          const saved = JSON.parse(raw);
          if (saved && Array.isArray(saved) && saved.length > 0) {
            const custom = saved.filter(p => !p.isDefault);
            return [...DEFAULT_COLOR_FILTERS, ...custom];
          }
          return DEFAULT_COLOR_FILTERS;
        } catch {
          return DEFAULT_COLOR_FILTERS;
        }
      }

      `;

  html = html.substring(0, startIdx) + replacement + html.substring(endIdx);
  fs.writeFileSync(indexHtmlPath, html, 'utf8');
  console.log("Successfully replaced caLoadPresets with 5 default color filters!");
} else {
  console.log("Markers not found");
}
