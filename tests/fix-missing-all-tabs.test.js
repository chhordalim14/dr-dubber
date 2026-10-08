// The real "Fix Missing: All Tabs" block of frontend/js/studio-main.js (fixMissingAllTabs and
// its Stop), run against fake tabs and a fake fixMissingForProject. Covers Dub Whole Series'
// every-tab-at-once mode (keyPerTab) next to the one-tab-at-a-time menu command.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8');
const start = src.indexOf('    const FIX_MISSING_MAX_PARALLEL = 6;');
const end = src.indexOf('    // ── Make names consistent across all tabs');
const block = src.slice(start, end);

// tabs: number of tabs with subtitles. answer(tabIndex): what fixMissingForProject returns for it.
function makeEnv({ keys, tabs, answer = () => ({ ok: true, changed: 0, report: {} }), delayMs = 20 }) {
  const env = { calls: [], running: 0, maxParallel: 0, cancelled: [], toasts: [], labels: [] };
  const projects = Array.from({ length: tabs }, (_, i) => ({ name: `tab${i + 1}.mp4`, subtitles: [{ id: 1, text: 'x' }] }));
  const factory = new Function('env', 'projects', 'keys', 'answer', 'delayMs', `
    let allTabsJob = null, allTabsJobLabel = '';
    let fixMissingAllRun = null;
    const btnFixMissing = { dataset: {} };
    const saveCurrentProjectState = () => { };
    const liveSubtitlesOf = (p) => p.subtitles;
    const getGeminiKeys = () => keys;
    const showToast = (m, type) => env.toasts.push({ m, type });
    const updateTranscribeAllButtonState = () => env.labels.push(allTabsJobLabel);
    const projectTabName = (p) => p.name;
    const describeRepair = () => 'fixed';
    const repairProblem = (r) => (r && r.quotaError) || '';
    let uuid = 0;
    const crypto = { randomUUID: () => 'req' + (++uuid) };
    const fetch = async (url, opts) => {
      env.cancelled.push(JSON.parse(opts.body).requestId);
      return { json: async () => ({ success: true }) };
    };
    const fixMissingForProject = async (proj, opts) => {
      const tab = projects.indexOf(proj);
      env.calls.push({ tab, ...opts });
      env.running++;
      env.maxParallel = Math.max(env.maxParallel, env.running);
      await new Promise((r) => setTimeout(r, delayMs));
      env.running--;
      if (env.cancelled.includes(opts.requestId)) return { ok: false, cancelled: true };
      return answer(tab);
    };
    ${block}
    return { fixMissingAllTabs, stopFixMissingAll, isRunning: () => !!fixMissingAllRun };
  `);
  return { env, projects, api: factory(env, projects, keys, answer, delayMs) };
}

describe('Fix Missing: All Tabs', () => {
  test('the block is found in the source', () => {
    assert.ok(start > 0 && end > start, 'markers moved - update this test');
  });

  test('menu command (no keyPerTab): one tab at a time, every key for each tab, server lanes', async () => {
    const keys = ['k1', 'k2', 'k3'];
    const { env, api } = makeEnv({ keys, tabs: 3 });
    const r = await api.fixMissingAllTabs();
    assert.equal(r.checked, 3);
    assert.equal(env.maxParallel, 1);
    env.calls.forEach((c) => {
      assert.deepEqual(c.apiKeys, keys);
      assert.equal(c.maxLanes, null);
    });
  });

  test('Dub Whole Series, 9 keys and 5 tabs: all tabs at once, the keys shared out without overlap', async () => {
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9'];
    const { env, api } = makeEnv({ keys, tabs: 5 });
    const r = await api.fixMissingAllTabs({ keyPerTab: true });
    assert.equal(r.checked, 5);
    assert.equal(env.maxParallel, 5);
    const own = env.calls.map((c) => c.apiKeys.slice(0, c.maxLanes));
    assert.deepEqual(own.map((o) => o.length).sort(), [1, 2, 2, 2, 2]);
    assert.deepEqual(own.flat().sort(), keys, 'every key is one tab\'s own key, none is shared');
    env.calls.forEach((c) => assert.deepEqual([...c.apiKeys].sort(), keys, 'the other keys stay backups'));
  });

  test('more tabs than keys: a tab waits for a free key, every tab is checked', async () => {
    const { env, api } = makeEnv({ keys: ['k1', 'k2'], tabs: 5 });
    const r = await api.fixMissingAllTabs({ keyPerTab: true });
    assert.equal(r.checked, 5);
    assert.equal(env.maxParallel, 2);
    assert.deepEqual(env.calls.map((c) => c.tab).sort(), [0, 1, 2, 3, 4]);
    env.calls.forEach((c) => assert.equal(c.maxLanes, 1));
  });

  test('fixed lines are counted over all tabs, reported in tab order', async () => {
    const { api } = makeEnv({ keys: ['k1', 'k2', 'k3'], tabs: 3, answer: (tab) => ({ ok: true, changed: tab === 1 ? 0 : tab + 1, report: {} }) });
    const r = await api.fixMissingAllTabs({ keyPerTab: true });
    assert.equal(r.fixedLines, 1 + 3);
    assert.equal(r.quotaOut, false);
  });

  test('every key out of its daily quota: no further tab starts, quotaOut', async () => {
    const quota = { ok: false, error: 'daily quota used up on every key', isDailyQuota: true };
    const { env, api } = makeEnv({ keys: ['k1', 'k2'], tabs: 6, answer: () => quota });
    const r = await api.fixMissingAllTabs({ keyPerTab: true });
    assert.equal(r.quotaOut, true);
    assert.equal(env.calls.length, 2, 'only the two tabs already started');
    assert.ok(env.toasts.some((t) => t.type === 'error' && /daily quota/.test(t.m)));
  });

  test('Stop cancels every tab being checked and starts no other', async () => {
    const { env, api } = makeEnv({ keys: ['k1', 'k2', 'k3'], tabs: 6, delayMs: 40 });
    const run = api.fixMissingAllTabs({ keyPerTab: true });
    await new Promise((r) => setTimeout(r, 10));
    api.stopFixMissingAll();
    const r = await run;
    assert.equal(r.stopped, true);
    assert.equal(env.calls.length, 3);
    assert.deepEqual(env.cancelled.sort(), env.calls.map((c) => c.requestId).sort());
    assert.equal(api.isRunning(), false);
  });
});
