// Gemini key rotation and "busy" retries from backend/server.js (tryKeysOnce / geminiWithKeys),
// lifted out of its source (requiring server.js starts the whole backend) and run against a
// fake Gemini. Covers the retry rounds Dub Whole Series' "Shorten rushed lines" now uses.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
const start = serverSource.indexOf('// Worth waiting and retrying:');
const end = serverSource.indexOf('async function retranslateCues(');
const block = serverSource.slice(start, end);

function load() {
  const waits = [];
  // Backoff waits are recorded, not slept; the clock jumps ahead by each wait instead.
  let now = 1e12;
  const fastTimeout = (fn, ms) => { waits.push(ms); now += ms; return setTimeout(fn, 0); };
  const FakeDate = { now: () => now };
  const api = new Function('setTimeout', 'console', 'Date', `
    const formatWait = (ms) => Math.round(ms / 1000) + 's';
    const geminiModelCooldowns = new Map();
    ${block}
    return { geminiWithKeys, geminiShouldRetry, GEMINI_RETRY_DELAYS_MS, GEMINI_BUSY_RETRY_BUDGET_MS };
  `)(fastTimeout, { warn: () => { }, log: () => { } }, FakeDate);
  return { ...api, waits, now: () => now };
}

const busy = { ok: false, result: { success: false, status: 503, code: 'OVERLOADED', error: 'high demand' } };
const perMinute = { ok: false, result: { success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED', isDailyQuota: false, retryAfterMs: 20000 } };
const daily = { ok: false, result: { success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED', isDailyQuota: true, retryAfterMs: 10 * 3600 * 1000 } };

describe('geminiWithKeys', () => {
  test('the block is found in server.js', () => {
    assert.ok(start > 0 && end > start, 'markers moved - update this test');
  });

  test('"high demand" is waited out on the own key; other keys are not asked (their quota is kept)', async () => {
    const { geminiWithKeys, waits } = load();
    const asked = [];
    const out = await geminiWithKeys(['own', 'k2', 'k3'], async (key) => { asked.push(key); return busy; }, null);
    assert.equal(out.ok, false);
    assert.deepEqual(asked, ['own', 'own', 'own'], 'default: 3 rounds');
    assert.deepEqual(waits, [5000, 15000]);
  });

  test('retries option: the main pass\'s full backoff, and an answer after Google calms down', async () => {
    const { geminiWithKeys, GEMINI_RETRY_DELAYS_MS, waits } = load();
    let n = 0;
    const out = await geminiWithKeys(['own', 'k2'], async (key) => (++n < 5 ? busy : { ok: true, key }), null, { retries: GEMINI_RETRY_DELAYS_MS.length });
    assert.equal(out.ok, true);
    assert.equal(out.key, 'own');
    assert.equal(n, 5);
    // Busy waits stop growing at 30s.
    assert.deepEqual(waits, GEMINI_RETRY_DELAYS_MS.map((ms) => Math.min(ms, 30000)));
  });

  test('busyBudgetMs: "high demand" is retried past the retry count until Google answers', async () => {
    const { geminiWithKeys, GEMINI_BUSY_RETRY_BUDGET_MS, waits } = load();
    let n = 0;
    const out = await geminiWithKeys(['own'], async (key) => (++n < 12 ? busy : { ok: true, key }), null, { busyBudgetMs: GEMINI_BUSY_RETRY_BUDGET_MS });
    assert.equal(out.ok, true);
    assert.equal(n, 12);
    assert.ok(waits.every((ms) => ms <= 30000));
  });

  test('busyBudgetMs: gives up once the budget is spent', async () => {
    const { geminiWithKeys, GEMINI_BUSY_RETRY_BUDGET_MS, waits } = load();
    const out = await geminiWithKeys(['own'], async () => busy, null, { busyBudgetMs: GEMINI_BUSY_RETRY_BUDGET_MS });
    assert.equal(out.ok, false);
    const waited = waits.reduce((a, b) => a + b, 0);
    assert.ok(waited >= GEMINI_BUSY_RETRY_BUDGET_MS && waited < GEMINI_BUSY_RETRY_BUDGET_MS + 30000);
  });

  test('busyBudgetMs: a rate limit still has only the usual retries', async () => {
    const { geminiWithKeys, waits } = load();
    const out = await geminiWithKeys(['own'], async () => perMinute, null, { retries: 2, busyBudgetMs: 30 * 60 * 1000 });
    assert.equal(out.ok, false);
    assert.equal(waits.length, 2);
  });

  test('busy, with the key\'s other models out of quota: the next key is asked in the same round', async () => {
    const { geminiWithKeys, waits } = load();
    const busyNoFallback = { ok: false, result: { ...busy.result, otherModelsLimited: true } };
    const asked = [];
    const out = await geminiWithKeys(['own', 'k2', 'k3'], async (key) => { asked.push(key); return key === 'own' ? busyNoFallback : { ok: true, key }; }, null);
    assert.equal(out.ok, true);
    assert.equal(out.key, 'k2');
    assert.deepEqual(asked, ['own', 'k2']);
    assert.deepEqual(waits, []);
  });

  test('busy on every key with no fallback left: still a busy answer to wait out', async () => {
    const { geminiWithKeys } = load();
    const busyNoFallback = { ok: false, result: { ...busy.result, otherModelsLimited: true } };
    const out = await geminiWithKeys(['own', 'k2'], async () => busyNoFallback, null, { retries: 0 });
    assert.equal(out.ok, false);
    assert.equal(out.result.code, 'OVERLOADED');
  });

  test('a rate-limited own key hands the request to another key in the same round', async () => {
    const { geminiWithKeys } = load();
    const asked = [];
    const out = await geminiWithKeys(['own', 'k2'], async (key) => { asked.push(key); return key === 'own' ? perMinute : { ok: true, key }; }, null, { retries: 4 });
    assert.equal(out.ok, true);
    assert.deepEqual(asked, ['own', 'k2']);
  });

  test('every key out for the day: no retry rounds (they would only spend more quota)', async () => {
    const { geminiWithKeys, waits } = load();
    const out = await geminiWithKeys(['a', 'b'], async () => daily, null, { retries: 4 });
    assert.equal(out.ok, false);
    assert.equal(out.result.isDailyQuota, true);
    assert.deepEqual(waits, []);
  });
});

describe('Shorten rushed lines endpoint', () => {
  const route = serverSource.slice(serverSource.indexOf("app.post('/api/condense-fast-subtitles'"), serverSource.indexOf("app.get('/api/transcribe-progress'"));

  test('goes through geminiWithKeys with the short text timeout and the full backoff', () => {
    assert.match(route, /geminiWithKeys\(keyPool,/);
    assert.match(route, /timeoutMs: GEMINI_TEXT_TIMEOUT_MS/);
    assert.match(route, /retries: GEMINI_RETRY_DELAYS_MS\.length/);
  });

  test('no longer asks every key in turn', () => {
    assert.doesNotMatch(route, /for \(const k of keyPool\)/);
  });
});

describe('short text requests time out sooner than audio', () => {
  test('re-translate, names and shorten use GEMINI_TEXT_TIMEOUT_MS; it is shorter than an audio attempt', () => {
    const text = Number(serverSource.match(/const GEMINI_TEXT_TIMEOUT_MS = (\d+);/)[1]);
    const audio = Number(serverSource.match(/const GEMINI_ATTEMPT_TIMEOUT_MS = (\d+);/)[1]);
    assert.ok(text < audio);
    assert.equal((serverSource.match(/timeoutMs: GEMINI_TEXT_TIMEOUT_MS/g) || []).length, 3);
  });
});

describe('geminiShouldRetry', () => {
  const network = { success: false, status: 503, code: 'NETWORK_ERROR', error: 'Cannot reach Google Gemini' };

  test('busy (503 / no answer in time) is retried for the whole budget, not a few tries', () => {
    const { geminiShouldRetry, GEMINI_BUSY_RETRY_BUDGET_MS, now: clock } = load();
    const now = clock();
    assert.equal(geminiShouldRetry(busy.result, 99, now - 10 * 60 * 1000), true);
    assert.equal(geminiShouldRetry(busy.result, 0, now - GEMINI_BUSY_RETRY_BUDGET_MS - 1), false);
  });

  test('a dead connection is not "busy": it keeps its single retry', () => {
    const { geminiShouldRetry } = load();
    assert.equal(geminiShouldRetry(network, 0, Date.now()), true);
    assert.equal(geminiShouldRetry(network, 1, Date.now()), false);
  });

  test('a daily quota is never retried', () => {
    const { geminiShouldRetry } = load();
    assert.equal(geminiShouldRetry(daily.result, 0, Date.now()), false);
  });
});
