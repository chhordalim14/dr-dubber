const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getGeminiWebRouter } = require('../backend/lib/gemini-web-router');

describe('Gemini Web Router toggle & API key routing', () => {
    const gw = getGeminiWebRouter();

    beforeEach(() => {
        gw._settings = null;
    });

    test('setSettings({ useForDubbing: false }) explicitly resets routerFirst and gmailOnly to false', () => {
        gw.setSettings({ useForDubbing: true, routerFirst: true, gmailOnly: true });
        assert.equal(gw.settings().useForDubbing, true);
        assert.equal(gw.settings().routerFirst, true);
        assert.equal(gw.settings().gmailOnly, true);

        gw.setSettings({ useForDubbing: false });
        assert.equal(gw.settings().useForDubbing, false);
        assert.equal(gw.settings().routerFirst, false);
        assert.equal(gw.settings().gmailOnly, false);
    });

    test('keysForDubber returns empty array when useForDubbing is false', () => {
        gw.setSettings({ useForDubbing: false });
        const keys = gw.keysForDubber();
        assert.deepEqual(keys, []);
    });

    test('gemini.js orderPool strips all gweb: keys when useForDubbing is false', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'gemini.js'), 'utf8');
        const start = source.indexOf('function getPoolKeys()');
        const end = source.indexOf('function webLaneCount(keys)');
        const block = source.slice(start, end).replace(
            "function geminiWeb() { return require('../lib/gemini-web-router').getGeminiWebRouter(); }",
            'function geminiWeb() { return gw; }'
        );

        const scope = new Function('gw', `${block}; return { getPoolKeys, geminiWebFirst, orderPool };`)(gw);

        gw.setSettings({ useForDubbing: false, routerFirst: true, gmailOnly: true });
        assert.equal(scope.geminiWebFirst(), false);
        assert.deepEqual(scope.getPoolKeys(), []);
        assert.deepEqual(scope.orderPool(['AIzaSyAPIKey1', 'gweb:acc1', 'AIzaSyAPIKey2']), ['AIzaSyAPIKey1', 'AIzaSyAPIKey2']);

        // When useForDubbing is true
        gw.setSettings({ useForDubbing: true, routerFirst: true, gmailOnly: false });
        assert.equal(scope.geminiWebFirst(), true);
        assert.deepEqual(scope.orderPool(['AIzaSyAPIKey1', 'gweb:acc1']), ['gweb:acc1', 'AIzaSyAPIKey1']);

        // When useForDubbing is true with gmailOnly
        gw.setSettings({ useForDubbing: true, routerFirst: true, gmailOnly: true });
        assert.deepEqual(scope.orderPool(['AIzaSyAPIKey1', 'gweb:acc1']), ['gweb:acc1']);

        // When useForDubbing is toggled back to false, strictly strips gweb:
        gw.setSettings({ useForDubbing: false });
        assert.equal(scope.geminiWebFirst(), false);
        assert.deepEqual(scope.orderPool(['AIzaSyAPIKey1', 'gweb:acc1']), ['AIzaSyAPIKey1']);
    });
});
