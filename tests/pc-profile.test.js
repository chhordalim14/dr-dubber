// Settings > Performance: limits from the PC's hardware (backend/lib/pc-profile.js), the RAM
// guard that holds the next heavy job (backend/lib/memory-guard.js), the limiter for
// Transcribe's FFmpeg cuts (backend/lib/limiter.js), and where each is used.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');

const { tierFor, limitsFor, createPcProfile, readNvidiaGpu } = require('../backend/lib/pc-profile');
const { createMemoryGuard, parseVmStat, MAX_HOLD_MS } = require('../backend/lib/memory-guard');
const { createLimiter } = require('../backend/lib/limiter');
const { createTextDetectService, defaultMaxRunning } = require('../backend/text_detect_service');

const repo = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(repo, ...p), 'utf8').replace(/\r\n/g, '\n');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

describe('which group a PC is in', () => {
    test('small PCs are light, big ones strong, the rest standard', () => {
        assert.equal(tierFor({ ramGB: 7.8, cores: 8 }), 'light', '8 GB');
        assert.equal(tierFor({ ramGB: 15.4, cores: 4 }), 'light', '4 threads');
        assert.equal(tierFor({ ramGB: 15.4, cores: 16 }), 'standard', 'the 16 GB RTX 3060 laptop');
        assert.equal(tierFor({ ramGB: 11.8, cores: 8 }), 'standard', '12 GB');
        assert.equal(tierFor({ ramGB: 31.9, cores: 16 }), 'strong');
        assert.equal(tierFor({ ramGB: 64, cores: 8 }), 'standard', 'lots of RAM but few threads');
        assert.equal(tierFor({}), 'standard', 'unknown hardware is never light');
    });

    test('standard keeps the limits the app always had', () => {
        assert.deepEqual(limitsFor('standard', { ramGB: 15.4, cores: 16 }), {
            renders: 2, previews: 2, isolateTabs: 1, textDetect: 4, transcribeCuts: 8,
            transcribeTabs: 8, batchTabs: 6, fitTabs: 6, voiceRequests: 5,
        });
        // The text search cap is the one text_detect_service.js used on its own.
        for (const cores of [1, 4, 8, 12, 16, 32]) assert.equal(limitsFor('standard', { cores }).textDetect, defaultMaxRunning(cores));
        // Isolate BGM All: 1 tab with 16 GB or less (a 16 GB Mac reports 16), 2 above.
        assert.equal(limitsFor('standard', { ramGB: 16 }).isolateTabs, 1);
        assert.equal(limitsFor('standard', { ramGB: 24 }).isolateTabs, 2);
    });

    test('light does one heavy thing at a time; strong isolates two tabs', () => {
        const light = limitsFor('light', { ramGB: 8, cores: 4 });
        assert.equal(light.renders, 1);
        assert.equal(light.isolateTabs, 1);
        assert.equal(light.textDetect, 1);
        assert.equal(light.previews, 1);
        assert.ok(light.transcribeTabs < 8 && light.batchTabs < 6 && light.voiceRequests < 5);
        assert.equal(limitsFor('strong', { ramGB: 64, cores: 24 }).isolateTabs, 2);
    });

    test('with no hardware encoder, exports go one at a time (two CPU exports only fight)', () => {
        assert.equal(limitsFor('standard', { ramGB: 16, cores: 16, hwEncoder: false }).renders, 1);
        assert.equal(limitsFor('standard', { ramGB: 16, cores: 16, hwEncoder: true }).renders, 2);
        assert.equal(limitsFor('standard', { ramGB: 16, cores: 16, hwEncoder: null }).renders, 2, 'not known yet');
    });

    test('Transcribe cuts: about one per two CPU threads, 2 to 8', () => {
        assert.equal(limitsFor('standard', { cores: 2 }).transcribeCuts, 2);
        assert.equal(limitsFor('standard', { cores: 8 }).transcribeCuts, 4);
        assert.equal(limitsFor('standard', { cores: 64 }).transcribeCuts, 8);
    });
});

