// A chroma-keyed video overlay (a sponsor banner) is keyed and fitted to its box once and kept
// (render_service.js preparedOverlay): every tab of a series then reads the small prepared
// copy instead of decoding and keying the full-size banner again. The copy must be exactly what
// keying inside the render gives, every frame, and be made again when what it depends on changes.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const binDir = path.join(__dirname, '..', 'backend', 'bin');
const ffmpeg = ['ffmpeg.exe', 'ffmpeg'].map((n) => path.join(binDir, n)).find((p) => fs.existsSync(p));
const ffprobe = ['ffprobe.exe', 'ffprobe'].map((n) => path.join(binDir, n)).find((p) => fs.existsSync(p));

describe('keyed video overlay, prepared once', { skip: (!ffmpeg || !ffprobe) && 'no ffmpeg in backend/bin' }, () => {
  let root, rs, banner;
  const ck = { enabled: true, color: '#00ff00', tolerance: 80, smooth: 20, spill: 80 };
  const W = 96, H = 28; // the box: much smaller than the banner, as a sponsor strip is
  const raw = (args) => execFileSync(ffmpeg, ['-v', 'error', ...args, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 26 });

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'drdub-keyed-'));
    process.env.APP_STORAGE_DIR = root; // the cache goes in this test's own storage
    rs = require('../backend/render_service');
    banner = path.join(root, 'banner.mp4');
    // A moving picture on green, 720x210 at 10 fps for 2 s.
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=720x210:r=10:d=2', '-f', 'lavfi', '-i', 'testsrc2=s=300x120:r=10:d=2',
      '-filter_complex', "[0][1]overlay=x='40+t*100':y=45", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', banner]);
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('the same pixels as keying in the render, every frame, at the box size', async () => {
    const prepared = await rs._preparedOverlay(banner, W, H, ck);
    assert.ok(prepared.startsWith(path.join(root, 'separated', 'keyed-overlays')), prepared);
    const info = execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=width,height,pix_fmt,nb_read_frames,r_frame_rate', '-of', 'csv=p=0', prepared]).toString().trim();
    assert.equal(info, `${W},${H},bgra,10/1,20`);
    const inRender = raw(['-i', banner, '-filter_complex', rs._keyedOverlayFilters('0:v', 'o', W, H, ck).join(';'), '-map', '[o]']);
    const fromCopy = raw(['-i', prepared]);
    assert.equal(fromCopy.length, W * H * 4 * 20);
    assert.ok(fromCopy.equals(inRender), 'pixel for pixel, alpha included');
    assert.ok(fromCopy.some((v, i) => i % 4 === 3 && v === 0), 'the green is keyed out');
  });

  test('made once: the next render reuses it; other key settings or another box make a new one', async () => {
    const first = await rs._preparedOverlay(banner, W, H, ck);
    const made = fs.statSync(first).size;
    const t0 = Date.now();
    assert.equal(await rs._preparedOverlay(banner, W, H, ck), first);
    assert.ok(Date.now() - t0 < 500, 'no FFmpeg run');
    assert.equal(fs.statSync(first).size, made);
    assert.notEqual(await rs._preparedOverlay(banner, W, H, { ...ck, tolerance: 120 }), first);
    assert.notEqual(await rs._preparedOverlay(banner, W + 2, H, ck), first);
    assert.deepEqual(fs.readdirSync(path.join(root, 'separated', 'keyed-overlays')).filter((n) => /tmp/.test(n)), [], 'no temp file left');
  });

  test('an export with a keyed, timed banner shows it keyed, only in its window, from the prepared copy', async () => {
    const main = path.join(root, 'main.mp4'), strip = path.join(root, 'strip.mp4'), out = path.join(root, 'out.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=320x240:d=3:r=10', '-f', 'lavfi', '-i', 'sine=d=3', '-shortest', main]);
    // Green with a red block in the middle: the green must go, the red stay.
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=320x120:r=10:d=1', '-vf', 'drawbox=x=120:y=30:w=80:h=60:color=red:t=fill',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', strip]);
    const cache = path.join(root, 'separated', 'keyed-overlays');
    const before = fs.existsSync(cache) ? fs.readdirSync(cache).length : 0;
    await new Promise((resolve, reject) => rs.renderVideo({
      videoPath: main, outputPath: out, encoder: 'cpu', burnSubtitles: false, normalizeLoudness: false,
      videoOverlays: [{ path: strip, x: 0, y: 0, w: 50, h: 25, opacity: 100, start: 1, end: 2, chromaKey: ck }], // a 160 x 60 box
    }, () => { }, resolve, reject));
    assert.equal(fs.readdirSync(cache).length, before + 1, 'prepared for this box');
    const px = (t, x, y) => {
      const f = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 22 });
      return [...f.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
    };
    const red = ([r, g, b]) => r > 150 && g < 90 && b < 90;
    const black = ([r, g, b]) => r < 40 && g < 40 && b < 40;
    assert.ok(black(px(0.5, 80, 30)), `not yet shown: ${px(0.5, 80, 30)}`);
    assert.ok(red(px(1.5, 80, 30)), `the red block: ${px(1.5, 80, 30)}`);
    assert.ok(black(px(1.5, 10, 5)), `the green keyed out: ${px(1.5, 10, 5)}`);
    assert.ok(black(px(2.5, 80, 30)), `gone after its end: ${px(2.5, 80, 30)}`);
  });

  test('the render reads the prepared copy in place of the banner, and keys in the render only when it fails', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'backend', 'render_service.js'), 'utf8').replace(/\r\n/g, '\n');
    const block = service.slice(service.indexOf('// Apply Video Overlays'), service.indexOf('// Subtitles burning or soft muxing'));
    assert.match(block, /prepared = await preparedOverlay\(ov\.path, ovW, ovH, keyed \? ov\.chromaKey : null\)/);
    // (In the render, a banner is first brought to the video's frame rate and its while: see sponsor-overlays.)
    assert.match(block, /if \(prepared\) \{\r?\n\s+args\[ov\.pathArg\] = prepared;\r?\n\s+\} else if \(keyed\) \{[^]*?filterComplex\.push\(\.\.\.keyedOverlayFilters\(ovSource, `vov_keyed_\$\{ovIdx\}`/);
  });

  test('a plain banner bigger than its box: fitted once, the same pixels as fitting in the render', async () => {
    const prepared = await rs._preparedOverlay(banner, W, H, null);
    assert.notEqual(prepared, await rs._preparedOverlay(banner, W, H, ck), 'not the keyed copy');
    const inRender = raw(['-i', banner, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=rgba`]);
    const fromCopy = raw(['-i', prepared]);
    assert.equal(fromCopy.length, W * H * 4 * 20);
    assert.ok(fromCopy.equals(inRender), 'pixel for pixel');
    assert.equal(await rs._plainOverlayWorthPreparing(banner, W, H), true, 'bigger than its box');
    assert.equal(await rs._plainOverlayWorthPreparing(banner, 720, 210), false, 'already the box size: read as it is');
  });

  test('an export with a plain banner reads its fitted copy', async () => {
    const main = path.join(root, 'main2.mp4'), out = path.join(root, 'out2.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=320x240:d=2:r=10', '-f', 'lavfi', '-i', 'sine=d=2', '-shortest', main]);
    const cache = path.join(root, 'separated', 'keyed-overlays');
    const before = fs.readdirSync(cache).length;
    // A 160 x 48 box on a 720x210 banner.
    await new Promise((resolve, reject) => rs.renderVideo({
      videoPath: main, outputPath: out, encoder: 'cpu', burnSubtitles: false, normalizeLoudness: false,
      videoOverlays: [{ path: banner, x: 0, y: 0, w: 50, h: 20, opacity: 100 }],
    }, () => { }, resolve, reject));
    assert.equal(fs.readdirSync(cache).length, before + 1, 'prepared for this box');
    const f = execFileSync(ffmpeg, ['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 22 });
    const [r, g, b] = f.subarray((5 * 320 + 5) * 3, (5 * 320 + 5) * 3 + 3);
    assert.ok(g > 150 && r < 90 && b < 90, `the banner's green, unkeyed: ${[r, g, b]}`);
  });
});
