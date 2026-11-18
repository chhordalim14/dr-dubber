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

// A Mac or source install has no backend/models (only the Windows setup fills it): MDX-Net
// downloads its model into the app's model folder, and a damaged download is never kept.
test('the model download is checked against its sha256 and a bad one leaves nothing', { skip: !hasNumpy && 'no Python with numpy' }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { pathToFileURL } = require('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdx-model-'));
  try {
    const src = path.join(dir, 'source.onnx');
    fs.writeFileSync(src, 'pretend model bytes');
    const sha = require('node:crypto').createHash('sha256').update('pretend model bytes').digest('hex');
    const dest = path.join(dir, 'models');
    const out = runPy(`
import json, os, onnx_separator as m
res = {}
try:
    m.download_model(${JSON.stringify(dest)}, url=${JSON.stringify(pathToFileURL(src).href)}, sha256="0" * 64, name="test-only.onnx")
except Exception as e:
    res["bad"] = str(e)
res["leftBehind"] = sorted(os.listdir(${JSON.stringify(dest)}))
p = m.download_model(${JSON.stringify(dest)}, url=${JSON.stringify(pathToFileURL(src).href)}, sha256=${JSON.stringify(sha)}, name="test-only.onnx")
res["found"] = m.find_model(name="test-only.onnx", model_dir=${JSON.stringify(dest)}) == os.path.abspath(p)
res["files"] = sorted(os.listdir(${JSON.stringify(dest)}))
print(json.dumps(res))
`);
    assert.match(out.bad || '', /checksum/);
    assert.deepEqual(out.leftBehind, []);
    assert.equal(out.found, true);
    assert.deepEqual(out.files, ['test-only.onnx']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// MDX-Net on a GPU (Core ML on a Mac, DirectML on Windows) that fails mid-tab, or answers with
// NaN, finishes the tab on the CPU with the same result. Stand-in sessions: no model needed.
test('a GPU session that throws or gives NaN mid-tab is swapped for the CPU', { skip: !hasNumpy && 'no Python with numpy' }, () => {
  const out = runPy(`${IDENTITY_MODEL}
class Sess:
    def __init__(self, provider, fault=None): self.provider, self.fault, self.calls = provider, fault, 0
    def get_providers(self): return [self.provider, "CPUExecutionProvider"]
    def run(self, names, feed):
        self.calls += 1
        spec = next(iter(feed.values()))
        if self.fault and self.calls == 2:
            if self.fault == "raise": raise RuntimeError("GPU reset")
            return [np.full_like(spec, np.nan)]
        return [spec]
res = {}
for provider in ("CoreMLExecutionProvider", "DmlExecutionProvider"):
    for fault in ("raise", "nan"):
        md = Identity(6144); md.input_name = "x"
        md.session = Sess(provider, fault)
        md.open_session = lambda gpu: Sess("CPUExecutionProvider")
        spec = np.ones((1, 4, 8, 8), np.float32)
        outs = [md.run_model(spec) for _ in range(3)]
        res[provider + ":" + fault] = [md.session.get_providers()[0], all(bool(np.isfinite(o).all()) for o in outs)]
md = Identity(6144); md.input_name = "x"; md.session = Sess("CPUExecutionProvider", "raise")
try:
    [md.run_model(np.ones((1, 4, 8, 8), np.float32)) for _ in range(3)]; res["cpu"] = "no error"
except RuntimeError:
    res["cpu"] = "raised"
print(json.dumps(res))
`);
  for (const k of ['CoreMLExecutionProvider:raise', 'CoreMLExecutionProvider:nan', 'DmlExecutionProvider:raise', 'DmlExecutionProvider:nan']) {
    assert.deepEqual(out[k], ['CPUExecutionProvider', true], k);
  }
  assert.equal(out.cpu, 'raised'); // a CPU failure is a real error, not retried
});

test('Core ML is picked only on a Mac, DirectML first wherever it exists', { skip: !hasNumpy && 'no Python with numpy' }, () => {
  const out = runPy(`
import json, types, onnx_separator as m
def ort(*names): return types.SimpleNamespace(get_available_providers=lambda: list(names) + ["CPUExecutionProvider"])
res = {}
for plat in ("darwin", "win32", "linux"):
    m.sys.platform = plat
    res[plat] = [m.gpu_provider(ort("CoreMLExecutionProvider")), m.gpu_provider(ort("DmlExecutionProvider", "CoreMLExecutionProvider")), m.gpu_provider(ort())]
print(json.dumps(res))
`);
  assert.deepEqual(out.darwin, ['CoreMLExecutionProvider', 'DmlExecutionProvider', null]);
  assert.deepEqual(out.win32, [null, 'DmlExecutionProvider', null]);
  assert.deepEqual(out.linux, [null, 'DmlExecutionProvider', null]);
});

// The stem is made as the audio streams through (a 10-minute tab peaked at 3.1 GB with the
// whole track held three times over, 2.4 GB streamed; 48 minutes: ~3.4 GB less). However the
// audio arrives, in pieces of any size, the stem must be the same, sample for sample.
test('the stem is the same whatever size of pieces the audio arrives in', { skip: !hasNumpy && 'no Python with numpy' }, () => {
  const out = runPy(`${IDENTITY_MODEL}
class Bent(Identity):
    def run_chunk(self, x, denoise=False):
        return np.tanh(x * 2.3) * 0.8  # not linear: the chunks' sums must add in the same order
md = Bent(7680)
rng = np.random.default_rng(3)
x = (rng.standard_normal((2, int(44100 * 13.7))) * 0.3).astype(np.float32)
whole = md.primary_stem(x, overlap=0.1)
same = []
for piece in (1, 997, 44100, 10 ** 7):
    pos, got = [0], []
    def read(k):
        k = min(k, piece); i = pos[0]; pos[0] = min(x.shape[1], i + k)
        return x[:, i:pos[0]]
    # read may hand back less than asked before the end: stream_stem must keep asking.
    def read_all(k):
        parts = []
        while k > 0:
            p = read(k)
            if not p.shape[1]: break
            parts.append(p); k -= p.shape[1]
        return np.concatenate(parts, axis=1) if parts else x[:, :0]
    n = md.stream_stem(read_all, lambda m, s: got.append(s.copy()), overlap=0.1)
    same.append(n == x.shape[1] and np.concatenate(got, axis=1).tobytes() == whole.tobytes())
print(json.dumps({"same": same}))
`);
  assert.deepEqual(out.same, [true, true, true, true]);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
test('separate_file streams through FFmpeg; a file it cannot decode leaves no half-written stems', { skip: (!hasNumpy || !hasFfmpeg) && 'no Python with numpy, or no ffmpeg' }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdx-stream-'));
  try {
    const out = runPy(`${IDENTITY_MODEL}
import os, subprocess, wave
d = ${JSON.stringify(dir)}
m.MdxModel = lambda path, threads=None: Identity(7680)
src = os.path.join(d, "in.wav")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=9.5", "-ac", "2", "-ar", "44100", src], check=True)
progress = []
v, b = m.separate_file(src, d, "model.onnx", progress=lambda k, t: progress.append((k, t)))
with wave.open(v) as w: frames = w.getnframes()
bad = os.path.join(d, "bad.wav")
open(bad, "wb").write(b"not audio at all")
os.makedirs(os.path.join(d, "badjob"))
try:
    m.separate_file(bad, os.path.join(d, "badjob"), "model.onnx")
    err = None
except RuntimeError as e:
    err = str(e)
print(json.dumps({"frames": frames, "last": progress[-1], "steady": all(a <= b for a, b in progress),
                  "err": err, "left": sorted(os.listdir(os.path.join(d, "badjob")))}))
`);
    assert.equal(out.frames, Math.round(44100 * 9.5));
    assert.equal(out.last[0], out.last[1]);
    assert.ok(out.steady);
    assert.match(out.err, /ffmpeg could not decode the audio/);
    assert.deepEqual(out.left, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