describe('the profile and its saved choice', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcprofile-'));
    const settingsFile = path.join(dir, 'performance.json');
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('auto follows the hardware; a choice is kept on disk and read back', async () => {
        const make = () => createPcProfile({
            settingsFile, hardware: { ramGB: 7.8, cores: 8 },
            detectEncoders: async () => ({ nvenc: false, qsv: true }),
            readGpu: async () => null,
        });
        const p = make();
        assert.equal(p.mode, 'auto');
        assert.equal(p.tier(), 'light');
        await p.readSlowFacts();
        assert.equal(p.describe().hardware.hwEncoder, true);
        p.setMode('standard');
        assert.equal(p.tier(), 'standard');
        assert.equal(p.describe().detectedTier, 'light', 'what the hardware says is still shown');
        assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).mode, 'standard');
        assert.equal(make().tier(), 'standard', 'kept after a restart');
        assert.throws(() => p.setMode('turbo'), /Unknown performance mode/);
        assert.equal(p.mode, 'standard');
    });

    test('a damaged settings file is auto', () => {
        fs.writeFileSync(settingsFile, '{not json');
        assert.equal(createPcProfile({ settingsFile, hardware: { ramGB: 16, cores: 16 }, readGpu: async () => null }).mode, 'auto');
    });

    test('the GPU name and memory come from nvidia-smi; no NVIDIA driver is no GPU', async () => {
        const run = (out, err = null) => (cmd, args, opts, cb) => cb(err, out);
        assert.deepEqual(await readNvidiaGpu(run('NVIDIA GeForce RTX 3060 Laptop GPU, 6144\r\n')), { name: 'NVIDIA GeForce RTX 3060 Laptop GPU', vramGB: 6 });
        assert.equal(await readNvidiaGpu(run('', new Error('ENOENT'))), null);
    });
});

describe('the RAM guard', () => {
    function guard({ freeMB = 8000, platform = 'win32', running = 0 } = {}) {
        const state = { freeMB, running, clock: 0, slept: 0, logs: [] };
        const g = createMemoryGuard({
            platform,
            freemem: () => state.freeMB * MB,
            now: () => state.clock,
            sleep: async (ms) => { state.clock += ms; state.slept += ms; if (state.onSleep) state.onSleep(); },
            log: { log: (m) => state.logs.push(m), warn: (m) => state.logs.push(m) },
        });
        g.registerActivity('jobs', () => state.running);
        return { g, state };
    }

    test('holds a job only when RAM is short AND another job of ours runs', () => {
        const { g, state } = guard({ freeMB: 900, running: 1 });
        assert.deepEqual(g.holdReason('separation'), { freeMB: 900, needMB: 2000, running: 1 });
        assert.equal(g.holdReason('preview'), null, 'a preview needs only 500 MB');
        state.running = 0;
        assert.equal(g.holdReason('separation'), null, 'nothing to wait for: go');
        state.running = 2;
        state.freeMB = 4000;
        assert.equal(g.holdReason('separation'), null, 'enough free RAM');
    });

    test('waits until the running job gives its memory back, then goes', async () => {
        const { g, state } = guard({ freeMB: 700, running: 1 });
        const reasons = [];
        state.onSleep = () => { if (state.clock >= 9000) { state.running = 0; } };
        assert.equal(await g.waitForRoom('render', { onWait: (r) => reasons.push(r) }), true);
        assert.equal(state.slept, 9000);
        assert.equal(reasons.length, 1, 'told once');
        assert.match(state.logs[0], /render waits: 700 MB free, needs 800 MB/);
    });

    test('a stopped job stops waiting; a job that never ends holds the next one 20 minutes at most', async () => {
        const { g, state } = guard({ freeMB: 100, running: 1 });
        let stop = false;
        state.onSleep = () => { stop = true; };
        assert.equal(await g.waitForRoom('separation', { isCancelled: () => stop }), false);
        state.onSleep = null;
        state.clock = 0;
        assert.equal(await g.waitForRoom('separation'), true);
        assert.ok(state.clock >= MAX_HOLD_MS && state.clock < MAX_HOLD_MS + 5000);
        assert.match(state.logs.at(-1), /starting anyway/);
    });

    test('macOS: free RAM from vm_stat (inactive + purgeable count as free); unknown never holds', async () => {
        const vmstat = [
            'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
            'Pages free:                               10000.',
            'Pages active:                            400000.',
            'Pages inactive:                          100000.',
            'Pages speculative:                         2000.',
            'Pages purgeable:                           8000.',
        ].join('\n');
        assert.equal(parseVmStat(vmstat), Math.round((120000 * 16384) / MB));
        assert.equal(parseVmStat('nonsense'), null);
        let calls = 0;
        const g = createMemoryGuard({ platform: 'darwin', freemem: () => 1, now: () => calls * 10000, run: (cmd, args, opts, cb) => { calls++; cb(null, vmstat); } });
        g.registerActivity('jobs', () => 1);
        assert.equal(g.freeMB(), 1875);
        assert.equal(g.holdReason('preview'), null, 'enough for a preview');
        assert.equal(g.holdReason('separation').freeMB, 1875, 'not enough for a separation (2 GB)');
        const unknown = createMemoryGuard({ platform: 'darwin', run: (cmd, args, opts, cb) => cb(new Error('no vm_stat')) });
        unknown.registerActivity('jobs', () => 3);
        assert.equal(unknown.holdReason('music'), null);
    });
});

