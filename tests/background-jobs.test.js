// Long requests as background jobs: the real backgroundable() + /api/job-result from
// backend/server.js, called through the real frontend/js/backend-jobs.js.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
const start = serverSrc.indexOf('const backgroundJobs = new Map();');
const end = serverSrc.indexOf('\n});', serverSrc.indexOf("app.get('/api/job-result'")) + 4;
const serverBlock = serverSrc.slice(start, end);

const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'backend-jobs.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, base, backendJobs, backgroundable, jobs;
before(async () => {
    const app = express();
    app.use(express.json());
    ({ backgroundable, backgroundJobs: jobs } = new Function('app', `${serverBlock}; return { backgroundable, backgroundJobs };`)(app));
    let running = 0;
    app.post('/api/slow', backgroundable(async (req, res) => {
        running++;
        await sleep(req.body.ms || 150);
        running--;
        if (req.body.fail) return res.status(429).json({ success: false, error: 'RATE_LIMIT_EXCEEDED' });
        if (req.body.throw) throw new Error('boom');
        if (req.body.silent) return;
        res.json({ success: true, echo: req.body.value, running });
    }));
    app.get('/api/quick', (req, res) => res.json({ ok: true }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;

    const window = {};
    vm.runInNewContext(clientSrc, {
        window, fetch, Response, DOMException, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval,
        crypto: globalThis.crypto, URL, location: { href: `${base}/` }
    });
    backendJobs = window.backendJobs;
});
after(() => server.close());

describe('background jobs', () => {
    test('the server block is found in the source', () => {
        assert.ok(start > 0 && end > start && serverBlock.includes('function backgroundable'), 'markers moved - update this test');
    });

    test('the route answers at once; the result comes back like a normal response', async () => {
        const t0 = Date.now();
        const res = await backendJobs.postJob(`${base}/api/slow`, { body: JSON.stringify({ value: 'hi', ms: 200 }) });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { success: true, echo: 'hi', running: 0 });
        assert.ok(Date.now() - t0 >= 200);
    });

    test('no connection is held while the job runs', async () => {
        let first;
        const startedRes = await fetch(`${base}/api/slow`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Background-Job': 'held-1' }, body: JSON.stringify({ ms: 400 })
        });
        first = await startedRes.json();
        assert.deepEqual(first, { success: true, background: true, jobId: 'held-1' });
        assert.deepEqual(await (await fetch(`${base}/api/job-result?id=held-1`)).json(), { success: true, done: false });
        await sleep(500);
        const done = await (await fetch(`${base}/api/job-result?id=held-1`)).json();
        assert.equal(done.done, true);
        assert.equal(done.status, 200);
    });

    test('an error status and body are passed through', async () => {
        const res = await backendJobs.postJob(`${base}/api/slow`, { body: JSON.stringify({ fail: true, ms: 10 }) });
        assert.equal(res.status, 429);
        assert.equal((await res.json()).error, 'RATE_LIMIT_EXCEEDED');
    });

    test('a handler that throws, or ends without answering, still gives a result', async () => {
        const thrown = await backendJobs.postJob(`${base}/api/slow`, { body: JSON.stringify({ throw: true, ms: 10 }) });
        assert.equal(thrown.status, 500);
        assert.equal((await thrown.json()).error, 'boom');
        const silent = await backendJobs.postJob(`${base}/api/slow`, { body: JSON.stringify({ silent: true, ms: 10 }) });
        assert.equal(silent.status, 500);
    });

    test('without the header the route works as before', async () => {
        const res = await fetch(`${base}/api/slow`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 1, ms: 10 }) });
        assert.equal((await res.json()).echo, 1);
    });

    test('aborting stops the wait with an AbortError, like fetch', async () => {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 100);
        await assert.rejects(
            backendJobs.postJob(`${base}/api/slow`, { body: JSON.stringify({ ms: 2000 }), signal: ctrl.signal }),
            (e) => e.name === 'AbortError'
        );
    });

    test('a job the server lost (restarted) fails instead of waiting forever', async () => {
        const res = backendJobs.postJob(`${base}/api/slow`, { body: JSON.stringify({ ms: 3000 }) });
        await sleep(50);
        jobs.clear();
        await assert.rejects(res, /lost this job/);
    });

    test('a progress poll is skipped while the last one is still waiting', async () => {
        let calls = 0, inFlight = 0, maxInFlight = 0;
        const id = backendJobs.pollEvery(20, async (signal) => {
            assert.ok(signal instanceof AbortSignal);
            calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
            await sleep(90);
            inFlight--;
        });
        await sleep(400);
        clearInterval(id);
        assert.equal(maxInFlight, 1);
        assert.ok(calls >= 2 && calls <= 5, `calls=${calls}`);
    });
});
