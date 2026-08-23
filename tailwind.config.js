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
    extend: {}
  },
  plugins: []
};
