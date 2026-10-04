// Tests for frontend/js/subtitle-layout.js (the line wrapping shared by the editor
// preview and the export) and for how the export turns the editor's subtitle
// settings into the burned-in ASS file (backend/render_service.js).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const SL = require('../frontend/js/subtitle-layout.js');
const render = require('../backend/render_service.js');

const LONG_KHMER = 'ខ្ញុំមិនដែលគិតថាអ្នកជាមនុស្សបែបនេះសោះ ហេតុអ្វីបានជាធ្វើបែបនេះដាក់ខ្ញុំ';
// Ordinary dialogue full of vowels that take space (\u17B6 \u17C4 \u17C5 \u17C1 \u17BE \u17C7): the old width
// guess counted these as almost nothing and the burned-in lines ran off the frame.
const VOWEL_HEAVY = [
  '\u1791\u17C5\u178E\u17B6\u17A0\u17BE\u1799\u1794\u17B6\u1793\u1787\u17B6\u1798\u17B7\u1793\u1791\u17C5\u1787\u17B6\u1798\u17BD\u1799\u1782\u17C1\u1793\u17C4\u17C7\u1791\u17C1 \u1796\u17C1\u179B\u1793\u17C1\u17C7\u1782\u17C1\u1780\u17C6\u1796\u17BB\u1784\u179A\u1784\u1785\u17B6\u17C6\u1793\u17C5\u1791\u17B8\u1793\u17C4\u17C7\u17A0\u17BE\u1799',
  '\u1796\u17C1\u179B\u1793\u17C4\u17C7\u1782\u17C1\u1791\u17C5\u179A\u1780\u17AA\u1796\u17BB\u1780\u1798\u17D2\u178A\u17B6\u1799\u17A0\u17BE\u1799\u1793\u17B7\u1799\u17B6\u1799\u1790\u17B6\u1780\u17BC\u1793\u1798\u17B7\u1793\u1785\u1784\u17CB\u1791\u17C5\u1791\u17C0\u178F\u1791\u17C1',
  '\u178F\u17BE\u179B\u17C4\u1780\u17AF\u1784\u1785\u1784\u17CB\u17B2\u17D2\u1799\u1781\u17D2\u1789\u17BB\u17C6\u1792\u17D2\u179C\u17BE\u1799\u17C9\u17B6\u1784\u1798\u17C9\u17C1\u1785\u1791\u17C0\u178F\u1791\u17C5? \u1781\u17D2\u1789\u17BB\u17C6\u1782\u17D2\u1798\u17B6\u1793\u1795\u17D2\u179B\u17BC\u179C\u178E\u17B6\u1791\u17C0\u178F\u17A0\u17BE\u1799\u17D4',
];
// Everything that must stay with the letter before it, including \u17D4 \u17D5 \u17D6 \u17D7.
const COMBINING = /[\u17B4-\u17D7\u17DD\u200C\u200D]/;
const COENG = '\u17D2';

// No line may start with a vowel sign/diacritic/coeng/Khmer full stop, and no line
// may end on a coeng (that would tear a stacked consonant away from its base).
function assertClustersIntact(lines, label) {
  lines.forEach((line, i) => {
    assert.ok(!COMBINING.test(line[0]), `${label}: line ${i} starts with a combining mark: ${line}`);
    assert.notEqual(line[line.length - 1], COENG, `${label}: line ${i} ends with a coeng: ${line}`);
  });
}

