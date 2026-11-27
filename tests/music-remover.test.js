// Isolate BGM > Remove music from BGM: backend/python/music_remover.py (the CDX23 model download)
// and how server.js hands every finished separation to the music pass.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const PY_DIR = path.join(__dirname, '..', 'backend', 'python');
const hasPython = spawnSync(PY, ['-c', 'import hashlib'], { windowsHide: true }).status === 0;

// A stand-in torch whose download writes the given bytes, so no network or real torch is needed.
function runEnsureModel(dir, bytes) {
  const code = `
import json, sys, types
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
torch = types.ModuleType("torch"); torch.hub = types.SimpleNamespace()
def download(url, dst, progress=True):
    open(dst, "wb").write(bytes.fromhex(${JSON.stringify(Buffer.from(bytes).toString('hex'))}))
torch.hub.download_url_to_file = download
sys.modules["torch"] = torch
import music_remover
try:
    print(json.dumps({"path": music_remover.ensure_model(${JSON.stringify(dir)})}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;
  const res = spawnSync(PY, ['-c', code], { encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

test('a damaged model download is refused and leaves nothing behind', { skip: !hasPython && 'no Python' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-model-'));
  try {
    const out = runEnsureModel(dir, 'not a checkpoint');
    assert.match(out.error || '', /checksum/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a model already in the folder is used without downloading', { skip: !hasPython && 'no Python' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-model-'));
  try {
    const model = path.join(dir, '97d170e1-dbb4db15.th');
    fs.writeFileSync(model, 'already here');
    const out = runEnsureModel(dir, 'should not be written');
    assert.equal(path.resolve(out.path), path.resolve(model));
    assert.equal(fs.readFileSync(model, 'utf8'), 'already here');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every finished separation goes through the music pass', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  // Only three places may report a BGM as done: finishBgmJob itself (no music pass asked),
  // a cached result that already has no music, and the end of the music pass.
  const direct = src.match(/bgmJobs\.set\(jobId, bgmDoneJob\(/g) || [];
  assert.equal(direct.length, 3);
  const fn = src.slice(src.indexOf('function finishBgmJob('), src.indexOf('async function removeMusicFromBgm('));
  assert.match(fn, /if \(!music\) \{\s*bgmJobs\.set\(jobId, bgmDoneJob\(/);
  assert.match(src, /bgmDoneJob\(cachedNoMusic\.bgm, cachedNoMusic\.vocal, \{[^}]*\.\.\.musicPassResult\(bgmKeep\)/);
  assert.match(src, /bgmJobs\.set\(jobId, bgmDoneJob\(outBgm, outVocal, \{ \.\.\.extra, \.\.\.musicPassResult\(music\.keep\) \}\)\)/);
});

test('"Keep: Music only" has its own cache key and reaches the Python as --keep music', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  assert.match(src, /const MUSIC_ONLY_MODEL = '\+musiconly:/);
  assert.notEqual(src.match(/const NO_MUSIC_MODEL = '([^']+)'/)[1], src.match(/const MUSIC_ONLY_MODEL = '([^']+)'/)[1]);
  assert.match(src, /const musicPassModel = bgmKeep === 'music' \? MUSIC_ONLY_MODEL : NO_MUSIC_MODEL;/);
  assert.match(src, /'--keep', music\.keep/);
  const vs = fs.readFileSync(path.join(PY_DIR, 'vocal_separator.py'), 'utf8');
  assert.match(vs, /"--keep", keep,/);
  assert.match(vs, /args\.threads, args\.keep\)/);
});

// Device choice and the GPU -> CPU fallback, with stand-in torch / demucs modules (no GPU,
// model or audio needed). `fail` makes the run on that device throw (or give NaN).
function runRemoveMusic({ cuda = false, mps = false, fail = null, device = null, nan = false, keep = null }) {
  const code = `
import json, sys, types
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
runs = []
torch = types.ModuleType("torch")
torch.cuda = types.SimpleNamespace(is_available=lambda: ${cuda ? 'True' : 'False'}, empty_cache=lambda: None)
torch.mps = types.SimpleNamespace(empty_cache=lambda: None)
torch.backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: ${mps ? 'True' : 'False'}))
torch.set_num_threads = lambda n: None
torch.from_numpy = lambda a: types.SimpleNamespace(shape=(1, 2, 44100))
sys.modules["torch"] = torch
model = types.SimpleNamespace(samplerate=44100, segment=7.8, sources=["music", "sfx", "speech"], eval=lambda: None, to=lambda d: None)
sys.modules["demucs"] = types.ModuleType("demucs")
sys.modules["demucs.states"] = types.SimpleNamespace(load_model=lambda p: model)
import onnx_separator, music_remover
import numpy
onnx_separator.read_audio = lambda p, f="ffmpeg": numpy.zeros((2, 44100), numpy.float32)
music_remover.ensure_model = lambda d: "model.th"
stems = []
def separate_stem(model, x, device, output_path, stem_idx):
    runs.append(device)
    stems.append(model.sources[stem_idx])
    if device == ${fail ? JSON.stringify(fail) : 'None'}: raise ${fail === 'cuda' ? 'RuntimeError("CUDA error: an illegal memory access")' : 'NotImplementedError("op not on MPS")'}
    if ${nan ? 'True' : 'False'} and device != "cpu": raise FloatingPointError("the GPU gave back invalid numbers")
