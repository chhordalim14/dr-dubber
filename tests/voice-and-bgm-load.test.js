// Fewer heavy things at once on an ordinary PC (2026-11-18, a 16 GB Mac during Dub Whole Series):
// - voice requests from the window: at most 5 open across every tab (8 tabs put 40-60 lines in
//   Chromium's own queue, and 64 of them failed in the same millisecond, "Failed to fetch");
// - why such a request failed, from Chromium, in the server log (one line per burst);
// - Isolate BGM All: 1 tab at a time with 16 GB of RAM or less;
// - Remove music: one at a time on the PC (3.7 GB each on Apple's GPU).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(repo, 'frontend', 'js', 'studio-main.js'), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout has CRLF

// A function of studio-main.js, run on its own: from `start` to the line closing it.
function pageSnippet(start, end) {
  const i = page.indexOf(start);
  assert.ok(i >= 0, `${start} not found in studio-main.js`);
  const j = page.indexOf(end, i);
  assert.ok(j > i, `${end} not found after ${start}`);
  return page.slice(i, j + end.length);
}

test('voice requests: never more than 5 open across every tab, and every one is sent', async () => {
  const src = pageSnippet('const VOICE_REQUESTS_AT_ONCE', '\n    }\n\n    async function generateStandardAudioForProject');
  const slot = new Function(`${src.replace(/\n    async function generateStandardAudioForProject$/, '')}; return withVoiceRequestSlot;`)();
  let open = 0, most = 0, done = 0;
  const send = () => new Promise((resolve) => {
    open++; most = Math.max(most, open);
    setTimeout(() => { open--; done++; resolve('ok'); }, 5 + Math.random() * 10);
  });
  // 8 tabs x 6 lines at once, as Dub Whole Series sends them.
  const results = await Promise.all(Array.from({ length: 48 }, () => slot(null, send)));
  assert.equal(most, 5);
  assert.equal(done, 48);
  assert.ok(results.every((r) => r === 'ok'));
});

test('voice requests: a slot is given back when a request fails, and a stopped job waits no longer', async () => {
  const src = pageSnippet('const VOICE_REQUESTS_AT_ONCE', '\n    }\n\n    async function generateStandardAudioForProject');
  const slot = new Function(`${src.replace(/\n    async function generateStandardAudioForProject$/, '')}; return withVoiceRequestSlot;`)();
  const fails = await Promise.allSettled(Array.from({ length: 5 }, () => slot(null, () => Promise.reject(new TypeError('Failed to fetch')))));
  assert.ok(fails.every((f) => f.status === 'rejected' && f.reason.message === 'Failed to fetch'));
  // All 5 slots are free again:
  let release;
  const hold = Array.from({ length: 5 }, () => slot(null, () => new Promise((r) => { release = release || []; release.push(r); })));
  await new Promise((r) => setImmediate(r));
  assert.equal(release.length, 5);
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(slot(ctrl.signal, () => Promise.resolve('sent')), (e) => e.name === 'AbortError');
  release.forEach((r) => r('ok'));
  await Promise.all(hold);
});

