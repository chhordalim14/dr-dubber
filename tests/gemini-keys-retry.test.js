// Gemini key rotation and "busy" retries from backend/server.js (tryKeysOnce / geminiWithKeys),
// lifted out of its source (requiring server.js starts the whole backend) and run against a
// fake Gemini. Covers the retry rounds Dub Whole Series' "Shorten rushed lines" now uses.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'gemini.js'), 'utf8');
const start = serverSource.indexOf('// Worth waiting and retrying:');
const end = serverSource.indexOf('async function retranslateCues(');
const block = serverSource.slice(start, end);
const { createKeyRest } = require('../backend/lib/key-rest');

function load({ pool = null } = {}) {
  const waits = [];
  // Backoff waits are recorded, not slept; the clock jumps ahead by each wait instead.
  let now = 1e12;
  const fastTimeout = (fn, ms) => { waits.push(ms); now += ms; return setTimeout(fn, 0); };
  const FakeDate = { now: () => now };
  const api = new Function('setTimeout', 'console', 'Date', 'createKeyRest', 'pool', `
    const formatWait = (ms) => Math.round(ms / 1000) + 's';
    ${pool ? 'const notifyDRRouterRateLimited = (key, ms) => pool.parked.push(key);' : ''}
    const keyRest = createKeyRest({ now: () => Date.now() });
    const geminiModelCooldowns = new Map();
    const geminiKeyAnswered = keyRest.answered;
    const msUntilPacificMidnight = () => 6 * 3600 * 1000; // the daily reset was 18 h ago
    const isCodeCraftKey = (k) => /^cc_/i.test(k);
    ${block}
    return { geminiWithKeys, geminiShouldRetry, tryKeysOnce, geminiKeyStatus, geminiKeyAnswered, GEMINI_RETRY_DELAYS_MS, GEMINI_BUSY_RETRY_BUDGET_MS };
  `)(fastTimeout, { warn: () => { }, log: () => { } }, FakeDate, createKeyRest, pool);
  return { ...api, waits, now: () => now };
}

