const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const net = require('net');
const { DRRouterManager, getDRRouterManager, parseProxyString, isKeyRejection, isDeadKeyRejection, isLocalOrigin, readQuotaError, maskProxyUrl } = require('../backend/lib/dr-router');
const { secureFetch } = require('../backend/lib/secure-fetch');
const createDRRouter = require('../backend/routes/dr-router');

test('DR Router PRO - Manager and API routes', async (t) => {
    const tempConfig = path.join(os.tmpdir(), `dr_router_test_${Date.now()}.json`);

    t.after(() => {
        try { if (fs.existsSync(tempConfig)) fs.unlinkSync(tempConfig); } catch (e) {}
    });

    const mgr = new DRRouterManager({ configPath: tempConfig, port: 8766 });

    await t.test('initializes with empty pool and default strategy', () => {
        const stats = mgr.getStats();
        assert.equal(stats.total, 0);
        assert.equal(stats.ready, 0);
        assert.equal(stats.strategy, 'round-robin');
        assert.equal(stats.port, 8766);
    });

    await t.test('adds, masks, and retrieves accounts', () => {
        const acc1 = mgr.addAccount({ email: 'mytestuser@gmail.com', apiKey: 'AIzaSyFakeKey123456789' });
        assert.equal(acc1.email, 'mytestuser@gmail.com');
        assert.equal(acc1.status, 'ready');

        const acc2 = mgr.addAccount({ email: 'seconduser@gmail.com', apiKey: 'AIzaSyAnotherFakeKey987' });
        assert.equal(acc2.email, 'seconduser@gmail.com');

        const masked = mgr.getMaskedAccounts();
        assert.equal(masked.length, 2);
        assert.equal(masked[0].maskedEmail, 'myt***@***');
        assert.equal(masked[1].maskedEmail, 'sec***@***');
        assert.ok(masked[0].maskedKey.includes('...'));

        const stats = mgr.getStats();
        assert.equal(stats.total, 2);
        assert.equal(stats.ready, 2);
    });

    await t.test('routing strategy round-robin / least-used / random', () => {
        mgr.setStrategy('round-robin');
        const k1 = mgr.getNextAccount();
        const k2 = mgr.getNextAccount();
        assert.notEqual(k1.id, k2.id);

        mgr.setStrategy('least-used');
        mgr.markSuccess(k1.id);
        const nextLeast = mgr.getNextAccount();
        assert.equal(nextLeast.id, k2.id); // k2 served 0, k1 served 1
    });

    await t.test('mark rate limited cools account down', () => {
        const accs = mgr.getReadyAccounts();
        assert.equal(accs.length, 2);
        mgr.markRateLimited(accs[0].id, 10000);

        const readyAfter = mgr.getReadyAccounts();
        assert.equal(readyAfter.length, 1);
        assert.equal(readyAfter[0].id, accs[1].id);
    });

    await t.test('DR Router express router endpoints respond correctly', async () => {
        const router = createDRRouter({ drRouterManager: mgr });
        assert.ok(router);

        // Test status handler
        let statusJson = null;
        const mockReq = { body: {} };
        const mockRes = {
            json: (obj) => { statusJson = obj; return mockRes; },
            status: () => mockRes
        };

        const statusRoute = router.stack.find(s => s.route && s.route.path === '/status');
        assert.ok(statusRoute);
        statusRoute.route.stack[0].handle(mockReq, mockRes);
        assert.equal(statusJson.success, true);
        assert.equal(statusJson.stats.total, 2);

        // Test accounts handler
        let accountsJson = null;
        const accountsRoute = router.stack.find(s => s.route && s.route.path === '/accounts');
        assert.ok(accountsRoute);
        accountsRoute.route.stack[0].handle(mockReq, {
            json: (obj) => { accountsJson = obj; return mockRes; }
        });
        assert.equal(accountsJson.success, true);
        assert.equal(accountsJson.accounts.length, 2);

        // Test strategy change
        let stratJson = null;
        const stratRoute = router.stack.find(s => s.route && s.route.path === '/strategy');
        assert.ok(stratRoute);
        stratRoute.route.stack[0].handle({ body: { strategy: 'random' } }, {
            json: (obj) => { stratJson = obj; return mockRes; }
        });
        assert.equal(stratJson.success, true);
        assert.equal(stratJson.strategy, 'random');

        // Test bulk-add handler
        let bulkJson = null;
        const bulkRoute = router.stack.find(s => s.route && s.route.path === '/account/bulk-add');
        assert.ok(bulkRoute);
        const rawKeys = `${fakeKey('BulkOne')}\n${fakeKey('BulkTwo')}\ncustom@gmail.com,${fakeKey('BulkThree')}`;
        bulkRoute.route.stack[0].handle({ body: { rawText: rawKeys } }, {
            json: (obj) => { bulkJson = obj; return mockRes; }
        });
        assert.equal(bulkJson.success, true);
        assert.equal(bulkJson.addedCount, 3);
        assert.equal(mgr.accounts.length, 5);
    });

    await t.test('persists and reloads configuration', () => {
        mgr.save();
        assert.ok(fs.existsSync(tempConfig));

        const mgr2 = new DRRouterManager({ configPath: tempConfig, port: 8766 });
        assert.equal(mgr2.accounts.length, 5);
        assert.equal(mgr2.strategy, 'random');
    });

    await t.test('orders pool keys by strategy for the dubbing pipeline', () => {
        mgr.accounts.forEach(a => { a.cooldownUntil = 0; a.status = 'ready'; a.inFlight = 0; });
        mgr.setStrategy('round-robin');
        const first = mgr.orderedReadyKeys();
        const second = mgr.orderedReadyKeys();
        assert.equal(first.length, mgr.accounts.length);
        assert.notEqual(first[0], second[0]);          // each job starts on the next account
        assert.deepEqual([...first].sort(), [...second].sort());

        mgr.setStrategy('least-used');
        const busy = mgr.accounts[0];
        mgr.trackInFlight(busy.id, 1);
        assert.notEqual(mgr.orderedReadyKeys()[0], busy.apiKey);
        mgr.trackInFlight(busy.id, -1);
    });

    await t.test('records live activity for the dashboard', () => {
        const { seq: before } = mgr.getEvents(0);
        const acc = mgr.accounts[1];
        mgr.trackInFlight(acc.id, 1);
        mgr.trackInFlight(acc.id, -1);
        mgr.markSuccess(acc.id);
        const { seq, events } = mgr.getEvents(before);
        assert.equal(seq, before + 2);
        assert.deepEqual(events.map(e => e.type), ['start', 'ok']);
        assert.equal(mgr.getEvents(seq).events.length, 0);
    });

    await t.test('only retires a key when Google rejects the key itself', () => {
        assert.equal(isKeyRejection(400, '{"error":{"message":"Invalid JSON payload"}}'), false);
        assert.equal(isKeyRejection(400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'), true);
        assert.equal(isKeyRejection(403, ''), true);
        assert.equal(isKeyRejection(500, 'API key not valid'), false);
        // ...but only a bad key is retired for good: a 403 (region, API not enabled) can pass
        assert.equal(isDeadKeyRejection(400, 'API key not valid. Please pass a valid API key.'), true);
        assert.equal(isDeadKeyRejection(401, ''), true);
        assert.equal(isDeadKeyRejection(403, ''), false);
    });

    await t.test('proxy refuses requests from web pages', () => {
        assert.equal(isLocalOrigin('http://localhost:3001'), true);
        assert.equal(isLocalOrigin('http://127.0.0.1:5173'), true);
        assert.equal(isLocalOrigin('https://evil.example'), false);
        assert.equal(isLocalOrigin('http://localhost.evil.example'), false);
        assert.equal(isLocalOrigin('null'), false);
    });

    await t.test('unlinking keeps the pool away from DR Dubber jobs and survives a restart', () => {
        mgr.accounts.forEach(a => { a.cooldownUntil = 0; a.status = 'ready'; });
        assert.ok(mgr.keysForDubber().length > 0);
        mgr.setLinked(false);
        assert.deepEqual(mgr.keysForDubber(), []);
        assert.equal(mgr.getStats().linked, false);
        assert.ok(mgr.pickAccount());                 // the proxy still serves outside tools

        const reloaded = new DRRouterManager({ configPath: tempConfig, port: 8766 });
        assert.equal(reloaded.linked, false);
        mgr.setLinked(true);
        assert.ok(mgr.keysForDubber().length > 0);
    });

    await t.test('fast mode is off by default, can be turned on, and survives a restart', () => {
        assert.equal(mgr.getStats().fastMode, false);
        mgr.setFastMode(true);
        assert.equal(mgr.getStats().fastMode, true);
        assert.equal(new DRRouterManager({ configPath: tempConfig, port: 8766 }).fastMode, true);
        mgr.setFastMode(false);
        assert.equal(new DRRouterManager({ configPath: tempConfig, port: 8766 }).fastMode, false);
    });

    await t.test('parses proxy strings in various standard formats', () => {
        const p1 = parseProxyString('1.2.3.4:8080');
        assert.equal(p1.host, '1.2.3.4');
        assert.equal(p1.port, 8080);
        assert.equal(p1.protocol, 'http');
        assert.equal(p1.url, 'http://1.2.3.4:8080');

        const p2 = parseProxyString('socks5://user:pass@10.0.0.1:1080');
        assert.equal(p2.protocol, 'socks5');
        assert.equal(p2.host, '10.0.0.1');
        assert.equal(p2.port, 1080);
        assert.equal(p2.username, 'user');
        assert.equal(p2.password, 'pass');
        assert.equal(p2.url, 'socks5://user:pass@10.0.0.1:1080');

        const p3 = parseProxyString('5.6.7.8:3128:myadmin:secretpass');
        assert.equal(p3.host, '5.6.7.8');
        assert.equal(p3.port, 3128);
        assert.equal(p3.username, 'myadmin');
        assert.equal(p3.password, 'secretpass');
        assert.equal(p3.url, 'http://myadmin:secretpass@5.6.7.8:3128');

        assert.equal(parseProxyString(''), null);
        assert.equal(parseProxyString('# commented proxy'), null);
    });

    await t.test('adds, bulk adds, and dedupes proxies', () => {
        const p1 = mgr.addProxy('10.20.30.40:8080');
        assert.ok(p1.id);
        assert.equal(p1.host, '10.20.30.40');

        const bulk = mgr.bulkAddProxies(`
            11.22.33.44:3128
            socks5://12.23.34.45:1080
            10.20.30.40:8080
        `);
        assert.equal(bulk.count, 3);
        assert.equal(mgr.proxies.length, 3); // 10.20.30.40 was deduped
    });

    await t.test('dedicated mode: binds proxy to account and routes requests by key', () => {
        mgr.setProxyMode('dedicated');
        const acc = mgr.accounts[0];
        const proxy = mgr.proxies[0];

        const bound = mgr.bindProxyToAccount(acc.id, proxy.id);
        assert.equal(bound, true);

        // Check proxy URL for account
        const accProxy = mgr.getProxyForAccount(acc.id);
        assert.equal(accProxy, proxy.url);

        // Check proxy URL for API key
        const keyProxy = mgr.getProxyForApiKey(acc.apiKey);
        assert.equal(keyProxy, proxy.url);

        // Account 2 has no proxy
        assert.equal(mgr.getProxyForAccount(mgr.accounts[1].id), null);
    });

    await t.test('rotating mode: rotates requests across available proxies', () => {
        mgr.setProxyMode('rotating');
        const r1 = mgr.getProxyForAccount(null);
        const r2 = mgr.getProxyForAccount(null);
        assert.ok(r1);
        assert.ok(r2);
        assert.notEqual(r1, r2);

        // Switching back to dedicated
        mgr.setProxyMode('dedicated');
    });

    await t.test('auto-assigns proxies 1:1 to accounts', () => {
        const res = mgr.autoAssignProxies();
        assert.ok(res.assignedCount >= 2);
        assert.ok(mgr.accounts[0].proxyId);
        assert.ok(mgr.accounts[1].proxyId);
        assert.notEqual(mgr.accounts[0].proxyId, mgr.accounts[1].proxyId);

        const masked = mgr.getMaskedAccounts();
        assert.ok(masked[0].proxyHost);
        assert.ok(masked[1].proxyHost);
    });

    await t.test('deleting proxy unbinds it from accounts', () => {
        const proxyId = mgr.accounts[0].proxyId;
        assert.ok(proxyId);
        mgr.deleteProxy(proxyId);
        assert.equal(mgr.accounts[0].proxyId, null);
        assert.equal(mgr.getProxyForAccount(mgr.accounts[0].id), null);
    });

    await t.test('proxy API routes in express router', async () => {
        const router = createDRRouter({ drRouterManager: mgr });
        const mockRes = {
            json: (obj) => { mockRes.lastJson = obj; return mockRes; },
            status: () => mockRes
        };

        // GET /proxies
        const listRoute = router.stack.find(s => s.route && s.route.path === '/proxies');
        assert.ok(listRoute);
        listRoute.route.stack[0].handle({ query: {} }, mockRes);
        assert.equal(mockRes.lastJson.success, true);
        assert.ok(Array.isArray(mockRes.lastJson.proxies));

        // POST /proxy/add
        const addRoute = router.stack.find(s => s.route && s.route.path === '/proxy/add');
        assert.ok(addRoute);
        addRoute.route.stack[0].handle({ body: { host: '99.88.77.66', port: 8080, protocol: 'http' } }, mockRes);
        assert.equal(mockRes.lastJson.success, true);
        assert.equal(mockRes.lastJson.proxy.host, '99.88.77.66');

        // POST /proxy/mode
        const modeRoute = router.stack.find(s => s.route && s.route.path === '/proxy/mode');
        assert.ok(modeRoute);
        modeRoute.route.stack[0].handle({ body: { mode: 'rotating' } }, mockRes);
        assert.equal(mockRes.lastJson.success, true);
        assert.equal(mockRes.lastJson.proxyMode, 'rotating');
    });

    await t.test('batch keys: ready pool accounts in a stable order, none while unlinked', () => {
        mgr.accounts.forEach(a => { a.cooldownUntil = 0; a.status = 'ready'; a.enabled = true; });
        mgr.setLinked(true);
        mgr.setStrategy('round-robin');
        const first = mgr.batchKeys();
        assert.equal(first.length, mgr.accounts.length);
        assert.deepEqual(mgr.batchKeys(), first, 'polling does not rotate the list');

        mgr.markRateLimited(mgr.accounts[0].id, 60000);
        assert.ok(!mgr.batchKeys().includes(mgr.accounts[0].apiKey), 'a resting account is left out');

        mgr.setLinked(false);
        assert.deepEqual(mgr.batchKeys(), []);
        mgr.setLinked(true);
        mgr.accounts[0].cooldownUntil = 0;
    });
});

test('bulk paste: finds the key in each line, skips lines without one, says what happened', (t) => {
    const { mgr, configPath, cleanup } = tempManager();
    t.after(cleanup);
    const known = mgr.addAccount({ email: 'known@gmail.com', apiKey: fakeKey('Known') });
    let writes = 0;
    const save = mgr.save.bind(mgr);
    mgr.save = () => { writes++; save(); };

    const pasted = [
        'email,key',                                  // a header row
        fakeKey('Plain'),
        `user1@gmail.com,${fakeKey('Comma')}`,
        `user2@gmail.com:${fakeKey('Colon')}`,
        `user3@gmail.com\t${fakeKey('Tab')}`,
        `  ${fakeKey('Plain')}  `,                    // the same key again
        fakeKey('Known'),                             // already in the pool, no email given
        fakeKey('Short').slice(0, 30),                // a key cut short
        `user4@gmail.com,${NEW_KEY}`,                 // Google's newer key form
        'AQ.Ab8RN6short',                             // ...cut short
        ''
    ].join('\r\n');
    const r = mgr.bulkAddFromText(pasted);

    assert.equal(r.added, 5);
    assert.equal(r.alreadyInPool, 1);
    assert.equal(r.repeated, 1);
    assert.deepEqual(r.skipped.map(s => s.line), [1, 8, 10]);
    assert.equal(writes, 1, 'the pool file is written once, not once per key');
    assert.equal(mgr.accounts.length, 6);
    assert.equal(mgr.findByKey(NEW_KEY).email, 'user4@gmail.com');
    assert.equal(mgr.findByKey(fakeKey('Comma')).email, 'user1@gmail.com');
    assert.equal(mgr.findByKey(fakeKey('Colon')).email, 'user2@gmail.com');
    assert.equal(mgr.findByKey(fakeKey('Tab')).email, 'user3@gmail.com');
    assert.match(mgr.findByKey(fakeKey('Plain')).email, /^account_\d+@gmail\.com$/);
    assert.equal(known.email, 'known@gmail.com', 'pasting a known key without an email keeps its name');
    assert.equal(new DRRouterManager({ configPath, port: 8766 }).accounts.length, 6);
});

// Google's newer key form ("AQ." + a long code), as Settings shows them: "AQ.Ab8RN...JrTg".
const NEW_KEY = 'AQ.Ab8RN6' + 'k3Xb_q-9ZtLm2WvYp7RfHs0aDcE4gNuQwI1oJyT5lB8x'.padEnd(60, 'Q') + 'JrTg';

// A Gemini-shaped key: "AIzaSy" + a tag, padded to the real 39 characters.
function fakeKey(tag) {
    return `AIzaSy${tag}`.padEnd(39, '0');
}

function tempManager(extra = {}) {
    const configPath = path.join(os.tmpdir(), `dr_router_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.json`);
    const mgr = new DRRouterManager({ configPath, port: 8766, ...extra });
    const cleanup = () => {
        for (const f of fs.readdirSync(os.tmpdir())) {
            if (f.startsWith(path.basename(configPath))) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
        }
    };
    return { mgr, configPath, cleanup };
}

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

test('a 429 rests the account as long as Google asks; "daily quota" is rechecked before it is trusted', (t) => {
    const { mgr, cleanup } = tempManager();
    t.after(cleanup);
    const acc = mgr.addAccount({ email: 'a@gmail.com', apiKey: 'AIzaSyQuotaTest00000001' });
    const now = Date.now();
    const rest = (body) => mgr.restFromQuota(acc.id, JSON.stringify(body), now);

    assert.equal(rest({ error: { details: [{ retryDelay: '30s' }] } }), 30500);
    assert.equal(rest({ error: { message: 'Please retry in 12.5s' } }), 13000);

    const daily = { error: { details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { retryDelay: '20s' }] } };
    assert.deepEqual(readQuotaError(JSON.stringify(daily)), { daily: true, retryMs: 20000 });
    assert.equal(rest(daily), 15 * 60 * 1000, 'first daily answer: recheck in 15 min');
    assert.equal(rest(daily), 60 * 60 * 1000, 'second: in 1 h');
    assert.ok(rest(daily) > 60 * 1000, 'third: until the reset');
    assert.equal(mgr.getReadyAccounts().length, 0);
    assert.match(mgr.accounts[0].lastError, /Daily quota/);

    // a long wait Google states itself is believed at once
    assert.equal(rest({ error: { message: 'Daily quota exceeded. Please retry in 5h0m0s' } }), 5 * 3600 * 1000 + 60 * 1000);
});

test('a refused key (403) rests; only a bad key is retired', (t) => {
    const { mgr, cleanup } = tempManager();
    t.after(cleanup);
    const acc = mgr.addAccount({ email: 'a@gmail.com', apiKey: 'AIzaSyRefusedTest000001' });
    mgr.markRejected(acc.id, 'HTTP 403', 60000);
    assert.equal(acc.status, 'cooling');
    assert.equal(mgr.getReadyAccounts().length, 0);
    acc.cooldownUntil = 0;
    assert.equal(mgr.getReadyAccounts().length, 1, 'back once the rest is over');
});

test('picking for the proxy skips tried and resting accounts', (t) => {
    const { mgr, cleanup } = tempManager();
    t.after(cleanup);
    const a = mgr.addAccount({ email: 'a@gmail.com', apiKey: 'AIzaSyPickTest000000001' });
    const b = mgr.addAccount({ email: 'b@gmail.com', apiKey: 'AIzaSyPickTest000000002' });
    assert.equal(mgr.pickAccount({ exclude: new Set([a.id]), readyOnly: true }).id, b.id);
    assert.equal(mgr.pickAccount({ exclude: new Set([a.id, b.id]), readyOnly: true }), null);
    mgr.markRateLimited(a.id, 60000);
    mgr.markRateLimited(b.id, 60000);
    assert.equal(mgr.pickAccount({ readyOnly: true }), null);
    assert.ok(mgr.pickAccount(), 'without readyOnly the soonest-free account is still offered');
});

test('the pool file is saved whole, and an unreadable one is kept rather than wiped', (t) => {
    const { mgr, configPath, cleanup } = tempManager();
    t.after(cleanup);
    mgr.addAccount({ email: 'a@gmail.com', apiKey: 'AIzaSySaveTest000000001' });
    assert.ok(fs.existsSync(configPath));
    assert.ok(!fs.existsSync(`${configPath}.tmp`), 'no temp file left behind');

    fs.writeFileSync(configPath, '{"accounts":[{"apiKey":"AIzaSyHalfWritt');
    const reloaded = new DRRouterManager({ configPath, port: 8766 });
    assert.equal(reloaded.accounts.length, 0);
    const kept = fs.readdirSync(path.dirname(configPath)).filter(f => f.startsWith(`${path.basename(configPath)}.broken-`));
    assert.equal(kept.length, 1, 'the broken file is copied aside before anything overwrites it');
});

test('the proxy on/off switch survives a restart', (t) => {
    const { mgr, configPath, cleanup } = tempManager();
    t.after(cleanup);
    assert.equal(mgr.proxyEnabled, true);
    mgr.setProxyEnabled(false);
    assert.equal(new DRRouterManager({ configPath, port: 8766 }).proxyEnabled, false);
    assert.equal(mgr.getStats().proxyEnabled, false);
});

test('proxy passwords stay out of the dashboard and may contain @', (t) => {
    const { mgr, cleanup } = tempManager();
    t.after(cleanup);
    const p = parseProxyString('http://user:p@ss@1.2.3.4:8080');
    assert.equal(p.host, '1.2.3.4');
    assert.equal(p.password, 'p@ss');
    assert.equal(maskProxyUrl('http://user:secret@1.2.3.4:8080'), 'http://user:••••@1.2.3.4:8080');
    mgr.addProxy('5.6.7.8:3128:admin:secret');
    assert.ok(!JSON.stringify(mgr.getMaskedProxies()).includes('secret'));
});

test('a request given a proxy goes through it, never direct', async (t) => {
    const seen = [];
    const fakeProxy = net.createServer((sock) => sock.once('data', (b) => { seen.push(b.toString('latin1')); sock.destroy(); }));
    await new Promise(r => fakeProxy.listen(0, '127.0.0.1', r));
    t.after(() => fakeProxy.close());
    await assert.rejects(secureFetch('https://generativelanguage.googleapis.com/v1beta/models', {
        proxy: `http://127.0.0.1:${fakeProxy.address().port}`, signal: AbortSignal.timeout(5000)
    }));
    assert.ok(seen.some(s => s.startsWith('CONNECT generativelanguage.googleapis.com:443')), 'the proxy was asked to connect');
});

test('local proxy: a rate-limited account hands the request to the next one; key in a header', async (t) => {
    const asked = [];
    const google = http.createServer((req, res) => {
        const key = req.headers['x-goog-api-key'];
        asked.push({ key, url: req.url });
        if (key === 'AIzaSyProxyBusy0000001') {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 429, details: [{ retryDelay: '40s' }] } }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"part":1}\n\n');
        setTimeout(() => res.end('data: {"part":2}\n\n'), 20);
    });
    await new Promise(r => google.listen(0, '127.0.0.1', r));
    const port = await freePort();
    const { mgr, cleanup } = tempManager({ port, upstreamBase: `http://127.0.0.1:${google.address().port}` });
    t.after(() => { mgr.stopProxy(); google.close(); cleanup(); });

    const busy = mgr.addAccount({ email: 'busy@gmail.com', apiKey: 'AIzaSyProxyBusy0000001' });
    const free = mgr.addAccount({ email: 'free@gmail.com', apiKey: 'AIzaSyProxyFree0000002' });
    mgr.startProxy();
    await new Promise(r => mgr.proxyServer.once('listening', r));

    const url = `http://127.0.0.1:${port}/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse&key=CALLERS_OWN`;
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'data: {"part":1}\n\ndata: {"part":2}\n\n');
    assert.equal(res.headers.get('x-dr-router-account'), free.id);
    assert.deepEqual(asked.map(a => a.key), [busy.apiKey, free.apiKey]);
    assert.ok(asked.every(a => a.url === '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse'), 'no key in the URL');
    assert.ok(busy.cooldownUntil - Date.now() > 35000, 'the 40 s retry time Google gave is kept');
    assert.equal(free.served, 1);

    // every account resting: answered at once, with when to come back
    mgr.markRateLimited(free.id, 30000);
    asked.length = 0;
    const resting = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(resting.status, 429);
    assert.ok(Number(resting.headers.get('retry-after')) >= 29);
    assert.equal((await resting.json()).error.code, 'ALL_ACCOUNTS_RESTING');
    assert.equal(asked.length, 0, 'no resting key was spent');
});

test('local proxy: a taken port is reported, not silent', async (t) => {
    const blocker = net.createServer();
    await new Promise(r => blocker.listen(0, '127.0.0.1', r));
    const { mgr, cleanup } = tempManager({ port: blocker.address().port });
    t.after(() => { mgr.stopProxy(); blocker.close(); cleanup(); });
    mgr.startProxy();
    await new Promise(r => setTimeout(r, 100));
    assert.equal(mgr.proxyActive, false);
    assert.match(mgr.getStats().proxyError, /already in use/);
    assert.equal(mgr.proxyServer, null, 'switching it on again can retry');
});
