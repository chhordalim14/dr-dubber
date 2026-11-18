// Isolate BGM: Spleeter runs a whole tab through TensorFlow in one go (a 7-minute tab peaked at
// 6.4 GB) and Isolate BGM All runs two tabs at once, which filled a 16 GB Mac. Separator
// processes share one lock (vocal_separator.one_at_a_time), so a second Spleeter waits its turn.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const PY_DIR = path.join(__dirname, '..', 'backend', 'python');
const hasPython = spawnSync(PY, ['-c', 'import json'], { windowsHide: true }).status === 0;
const LOCK = `dr_dubber_test_${process.pid}`;

// Holds the lock for holdS seconds; prints when it got it and when it let go.
function holder(holdS) {
  const code = `
import json, sys, time
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
import vocal_separator as v
with v.one_at_a_time(${JSON.stringify(LOCK)}, "waiting"):
    got = time.time()
    time.sleep(${holdS})
print(json.dumps({"got": got, "left": time.time()}))
`;
  return new Promise((resolve, reject) => {
    const p = spawn(PY, ['-c', code], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? resolve({ ...JSON.parse(out.trim().split('\n').pop()), err }) : reject(new Error(err))));
  });
}

test('two separators never hold the Spleeter lock at once; the second says it waits', { skip: !hasPython && 'no Python' }, async () => {
  const [a, b] = await Promise.all([holder(1.2), holder(1.2)]);
  const [first, second] = a.got <= b.got ? [a, b] : [b, a];
  assert.ok(second.got >= first.left - 0.05, `second got the lock ${(first.left - second.got).toFixed(2)} s before the first let go`);
  assert.match(second.err, /waiting/);
  assert.doesNotMatch(first.err, /waiting/);
});

test('a killed holder releases the lock', { skip: !hasPython && 'no Python' }, async () => {
  const code = `
import sys, time
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
import vocal_separator as v
with v.one_at_a_time(${JSON.stringify(LOCK)}):
    print("held", flush=True)
    time.sleep(60)
`;
  const p = spawn(PY, ['-c', code], { windowsHide: true });
  await new Promise((resolve) => p.stdout.once('data', resolve));
  p.kill('SIGKILL');
  await new Promise((resolve) => p.on('close', resolve));
  const t0 = Date.now();
  await holder(0);
  assert.ok(Date.now() - t0 < 5000, 'the lock stayed held after its holder was killed');
});
