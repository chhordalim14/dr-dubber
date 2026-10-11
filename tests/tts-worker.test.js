// The long-running voice generator (backend/lib/tts-worker.js), driven by a fake worker that
// speaks the same stdin/stdout protocol as `tts_generator.py --serve`: one JSON line per
// request, one per result. Text controls the fake: "slow" answers late, "die" exits, "hang"
// never answers. The real generator is checked by hand (it needs Edge's servers).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createTtsWorker, MAX_FAILED_STARTS } = require('../backend/lib/tts-worker');

const FAKE = `
const rl = require('readline').createInterface({ input: process.stdin });
let active = 0, peak = 0;
const cancelled = new Set();
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.cancel) { cancelled.add(m.cancel); return; }
  if (m.text === 'die') process.exit(3);
  if (m.text === 'hang') return;
  active++; peak = Math.max(peak, active);
  setTimeout(() => {
    active--;
    if (cancelled.has(m.id)) return;
    process.stdout.write(JSON.stringify({ id: m.id, success: true, file: m.output, duration: 1.5, peak }) + '\\n');
  }, m.text === 'slow' ? 150 : 20);
});
`;

let spawned = 0;
const fakeWorker = (opts = {}) => createTtsWorker({
    spawnWorker: () => { spawned++; return spawn(process.execPath, ['-e', FAKE]); },
    ...opts,
});
const line = (text, n = 0) => ({ text, voice: 'km-KH-PisethNeural', rate: '+0%', pitch: '+0Hz', volume: '+0%', output: `out${n}.mp3` });

test('each result goes back to its own request, through one process', async () => {
    const before = spawned;
    const w = fakeWorker();
    const res = await Promise.all([0, 1, 2, 3].map((n) => w.request(line(n % 2 ? 'slow' : 'hi', n)).promise));
    assert.deepEqual(res.map((r) => r.file), ['out0.mp3', 'out1.mp3', 'out2.mp3', 'out3.mp3']);
    assert.ok(res.every((r) => r.success && r.duration === 1.5));
    assert.equal(spawned - before, 1);
    w.stop();
});

test('never more than maxInFlight lines at once in the worker', async () => {
    const w = fakeWorker({ maxInFlight: 2 });
    const res = await Promise.all(Array.from({ length: 7 }, (_, n) => w.request(line('slow', n)).promise));
    assert.ok(res.every((r) => r.success));
    assert.ok(Math.max(...res.map((r) => r.peak)) <= 2);
    w.stop();
});

test('cancel answers at once, queued or in the worker', async () => {
    const w = fakeWorker({ maxInFlight: 1 });
    const running = w.request(line('slow', 1));
    const queued = w.request(line('hi', 2));
    queued.cancel();
    running.cancel();
    assert.equal((await running.promise).cancelled, true);
    assert.equal((await queued.promise).cancelled, true);
    // The worker is still usable afterwards.
    assert.equal((await w.request(line('hi', 3)).promise).success, true);
    w.stop();
});

test('a line that never answers times out without blocking the others', async () => {
    const w = fakeWorker({ maxInFlight: 1, timeoutMs: 200 });
    const hung = w.request(line('hang', 1));
    const next = w.request(line('hi', 2));
    const r = await hung.promise;
    assert.equal(r.success, false);
    assert.match(r.error, /timed out/);
    assert.equal((await next.promise).success, true);
    w.stop();
});

test('a worker that dies fails only its lines and is started again', async () => {
    const w = fakeWorker();
    assert.equal((await w.request(line('hi', 1)).promise).success, true); // it has answered once
    const r = await w.request(line('die', 2)).promise;
    assert.equal(r.success, false);
    assert.equal(r.workerDied, true);
    assert.equal((await w.request(line('hi', 3)).promise).success, true);
    assert.equal(w.usable(), true);
    w.stop();
});

test('a worker that keeps dying before it answers is given up (one process per line again)', async () => {
    const w = fakeWorker();
    for (let k = 0; k < MAX_FAILED_STARTS; k++) {
        assert.equal(w.usable(), true);
        assert.equal((await w.request(line('die', k)).promise).workerDied, true);
    }
    assert.equal(w.usable(), false);
});

test('a worker that cannot be started at all fails the line instead of hanging', async () => {
    const w = createTtsWorker({ spawnWorker: () => { throw new Error('No Python'); } });
    const r = await w.request(line('hi')).promise;
    assert.equal(r.success, false);
    assert.equal(r.workerDied, true);
});