music_remover.separate_stem = separate_stem
try:
    kw = {${keep ? `"keep": ${JSON.stringify(keep)}` : ''}}
    dev = music_remover.remove_music("in.wav", "out.wav", "models", device=${device ? JSON.stringify(device) : 'None'}, **kw)
    out = {"device": dev, "runs": runs}
    if ${keep ? 'True' : 'False'}: out["stems"] = stems
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({"error": type(e).__name__, "runs": runs}))
`;
  const res = spawnSync(PY, ['-c', code], { encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}
const hasNumpy = hasPython && spawnSync(PY, ['-c', 'import numpy'], { windowsHide: true }).status === 0;

test('a Mac uses Apple\'s GPU (MPS); NVIDIA wins when there is one; Use CPU stays on the CPU', { skip: !hasNumpy && 'no Python with numpy' }, () => {
  assert.deepEqual(runRemoveMusic({ mps: true }), { device: 'mps', runs: ['mps'] });
  assert.deepEqual(runRemoveMusic({ cuda: true, mps: true }), { device: 'cuda', runs: ['cuda'] });
  assert.deepEqual(runRemoveMusic({ mps: true, device: 'cpu' }), { device: 'cpu', runs: ['cpu'] });
  assert.deepEqual(runRemoveMusic({}), { device: 'cpu', runs: ['cpu'] });
});

test('any failure on Apple\'s GPU, or NaN from any GPU, is redone on the CPU', { skip: !hasNumpy && 'no Python with numpy' }, () => {
  assert.deepEqual(runRemoveMusic({ mps: true, fail: 'mps' }), { device: 'cpu', runs: ['mps', 'cpu'] });
  assert.deepEqual(runRemoveMusic({ mps: true, nan: true }), { device: 'cpu', runs: ['mps', 'cpu'] });
  assert.deepEqual(runRemoveMusic({ cuda: true, nan: true }), { device: 'cpu', runs: ['cuda', 'cpu'] });
  // An NVIDIA error that is not "out of memory" still shows (as before), not hidden by a CPU rerun.
  assert.deepEqual(runRemoveMusic({ cuda: true, fail: 'cuda' }), { error: 'RuntimeError', runs: ['cuda'] });
});

test('keep "sfx" (the default) writes the effects stem, keep "music" the music stem; anything else is refused', { skip: !hasNumpy && 'no Python with numpy' }, () => {
  assert.deepEqual(runRemoveMusic({ keep: 'sfx' }), { device: 'cpu', runs: ['cpu'], stems: ['sfx'] });
  assert.deepEqual(runRemoveMusic({ keep: 'music' }), { device: 'cpu', runs: ['cpu'], stems: ['music'] });
  // The GPU -> CPU rerun keeps the same stem.
  assert.deepEqual(runRemoveMusic({ mps: true, fail: 'mps', keep: 'music' }), { device: 'cpu', runs: ['mps', 'cpu'], stems: ['music', 'music'] });
  assert.deepEqual(runRemoveMusic({ keep: 'speech' }), { error: 'ValueError', runs: [] });
});

// separate_stem is apply_model's split loop keeping only one stem, written as it goes
// (apply_model held all three stems of the whole tab: 636 MB more for 10 minutes). It must
// write exactly the samples apply_model gives. Needs torch + demucs: the app's Demucs Python
// when it is there (backend/demucs-env), else $PYTHON.
const DEMUCS_PY = [
  path.join(__dirname, '..', 'backend', 'demucs-env', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  PY,
].find((p) => spawnSync(p, ['-c', 'import torch, demucs'], { windowsHide: true }).status === 0);

test('the effects stem written piece by piece is apply_model\'s, sample for sample; NaN on a GPU is caught', { skip: !DEMUCS_PY && 'no Python with torch + demucs' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfx-'));
  try {
    const code = `
