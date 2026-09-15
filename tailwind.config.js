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
      colors: {
        'studio-bg': '#090a10',
        'studio-surface': '#11121c',
        'studio-card': '#171826',
        'studio-hover': '#1f2133',
        'studio-border': 'rgba(255, 255, 255, 0.08)',
        'studio-border-light': 'rgba(255, 255, 255, 0.14)',
        'studio-accent': '#6366f1',
        'studio-accent-hover': '#818cf8'
      },
      boxShadow: {
        'studio-card': '0 4px 20px -2px rgba(0, 0, 0, 0.5)',
        'studio-glow': '0 0 25px -5px rgba(99, 102, 241, 0.25)',
        'studio-modal': '0 20px 50px -10px rgba(0, 0, 0, 0.7)'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        khmer: ['"Kantumruy Pro"', '"Khmer OS Battambang"', 'sans-serif']
      }
    }
  },
  plugins: []
};
