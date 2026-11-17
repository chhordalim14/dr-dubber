// Gemini Web Router (backend/lib/gemini-web-router.js): a stopped job stops its request in the
// Python service too (the Gmail is let go at once, its audio file kept until then), a job stopped
// before its request is sent sends nothing, and an out-of-credits Gmail is parked until the time
// Google gives. The real router code against a fake Python service.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getEventListeners } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gweb-cancel-test-'));
process.env.APP_STORAGE_DIR = tmp;
const { getGeminiWebRouter } = require('../backend/lib/gemini-web-router');

const KEY = 'gweb:g1';
const AUDIO_PAYLOAD = {
    contents: [{ role: 'user', parts: [
        { text: 'Transcribe this.' },
        { inlineData: { mimeType: 'audio/mpeg', data: Buffer.from('fake mp3').toString('base64') } }
    ] }]
};

// fake.generate(body) -> a promise for the service's /generate answer.
function setup(fake) {
    const gw = getGeminiWebRouter();
    gw._settings = null;
    gw.inFlight.clear();
    gw.ensureService = async () => true;
    gw.keepSessionsAlive = async () => {};
    const calls = [];
    gw.call = async (pathname, body) => {
        calls.push({ pathname, body });
        if (pathname === '/generate') return fake.generate(body);
        if (pathname === '/cancel') return fake.cancel ? fake.cancel(body) : { ok: true, cancelled: true };
        return { ok: true, accounts: [] };
    };
    return { gw, calls };
}

describe('Gemini Web Router: stopping a job', () => {
    beforeEach(() => { getGeminiWebRouter()._settings = null; });

    test('a job stopped before the request is sent sends nothing', async () => {
        const { gw, calls } = setup({ generate: async () => ({ ok: true, text: 'x' }) });
        const ctrl = new AbortController();
        ctrl.abort();
        await assert.rejects(gw.generate(KEY, AUDIO_PAYLOAD, ctrl.signal), { name: 'AbortError' });
        assert.equal(calls.filter(c => c.pathname === '/generate').length, 0);
        assert.equal(gw.inFlight.get('g1') || 0, 0);
    });

    test('a job stopped mid-request cancels it in the service before the audio file is removed', async () => {
        let finishGenerate;
        let filesAtCancel = null;
        const { gw, calls } = setup({
            generate: () => new Promise((resolve) => { finishGenerate = resolve; }),
            cancel: (body) => {
                const gen = calls.find(c => c.pathname === '/generate');
                filesAtCancel = gen.body.files.map(f => fs.existsSync(f));
                // The service answers the stopped /generate once its task is cancelled.
                setTimeout(() => finishGenerate({ ok: false, code: 'CANCELLED', error: 'Stopped by DR Dubber' }), 20);
                return { ok: true, cancelled: true, requestId: body.requestId };
            }
        });
        const ctrl = new AbortController();
        const run = gw.generate(KEY, AUDIO_PAYLOAD, ctrl.signal);
        await new Promise(r => setTimeout(r, 20));
        assert.equal(gw.inFlight.get('g1'), 1);
        ctrl.abort();
        await assert.rejects(run, { name: 'AbortError' });

        const gen = calls.find(c => c.pathname === '/generate');
        const cancel = calls.find(c => c.pathname === '/cancel');
        assert.ok(gen.body.requestId, '/generate carries a requestId');
        assert.equal(cancel.body.requestId, gen.body.requestId, '/cancel names the same request');
        assert.deepEqual(filesAtCancel, [true], 'the audio file still exists when the service is told to stop');
        assert.equal(fs.existsSync(gen.body.files[0]), false, 'and is removed afterwards');
        assert.equal(gw.inFlight.get('g1'), 0, 'the Gmail is free again');
    });

    test('a finished request leaves no abort listener behind on the job signal', async () => {
        const { gw } = setup({ generate: async () => ({ ok: true, text: 'Hello', email: 'a@gmail.com' }) });
        const ctrl = new AbortController();
        for (let i = 0; i < 3; i++) {
            const r = await gw.generate(KEY, { contents: [{ parts: [{ text: 'hi' }] }] }, ctrl.signal);
            assert.equal(r.success, true);
        }
        assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0);
    });
});

describe('Gemini Web Router: out of credits', () => {
    test('parked until the reset time the service reports', async () => {
        const { gw } = setup({ generate: async () => ({ ok: false, code: 'QUOTA', error: 'Out of credits', retryAfterSec: 600 }) });
        const r = await gw.generate(KEY, { contents: [{ parts: [{ text: 'hi' }] }] });
        assert.equal(r.status, 429);
        assert.equal(r.isDailyQuota, true);
        assert.equal(r.retryAfterMs, 600 * 1000);
    });

    test('30 minutes when the service knows no reset time', async () => {
        const { gw } = setup({ generate: async () => ({ ok: false, code: 'QUOTA', error: 'Out of credits' }) });
        const r = await gw.generate(KEY, { contents: [{ parts: [{ text: 'hi' }] }] });
        assert.equal(r.retryAfterMs, 30 * 60 * 1000);
    });
});
