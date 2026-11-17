// AI Refactor and Rewrite (backend/routes/gemini.js): the text request goes over every Gemini key
// the window sends, not only the first one. Before, generateTextForKey got apiKey alone, so a
// rate-limited first key failed the job while the other keys sat unused.
// generateTextForKey is lifted out of its source (requiring gemini.js starts the whole backend),
// with the key pool and the Gemini call faked.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// CRLF on a Windows checkout (core.autocrlf) would hide the '\n}\n' the function ends at.
const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'gemini.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('async function generateTextForKey(');
const end = source.indexOf('\n}\n', start) + 2;
const fnSource = source.slice(start, end);

// answers: key -> result of one call with that key
function load({ answers = {}, codecraft = false } = {}) {
    const asked = [];
    const call = (key) => {
        asked.push(key);
        return answers[key] || { success: true, text: `from ${key}` };
    };
    const generateTextForKey = new Function('deps', `
        const { textKeys, codecraftActive, executeGeminiGenerate, generateText, tryKeysOnce } = deps;
        ${fnSource}
        return generateTextForKey;
    `)({
        // The real textKeys: the given keys trimmed and de-duplicated (CodeCraft/Gmails left out here).
        textKeys: (keys) => keys.map(k => String(k || '').trim()).filter((k, i, a) => k && a.indexOf(k) === i),
        codecraftActive: () => codecraft,
        executeGeminiGenerate: async (key) => call(key),
        generateText: async (key) => call(key),
        // The real tryKeysOnce moves on to the next key after a refusal or a rate limit.
        tryKeysOnce: async (keys, fn) => {
            let last = null;
            for (const k of keys) {
                const out = await fn(k);
                if (out.ok) return out;
                last = out;
            }
            return last;
        }
    });
    return { generateTextForKey, asked };
}

const rateLimited = { success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED' };

describe('generateTextForKey', () => {
    test('the function is found in gemini.js', () => {
        assert.ok(start > 0 && end > start, 'generateTextForKey moved - update this test');
    });

    test('a rate-limited first key moves on to the next key the window sent', async () => {
        const { generateTextForKey, asked } = load({ answers: { k1: rateLimited } });
        const r = await generateTextForKey(['k1', 'k2', 'k3'], 'm', {}, null);
        assert.equal(r.success, true);
        assert.equal(r.text, 'from k2');
        assert.deepEqual(asked, ['k1', 'k2']);
    });

    test('every key refused: the last refusal comes back', async () => {
        const { generateTextForKey, asked } = load({ answers: { k1: rateLimited, k2: rateLimited } });
        const r = await generateTextForKey(['k1', 'k2'], 'm', {}, null);
        assert.equal(r.status, 429);
        assert.deepEqual(asked, ['k1', 'k2']);
    });

    test('one key (as a string or in a list) is the direct call', async () => {
        for (const given of ['k1', ['k1'], [' k1 ', 'k1', '']]) {
            const { generateTextForKey, asked } = load();
            const r = await generateTextForKey(given, 'm', {}, null);
            assert.equal(r.text, 'from k1');
            assert.deepEqual(asked, ['k1']);
        }
    });

    test('the Refactor and Rewrite routes pass the whole key list', () => {
        const calls = source.match(/await generateTextForKey\([^\n]*/g) || [];
        assert.ok(calls.length >= 2, 'expected the Rewrite and Refactor calls');
        for (const c of calls) {
            assert.match(c, /^await generateTextForKey\(\[apiKey, \.\.\.\(Array\.isArray\(apiKeys\)/, `a call passes one key only: ${c}`);
        }
    });
});
