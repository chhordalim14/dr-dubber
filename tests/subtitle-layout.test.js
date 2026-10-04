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
const COMBINING = /[\u17B4-\u17D3\u17DD\u200C\u200D]/;
const COENG = '\u17D2';

// No line may start with a vowel sign/diacritic/coeng, and no line may end on a
// coeng (that would tear a stacked consonant away from its base).
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
      const width = Array.from(line).reduce((w, ch) => w + SL.charWidth(ch, layout.fontSize), 0);
      assert.ok(width <= layout.usableWidth + layout.fontSize, `line too wide: ${line}`);
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
