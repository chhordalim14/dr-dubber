// Shared review requests (backend/routes/gemini.js sharedReview / reviewKhmerLines): tabs being
// transcribed at the same time put their Khmer review in one request instead of one each - the
// real code, run against a fake Gemini that records every request.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'gemini.js'), 'utf8');
const from = src.indexOf('const REVIEW_BATCH = ');
const to = src.indexOf('async function fitOverlongLines(');
const block = src.slice(from, to);

// waitScale: REVIEW_GATHER_MS is shortened by this factor (the 20 s wait in a test).
function load({ waitScale = 1 / 200, fail = false } = {}) {
  const requests = [];
  const api = new Function('requests', 'waitScale', 'fail', `
    const KHMER_CHAR_RE = /[\\u1780-\\u17FF]/;
    const TRANSCRIBE_MAX_LANES = 8;
    const GEMINI_RETRY_DELAYS_MS = [1];
    const REPAIR_BUSY_BUDGET_MS = 1;
    const console = { log: () => { }, warn: () => { } };
    const realSetTimeout = setTimeout;
    const setTimeoutFast = (fn, ms) => realSetTimeout(fn, ms * waitScale);
    const buildReviewSystemPrompt = () => 'system';
    const getKhmerDramaRegisterGuidance = () => '';
    const buildReviewUserPrompt = ({ lines }) => JSON.stringify(lines);
    const textLaneCount = (keys) => keys.length;
    const textLaneKeys = (keys) => keys;
    const khmerMaxSyllables = () => 12;
    const addTokenUsage = (usage) => { if (usage) usage.requests = (usage.requests || 0) + 1; };
    const parseJsonArrayLoose = (t) => JSON.parse(t);
    const sanitizeKhmerDialogue = (t) => t;
    const applyGlossary = (t) => t;
    const hasForeignText = () => false;
    const estimateSpeechSeconds = (t) => t.length / 20;
    const generateText = async (key, model, payload) => {
      const lines = JSON.parse(payload.contents[0].parts[0].text);
      requests.push(lines);
      await new Promise((r) => realSetTimeout(r, 5));
      if (fail) return { success: false, error: 'boom' };
      return { success: true, text: JSON.stringify(lines.map((l) => ({ i: l.i, text: l.khmer + 'ថ្មី' }))) };
    };
    const geminiWithKeys = async (keys, call) => {
      const out = await call(keys[0]);
      return out;
    };
    ${block.replace(/setTimeout\(\(\) => flushReviewGroup/g, 'setTimeoutFast(() => flushReviewGroup')}
    return { reviewKhmerLines, setRunning: (n) => { transcribesRunning = n; }, done: () => { transcribesRunning--; flushReviewGroupsIfComplete(); } };
  `)(requests, waitScale, fail);
  return { ...api, requests };
}

// A tab's review: n lines of "<tab>-<line>" Khmer text; returns what apply() received.
function tab(api, name, n, opts = {}) {
  const lines = Array.from({ length: n }, (_, i) => ({ source: `${name} source ${i}`, gender: 'Male', seconds: 2 }));
  const texts = Array.from({ length: n }, (_, i) => `ខ${name}${i}`);
  const original = [...texts]; // reviewKhmerLines writes its corrections back into texts
  const applied = {};
  const usage = {};
  const run = api.reviewKhmerLines({
    lines, texts, apply: (i, t) => { applied[i] = t; }, genre: 'modern', glossaryHint: '', sheetHint: 'sheet',
    keyPool: ['k1'], model: 'gemini-3.8-flash', signal: null, usage, tag: 'Transcribe', share: true, ...opts,
  });
  return { run, applied, usage, texts: original };
}

describe('shared review requests', () => {
  test('the block is found in gemini.js', () => {
    assert.ok(from > 0 && to > from, 'markers moved - update this test');
  });

  test('three tabs transcribed at once: one review request; each tab gets exactly its own lines back', async () => {
    const api = load();
    api.setRunning(3);
    const a = tab(api, 'A', 20), b = tab(api, 'B', 21), c = tab(api, 'C', 19);
    const changed = await Promise.all([a.run, b.run, c.run]);
    assert.equal(api.requests.length, 1, 'one request, not three');
    assert.equal(api.requests[0].length, 60);
    assert.deepEqual(changed, [20, 21, 19]);
    for (const t of [a, b, c]) {
      assert.equal(Object.keys(t.applied).length, t.texts.length);
      Object.entries(t.applied).forEach(([i, text]) => assert.equal(text, `${t.texts[i]}ថ្មី`, 'its own line, not another tab\'s'));
    }
  });

  test('one tab alone does not wait (nobody else is being transcribed)', async () => {
    const api = load({ waitScale: 1 }); // a real 20 s wait would time the test out
    api.setRunning(1);
    const started = Date.now();
    assert.equal(await tab(api, 'A', 20).run, 20);
    assert.ok(Date.now() - started < 1000);
    assert.equal(api.requests.length, 1);
  });

  test('a request never takes more than REVIEW_BATCH lines: the next tab starts a new one', async () => {
    const api = load();
    api.setRunning(3);
    const runs = [tab(api, 'A', 60), tab(api, 'B', 60), tab(api, 'C', 30)].map((t) => t.run);
    await Promise.all(runs);
    assert.deepEqual(api.requests.map((r) => r.length), [60, 90]);
  });

  test('a tab still transcribing is waited for only up to REVIEW_GATHER_MS', async () => {
    const api = load(); // 20 s / 200 = 100 ms
    api.setRunning(3); // the third never reaches its review
    const runs = [tab(api, 'A', 20).run, tab(api, 'B', 20).run];
    assert.deepEqual(await Promise.all(runs), [20, 20]);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].length, 40);
  });

  test('Gemini does not answer: every tab keeps its lines and says so', async () => {
    const api = load({ fail: true });
    api.setRunning(2);
    const a = tab(api, 'A', 10), b = tab(api, 'B', 10);
    assert.deepEqual(await Promise.all([a.run, b.run]), [0, 0]);
    assert.deepEqual(a.applied, {});
  });

  test('a long tab (more lines than one request) keeps its own requests', async () => {
    const api = load();
    api.setRunning(2);
    const long = tab(api, 'L', 150);
    assert.equal(await long.run, 150);
    assert.deepEqual(api.requests.map((r) => r.length), [100, 50]);
  });
});
