// The app closing or the network dropping loses no work: the series checkpoints on disk
// (backend/routes/series-checkpoint.js), a render whose request was lost is waited for instead
// of failed (backend/routes/render.js + sendRender in frontend/js/studio-main.js), and the open
// part's tabs are saved and put back as they were (tabState / restoreTabsCheckpoint).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8').replace(/\r\n/g, '\n');
const cut = (from, to) => {
    const a = src.indexOf(from), b = src.indexOf(to, a);
    assert.ok(a > 0 && b > a, `markers moved - update this test: ${from}`);
    return src.slice(a, b);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listen(app) {
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const post = async (url, body) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

describe('series checkpoints on disk', () => {
    const createRouter = require('../backend/routes/series-checkpoint');
    let dir, server, base;
    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-test-'));
        const app = express();
        app.use(express.json({ limit: '100mb' }));
        app.use('/api', createRouter({ dir }));
        ({ server, base } = await listen(app));
    });
    after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

    test('saved, read back, deleted', async () => {
        const data = { part: 2, tabs: [{ path: 'D:\\a.mp4', state: { subtitles: [{ text: 'សួស្តី' }] } }] };
        assert.equal((await post(`${base}/api/series-checkpoint`, { key: 'series_1_part3_tabs', data })).success, true);
        assert.deepEqual((await (await fetch(`${base}/api/series-checkpoint?key=series_1_part3_tabs`)).json()).data, data);
        assert.deepEqual(fs.readdirSync(dir), ['series_1_part3_tabs.json'], 'no temporary file left');
        await post(`${base}/api/series-checkpoint/delete`, { keys: ['series_1_part3_tabs'] });
        assert.equal((await (await fetch(`${base}/api/series-checkpoint?key=series_1_part3_tabs`)).json()).data, null);
    });

    test('a key can only name a file in the checkpoint folder', async () => {
        for (const key of ['../x', 'a/b', 'C:\\x', '', 'a.json']) {
            const res = await fetch(`${base}/api/series-checkpoint`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, data: 1 }) });
            assert.equal(res.status, 400, key);
        }
    });

    test('which exported videos are on disk, without making or touching anything', async () => {
        const video = path.join(dir, 'tab1.mp4');
        fs.writeFileSync(video, 'x');
        fs.writeFileSync(path.join(dir, 'empty.mp4'), '');
        const missing = path.join(dir, 'missing.mp4');
        const r = await post(`${base}/api/series-checkpoint/files-exist`, { paths: [video, path.join(dir, 'empty.mp4'), missing, 'relative.mp4', '\\\\server\\share\\a.mp4'] });
        assert.deepEqual(r.exists, [true, false, false, false, false]);
        assert.equal(fs.existsSync(missing), false);
    });

    test('checkpoints of a series left for a month go', () => {
        const old = path.join(dir, 'old.json'), fresh = path.join(dir, 'fresh.json');
        fs.writeFileSync(old, '{}');
        fs.writeFileSync(fresh, '{}');
        const monthAgo = (Date.now() - 31 * 24 * 3600 * 1000) / 1000;
        fs.utimesSync(old, monthAgo, monthAgo);
        createRouter._removeOld(dir);
        assert.equal(fs.existsSync(old), false);
        assert.equal(fs.existsSync(fresh), true);
    });
});

