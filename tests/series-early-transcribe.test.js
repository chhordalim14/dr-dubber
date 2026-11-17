// Dub Whole Series transcribes the next part while the current part is voiced and blurred:
// transcribeFilesEarly (frontend/js/dai-transcribe-studio.js) runs the pieces with no tab and no
// queue row, only saving each result, and the series (frontend/js/studio-main.js) cuts the next
// part early, reuses those pieces in its Split step and waits for the early run in Transcribe.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', f), 'utf8').replace(/\r\n/g, '\n');
const dai = read('dai-transcribe-studio.js');
const main = read('studio-main.js');
const cut = (src, from, to) => {
    const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
    assert.ok(a > 0 && b > a, `markers moved - update this test: ${from}`);
    return src.slice(a, b);
};

const earlyFn = cut(dai, '  async function transcribeFilesEarly(', '  async function loadSavedBatchResult(');
const rankFn = cut(dai, '  function keyStatusRank(', '  // A tab that failed for a passing reason');
const LANES = Number(dai.match(/const SERIES_MAX_LANES_PER_TAB = (\d+)/)[1]);

// keyStatus: what the server says per key; fail: file -> error thrown by processSingleBatchItem.
function load({ keys, keyStatus = {}, fail = {}, parallel = 8 }) {
    const calls = [];
    const cancelled = [];
    let running = 0, peak = 0;
    const processSingleBatchItem = async (item, opts) => {
        calls.push({ file: item.filePath, ...opts });
        running++; peak = Math.max(peak, running);
        try {
            await new Promise((r, j) => {
                const t = setTimeout(r, 20);
                opts.signal?.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('Aborted'), { name: 'AbortError' })); });
            });
            if (fail[item.filePath]) throw fail[item.filePath];
        } finally { running--; }
    };
    const fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (url.endsWith('/api/cancel-transcribe')) { cancelled.push(body.requestId); return { json: async () => ({}) }; }
        return { json: async () => ({ keys: body.keys.map((k) => ({ state: keyStatus[k] || 'ok', models: [] })) }) };
    };
    const fn = new Function('processSingleBatchItem', 'fetch', 'getActiveApiKeys', 'seriesParallelFiles', 'console', `
        const SERIES_MAX_LANES_PER_TAB = ${LANES};
        const state = { glossary: [], outputFolder: '' };
        const localStorage = { getItem: () => null };
        const $ = () => null;
        const getBackendBase = () => 'http://x';
        const getDramaGenre = () => 'comedy';
        const getActiveModel = () => 'm';
        const loadGlossaryFromStorage = () => { };
        const refreshRouterKeys = async () => { }; // the Router's Gmails: already in getActiveApiKeys()
        const isRouterKey = (k) => String(k || '').startsWith('gweb:');
        ${rankFn}
        ${earlyFn}
        return transcribeFilesEarly;
    `)(processSingleBatchItem, fetch, () => [...keys], () => parallel, { warn: () => { }, log: () => { } });
    return { transcribeFilesEarly: fn, calls, cancelled, peak: () => peak };
}

describe('transcribeFilesEarly: the next part\'s pieces, no tab', () => {
    test('one ready key per piece, spare keys lent as lanes, same settings as the series step', async () => {
        const keys = Array.from({ length: 12 }, (_, i) => `k${i + 1}`);
        const t = load({ keys });
        const files = ['/s/p1.mp4', '/s/p2.mp4', '/s/p3.mp4', '/s/p4.mp4'];
        const progress = [];
        const r = await t.transcribeFilesEarly(files, { onProgress: (n) => progress.push(n) });
        assert.deepEqual(r, { total: 4, done: 4, failed: 0 });
        assert.equal(t.peak(), 4);
        assert.deepEqual(t.calls.map((c) => c.file).sort(), files);
        for (const c of t.calls) {
            assert.equal(c.maxLanes, 3, 'own key + 2 of the 8 spares');
            assert.equal(c.spread, true);
            assert.equal(c.forSeries, true);
            assert.equal(c.stayOnModel, true);
            assert.equal(c.early, true, 'the server saves the result itself');
        }
        const own = t.calls.map((c) => c.apiKeys[0]);
        assert.equal(new Set(own).size, 4);
        const lent = t.calls.flatMap((c) => c.apiKeys.slice(1, c.maxLanes));
        assert.equal(new Set(lent).size, lent.length, 'no spare lent twice');
        assert.ok(lent.every((k) => !own.includes(k)));
        assert.deepEqual(progress, [1, 2, 3, 4]);
    });

    test('"Episodes at once" caps the pieces running together', async () => {
        const keys = Array.from({ length: 12 }, (_, i) => `k${i + 1}`);
        const t = load({ keys, parallel: 2 });
        const r = await t.transcribeFilesEarly(['a', 'b', 'c', 'd', 'e']);
        assert.equal(r.done, 5);
        assert.equal(t.peak(), 2);
    });

    test('a piece that fails is left for the part\'s own step; the others go on', async () => {
        const t = load({ keys: ['k1', 'k2', 'k3'], fail: { b: Object.assign(new Error('busy'), { status: 503 }) } });
        const r = await t.transcribeFilesEarly(['a', 'b', 'c']);
        assert.deepEqual(r, { total: 3, done: 2, failed: 1 });
    });

    test('keys resting or out for today get no piece; no ready key: nothing is sent', async () => {
        const t = load({ keys: ['k1', 'k2', 'k3'], keyStatus: { k1: 'invalid', k2: 'daily' } });
        await t.transcribeFilesEarly(['a', 'b']);
        assert.ok(t.calls.every((c) => c.apiKeys[0] === 'k3'));
        const none = load({ keys: ['k1'], keyStatus: { k1: 'daily' } });
        const r = await none.transcribeFilesEarly(['a']);
        assert.equal(none.calls.length, 0);
        assert.equal(r.done, 0);
    });

    test('Stop: the running pieces are cancelled on the server and nothing new starts', async () => {
        const t = load({ keys: ['k1', 'k2'] });
        const ctrl = new AbortController();
        const p = t.transcribeFilesEarly(['a', 'b', 'c', 'd'], { signal: ctrl.signal });
        await new Promise((r) => setTimeout(r, 5));
        ctrl.abort();
        const r = await p;
        assert.equal(r.done, 0);
        assert.equal(t.calls.length, 2, 'only the two already running');
        assert.equal(t.cancelled.length, 2);
    });

    test('an early item asks the server to save, and the app does not save it a second time', () => {
        const item = cut(dai, '  async function processSingleBatchItem(', '  // PREVIEW / SUBTITLE EDITOR DRAWER');
        assert.match(item, /\.\.\.\(early \? \{ saveResult: true \} : \{\}\)/);
        assert.match(item, /!incomplete && !early\)/);
    });

    test('is on window.daiStudio', () => {
        assert.match(dai, /transcribeAllTabs,\n\s+transcribeFilesEarly,/);
    });
});

