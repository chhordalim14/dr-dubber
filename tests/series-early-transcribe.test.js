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

// startEarlyTranscribe itself, with fakes around it. While it waits for a part still joining it
// has no part (index -1), so the main run did not wait for it: it must never take the part the
// main run is on, or both split the same file into the same folder.
describe('startEarlyTranscribe: which part', () => {
    const fnSrc = cut(main, '      function startEarlyTranscribe(i) {', '      stopSeriesEarlyTranscribe = () => {');
    function run({ parts, i = 0, current = 0, settingsKeys = ['k1'], gmails = false, onWait = null }) {
        const plan = { parts, current };
        const split = [];
        const early = [];
        let waits = 0;
        const env = {
            plan, wanted: () => true,
            window: { daiStudio: { transcribeFilesEarly: async (pieces) => { early.push(pieces); return { done: pieces.length, total: pieces.length, failed: 0 }; } } },
            getGeminiKeys: () => settingsKeys, routerHasGmails: async () => gmails,
            joiningIndices: () => parts.map((p, idx) => (p.status === 'joining' ? idx : -1)).filter((x) => x >= 0),
            sleep: async () => { waits++; if (onWait) onWait(plan, waits); await new Promise((r) => setImmediate(r)); },
            earlyPiecesFor: async () => null,
            splitPartFile: async (k) => { split.push(k); return { pieces: [`/s/p${k}a.mp4`, `/s/p${k}b.mp4`], note: '', duration: 600 }; },
            savePlan: () => { }, render: () => { }, splitMinutes: () => 7, console: { log: () => { }, warn: () => { } }
        };
        const api = new Function(...Object.keys(env), `let earlyRun = null; ${fnSrc}; return { start: startEarlyTranscribe, get run() { return earlyRun; } };`)(...Object.values(env));
        api.start(i);
        const job = api.run;
        return { done: job ? job.promise : Promise.resolve(), job, split, early, api };
    }

    test('the next joined part is cut and transcribed', async () => {
        const r = run({ parts: [{ status: 'done' }, { status: 'joined', outPath: '/j/p2.mp4' }] });
        await r.done;
        assert.deepEqual(r.split, [1]);
        assert.equal(r.early.length, 1);
    });

    test('the main run moves on to the part this job waited for: it is left to the main run', async () => {
        const parts = [{ status: 'done' }, { status: 'joining', outPath: '/j/p2.mp4' }];
        // While waiting, the main run reaches part 2 (Continue) and it finishes joining.
        const r = run({ parts, onWait: (plan) => { plan.current = 1; parts[1].status = 'joined'; } });
        await r.done;
        assert.deepEqual(r.split, [], 'part 2 was split by the early job too');
        assert.equal(r.api.run, null, 'the job ended, so the main run can start the next early run');
    });

    test('...and it goes on to the part after that one when it is joined', async () => {
        const parts = [{ status: 'done' }, { status: 'joining' }, { status: 'joined', outPath: '/j/p3.mp4' }];
        const r = run({ parts, onWait: (plan) => { plan.current = 1; } });
        await r.done;
        assert.deepEqual(r.split, [2]);
    });

    test('no Settings key: runs on the Router\'s ready Gmails; neither: nothing starts', async () => {
        const parts = () => [{ status: 'done' }, { status: 'joined', outPath: '/j/p2.mp4' }];
        const withGmails = run({ parts: parts(), settingsKeys: [], gmails: true });
        await withGmails.done;
        assert.deepEqual(withGmails.split, [1]);
        const none = run({ parts: parts(), settingsKeys: [], gmails: false });
        await none.done;
        assert.deepEqual(none.split, []);
        assert.equal(none.api.run, null);
    });
});

// The server saves an early transcript as it came (holes and all); the batch must not reuse one
// with holes, or it keeps them for good - it is transcribed again, as the batch's own rule says.
describe('loadSavedBatchResult: only complete results are reused', () => {
    const fns = cut(dai, '  function isIncompleteResult(result) {', '  async function processSingleBatchItem(');
    const load = (saved) => new Function('fetch', `${fns}; return loadSavedBatchResult;`)(
        async () => ({ json: async () => (saved ? { found: true, result: saved } : { found: false }) }));
    const lines = [{ start: '00:00:01.00', end: '00:00:02.00', text: 'ក' }];

    test('a complete saved result is reused', async () => {
        const r = await load({ data: lines, repair: {}, fallbackModels: [], early: true })('http://x', '/s/a.mp4');
        assert.equal(r.success, true);
        assert.equal(r.data.length, 1);
    });
    for (const [what, saved] of [
        ['lines left without Khmer', { repair: { stillUntranslated: 2 } }],
        ['a quota error in the repair', { repair: { quotaError: 'daily quota' } }],
        ['a failed missed-dialogue check', { repair: { gapsFailed: 1 } }],
        ['pieces from a fallback model', { repair: {}, fallbackModels: ['gemini-3.6-flash'] }]
    ]) {
        test(`${what}: not reused (transcribed again)`, async () => {
            assert.equal(await load({ data: lines, early: true, ...saved })('http://x', '/s/a.mp4'), null);
        });
    }
    test('nothing saved, or no lines: null', async () => {
        assert.equal(await load(null)('http://x', '/s/a.mp4'), null);
        assert.equal(await load({ data: [] })('http://x', '/s/a.mp4'), null);
    });
});