describe('wrapText / layoutSubtitle', () => {
  test('a long Khmer line on a 1080x1920 video wraps and loses no text', () => {
    const layout = SL.layoutSubtitle(LONG_KHMER, { baseSize: 106, videoWidth: 1080, videoHeight: 1920 });
    assert.ok(layout.lines.length >= 2, 'long line must wrap');
    assert.equal(layout.lines.join('').replace(/ /g, ''), LONG_KHMER.replace(/ /g, ''));
    assertClustersIntact(layout.lines, 'size 106');
    for (const line of layout.lines) {
      assert.ok(SL.textWidth(line, layout.fontSize) <= layout.usableWidth, `line too wide: ${line}`);
    }
  });

  test('vowels that take space count as real width', () => {
    // ោ is drawn before and after its consonant: about as wide as the consonant.
    assert.ok(SL.textWidth('កោ', 100) > SL.textWidth('ក', 100) * 1.9);
    assert.ok(SL.textWidth('កា', 100) > SL.textWidth('ក', 100) * 1.4);
    // Marks drawn above/below and plain subscripts take no width.
    assert.equal(SL.textWidth('កិុំ', 100), SL.textWidth('ក', 100));
    assert.equal(SL.textWidth('ក្ក', 100), SL.textWidth('ក', 100));
    // ្រ is drawn beside the consonant.
    assert.ok(SL.textWidth('ក្រ', 100) > SL.textWidth('ក', 100) * 1.4);
    for (const text of VOWEL_HEAVY) {
      const layout = SL.layoutSubtitle(text, { baseSize: 106, videoWidth: 1080, videoHeight: 1920 });
      assert.ok(layout.lines.length >= 2, `should wrap: ${text}`);
      assertClustersIntact(layout.lines, text);
      for (const line of layout.lines) assert.ok(SL.textWidth(line, layout.fontSize) <= layout.usableWidth, `line too wide: ${line}`);
    }
  });

  test('never breaks inside a Khmer cluster, whatever the size', () => {
    // Text full of stacked consonants and vowel signs, wrapped at many sizes so
    // the break point lands on every kind of character.
    const text = 'ស្ត្រីក្មេងស្រស់ស្អាតធ្វើការនៅក្រសួងស្រុកខ្មែរ្យ៍ព្រះរាជាណាចក្រកម្ពុជា'.repeat(3);
    for (let size = 20; size <= 150; size += 3) {
      const layout = SL.layoutSubtitle(text, { baseSize: size, videoWidth: 1080, videoHeight: 1920 });
      assertClustersIntact(layout.lines, `size ${size}`);
      assert.equal(layout.lines.join(''), text, `size ${size}: text changed`);
    }
  });

  test('canBreakBefore protects coeng + consonant and vowel signs', () => {
    const word = 'ខ្ញុំ'; // ខ ្ ញ ុ ំ
    assert.equal(SL.canBreakBefore(word, 1), false, 'before the coeng');
    assert.equal(SL.canBreakBefore(word, 2), false, 'between coeng and the stacked consonant');
    assert.equal(SL.canBreakBefore(word, 3), false, 'before a vowel sign');
    assert.equal(SL.canBreakBefore(word, 4), false, 'before a diacritic');
    assert.equal(SL.canBreakBefore('កខ', 1), true, 'between two plain consonants');
    assert.equal(SL.canBreakBefore('កោ', 1), false, 'before a vowel that takes space');
    assert.equal(SL.canBreakBefore('ក។', 1), false, 'before the Khmer full stop');
    assert.equal(SL.canBreakBefore('ក៕', 1), false, 'before the Khmer end-of-text mark');
    assert.equal(SL.canBreakBefore('ក ។', 1), false, 'at a space that is followed by a full stop');
  });

  test('a line never starts with a lone ។', () => {
    const text = 'ខ្ញុំមិនដឹងទេ ។ '.repeat(12).trim();
    for (let size = 40; size <= 150; size += 2) {
      const layout = SL.layoutSubtitle(text, { baseSize: size, videoWidth: 1080, videoHeight: 1920 });
      layout.lines.forEach((line) => assert.notEqual(line[0], '។', `size ${size}: ${line}`));
    }
  });

  test('at most 2 lines per chunk, and the chunks share the time evenly', () => {
    const layout = SL.layoutSubtitle(LONG_KHMER + ' ' + LONG_KHMER, { baseSize: 106, videoWidth: 1080, videoHeight: 1920 });
    assert.ok(layout.chunks.length >= 2);
    for (const chunk of layout.chunks) assert.ok(chunk.length >= 1 && chunk.length <= 2);
    assert.deepEqual(layout.chunks.flat(), layout.lines);
    const times = SL.chunkTimes(10, 16, layout.chunks.length);
    assert.equal(times[0].start, 10);
    assert.equal(times[times.length - 1].end, 16);
    for (let i = 1; i < times.length; i++) assert.equal(times[i].start, times[i - 1].end);
    // The preview shows the chunk the export shows at the same moment.
    times.forEach((t, i) => assert.equal(SL.chunkIndexAt(10, 16, times.length, (t.start + t.end) / 2), i));
  });

  test('short lines are left untouched', () => {
    for (const text of ['សួស្តី', 'អរគុណ បងប្រុស', 'Hello there']) {
      const layout = SL.layoutSubtitle(text, { baseSize: 106, videoWidth: 1080, videoHeight: 1920 });
      assert.deepEqual(layout.lines, [text]);
      assert.deepEqual(layout.chunks, [[text]]);
    }
    assert.deepEqual(SL.layoutSubtitle('   ', { baseSize: 106 }).lines, []);
  });

  test('tags and old line breaks are cleaned the way the preview cleans them', () => {
    assert.equal(SL.cleanText('<font face="Kantumruy Pro">ក\\Nខ\nគ</font>'), 'ក ខ គ');
  });

  test('size scales with the short side of the video, like the preview', () => {
    assert.equal(SL.scaledFontSize(106, 1080, 1920), 106);
    assert.equal(SL.scaledFontSize(106, 720, 1280), 71);
    assert.equal(SL.scaledFontSize(106, 1920, 1080), 106);
  });
});

