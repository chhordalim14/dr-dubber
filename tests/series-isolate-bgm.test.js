// Dub Whole Series, Isolate BGM step: the real isolateStep of frontend/js/studio-main.js run
// against a fake isolateBgmAllProjects. No ML engine installed at all (as on every installer
// copy) keeps the FFmpeg BGM and goes on; an engine that is there but broke still pauses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8');
const a = src.indexOf('      // Fell back to FFmpeg only because no ML engine is installed');
const b = src.indexOf('      // Burned-in subtitles: found in every tab', a);
const block = a > 0 && b > a ? src.slice(a, b) : null;

const NOT_INSTALLED = 'Spleeter could not run (no Python with Spleeter installed was found (backend/spleeter-env is missing or broken)); '
  + 'Demucs could not run (no Python with Demucs installed was found (backend/demucs-env is missing or broken))';
const CRASHED = 'Spleeter could not run (ImportError: DLL load failed while importing _pywrap_tensorflow_internal); '
  + 'Demucs could not run (no Python with Demucs installed was found (backend/demucs-env is missing or broken))';

// runs: what each isolateBgmAllProjects call does to the tabs it gets: (tab) => { method, reason } or 'fail'.
function makeStep(tabs, runs) {
  const calls = [];
  const isolateBgmAllProjects = async (opts) => {
    const run = runs[calls.length] || runs[runs.length - 1];
    calls.push(opts);
    const res = { total: tabs.length, fellBack: [], failed: [], substituted: [] };
    for (const p of opts.only || tabs) {
      const r = run(p);
      if (r === 'fail') { p.bgmError = 'boom'; res.failed.push(p); continue; }
      p.bgmMethod = r.method;
      p.bgmFallbackReason = r.reason || '';
      if (r.method === 'ffmpeg_fallback') res.fellBack.push(p);
      else if (r.reason) res.substituted.push(p);
    }
    return res;
  };
  const isolateStep = new Function('projects', 'isolateBgmAllProjects', 'localStorage', `
    const plan = { current: 0, parts: [{}] };
    const checkStop = () => { };
    const setLabel = () => { };
    const stoppedError = () => new Error('stopped');
    const tabNumbers = (list) => list.map((p) => projects.indexOf(p) + 1).join(", ");
    ${block}
    return isolateStep;
  `)(tabs, isolateBgmAllProjects, { getItem: () => null });
  return { isolateStep, calls };
}

const tabs = (n) => Array.from({ length: n }, (_, i) => ({ name: `tab${i + 1}` }));

test('the step is found in studio-main.js', () => {
  assert.ok(block, 'isolateStep block not found - update the markers in this test');
});

test('no ML engine installed: every tab keeps the FFmpeg BGM, no retry, no pause', async () => {
  const t = tabs(3);
  const { isolateStep, calls } = makeStep(t, [() => ({ method: 'ffmpeg_fallback', reason: NOT_INSTALLED })]);
  const note = await isolateStep();
  assert.equal(calls.length, 1);
  assert.match(note, /^3 of 3 tabs/);
  assert.match(note, /tab 1, 2, 3 used FFmpeg phase cancellation \(Spleeter and Demucs are not installed\)/);
});

test('an installed engine that crashed still gets a retry and then pauses the series', async () => {
  const t = tabs(2);
  const { isolateStep, calls } = makeStep(t, [(p) => (p === t[0]
    ? { method: 'ffmpeg_fallback', reason: CRASHED }
    : { method: 'ffmpeg_fallback', reason: NOT_INSTALLED })]);
  await assert.rejects(isolateStep(), /Tab 1: Spleeter could not run \(ImportError.*Fix it or switch engine in Settings/);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].only, [t[0]]);
});

test('a tab with no BGM at all still pauses the series', async () => {
  const t = tabs(2);
  const { isolateStep } = makeStep(t, [(p) => (p === t[1] ? 'fail' : { method: 'ffmpeg_fallback', reason: NOT_INSTALLED })]);
  await assert.rejects(isolateStep(), /Tab 2: Spleeter could not run \(boom\)/);
});

test('a crash that is gone on the retry goes on, with the no-engine tabs noted', async () => {
  const t = tabs(2);
  const { isolateStep } = makeStep(t, [
    (p) => (p === t[0] ? { method: 'ffmpeg_fallback', reason: CRASHED } : { method: 'ffmpeg_fallback', reason: NOT_INSTALLED }),
    () => ({ method: 'spleeter' }),
  ]);
  const note = await isolateStep();
  assert.match(note, /1 tab\(s\) needed a second try/);
  assert.match(note, /tab 2 used FFmpeg phase cancellation/);
});