describe('a render taken by the server counts as going before FFmpeg starts', () => {
    const createRenderRouter = require('../backend/routes/render');
    let server, base, job, releaseAudio, started;
    before(async () => {
        job = { status: 'idle', progress: 0 };
        started = [];
        const app = express();
        app.use(express.json());
        app.use('/api', createRenderRouter({
            upload: { any: () => (req, res, next) => next() },
            // Checking the video's own audio takes a while (here: until the test lets it go).
            audioRepair: { getAudioSource: () => new Promise((r) => { releaseAudio = () => r({ path: __filename }); }) },
            renderVideo: (opts, onProgress, onComplete) => {
                job = { status: 'rendering', progress: 1, token: opts.renderToken, outputFile: opts.outputPath };
                started.push(opts.renderToken);
                setTimeout(() => { job = { ...job, status: 'done', progress: 100 }; onComplete(opts.outputPath); }, 30);
            },
            getRenderProgress: () => job,
            cancelRender: () => true,
        }));
        ({ server, base } = await listen(app));
    });
    after(() => server.close());

    test('while the audio is checked: shown as rendering with its token, and a second render is refused', async () => {
        const first = post(`${base}/api/render`, { videoFilePath: __filename, isOriginalAudioMuted: false, renderToken: 'tok1', exportPath: os.tmpdir(), outputFileName: 'x.mp4' });
        await sleep(30);
        const st = await (await fetch(`${base}/api/render-progress`)).json();
        assert.equal(st.status, 'processing');
        assert.equal(st.token, 'tok1');
        const second = await fetch(`${base}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoFilePath: __filename, renderToken: 'tok2' }) });
        assert.equal(second.status, 409);
        releaseAudio();
        assert.equal((await first).success, true);
        assert.deepEqual(started, ['tok1']);
        const end = await (await fetch(`${base}/api/render-progress`)).json();
        assert.equal(end.status, 'done');
        assert.equal(end.token, 'tok1');
    });
});

describe('the page waits for a render whose request was lost', () => {
    const block = cut('        const waitForServerRender = async (signal) => {', '        const formatSrtTime = (seconds) => {');
    // server: { progress: [answers of /api/render-progress, in turn], posts: [answers of /api/render: 'lost' | status | object] }
    function make(server) {
        const calls = [];
        const fetch = async (url, opts) => {
            if (opts?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
            if (/render-progress/.test(url)) {
                calls.push('progress');
                const st = server.progress.length > 1 ? server.progress.shift() : server.progress[0];
                return { json: async () => st };
            }
            calls.push('render');
            const answer = server.posts.shift();
            if (answer === 'lost') throw new TypeError('Failed to fetch');
            if (typeof answer === 'number') return { status: answer, json: async () => ({ success: false, error: 'A render is already in progress.' }) };
            return { status: 200, json: async () => answer };
        };
        const fast = (fn) => setTimeout(fn, 0);
        const api = new Function('fetch', 'setTimeout', 'console', `${block}; return { sendRender, waitForServerRender };`)(fetch, fast, { warn: () => { } });
        return { api, calls };
    }

    test('lost on the way, the server renders it: its result is taken, nothing is sent again', async () => {
        const { api, calls } = make({
            posts: ['lost'],
            progress: [{ status: 'processing', token: 'me' }, { status: 'processing', token: 'me' }, { status: 'done', token: 'me', outputFile: 'D:/out/ep1.mp4' }],
        });
        const r = await api.sendRender({}, 'me', null);
        assert.deepEqual(r, { success: true, outputPath: 'D:/out/ep1.mp4' });
        assert.equal(calls.filter((c) => c === 'render').length, 1);
    });

    test('lost before it reached the server: sent again', async () => {
        const { api, calls } = make({ posts: ['lost', { success: true, outputPath: 'D:/out/ep1.mp4' }], progress: [{ status: 'done', token: 'earlier' }] });
        const r = await api.sendRender({}, 'me', null);
        assert.equal(r.success, true);
        assert.equal(calls.filter((c) => c === 'render').length, 2);
    });

    test('its render failed on the server: the failure, not a resend', async () => {
        const { api } = make({ posts: ['lost'], progress: [{ status: 'error', token: 'me', error: 'FFmpeg exited with code 1' }] });
        assert.deepEqual(await api.sendRender({}, 'me', null), { success: false, error: 'FFmpeg exited with code 1' });
    });

    test('"already in progress" (a render of a request lost earlier): waited out, then sent', async () => {
        const { api, calls } = make({ posts: [409, { success: true, outputPath: 'x' }], progress: [{ status: 'processing', token: 'old' }, { status: 'done', token: 'old' }] });
        assert.equal((await api.sendRender({}, 'me', null)).success, true);
        assert.deepEqual(calls, ['render', 'progress', 'progress', 'render']);
    });

    test('the Export button keeps its own "already in progress" message', async () => {
        const { api } = make({ posts: [409], progress: [{ status: 'processing' }] });
        const r = await api.sendRender({}, 'me', null, { waitIfBusy: false });
        assert.equal(r.status, 409);
        assert.equal(r.success, false);
    });

    test('Stop while waiting stops it', async () => {
        const ctrl = new AbortController();
        const { api } = make({ posts: ['lost'], progress: [{ status: 'processing', token: 'me' }] });
        setTimeout(() => ctrl.abort(), 20);
        await assert.rejects(api.sendRender({}, 'me', ctrl.signal), { name: 'AbortError' });
    });

    test('the render queue and the Export button both send through it with a token', () => {
        assert.equal((src.match(/await sendRender\(formData, renderToken, /g) || []).length, 2);
        assert.equal((src.match(/\.renderToken = renderToken;/g) || []).length, 2);
        const posts = src.match(/fetch\("http:\/\/localhost:3001\/api\/render",/g) || [];
        assert.equal(posts.length, 1, 'only sendRender posts a render');
        assert.ok(block.includes('fetch("http://localhost:3001/api/render",'));
    });
});

describe('the open part\'s tabs are saved and put back', () => {
    const block = cut('      const TAB_NOT_KEPT = new Set(', '      // The open part\'s tabs and its steps.');
    const restoreBlock = cut('      function restoreTabsCheckpoint(saved) {', '      // A finished part\'s export queue:');
    const tabState = new Function(`${block}; return tabState;`)();

    test('a tab as data: its work kept, the page\'s own objects and running jobs not', () => {
        class FakeFile { }
        const tab = {
            file: new FakeFile(), blobUrl: 'blob:x', videoFilePath: 'D:\\p1.mp4', pastStates: [[1]], currentTime: 12,
            subtitles: [{ id: 'a', text: 'សួស្តី', audioStatus: 'ready', file: 'C:\\Temp\\a.mp3', emotion: 'Sad' }],
            bgmTrack: { src: 'http://localhost:3001/separated/x.wav', file: 'D:\\x.wav', volume: 0.5 },
            bgmMethod: 'mdx', textBlur: { enabled: true, lines: [{ t: 1 }] }, isOriginalAudioMuted: true, isFlippedH: false,
            isGeneratingAudio: true, generateAbortController: new AbortController(), _cancelGenRef: {}, _pollers: [1], textDetectJobId: 'j1',
            onSomething: () => { },
        };
        const s = tabState(tab);
        assert.deepEqual(Object.keys(s).sort(), ['bgmMethod', 'bgmTrack', 'isFlippedH', 'isOriginalAudioMuted', 'subtitles', 'textBlur']);
        assert.deepEqual(s.subtitles, tab.subtitles);
        s.subtitles[0].text = 'changed';
        assert.equal(tab.subtitles[0].text, 'សួស្តី', 'a copy');
    });

    function makeRestore({ pieces, projects, stepState = {} }) {
        const env = { shown: 0, saves: 0 };
        const plan = { current: 1, pieces, stepState };
        const fn = new Function('plan', 'projects', 'env', `
            const OPTIONAL_STEPS = ["transcribe", "match", "generate", "isolate", "blurtext"];
            const piecesOpen = () => projects.length === plan.pieces.length && plan.pieces.every((p, k) => projects[k].videoFilePath === p);
            const activeProjectIndex = 0;
            const restoreProjectState = () => { env.shown++; };
            const renderProjectTabs = () => { };
            const savePlan = () => { env.saves++; };
            ${restoreBlock}; return restoreTabsCheckpoint;`)(plan, projects, env);
        return { plan, env, restore: fn };
    }

    test('fresh tabs get their saved state by video; the steps done stay done, a running one runs again', () => {
        const pieces = ['D:\\p1.mp4', 'D:\\p2.mp4'];
        const projects = pieces.map((p) => ({ videoFilePath: p, file: { name: p }, subtitles: [] }));
        const { plan, env, restore } = makeRestore({ pieces, projects });
        const saved = {
            part: 1, pieces,
            steps: { transcribe: { state: 'done', note: '40 lines' }, match: { state: 'done' }, generate: { state: 'running' } },
            tabs: [{ path: 'D:\\p2.mp4', state: { subtitles: [{ id: 'b' }] } }, { path: 'D:\\p1.mp4', state: { subtitles: [{ id: 'a' }], bgmMethod: 'mdx' } }],
        };
        assert.equal(restore(saved), 2);
        assert.deepEqual(projects[0].subtitles, [{ id: 'a' }]);
        assert.equal(projects[0].bgmMethod, 'mdx');
        assert.deepEqual(projects[1].subtitles, [{ id: 'b' }]);
        assert.deepEqual(projects[0].file, { name: 'D:\\p1.mp4' }, 'the freshly opened video stays');
        assert.deepEqual(Object.keys(plan.stepState).sort(), ['match', 'transcribe']);
        assert.equal(env.shown, 1);
    });

    test('a checkpoint of other pieces or another part is not used', () => {
        const pieces = ['D:\\p1.mp4'];
        for (const saved of [null, { part: 0, pieces, tabs: [] }, { part: 1, pieces: ['D:\\other.mp4'], tabs: [] }]) {
            const projects = [{ videoFilePath: 'D:\\p1.mp4', subtitles: [] }];
            const { plan, restore } = makeRestore({ pieces, projects });
            assert.equal(restore(saved), 0);
            assert.deepEqual(projects[0].subtitles, []);
            assert.deepEqual(plan.stepState, {});
        }
    });

    test('the series saves the tabs after each step, every half minute and when it stops; runPart puts them back', () => {
        assert.match(src, /if \(OPTIONAL_STEPS\.includes\(name\)\) saveTabsCheckpoint\(\);/);
        assert.match(src, /const tabsCkTimer = setInterval\(saveTabsCheckpoint, 30000\);/);
        assert.match(src, /clearInterval\(tabsCkTimer\);\n\s*saveTabsCheckpoint\(\);/);
        const runPart = cut('      async function runPart(i) {', '        // The subtitles are found while the part is transcribed');
        assert.ok(runPart.indexOf('const saved = await ckLoad(ckKey(i, "tabs"));') < runPart.indexOf('await runStep("load", loadStep);'), 'read before the load step saves anything');
        assert.ok(runPart.indexOf('await runStep("load", loadStep);') < runPart.indexOf('restoreTabsCheckpoint(saved)'));
    });

    test('hands-free continues by itself when the app opens after closing mid-run', () => {
        const startup = cut('      // The app closed while the series worked', '    })();');
        assert.match(startup, /plan && handsFree\(\) && !seriesFinished\(\) && \(plan\.running \|\| plan\.resumeAt\)/);
        assert.match(startup, /armAutoResume\(wait, /);
        assert.match(src, /plan\.running = true;/);
        assert.match(src, /plan\.running = false;\n\s*\}\n\s*savePlan\(\);/);
    });
});
