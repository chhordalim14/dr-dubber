// tts_generator.py: Microsoft turns lines away now and then ("No audio was received"). The
// generator tries a refused line again itself after a short wait, so it rarely goes back to the
// app, and never holds the other lines back meanwhile. A gate that did (2026-11-17/18: down to 2
// at once, then no line at all for 30-60 s) made 150 real lines take 500-1427 s instead of ~220 s,
// and lines ran past the server's time limit, so the app retried them anyway.
// Runs the app's Python with a stand-in edge_tts; skipped when python_env isn't there (git-ignored).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..');
const roots = [repo, path.join(repo, '..', '..', '..'), 'C:\\dr-dubber'];
const PY = roots.map((r) => path.join(r, 'backend', 'python_env', process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python')))
    .find((p) => fs.existsSync(p)) || process.env.PYTHON;
const SCRIPT = path.join(repo, 'backend', 'python', 'tts_generator.py');

// The stand-in refuses a line while refuse(text, tries so far) is true, else writes a clip.
function runPy(refuse, body) {
    const code = `
import sys, types, asyncio, json, importlib.util, tempfile, os
fake = types.ModuleType("edge_tts")
sys.modules["edge_tts"] = fake
spec = importlib.util.spec_from_file_location("tts", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.trim_silence = lambda p: {"duration": 1.0}
m.BUSY_WAIT_SECONDS = 0.05
state = {"now": 0, "peak": 0, "tries": {}, "done": []}
def refuse(text, tries):
    return ${refuse}
class Communicate:
    def __init__(self, text, **kw): self.text = text
    async def save(self, path):
        state["now"] += 1
        state["peak"] = max(state["peak"], state["now"])
        n = state["tries"].get(self.text, 0)
        state["tries"][self.text] = n + 1
        try:
            await asyncio.sleep(0.02)
            if refuse(self.text, n):
                raise Exception("No audio was received. Please verify that your parameters are correct.")
            open(path, "wb").write(b"x")
            state["done"].append(self.text)
        finally:
            state["now"] -= 1
fake.Communicate = Communicate
def line(text, d, sem=None):
    return m.generate_single_item(text, "km-KH-PisethNeural", "+0%", "+0Hz", "+0%", os.path.join(d, text + ".mp3"), sem)
${body}
`;
    const r = spawnSync(PY, ['-I', '-c', code], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('a refused line is tried again in the generator and voiced', { skip: !PY && 'app python_env not found' }, () => {
    const out = runPy('tries < 4', `
async def main():
    r = await line("a", tempfile.mkdtemp())
    return {"success": r.get("success"), "tries": state["tries"]["a"]}
print(json.dumps(asyncio.run(main())))
`);
    assert.equal(out.success, true);
    assert.equal(out.tries, 5, 'voiced on the last try the generator gives it');
});

test('a line refused every time goes back to the app with Microsoft\'s answer', { skip: !PY && 'app python_env not found' }, () => {
    const out = runPy('True', `
async def main():
    r = await line("a", tempfile.mkdtemp())
    return {"success": r.get("success"), "error": r.get("error"), "tries": state["tries"]["a"]}
print(json.dumps(asyncio.run(main())))
`);
    assert.equal(out.success, false);
    assert.match(out.error, /No audio was received/);
    assert.equal(out.tries, 5);
});

// Through generate_batch, which sets the generator up the way --serve does (the old gate only
// switched on there).
test('one refused line never holds the other lines back', { skip: !PY && 'app python_env not found' }, () => {
    const out = runPy('text == "stuck" and tries < 3', `
import io, contextlib, time
async def main():
    d = tempfile.mkdtemp()
    names = ["stuck"] + [f"l{i}" for i in range(35)]
    items = [{"id": n, "text": n, "output": os.path.join(d, n + ".mp3")} for n in names]
    t = time.monotonic()
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        await m.generate_batch(items, max_concurrency=12)
    res = json.loads(buf.getvalue().strip().splitlines()[-1])["results"]
    return {"ok": sum(1 for r in res if r.get("success")), "peak": state["peak"],
            "lastDone": state["done"][-1], "seconds": time.monotonic() - t}
print(json.dumps(asyncio.run(main())))
`);
    assert.equal(out.ok, 36, 'every line voiced');
    assert.equal(out.peak, 12, '12 went to Microsoft at once, none held back');
    assert.equal(out.lastDone, 'stuck', 'the others finished while the refused line waited');
    assert.ok(out.seconds < 1.5, `no pause for every line while one is refused (took ${out.seconds.toFixed(2)}s)`);
});