test('the voice fetch goes through the slot', () => {
  assert.match(page, /await withVoiceRequestSlot\(jobAbortController\.signal, \(\) => fetch\("http:\/\/localhost:3001\/api\/generate-audio"/);
});

test('voice requests: micro-staggering spaces consecutive outgoing requests', async () => {
  const src = pageSnippet('const VOICE_REQUESTS_AT_ONCE', '\n    }\n\n    async function generateStandardAudioForProject');
  const slot = new Function('window', `${src.replace(/\n    async function generateStandardAudioForProject$/, '')}; return withVoiceRequestSlot;`)({ __VOICE_STAGGER_MS: 50 });
  const starts = [];
  const send = () => new Promise((resolve) => {
    starts.push(Date.now());
    setTimeout(() => resolve('ok'), 10);
  });
  await Promise.all([slot(null, send), slot(null, send), slot(null, send)]);
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 35, `gap 1 too small: ${starts[1] - starts[0]}ms`);
  assert.ok(starts[2] - starts[1] >= 35, `gap 2 too small: ${starts[2] - starts[1]}ms`);
});

test('Isolate BGM All: 1 tab at a time with 16 GB of RAM or less, else 2', async () => {
  const src = pageSnippet('async function bgmTabsAtOnce()', '\n      return 2;\n    }');
  const run = async (specs) => new Function('window', `${src}; return bgmTabsAtOnce();`)({ electronAPI: specs === undefined ? undefined : { getHardwareSpecs: async () => { if (specs instanceof Error) throw specs; return specs; } } });
  assert.equal(await run({ ramGB: 16 }), 1);
  assert.equal(await run({ ramGB: 8 }), 1);
  assert.equal(await run({ ramGB: 32 }), 2);
  assert.equal(await run({}), 2, 'unknown RAM: as before');
  assert.equal(await run(undefined), 2, 'no Electron');
  assert.equal(await run(new Error('ipc failed')), 2);
  assert.match(page, /const poolSize = await bgmTabsAtOnce\(\);/);
});

test('Remove music runs under the one-at-a-time lock the separators share', () => {
  const py = fs.readFileSync(path.join(repo, 'backend', 'python', 'vocal_separator.py'), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout has CRLF
  const fn = py.slice(py.indexOf('def remove_music('), py.indexOf('def ml_failure('));
  assert.match(fn, /with one_at_a_time\("music", "[^"]+"\):\n\s+try:\n\s+proc = subprocess\.Popen/);
  // Everything that reads the running process stays inside the lock.
  const inside = fn.slice(fn.indexOf('with one_at_a_time("music"'));
  assert.match(inside, /^ {8}proc\.wait\(\)$/m);
});

test('a burst of failed requests is one log line with Chromium\'s reason; Stop (ERR_ABORTED) is not logged', () => {
  const { createRequestErrorLog } = require('../backend/lib/request-errors');
  const lines = [];
  let fire = null;
  const rl = createRequestErrorLog({ log: (l) => lines.push(l), setTimer: (fn) => { fire = fn; return 0; } });
  for (let i = 0; i < 43; i++) rl.onError({ error: 'net::ERR_NETWORK_CHANGED', method: 'POST', url: 'http://localhost:3001/api/generate-audio' });
  rl.onError({ error: 'net::ERR_NETWORK_CHANGED', method: 'GET', url: 'http://localhost:3001/api/bgm-status/x?y=1' });
  rl.onError({ error: 'net::ERR_ABORTED', method: 'POST', url: 'http://localhost:3001/api/generate-audio' });
  assert.equal(lines.length, 0, 'nothing until the burst is over');
  fire();
  assert.deepEqual(lines, ["[Network] 44 request(s) from the window to the app's server failed: net::ERR_NETWORK_CHANGED x44 (POST /api/generate-audio x43, GET /api/bgm-status/x)"]);
  rl.onError({ error: 'net::ERR_ABORTED', url: 'http://localhost:3001/a' });
  rl.onError({ error: 'net::ERR_CACHE_MISS', url: 'http://localhost:3001/fonts/KantumruyPro-Bold.ttf' });
  rl.flush();
  assert.equal(lines.length, 1, 'only aborted requests and cache-only lookups: nothing to say');
});

test('main.js passes failed requests to the app\'s server on to the log', () => {
  const main = fs.readFileSync(path.join(repo, 'main.js'), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout has CRLF
  assert.match(main, /webRequest\.onErrorOccurred\(\s*\{ urls: \[`http:\/\/localhost:\$\{PORT\}\/\*`, `http:\/\/127\.0\.0\.1:\$\{PORT\}\/\*`\] \}/);
  assert.ok(main.indexOf('onErrorOccurred') < main.indexOf('createWindow();\n\n        app.on'), 'hooked up before the window opens');
});

test('maxPastStates bounds undo history based on PC profile', () => {
  const fn = new Function('pcLimit, window', `${pageSnippet('function maxPastStates()', '\n    }')}; return maxPastStates;`);
  // Light profile (renders limit is 1)
  const lightFn = fn((name) => (name === 'renders' ? 1 : 2), {});
  assert.equal(lightFn(), 15);
  // Standard profile (renders limit is 2)
  const standardFn = fn((name) => (name === 'renders' ? 2 : 2), {});
  assert.equal(standardFn(), 25);
  // No pcLimit available
  const defaultFn = fn(undefined, {});
  assert.equal(defaultFn(), 25);
});

test('pruneActiveAudios evicts paused audio elements when activeAudios exceeds MAX_ACTIVE_AUDIOS', () => {
  const snippet = pageSnippet('const activeAudios = {};', '\n    let bgmAudio = null;');
  const sandbox = new Function('window', `
    ${snippet.replace('let bgmAudio = null;', '')}
    return { activeAudios, pruneActiveAudios, MAX_ACTIVE_AUDIOS };
  `)({});
  const { activeAudios, pruneActiveAudios, MAX_ACTIVE_AUDIOS } = sandbox;

  for (let i = 0; i < 50; i++) {
    activeAudios['sub-' + i] = {
      paused: true,
      src: 'http://localhost:3001/audio-' + i + '.wav',
      removeAttribute: function() { this.src = ''; },
      load: function() {}
    };
  }
  assert.equal(Object.keys(activeAudios).length, 50);
  pruneActiveAudios();
  assert.equal(Object.keys(activeAudios).length, MAX_ACTIVE_AUDIOS);
  assert.equal(MAX_ACTIVE_AUDIOS, 40);
});

test('setVoxAudioCache evicts oldest entry when cache exceeds MAX_VOX_AUDIO_CACHE', () => {
  const snippet = pageSnippet('const voxAudioBase64Cache =', '\n    async function executeVoxCpm2Synthesis');
  const sandbox = new Function('window', `
    ${snippet.replace('async function executeVoxCpm2Synthesis', '')}
    return { voxAudioBase64Cache, setVoxAudioCache, MAX_VOX_AUDIO_CACHE };
  `)({});
  const { voxAudioBase64Cache, setVoxAudioCache, MAX_VOX_AUDIO_CACHE } = sandbox;

  assert.equal(MAX_VOX_AUDIO_CACHE, 5);
  for (let i = 1; i <= 6; i++) {
    setVoxAudioCache('key-' + i, 'base64-data-' + i);
  }
  assert.equal(voxAudioBase64Cache.size, 5);
  assert.equal(voxAudioBase64Cache.has('key-1'), false, 'oldest entry evicted');
  assert.equal(voxAudioBase64Cache.has('key-6'), true, 'newest entry kept');
});

test('clearVocalWaveform resets canvas dimensions to 1x1 to reclaim GPU texture memory', () => {
  const snippet = pageSnippet('function clearVocalWaveform()', '\n    let isIsolatingBgm = false;');
  const mockCanvas = { width: 30000, height: 100, getContext: () => ({ clearRect: () => {} }) };
  const mockDoc = { getElementById: (id) => (id === 'a1-waveform-canvas' ? mockCanvas : null) };
  const res = new Function('document, mockCanvas', `
    let _activeWaveformDrawId = 0;
    ${snippet.replace('let isIsolatingBgm = false;', '')}
    clearVocalWaveform();
    return { canvas: mockCanvas, drawId: _activeWaveformDrawId };
  `)(mockDoc, mockCanvas);
  assert.equal(res.canvas.width, 1);
  assert.equal(res.canvas.height, 1);
  assert.equal(res.drawId, 1);
});