describe('resolveStyle (what the export uses from the request)', () => {
  test('the size and colour the editor sends win over the old option names', () => {
    const s = SL.resolveStyle({ subtitleSize: 106, subtitleFontSize: 28, subtitleColor: '#ffcc00', subtitleFontColor: '&H00FFFFFF' });
    assert.equal(s.baseSize, 106);
    assert.equal(s.color, '#ffcc00');
  });

  test('old callers that only send the old names still work', () => {
    const s = SL.resolveStyle({ subtitleFontSize: '80', subtitleFontColor: '&H0000FF00' });
    assert.equal(s.baseSize, 80);
    assert.equal(s.color, '&H0000FF00');
  });

  test('nothing sent = the preview defaults', () => {
    const s = SL.resolveStyle({});
    assert.equal(s.baseSize, 106);
    assert.equal(s.color, '#ffffff');
    assert.equal(s.font, 'Kantumruy Pro');
    assert.equal(s.marginPercent, 8);
    assert.equal(s.outlineWidth, 1.5);
    assert.equal(s.shadowDepth, 1.5);
    assert.equal(s.preset, 'classic');
  });

  test('margin is a percent of the height; old ASS-unit margins are converted', () => {
    assert.equal(SL.resolveStyle({ subtitleMarginV: 20 }).marginPercent, 20);
    assert.equal(SL.resolveStyle({ subtitleMarginV: 0 }).marginPercent, 0);
    assert.equal(Math.round(SL.resolveStyle({ subtitleMarginV: 144 }).marginPercent), 50);
    assert.equal(SL.resolveStyle({ subtitleOutlineWidth: 0 }).outlineWidth, 0);
  });
});

