// "Fresh" versions of Tailwind's colour families, so the icon and text
// colours used across the app sit well on the sky-blue theme.
//
// Each family keeps Tailwind's lightness ladder (so text-*-400 stays as
// readable as before) but gets a new hue (and, for the loudest families, a
// little less chroma), worked out in OKLCH. Red is left alone so errors
// still look like errors.
const twColors = require('tailwindcss/colors');

// family: [target hue in OKLCH degrees, chroma multiplier]
const FRESH = {
  emerald: [165, 1.0], // mint
  green: [155, 0.95],
  teal: [182, 1.0],
  cyan: [208, 1.0],    // aqua
  sky: [228, 1.0],     // sky
  blue: [245, 0.95],
  indigo: [255, 0.95], // the old brand colour: now a blue next to the accent
  violet: [285, 0.85], // lavender
  purple: [300, 0.85],
  fuchsia: [330, 0.85],
  pink: [8, 0.9],      // coral pink
  rose: [18, 0.95],    // coral
  orange: [50, 0.95],  // peach
  amber: [72, 0.95],   // apricot / sun
  yellow: [95, 0.9],
};

// ── sRGB <-> OKLCH ──────────────────────────────────────────────────────────
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function hexToOklch(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B)];
}

function oklchToLinearRgb(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function oklchToHex(L, C, h) {
  // Lower the chroma until the colour fits in sRGB.
  let rgb = oklchToLinearRgb(L, C, h);
  for (let c = C; rgb.some((v) => v < -1e-4 || v > 1 + 1e-4) && c > 0; c -= 0.002) {
    rgb = oklchToLinearRgb(L, c, h);
  }
  return '#' + rgb
    .map((v) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, '0'))
    .join('');
}

const freshColors = {};
for (const [family, [hue, chromaScale]] of Object.entries(FRESH)) {
  freshColors[family] = {};
  for (const [shade, hex] of Object.entries(twColors[family])) {
    const [L, C] = hexToOklch(hex);
    freshColors[family][shade] = oklchToHex(L, C * chromaScale, hue);
  }
}

// Light theme: the pale 200-400 text shades are made for dark panels and
// wash out on white, so swap them for the deeper shades of the same colour.
const LIGHT_TEXT_SHADE = { 200: 700, 300: 700, 400: 600 };
const lightThemeText = ({ addBase }) => {
  const rules = {};
  const families = [...Object.keys(FRESH), 'red', 'slate'];
  for (const family of families) {
    const scale = freshColors[family] || twColors[family];
    for (const [from, to] of Object.entries(LIGHT_TEXT_SHADE)) {
      const name = `text-${family}-${from}`;
      rules[`:root.light-theme .${name}, :root.light-theme .hover\\:${name}:hover`] = { color: scale[to] };
    }
  }
  addBase(rules);
};

module.exports = { colors: freshColors, lightThemeText };
