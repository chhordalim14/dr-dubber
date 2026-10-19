// Sponsor overlays and promo clips for a dubbed series:
// - evenClipPositions (frontend/js/studio-main.js): where "Repeat evenly" puts one clip in the
//   joined video - every round(episodes / times) episodes and once more at the very end.
// - the overlay time window (backend/render_service.js): an image / video overlay shown only
//   from a start to an end second, through the overlay filter's enable= option.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8').replace(/\r\n/g, '\n');
const from = src.indexOf('    function evenClipPositions(');
const to = src.indexOf('\n    }\n', from);
const evenClipPositions = from > 0 && to > from ? new Function(`${src.slice(from, to + 6)}; return evenClipPositions;`)() : null;

const fromR = src.indexOf('    function repeatClipInserts(');
const toR = src.indexOf('\n    }\n', fromR);
const repeatClipInserts = fromR > 0 && toR > fromR ? new Function(`${src.slice(fromR, toR + 6)}; return repeatClipInserts;`)() : null;

const H = 3600;

describe('Repeat evenly with several ads', () => {
  const A = { path: 'D:\\ads\\a.mp4', name: 'a.mp4' };
  const B = { path: 'D:\\ads\\b.mp4', name: 'b.mp4' };
  const C = { path: 'D:\\ads\\c.mp4', name: 'c.mp4' };
  const brief = (list) => list.map((c) => `${c.pos}:${c.name[0]}`).join(' ');

  test('the function is found in studio-main.js', () => {
    assert.equal(typeof repeatClipInserts, 'function');
  });

  test('one per break, in turn: a, b, a, b at the 4 breaks', () => {
    assert.equal(brief(repeatClipInserts([5, 10, 15, 20], [A, B])), '5:a 10:b 15:a 20:b');
    assert.equal(brief(repeatClipInserts([5, 10, 15, 20], [A, B], 'turns')), '5:a 10:b 15:a 20:b');
  });

  test('more ads than breaks: the first ones play', () => {
    assert.equal(brief(repeatClipInserts([5, 10], [A, B, C])), '5:a 10:b');
  });

  test('all at every break: every ad, in order, at each break', () => {
    assert.equal(brief(repeatClipInserts([5, 10, 15], [A, B], 'all')), '5:a 5:b 10:a 10:b 15:a 15:b');
  });

  test('one ad: it plays at every break either way; no ads: nothing', () => {
    assert.equal(brief(repeatClipInserts([6, 12, 18], [C])), '6:c 12:c 18:c');
    assert.equal(brief(repeatClipInserts([6, 12, 18], [C], 'all')), '6:c 12:c 18:c');
    assert.deepEqual(repeatClipInserts([6, 12], []), []);
  });

  test('the inserts carry the path the join uses', () => {
    assert.deepEqual(repeatClipInserts([5], [A])[0], { pos: 5, path: 'D:\\ads\\a.mp4', name: 'a.mp4' });
  });
});

describe('Repeat evenly: where the clip goes', () => {
  test('the function is found in studio-main.js', () => {
    assert.equal(typeof evenClipPositions, 'function');
  });

  test('15 episodes, 3 times: after EP5, EP10 and EP15 (the end)', () => {
    assert.deepEqual(evenClipPositions(15, 1 * H, 3), [5, 10, 15]);
  });

  test('20 episodes, 4 times: after EP5, EP10, EP15 and EP20', () => {
    assert.deepEqual(evenClipPositions(20, 2 * H, 4), [5, 10, 15, 20]);
  });

  test('30 episodes, 5 times: after EP6, EP12, EP18, EP24 and EP30', () => {
    assert.deepEqual(evenClipPositions(30, 4 * H, 5), [6, 12, 18, 24, 30]);
  });

  test('auto: 3 times under 1h30, 4 under 3h, 5 for longer', () => {
    assert.deepEqual(evenClipPositions(15, 80 * 60), [5, 10, 15]);
    assert.deepEqual(evenClipPositions(20, 2.5 * H), [5, 10, 15, 20]);
    assert.deepEqual(evenClipPositions(30, 5 * H), [6, 12, 18, 24, 30]);
    assert.deepEqual(evenClipPositions(30, 5 * H, 'auto'), [6, 12, 18, 24, 30]);
  });

  test('an uneven count still puts it in as many times as asked, the last at the very end', () => {
    assert.deepEqual(evenClipPositions(17, 2 * H, 4), [4, 8, 12, 17]);
    assert.deepEqual(evenClipPositions(22, 5 * H), [4, 8, 12, 16, 22]);
  });

  test('never more times than there are episodes (a series of merged parts)', () => {
    assert.deepEqual(evenClipPositions(2, 3 * H), [1, 2]);
    assert.deepEqual(evenClipPositions(1, 3 * H), [1]);
    assert.deepEqual(evenClipPositions(0, 3 * H), []);
  });
});

const rs = require('../backend/render_service');