describe('buildSubtitleAss (render_service)', () => {
  const cues = [{ start: 0, end: 4, text: LONG_KHMER }];
  const styleLine = (ass) => ass.content.split('\n').find((l) => l.startsWith('Style: Default,'));
  const field = (ass, i) => styleLine(ass).slice('Style: '.length).split(',')[i];

  test('script is in video pixels and lines are pre-broken with \\N', () => {
    const ass = render._buildSubtitleAss(cues, { subtitleSize: 106 }, 1080, 1920);
    assert.match(ass.content, /PlayResX: 1080/);
    assert.match(ass.content, /PlayResY: 1920/);
    assert.match(ass.content, /WrapStyle: 2/);
    const events = ass.content.split('\n').filter((l) => l.startsWith('Dialogue:'));
    const layout = SL.layoutSubtitle(LONG_KHMER, { baseSize: 106, videoWidth: 1080, videoHeight: 1920 });
    assert.equal(events.length, layout.chunks.length);
    assert.ok(events[0].endsWith(layout.chunks[0].join('\\N')));
  });

  test('the size and colour the user picked reach the ASS style', () => {
    const big = render._buildSubtitleAss(cues, { subtitleSize: 106, subtitleColor: '#ffcc00', subtitleFontSize: 28, subtitleFontColor: '&H00FFFFFF' }, 1080, 1920);
    const small = render._buildSubtitleAss(cues, { subtitleSize: 60, subtitleColor: '#ff3399' }, 1080, 1920);
    assert.equal(field(big, 3), '&H0000CCFF');
    assert.equal(field(small, 3), '&H009933FF');
    assert.ok(parseFloat(field(big, 2)) > parseFloat(field(small, 2)) * 1.6);
    // A bigger margin moves the text up.
    const high = render._buildSubtitleAss(cues, { subtitleSize: 60, subtitleMarginV: 20 }, 1080, 1920);
    assert.ok(parseInt(field(high, 21), 10) > parseInt(field(small, 21), 10));
  });

  test('the bundled Kantumruy Pro maps to the file the preview uses', () => {
    // Preview normal weight = the Medium file (family "Kantumruy Pro Medium");
    // bold = the Bold file (family "Kantumruy Pro").
    assert.equal(render._resolveSubtitleFace('Kantumruy Pro', false).fontName, 'Kantumruy Pro Medium');
    const bold = render._resolveSubtitleFace('Kantumruy Pro', true);
    assert.equal(bold.fontName, 'Kantumruy Pro');
    assert.equal(bold.boldFlag, -1);
    const ass = render._buildSubtitleAss(cues, { subtitleSize: 106 }, 1080, 1920);
    assert.equal(field(ass, 1), 'Kantumruy Pro Medium');
    // CSS em of 0.95 * 106 px, converted with the font's Windows height (1488/1000).
    assert.ok(Math.abs(parseFloat(field(ass, 2)) - 106 * 0.95 * 1.488) < 0.2);
  });
});

// Burns the ASS through the same ffmpeg filter the export uses and checks the
// subtitle colour really shows up in the bottom of the frame. Skips without ffmpeg.
const FFMPEG = [
  path.join(__dirname, '..', 'backend', 'bin', 'ffmpeg.exe'),
  'C:\\dr-dubber\\backend\\bin\\ffmpeg.exe',
].find((p) => fs.existsSync(p));

