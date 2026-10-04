// Subtitle layout shared by the editor preview and the exported video.
//
// The preview (studio-main.js updateSubtitleDisplay) draws subtitles with HTML,
// the export burns them in with libass. Before this module each side decided on
// its own where a long line breaks, so a Khmer line that the preview showed on two
// lines came out of the export as one line running off both edges of the frame
// (Khmer has no spaces, and libass only breaks at spaces). Both sides now call the
// same pure functions here, so the line breaks, the 2-lines-per-screen chunks and
// the time each chunk is shown are identical.
//
// Units: everything is in VIDEO pixels (the video's own resolution). The preview
// multiplies by its on-screen scale afterwards; the export uses them directly as
// ASS coordinates (PlayResX/PlayResY = video size).
//
// Loaded by the browser as a classic script (exposes window.SubtitleLayout)
// and by Node via require() (backend/render_service.js, tests).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SubtitleLayout = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Same default as the size slider in the editor (localStorage aiDubberSubtitleSize).
  const DEFAULT_SIZE = 106;
  // The size slider is calibrated for a 1080 px short side; bigger/smaller videos scale.
  const REFERENCE_SHORT_SIDE = 1080;
  // The preview keeps 4% of the width free on each side.
  const SIDE_MARGIN_RATIO = 0.04;
  // The preview's CSS font-size is 95% of the scaled size (its line box uses
  // line-height 1.2). The export converts this CSS size to an ASS size with the
  // font's own metrics, so the letters come out the same height.
  const CSS_FONT_RATIO = 0.95;
  const CSS_LINE_HEIGHT = 1.2;
  // Outline and shadow widths are set in screen pixels in the preview (they do not
  // grow with the video). The preview shows the video's short side at roughly 360
  // screen pixels, so that is the scale used to turn them into video pixels.
  const PREVIEW_SHORT_SIDE = 360;
  const MAX_LINES_PER_CHUNK = 2;
  const DEFAULTS = {
    color: '#ffffff',
    font: 'Kantumruy Pro',
    outlineColor: '#000000',
    outlineWidth: 1.5,
    shadowColor: '#000000',
    shadowDepth: 1.5,
    marginPercent: 8,
  };

  // Lines are broken a few percent before the usable width. The width below is an
  // estimate (another font, bold, the outline), and the export tells libass never to
  // wrap, so a line that came out a little too wide would be cut off at the frame edge.
  const WRAP_SLACK = 0.96;

  // Everything that belongs to the letter before it: Khmer vowel signs (also the
  // ones that take space, like ា or ោ), diacritics, the coeng (U+17D2, which stacks
  // the NEXT consonant under the previous one) and the joiners. Also the Khmer full
  // stops and the repeat sign (។ ៕ ៖ ៗ), which end the word before them. A line must
  // never start with one of these.
  const NO_BREAK_BEFORE_RE = /[឴-ៗ៝‌‍]/;
  const COENG = '្';
  const WIDE_RE = /[　-鿿가-힯＀-￯]/;
  const isBreakSpace = (ch) => ch === ' ' || ch === '​';

  // Width of each Khmer code point (U+1780-U+17DD) in em, measured from what libass
  // and Chromium actually draw with Kantumruy Pro Bold (the wider weight, so a bold
  // preview still fits). Rendered, not just the font's advance table: libass/Chrome
  // split ើ ឿ ៀ ោ ៅ into a part before and a part after the consonant, so those take
  // the width of both parts, while the advance table lists some of them as 0.
  // Default for a consonant / independent vowel is 0.65 em.
  const KHMER_EM = (() => {
    const t = new Array(0x5e).fill(0.65);
    const set = (from, to, w) => { for (let c = from; c <= to; c++) t[c - 0x1780] = w; };
    // Wide consonants: ឃ ញ ឍ យ ល ស ហ, and the extra-wide ឈ ណ; the narrow រ វ.
    for (const c of [0x1783, 0x1789, 0x178D, 0x1799, 0x179B, 0x179F, 0x17A0]) set(c, c, 0.95);
    set(0x1788, 0x1788, 1.25); set(0x178E, 0x178E, 1.25);
    set(0x179A, 0x179A, 0.36); set(0x179C, 0x179C, 0.36);
    set(0x17A1, 0x17A1, 0.88); set(0x17A6, 0x17A6, 0.95);
    set(0x17B4, 0x17B5, 0); // inherent vowels: invisible
    set(0x17B6, 0x17B6, 0.34); // ា
    set(0x17B7, 0x17BD, 0); // ិ ី ឹ ឺ ុ ូ ួ: drawn above/below, no width
    set(0x17BE, 0x17BE, 0.35); // ើ = េ before + a mark above
    set(0x17BF, 0x17C0, 0.68); // ឿ ៀ = េ before + a part after
    set(0x17C1, 0x17C3, 0.35); // េ ែ ៃ
    set(0x17C4, 0x17C5, 0.68); // ោ ៅ = េ before + ា after
    set(0x17C6, 0x17C6, 0); // ំ
    set(0x17C7, 0x17C7, 0.37); // ះ
    set(0x17C8, 0x17C8, 0.26); // ៈ
    set(0x17C9, 0x17D3, 0); // diacritics and the coeng itself
    set(0x17D4, 0x17D4, 0.62); // ។
    set(0x17D5, 0x17D5, 0.80); // ៕
    set(0x17D6, 0x17D6, 0.40); // ៖
    set(0x17D7, 0x17D7, 0.60); // ៗ
    set(0x17D8, 0x17D8, 2.17);
    set(0x17D9, 0x17D9, 0.56);
    set(0x17DA, 0x17DA, 1.18);
    set(0x17DB, 0x17DB, 0.39);
    set(0x17DC, 0x17DC, 0.57);
    set(0x17DD, 0x17DD, 0);
    return t;
  })();
  // After a coeng most consonants are drawn under the previous one (no width), but
  // these are drawn beside it: ្រ before it, ្យ ្ស ្ប ្ឃ ្ឈ after it.
  const SPACING_SUBSCRIPTS = new Set(['រ', 'យ', 'ស', 'ប', 'ឃ', 'ឈ']);
  const SPACING_SUBSCRIPT_EM = 0.33;

  const toNumber = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const firstPositive = (...values) => {
    for (const v of values) {
      const n = toNumber(v);
      if (n !== null && n > 0) return n;
    }
    return null;
  };
  const firstDefined = (...values) => {
    for (const v of values) {
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
  const isTrue = (v) => v === true || v === 'true' || v === 1 || v === '1';

  // Subtitle text as it is shown: no tags, one paragraph (the layout decides the breaks).
  function cleanText(text) {
    return String(text == null ? '' : text)
      .replace(/<[^>]+>/g, '')
      .replace(/\\N/g, ' ')
      .replace(/\r?\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // The size the user picked, scaled to this video (still before the 95% CSS ratio).
  function scaledFontSize(baseSize, videoWidth, videoHeight) {
    const base = firstPositive(baseSize) || DEFAULT_SIZE;
    const w = firstPositive(videoWidth) || 1080;
    const h = firstPositive(videoHeight) || 1920;
    return Math.round(base * (Math.min(w, h) / REFERENCE_SHORT_SIDE));
  }

  // Width of one character in em. prev is the character before it (a consonant
  // after a coeng is a subscript and usually takes no width of its own).
  function charEm(ch, prev) {
    const c = ch.charCodeAt(0);
    if (c >= 0x1780 && c <= 0x17DD) {
      if (prev === COENG) return SPACING_SUBSCRIPTS.has(ch) ? SPACING_SUBSCRIPT_EM : 0;
      return KHMER_EM[c - 0x1780];
    }
    if (c >= 0x17E0 && c <= 0x17F9) return 0.62; // Khmer digits and signs
    if (c === 0x200B || c === 0x200C || c === 0x200D) return 0;
    if (c === 0x20) return 0.32;
    if (WIDE_RE.test(ch)) return 1.05; // CJK comes from a fallback font, full width
    if (c >= 0x41 && c <= 0x5A) return 0.7; // A-Z
    if (c >= 0x61 && c <= 0x7A) return 0.58; // a-z
    if (c >= 0x30 && c <= 0x39) return 0.62; // 0-9
    if (c < 0x80) return 0.4; // ASCII punctuation
    return 0.65;
  }

  // Width of one character in video pixels for a subtitle of this (scaled) size.
  // The text is drawn at CSS_FONT_RATIO of the size (the preview's CSS font-size,
  // which the export reproduces), so that is the em.
  function charWidth(ch, fontSize, prev) {
    return charEm(ch, prev) * fontSize * CSS_FONT_RATIO;
  }

  // Estimated drawn width of a whole line in video pixels.
  function textWidth(text, fontSize) {
    const s = String(text || '');
    let w = 0;
    for (let k = 0; k < s.length; k++) w += charWidth(s[k], fontSize, k > 0 ? s[k - 1] : '');
    return w;
  }

  // Is it safe to start a new line at text[i]? Not on (or, when breaking at a space,
  // right before) a vowel sign, diacritic or Khmer full stop, and not right after a
  // coeng (that would tear a stacked consonant off its base).
  function canBreakBefore(text, i) {
    if (i <= 0 || i >= text.length) return false;
    if (text[i - 1] === COENG) return false;
    let j = i;
    while (j < text.length && isBreakSpace(text[j])) j++;
    if (j < text.length && NO_BREAK_BEFORE_RE.test(text[j])) return false;
    return true;
  }

  // Greedy wrap into lines no wider than usableWidth (less WRAP_SLACK). Prefers the
  // last space when it is close to the end of the line; otherwise breaks between
  // Khmer clusters.
  function wrapText(text, fontSize, usableWidth) {
    const clean = cleanText(text);
    if (!clean) return [];
    const size = firstPositive(fontSize) || DEFAULT_SIZE;
    const maxWidth = (firstPositive(usableWidth) || 1000) * WRAP_SLACK;
    const lines = [];
    let line = '';
    let width = 0;
    let lastSpace = -1;
    let lastSpaceWidth = 0;

    const rescan = () => {
      width = 0;
      lastSpace = -1;
      lastSpaceWidth = 0;
      for (let k = 0; k < line.length; k++) {
        if (isBreakSpace(line[k])) {
          lastSpace = k;
          lastSpaceWidth = width;
        }
        width += charWidth(line[k], size, k > 0 ? line[k - 1] : '');
      }
    };

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (isBreakSpace(ch)) {
        lastSpace = line.length;
        lastSpaceWidth = width;
      }
      const prev = line.length > 0 ? line[line.length - 1] : '';
      line += ch;
      width += charWidth(ch, size, prev);
      // A space that overflows is trimmed off the line anyway. Decide at the next
      // character instead, which may be a ។ that must not start the next line.
      if (width < maxWidth || isBreakSpace(ch)) continue;

      // Line is full. Break at the last space when little text would move down with
      // it (and the next line would not start with a ។ or a vowel sign); otherwise
      // break at the last point between two Khmer clusters.
      if (lastSpace > 0 && width - lastSpaceWidth < maxWidth * 0.4 && canBreakBefore(line, lastSpace + 1)) {
        const head = line.substring(0, lastSpace).trim();
        if (head) lines.push(head);
        line = line.substring(lastSpace + 1);
      } else {
        let cut = line.length - 1;
        while (cut > 0 && !canBreakBefore(line, cut)) cut--;
        if (cut <= 0) {
          // One unbreakable cluster wider than the line (only with absurd sizes):
          // wait for the next safe point instead of tearing the cluster.
          continue;
        }
        const head = line.substring(0, cut).trim();
        if (head) lines.push(head);
        line = line.substring(cut).replace(/^[ ​]+/, '');
      }
      rescan();
    }
    const tail = line.trim();
    if (tail) lines.push(tail);
    return lines;
  }

  // Groups lines into what is on screen at once (at most 2 lines each).
  function chunkLines(lines, maxLines) {
    const per = Math.max(1, Math.floor(maxLines || MAX_LINES_PER_CHUNK));
    const chunks = [];
    for (let i = 0; i < lines.length; i += per) chunks.push(lines.slice(i, i + per));
    return chunks;
  }

  // Full layout of one subtitle for a video of the given size.
  // sizeMultiplier lets an export style preset enlarge the text (wrap follows).
  function layoutSubtitle(text, opts) {
    const o = opts || {};
    const videoWidth = firstPositive(o.videoWidth) || 1080;
    const videoHeight = firstPositive(o.videoHeight) || 1920;
    const fontSize = Math.round(scaledFontSize(o.baseSize, videoWidth, videoHeight) * (firstPositive(o.sizeMultiplier) || 1));
    const sideMargin = Math.round(videoWidth * SIDE_MARGIN_RATIO);
    const usableWidth = videoWidth - sideMargin * 2;
    const lines = wrapText(text, fontSize, usableWidth);
    return { fontSize, sideMargin, usableWidth, lines, chunks: chunkLines(lines, o.maxLines) };
  }

  // Splits a subtitle's time evenly between its chunks (what the preview swaps live).
  function chunkTimes(start, end, count) {
    const s = toNumber(start) || 0;
    const e = Math.max(s + 0.01, toNumber(end) || 0);
    const n = Math.max(1, count | 0);
    const step = (e - s) / n;
    const out = [];
    for (let i = 0; i < n; i++) out.push({ start: s + step * i, end: i === n - 1 ? e : s + step * (i + 1) });
    return out;
  }

  // Index of the chunk on screen at time t (same rule as the export's time split).
  function chunkIndexAt(start, end, count, t) {
    const n = Math.max(1, count | 0);
    const s = toNumber(start) || 0;
    const total = Math.max(0.01, (toNumber(end) || 0) - s);
    const idx = Math.floor((t - s) / (total / n));
    return Math.min(n - 1, Math.max(0, idx));
  }

  // Normalises the subtitle style a render request carries. The editor sends
  // subtitleSize / subtitleColor; older callers sent subtitleFontSize /
  // subtitleFontColor. The names the editor sends win, then the old names, then the
  // editor's own defaults (so an export with nothing set looks like the preview).
  function resolveStyle(options) {
    const o = options || {};
    const marginRaw = toNumber(o.subtitleMarginV);
    // The editor's margin is a percent of the video height (slider 0-50). Larger
    // numbers can only come from old callers that meant ASS units of libass's
    // default 288-line script, so convert those to a percent.
    let marginPercent = DEFAULTS.marginPercent;
    if (marginRaw !== null && marginRaw >= 0) marginPercent = marginRaw <= 50 ? marginRaw : (marginRaw / 288) * 100;
    const outline = toNumber(o.subtitleOutlineWidth);
    const shadow = toNumber(o.subtitleShadowDepth);
    return {
      // An old-name size is taken as an editor (preview) size, not converted. The old
      // subtitleFontSize meant units of libass's 288-line script (28 = about 187 px
      // tall on a 1920-tall video), so a caller still sending it gets much smaller
      // text than before. No caller sends it today; one that comes back should send
      // subtitleSize instead.
      baseSize: firstPositive(o.subtitleSize, o.subtitleFontSize) || DEFAULT_SIZE,
      color: firstDefined(o.subtitleColor, o.subtitleFontColor) || DEFAULTS.color,
      font: firstDefined(o.subtitleFont) || DEFAULTS.font,
      outlineColor: firstDefined(o.subtitleOutlineColor) || DEFAULTS.outlineColor,
      outlineWidth: outline !== null && outline >= 0 ? outline : DEFAULTS.outlineWidth,
      shadowColor: firstDefined(o.subtitleShadowColor) || DEFAULTS.shadowColor,
      shadowDepth: shadow !== null && shadow >= 0 ? shadow : DEFAULTS.shadowDepth,
      marginPercent: Math.min(90, Math.max(0, marginPercent)),
      bold: isTrue(o.subtitleBold),
      italic: isTrue(o.subtitleItalic),
      underline: isTrue(o.subtitleUnderline),
      preset: firstDefined(o.subtitlePreset) || 'classic',
    };
  }

  // Preview screen pixels (outline/shadow) -> video pixels.
  function previewPxToVideoPx(px, videoWidth, videoHeight) {
    const shortSide = Math.min(firstPositive(videoWidth) || 1080, firstPositive(videoHeight) || 1920);
    return (toNumber(px) || 0) * (shortSide / PREVIEW_SHORT_SIDE);
  }

  return {
    DEFAULT_SIZE,
    SIDE_MARGIN_RATIO,
    CSS_FONT_RATIO,
    CSS_LINE_HEIGHT,
    PREVIEW_SHORT_SIDE,
    MAX_LINES_PER_CHUNK,
    WRAP_SLACK,
    DEFAULTS,
    cleanText,
    scaledFontSize,
    charWidth,
    textWidth,
    canBreakBefore,
    wrapText,
    chunkLines,
    layoutSubtitle,
    chunkTimes,
    chunkIndexAt,
    resolveStyle,
    previewPxToVideoPx,
  };
});
