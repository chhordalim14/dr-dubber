// tts_generator.py EdgeGate: Microsoft turns lines away ("No audio was received") when too many
// arrive at once (Dub Whole Series, 12 at a time). The generator then sends fewer at once and
// pauses, instead of handing every refused line back to the app to retry into the same crowd.
// Runs the app's Python with a stand-in edge_tts; skipped when python_env isn't there (git-ignored).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..');
const roots = [repo, path.join(repo, '..', '..', '..'), 'C:\\dr-dubber'];
const PY = roots.map((r) => path.join(r, 'backend', 'python_env', process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python')))
    .find((p) => fs.existsSync(p));
const SCRIPT = path.join(repo, 'backend', 'python', 'tts_generator.py');

function runPy(body) {
    const code = `
import sys, types, asyncio, json, importlib.util, tempfile, os
fake = types.ModuleType("edge_tts")
sys.modules["edge_tts"] = fake
spec = importlib.util.spec_from_file_location("tts", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${body}
`;
    const r = spawnSync(PY, ['-I', '-c', code], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    return { out: JSON.parse(r.stdout.trim().split('\n').pop()), stderr: r.stderr };
}

test('halves on a refusal, pauses, then climbs back to the start value', { skip: !PY && 'app python_env not found' }, () => {
    const { out } = runPy(`
async def main():
    loop = asyncio.get_running_loop()
    g = m.EdgeGate(); g.PAUSE_SECONDS = 0.3
    g.setup(12)
    tickets = [await g.acquire() for _ in range(12)]
    r = {"full": g.active}
    g.release("busy", tickets[0]); r["afterBusy"] = g.limit
    g.release("busy", tickets[1]); r["sameCrowd"] = g.limit
    for k in tickets[2:]: g.release("other", k)
    t = loop.time(); k = await g.acquire(); r["waited"] = loop.time() - t
    g.release("busy", k); r["newCrowd"] = g.limit
    for _ in range(300):
        k = await g.acquire(); g.release("ok", k)
    r["recovered"] = g.limit
    off = m.EdgeGate()
    for _ in range(50): await off.acquire()
    r["offActive"] = off.active
    return r
print(json.dumps(asyncio.run(main())))
`);
    assert.equal(out.full, 12);
    assert.equal(out.afterBusy, 6);
    assert.equal(out.sameCrowd, 6, 'refusals from the same crowd halve only once');
    assert.ok(out.waited >= 0.2, `no new line during the pause (waited ${out.waited}s)`);
    assert.equal(out.newCrowd, 3, 'a line sent after the cut refused too: halve again');
    assert.equal(out.recovered, 12);
    assert.equal(out.offActive, 0, 'no limit before setup (single-line command)');
});

test('every line is voiced when Microsoft refuses more than 3 at once', { skip: !PY && 'app python_env not found' }, () => {
    const { out, stderr } = runPy(`
state = {"now": 0, "peak": 0, "refused": 0}
class Communicate:
    def __init__(self, **kw): pass
    async def save(self, path):
        state["now"] += 1
        state["peak"] = max(state["peak"], state["now"])
        try:
            await asyncio.sleep(0.05)
            if state["now"] > 3:
                state["refused"] += 1
                raise Exception("No audio was received. Please verify that your parameters are correct.")
            open(path, "wb").write(b"x")
        finally:
            state["now"] -= 1
fake.Communicate = Communicate
m.trim_silence = lambda p: {"duration": 1.0}
m.EdgeGate.PAUSE_SECONDS = 0.2
async def main():
    d = tempfile.mkdtemp()
    sem = asyncio.Semaphore(12)
    m.EDGE_GATE.setup(12)
    res = await asyncio.gather(*[m.generate_single_item("line", "km-KH-PisethNeural", "+0%", "+0Hz", "+0%", os.path.join(d, f"{i}.mp3"), sem) for i in range(36)])
    return {"ok": sum(1 for r in res if r.get("success")), "refused": state["refused"], "limit": m.EDGE_GATE.limit}
print(json.dumps(asyncio.run(main())))
`);
    assert.equal(out.ok, 36, `all lines voiced (refused ${out.refused} times)`);
    assert.ok(out.refused > 0, 'the stand-in did refuse the first crowd');
    assert.match(stderr, /\[TTS busy\]/);
});
