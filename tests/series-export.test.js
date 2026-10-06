// Dub Whole Series, hands-free: the real export code of frontend/js/studio-main.js - the series
// side (exportAndContinue and its helpers, and what happens to a lost export when the app
// starts) and the render queue side (renderSeriesItems) - run against a fake render queue and
// fake parts. A finished part renders while the next part is dubbed; exports stay in order.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  return a > 0 && b > a ? src.slice(a, b) : null;
};
const loadBlock = cut('      // Hands-free exports of this session:', '      // Remembered settings.');
const exportBlock = cut('      // Hands-free: export each finished part through', '      async function startBackgroundJoin(indices) {');
const renderBlock = cut('        const renderSeriesItems = async (items) => {', '        window.seriesRenderApi = {');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// parts: how many parts the series has; part 1 is dubbed and its 3 tabs are open (as at the
// app start, so not marked autoExport: that would be an export lost when the app closed).
// outcome(item): 'done' or 'error' for one render of a queue item ({ tab, tries }).
function makeSeries({ parts = 3, outcome = () => 'done', renderMs = 10, dubMs = 15, plan = null } = {}) {
  const env = { log: [], toasts: [], saves: 0, renderQueue: [] };
  const tabsOf = (k) => [1, 2, 3].map((t) => ({ name: `part${k + 1}_tab${t}` }));
  plan = plan || {
    outDir: 'D:\\out',
    parts: Array.from({ length: parts }, (_, k) => (k === 0 ? { status: 'done' } : { status: 'joined' })),
    lastDone: { index: 0 },
  };
  const projects = plan.lastDone ? tabsOf(plan.lastDone.index) : [];
  const factory = new Function('env', 'plan', 'projects', 'tabsOf', 'outcome', 'renderMs', 'dubMs', 'sleep', `
    const savePlan = () => { env.saves++; env.saved = JSON.parse(JSON.stringify(plan)); };
    const render = () => { };
    const setLabel = () => { };
    const showToast = (m, type) => env.toasts.push({ m, type });
    const modal = { classList: { remove: () => { } } };
    let seriesRun = { stopped: false };
    const stoppedError = () => Object.assign(new Error('stopped'), { seriesStopped: true });
    const checkStop = () => { if (!seriesRun || seriesRun.stopped) throw stoppedError(); };
    const handsFree = () => true;
    const nextPartIndex = () => plan.parts.findIndex((p) => p.status === 'joined');
    const joiningIndices = () => [];
    const partsToJoin = () => [];
    const ensureNextPartJoined = async () => { };
    const startBackgroundJoin = async () => { };
    const closeProjectTab = (k) => { env.log.push('close ' + projects[k].name); projects.splice(k, 1); };
    // Dubbing a part: its tabs open, it takes a while, then it is done (like the real runPart).
    const runPart = async (i) => {
      env.log.push('dub part' + (i + 1));
      projects.push(...tabsOf(i));
      plan.current = i;
      await sleep(dubMs);
      checkStop();
      plan.current = null;
      plan.parts[i].status = 'done';
      plan.parts[i].autoExport = true;
      plan.lastDone = { index: i };
      savePlan();
    };

    // The render queue: runs pending items one at a time; Stop cancels what hasn't finished.
    const renderQueue = env.renderQueue;
    let queueRunning = false, queueStops = 0, stopRequested = false;
    const renderQueueList = () => { };
    const runRenderQueue = async (only) => {
      if (queueRunning) return;
      queueRunning = true;
      stopRequested = false;
      for (const item of renderQueue) {
        if (stopRequested) break;
        if (item.status !== 'pending' || (only && !only.has(item))) continue;
        item.status = 'running';
        item.tries = (item.tries || 0) + 1;
        env.log.push('render ' + item.tab);
        await sleep(renderMs);
        item.status = stopRequested ? 'cancelled' : outcome(item);
      }
      queueRunning = false;
      stopRequested = false;
    };
    const stopRenderQueue = async () => {
      if (!queueRunning) return;
      stopRequested = true;
      queueStops++;
      renderQueue.forEach((i) => { if (i.status === 'pending') i.status = 'cancelled'; });
    };
    ${renderBlock}
    const window = { seriesRenderApi: {
      queueAllTabs: (tag) => {
        const items = projects.map((p) => ({ status: 'pending', tab: p.name, tag }));
        env.log.push('queue ' + tag);
        renderQueue.push(...items);
        return items;
      },
      renderItems: renderSeriesItems,
      stop: stopRenderQueue,
    } };

    let stopSeriesBackgroundExport = () => { };
    ${loadBlock}
    ${exportBlock}
    return {
      exportAndContinue, runPart, lostNote: () => lostExportsNote,
      stop: () => { seriesRun.stopped = true; stopSeriesBackgroundExport(); }, // the series' Stop
      stopQueue: () => stopRenderQueue(), // the render queue's own Stop button
      newRun: () => { seriesRun = { stopped: false }; },
    };
  `);
  const api = factory(env, plan, projects, tabsOf, outcome, renderMs, dubMs, sleep);
  return { env, plan, projects, api };
}

