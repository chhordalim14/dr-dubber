// Gemini Web Router (backend/lib/gemini-web-router.js): updating the gemini_webapi library from the
// page - install the newest, restart the service, test it through a Gmail, put the old packages
// back if it fails - and the "who answered" counts the page shows. The real router code against a
// fake pip, a fake Python service and a fake home folder (the Router's venv lives in the home folder).
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gweb-lib-test-'));
process.env.APP_STORAGE_DIR = path.join(tmp, 'storage');
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
const { getGeminiWebRouter } = require('../backend/lib/gemini-web-router');

const ENV = path.join(tmp, 'DR Dubber Gemini Web');
const PY = path.join(ENV, 'venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
fs.mkdirSync(path.dirname(PY), { recursive: true });
fs.writeFileSync(PY, '');

// world: installed version, what pip --upgrade installs, which versions answer a test request
let world;
function setup({ installed = '2.1.1', newest = '2.2.0', works = ['2.1.1', '2.2.0'], gmailReady = true } = {}) {
    fs.writeFileSync(path.join(ENV, 'ready.json'), JSON.stringify({ lib: installed }));
    world = { version: installed, newest, works, up: true, restarts: 0, pip: [], tested: [] };
    const gw = getGeminiWebRouter();
    gw._settings = null;
    gw.inFlight.clear();
    gw.signIns.clear();
    gw.external = false;
    gw.updating = false;
    gw.libUpdate = { running: false, lines: [], error: null, result: null };
    gw.libLatest = { at: Date.now(), version: newest, checking: false }; // no PyPI in tests
    gw.run = async (cmd, args) => {
        if (args[0] === '-c') return { code: 0, out: `${world.version}\n` };
        const pip = args.slice(2).filter(a => !a.startsWith('--')).join(' ');
        world.pip.push(pip);
        if (pip === 'freeze') return { code: 0, out: `gemini_webapi==${world.version}\ncurl_cffi==0.7\n` };
        if (pip === 'install gemini_webapi') { world.version = world.newest; return { code: 0, out: '' }; }
        if (pip.startsWith('install -r ')) {
            const saved = fs.readFileSync(args[args.length - 1], 'utf8');
            world.version = saved.match(/gemini_webapi==(\S+)/)[1];
            return { code: 0, out: '' };
        }
        return { code: 1, out: 'unexpected' };
    };
    gw.stopService = () => { world.up = false; gw.proc = null; };
    gw.ensureService = async () => { if (!world.up) world.restarts++; world.up = true; return true; };
    gw.call = async (pathname) => {
        if (!world.up) throw new Error('ECONNREFUSED');
        if (pathname === '/status') {
            const acc = { id: 'g1', email: 'a@gmail.com', enabled: true, state: gmailReady ? 'ready' : 'signed_out' };
            gw.statusCache = { at: Date.now(), accounts: [acc] };
            return { ok: true, accounts: [acc] };
        }
        return { ok: true };
    };
    const realGenerate = gw.constructor.prototype.generate;
    gw.generate = async function (key, payload, signal, opts = {}) {
        if (this.updating && !opts.duringUpdate) return realGenerate.call(this, key, payload, signal, opts);
        world.tested.push(world.version);
        return world.works.includes(world.version)
            ? { success: true, text: 'តោះទៅផ្ទះ' }
            : { success: false, status: 502, message: 'Gemini Web: unexpected response' };
    };
    return gw;
}
async function finished(gw) {
    for (let i = 0; i < 200 && gw.libUpdate.running; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(gw.libUpdate.running, false, 'the update did not finish');
    return gw.libUpdate;
}
const readyJson = () => JSON.parse(fs.readFileSync(path.join(ENV, 'ready.json'), 'utf8'));

describe('Gemini Web Router: updating the library', () => {
    test('a newer version that works is kept, after a test request through a Gmail', async () => {
        const gw = setup();
        gw.startLibUpdate();
        const u = await finished(gw);
        assert.equal(u.error, null);
        assert.equal(u.result.status, 'updated');
        assert.equal(u.result.version, '2.2.0');
        assert.deepEqual(world.tested, ['2.2.0']);
        assert.equal(world.restarts, 1);
        assert.equal(readyJson().lib, '2.2.0');
        assert.ok(!world.pip.some(p => p.startsWith('install -r')), 'nothing rolled back');
        assert.equal(gw.updating, false);
    });

    test('a newer version that fails the test: the old packages are put back and the service restarted', async () => {
        const gw = setup({ works: ['2.1.1'] });
        gw.startLibUpdate();
        const u = await finished(gw);
        assert.equal(u.result.status, 'rolled_back');
        assert.equal(u.result.version, '2.1.1');
        assert.equal(world.version, '2.1.1');
        assert.ok(world.pip.some(p => p.startsWith('install -r')), 'the saved package list was installed again');
        assert.equal(world.restarts, 2, 'restarted with the new version, then with the old one');
        assert.equal(readyJson().lib, '2.1.1');
        assert.match(u.result.message, /2\.2\.0 did not work/);
    });

    test('already the newest: nothing is restarted', async () => {
        const gw = setup({ newest: '2.1.1' });
        gw.startLibUpdate();
        const u = await finished(gw);
        assert.equal(u.result.status, 'current');
        assert.equal(world.restarts, 0);
        assert.deepEqual(world.tested, []);
    });

    test('no Gmail ready before: only the service start is checked', async () => {
        const gw = setup({ gmailReady: false });
        gw.startLibUpdate();
        const u = await finished(gw);
        assert.equal(u.result.status, 'updated');
        assert.deepEqual(world.tested, []);
    });

    test('refused while a Gmail works on a job, or a Gmail signs in', () => {
        const gw = setup();
        gw.inFlight.set('g1', 1);
        assert.throws(() => gw.startLibUpdate(), /working on a job/);
        gw.inFlight.clear();
        gw.signIns.set('g1', {});
        assert.throws(() => gw.startLibUpdate(), /signing in/);
        gw.signIns.clear();
    });

    test('while it runs: Gmails are out of the key pool and a Gmail key handed out before is passed over', async () => {
        const gw = setup();
        gw.statusCache = { at: Date.now(), accounts: [{ id: 'g1', enabled: true, state: 'ready' }] };
        gw.proc = {};
        assert.deepEqual(gw.keysForDubber(), ['gweb:g1']);
        gw.updating = true;
        assert.deepEqual(gw.keysForDubber(), []);
        const r = await gw.generate('gweb:g1', { contents: [] });
        assert.equal(r.code, 'GWEB_BUSY');
        gw.updating = false;
        gw.proc = null;
    });
});

describe('Gemini Web Router: who answered', () => {
    beforeEach(() => { const gw = getGeminiWebRouter(); gw.usage = { since: Date.now(), events: [], total: {} }; });

    test('Gmail answers, API answers and the reasons a Gmail was passed over', () => {
        const gw = getGeminiWebRouter();
        gw.noteUsage('gmail', { success: true });
        gw.noteUsage('gmail', { success: true });
        gw.noteUsage('api', { success: true });
        gw.noteUsage('api', { success: false, status: 429 }); // API failures are not counted
        gw.noteUsage('gmail', { success: false, status: 502, code: 'GWEB_BUSY' });
        gw.noteUsage('gmail', { success: false, status: 429, isDailyQuota: true });
        gw.noteUsage('gmail', { success: false, status: 502, code: 'GWEB_SIGNED_OUT' });
        gw.noteUsage('gmail', { success: false, status: 504 });
        const s = gw.usageSummary();
        assert.deepEqual(s.lastHour, { gmail: 2, api: 1, busy: 1, credits: 1, signedOut: 1, timeout: 1 });
        assert.deepEqual(s.total, s.lastHour);
    });

    test('routes/gemini.js reports answers only while the Router is on, never CodeCraft keys', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'gemini.js'), 'utf8').replace(/\r\n/g, '\n'); // CRLF on Windows CI
        const at = src.indexOf('function noteRouterUsage(');
        const fn = src.slice(at, src.indexOf('\n}\n', at) + 2);
        const noted = [];
        let on = true;
        const noteRouterUsage = new Function('deps', `const { isCodeCraftKey, geminiWeb, isGeminiWebKey } = deps; ${fn} return noteRouterUsage;`)({
            isCodeCraftKey: (k) => /^cc_/i.test(k),
            isGeminiWebKey: (k) => k.startsWith('gweb:'),
            geminiWeb: () => ({ settings: () => ({ useForDubbing: on }), noteUsage: (kind, r) => noted.push([kind, r.success]) })
        });
        noteRouterUsage('gweb:g1', { success: true });
        noteRouterUsage('AIzaKEY', { success: true });
        noteRouterUsage('cc_key', { success: true });
        on = false;
        noteRouterUsage('AIzaKEY', { success: true });
        assert.deepEqual(noted, [['gmail', true], ['api', true]]);
        // Every API success return in executeGeminiGenerate reports, except Check limits (onlyModel).
        assert.equal((src.match(/if \(!onlyModel && typeof noteRouterUsage === 'function'\) noteRouterUsage\(apiKey, \{ success: true \}\);/g) || []).length, 2);
    });

    test('the last hour forgets older answers; the total keeps them', () => {
        const gw = getGeminiWebRouter();
        gw.noteUsage('gmail', { success: true });
        gw.usage.events[0].at -= 2 * 3600 * 1000;
        gw.noteUsage('api', { success: true });
        const s = gw.usageSummary();
        assert.deepEqual(s.lastHour, { api: 1 });
        assert.deepEqual(s.total, { gmail: 1, api: 1 });
    });
});

