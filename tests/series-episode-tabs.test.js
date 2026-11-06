// Dub Whole Series, "Each episode its own tab": the real planning code of frontend/js/studio-main.js
// (planEpisodeParts, startSeries, splitStep) run against fakes. Episodes are not joined or cut:
// a part is a batch of whole episodes opened as tabs, each exported as its own video.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8').replace(/\r\n/g, '\n');
const cut = (from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  return a > 0 && b > a ? src.slice(a, b) : null;
};
const planBlock = cut('    function planEpisodeParts(', '    // ── Split Movie');
const startBlock = cut('      async function startSeries() {', '      // auto: started by the hands-free');
const splitBlock = cut('      async function splitStep() {', '      async function loadStep() {');
const MAX_PROJECT_TABS = Number(src.match(/const MAX_PROJECT_TABS = (\d+)/)[1]);
const planEpisodeParts = new Function(`${planBlock}; return planEpisodeParts;`)();

const episodes = (n, sec) => Array.from({ length: n }, (_, i) => ({ path: `D:\\Show\\E${String(i + 1).padStart(2, '0')}.mp4`, name: `E${i + 1}.mp4`, episode: i + 1, duration: sec }));

describe('Each episode its own tab', () => {
  test('the blocks are found in the source', () => {
    assert.ok(planBlock && startBlock && splitBlock, 'markers moved - update this test');
  });

  test('batches hold whole episodes in order, about "Minutes per part", never more than the tab limit', () => {
    // 60 episodes of 1:42 (the demo's length) = 102 min; 50-minute parts would hold 29, the tab limit is 20.
    const parts = planEpisodeParts(episodes(60, 102), 50, MAX_PROJECT_TABS);
    assert.ok(parts.every((p) => p.length <= MAX_PROJECT_TABS));
    assert.deepEqual(parts.flat().map((f) => f.episode), Array.from({ length: 60 }, (_, i) => i + 1));
    // Longer episodes: the minutes decide (50 min of 5-minute episodes = 10 a part).
    assert.ok(planEpisodeParts(episodes(30, 300), 50, MAX_PROJECT_TABS).every((p) => p.length === 10));
    // Joined mode keeps its own limit (80 episodes a part).
    assert.equal(planEpisodeParts(episodes(60, 102), 180).length, 1);
  });

  function startWith({ episodeTabs, unpicked = null }) {
    const env = { runPart: [], joined: 0, closed: 0 };
    const scan = { folder: 'D:\\Show', seriesName: 'Show', files: episodes(30, 150), unpicked };
    const run = new Function('env', 'scan', 'episodeTabsOn', 'planEpisodeParts', 'MAX_PROJECT_TABS', `
      let plan = null, seriesRun = null;
      const preflight = () => true, cancelAutoResume = () => { }, savePrefs = () => { }, savePlan = () => { };
      const $ = (id) => ({ value: '' });
      const joinMinutes = () => 50;
      const readyParts = () => null;
      const episodeTabsWanted = () => episodeTabsOn;
      const pickedFiles = () => scan.files.filter((f) => !f.error && !scan.unpicked?.has(f.path));
      const episodeBatches = () => planEpisodeParts(pickedFiles(), joinMinutes(), MAX_PROJECT_TABS);
      const pathJoin = (a, b) => a + '\\\\' + b;
      const epLabel = (f) => 'EP' + f.episode;
      const closeOpenTabs = async () => { env.closed++; return true; };
      const partsToJoin = () => plan.parts.map((p, k) => k).filter((k) => plan.parts[k].status === 'planned');
      const joinNextAvailable = async () => { if (partsToJoin().length) env.joined++; };
      const startBackgroundJoin = async (ks) => { env.background = ks; };
      const nextPartIndex = () => plan.parts.findIndex((p) => p.status === 'joined');
      const runPart = async (i) => { env.runPart.push(i); };
      const exportAndContinue = async () => { };
      const withRun = async (fn) => fn();
      ${startBlock}
      return startSeries().then(() => plan);
    `);
    return run(env, scan, episodeTabs, planEpisodeParts, MAX_PROJECT_TABS).then((plan) => ({ plan, env }));
  }

  test('a series of episodes as tabs: nothing to join, the parts are dubbed from the episode files', async () => {
    const { plan, env } = await startWith({ episodeTabs: true });
    assert.equal(plan.episodeTabs, true);
    assert.equal(plan.outDir, 'D:\\Show', 'no "DR Dubber Joined" folder');
    assert.ok(plan.parts.every((p) => p.episodeTabs && p.prejoined && p.status === 'joined'));
    assert.deepEqual(plan.parts.flatMap((p) => p.files), episodes(30, 150).map((f) => f.path));
    assert.equal(env.joined, 0);
    assert.deepEqual(env.background, []);
    assert.deepEqual(env.runPart, [0]);
  });

  test('switched off: episodes are joined into parts as before', async () => {
    const { plan, env } = await startWith({ episodeTabs: false });
    assert.equal(plan.episodeTabs, false);
    assert.equal(plan.outDir, 'D:\\Show\\DR Dubber Joined');
    assert.ok(plan.parts.every((p) => p.status === 'planned' && !p.episodeTabs));
    assert.equal(env.joined, 1);
  });

  test('"Episodes to dub": unticked episodes are left out, in both modes', async () => {
    const all = episodes(30, 150).map((f) => f.path);
    const unpicked = new Set(all.slice(0, 5));
    for (const episodeTabs of [true, false]) {
      const { plan } = await startWith({ episodeTabs, unpicked });
      assert.deepEqual(plan.parts.flatMap((p) => p.files), all.slice(5));
    }
  });

  test('a batch opens its episode files as tabs - the splitter is not asked', async () => {
    const files = episodes(3, 150).map((f) => f.path);
    const env = { posted: [] };
    const plan = { current: 0, parts: [{ episodeTabs: true, files }] };
    const splitStep = new Function('env', 'plan', `
      const postJson = async (url) => { env.posted.push(url); return { success: false }; };
      ${splitBlock}
      return splitStep;
    `)(env, plan);
    const note = await splitStep();
    assert.deepEqual(plan.pieces, files);
    assert.notEqual(plan.pieces, files, 'a copy, not the part\'s own list');
    assert.deepEqual(env.posted, []);
    assert.equal(note, '3 episodes, one tab each');
  });
});