import json, sys, wave
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
import torch
from demucs.apply import apply_model
import music_remover, onnx_separator
torch.manual_seed(0)
class Stand(torch.nn.Module):
    """Three stems from a small conv net: each output sample depends on its neighbours."""
    samplerate, segment, sources = 44100, 0.37, ["music", "sfx", "speech"]
    def __init__(self):
        super().__init__()
        self.conv = torch.nn.Conv1d(2, 6, 31, padding=15)
    def forward(self, x):
        return torch.tanh(self.conv(x) * 3).view(x.shape[0], 3, 2, -1)
m = Stand().eval()
seg = int(m.samplerate * m.segment); stride = int(0.75 * seg)
res = []
for n in (5, seg - 1, seg, seg + 1, stride * 4, stride * 4 + 1, 44100 * 3 + 123):
    x = torch.randn(1, 2, n) * 0.4
    with torch.no_grad():
        ref = apply_model(m, x, shifts=0, overlap=music_remover.OVERLAP, device="cpu")[0][1]
    out = ${JSON.stringify(dir)} + f"/sfx_{n}.wav"
    music_remover.separate_stem(m, x, "cpu", out, 1)
    with wave.open(out) as w:
        got = w.readframes(w.getnframes())
    res.append(got == onnx_separator.to_pcm16(ref.numpy()))
# A GPU answering NaN is refused (the caller then redoes it on the CPU). The "GPU" is the
# CPU under another device type, so the check runs without one.
class NaNs(Stand):
    def forward(self, x): return super().forward(x) * float("nan")
class FakeGpu:
    type = "mps"
real_device, real_arange = torch.device, torch.arange
torch.device = lambda d: FakeGpu() if d == "fake-gpu" else real_device(d)
torch.arange = lambda *a, device=None, **k: real_arange(*a, **k)
import demucs.apply as da
real_apply = da.apply_model
da.apply_model = lambda model, chunk, **kw: real_apply(model, chunk, **{**kw, "device": "cpu"})
m2 = NaNs().eval()
m2.to = lambda d: m2
nan_caught = False
try:
    music_remover.separate_stem(m2, torch.randn(1, 2, 44100), "fake-gpu", ${JSON.stringify(dir)} + "/nan.wav", 1)
except FloatingPointError:
    nan_caught = True
print(json.dumps({"same": res, "nan_caught": nan_caught}))
`;
    const res = spawnSync(DEMUCS_PY, ['-c', code], { encoding: 'utf8', windowsHide: true });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.deepEqual(out.same, out.same.map(() => true));
    assert.equal(out.nan_caught, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
