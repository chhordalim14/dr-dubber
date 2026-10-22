// Text motion in the exported video (backend/render_service.js), as the editor previews it: the
// editor's motion names (scroll-left, scroll-right, scroll-up, scroll-down, bounce-x) at the
// preview's speed - speed x 2.1 % of the frame a second. Before, the export only knew
// scroll_left / scroll_right, so moving text stood still in the video.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rs = require('../backend/render_service');

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

describe('free text motion: one pass after another, as the preview moves it', () => {
  test('no motion (or an unknown one): no passes - the text stands where it was put', () => {
    assert.equal(rs._textMotionSegments('none', 50, 2, 60), null);
    assert.equal(rs._textMotionSegments('spin', 50, 2, 60), null);
  });

  test('scroll-left from the middle: to -20 %, then from 110 % again, at speed x 2.1 % a second', () => {
    const segs = rs._textMotionSegments('scroll-left', 50, 2, 120); // 4.2 % a second
    near(segs[0].p0, 50, 'starts where it was put');
    near(segs[0].p1, -20, 'leaves on the left');
    near(segs[0].t1, 70 / 4.2, 'takes 70 % / 4.2 % a second');
    near(segs[1].p0, 110, 'comes back in from the right');
    near(segs[1].p1, -20, 'the whole way across');
    near(segs[1].t0, segs[0].t1, 'right after the first pass');
    near(segs[segs.length - 1].t1, 120, 'until the video ends');
  });

  test('the old name scroll_right works the same as scroll-right', () => {
    assert.deepEqual(rs._textMotionSegments('scroll_right', 0, 3, 30), rs._textMotionSegments('scroll-right', 0, 3, 30));
  });

  test('bounce-x goes right to 90 %, back to 10 %, and right again', () => {
    const segs = rs._textMotionSegments('bounce-x', 50, 2, 100);
    assert.deepEqual(segs.slice(0, 3).map((s) => Math.round(s.p1)), [90, 10, 90]);
  });

  test('a long video stays a bounded number of lines', () => {
    assert.ok(rs._textMotionSegments('bounce-x', 50, 10, 10 * 3600).length <= 5000);
  });

  test('the ASS file has one \\move line per pass, scroll-up moving only y', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-test-'));
    try {
      const ass = fs.readFileSync(rs._buildFreeTextAssFile([{ text: 'SALE', x: 50, y: 50, motion: 'scroll-up', speed: 2 }], 1000, 1000, 60, dir), 'utf8');
      const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
      assert.ok(lines.length >= 2, 'more than one pass in a minute');
      assert.match(lines[0], /^Dialogue: 1,0:00:00\.00,[^,]+,FT_\w+,,0,0,0,,\{\\an5\\move\(500,500,500,-100\)/);
      assert.match(lines[1], /\\move\(500,1100,500,-100\)/);
      const still = fs.readFileSync(rs._buildFreeTextAssFile([{ text: 'LOGO', x: 10, y: 20 }], 1000, 1000, 60, dir), 'utf8');
      assert.match(still, /\\an5\\pos\(100,200\)/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('free text: what the editor shows is what is exported', () => {
  const base = { b: false, i: false, u: false, c: '&HFFFFFF&' };
  const R = String.raw;
  const has = (line, part) => assert.ok(line.includes(part), `${line}\n  should have ${part}`);

  test('rich text: bold, italic, underline, colours and line breaks become ASS, not literal HTML', () => {
    assert.equal(rs._richTextToAss('Hello <b>big</b> &amp; <span style="color: rgb(255, 0, 0);">red</span><div>line <i>two</i></div><div><br></div>', base),
      R`Hello {\b1}big{\b0} & {\c&H0000FF&}red{\c&HFFFFFF&}\Nline {\i1}two{\i0}`);
    assert.equal(rs._richTextToAss('<u>x</u><br>y&nbsp;z <font color="#00ff00">g</font>', base), R`{\u1}x{\u0}\Ny\hz {\c&H00FF00&}g{\c&HFFFFFF&}`);
    assert.equal(rs._richTextToAss('a {b} c', base), R`a \{b\} c`, 'braces cannot start ASS tags');
    assert.equal(rs._richTextToAss('plain', { ...base, b: true }), 'plain');
  });

  const lines = (t, duration = 10) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-test-'));
    try {
      const ass = fs.readFileSync(rs._buildFreeTextAssFile([{ text: 'SALE', x: 50, y: 50, fontSize: 40, opacity: 100, ...t }], 1000, 1000, duration, dir), 'utf8');
      return ass.split('\n').filter((l) => l.startsWith('Style: FT_') || l.startsWith('Dialogue:'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const dialogue = (t, duration) => lines(t, duration).filter((x) => x.startsWith('Dialogue'));

  test('underline goes into the style', () => {
    assert.match(lines({ underline: true })[0], /^Style: FT_\w+,[^,]+,40,[^,]+,[^,]+,[^,]+,[^,]+,0,0,-1,0,/);
  });

  test('a still text with no idle style is one line for the whole video', () => {
    const l = dialogue({});
    assert.equal(l.length, 1);
    assert.ok(l[0].endsWith(R`\pos(500,500)\alpha&H00&}SALE`), l[0]);
  });

  test('pulse: the opacity goes 1 -> 0.45 -> 1 every 2 s (strength 5)', () => {
    const l = dialogue({ idleStyle: 'pulse' });
    assert.ok(l[0].startsWith('Dialogue: 1,0:00:00.00,0:00:01.00,'), l[0]);
    has(l[0], R`\alpha&H00&\t(\alpha&H8C&)`);
    assert.ok(l[1].startsWith('Dialogue: 1,0:00:01.00,0:00:02.00,'), l[1]);
    has(l[1], R`\alpha&H8C&\t(\alpha&H00&)`);
    assert.equal(l.length, 10);
  });

  test('strength 10 runs the cycle twice as fast', () => {
    assert.equal(dialogue({ idleStyle: 'pulse', idleStrength: 10 }).length, 20);
  });

  test('shake moves left and right by the keyframes, in video pixels', () => {
    const l = dialogue({ idleStyle: 'shake' });
    has(l[0], R`\move(500,500,482,500)`);
    has(l[1], R`\move(482,500,518,500)`);
  });

  test('wobble turns (clockwise in CSS is a negative \\frz) and float rises 24 px', () => {
    has(dialogue({ idleStyle: 'wobble' })[0], R`\frz0\t(\frz12)`);
    has(dialogue({ idleStyle: 'float' })[0], R`\move(500,500,500,476)`);
  });

  test('glow: a blurred halo in the outline colour under the text, fading in', () => {
    const l = dialogue({ idleStyle: 'glow', strokeColor: '#ff0000', strokeWidth: 2 });
    assert.ok(l[0].startsWith('Dialogue: 0,'), l[0]);
    assert.ok(l[0].endsWith(R`\1a&HFF&\shad0\3c&H0000FF&\bord6\blur8\3a&HFF&\t(\3a&H26&)}SALE`), l[0]);
    assert.ok(l[1].startsWith('Dialogue: 1,'), l[1]);
  });

  test('motion and an idle style play together', () => {
    // The first 1.25 s: 4.2 % a second to the left (1000 px frame) while rising 24 px.
    has(dialogue({ idleStyle: 'float', motion: 'scroll-left', speed: 2 })[0], R`\move(500,500,448,476)`);
  });
});
