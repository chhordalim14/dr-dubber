// Chroma key: the export keys a video overlay exactly as the editor previews it. The real preview
// code (frontend/chroma-worker.js, run here with a stand-in canvas) and the export's FFmpeg
// filters (render_service.js chromaKeyFilters) key the same frame - every mix of red, green
// and blue in steps of 17 - and must give the same picture, pixel for pixel (within rounding).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const rs = require('../backend/render_service');

const binDir = path.join(__dirname, '..', 'backend', 'bin');
const ffmpeg = ['ffmpeg.exe', 'ffmpeg'].map((n) => path.join(binDir, n)).find((p) => fs.existsSync(p));

// The test frame: 16 x 16 x 16 colours (0, 17, ... 255), laid out 64 wide, 64 high.
const W = 64, H = 64;
const frame = Buffer.alloc(W * H * 3);
for (let i = 0; i < 4096; i++) {
  frame[i * 3] = (i % 16) * 17;
  frame[i * 3 + 1] = (Math.floor(i / 16) % 16) * 17;
  frame[i * 3 + 2] = Math.floor(i / 256) * 17;
}

// The preview: chroma-worker.js as the editor runs it, on the frame's pixels.
function previewKey(ck) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = frame[i * 3];
    rgba[i * 4 + 1] = frame[i * 3 + 1];
    rgba[i * 4 + 2] = frame[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  let result = null;
  class OffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() {
      return {
        drawImage() { },
        getImageData: () => ({ data: rgba }),
        putImageData: (img) => { result = img.data; },
      };
    }
    transferToImageBitmap() { return {}; }
  }
  const self = { postMessage() { } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'chroma-worker.js'), 'utf8'), { self, OffscreenCanvas, Math });
  const hex = ck.color.replace('#', '');
  self.onmessage({ data: { bitmap: { close() { } }, width: W, height: H, kr: parseInt(hex.slice(0, 2), 16), kg: parseInt(hex.slice(2, 4), 16), kb: parseInt(hex.slice(4, 6), 16), tolerance: ck.tolerance, smoothing: ck.smooth, spill: ck.spill } });
  return result;
}

// The export: the filters render_service.js puts in the graph, on the same pixels.
function exportKey(ck, dir) {
  const input = path.join(dir, 'in.rgb');
  fs.writeFileSync(input, frame);
  const graph = rs._chromaKeyFilters('0:v', 'out', { enabled: true, ...ck }, 'ck0').join(';');
  return execFileSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', input,
    '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 24 });
}

describe('chroma key: the export matches the preview', { skip: !ffmpeg && 'no ffmpeg in backend/bin' }, () => {
  const cases = [
    { name: 'green screen, the defaults', ck: { color: '#00ff00', tolerance: 80, smooth: 20, spill: 80 } },
    { name: 'green screen, loose and soft, little despill', ck: { color: '#22cc33', tolerance: 200, smooth: 60, spill: 30 } },
    { name: 'green screen, tight and hard, no despill', ck: { color: '#00ff00', tolerance: 10, smooth: 0, spill: 0 } },
    { name: 'blue screen', ck: { color: '#0000ff', tolerance: 120, smooth: 40, spill: 60 } },
    { name: 'another colour (magenta): YUV distance', ck: { color: '#ff00ff', tolerance: 80, smooth: 20, spill: 80 } },
    { name: 'another colour (grey-ish orange), wide', ck: { color: '#cc8844', tolerance: 160, smooth: 80, spill: 0 } },
  ];
  for (const { name, ck } of cases) {
    test(name, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chroma-test-'));
      try {
        const want = previewKey(ck);
        const got = exportKey(ck, dir);
        assert.equal(got.length, want.length);
        let worst = 0, worstAt = -1, keyedOut = 0;
        for (let i = 0; i < want.length; i++) {
          // The colour of a pixel keyed out completely doesn't show (the export despills it too).
          if (i % 4 !== 3 && want[i - (i % 4) + 3] === 0 && got[i - (i % 4) + 3] === 0) continue;
          const diff = Math.abs(got[i] - want[i]);
          if (diff > worst) { worst = diff; worstAt = i; }
        }
        for (let i = 3; i < want.length; i += 4) if (want[i] === 0) keyedOut++;
        assert.ok(keyedOut > 0, 'the key takes something out of the frame');
        const px = Math.floor(worstAt / 4);
        assert.ok(worst <= 2, `pixel rgb(${frame[px * 3]},${frame[px * 3 + 1]},${frame[px * 3 + 2]}) channel ${worstAt % 4}: preview ${want[worstAt]}, export ${got[worstAt]}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
