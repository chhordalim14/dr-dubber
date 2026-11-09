// Gemini Web Router proxies (backend/lib/gemini-web-router.js): every Gmail gets its own outside
// address - your own proxies (DR Router PRO) first, free public ones only to fill the gap - and a
// working Gmail keeps its proxy. The real router code against a fake Python service.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gweb-proxy-test-'));
process.env.APP_STORAGE_DIR = tmp;
const { getGeminiWebRouter } = require('../backend/lib/gemini-web-router');

const DIR = path.join(tmp, 'gemini_web');
const COOKIES = path.join(DIR, 'cookies');
const PC_IP = '9.9.9.9';

// world: proxy url -> { ip, works (passes the test), session (Google accepts a Gmail through it) }
function setup({ gmails, own = [], free = [], world = {}, settings = {} }) {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(COOKIES, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'accounts.json'), JSON.stringify(gmails.map((g) => ({ enabled: true, ...g }))));
    fs.writeFileSync(path.join(DIR, 'settings.json'), JSON.stringify(settings));
    for (const g of gmails) if (g.cookies !== false) fs.writeFileSync(path.join(COOKIES, `${g.id}.json`), '{"__Secure-1PSID":"x"}');
    const gw = getGeminiWebRouter();
    gw._settings = null;
    gw.proxyRotateTried.clear();
    gw.proxyDeadSince.clear();
    gw.publicProxyCache = { at: 0, list: [] };
    gw.ownProxies = () => own.map((url, i) => ({ id: `p${i}`, url }));
    gw.fetchPublicProxyCandidates = async () => free;
    gw.ensureService = async () => true;
    const calls = [];
    // Each Gmail's live state, as the Python service would report it after starting it.
    const liveOf = (a) => {
        if (!a.proxy) return { id: a.id, state: a.state || 'ready', ip: PC_IP };
        const w = world[a.proxy] || {};
        if (w.dead) return { id: a.id, state: 'error', ip: null, error: 'The proxy does not work: ConnectionError' };
        if (w.error) return { id: a.id, state: 'error', ip: w.ip, error: w.error };
        return { id: a.id, state: w.session === false ? 'error' : 'ready', ip: w.ip, error: w.session === false ? 'Google refused' : null };
    };
    const status = () => ({ accounts: gw.accounts().map(liveOf) });
    gw.call = async (p, body) => {
        calls.push({ p, body });
        if (p === '/test-proxies') {
            const avoid = new Set([...(body.avoidIps || []), PC_IP]);
            const out = [];
            for (const u of body.proxies) {
                const w = world[u];
                if (!w || w.works === false || avoid.has(w.ip) || out.some((x) => x.ip === w.ip)) continue;
                out.push({ proxy: u, ip: w.ip, ms: w.ms || 500 });
                if (out.length >= body.need) break;
            }
            return { ok: true, proxies: out };
        }
        const st = status();
        gw.statusCache = { at: Date.now(), accounts: st.accounts };
        return st;
    };
    gw.statusCache = { at: Date.now(), accounts: status().accounts };
    return { gw, calls, byId: (id) => gw.accounts().find((a) => a.id === id) };
}

