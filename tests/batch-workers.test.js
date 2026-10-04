// The real Batch Transcribe worker loop from frontend/js/dai-transcribe-studio.js (startBatch),
// run with a fake processSingleBatchItem. Covers Dub Whole Series' one-key-per-tab mode.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'dai-transcribe-studio.js'), 'utf8');
const start = src.indexOf('    const todo = [...pendingItems];');
const end = src.indexOf('    // Stopped (and maybe already restarted)');
const workerBlock = src.slice(start, end);

async function runBatch({ keys, tabs, deadKeys = [] }) {
    const state = { isBatchRunning: true, batchAbortController: { signal: { aborted: false } }, runningItemIds: new Set() };
    const pendingItems = Array.from({ length: tabs }, (_, i) => ({ id: `i${i}`, fileName: `tab${i + 1}`, status: 'pending' }));
    const apiKeys = keys;
    const concurrency = Math.max(1, Math.min(6, apiKeys.length, pendingItems.length));
    const keyStride = 1, keyPerTab = true, model = 'm', genre = 'g', glossaryDict = null, customFolder = '';
    const batchAbort = state.batchAbortController;
    const toasts = [];
    const showToast = (m) => toasts.push(m);
    const renderQueueTable = () => { }, refreshKeyStatuses = () => { };
    const window = {};
    const console = { warn: () => { }, error: () => { } };
    const calls = [];
    let running = 0, maxParallel = 0;
    const processSingleBatchItem = async (item, opts) => {
        calls.push(opts);
        running++; maxParallel = Math.max(maxParallel, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        if (deadKeys.includes(opts.apiKeys[0])) throw Object.assign(new Error('daily quota'), { isDailyQuota: true });
        Object.assign(item, { status: 'completed', by: opts.apiKeys[0] });
    };
    let quotaOut; // eslint-disable-line prefer-const
    await eval(`(async () => { ${workerBlock.replace('let quotaOut = false;', 'quotaOut = false;')} })()`);
    return { items: pendingItems, quotaOut, maxParallel, calls, toasts };
}

describe('Batch Transcribe, one key per tab', () => {
    test('the worker block is found in the source', () => {
        assert.ok(start > 0 && end > start, 'markers moved - update this test');
    });

    test('6 keys, 6 tabs: all at once, tab N on key N, other keys as backups, one request at a time, same model', async () => {
        const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
        const r = await runBatch({ keys, tabs: 6 });
        assert.equal(r.maxParallel, 6);
        assert.deepEqual(r.items.map((i) => i.by), keys);
        for (const c of r.calls) {
            assert.equal(c.apiKeys.length, keys.length); // own key first, then the backups
            assert.equal(c.maxLanes, 1);
            assert.equal(c.stayOnModel, true);
        }
    });

    test('fewer keys than tabs: the extra tabs wait for a key', async () => {
        const r = await runBatch({ keys: ['k1', 'k2', 'k3'], tabs: 6 });
        assert.equal(r.maxParallel, 3);
        assert.ok(r.items.every((i) => i.status === 'completed'));
    });

    test('a key out of daily quota hands its tab to a key that still has quota', async () => {
        const r = await runBatch({ keys: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'], tabs: 6, deadKeys: ['k3'] });
        assert.ok(r.items.every((i) => i.status === 'completed'));
        assert.equal(r.quotaOut, false);
        assert.ok(!r.items.some((i) => i.by === 'k3'));
    });

    test('a spare key (more keys than tabs) replaces one that ran out', async () => {
        const r = await runBatch({ keys: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7'], tabs: 6, deadKeys: ['k2'] });
        assert.ok(r.items.every((i) => i.status === 'completed'));
        assert.ok(r.items.some((i) => i.by === 'k7'));
    });

    test('every key out of quota: stops and says so', async () => {
        const r = await runBatch({ keys: ['k1', 'k2'], tabs: 4, deadKeys: ['k1', 'k2'] });
        assert.equal(r.quotaOut, true);
        assert.ok(r.items.every((i) => i.status === 'failed'));
        assert.ok(r.toasts.some((t) => /daily quota/i.test(t)));
    });
});