describe('the series uses it', () => {
    test('the next part starts right after this part\'s Transcribe (also when Transcribe was already done)', () => {
        const loop = cut(main, '        for (const [name, fn] of [["transcribe", transcribeStep]', '        // The SRTs saved after Transcribe');
        assert.match(loop, /if \(plan\.stepState\[name\]\?\.state !== "done"\) await runStep\(name, fn\);/);
        assert.match(loop, /if \(name === "transcribe"\) startEarlyTranscribe\(i\);/);
    });

    test('Transcribe waits for the early run of its own part, then runs as before (saved results are reused)', () => {
        const step = cut(main, '      async function transcribeStep() {', '        const emptyTabs = ');
        assert.match(step, /earlyRun\.index === plan\.current/);
        assert.match(step, /while \(job\.phase !== "finished"\)/);
        assert.match(step, /checkStop\(\)/);
    });

    test('Split reuses the early pieces only when they still fit, and stops an early run it can\'t use', () => {
        const step = cut(main, '      async function splitStep() {', '      // ── The next part, transcribed early ──');
        assert.match(step, /await earlyPiecesFor\(plan\.current\)/);
        assert.match(step, /stopSeriesEarlyTranscribe\(\)/);
    });

    test('Stop stops the early run too', () => {
        const stop = cut(main, '    function stopSeriesRun() {', '    (() => {');
        assert.match(stop, /stopSeriesEarlyTranscribe\(\)/);
    });

    describe('earlyPiecesFor', () => {
        const fnSrc = cut(main, '      async function earlyPiecesFor(k) {', '      async function splitStep() {');
        const make = ({ part, minutes = 7, inspect }) => new Function('plan', 'splitMinutes', 'postJson', 'API', `${fnSrc}; return earlyPiecesFor;`)(
            { parts: [part] }, () => minutes, async (url, body) => inspect(body.file), 'http://x');
        const early = { pieces: ['/s/a.mp4', '/s/b.mp4'], note: '2 tabs', duration: 840, minutes: 7, outPath: '/j/p2.mp4' };
        const ok = (file) => ({ success: true, duration: file === '/j/p2.mp4' ? 840.4 : 420 });

        test('pieces still there, same tab length and joined file: reused', async () => {
            const f = make({ part: { outPath: '/j/p2.mp4', early }, inspect: ok });
            assert.equal(await f(0), early);
        });
        test('tab length changed: cut again', async () => {
            const f = make({ part: { outPath: '/j/p2.mp4', early }, minutes: 5, inspect: ok });
            assert.equal(await f(0), null);
        });
        test('a piece is gone: cut again', async () => {
            const f = make({ part: { outPath: '/j/p2.mp4', early }, inspect: (file) => (file === '/s/b.mp4' ? { success: false } : ok(file)) });
            assert.equal(await f(0), null);
        });
        test('the joined file was made again (another length): cut again', async () => {
            const f = make({ part: { outPath: '/j/p2.mp4', early }, inspect: (file) => (file === '/j/p2.mp4' ? { success: true, duration: 900 } : ok(file)) });
            assert.equal(await f(0), null);
        });
        test('nothing cut early: null', async () => {
            const f = make({ part: { outPath: '/j/p2.mp4' }, inspect: ok });
            assert.equal(await f(0), null);
        });
    });
});