const busy = { ok: false, result: { success: false, status: 503, code: 'OVERLOADED', error: 'high demand' } };
const perMinute = { ok: false, result: { success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED', isDailyQuota: false, retryAfterMs: 20000 } };
const daily = { ok: false, result: { success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED', isDailyQuota: true, retryAfterMs: 10 * 3600 * 1000 } };

describe('geminiWithKeys', () => {
  test('the block is found in server.js', () => {
    assert.ok(start > 0 && end > start, 'markers moved - update this test');
  });

  test('"high demand" is waited out, not walked through every key (the model is busy for every key)', async () => {
    const { geminiWithKeys, waits } = load();
    const asked = [];
    const out = await geminiWithKeys(['own', 'k2', 'k3'], async (key) => { asked.push(key); return busy; }, null);
    assert.equal(out.ok, false);
    assert.equal(asked.length, 3, 'one key per round, a wait between rounds');
    assert.deepEqual(waits, [5000, 15000]);
  });

  test('"high demand", then Google answers: the next round gets it, without asking the other keys first', async () => {
    const { geminiWithKeys, waits } = load();
    let n = 0;
    const out = await geminiWithKeys(['own', 'k2', 'k3'], async (key) => (++n === 1 ? busy : { ok: true, key }), null, { busyBudgetMs: 30 * 60 * 1000 });
    assert.equal(out.ok, true);
    assert.equal(n, 2);
    assert.deepEqual(waits, [5000]);
  });

  test('"high demand" does not park DR Router pool accounts (it is Google busy, not the key); a 429 does', async () => {
    const pool = { parked: [] };
    const { geminiWithKeys } = load({ pool });
    await geminiWithKeys(['p1', 'p2'], async () => busy, null);
    assert.deepEqual(pool.parked, []);
    await geminiWithKeys(['p1', 'p2'], async (key) => (key === 'p1' ? perMinute : { ok: true, key }), null);
    assert.deepEqual(pool.parked, ['p1']);
  });

  test('retries option: the main pass\'s full backoff, and an answer after Google calms down', async () => {
    const { geminiWithKeys, GEMINI_RETRY_DELAYS_MS, waits } = load();
    let n = 0;
    const out = await geminiWithKeys(['own'], async (key) => (++n < 5 ? busy : { ok: true, key }), null, { retries: GEMINI_RETRY_DELAYS_MS.length });
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

  test('Gemini Web Router: a signed-out or busy Gmail tries the next Gmail in the same round, and waits out profile refresh when all are signed out', async () => {
    const { geminiWithKeys, waits } = load();
    const gwebSignedOut = { ok: false, result: { success: false, status: 502, code: 'GWEB_SIGNED_OUT', error: 'signed out' } };
    const asked = [];
    let round = 0;
    const out = await geminiWithKeys(['gweb:a', 'gweb:b'], async (key) => {
      asked.push(key);
      // Both Gmails are refreshing on rounds 1-3 (~50s), then gweb:b comes back on round 4
      if (++round < 8) return gwebSignedOut;
      return { ok: true, key };
    }, null, { busyBudgetMs: 5 * 60 * 1000 });
    assert.equal(out.ok, true);
    assert.equal(out.key, 'gweb:b');
    assert.deepEqual(asked, ['gweb:a', 'gweb:b', 'gweb:a', 'gweb:b', 'gweb:a', 'gweb:b', 'gweb:a', 'gweb:b']);
    assert.deepEqual(waits, [5000, 15000, 30000]);
  });
});

describe('Shortening engine (Shorten rushed lines, Ultra-Short, a row\'s Shorten)', () => {
  const condenseIdx = serverSource.indexOf("router.post('/condense-fast-subtitles'") >= 0
    ? serverSource.indexOf("router.post('/condense-fast-subtitles'")
    : serverSource.indexOf("app.post('/api/condense-fast-subtitles'");
  const engine = serverSource.slice(serverSource.indexOf('async function shortenLines('), condenseIdx);
  const route = (name) => {
    const rFrom = serverSource.indexOf(`router.post('/${name}'`);
    if (rFrom >= 0) {
      const next = serverSource.search(new RegExp(`\\n\\s*router\\.(?:post|get)\\('`));
      const end = serverSource.indexOf('\n    router.', rFrom + 10);
      return serverSource.slice(rFrom, end >= 0 ? end : rFrom + 2000);
    }
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
  test('re-translate, names, shorten, the character sheet, missed subtitles and split lines use GEMINI_TEXT_TIMEOUT_MS; it is shorter than an audio attempt', () => {
    const text = Number(serverSource.match(/const GEMINI_TEXT_TIMEOUT_MS = (\d+);/)[1]);
    const audio = Number(serverSource.match(/const GEMINI_ATTEMPT_TIMEOUT_MS = (\d+);/)[1]);
    assert.ok(text < audio);
    assert.equal((serverSource.match(/timeoutMs: GEMINI_TEXT_TIMEOUT_MS/g) || []).length, 6);
  });

  test('a whole tab has time to be written: an audio attempt waits at least 4 minutes (65s cut most of them off)', () => {
    assert.ok(Number(serverSource.match(/const GEMINI_ATTEMPT_TIMEOUT_MS = (\d+);/)[1]) >= 240000);
  });

  test('Check limits ("Reply with OK") gives up sooner than a text job', () => {
    const check = Number(serverSource.match(/const GEMINI_CHECK_TIMEOUT_MS = (\d+);/)[1]);
    const text = Number(serverSource.match(/const GEMINI_TEXT_TIMEOUT_MS = (\d+);/)[1]);
    assert.ok(check < text);
    assert.match(serverSource, /gemini-check-limits[\s\S]*?timeoutMs: GEMINI_CHECK_TIMEOUT_MS/);
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

describe('key status for Settings', () => {
  test('"ok" is only "checked today" once Google answered the key after the daily reset', () => {
    const { geminiKeyStatus, geminiKeyAnswered, now } = load();
    assert.equal(geminiKeyStatus('never').checkedToday, false, 'no answer yet: not checked today');
    geminiKeyAnswered.set('yesterday', now() - 20 * 3600 * 1000);
    assert.equal(geminiKeyStatus('yesterday').checkedToday, false, 'answered before the reset');
    geminiKeyAnswered.set('today', now() - 3600 * 1000);
    const st = geminiKeyStatus('today');
    assert.equal(st.state, 'ok');
    assert.equal(st.checkedToday, true);
  });
});

describe('keys Google refuses', () => {
  const refused = (status, message) => ({ ok: false, result: { success: false, status, error: 'INVALID_API_KEY', message } });

  test('a dead key (401: its service account deleted) rests a day; the next key does the work', async () => {
    const { tryKeysOnce, geminiKeyStatus } = load();
    const asked = [];
    const out = await tryKeysOnce(['dead', 'good'], async (k) => {
      asked.push(k);
      return k === 'dead' ? refused(401, 'The bound service account is deleted or disabled.') : { ok: true };
    });
    assert.equal(out.ok, true);
    assert.deepEqual(asked, ['dead', 'good']);
    const st = geminiKeyStatus('dead');
    assert.equal(st.state, 'invalid');
    assert.equal(st.dead, true);
    assert.equal(st.retryAfterMs, 24 * 3600 * 1000);
    assert.match(st.message, /service account/);
    asked.length = 0;
    await tryKeysOnce(['dead', 'good'], async (k) => { asked.push(k); return { ok: true }; });
    assert.deepEqual(asked, ['good'], 'not asked again');
  });

  test('a 400 "API key expired" is dead too; a 403 and a CodeCraft key rest 10 minutes', async () => {
    const { tryKeysOnce, geminiKeyStatus } = load();
    const answer = async (k) => (
      k === 'old' ? refused(400, 'API key expired.')
        : k === 'k403' ? refused(403, 'Permission denied')
          : k === 'cc_x' ? refused(401, 'bad key')
            : { ok: true });
    await tryKeysOnce(['old', 'k403', 'good'], answer);
    await tryKeysOnce(['cc_x', 'good'], answer);
    assert.equal(geminiKeyStatus('old').dead, true);
    assert.equal(geminiKeyStatus('k403').dead, false);
    assert.equal(geminiKeyStatus('k403').retryAfterMs, 10 * 60 * 1000);
    assert.equal(geminiKeyStatus('cc_x').dead, false);
  });
});