describe('the limiter', () => {
    test('never more than getMax() at once, and a new limit applies to the next task', async () => {
        let max = 2, running = 0, most = 0;
        const lim = createLimiter(() => max);
        const task = () => new Promise((r) => { running++; most = Math.max(most, running); setTimeout(() => { running--; r('ok'); }, 5); });
        const all = Array.from({ length: 8 }, () => lim.run(task));
        await tick(1);
        max = 1;
        assert.deepEqual(await Promise.all(all), Array(8).fill('ok'));
        assert.equal(most, 2);
        most = 0;
        await Promise.all(Array.from({ length: 4 }, () => lim.run(task)));
        assert.equal(most, 1);
    });

    test('a task that fails gives its slot back; a stop while waiting ends the wait', async () => {
        const lim = createLimiter(1);
        await assert.rejects(lim.run(() => Promise.reject(new Error('ffmpeg broke'))), /ffmpeg broke/);
        let release;
        const first = lim.run(() => new Promise((r) => { release = r; }));
        const ctrl = new AbortController();
        const waiting = lim.run(() => 'never', ctrl.signal);
        await tick(1);
        ctrl.abort();
        await assert.rejects(waiting, (e) => e.name === 'AbortError');
        release('done');
        assert.equal(await first, 'done');
        assert.equal(await lim.run(() => 'next'), 'next');
        assert.equal(lim.active, 0);
    });
});