const firstIndex = (log, re) => log.findIndex((l) => re.test(l));
const lastIndex = (log, re) => log.length - 1 - [...log].reverse().findIndex((l) => re.test(l));

describe('Dub Whole Series hands-free export', () => {
  test('the blocks are found in the source', () => {
    assert.ok(loadBlock && exportBlock && renderBlock, 'markers moved - update this test');
  });

  test('each part renders while the next part is dubbed; exports stay in part order; all exported', async () => {
    const { env, plan, api } = makeSeries({ parts: 3 });
    await api.exportAndContinue();
    const { log } = env;
    // Part 2 is being dubbed before part 1's last tab has rendered.
    assert.ok(firstIndex(log, /^dub part2/) < lastIndex(log, /^render part1_/), log.join('\n'));
    // Part 1's tabs were closed (they are in the queue) before part 2 opened.
    assert.ok(lastIndex(log, /^close part1_/) < firstIndex(log, /^dub part2/));
    // Part 2's export starts only after part 1's is complete, and so on.
    assert.ok(lastIndex(log, /^render part1_/) < firstIndex(log, /^render part2_/));
    assert.ok(lastIndex(log, /^render part2_/) < firstIndex(log, /^render part3_/));
    assert.ok(plan.parts.every((p) => p.status === 'done' && p.exported));
    assert.equal(env.renderQueue.length, 9);
    assert.ok(env.renderQueue.every((i) => i.status === 'done' && i.tries === 1));
    assert.ok(env.toasts.some((t) => /All 3 parts are dubbed and exported/.test(t.m)));
    assert.ok(env.saved.parts.every((p) => p.exported), 'saved for the next app start');
  });

  test('a tab that fails twice in the background is rendered again before the next export', async () => {
    const outcome = (item) => (item.tab === 'part1_tab2' && item.tries <= 2 ? 'error' : 'done');
    const { env, plan, api } = makeSeries({ parts: 2, outcome });
    await api.exportAndContinue();
    assert.ok(plan.parts.every((p) => p.exported));
    assert.equal(env.renderQueue.find((i) => i.tab === 'part1_tab2').tries, 3);
    assert.ok(env.toasts.some((t) => t.type === 'warning' && /Part 1: 2 of 3/.test(t.m)));
    assert.ok(lastIndex(env.log, /^render part1_/) < firstIndex(env.log, /^render part2_/));
  });

  test('a tab that keeps failing pauses the series before the next export; Continue finishes both', async () => {
    let broken = true;
    const outcome = (item) => (item.tab === 'part1_tab2' && broken ? 'error' : 'done');
    const { env, plan, projects, api } = makeSeries({ parts: 2, outcome });
    await assert.rejects(api.exportAndContinue(), /Part 1: 2 of 3 tab\(s\) exported \(1 failed\)/);
    assert.equal(plan.parts[0].exported, undefined);
    assert.equal(plan.parts[1].status, 'done');
    assert.deepEqual(projects.map((p) => p.name), ['part2_tab1', 'part2_tab2', 'part2_tab3'], 'part 2 is still open');
    assert.equal(firstIndex(env.log, /^queue .*part2/), -1, 'part 2 is not in the queue yet');

    broken = false; // fixed; Continue
    api.newRun();
    await api.exportAndContinue();
    assert.ok(plan.parts.every((p) => p.exported));
    assert.equal(env.renderQueue.filter((i) => i.status === 'done').length, 6);
  });

  test('Stop while the finished part renders: the render stops too; Continue renders only the rest', async () => {
    const { env, plan, api } = makeSeries({ parts: 2, renderMs: 15, dubMs: 60 });
    const run = api.exportAndContinue();
    await sleep(20); // part 1's second tab is rendering, part 2 is being dubbed
    api.stop();
    await assert.rejects(run, (e) => e.seriesStopped);
    const part1 = env.renderQueue.filter((i) => /^part1_/.test(i.tab));
    assert.ok(part1.some((i) => i.status === 'cancelled'), 'not rendered on after Stop');
    assert.equal(plan.parts[0].exported, undefined);

    // Continue: part 2 is dubbed again from where it stopped, then exports go on in order.
    const doneBefore = part1.filter((i) => i.status === 'done').map((i) => i.tab);
    api.newRun();
    await api.runPart(1);
    await api.exportAndContinue();
    assert.ok(plan.parts.every((p) => p.exported));
    assert.ok(part1.every((i) => i.status === 'done'));
    part1.filter((i) => doneBefore.includes(i.tab)).forEach((i) => assert.equal(i.tries, 1, `${i.tab} was already done: not rendered again`));
    assert.ok(part1.every((i) => i.tries <= 2), 'a stopped tab is rendered once more, no more');
  });

  test('the render queue\'s own Stop while the series waits: the series pauses instead of rendering it again', async () => {
    const { env, plan, api } = makeSeries({ parts: 2, renderMs: 30, dubMs: 5 });
    const run = api.exportAndContinue();
    await sleep(45); // part 2 is dubbed; the series waits for part 1's second tab
    await api.stopQueue();
    await assert.rejects(run, /Part 1's export was stopped \(1 of 3 tab\(s\) exported\)\. Press Continue to export the rest\./);
    const part1 = env.renderQueue.filter((i) => /^part1_/.test(i.tab));
    assert.ok(part1.every((i) => (i.tries || 0) <= 1), 'nothing rendered again after the Stop');
    assert.ok(part1.some((i) => i.status === 'cancelled'));
    assert.equal(plan.parts[0].exported, undefined);
    assert.equal(plan.parts[1].exported, undefined);

    api.newRun(); // Continue
    await api.exportAndContinue();
    assert.ok(plan.parts.every((p) => p.exported));
  });

  test('app restarted while a part was exporting: that part is dubbed again, other parts untouched', () => {
    const plan = {
      outDir: 'D:\\out',
      parts: [
        { status: 'done', autoExport: true, exported: true },
        { status: 'done', autoExport: true },
        { status: 'done' }, // finished without hands-free: the user's to export
        { status: 'joined' },
      ],
      lastDone: { index: 1 },
    };
    const { env, api } = makeSeries({ plan });
    assert.equal(plan.parts[0].status, 'done');
    assert.equal(plan.parts[1].status, 'joined');
    assert.equal(plan.parts[1].autoExport, undefined);
    assert.equal(plan.parts[2].status, 'done');
    assert.equal(plan.lastDone, null, 'Continue must not export whatever tabs are open as part 2');
    assert.match(api.lostNote(), /Part 2 wasn't fully exported when the app closed, so it is dubbed again/);
    assert.equal(env.saved.parts[1].status, 'joined');
  });

  test('a normal start leaves the plan alone', () => {
    const { env, api } = makeSeries({ parts: 3 });
    assert.equal(api.lostNote(), '');
    assert.equal(env.saves, 0);
  });
});
