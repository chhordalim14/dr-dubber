// Isolate BGM's built-in MDX-Net separator (backend/python/onnx_separator.py): the chunk
// blending must add up to exactly 1 everywhere (no seams or level dips every ~6 s) and the
// STFT pair must give back its input. No model needed: the network is swapped for identity.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const PY_DIR = path.join(__dirname, '..', 'backend', 'python');
const hasNumpy = spawnSync(PY, ['-c', 'import numpy'], { windowsHide: true }).status === 0;

function runPy(code) {
  const res = spawnSync(PY, ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(PY_DIR)})\n${code}`], { encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

// An MdxModel without an onnxruntime session; run_chunk is the STFT round trip.
const IDENTITY_MODEL = `
import json, numpy as np, onnx_separator as m
class Identity(m.MdxModel):
    def __init__(self, n_fft):
        self.n_fft, self.dim_f = n_fft, n_fft // 2
        self.compensate, self.primary = 1.0, "vocal"
        self.chunk, self.trim = m.HOP * (m.DIM_T - 1), n_fft // 2
        self.window = m.hann(n_fft)
        w = np.zeros(n_fft + m.HOP * (m.DIM_T - 1), np.float32)
        for t in range(m.DIM_T): w[t * m.HOP:t * m.HOP + n_fft] += self.window ** 2
        self.wsum = np.maximum(w, 1e-8)
        self.frame_idx = np.arange(m.DIM_T)[:, None] * m.HOP + np.arange(n_fft)[None, :]
    def run_chunk(self, x, denoise=False):
        return x
`;

test('chunk blend weights sum to 1 across every overlap', { skip: !hasNumpy && 'no Python with numpy' }, () => {
  const out = runPy(`${IDENTITY_MODEL}
md = Identity(7680)
worst = 0.0
for ov in (0.03, 0.1, 0.25, 0.5):
    olen = max(4 * m.HOP, int(md.chunk * ov)); step = md.chunk - olen
    w = md.blend_weight(olen)
    total = np.zeros(step * 6 + md.chunk)
    for k in range(7): total[k * step:k * step + md.chunk] += w
    mid = total[md.chunk:step * 6]
    worst = max(worst, float(np.abs(mid - 1).max()))
print(json.dumps({"worst": worst}))
`);
  assert.ok(out.worst < 1e-5, `blend weights stray ${out.worst} from 1`);
});

test('a long signal comes back unchanged through chunking (no seams, no edge loss)', { skip: !hasNumpy && 'no Python with numpy' }, () => {
  const out = runPy(`${IDENTITY_MODEL}
md = Identity(6144)
t = np.arange(int(44100 * 20.3)) / 44100
x = np.stack([np.sin(2 * np.pi * 440 * t), 0.5 * np.sin(2 * np.pi * 1234 * t)]).astype(np.float32) * 0.4
y = md.primary_stem(x, overlap=0.1)
print(json.dumps({"shape": list(y.shape), "err": float(np.abs(y - x).max())}))
`);
  assert.deepEqual(out.shape, [2, Math.floor(44100 * 20.3)]);
  assert.ok(out.err < 1e-4, `round trip error ${out.err}`);
});