describe('exports: how many at once, and waiting for free RAM', () => {
    const createRenderRouter = require('../backend/routes/render');
    // The route answers when the export ends: finish[token]() ends it.
    let server, base, started, lowMemory, cap, clock, rendering, finish;
    before(async () => {
        started = [];
        finish = {};
        lowMemory = null;
        cap = 1;
        clock = 1000; // the route reads a held time of 0 as "not held yet"
        rendering = 0;
        const app = express();
        app.use(express.json());
        app.use('/api', createRenderRouter({
            upload: { any: () => (req, res, next) => next() },
            audioRepair: { getAudioSource: async () => ({ path: __filename }) },
            renderVideo: (opts, onProgress, onComplete) => {
                started.push(opts.renderToken);
                rendering++;
                finish[opts.renderToken] = () => { rendering--; onComplete(opts.outputPath); };
            },
            getRenderProgress: () => ({ status: 'idle' }),
            renderingCount: () => rendering,
            cancelRender: () => true,
            maxRenders: () => cap,
            memoryHold: () => lowMemory,
            now: () => clock,
        }));
        server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.close());
    const send = (token) => fetch(`${base}/api/render`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoFilePath: __filename, renderToken: token, exportPath: os.tmpdir(), outputFileName: `${token}.mp4` }),
    });

    // Sends an export the server takes, then ends it.
    async function exportThrough(token) {
        const answer = send(token);
        for (let i = 0; i < 100 && !finish[token]; i++) await tick(2);
        assert.ok(finish[token], `${token} started`);
        finish[token]();
        return answer;
    }

    test('a light PC exports one at a time', async () => {
        const first = send('m1');
        for (let i = 0; i < 100 && !finish.m1; i++) await tick(2);
        const second = await send('m2');
        assert.equal(second.status, 409);
        assert.equal((await second.json()).held, undefined, 'busy, not held');
        finish.m1();
        assert.equal((await first).status, 200);
        cap = 2;
        const a = send('m2');
        for (let i = 0; i < 100 && !finish.m2; i++) await tick(2);
        assert.equal((await exportThrough('m2b')).status, 200, 'a standard PC takes a second one');
        finish.m2();
        await a;
    });

    test('held (409, held: memory) while RAM is short; goes when it is back, or after 20 minutes', async () => {
        lowMemory = { freeMB: 600, needMB: 800, running: 1 };
        const r = await send('m3');
        assert.equal(r.status, 409);
        const body = await r.json();
        assert.equal(body.held, 'memory');
        assert.match(body.error, /600 MB free/);
        lowMemory = null;
        assert.equal((await exportThrough('m3')).status, 200);
        lowMemory = { freeMB: 500, needMB: 800, running: 1 };
        assert.equal((await send('m4')).status, 409);
        clock += 21 * 60 * 1000;
        assert.equal((await exportThrough('m4')).status, 200);
        assert.deepEqual(started, ['m1', 'm2', 'm2b', 'm3', 'm4']);
    });

    test('the page waits on held: memory like a subtitle search (not a busy try)', () => {
        assert.match(read('frontend', 'js', 'studio-main.js'), /busy\.held === "search" \|\| busy\.held === "memory"/);
    });
});