test('burn-in draws the subtitle in the chosen colour', { skip: !FFMPEG && 'ffmpeg not found' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-test-'));
  try {
    const ass = render._buildSubtitleAss([{ start: 0, end: 4, text: LONG_KHMER }], { subtitleSize: 106, subtitleColor: '#ffff00', subtitleShadowDepth: 0 }, 270, 480);
    fs.writeFileSync(path.join(dir, 'a.ass'), ass.content, 'utf8');
    const fontsDir = path.join(__dirname, '..', 'frontend', 'fonts').replace(/\\/g, '/').replace(/:/g, '\\:');
    const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x204060:s=270x480:d=1',
      '-vf', `ass=filename=a.ass:fontsdir='${fontsDir}':shaping=complex`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { cwd: dir, maxBuffer: 10 * 1024 * 1024 });
    let top = 0, bottom = 0;
    for (let i = 0; i < raw.length; i += 3) {
      if (raw[i] > 200 && raw[i + 1] > 200 && raw[i + 2] < 80) {
        if (i / 3 / 270 < 240) top++; else bottom++;
      }
    }
    assert.equal(top, 0, 'nothing drawn in the top half');
    assert.ok(bottom > 500, `expected yellow text near the bottom, got ${bottom} pixels`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The export tells libass never to wrap, so a line the layout thinks fits but that
// is really wider gets cut off at the frame edge. Burns vowel-heavy dialogue at the
// default size, in bold and with the biggest preset, and checks every drawn pixel
// (letters, outline and shadow) stays inside the side margins.
test('burned-in Khmer lines stay inside the side margins', { skip: !FFMPEG && 'ffmpeg not found' }, () => {
  const W = 1080, H = 1920;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-margin-'));
  const fontsDir = path.join(__dirname, '..', 'frontend', 'fonts').replace(/\\/g, '/').replace(/:/g, '\\:');
  const styles = [
    { subtitleSize: 106 },
    { subtitleSize: 106, subtitleBold: true },
    { subtitleSize: 106, subtitlePreset: 'tiktok_pop' },
    { subtitleSize: 130, subtitleBold: true },
  ];
  try {
    for (const style of styles) {
      for (const text of [LONG_KHMER, ...VOWEL_HEAVY]) {
        const ass = render._buildSubtitleAss([{ start: 0, end: 4, text }], { ...style, subtitleColor: '#ffffff' }, W, H);
        // Show every chunk at once (libass stacks them) so one frame checks all lines.
        const content = ass.content.replace(/^Dialogue: 0,[^,]+,[^,]+,/gm, 'Dialogue: 0,0:00:00.00,0:00:01.00,');
        fs.writeFileSync(path.join(dir, 'a.ass'), content, 'utf8');
        const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x808080:s=${W}x${H}:d=1`,
          '-vf', `ass=filename=a.ass:fontsdir='${fontsDir}':shaping=complex`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
          { cwd: dir, maxBuffer: 4 * W * H });
        let minX = W, maxX = -1;
        for (let i = 0; i < raw.length; i++) {
          if (Math.abs(raw[i] - 128) > 40) {
            const x = i % W;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
        const margin = Math.round(W * SL.SIDE_MARGIN_RATIO);
        const label = `${JSON.stringify(style)} "${text}": drawn x=${minX}-${maxX}, margins ${margin}-${W - margin}`;
        assert.ok(maxX > minX, `nothing drawn: ${label}`);
        assert.ok(minX >= margin && maxX <= W - margin, label);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('word boundaries', () => {
  const hasKhmerWords = (() => {
    try { return [...new Intl.Segmenter('km', { granularity: 'word' }).segment('មនុស្សបែបនេះ')].length > 1; } catch (e) { return false; }
  })();

  test('a wrapped Khmer line breaks between words, never inside one', { skip: !hasKhmerWords && 'no Khmer word data in this ICU' }, () => {
    const words = [...new Intl.Segmenter('km', { granularity: 'word' }).segment(LONG_KHMER)].map((s) => s.segment).filter((w) => w.trim());
    for (const size of [100, 120, 150]) {
      const lines = SL.wrapText(LONG_KHMER, size, 1000);
      assert.ok(lines.length >= 2, `wraps at size ${size}`);
      // Every line must be made of whole words (the segmenter's), so joining them back
      // and re-splitting gives the same words.
      for (const line of lines) {
        const lineWords = [...new Intl.Segmenter('km', { granularity: 'word' }).segment(line)].map((s) => s.segment).filter((w) => w.trim());
        for (const w of lineWords) assert.ok(words.includes(w), `"${w}" (size ${size}) is a piece of a word: ${JSON.stringify(lines)}`);
      }
      assert.equal(lines.join('').replace(/\s/g, ''), LONG_KHMER.replace(/\s/g, ''));
    }
  });
});
