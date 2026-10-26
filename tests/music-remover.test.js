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
  assert.match(src, /bgmDoneJob\(cachedNoMusic\.bgm, cachedNoMusic\.vocal, \{[^}]*musicRemoved: true/);
  assert.match(src, /bgmJobs\.set\(jobId, bgmDoneJob\(outBgm, outVocal, \{ \.\.\.extra, musicRemoved: true \}\)\)/);
});