describe('subtitle searches wait for free RAM and follow the profile', () => {
    test('the next search holds while RAM is short, then starts by itself', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcprofile-td-'));
        const video = path.join(dir, 'a.mp4');
        fs.writeFileSync(video, 'a');
        const children = [];
        let hold = { freeMB: 300 };
        let cap = 1;
        const svc = createTextDetectService({
            pythonCmd: 'python', pythonEnv: {}, scriptPath: 'x.py', requirementsPath: 'r.txt', ffmpegPath: 'ffmpeg', cacheDir: path.join(dir, 'cache'),
            spawn: () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); children.push(c); return c; },
            execFile: (cmd, args, opts, cb) => cb(null, '', ''),
            log: { log: () => { }, warn: () => { } },
            maxRunning: () => cap,
            memoryHold: () => hold,
        });
        try {
            svc.start(video);
            await tick(20);
            assert.equal(children.length, 0, 'held');
            assert.equal(svc.busy(), true, 'still counts as busy: exports keep waiting for it');
            hold = null;
            await new Promise((r) => setTimeout(r, 3200));
            assert.equal(children.length, 1, 'started once RAM was back');
            assert.equal(svc.runningCount(), 1);
        } finally {
            children.forEach((c) => c.emit('close', 1));
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('wiring', () => {
    const server = read('backend', 'server.js');
    const page = read('frontend', 'js', 'studio-main.js');
    const studio = read('frontend', 'js', 'dai-transcribe-studio.js');
    const html = read('frontend', 'index.html');

    test('the server hands every heavy step its limit and the RAM guard', () => {
        assert.match(server, /maxRenders: \(\) => pcProfile\.limits\(\)\.renders,\n\s+memoryHold: \(\) => memoryGuard\.holdReason\('render'\)/);
        assert.match(server, /maxRunning: \(\) => pcProfile\.limits\(\)\.textDetect,/);
        assert.match(server, /maxRunning: \(\) => pcProfile\.limits\(\)\.previews,/);
        assert.match(server, /pcLimits: \(\) => pcProfile\.limits\(\)/);
        for (const name of ['separations', 'renders', 'textDetect', 'previews']) assert.match(server, new RegExp(`registerActivity\\('${name}'`));
        // Isolate BGM and Remove music wait right before their Python starts.
        assert.equal((server.match(/await waitForBgmMemory\(jobId, '(separation|music)'\);\n\s+if \(isBgmJobCancelled\(jobId\)\)/g) || []).length, 2);
    });

    test('every FFmpeg run of Transcribe goes through the limiter', () => {
        const gemini = read('backend', 'routes', 'gemini.js');
        assert.match(gemini, /function runFFmpegCapture\(args, signal\) \{\n(.*\n){0,1}\s+return ffmpegSlots\.run\(\(\) => runFFmpegNow\(args, signal\), signal\)/);
        assert.equal((gemini.match(/spawn\(_getFFmpegBinary\(\)/g) || []).length, 1, 'no FFmpeg started around it');
    });

    test('the page reads its limits from the profile, with the old numbers until it has them', () => {
        assert.match(page, /pcLimit\("voiceRequests", VOICE_REQUESTS_AT_ONCE\)/);
        assert.match(page, /while \(voiceRequestsOpen >= voiceRequestsAtOnce\(\)\)/);
        assert.match(page, /pcLimit\("isolateTabs", 0\)/);
        assert.match(page, /pcLimit\("transcribeTabs", FIX_MISSING_MAX_PARALLEL\)/);
        assert.equal((page.match(/Math\.min\(seriesFitAtOnce\(\), keys\.length/g) || []).length, 2);
        assert.match(studio, /pcLimitOr\('transcribeTabs', SERIES_MAX_PARALLEL_FILES\)/);
        assert.match(studio, /maxParallel \|\| \(keyPerTab \? seriesParallelFiles\(\) : batchParallelFiles\(\)\)/);
    });

    test('Settings shows the choice, and the script loads before the page scripts', () => {
        for (const v of ['auto', 'light', 'standard', 'strong']) assert.match(html, new RegExp(`<option value="${v}">`));
        const at = (f) => html.indexOf(`<script src="js/${f}"></script>`);
        assert.ok(at('pc-profile.js') > 0 && at('pc-profile.js') < at('studio-main.js') && at('pc-profile.js') < at('dai-transcribe-studio.js'));
        // "Episodes at once" offers the light default.
        assert.match(html, /<option value="3">3<\/option>/);
        assert.equal(limitsFor('light').transcribeTabs, 3);
    });
});

describe('the page script (js/pc-profile.js)', () => {
    function load(answer) {
        const window = {};
        const posted = [];
        const document = { readyState: 'complete', getElementById: () => null, addEventListener() { } };
        const fetch = async (url, opts) => {
            if (opts && opts.method === 'POST') posted.push(JSON.parse(opts.body));
            return { json: async () => (typeof answer === 'function' ? answer(opts) : answer) };
        };
        new Function('window', 'document', 'fetch', read('frontend', 'js', 'pc-profile.js'))(window, document, fetch);
        return { window, posted };
    }

    test('until the server answers, every limit is the old number; then the server\'s', async () => {
        const { window } = load({ success: true, mode: 'auto', tier: 'light', limits: { voiceRequests: 3, isolateTabs: 1 } });
        assert.equal(window.pcLimit('voiceRequests', 5), 5);
        await tick();
        assert.equal(window.pcLimit('voiceRequests', 5), 3);
        assert.equal(window.pcLimit('unknown', 7), 7);
    });

    test('a server that does not answer leaves the old numbers', async () => {
        const { window } = load({ success: false });
        await tick();
        assert.equal(window.pcLimit('transcribeTabs', 8), 8);
    });

    test('choosing a group saves it and the new limits apply at once', async () => {
        const { window, posted } = load((opts) => (opts && opts.method === 'POST'
            ? { success: true, mode: 'light', tier: 'light', limits: { renders: 1 } }
            : { success: true, mode: 'auto', tier: 'standard', limits: { renders: 2 } }));
        await tick();
        assert.equal(window.pcLimit('renders', 2), 2);
        const seen = [];
        window.pcProfile.onChange((p) => seen.push(p.tier));
        await window.pcProfile.setMode('light');
        assert.deepEqual(posted, [{ mode: 'light' }]);
        assert.equal(window.pcLimit('renders', 2), 1);
        assert.deepEqual(seen, ['standard', 'light']);
    });
});
