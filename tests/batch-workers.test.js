// The real Batch Transcribe worker loop from frontend/js/dai-transcribe-studio.js (startBatch),
// run with a fake processSingleBatchItem. Covers Dub Whole Series' one-key-per-tab mode.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'dai-transcribe-studio.js'), 'utf8');
const start = src.indexOf('    // keyPerTab: the keys that are ready come first');
const end = src.indexOf('    // Stopped (and maybe already restarted)');
const workerBlock = src.slice(start, end);
const rankStart = src.indexOf('  function keyStatusRank(');
const rankBlock = src.slice(rankStart).match(/^[\s\S]*?\r?\n  \}\r?\n/)[0];
const SERIES_MAX_PARALLEL_FILES = Number(src.match(/const SERIES_MAX_PARALLEL_FILES = (\d+)/)[1]);
const BATCH_MAX_PARALLEL_FILES = Number(src.match(/const BATCH_MAX_PARALLEL_FILES = (\d+)/)[1]);
const SERIES_MAX_LANES_PER_TAB = Number(src.match(/const SERIES_MAX_LANES_PER_TAB = (\d+)/)[1]);
const keyStatusRank = eval(`(${rankBlock.trim()})`);
// The Router's ready Gmails ("gweb:") rank with the ready keys (dai-transcribe-studio.js isRouterKey).
const isRouterKey = eval(src.match(/const isRouterKey = (\(k\) => [^;]+);/)[1]);

