const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const security = require('../backend/lib/security');

describe('isNetworkPath', () => {
    const network = ['\\\\host\\share\\x.mp4', '//host/share/x.mp4', 'file://host/share/x.mp4', 'file:////host/share/x.mp4', '\\\\?\\C:\\x.mp4'];
    const local = ['/Users/me/x.mp4', 'C:\\Videos\\x.mp4', 'D:/x.mp4', 'file:///Users/me/x.mp4', 'file:///C:/x.mp4', 'file://localhost/Users/me/x.mp4', 'relative/x.mp4'];
    for (const p of network) test(`network: ${p}`, () => assert.strictEqual(security.isNetworkPath(p), true));
    for (const p of local) test(`local: ${p}`, () => assert.strictEqual(security.isNetworkPath(p), false));
});

describe('file type checks', () => {
    test('media, subtitles, images and fonts can be served', () => {
        for (const p of ['/a/b.mp4', '/a/b.MKV', '/a/b.wav', '/a/b.srt', '/a/b.png', '/a/b.ttf']) assert.ok(security.isServableMedia(p), p);
    });
    test('other files cannot', () => {
        for (const p of ['/Users/me/.ssh/id_rsa', '/a/b.json', '/a/b.sh', '/a/b.exe', '/a/b', '\\\\host\\s\\b.mp4']) assert.ok(!security.isServableMedia(p), p);
    });
    test('audio check', () => {
        assert.ok(security.isAudioFile('/a/voice.mp3'));
        assert.ok(!security.isAudioFile('/a/run.sh'));
        assert.ok(!security.isAudioFile('//host/a/voice.mp3'));
    });
});

describe('safeOutputFileName', () => {
    test('keeps a normal name', () => assert.strictEqual(security.safeOutputFileName('Ep 01_DR_Dubbed.mp4', ['.mp4'], 'x.mp4'), 'Ep 01_DR_Dubbed.mp4'));
    test('strips folders', () => assert.strictEqual(security.safeOutputFileName('../../evil.mp4', ['.mp4'], 'x.mp4'), 'evil.mp4'));
    test('forces the extension', () => assert.strictEqual(security.safeOutputFileName('run.sh', ['.mp3'], 'x.mp3'), 'run.mp3'));
    test('falls back when empty', () => assert.strictEqual(security.safeOutputFileName('..', ['.mp4'], 'x.mp4'), 'x.mp4'));
});

describe('CSP', () => {
    test('hashes static inline handlers exactly as the browser sees them', () => {
        const html = '<button onclick="go(&quot;a&quot;)">x</button><div onmouseover=\'hi()\'></div>';
        const expected = code => `'sha256-${crypto.createHash('sha256').update(code).digest('base64')}'`;
        assert.deepStrictEqual(security.inlineHandlerHashes(html).sort(), [expected('go("a")'), expected('hi()')].sort());
    });
    test('policy never allows unsafe-inline or eval for scripts', () => {
        const csp = security.buildCsp(require('path').join(__dirname, '..', 'frontend', 'index.html'));
        const scriptSrc = csp.split(';').find(d => d.trim().startsWith('script-src'));
        assert.ok(!/'unsafe-inline'|'unsafe-eval'/.test(scriptSrc));
        assert.ok(/object-src 'none'/.test(csp));
    });
});

describe('request guards', () => {
    let server;
    let port;
    const token = crypto.randomBytes(32).toString('hex');

    before(async () => {
        security.setApiToken(token);
        const app = express();
        let guard;
        app.use((req, res, next) => guard(req, res, next));
        app.use(security.tokenAuth());
        app.get('/', (req, res) => res.send('page'));
        app.post('/api/x', (req, res) => res.json({ ok: true }));
        server = app.listen(0, '127.0.0.1');
        await new Promise(r => server.once('listening', r));
        port = server.address().port;
        guard = security.hostAndOriginGuard(port);
    });
    after(() => server.close());

    function request(method, path, headers = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers } }, res => {
                let body = '';
                res.on('data', d => { body += d; });
                res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
            });
            req.on('error', reject);
            req.end();
        });
    }
    const cookie = { cookie: `${security.TOKEN_COOKIE}=${token}` };

    test('no token: 401', async () => assert.strictEqual((await request('POST', '/api/x')).status, 401));
    test('wrong token: 401', async () => assert.strictEqual((await request('POST', '/api/x', { cookie: `${security.TOKEN_COOKIE}=${'0'.repeat(64)}` })).status, 401));
    test('token cookie: allowed', async () => assert.strictEqual((await request('POST', '/api/x', cookie)).status, 200));
    test('same-origin request: allowed', async () => {
        assert.strictEqual((await request('POST', '/api/x', { ...cookie, origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin' })).status, 200);
    });
    test('other Host header (DNS rebinding): 403', async () => {
        assert.strictEqual((await request('GET', '/', { ...cookie, host: `evil.example:${port}` })).status, 403);
    });
    test('other website origin: 403', async () => {
        assert.strictEqual((await request('POST', '/api/x', { ...cookie, origin: 'https://evil.example' })).status, 403);
    });
    test('null origin (sandboxed frame): 403', async () => {
        assert.strictEqual((await request('POST', '/api/x', { ...cookie, origin: 'null' })).status, 403);
    });
    test('cross-site fetch metadata: 403', async () => {
        assert.strictEqual((await request('POST', '/api/x', { ...cookie, 'sec-fetch-site': 'cross-site' })).status, 403);
    });
    test('standalone login link sets the cookie and redirects', async () => {
        const res = await request('GET', `/?t=${token}`);
        assert.strictEqual(res.status, 302);
        assert.match(res.headers['set-cookie'][0], new RegExp(`^${security.TOKEN_COOKIE}=${token};.*HttpOnly; SameSite=Strict`));
    });
});
