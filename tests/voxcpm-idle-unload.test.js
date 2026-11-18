// VoxCPM2 (a 2B model) stayed loaded all session: several GB of RAM on a PC without NVIDIA,
// whatever else the app was doing. After VOXCPM_IDLE_MINUTES with no line spoken the server
// lets it go, on any device, and the next line loads it back. A stand-in torch: no model needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const PY_DIR = path.join(__dirname, '..', 'backend', 'python');
const hasPython = spawnSync(PY, ['-c', 'import json'], { windowsHide: true }).status === 0;

function runPy(body, env = {}) {
  const code = `
import json, sys, time, types
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
torch = types.ModuleType("torch")
torch.cuda = types.SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
sys.modules["torch"] = torch
import voxcpm2_server as v
v.log = lambda msg: None
${body}
`;
  const res = spawnSync(PY, ['-c', code], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

test('a CPU model idle past the limit is unloaded; one used just now is kept', { skip: !hasPython && 'no Python' }, () => {
  const out = runPy(`
v.state.update(status="ready", device="cpu", model=object())
v.last_use["t"] = time.time() - 16 * 60
idle = v.release_model(idle=True)
after_idle = (v.state["status"], v.state["model"] is None)
v.state.update(status="ready", model=object())
v.last_use["t"] = time.time() - 60
recent = v.release_model(idle=True)
print(json.dumps({"default": v.IDLE_MINUTES, "idle": idle, "after_idle": after_idle, "recent": recent, "kept": v.state["status"]}))
`);
  assert.equal(out.default, 15);
  assert.equal(out.idle, true);
  assert.deepEqual(out.after_idle, ['sleeping', true]);
  assert.equal(out.recent, false);
  assert.equal(out.kept, 'ready');
});

test('VOXCPM_IDLE_MINUTES sets the limit; 0 or junk never leaves it unbounded or broken', { skip: !hasPython && 'no Python' }, () => {
  assert.equal(runPy('print(json.dumps(v.IDLE_MINUTES))', { VOXCPM_IDLE_MINUTES: '5' }), 5);
  assert.equal(runPy('print(json.dumps(v.IDLE_MINUTES))', { VOXCPM_IDLE_MINUTES: '0' }), 0);
  assert.equal(runPy('print(json.dumps(v.IDLE_MINUTES))', { VOXCPM_IDLE_MINUTES: 'soon' }), 15);
});

test('a line arriving while the unload waits for the lock keeps the model', { skip: !hasPython && 'no Python' }, () => {
  // The line holds use_lock while it speaks; the watcher queues behind it, and the line's
  // finishing time stamp must stop the unload once the watcher gets the lock.
  const out = runPy(`
import threading
v.state.update(status="ready", device="cpu", model=object())
v.last_use["t"] = time.time() - 16 * 60
res = {}
with v.use_lock:
    t = threading.Thread(target=lambda: res.update(released=v.release_model(idle=True)))
    t.start()
    time.sleep(0.2)
    v.last_use["t"] = time.time()  # the line ends
t.join(5)
print(json.dumps({"released": res.get("released"), "status": v.state["status"]}))
`);
  assert.deepEqual(out, { released: false, status: 'ready' });
});

test('the server starts the idle watcher and stamps each line it speaks', () => {
  const src = require('node:fs').readFileSync(path.join(PY_DIR, 'voxcpm2_server.py'), 'utf8');
  assert.match(src, /if IDLE_MINUTES > 0:\s*threading\.Thread\(target=idle_watch, daemon=True\)\.start\(\)/);
  const gen = src.slice(src.indexOf('if route not in ("/api/generate", "/generate")'));
  assert.match(gen, /last_use\["t"\] = time\.time\(\)\s*if state\["status"\] == "sleeping"/);
  assert.match(gen, /result = synthesize\(payload\)\s*last_use\["t"\] = time\.time\(\)/);
});
