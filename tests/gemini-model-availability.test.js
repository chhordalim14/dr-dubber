// Gemini model choice from backend/server.js (resolveGeminiModel ... executeGeminiGenerate),
// lifted out of its source and run against a fake Google. Covers Google's model changes of
// Sep / Oct 2026: 3.7 and 3.5 Flash retired (routed to 3.8 / 3.6 Flash), and the 2.5 models
// answering 404 "no longer available to new users" to keys that never used them.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
const start = serverSource.indexOf('// --- GEMINI MODEL RESOLUTION & FALLBACK ENGINE ---');
const end = serverSource.indexOf('// ── Text AI provider');
const block = serverSource.slice(start, end);
const { createKeyRest } = require('../backend/lib/key-rest');

// listed: the models Google lists for the key. answer(model): the HTTP status it answers with.
function load({ listed, answer = () => 200 }) {
  const asked = [];
  const secureFetch = async (url) => {
    if (/\/models\?/.test(url)) {
      return { ok: true, json: async () => ({ models: listed.map((m) => ({ name: `models/${m}`, supportedGenerationMethods: ['generateContent'] })) }) };
    }
    const model = url.match(/models\/([^:]+):generateContent/)[1];
    asked.push(model);
    const status = answer(model);
    const text = status === 200
      ? JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] })
      : JSON.stringify({ error: { message: status === 404 ? `This model models/${model} is no longer available to new users.` : 'error' } });
    return { ok: status === 200, status, text: async () => text };
  };
  const api = new Function('secureFetch', 'console', 'createKeyRest', `
    const RATE_LIMIT_COOLDOWN_MS = 60000;
    const keyRest = createKeyRest();
    ${block}
    return { resolveGeminiModel, rankGeminiFallbacks, executeGeminiGenerate };
  `)(secureFetch, { warn: () => { }, log: () => { } }, createKeyRest);
  return { ...api, asked };
}

const payload = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

describe('Gemini models after Google\'s Sep / Oct 2026 changes', () => {
  test('the block is found in server.js', () => {
    assert.ok(start > 0 && end > start, 'markers moved - update this test');
  });

  test('a setting saved with retired, lite, or closed models asks the reliable model Google answers them with', () => {
    const { resolveGeminiModel } = load({ listed: [] });
    assert.equal(resolveGeminiModel('gemini-3.7-flash'), 'gemini-3.8-flash');
    assert.equal(resolveGeminiModel('gemini-3.5-flash'), 'gemini-3.6-flash');
    assert.equal(resolveGeminiModel('gemini-3.5-flash-lite'), 'gemini-3.8-flash');
    assert.equal(resolveGeminiModel('gemini-3.1-flash-lite'), 'gemini-3.8-flash');
    assert.equal(resolveGeminiModel('gemini-2.5-flash'), 'gemini-3.8-flash');
    assert.equal(resolveGeminiModel('gemini-2.5-pro'), 'gemini-3.1-pro-preview');
    assert.equal(resolveGeminiModel('gemini-3.6-flash'), 'gemini-3.6-flash');
  });

  test('fallbacks leave out retired, 2.5, and flash-lite names', () => {
    const { rankGeminiFallbacks } = load({ listed: [] });
    const ranked = rankGeminiFallbacks(['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash']);
    assert.deepEqual(ranked, ['gemini-3.8-flash', 'gemini-3.6-flash']);
  });

  test('retired or lite models map to 3.8 Flash and succeed', async () => {
    const { executeGeminiGenerate, asked } = load({
      listed: ['gemini-3.8-flash', 'gemini-3.6-flash'],
      answer: (m) => 200,
    });
    const first = await executeGeminiGenerate('KEY1', 'gemini-3.5-flash-lite', payload, null, { stayOnModel: true });
    assert.equal(first.success, true);
    assert.equal(first.modelUsed, 'gemini-3.8-flash');
    assert.deepEqual(asked, ['gemini-3.8-flash']);
  });
});
