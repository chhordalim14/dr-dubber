// DR Router PRO API Router for DR Dubber Pro
const express = require('express');

function createDRRouter(options = {}) {
    const router = express.Router();
    const mgr = options.drRouterManager || options.dapoolManager;

    if (!mgr) {
        throw new Error('createDRRouter requires drRouterManager instance');
    }
    // What the Gemini routes know about each account's key (routes/gemini.js geminiKeyStatus):
    // a model out for today, a whole key resting, or not answered since the daily reset. The
    // pool itself only knows whole-key rests, so an account out on its main model looked "Ready".
    const keyStatus = typeof options.keyStatus === 'function' ? options.keyStatus : null;
    const withGemini = (list) => (keyStatus ? list.map((a) => {
        const acc = mgr.accounts.find((x) => x.id === a.id);
        if (!acc || !acc.apiKey) return a;
        try {
            const s = keyStatus(acc.apiKey);
            return { ...a, gemini: { state: s.state, retryAfterMs: s.retryAfterMs || 0, checkedToday: s.checkedToday !== false, models: (s.models || []).map((m) => ({ model: m.model, daily: !!m.daily, retryAfterMs: m.retryAfterMs })) } };
        } catch (e) {
            return a;
        }
    }) : list);

    // Pool status and metrics
    router.get('/status', (req, res) => {
        mgr.touchClient();
        res.json({
            success: true,
            stats: mgr.getStats()
        });
    });

    // List of accounts
    router.get('/accounts', (req, res) => {
        mgr.touchClient();
        res.json({
            success: true,
            accounts: withGemini(mgr.getMaskedAccounts()),
            stats: mgr.getStats(),
            activity: mgr.getEvents(req.query && req.query.since)
        });
    });

    // Add new account
    router.post('/account/add', (req, res) => {
        const { email, apiKey } = req.body || {};
        try {
            const acc = mgr.addAccount({ email, apiKey });
            res.json({
                success: true,
                account: {
                    id: acc.id,
                    email: acc.email,
                    status: acc.status,
                    served: acc.served
                },
                stats: mgr.getStats()
            });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Bulk add accounts
    // rawText (Bulk Paste): answers what happened to every line - added, already in the pool,
    // repeated in the paste, or skipped (no Gemini key in it).
    router.post('/account/bulk-add', (req, res) => {
        const { accounts, rawText } = req.body || {};
        let result;
        if (Array.isArray(accounts)) {
            result = { added: mgr.addAccounts(accounts).length, alreadyInPool: 0, repeated: 0, skipped: [] };
        } else {
            result = mgr.bulkAddFromText(typeof rawText === 'string' ? rawText : '');
        }
        res.json({
            success: true,
            addedCount: result.added,
            alreadyInPool: result.alreadyInPool,
            repeated: result.repeated,
            skipped: result.skipped,
            accounts: mgr.getMaskedAccounts(),
            stats: mgr.getStats()
        });
    });

    // Delete account
    router.post('/account/delete', (req, res) => {
        const { id } = req.body || {};
        const deleted = mgr.deleteAccount(id);
        res.json({
            success: deleted,
            stats: mgr.getStats()
        });
    });

    // Delete every account whose key Google refused for good ("Remove invalid")
    router.post('/account/delete-invalid', (req, res) => {
        const deleted = mgr.deleteInvalidAccounts();
        res.json({ success: true, deleted, stats: mgr.getStats() });
    });

    // Toggle account enabled/disabled
    router.post('/account/toggle', (req, res) => {
        const { id, enabled } = req.body || {};
        const ok = mgr.toggleAccount(id, enabled);
        res.json({
            success: ok,
            stats: mgr.getStats()
        });
    });

    // Set routing strategy (round-robin | least-used | random)
    router.post('/strategy', (req, res) => {
        const { strategy } = req.body || {};
        const ok = mgr.setStrategy(strategy);
        res.json({
            success: ok,
            strategy: mgr.strategy,
            stats: mgr.getStats()
        });
    });

    // Test a single account
    router.post('/test', async (req, res) => {
        const { id } = req.body || {};
        try {
            const result = await mgr.testAccount(id);
            res.json({
                success: true,
                result,
                stats: mgr.getStats()
            });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Verify all accounts
    router.post('/verify-all', async (req, res) => {
        try {
            const results = await mgr.verifyAll();
            res.json({
                success: true,
                results,
                stats: mgr.getStats()
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // The pool's ready keys for the app's own batch (only answered to the app's window:
    // server.js's host/origin guard and launch token cover every /api route)
    router.get('/dubber-keys', (req, res) => {
        // Plus the Gemini Web Router's ready Gmails ("gweb:<id>"), so a batch gives them tabs too.
        let web = [];
        let routerFirst = false;
        try {
            const gw = require('../lib/gemini-web-router').getGeminiWebRouter();
            web = gw.keysForDubber();
            routerFirst = gw.settings().routerFirst !== false;
        } catch (e) { }
        const keys = mgr.batchKeys();
        res.json({ success: true, linked: mgr.linked, routerFirst, keys: [...keys, ...web.filter(k => !keys.includes(k))] });
    });

    // Link / unlink DR Dubber's own jobs from the pool
    router.post('/link', (req, res) => {
        const { linked } = req.body || {};
        res.json({
            success: true,
            linked: mgr.setLinked(linked),
            stats: mgr.getStats()
        });
    });

    // Fast mode on / off
    router.post('/fast-mode', (req, res) => {
        const { enabled } = req.body || {};
        res.json({
            success: true,
            fastMode: mgr.setFastMode(enabled === true),
            stats: mgr.getStats()
        });
    });

    // Toggle local proxy server (127.0.0.1:8765); the choice is kept for the next start
    router.post('/proxy/toggle', (req, res) => {
        const { enabled } = req.body || {};
        mgr.setProxyEnabled(!!enabled);
        res.json({
            success: true,
            stats: mgr.getStats()
        });
    });

    // --- PROXY MANAGEMENT ENDPOINTS ---

    // List all proxies
    router.get('/proxies', (req, res) => {
        mgr.touchClient();
        res.json({
            success: true,
            proxies: mgr.getMaskedProxies(),
            proxyMode: mgr.proxyMode,
            stats: mgr.getStats()
        });
    });

    // Add a single proxy
    router.post('/proxy/add', (req, res) => {
        try {
            const proxy = mgr.addProxy(req.body);
            res.json({
                success: true,
                proxy,
                proxies: mgr.getMaskedProxies(),
                stats: mgr.getStats()
            });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Bulk add proxies
    router.post('/proxy/bulk-add', (req, res) => {
        const { rawText, proxies } = req.body || {};
        try {
            const result = mgr.bulkAddProxies(rawText || proxies);
            res.json({
                success: true,
                addedCount: result.count,
                proxies: mgr.getMaskedProxies(),
                stats: mgr.getStats()
            });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Delete a proxy
    router.post('/proxy/delete', (req, res) => {
        const { id } = req.body || {};
        const ok = mgr.deleteProxy(id);
        res.json({
            success: ok,
            proxies: mgr.getMaskedProxies(),
            accounts: mgr.getMaskedAccounts(),
            stats: mgr.getStats()
        });
    });

    // Toggle proxy enabled
    router.post('/proxy/toggle-enabled', (req, res) => {
        const { id, enabled } = req.body || {};
        const ok = mgr.toggleProxy(id, enabled);
        res.json({
            success: ok,
            proxies: mgr.getMaskedProxies(),
            stats: mgr.getStats()
        });
    });

    // Set proxy mode: 'dedicated' | 'rotating'
    router.post('/proxy/mode', (req, res) => {
        const { mode } = req.body || {};
        const ok = mgr.setProxyMode(mode);
        res.json({
            success: ok,
            proxyMode: mgr.proxyMode,
            stats: mgr.getStats()
        });
    });

    // Bind proxy to account
    router.post('/proxy/bind', (req, res) => {
        const { accountId, proxyId } = req.body || {};
        const ok = mgr.bindProxyToAccount(accountId, proxyId);
        res.json({
            success: ok,
            accounts: mgr.getMaskedAccounts(),
            proxies: mgr.getMaskedProxies(),
            stats: mgr.getStats()
        });
    });

    // Auto-assign proxies 1:1 to accounts
    router.post('/proxy/auto-assign', (req, res) => {
        const result = mgr.autoAssignProxies();
        res.json({
            success: true,
            ...result,
            accounts: mgr.getMaskedAccounts(),
            proxies: mgr.getMaskedProxies(),
            stats: mgr.getStats()
        });
    });

    // Test a single proxy
    router.post('/proxy/test', async (req, res) => {
        const { id } = req.body || {};
        try {
            const result = await mgr.testProxy(id);
            res.json({
                success: true,
                result,
                proxies: mgr.getMaskedProxies(),
                stats: mgr.getStats()
            });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Test all proxies
    router.post('/proxy/test-all', async (req, res) => {
        try {
            const results = await mgr.testAllProxies();
            res.json({
                success: true,
                results,
                proxies: mgr.getMaskedProxies(),
                stats: mgr.getStats()
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
}

module.exports = createDRRouter;

