const fresh = require('./tailwind.fresh-palette');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./frontend/index.html', './frontend/js/**/*.js', './frontend/app.js'],
  // These classes are built at runtime via string interpolation (e.g. `text-${fallback}-400`),
  // so Tailwind's static scanner can't see them in source. Traced to their concrete call
  // sites in frontend/index.html — the value domains are small and fully enumerable:
  //   - fallback ("blue"/"pink"): gender-tag coloring for TTS voice pickers
  //   - dir ("nw"/"ne"/"se"/"sw"): resize-handle cursor for video/image crop handles
  safelist: [
    'text-blue-400', 'text-pink-400',
    'border-blue-400/30', 'border-pink-400/30',
    'bg-blue-500/5', 'bg-pink-500/5',
    'cursor-nw-resize', 'cursor-ne-resize', 'cursor-se-resize', 'cursor-sw-resize'
  ],
  theme: {
    extend: {
      // Tailwind's colour families retuned to fit the sky-blue theme (see the file).
      colors: {
        ...fresh.colors,
        'studio-bg': '#0e1320',
        'studio-surface': '#151c2c',
        'studio-card': '#182033',
        'studio-hover': '#1f2a3e',
        'studio-border': 'rgba(255, 255, 255, 0.08)',
        'studio-border-light': 'rgba(255, 255, 255, 0.14)',
        'studio-accent': '#3d8ef0',
        'studio-accent-hover': '#6aa8f5'
      },
      boxShadow: {
        'studio-card': '0 4px 20px -2px rgba(0, 0, 0, 0.5)',
        'studio-glow': '0 0 25px -5px rgba(61, 142, 240, 0.25)',
        'studio-modal': '0 20px 50px -10px rgba(0, 0, 0, 0.7)'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        khmer: ['"Kantumruy Pro"', '"Khmer OS Battambang"', 'sans-serif']
      }
    }
  },
  plugins: [fresh.lightThemeText]
};
