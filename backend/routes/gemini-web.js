// /api/gemini-web: the Gemini Web Router page (frontend/js/gemini-web-modal.js).
const express = require('express');
const { getGeminiWebRouter } = require('../lib/gemini-web-router');

module.exports = function createGeminiWebRoutes() {
    const router = express.Router();
    const gw = getGeminiWebRouter();
    const wrap = (fn) => async (req, res) => {
        try { res.json({ success: true, ...(await fn(req, res)) }); }
        catch (e) { res.status(400).json({ success: false, error: e.message }); }
    };

    router.get('/status', wrap(async (req) => gw.status({ quota: req.query.quota === '1' })));

    router.post('/install', wrap(async () => { gw.installEnv(); return { install: gw.install }; }));

    // { useForDubbing?, routerFirst?, gmailOnly?, freeProxies?, model?, thinking? } - only the fields sent change.
    router.post('/settings', wrap(async (req) => ({ settings: gw.setSettings(req.body || {}) })));

    // Add a Gmail (optionally with its proxy: { autoProxy }, { proxyId } from DR Router PRO or { proxy } typed)
    // and start its hidden sign-in at once.
    router.post('/accounts', wrap(async (req) => {
        const { email, password, proxyId, proxy, autoProxy } = req.body || {};
        if (!gw.envReady()) throw new Error('Install the Gemini Web part first.');
        const wantAuto = autoProxy === true || proxy === 'auto' || proxyId === 'auto';
        // No proxy chosen: a new Gmail gets none, one signing in again keeps its own.
        const proxyUrl = wantAuto
            ? undefined
            : ((proxyId || (proxy && String(proxy).trim())) ? gw.resolveProxy({ proxyId, proxy }) : undefined);
        const acc = gw.addAccount(email, proxyUrl, { autoProxy: wantAuto });
        // Auto: one of your own proxies before the sign-in, so Google sees one address from the start.
        if (wantAuto && !acc.proxy) await gw.prepareAutoProxyForSignIn(acc.id);
        const signIn = await gw.startSignIn(acc.id, password);
        return { account: { id: acc.id, email: acc.email }, signIn };
    }));

    router.post('/accounts/:id/proxy', wrap(async (req) => {
        const body = req.body || {};
        if (body.autoProxy === true || body.proxy === 'auto' || body.proxyId === 'auto') {
            return await gw.assignAutoProxy(req.params.id);
        }
        await gw.setProxy(req.params.id, gw.resolveProxy(body));
        return {};
    }));

    router.post('/accounts/:id/auto-proxy', wrap(async (req) => gw.assignAutoProxy(req.params.id)));
    router.post('/auto-proxy-all', wrap(async () => gw.autoAssignAllProxies()));

    router.post('/accounts/:id/signin', wrap(async (req) => ({ signIn: await gw.startSignIn(req.params.id, (req.body || {}).password) })));
    router.post('/accounts/:id/code', wrap(async (req) => ({ signIn: gw.submitCode(req.params.id, (req.body || {}).code) })));
    router.post('/accounts/:id/show', wrap(async (req) => ({ signIn: await gw.showSignInWindow(req.params.id) })));
    router.post('/accounts/:id/cancel', wrap(async (req) => { gw.cancelSignIn(req.params.id); return {}; }));
    router.post('/accounts/:id/enabled', wrap(async (req) => { await gw.setEnabled(req.params.id, !!(req.body || {}).enabled); return {}; }));
    router.delete('/accounts/:id', wrap(async (req) => { await gw.removeAccount(req.params.id); return {}; }));

    // A small request through one account (or the next free one): proves it answers.
    router.post('/test', wrap(async (req) => {
        const id = (req.body || {}).account;
        const t = Date.now();
        const r = await gw.generate(`gweb:${id}`, { contents: [{ role: 'user', parts: [{ text: 'Translate to Khmer, answer with the Khmer only: 我们回家吧' }] }] });
        if (!r.success) throw new Error(r.message || r.error);
        return { text: r.text, ms: Date.now() - t };
    }));

    return router;
};
