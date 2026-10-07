// backend/text_detect_service.js: the job queue around the subtitle text detector, run with a
// fake Python process (spawn) and a fake dependency check (execFile).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createTextDetectService } = require('../backend/text_detect_service');

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// A fake detector process the test drives: emit progress, finish with a result or fail.
function fakeChild() {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.killed = false;
    c.say = (line) => c.stdout.emit('data', Buffer.from(line + '\n'));
    c.done = (result) => { c.say(JSON.stringify({ success: true, ...result })); c.emit('close', 0); };
    c.fail = (error) => { c.say(JSON.stringify({ success: false, error })); c.emit('close', 1); };
    return c;
}

function makeService({ depsOk = true, installFixes = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textdetect-'));
    const videos = ['a', 'b', 'c'].map((n) => {
        const f = path.join(dir, `${n}.mp4`);
        fs.writeFileSync(f, n);
        return f;
    });
    const children = [];
    const killed = [];
    const calls = [];
    let installed = depsOk;
    const svc = createTextDetectService({
        pythonCmd: 'python', pythonEnv: {}, scriptPath: 'text_detector.py', requirementsPath: 'req.txt', ffmpegPath: 'ffmpeg',
        cacheDir: path.join(dir, 'cache'),
        spawn: (cmd, args) => { const c = fakeChild(); c.args = args; children.push(c); return c; },
        execFile: (cmd, args, opts, cb) => {
            calls.push(args.join(' '));
            if (args[0] === '-m') { installed = installFixes; return cb(installFixes ? null : new Error('pip'), '', installFixes ? '' : 'ERROR: no internet'); }
            cb(installed ? null : new Error('import'), '', installed ? '' : 'ModuleNotFoundError');
        },
        killProcessTree: (c) => killed.push(c),
        log: { log: () => { }, warn: () => { } },
    });
    return { svc, videos, children, killed, calls, dir };
}

const result = { row: { y: 66, h: 7 }, segments: [{ start: 1, end: 2, x: 30, y: 66, w: 40, h: 7 }], width: 1080, height: 1920, duration: 10, seconds: 3 };

describe('subtitle text detection jobs', () => {
    test('a job runs, reports progress, and keeps the result', async () => {
        const { svc, videos, children } = makeService();
        const j = svc.start(videos[0]);
        assert.equal(j.success, true);
        await tick();
        assert.equal(children.length, 1);
        assert.deepEqual(children[0].args.slice(1), [videos[0], '--fps', '4']);
        assert.equal(svc.status(j.jobId).status, 'running');
        children[0].say('PROGRESS 25 100');
        assert.equal(svc.status(j.jobId).progress, 25);
        children[0].done(result);
        const st = svc.status(j.jobId);
        assert.equal(st.status, 'done');
        assert.equal(st.progress, 100);
        assert.deepEqual(st.result.segments, result.segments);
    });

    test('one video at a time; asking again for a video in line joins its job', async () => {
        const { svc, videos, children } = makeService();
        const a = svc.start(videos[0]);
        const b = svc.start(videos[1]);
        const a2 = svc.start(videos[0]);
        assert.equal(a2.jobId, a.jobId);
        await tick();
        assert.equal(children.length, 1, 'b waits');
        assert.equal(svc.status(b.jobId).status, 'queued');
        children[0].done(result);
        await tick();
        assert.equal(children.length, 2, 'b starts when a is done');
        assert.equal(svc.status(b.jobId).status, 'running');
    });

    test('a finished video is answered from the cache, without running again', async () => {
        const { svc, videos, children } = makeService();
        const a = svc.start(videos[0]);
        await tick();
        children[0].done(result);
        const again = svc.start(videos[0]);
        assert.notEqual(again.jobId, a.jobId);
        assert.equal(again.status, 'done');
        assert.deepEqual(again.result.segments, result.segments);
        assert.equal(children.length, 1);
    });

    test('a changed video file is read again', async () => {
        const { svc, videos, children } = makeService();
        svc.start(videos[0]);
        await tick();
        children[0].done(result);
        fs.writeFileSync(videos[0], 'a different video');
        const again = svc.start(videos[0]);
        assert.notEqual(again.status, 'done');
        await tick();
        assert.equal(children.length, 2);
    });

    test('cancel: a running job is killed, a queued one never starts, the next one goes on', async () => {
        const { svc, videos, children, killed } = makeService();
        const a = svc.start(videos[0]);
        const b = svc.start(videos[1]);
        const c = svc.start(videos[2]);
        await tick();
        svc.cancel(b.jobId);
        svc.cancel(a.jobId);
        assert.equal(killed.length, 1);
        assert.equal(svc.status(a.jobId).status, 'cancelled');
        assert.equal(svc.status(b.jobId).status, 'cancelled');
        children[0].emit('close', 1); // the killed process ends: no result, no error over the cancel
        assert.equal(svc.status(a.jobId).status, 'cancelled');
        await tick();
        assert.equal(children.length, 2);
        assert.equal(children[1].args[1], videos[2]);
        assert.equal(svc.status(c.jobId).status, 'running');
    });

    test('a detector error is reported and not cached', async () => {
        const { svc, videos, children } = makeService();
        const a = svc.start(videos[0]);
        await tick();
        children[0].fail('Could not read the video (size or length unknown).');
        const st = svc.status(a.jobId);
        assert.equal(st.status, 'error');
        assert.match(st.error, /Could not read the video/);
        assert.notEqual(svc.start(videos[0]).status, 'done');
    });

    test('a missing video and an unknown job are answered plainly', () => {
        const { svc, dir } = makeService();
        assert.equal(svc.start(path.join(dir, 'nope.mp4')).success, false);
        assert.equal(svc.status('td_nope').status, 'unknown');
    });

    test('missing packages are installed once (pinned, --no-deps), then the job runs', async () => {
        const { svc, videos, children, calls } = makeService({ depsOk: false });
        svc.start(videos[0]);
        await tick(20);
        assert.ok(calls.some((c) => /^-m pip install --no-deps .* -r req\.txt$/.test(c)), calls.join('\n'));
        assert.equal(children.length, 1);
    });

    test('packages that cannot be installed: a clear error, and another try next time', async () => {
        const { svc, videos, children, calls } = makeService({ depsOk: false, installFixes: false });
        const a = svc.start(videos[0]);
        await tick(20);
        assert.equal(children.length, 0);
        const st = svc.status(a.jobId);
        assert.equal(st.status, 'error');
        assert.match(st.error, /could not be installed: .*no internet/);
        const pipCalls = calls.filter((c) => c.startsWith('-m pip')).length;
        svc.start(videos[1]);
        await tick(20);
        assert.equal(calls.filter((c) => c.startsWith('-m pip')).length, pipCalls + 1);
    });
});
