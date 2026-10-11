// The "Text AI provider" block of backend/server.js (lifted out of its source, like
// gemini-keys-retry.test.js): which keys a text job uses, and how several CodeCraft keys share it.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
const start = serverSource.indexOf('// ── Text AI provider');
const end = serverSource.indexOf('// ── Khmer Dubbing & Subtitle Dialogue Engine');
const block = serverSource.slice(start, end);

function load() {
  const geminiKeyInFlight = new Map();
  const invalidGeminiKeys = new Map();
  const rateLimitedGeminiKeys = new Map();
  const api = new Function('geminiKeyInFlight', 'invalidGeminiKeys', 'rateLimitedGeminiKeys', `
    const createCodeCraftClient = () => ({});
    const secureFetch = null, extractJsonValue = null;
    const GEMINI_ATTEMPT_TIMEOUT_MS = 1000;
    const isGeminiKeyInvalid = (k) => invalidGeminiKeys.has(k);
    ${block}
    return { textAi, codecraftActive, textKeys, textLaneKeys, textLaneCount, textAiNotice, codecraftKeyStatus };
  `)(geminiKeyInFlight, invalidGeminiKeys, rateLimitedGeminiKeys);
  return { ...api, geminiKeyInFlight, invalidGeminiKeys, rateLimitedGeminiKeys };
}

const on = (t, keys) => Object.assign(t.textAi, { provider: 'codecraft', keys, model: 'gemini-3.7-flash' });

describe('text AI keys', () => {
  test('the block is found in server.js', () => {
    assert.ok(start > 0 && end > start, 'markers moved - update this test');
  });

  test('Gemini chosen: the Gemini keys, unchanged', () => {
    const t = load();
    t.textAi.keys = ['cc_a'];
    assert.equal(t.codecraftActive(), false);
    assert.deepEqual(t.textKeys(['g1', 'g2', 'g1', '']), ['g1', 'g2']);
  });

  test('CodeCraft chosen: its keys first, least busy first, then the Gemini keys', () => {
    const t = load();
    on(t, ['cc_a', 'cc_b', 'cc_c']);
    t.geminiKeyInFlight.set('cc_a', 3).set('cc_b', 1);
    assert.deepEqual(t.textKeys(['g1']), ['cc_c', 'cc_b', 'cc_a', 'g1']);
    assert.deepEqual(t.textKeys([]), ['cc_c', 'cc_b', 'cc_a']);
    assert.deepEqual(t.textKeys(['g1'], false), ['g1'], 'Direct transcription stays on Gemini');
  });

  test('lanes are spread over the CodeCraft keys; Gemini keys stay last in every lane', () => {
    const t = load();
    on(t, ['cc_a', 'cc_b']);
    const keys = t.textKeys(['g1', 'g2']);
    assert.equal(t.textLaneCount(keys), 8, '4 lanes per CodeCraft key');
    assert.deepEqual(t.textLaneKeys(keys, 0), ['cc_a', 'cc_b', 'g1', 'g2']);
    assert.deepEqual(t.textLaneKeys(keys, 1), ['cc_b', 'cc_a', 'g2', 'g1']);
    assert.deepEqual(t.textLaneKeys(['g1', 'g2', 'g3'], 1), ['g2', 'g3', 'g1'], 'Gemini only: the old rotation');
    assert.equal(t.textLaneCount(['g1', 'g2', 'g3']), 3);
  });

  test('key status for the Settings list', () => {
    const t = load();
    on(t, ['cc_a', 'cc_b', 'cc_c', 'cc_d']);
    t.textAi.issues.set('cc_a', { at: 1, message: 'no credit', outOfCredit: true });
    t.invalidGeminiKeys.set('cc_a', Date.now());
    t.rateLimitedGeminiKeys.set('cc_b', { until: Date.now() + 20000 });
    assert.equal(t.codecraftKeyStatus('cc_a').state, 'no-credit');
    assert.equal(t.codecraftKeyStatus('cc_b').state, 'cooling');
    assert.ok(t.codecraftKeyStatus('cc_b').retryAfterMs > 0);
    assert.equal(t.codecraftKeyStatus('cc_c').state, 'unknown');
    assert.equal(t.codecraftKeyStatus('cc_c', { success: true }).state, 'ok');
    assert.equal(t.codecraftKeyStatus('cc_d', { success: false, status: 401, error: 'bad' }).state, 'refused');
  });

  test('notice: only problems seen during this job', () => {
    const t = load();
    t.textAi.issues.set('cc_a', { at: 100, message: 'Key …a is out of credit.' });
    assert.equal(t.textAiNotice(200), undefined);
    assert.match(t.textAiNotice(50), /out of credit\. The job carried on with your other keys\./);
  });
});