describe('Gemini Web Router: one address per Gmail', () => {
    beforeEach(() => { getGeminiWebRouter()._settings = null; });

    test('own proxies first, free ones fill the gap, one Gmail keeps this PC; no two share', async () => {
        const world = {
            'http://own1:1': { ip: '1.0.0.1' }, 'http://own2:2': { ip: '1.0.0.2' },
            'http://free1:1': { ip: '2.0.0.1' }, 'http://free2:2': { ip: '2.0.0.2' }, 'http://free3:3': { ip: '2.0.0.3' }
        };
        const { gw, byId } = setup({
            gmails: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, email: `${id}@gmail.com` })),
            own: ['http://own1:1', 'http://own2:2'],
            free: ['http://free1:1', 'http://free2:2', 'http://free3:3'],
            world
        });
        const r = await gw.autoAssignAllProxies();
        const accs = gw.accounts();
        const onPc = accs.filter((a) => !a.proxy);
        assert.equal(onPc.length, 1, 'one Gmail stays on this PC');
        const sources = accs.filter((a) => a.proxy).map((a) => gw.proxySourceOf(a)).sort();
        assert.deepEqual(sources, ['free', 'free', 'own', 'own']);
        const ips = accs.map((a) => (a.proxy ? world[a.proxy].ip : PC_IP));
        assert.equal(new Set(ips).size, ips.length, 'every Gmail has its own address');
        assert.equal(r.failed.length, 0);
        assert.equal(r.summary.shared.length, 0);
        assert.ok(byId('a'));
    });

    test('a working Gmail on its own address is left alone', async () => {
        const world = { 'http://free1:1': { ip: '2.0.0.1' }, 'http://free9:9': { ip: '2.0.0.9' } };
        const { gw, calls } = setup({
            gmails: [{ id: 'a', email: 'a@gmail.com' }, { id: 'b', email: 'b@gmail.com', proxy: 'http://free1:1', autoProxy: true }],
            free: ['http://free9:9'],
            world
        });
        const r = await gw.autoAssignAllProxies();
        assert.equal(r.assigned.length, 0);
        assert.equal(gw.accounts().find((a) => a.id === 'b').proxy, 'http://free1:1', 'not moved to another free proxy');
        assert.ok(!calls.some((c) => c.p === '/reload'), 'nothing restarted');
    });

    test('a Gmail on a free proxy moves to one of yours when one is spare', async () => {
        const world = { 'http://free1:1': { ip: '2.0.0.1' }, 'http://own1:1': { ip: '1.0.0.1' } };
        const { gw, byId } = setup({
            gmails: [{ id: 'a', email: 'a@gmail.com' }, { id: 'b', email: 'b@gmail.com', proxy: 'http://free1:1', autoProxy: true }],
            own: ['http://own1:1'],
            world
        });
        const r = await gw.autoAssignAllProxies();
        assert.equal(r.upgraded.length, 1);
        assert.equal(byId('b').proxy, 'http://own1:1');
        assert.equal(gw.proxySourceOf(byId('b')), 'own');
    });

    test('Gmails sharing an address: all but one get another', async () => {
        const world = { 'http://own1:1': { ip: '1.0.0.1' }, 'http://own2:2': { ip: '1.0.0.2' } };
        const { gw } = setup({
            gmails: [{ id: 'a', email: 'a@gmail.com' }, { id: 'b', email: 'b@gmail.com' }, { id: 'c', email: 'c@gmail.com' }],
            own: ['http://own1:1', 'http://own2:2'],
            world
        });
        assert.equal(gw.proxySummary().shared[0].emails.length, 3, 'three on this PC are reported as shared');
        await gw.autoAssignAllProxies();
        assert.equal(gw.accounts().filter((a) => !a.proxy).length, 1);
        assert.equal(gw.proxySummary().shared.length, 0);
    });

    test('free proxies off: only your own; the rest are told to add proxies', async () => {
        const world = { 'http://own1:1': { ip: '1.0.0.1' }, 'http://free1:1': { ip: '2.0.0.1' } };
        const { gw } = setup({
            gmails: ['a', 'b', 'c'].map((id) => ({ id, email: `${id}@gmail.com` })),
            own: ['http://own1:1'],
            free: ['http://free1:1'],
            world,
            settings: { freeProxies: false }
        });
        const r = await gw.autoAssignAllProxies();
        assert.ok(!gw.accounts().some((a) => a.proxy === 'http://free1:1'));
        assert.equal(r.failed.length, 1);
        assert.match(r.failed[0].error, /Add proxies in DR Router PRO/);
        assert.equal(gw.proxySummary().needMore, 1);
    });

    test('a proxy Google refuses the Gmail through is not kept; the next one is tried', async () => {
        const world = { 'http://free1:1': { ip: '2.0.0.1', session: false }, 'http://free2:2': { ip: '2.0.0.2' } };
        const { gw, byId } = setup({
            gmails: [{ id: 'a', email: 'a@gmail.com' }, { id: 'b', email: 'b@gmail.com' }],
            free: ['http://free1:1', 'http://free2:2'],
            world
        });
        const r = await gw.assignAutoProxy('b');
        assert.equal(r.source, 'free');
        assert.equal(byId('b').proxy, 'http://free2:2');
        const h = gw.proxyHistory();
        assert.equal(Object.values(h).find((e) => e.url === 'http://free1:1').fail, 1);
        assert.equal(Object.values(h).find((e) => e.url === 'http://free2:2').ok, 1);
        // Next time the proven one is tried first.
        assert.equal(gw.provenFreeProxies()[0], 'http://free2:2');
    });

    test('a dead proxy is tried once more before the Gmail moves; other errors keep it', async () => {
        const world = { 'http://free1:1': { dead: true }, 'http://free2:2': { ip: '2.0.0.2' }, 'http://free9:9': { ip: '2.0.0.9', error: 'Gemini says no' } };
        const { gw, byId } = setup({
            gmails: [
                { id: 'a', email: 'a@gmail.com' },
                { id: 'b', email: 'b@gmail.com', proxy: 'http://free1:1', autoProxy: true },
                { id: 'c', email: 'c@gmail.com', proxy: 'http://free9:9', autoProxy: true }
            ],
            free: ['http://free2:2'],
            world
        });
        await gw.keepSessionsAlive();
        assert.equal(byId('b').proxy, 'http://free1:1', 'first time: kept, only reconnected');
        gw.proxyDeadSince.set('b', Date.now() - 4 * 60 * 1000);
        await gw.keepSessionsAlive();
        assert.equal(byId('b').proxy, 'http://free2:2', 'still dead minutes later: moved');
        assert.equal(byId('c').proxy, 'http://free9:9', 'not a proxy problem: not moved');
    });

    test('a new Gmail set to Auto signs in through one of your own proxies', async () => {
        const world = { 'http://u:p@own1:1': { ip: '1.0.0.1' }, 'socks5://u:p@own2:2': { ip: '1.0.0.2' } };
        const { gw, byId } = setup({ gmails: [], own: ['socks5://u:p@own2:2', 'http://u:p@own1:1'], world });
        const acc = gw.addAccount('new@gmail.com', undefined, { autoProxy: true });
        await gw.prepareAutoProxyForSignIn(acc.id);
        // Chrome cannot use a SOCKS proxy with a password: the http one is picked.
        assert.equal(byId(acc.id).proxy, 'http://u:p@own1:1');
        const p = gw.chromeProxyFor(byId(acc.id));
        assert.equal(p.host, 'own1');
        // A free proxy is never used by the sign-in Chrome.
        assert.equal(gw.chromeProxyFor({ proxy: 'http://free1:1', autoProxy: true, proxySource: 'free' }), null);
    });
});
