// DR Router PRO API Router for DR Dubber Pro
const express = require('express');

function createDRRouter(options = {}) {
    const router = express.Router();
    const mgr = options.drRouterManager || options.dapoolManager;

    if (!mgr) {
        throw new Error('createDRRouter requires drRouterManager instance');
    }

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
            accounts: mgr.getMaskedAccounts(),
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
    router.post('/account/bulk-add', (req, res) => {
        const { accounts, rawText } = req.body || {};
        const toAdd = [];
        if (Array.isArray(accounts)) {
            toAdd.push(...accounts);
        } else if (typeof rawText === 'string') {
            const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
            lines.forEach((line, idx) => {
                let email = '';
                let apiKey = '';
                if (line.includes(',')) {
                    const parts = line.split(',');
                    email = parts[0].trim();
                    apiKey = parts[1].trim();
                } else if (line.includes(':') && !line.startsWith('AIzaSy')) {
                    const parts = line.split(':');
                    email = parts[0].trim();
                    apiKey = parts[1].trim();
                } else if (line.includes('\t') || (line.includes(' ') && !line.startsWith('AIzaSy'))) {
                    const parts = line.split(/\s+/);
                    email = parts[0];
                    apiKey = parts[1] || '';
                } else {
                    apiKey = line;
                    email = `account_${mgr.accounts.length + idx + 1}@gmail.com`;
                }
                if (apiKey) toAdd.push({ email, apiKey });
            });
        }
        const added = mgr.addAccounts(toAdd);
        res.json({
            success: true,
            addedCount: added.length,
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
        res.json({ success: true, linked: mgr.linked, keys: mgr.batchKeys() });
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

    // Toggle local proxy server (127.0.0.1:8765)
    router.post('/proxy/toggle', (req, res) => {
        const { enabled } = req.body || {};
        if (enabled && !mgr.proxyActive) {
            mgr.startProxy();
        } else if (!enabled && mgr.proxyActive) {
            mgr.stopProxy();
        }
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

