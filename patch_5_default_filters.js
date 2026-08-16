const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, 'frontend', 'index.html');
let html = fs.readFileSync(indexHtmlPath, 'utf8');

const targetSection = `// ── COLOR PRESETS ─────────────────────────────────────────────
      const CA_PRESET_KEY = "aiDubber_colorPresets";

      function caLoadPresets() {
        try {
          return JSON.parse(localStorage.getItem(CA_PRESET_KEY)) || [];
        } catch {
          return [];
        }
      }`;

const replacementSection = `// ── COLOR PRESETS (5 BUILT-IN DEFAULTS + USER PRESETS) ───────────
      const CA_PRESET_KEY = "aiDubber_colorPresets";

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
          const saved = JSON.parse(localStorage.getItem(CA_PRESET_KEY));
          if (saved && Array.isArray(saved) && saved.length > 0) {
            // Ensure the 5 defaults are always included at top if not present
            const custom = saved.filter(p => !p.isDefault);
            return [...DEFAULT_COLOR_FILTERS, ...custom];
          }
          return DEFAULT_COLOR_FILTERS;
        } catch {
          return DEFAULT_COLOR_FILTERS;
        }
      }`;

if (html.includes(targetSection)) {
  html = html.replace(targetSection, replacementSection);
  fs.writeFileSync(indexHtmlPath, html, 'utf8');
  console.log("Successfully added 5 default color filters to index.html!");
} else {
  console.log("Warning: targetSection not found in index.html");
}