describe('overlay shown for a while', () => {
  test('no times: the whole video, no enable option', () => {
    assert.equal(rs._overlayEnableOption(rs._overlayTimeWindow({})), '');
    assert.equal(rs._overlayEnableOption(rs._overlayTimeWindow({ start: null, end: null })), '');
    assert.equal(rs._overlayEnableOption(rs._overlayTimeWindow({ start: 0 })), '');
  });

  test('a start and an end: between them', () => {
    assert.deepEqual(rs._overlayTimeWindow({ start: 5, end: 20.5 }), { start: 5, end: 20.5 });
    assert.equal(rs._overlayEnableOption(rs._overlayTimeWindow({ start: 5, end: 20.5 })), ":enable='between(t,5.000,20.500)'");
  });

  test('only a start: from it to the end; only an end: from the start to it', () => {
    assert.equal(rs._overlayEnableOption(rs._overlayTimeWindow({ start: '90' })), ":enable='gte(t,90.000)'");
    assert.equal(rs._overlayEnableOption(rs._overlayTimeWindow({ end: 15 })), ":enable='between(t,0.000,15.000)'");
  });

  test('an end not after the start, or text that is not a number, is dropped (never reaches the filter)', () => {
    assert.deepEqual(rs._overlayTimeWindow({ start: 30, end: 10 }), { start: 30, end: null });
    assert.deepEqual(rs._overlayTimeWindow({ start: "1);drawtext=x", end: 'x' }), { start: 1, end: null });
    assert.deepEqual(rs._overlayTimeWindow({ start: -4 }), { start: 0, end: null });
  });

  test('the image and video overlay filters use it; a late video starts playing at its start', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'backend', 'render_service.js'), 'utf8');
    assert.match(service, /overlay=x='\$\{xExpr\}':y='\$\{yExpr\}'\$\{evalParam\}:eof_action=repeat\$\{overlayEnableOption\(overlayTimeWindow\(ov\)\)\}/);
    assert.match(service, /overlay=x=\$\{baseX\}:y=\$\{baseY\}:eof_action=\$\{eofAction\}\$\{overlayEnableOption\(win\)\}/);
    assert.match(service, /setpts=PTS-STARTPTS\+\$\{win\.start\.toFixed\(3\)\}\/TB/);
  });

  test('a video overlay is only worked on while it shows: cut to its while, at the video frame rate', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'backend', 'render_service.js'), 'utf8');
    assert.match(service, /const trim = win\.end !== null \? `trim=duration=\$\{\(win\.end - win\.start\)\.toFixed\(3\)\},` : '';/);
    assert.match(service, /const eofAction = trim \? 'pass' : 'repeat';/);
    assert.match(service, /ovFps\[ovIdx\] > outFps \+ 0\.01 \? `fps=/);
    // Keyed in the render (no prepared copy): brought down and cut before keying, fewer frames to key;
    // the prepared copy, timed like the original, gets the same in the fit.
    assert.match(service, /filterComplex\.push\(`\[\$\{ovSource\}\]\$\{shown\.slice\(0, -1\)\}\[vov_shown_\$\{ovIdx\}\]`\);/);
    assert.match(service, /const fitted = `\[\$\{ovSource\}\]\$\{shown\}scale=/);
  });

  test('a video overlay with an end time is read only for its window (not keyed to the end of the episode)', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'backend', 'render_service.js'), 'utf8').replace(/\r\n/g, '\n');
    const inputs = service.slice(service.indexOf('// Overlay video inputs'), service.indexOf('// 3. Build Filter Graph'));
    assert.match(inputs, /if \(win\.end !== null\) args\.push\('-t', \(win\.end - win\.start\)\.toFixed\(3\)\);\n\s+args\.push\('-i', p\);/);
  });
});

// Rounded corners of a video overlay: a mask drawn once and multiplied into each frame's alpha
// must cut exactly what the per-pixel geq (still used for images) cuts, on every frame.
const binDir = path.join(__dirname, '..', 'backend', 'bin');
const ffmpeg = ['ffmpeg.exe', 'ffmpeg'].map((n) => path.join(binDir, n)).find((p) => fs.existsSync(p));
describe('rounded corners of a video overlay', { skip: !ffmpeg && 'no ffmpeg in backend/bin' }, () => {
  const { execFileSync } = require('node:child_process');
  const W = 96, H = 54, R = 20, FRAMES = 6;
  // A moving picture whose alpha varies too (a keyed banner's), so both the colour and the alpha are checked.
  const source = `testsrc2=s=${W}x${H}:r=10,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='mod(X*3+Y*5+N*40,256)'`;
  const run = (graph) => execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', source, '-filter_complex', graph, '-map', '[out]',
    '-frames:v', String(FRAMES), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 24 });

  test('same pixels as the geq, every frame', () => {
    const r = R, w = W, h = H;
    const geq = `[0:v]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,${r})*lt(Y,${r}),if(gt(hypot(${r}-X,${r}-Y),${r}),0,alpha(X,Y)),if(gt(X,${w}-${r})*lt(Y,${r}),if(gt(hypot(X-(${w}-${r}),${r}-Y),${r}),0,alpha(X,Y)),if(lt(X,${r})*gt(Y,${h}-${r}),if(gt(hypot(${r}-X,Y-(${h}-${r})),${r}),0,alpha(X,Y)),if(gt(X,${w}-${r})*gt(Y,${h}-${r}),if(gt(hypot(X-(${w}-${r}),Y-(${h}-${r})),${r}),0,alpha(X,Y)),alpha(X,Y)))))'[out]`;
    const masked = ['[0:v]format=rgba[src]', ...rs._roundedCornerFilters('src', 'rnd', W, H, R, 'rc0'), '[rnd]format=rgba[out]'].join(';');
    const a = run(geq), b = run(masked);
    assert.equal(a.length, W * H * 4 * FRAMES);
    assert.equal(b.length, a.length, 'one output frame per input frame');
    assert.ok(a.equals(b), 'pixel for pixel');
    assert.equal(b[3], 0, 'the top-left corner is cut');
  });
});