// keyStatus: what the server reports per key ('ok' | 'daily' | 'invalid'); addLater: keys the
// user adds in Settings while the batch runs ({ key, afterMs }).
// parallel / retries: Dub Whole Series' "Episodes at once" and "Retry failed" (unset: the defaults).
async function runBatch({ keys, tabs, deadKeys = [], keyStatus = {}, addLater = [], parallel = null, retries = null }) {
    const TAB_RETRIES = 2;
    const seriesParallelFiles = () => parallel ?? SERIES_MAX_PARALLEL_FILES;
    const seriesTabRetries = () => retries ?? TAB_RETRIES;
    const state = { isBatchRunning: true, batchAbortController: { signal: { aborted: false } }, runningItemIds: new Set() };
    const pendingItems = Array.from({ length: tabs }, (_, i) => ({ id: `i${i}`, fileName: `tab${i + 1}`, status: 'pending' }));
    const apiKeys = keys;
    const maxParallel = null, keyPerTab = true, model = 'm', genre = 'g', glossaryDict = null, customFolder = '';
    const toasts = [];
    const showToast = (m) => toasts.push(m);
    const renderQueueTable = () => { }, refreshKeyStatuses = () => { };
    const window = {};
    const console = { warn: () => { }, error: () => { } };
    const calls = [];
    let running = 0, peak = 0;
    const processSingleBatchItem = async (item, opts) => {
        calls.push(opts);
        running++; peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        if (deadKeys.includes(opts.apiKeys[0])) throw Object.assign(new Error('daily quota'), { isDailyQuota: true });
        Object.assign(item, { status: 'completed', by: opts.apiKeys[0] });
    };
    const pool = [...keys];
    const getActiveApiKeys = () => [...pool];
    for (const { key, afterMs } of addLater) global.setTimeout(() => pool.push(key), afterMs);
    const getBackendBase = () => 'http://localhost:3001';
    const refreshRouterKeys = async () => { }; // the merged list is `keys` itself
    const fetch = async (url, init) => {
        const sent = JSON.parse(init.body).keys;
        return { json: async () => ({ keys: sent.map((k) => ({ suffix: k.slice(-4), state: keyStatus[k] || 'ok', models: [] })) }) };
    };
    const setTimeout = (fn, ms) => global.setTimeout(fn, Math.min(ms, 15)); // the 5 s spare-key wait, sped up
    let quotaOut; // eslint-disable-line prefer-const
    await eval(`(async () => { ${workerBlock.replace('let quotaOut = false;', 'quotaOut = false;')} })()`);
    return { items: pendingItems, quotaOut, maxParallel: peak, calls, toasts };
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

    test('"Episodes at once" limits how many tabs run together; 10 lets 10 run', async () => {
        const keys = Array.from({ length: 12 }, (_, i) => `k${i + 1}`);
        const three = await runBatch({ keys, tabs: 6, parallel: 3 });
        assert.equal(three.maxParallel, 3);
        assert.ok(three.items.every((i) => i.status === 'completed'));
        const ten = await runBatch({ keys, tabs: 12, parallel: 10 });
        assert.equal(ten.maxParallel, 10);
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

    test('12 keys, 12 tabs: 8 at a time, keys 9-12 replace ones that run out', async () => {
        const keys = Array.from({ length: 12 }, (_, i) => `k${i + 1}`);
        const r = await runBatch({ keys, tabs: 12, deadKeys: ['k1', 'k2'] });
        assert.equal(r.maxParallel, SERIES_MAX_PARALLEL_FILES);
        assert.ok(r.items.every((i) => i.status === 'completed'));
        assert.ok(!r.items.some((i) => i.by === 'k1' || i.by === 'k2'));
        assert.ok(r.items.some((i) => ['k9', 'k10', 'k11', 'k12'].includes(i.by)));
    });

    test('a part of 7 tabs: all 7 at once (the 7th no longer waits for a free key)', async () => {
        const keys = Array.from({ length: 10 }, (_, i) => `k${i + 1}`);
        const r = await runBatch({ keys, tabs: 7 });
        assert.equal(r.maxParallel, 7);
        assert.deepEqual(r.items.map((i) => i.by), keys.slice(0, 7));
    });

    test('keys refused by Google or out for today get no tab of their own; ready keys go first', async () => {
        const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
        const r = await runBatch({ keys, tabs: 6, keyStatus: { k1: 'invalid', k2: 'daily' } });
        assert.equal(r.maxParallel, 4, 'only the 4 ready keys carry a tab');
        assert.ok(r.items.every((i) => i.status === 'completed'));
        assert.deepEqual([...new Set(r.items.map((i) => i.by))].sort(), ['k3', 'k4', 'k5', 'k6']);
    });

    test('every key resting: the keys in their own order (the server says why they fail)', async () => {
        const r = await runBatch({ keys: ['k1', 'k2'], tabs: 2, keyStatus: { k1: 'invalid', k2: 'daily' } });
        assert.deepEqual(r.items.map((i) => i.by), ['k1', 'k2']);
    });

    test('a spare that is rejected or already out for today is skipped', async () => {
        const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9'];
        const r = await runBatch({ keys, tabs: 6, deadKeys: ['k1'], keyStatus: { k7: 'invalid', k8: 'daily' } });
        assert.ok(r.items.every((i) => i.status === 'completed'));
        assert.ok(!r.items.some((i) => i.by === 'k7' || i.by === 'k8'));
    });

    test('a key added in Settings while the batch runs is picked up', async () => {
        const r = await runBatch({ keys: ['k1', 'k2'], tabs: 6, deadKeys: ['k1'], addLater: [{ key: 'k-new', afterMs: 30 }] });
        assert.ok(r.items.every((i) => i.status === 'completed'));
        assert.ok(r.items.some((i) => i.by === 'k-new'));
    });

    test('more ready keys than tabs: each tab borrows its own spare keys as extra lanes', async () => {
        const keys = Array.from({ length: 12 }, (_, i) => `k${i + 1}`);
        const r = await runBatch({ keys, tabs: 4 });
        assert.equal(r.maxParallel, 4);
        const borrowed = [];
        for (const c of r.calls) {
            assert.equal(c.maxLanes, 3, 'own key + 2 of the 8 spares');
            assert.equal(c.spread, true);
            assert.equal(c.apiKeys.length, keys.length, 'every key still there as a backup');
            borrowed.push(...c.apiKeys.slice(1, c.maxLanes));
        }
        assert.equal(new Set(borrowed).size, borrowed.length, 'no spare is lent to two tabs');
        assert.ok(borrowed.every((k) => !['k1', 'k2', 'k3', 'k4'].includes(k)), 'no tab borrows another tab\'s own key');
    });

    test('lanes per tab are capped (2 tabs, 20 keys: 4 lanes each, not 10)', async () => {
        const keys = Array.from({ length: 20 }, (_, i) => `k${i + 1}`);
        const r = await runBatch({ keys, tabs: 2 });
        for (const c of r.calls) assert.equal(c.maxLanes, SERIES_MAX_LANES_PER_TAB);
    });

    test('a spare out for today is not borrowed', async () => {
        const keys = ['k1', 'k2', 'k3', 'k4'];
        const r = await runBatch({ keys, tabs: 2, keyStatus: { k3: 'daily' } });
        for (const c of r.calls) assert.ok(!c.apiKeys.slice(1, c.maxLanes).includes('k3'));
    });

    test('every key out of quota: stops and says so', async () => {
        const r = await runBatch({ keys: ['k1', 'k2'], tabs: 4, deadKeys: ['k1', 'k2'] });
        assert.equal(r.quotaOut, true);
        assert.ok(r.items.every((i) => i.status === 'failed'));
        assert.ok(r.toasts.some((t) => /daily quota/i.test(t)));
    });
});

// Gemini Web Router Gmails ("gweb:") in Dub Whole Series. The list the batch gets is the merged one
// (getActiveApiKeys = mergeRouterKeys(Settings keys)): with Router first the ready Gmails lead.
// They were lost when DR Router was removed (bcb7540), and a series ran only as many tabs as
// Settings keys - 2 tabs for 10 Gmails and 2 API keys.
describe('Batch Transcribe, Gemini Web Router Gmails own tabs', () => {
    const gmails = (n) => Array.from({ length: n }, (_, i) => `gweb:g${i + 1}`);

    test('10 Gmails + 2 API keys: 8 tabs at once ("Episodes at once"), each on its own Gmail, one lane each', async () => {
        const keys = [...gmails(10), 'k1', 'k2'];
        const r = await runBatch({ keys, tabs: 8 });
        assert.equal(r.maxParallel, 8);
        assert.ok(r.items.every((i) => i.by.startsWith('gweb:')), 'every tab owned by a Gmail');
        assert.equal(new Set(r.items.map((i) => i.by)).size, 8);
        for (const c of r.calls) {
            assert.equal(c.maxLanes, 1, 'floor(10 Gmails / 8 tabs) lanes: no Gmail asked for twice');
            assert.equal(c.spread, false, 'Gmails are never lent as spread lanes');
            assert.ok(c.apiKeys.includes('k1') && c.apiKeys.includes('k2'), 'API keys stay as backups');
        }
    });

    test('Gmails not checked like API keys still lead (they are listed only while ready)', async () => {
        const keys = [...gmails(3), 'k1'];
        const keyStatus = { 'gweb:g1': 'unknown', 'gweb:g2': 'unknown', 'gweb:g3': 'unknown' }; // rank 1 without isRouterKey
        const r = await runBatch({ keys, tabs: 3, keyStatus });
        assert.deepEqual(r.items.map((i) => i.by), gmails(3));
    });

    test('3 Gmails, 2 tabs: one lane each (floor(3 / 2)), the third Gmail stays free as a backup', async () => {
        const r = await runBatch({ keys: gmails(3), tabs: 2 });
        assert.equal(r.maxParallel, 2);
        for (const c of r.calls) assert.equal(c.maxLanes, 1);
    });

    test('Gmails only: a series runs with no Settings key at all', async () => {
        const r = await runBatch({ keys: gmails(4), tabs: 4 });
        assert.equal(r.maxParallel, 4);
        assert.ok(r.items.every((i) => i.status === 'completed'));
    });
});

describe('mergeRouterKeys (Settings keys + the Router\'s ready Gmails)', () => {
    const at = src.indexOf('  const routerPool = {');
    const block = src.slice(at, src.indexOf('  const getActiveApiKeys = ', at));
    const load = (pool) => eval(`(() => { ${block.replace(/async function refreshRouterKeys[\s\S]*?\n  }\n/, '')}; Object.assign(routerPool, ${JSON.stringify(pool)}); return mergeRouterKeys; })()`);

    test('Router first: Gmails lead, Settings keys follow as backups', () => {
        const merge = load({ keys: ['gweb:a', 'gweb:b'], routerFirst: true, gmailOnly: false });
        assert.deepEqual(merge(['k1', 'k2']), ['gweb:a', 'gweb:b', 'k1', 'k2']);
    });
    test('Gmails only: just the Gmails (while any is ready)', () => {
        const merge = load({ keys: ['gweb:a'], routerFirst: true, gmailOnly: true });
        assert.deepEqual(merge(['k1']), ['gweb:a']);
        const none = load({ keys: [], routerFirst: true, gmailOnly: true });
        assert.deepEqual(none(['k1']), ['k1'], 'no ready Gmail: the Settings keys still work');
    });
    test('Router first off: Settings keys first, Gmails after', () => {
        const merge = load({ keys: ['gweb:a'], routerFirst: false, gmailOnly: false });
        assert.deepEqual(merge(['k1']), ['k1', 'gweb:a']);
    });
    test('Router off (no ready Gmails listed): Settings keys unchanged', () => {
        const merge = load({ keys: [], routerFirst: false, gmailOnly: false });
        assert.deepEqual(merge(['k1', 'k2']), ['k1', 'k2']);
    });
    test('Smart Task Split: API keys lead for transcribe, Gmails lead for translate', () => {
        const merge = load({ keys: ['gweb:a'], routerFirst: true, gmailOnly: false, taskSplit: true });
        assert.deepEqual(merge(['k1'], 'transcribe'), ['k1', 'gweb:a']);
        assert.deepEqual(merge(['k1'], 'translate'), ['gweb:a', 'k1']);
    });
});