describe('GET /api/gemini-web/dubber-keys', () => {
    const express = require('express');
    const createRoutes = require('../backend/routes/gemini-web');
    async function get(settings, accounts) {
        const gw = setup();
        fs.mkdirSync(path.join(process.env.APP_STORAGE_DIR, 'gemini_web'), { recursive: true });
        fs.writeFileSync(path.join(process.env.APP_STORAGE_DIR, 'gemini_web', 'settings.json'), JSON.stringify(settings));
        gw._settings = null;
        gw.statusCache = { at: Date.now(), accounts };
        gw.proc = {};
        const app = express();
        app.use('/api/gemini-web', createRoutes());
        const srv = app.listen(0, '127.0.0.1');
        await new Promise(r => srv.once('listening', r));
        try {
            const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/gemini-web/dubber-keys`);
            return await res.json();
        } finally { srv.close(); gw.proc = null; }
    }

    test('lists the ready Gmails and the Router first / Gmails only settings', async () => {
        const j = await get({ useForDubbing: true, routerFirst: true, gmailOnly: true },
            [{ id: 'g1', enabled: true, state: 'ready' }, { id: 'g2', enabled: true, state: 'limited' }, { id: 'g3', enabled: false, state: 'ready' }]);
        assert.deepEqual(j, { success: true, keys: ['gweb:g1'], routerFirst: true, gmailOnly: true });
    });

    test('Router off: no Gmails, and neither setting reported as on', async () => {
        const j = await get({ useForDubbing: false, routerFirst: true, gmailOnly: true }, [{ id: 'g1', enabled: true, state: 'ready' }]);
        assert.deepEqual(j, { success: true, keys: [], routerFirst: false, gmailOnly: false });
    });
});
