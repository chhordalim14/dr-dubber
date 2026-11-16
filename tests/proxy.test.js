const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseProxyString, maskProxyUrl, isLocalOrigin } = require('../backend/lib/proxy');

test('parseProxyString parses host:port', () => {
    const p = parseProxyString('1.2.3.4:8080');
    assert.deepEqual(p, {
        protocol: 'http',
        host: '1.2.3.4',
        port: 8080,
        username: '',
        password: '',
        url: 'http://1.2.3.4:8080'
    });
});

test('parseProxyString parses host:port:user:pass', () => {
    const p = parseProxyString('1.2.3.4:8080:alice:secret');
    assert.deepEqual(p, {
        protocol: 'http',
        host: '1.2.3.4',
        port: 8080,
        username: 'alice',
        password: 'secret',
        url: 'http://alice:secret@1.2.3.4:8080'
    });
});

test('parseProxyString parses socks5://user:pass@host:port', () => {
    const p = parseProxyString('socks5://bob:pw123@proxy.example.com:1080');
    assert.deepEqual(p, {
        protocol: 'socks5',
        host: 'proxy.example.com',
        port: 1080,
        username: 'bob',
        password: 'pw123',
        url: 'socks5://bob:pw123@proxy.example.com:1080'
    });
});

test('parseProxyString handles invalid or comment inputs', () => {
    assert.equal(parseProxyString(''), null);
    assert.equal(parseProxyString(null), null);
    assert.equal(parseProxyString('# comment line'), null);
    assert.equal(parseProxyString('not:valid:proxy:spec:extra'), null);
});

test('maskProxyUrl hides user credentials', () => {
    assert.equal(maskProxyUrl('http://alice:secret@1.2.3.4:8080'), 'http://alice:••••@1.2.3.4:8080');
    assert.equal(maskProxyUrl('http://1.2.3.4:8080'), 'http://1.2.3.4:8080');
    assert.equal(maskProxyUrl(''), '');
});

test('isLocalOrigin identifies local URLs', () => {
    assert.equal(isLocalOrigin('http://localhost:3001'), true);
    assert.equal(isLocalOrigin('http://127.0.0.1:8765'), true);
    assert.equal(isLocalOrigin('https://example.com'), false);
});
