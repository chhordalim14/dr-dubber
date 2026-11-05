const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DRRouterManager, getDRRouterManager, parseProxyString, isKeyRejection, isLocalOrigin } = require('../backend/lib/dr-router');
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
        const rawKeys = `AIzaSyBulkOne111111111\nAIzaSyBulkTwo222222222\ncustom@gmail.com,AIzaSyBulkThree333333333`;
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
