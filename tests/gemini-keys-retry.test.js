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
    const isCodeCraftKey = (k) => /^cc_/i.test(k);
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

  test('a CodeCraft key that is out of credit (PROVIDER_KEY) is skipped: the Gemini keys after it answer', async () => {
    const { geminiWithKeys, waits } = load();
    const noCredit = { ok: false, result: { success: false, status: 402, code: 'PROVIDER_KEY', outOfCredit: true, error: 'CodeCraft is out of credit.' } };
    const asked = [];
    const call = async (key) => { asked.push(key); return key === 'cc_x' ? noCredit : { ok: true, key }; };
    const out = await geminiWithKeys(['cc_x', 'g1'], call, null);
    assert.equal(out.ok, true);
    assert.equal(out.key, 'g1');
    assert.deepEqual(waits, []);
    // ...and left out of the next jobs for a while, instead of being asked first every time.
    await geminiWithKeys(['cc_x', 'g1'], call, null);
    assert.deepEqual(asked, ['cc_x', 'g1', 'g1']);
  });

  test('several CodeCraft keys: a refused or rate-limited one hands over to the next CodeCraft key, Gemini only last', async () => {
    const { geminiWithKeys } = load();
    const refused = { ok: false, result: { success: false, status: 401, code: 'PROVIDER_KEY', error: 'rejected' } };
    const asked = [];
    const out = await geminiWithKeys(['cc_a', 'cc_b', 'cc_c', 'g1'], async (key) => {
      asked.push(key);
      if (key === 'cc_a') return refused;
      if (key === 'cc_b') return perMinute;
      return { ok: true, key };
    }, null);
    assert.equal(out.ok, true);
    assert.equal(out.key, 'cc_c');
    assert.deepEqual(asked, ['cc_a', 'cc_b', 'cc_c']);
  });

  test('every CodeCraft key out: the Gemini keys finish the job', async () => {
    const { geminiWithKeys } = load();
    const noCredit = { ok: false, result: { success: false, status: 402, code: 'PROVIDER_KEY', outOfCredit: true, error: 'no credit' } };
    const asked = [];
    const out = await geminiWithKeys(['cc_a', 'cc_b', 'g1', 'g2'], async (key) => { asked.push(key); return key.startsWith('cc_') ? noCredit : { ok: true, key }; }, null);
    assert.equal(out.ok, true);
    assert.equal(out.key, 'g1');
    assert.deepEqual(asked, ['cc_a', 'cc_b', 'g1']);
  });
});

describe('Shortening engine (Shorten rushed lines, Ultra-Short, a row\'s Shorten)', () => {
  const engine = serverSource.slice(serverSource.indexOf('async function shortenLines('), serverSource.indexOf("app.post('/api/condense-fast-subtitles'"));
  const route = (name) => {
    const from = serverSource.indexOf(`app.post('/api/${name}'`);
    return serverSource.slice(from, serverSource.indexOf('\napp.', from + 10));
  };

  test('goes through geminiWithKeys with the short text timeout and the full backoff', () => {
    assert.ok(engine.length > 0, 'shortenLines moved - update this test');
    assert.match(engine, /geminiWithKeys\(keyPool,/);
    assert.match(engine, /timeoutMs: GEMINI_TEXT_TIMEOUT_MS/);
    assert.match(engine, /retries: GEMINI_RETRY_DELAYS_MS\.length/);
  });

  test('no longer asks every key in turn', () => {
    assert.doesNotMatch(engine, /for \(const k of keyPool\)/);
  });

  test('all three shortening tools use it: fit for rushed lines, shorter for Ultra-Short and a row', () => {
    assert.match(route('condense-fast-subtitles'), /shortenLines\(\{[\s\S]*strength: 'fit'/);
    assert.match(route('refactor-subtitles-batch'), /mode === 'shorten'[\s\S]*shortenLines\(\{[\s\S]*strength: 'shorter'/);
    assert.match(route('rewrite-dialogue'), /mode === 'shorten'[\s\S]*shortenLines\(\{[\s\S]*strength: 'shorter'/);
  });
});

describe('short text requests time out sooner than audio', () => {
  test('re-translate, names, shorten and the character sheet use GEMINI_TEXT_TIMEOUT_MS; it is shorter than an audio attempt', () => {
    const text = Number(serverSource.match(/const GEMINI_TEXT_TIMEOUT_MS = (\d+);/)[1]);
    const audio = Number(serverSource.match(/const GEMINI_ATTEMPT_TIMEOUT_MS = (\d+);/)[1]);
    assert.ok(text < audio);
    assert.equal((serverSource.match(/timeoutMs: GEMINI_TEXT_TIMEOUT_MS/g) || []).length, 4);
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
