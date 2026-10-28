// The real "Fast Audio" block of frontend/js/studio-main.js (pace analysis + Dub Whole Series'
// fitFastLinesAllTabs / refitShortenedLinesAllTabs), run against fake tabs and a fake
// /api/condense-fast-subtitles.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8');
const start = src.indexOf('    const FAST_SPEED_THRESHOLD = 1.15;');
const end = src.indexOf('    // ── Timeline changes ──');
const fastBlock = src.slice(start, end);
// The voice's room for a line (a line matched to the video may speak past its text), from the
// same file; and the Khmer text as said (the pace estimate of a line not voiced yet uses it).
const voiceSlotSrc = src.slice(src.indexOf('    const VOICE_GAP = '), src.indexOf('    // Bottom margin (% of the video height)'));
const KhmerSpeech = require('../frontend/js/khmer-speech.js');
const ScreenSync = require('../frontend/js/screen-sync.js');

// keys: the API keys in Settings. delayMs: how long each fake Gemini answer takes (to see
// requests overlap). env.maxParallel: most requests that were running at once.
function makeEnv({ condense, missing = () => [], keys = ['k1'], delayMs = 0 }) {
  const env = {
    projects: [], activeProjectIndex: -1, subtitles: [], activeAudios: {}, duration: 0,
    requests: [], running: 0, maxParallel: 0, cancelled: [],
  };
  const factory = new Function('env', 'condense', 'missing', 'keysJson', 'delayMs', 'KhmerSpeech', 'ScreenSync', `
    let { projects, activeProjectIndex, subtitles, activeAudios, duration } = env;
    const saveCurrentProjectState = () => { }, renderSubtitles = () => { }, updateContextualControls = () => { };
    const showToast = () => { }, saveStateToPast = () => { }, saveProjectStateDirectly = () => { };
    const isSpeakableText = (t) => /[\\p{L}\\p{N}]/u.test(t || '');
    const targetLanguage = 'Khmer', activeDramaGenre = 'historical', getDramaGlossaryDict = () => null;
    const localStorage = { getItem: (k) => (k === 'aiDubberApiKeys' ? keysJson : null) };
    const document = { getElementById: () => null, querySelector: () => null };
    const CSS = { escape: (s) => s };
    const window = { KhmerSpeech, ScreenSync, defaultVoiceFor: (g) => (g === 'Female' ? 'Female' : 'Male') };
    const fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url.endsWith('/api/cancel-transcribe')) {
        env.cancelled.push(body.requestId);
        return { json: async () => ({ success: true }) };
      }
      env.requests.push(body);
      if (url.endsWith('/api/translate-missing-lines')) return { json: async () => ({ success: true, results: missing(body.lines, body) }) };
      env.running++;
      env.maxParallel = Math.max(env.maxParallel, env.running);
      await new Promise((r) => setTimeout(r, delayMs));
      env.running--;
      return { json: async () => ({ success: true, results: condense(body.subtitles) }) };
    };
    ${voiceSlotSrc}
    ${fastBlock}
    return { shortenForVoxCpm2, fillMissingScreenLinesAllTabs, fitFastLinesAllTabs, refitShortenedLinesAllTabs, countRushedLinesAllTabs, fillShortVoicesAllTabs, nativePaceAllTabs, refitPacedLinesAllTabs, boostVoicesOverMusic, musicLevelDb, analyzeSubPace, settleMatchedSubtitles, setProjects: (p) => { projects = p; }, setActive: (i, live) => { activeProjectIndex = i; subtitles = live; }, getLive: () => subtitles };
  `);
  return { env, api: factory(env, condense, missing, JSON.stringify(keys), delayMs, KhmerSpeech, ScreenSync) };
}

// A line: text slot [start, end], voice of baseDur seconds.
const line = (id, start, end, baseDur, text = 'ខ្ញុំមិនដឹងថាត្រូវធ្វើយ៉ាងម៉េចទៀតទេ') =>
  ({ id, textStart: String(start), textEnd: String(end), audioStart: String(start), baseAudioDuration: baseDur, audioStatus: 'ready', file: 'x.mp3', speed: 1, text });

describe('fit rushed lines (Dub Whole Series)', () => {
  test('the block is found in the source', () => {
    assert.ok(start > 0 && end > start, 'markers moved - update this test');
  });

  test('a line with free time after it is extended, not rewritten', async () => {
    const { env, api } = makeEnv({ condense: () => [] });
    const tab = { duration: 60, subtitles: [line('a', 0, 2, 2.6), line('b', 5, 7, 1.5)] };
    api.setProjects([tab]);
    const r = await api.fitFastLinesAllTabs();
    assert.equal(r.extended, 1);
    assert.equal(r.shortened, 0);
    assert.equal(env.requests.length, 0);
    assert.ok(parseFloat(tab.subtitles[0].textEnd) >= 2.6, 'end moved into the free time');
    assert.equal(tab.subtitles[0].speed, 1.0);
  });

  test('a line matched to the video: its voice uses the time up to the next line, its text keeps the video\'s times', async () => {
    const { env, api } = makeEnv({ condense: () => [] });
    // On screen 0-1.2 s (the video's own line), voice 2.6 s, next line at 5 s.
    const a = { ...line('a', 0, 1.2, 2.6), screenMatched: true, voiceRoom: '4.90' };
    const tab = { duration: 60, subtitles: [a, { ...line('b', 5, 6, 0.9), screenMatched: true, voiceRoom: '55.00' }] };
    api.setProjects([tab]);
    assert.ok(api.analyzeSubPace(a).effectiveSpeed < 1.15, 'not counted as rushed');
    const r = await api.fitFastLinesAllTabs();
    assert.equal(r.extended, 0);
    assert.equal(env.requests.length, 0);
    assert.equal(a.textEnd, '1.2', 'shown exactly while the video\'s line is');
    assert.equal(a.speed, 1);
  });

  test('a matched line whose voice runs into the next line is still sped up (not past the next line)', async () => {
    const { api } = makeEnv({ condense: () => [] });
    const a = { ...line('a', 0, 1.2, 4.0), screenMatched: true, voiceRoom: '2.90' };
    const tab = { duration: 60, subtitles: [a, { ...line('b', 3, 4, 0.9), screenMatched: true }] };
    api.setProjects([tab]);
    await api.fitFastLinesAllTabs();
    assert.equal(a.textEnd, '1.2');
    assert.ok(parseFloat(a.audioEnd) <= 3, `voice ends by the next line (${a.audioEnd})`);
    assert.ok(a.speed > 1.3 && a.speed < 1.5, `just fast enough (${a.speed})`);
  });

  test('a line with no room is shortened by Gemini and left idle to be voiced again', async () => {
    const { env, api } = makeEnv({ condense: (subs) => subs.map((s) => ({ id: s.id, condensedText: 'មិនដឹងទេ' })) });
    const tab = { duration: 60, subtitles: [line('a', 0, 2, 3.5), line('b', 2.05, 4, 1.5)] };
    api.setProjects([tab]);
    const r = await api.fitFastLinesAllTabs();
    assert.equal(r.shortened, 1);
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0].subtitles[0].id, 'a');
    const a = tab.subtitles[0];
    assert.equal(a.text, 'មិនដឹងទេ');
    assert.equal(a.audioStatus, 'idle');
    assert.equal(tab.subtitles[1].audioStatus, 'ready', 'lines that fit are not touched');
  });

  test('slightly fast lines (under 1.3x) are only sped up a little, never rewritten', async () => {
    const { env, api } = makeEnv({ condense: () => { throw new Error('should not be called'); } });
    const tab = { duration: 60, subtitles: [line('a', 0, 2, 2.4), line('b', 2.05, 4, 1.5)] }; // needs 1.2x
    api.setProjects([tab]);
    const r = await api.fitFastLinesAllTabs();
    assert.equal(r.shortened, 0);
    assert.equal(env.requests.length, 0);
    assert.ok(tab.subtitles[0].speed > 1 && tab.subtitles[0].speed < 1.3);
  });

  test('every tab is handled, each with its own request', async () => {
    const { env, api } = makeEnv({ condense: (subs) => subs.map((s) => ({ id: s.id, condensedText: 'ទៅ!' })) });
    const tabs = [1, 2].map(() => ({ duration: 60, subtitles: [line('a', 0, 1, 3), line('b', 1.05, 3, 1)] }));
    api.setProjects(tabs);
    const r = await api.fitFastLinesAllTabs();
    assert.equal(r.shortened, 2);
    assert.equal(env.requests.length, 2);
  });

  test('tabs are shortened at once, each starting on its own key (the others as backups)', async () => {
    const keys = ['k1', 'k2', 'k3'];
    const { env, api } = makeEnv({ condense: (subs) => subs.map((s) => ({ id: s.id, condensedText: 'ទៅ!' })), keys, delayMs: 30 });
    const tabs = [1, 2, 3].map(() => ({ duration: 60, subtitles: [line('a', 0, 1, 3), line('b', 1.05, 3, 1)] }));
    api.setProjects(tabs);
    const r = await api.fitFastLinesAllTabs();
    assert.equal(r.shortened, 3);
    assert.equal(env.maxParallel, 3);
    assert.deepEqual(env.requests.map((b) => b.apiKey).sort(), keys);
    env.requests.forEach((b) => {
      assert.equal(b.apiKeys[0], b.apiKey);
      assert.deepEqual([...b.apiKeys].sort(), keys, 'every key is still a backup');
    });
  });

  test('more tabs than keys: one request per key at a time, every tab still done', async () => {
    const { env, api } = makeEnv({ condense: (subs) => subs.map((s) => ({ id: s.id, condensedText: 'ទៅ!' })), keys: ['k1', 'k2'], delayMs: 20 });
    const tabs = [1, 2, 3, 4, 5].map(() => ({ duration: 60, subtitles: [line('a', 0, 1, 3), line('b', 1.05, 3, 1)] }));
    api.setProjects(tabs);
    const r = await api.fitFastLinesAllTabs();
    assert.equal(r.shortened, 5);
    assert.equal(env.requests.length, 5);
    assert.equal(env.maxParallel, 2);
    tabs.forEach((t) => assert.equal(t.subtitles[0].text, 'ទៅ!'));
  });

  test('Stop: no new request starts, answers already asked for land, the open tab shows them', async () => {
    const { env, api } = makeEnv({ condense: (subs) => subs.map((s) => ({ id: s.id, condensedText: 'ទៅ!' })), keys: ['k1', 'k2'], delayMs: 30 });
    const tabs = [1, 2, 3, 4].map(() => ({ duration: 60, subtitles: [line('a', 0, 1, 3), line('b', 1.05, 3, 1)] }));
    api.setProjects(tabs);
    api.setActive(0, tabs[0].subtitles.map((s) => ({ ...s })));
    let stopped = false;
    setTimeout(() => { stopped = true; }, 10); // while the first two requests run
    const stopErr = new Error('stopped');
    await assert.rejects(api.fitFastLinesAllTabs({ checkStop: () => { if (stopped) throw stopErr; } }), (e) => e === stopErr);
    assert.equal(env.requests.length, 2, 'tabs 3 and 4 never asked');
    assert.equal(env.running, 0, 'nothing still in flight when it returns');
    assert.equal(tabs[0].subtitles[0].text, 'ទៅ!');
    assert.equal(api.getLive()[0].text, 'ទៅ!', 'the open tab was refreshed');
    assert.equal(tabs[2].subtitles[0].audioStatus, 'ready');
  });

  test('after re-voicing, shortened lines get a speed that fits; still-rushed ones are counted', async () => {
    const { api } = makeEnv({ condense: (subs) => subs.map((s) => ({ id: s.id, condensedText: 'ទៅ!' })) });
    const tab = { duration: 60, subtitles: [line('a', 0, 2, 3.5), line('b', 2.05, 4, 1.5)] };
    api.setProjects([tab]);
    await api.fitFastLinesAllTabs();
    Object.assign(tab.subtitles[0], { audioStatus: 'ready', baseAudioDuration: 1.8 }); // new, shorter voice
    assert.equal(api.refitShortenedLinesAllTabs(), 0);
    assert.equal(tab.subtitles[0].speed, 1.0);
    assert.equal(tab.subtitles[0]._fitShortened, undefined);
  });

  test('one pass fixes the fastest lines; what is left a little fast is only counted', async () => {
    const { env, api } = makeEnv({ condense: (subs) => subs.map((s) => ({ id: s.id, condensedText: 'ខ្ញុំមិនដឹងទេ' })) });
    // a: 1.75x, no room -> shortened. c: 1.2x -> only sped up, never rewritten.
    const tab = { duration: 60, subtitles: [line('a', 0, 2, 3.5), line('b', 2.05, 4, 1.5), line('c', 4.05, 6, 2.4), line('d', 6.05, 8, 1.5)] };
    api.setProjects([tab]);
    const r = await api.fitFastLinesAllTabs();
    assert.equal(r.shortened, 1);
    assert.deepEqual(env.requests[0].subtitles.map((s) => s.id), ['a'], 'only the clearly rushed line goes to Gemini');
    Object.assign(tab.subtitles[0], { audioStatus: 'ready', baseAudioDuration: 2.8 }); // re-voiced: 1.4x, better
    api.refitShortenedLinesAllTabs();
    assert.equal(api.countRushedLinesAllTabs(), 1, 'still a little fast: reported, not chased');
  });

  test('Dub Whole Series runs the rushed-line fix once per part, not until none are left', () => {
    const main = src.replace(/\r\n/g, '\n');
    const step = main.slice(main.indexOf('      async function generateStep() {'), main.indexOf('      function noEngineInstalled(p) {'));
    assert.equal((step.match(/await fitFastLinesAllTabs\(/g) || []).length, 1);
    assert.ok(!/for \(let round/.test(step), 'no repeat rounds');
    assert.match(step, /const stillRushed = countRushedLinesAllTabs\(\);/);
  });
});

// A subtitle matched to the video's own line (Match Subtitles to Video) appears with the line and
// stays up while its voice speaks - never into the next subtitle.
describe('matched subtitles follow their voice', () => {
  const matched = (id, start, screenLen, audioEnd, extra = {}) => ({
    id, textStart: String(start), textEnd: (start + screenLen).toFixed(2), screenLen: String(screenLen), screenMatched: true,
    audioStatus: audioEnd == null ? 'idle' : 'ready', audioStart: String(start), audioEnd: audioEnd == null ? undefined : String(audioEnd), ...extra,
  });

  test('the voice outlasts the line: the subtitle stays until the voice ends', () => {
    const { api } = makeEnv({ condense: () => [] });
    const subs = [matched('a', 0, 1.2, 2.6), matched('b', 5, 1.0, 5.8)];
    assert.equal(api.settleMatchedSubtitles(subs, 60), 1);
    assert.equal(subs[0].textEnd, '2.75');
    assert.equal(subs[1].textEnd, '6.00', 'a voice shorter than its line: the line\'s time');
  });

  test('never into the next subtitle; never shorter than the video\'s line', () => {
    const { api } = makeEnv({ condense: () => [] });
    const subs = [matched('a', 0, 1.2, 3.4), matched('b', 3, 1.0, 3.5)];
    api.settleMatchedSubtitles(subs, 60);
    assert.equal(subs[0].textEnd, '2.95');
    const lone = [matched('c', 0, 2.0, 0.8)];
    api.settleMatchedSubtitles(lone, 60);
    assert.equal(lone[0].textEnd, '2.00');
  });

  test('no voice yet, or not matched: left as it is', () => {
    const { api } = makeEnv({ condense: () => [] });
    const subs = [matched('a', 0, 1.2, null), { id: 'b', textStart: '2', textEnd: '3', audioStatus: 'ready', audioEnd: '6' }];
    assert.equal(api.settleMatchedSubtitles(subs, 60), 0);
    assert.equal(subs[0].textEnd, '1.20');
    assert.equal(subs[1].textEnd, '3');
  });
});

describe('short voices last as long as the actor', () => {
  // Matched to the video's line [start, start + screenLen], voice of baseDur seconds.
  const onScreen = (id, start, screenLen, baseDur) => ({ ...line(id, start, start + screenLen, baseDur), screenMatched: true, screenLen: String(screenLen) });

  test('a voice that ends well before its line is slowed, never below 0.85x, and its subtitle stays while it speaks', () => {
    const { api } = makeEnv({ condense: () => [] });
    // Measured case: the line shows 5.04 s, the Khmer voice was 3.8 s.
    const a = onScreen('a', 0.42, 5.04, 3.8);
    const tab = { duration: 60, subtitles: [a, onScreen('b', 8, 2, 1.9)] };
    api.setProjects([tab]);
    assert.equal(api.fillShortVoicesAllTabs(), 1);
    assert.equal(a.speed, 0.85);
    assert.equal(a.audioEnd, (0.42 + 3.8 / 0.85).toFixed(2));
    assert.ok(parseFloat(a.textEnd) >= parseFloat(a.audioEnd), 'subtitle shown while the voice speaks');
    assert.equal(tab.subtitles[1].speed, 1, 'a voice that already fills its line is left alone');
  });

  test('just slow enough to fill the line', () => {
    const { api } = makeEnv({ condense: () => [] });
    const a = onScreen('a', 0, 4, 3.4); // 0.6 s short
    api.setProjects([{ duration: 60, subtitles: [a] }]);
    api.fillShortVoicesAllTabs();
    assert.equal(a.speed, 0.85);
    assert.ok(parseFloat(a.audioEnd) <= 4, `ends with the line (${a.audioEnd})`);
  });

  test('never into the next line', () => {
    const { api } = makeEnv({ condense: () => [] });
    const a = onScreen('a', 0, 5, 2.8);
    const tab = { duration: 60, subtitles: [a, onScreen('b', 3.5, 1, 0.9)] };
    api.setProjects([tab]);
    api.fillShortVoicesAllTabs();
    assert.ok(a.speed < 1, `slowed (${a.speed})`);
    assert.ok(parseFloat(a.audioEnd) <= 3.4, `voice ends before the next line (${a.audioEnd})`);
  });

  test('left alone: a small gap, a sped-up voice, a line with no voice', () => {
    const { api } = makeEnv({ condense: () => [] });
    const small = onScreen('a', 0, 2, 1.8);
    const fast = { ...onScreen('b', 5, 2, 1.0), speed: 1.2 };
    const none = { ...onScreen('c', 10, 3, 0), audioStatus: 'idle' };
    api.setProjects([{ duration: 60, subtitles: [small, fast, none] }]);
    assert.equal(api.fillShortVoicesAllTabs(), 0);
    assert.equal(small.speed, 1);
    assert.equal(fast.speed, 1.2);
    assert.equal(none.speed, 1);
  });

  test('a line not matched to the video fills its own text slot', () => {
    const { api } = makeEnv({ condense: () => [] });
    const a = line('a', 0, 3, 2.2);
    api.setProjects([{ duration: 60, subtitles: [a] }]);
    api.fillShortVoicesAllTabs();
    assert.ok(a.speed < 1 && a.speed >= 0.85, `slowed (${a.speed})`);
    assert.ok(parseFloat(a.audioEnd) <= 3);
    assert.equal(a.textEnd, '3', 'its text keeps its times');
  });

  test('Dub Whole Series fills short voices after the rushed-line fix', () => {
    const gen = src.slice(src.indexOf('      async function generateStep() {'), src.indexOf('      function noEngineInstalled('));
    assert.ok(gen.indexOf('fillShortVoicesAllTabs()') > gen.indexOf('fitFastLinesAllTabs('));
  });
});

describe("Edge's own pace instead of a stretch", () => {
  test('a slowed or sped-up voice is voiced again at that pace; a voice at 1.0x is not', () => {
    const { api } = makeEnv({ condense: () => [] });
    const slow = { ...line('a', 0, 5, 3.8), speed: 0.85 };
    const fast = { ...line('b', 6, 8, 2.4), speed: 1.2 };
    const fine = line('c', 9, 11, 1.9);
    const tiny = { ...line('d', 12, 14, 1.9), speed: 1.02 };
    api.setProjects([{ duration: 60, subtitles: [slow, fast, fine, tiny] }]);
    assert.equal(api.nativePaceAllTabs(), 2);
    assert.deepEqual([slow.ttsRate, slow.ttsRateFor, slow.speed, slow.audioStatus], [-15, slow.text, 1, 'idle']);
    assert.equal(fast.ttsRate, 20);
    assert.equal(fine.audioStatus, 'ready');
    assert.equal(tiny.audioStatus, 'ready', 'a 2% stretch is not heard: not voiced again');
  });

  test('never slower than -15% or faster than +35%; a line already at the limit is not voiced again', () => {
    const { api } = makeEnv({ condense: () => [] });
    const a = { ...line('a', 0, 5, 3), speed: 0.7 };
    const b = { ...line('b', 6, 8, 3), speed: 2.0 };
    const c = { ...line('c', 9, 11, 2), speed: 0.9 };
    c.ttsRate = -15; c.ttsRateFor = c.text;
    api.setProjects([{ duration: 60, subtitles: [a, b, c] }]);
    assert.equal(api.nativePaceAllTabs(), 2);
    assert.equal(a.ttsRate, -15);
    assert.equal(b.ttsRate, 35);
    assert.equal(c.audioStatus, 'ready');
  });

  test('a pace is kept only for the text it was made for', () => {
    const { api } = makeEnv({ condense: () => [] });
    const a = { ...line('a', 0, 4, 2.5), speed: 0.9, ttsRate: -10, ttsRateFor: 'អត្ថបទចាស់' };
    api.setProjects([{ duration: 60, subtitles: [a] }]);
    api.nativePaceAllTabs();
    assert.equal(a.ttsRate, -10, 'the old pace is not built on (0 for this text): 0.9x -> -10%');
    assert.equal(a.ttsRateFor, a.text);
  });

  test('voiced again: fitted to the slot, and a voice Edge already slowed is not stretched past the limit', () => {
    const { api } = makeEnv({ condense: () => [] });
    // Voiced again at -15%, still 0.6 s short of its line: no more slowing (0.85 is the limit).
    const a = { ...line('a', 0, 5, 4.4), _nativePaced: true, ttsRate: -15 };
    a.ttsRateFor = a.text;
    const tab = { duration: 60, subtitles: [a] };
    api.setProjects([tab]);
    api.refitPacedLinesAllTabs();
    assert.equal(a._nativePaced, undefined);
    assert.equal(a.speed, 1);
    assert.equal(api.fillShortVoicesAllTabs(), 0);
    assert.equal(a.speed, 1);
  });

  test('Dub Whole Series voices the stretched lines again at their own pace, with Edge only', () => {
    const gen = src.slice(src.indexOf('      async function generateStep() {'), src.indexOf('      function noEngineInstalled('));
    assert.match(gen, /if \(!voxCmp2Load\(\)\.enabled\) \{[\s\S]*nativePaceAllTabs\(\)[\s\S]*runGenerate\(\)[\s\S]*refitPacedLinesAllTabs\(\)[\s\S]*fillShortVoicesAllTabs\(\)/);
    assert.ok(gen.indexOf('countRushedLinesAllTabs()') > gen.indexOf('refitPacedLinesAllTabs()'), 'rushed lines counted after');
  });

  test('Edge is sent the line\'s own pace', () => {
    const gen = src.slice(src.indexOf('    async function generateStandardAudioForProject('), src.indexOf('    async function generateSelectedAudioAllProjects('));
    assert.match(gen, /api\/generate-audio[\s\S]*fitRate: nativeRateOf\(sub\)/);
  });

  test('the server multiplies the line\'s pace into its emotion\'s', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
    const fnSrc = server.slice(server.indexOf('function applyFitRate('), server.indexOf('// ── GLOBAL TTS CONCURRENCY REGULATOR'));
    const applyFitRate = new Function(`${fnSrc}; return applyFitRate;`)();
    assert.equal(applyFitRate('+0%', -15), '-15%');
    assert.equal(applyFitRate('+12%', -15), '-5%');
    assert.equal(applyFitRate('-12%', 20), '+6%');
    assert.equal(applyFitRate('+10%', 0), '+10%');
    assert.equal(applyFitRate('+0%', -90), '-20%', 'clamped');
    assert.match(server, /prosody\.rate = applyFitRate\(prosody\.rate, fitRate\);\s*const cacheKey/);
  });
});

describe('the voice above the music', () => {
  // 20 slices a second; music level `quiet` everywhere, `loud` over [from, to).
  const music = (secs, quiet, loud = [], perSec = 20) => {
    const p = new Array(secs * perSec).fill(quiet);
    loud.forEach(([from, to, v]) => { for (let i = from * perSec; i < to * perSec; i++) p[i] = v; });
    return p;
  };
  const voiced = (id, start, end) => ({ ...line(id, start, end, end - start - 0.1), audioEnd: String(end - 0.1), volume: 1 });

  test('a line over a music swell is played louder, as much as the music is (up to +6 dB)', () => {
    const { api } = makeEnv({ condense: () => [] });
    const subs = [voiced('a', 0, 2), voiced('b', 3, 5), voiced('c', 6, 8), voiced('d', 9, 11), voiced('e', 12, 14)];
    // usual music 32/255; under c +3.5 dB (48), under e +18 dB (255)
    const peaks = music(15, 32, [[6, 8, 48], [12, 14.5, 255]]);
    assert.equal(api.boostVoicesOverMusic(subs, peaks, 20), 2);
    assert.equal(subs[0].volume, 1);
    assert.equal(subs[2].musicBoostDb, 3.5, 'the voice rises as much as the music');
    assert.equal(subs[2].volume, 1.5);
    assert.equal(subs[4].musicBoostDb, 6, 'capped at +6 dB');
    assert.equal(subs[4].volume, 2);
  });

  test('run again: follows the music as it is now; a volume set by hand is left alone', () => {
    const { api } = makeEnv({ condense: () => [] });
    const subs = [voiced('a', 0, 2), voiced('b', 3, 5), voiced('c', 6, 8), { ...voiced('d', 9, 11), volume: 0.7 }, voiced('e', 12, 14), voiced('f', 15, 17)];
    api.boostVoicesOverMusic(subs, music(18, 32, [[6, 8, 128], [9, 11, 128]]), 20);
    assert.ok(subs[2].volume > 1);
    assert.equal(subs[3].volume, 0.7, 'hand-set volume kept');
    api.boostVoicesOverMusic(subs, music(18, 32), 20); // the music is no longer loud there
    assert.equal(subs[2].volume, 1);
    assert.equal(subs[2].musicBoostDb, undefined);
  });

  test('too few voiced lines to know the usual music: nothing changes', () => {
    const { api } = makeEnv({ condense: () => [] });
    const subs = [voiced('a', 0, 2), voiced('b', 3, 5)];
    assert.equal(api.boostVoicesOverMusic(subs, music(6, 32, [[3, 5, 255]]), 20), 0);
  });

  test('Dub Whole Series plays lines louder over loud music after Isolate BGM', () => {
    const iso = src.slice(src.indexOf('      async function isolateStep() {'), src.indexOf('      async function blurTextStep() {'));
    assert.match(iso, /await boostVoicesOverMusicAllTabs\(\)/);
    assert.match(iso, /audio-peaks`, \{ filePath: music\.file \}/);
  });

  test('a tab with loud music all the way through is turned down to -13 dB (at most 8 dB)', () => {
    const { api } = makeEnv({ condense: () => [] });
    const subs = () => [voiced('a', 0, 2), voiced('b', 3, 5), voiced('c', 6, 8), voiced('d', 9, 11)];
    // 128/255 = -6 dB under every line: no line is louder than the tab's usual, so none is
    // played louder, but the whole tab's music goes down 7 dB.
    const loud = subs();
    assert.equal(api.musicLevelDb(loud, music(12, 128), 20), -7);
    assert.equal(api.boostVoicesOverMusic(loud, music(12, 128), 20), 0);
    assert.equal(api.musicLevelDb(subs(), music(12, 255), 20), -8, 'capped at 8 dB');
    assert.equal(api.musicLevelDb(subs(), music(12, 32), 20), 0, 'quiet music (-18 dB) is left alone');
    assert.equal(api.musicLevelDb(subs(), music(12, 58), 20), 0, '-12.9 dB: under 1 dB to take off, left alone');
    assert.equal(api.musicLevelDb(subs().slice(0, 2), music(12, 255), 20), 0, 'too few voiced lines to tell');
  });

  test('the tab level reaches the series step, the open tab, the preview and both exports', () => {
    const iso = src.slice(src.indexOf('      async function boostVoicesOverMusicAllTabs() {'), src.indexOf('      async function blurTextStep() {'));
    assert.match(iso, /music\.levelDb = levelDb/);
    assert.match(iso, /bgmTrack\.levelDb = music\.levelDb/, 'the open tab saves its own copy back over the project');
    assert.equal((src.match(/volume: bgmPlayVolume\(\{ \.\.\.projBgmTrack/g) || []).length, 2, 'both export snapshots');
    assert.doesNotMatch(src, /bgmAudio\.volume = bgmTrack\.volume|\(bgmTrack\.volume \?\? 0\.5\) \* fadeMult/, 'every playback path');
    const bgmPlayVolume = new Function(`${src.slice(src.indexOf('    function bgmPlayVolume(track) {'), src.indexOf('    let globalSubtitleItalic'))}; return bgmPlayVolume;`)();
    assert.equal(bgmPlayVolume({ volume: 0.5 }), 0.5);
    assert.ok(Math.abs(bgmPlayVolume({ volume: 0.5, levelDb: -6 }) - 0.2506) < 0.001);
  });
});

describe('every subtitle on screen has a voice', () => {
  // On screen: 0-1.5 (has a line), 3-4.2 (no line), 6-6.8 (a sign), 9-10 (has a line, not matched).
  const shown = [{ start: 0, end: 1.5, text: '我们走吧' }, { start: 3, end: 4.2, text: '几点出发' }, { start: 6, end: 6.8, text: '中国银行' }, { start: 9, end: 10, text: '好的' }];
  const tabOf = () => ({
    duration: 60, videoFilePath: 'C:/v/ep_part01.mp4', textBlur: { lines: shown },
    subtitles: [
      { ...line('a', 0, 1.5, 0), audioStatus: 'idle', text: 'ទៅ', originalText: '我们走吧', gender: 'Female', character: 'Female', screenMatched: true, screenLen: '1.5' },
      { ...line('b', 9.2, 10.4, 0), audioStatus: 'idle', text: 'បាទ', originalText: 'ok', gender: 'Male', character: 'Male' },
    ],
  });

  test('a subtitle with no line gets one on its exact times, voiced by who Gemini says; a sign is skipped', async () => {
    const { env, api } = makeEnv({
      condense: () => [],
      missing: (lines) => lines.filter((l) => l.onScreen === '几点出发').map((l) => ({ id: l.id, text: 'ចេញម៉ោងប៉ុន្មាន?', gender: 'Female', emotion: 'Excited' })),
    });
    const tab = tabOf();
    api.setProjects([tab]);
    const r = await api.fillMissingScreenLinesAllTabs();
    assert.deepEqual(r, { added: 1, missing: 2 });
    const req = env.requests.find((b) => b.lines);
    assert.deepEqual(req.lines.map((l) => l.onScreen), ['几点出发', '中国银行'], 'the line under the unmatched transcribed line is not asked about');
    assert.deepEqual(req.lines[0].before.map((b) => [b.onScreen, b.line, b.gender]), [['我们走吧', 'ទៅ', 'Female']]);
    assert.equal(req.sourceFilePath, 'C:/v/ep_part01.mp4', "the series' character sheet");
    const added = tab.subtitles.find((s) => s.fromScreen);
    assert.deepEqual([added.text, added.textStart, added.screenLen, added.gender, added.emotion, added.audioStatus, added.screenMatched, added.originalText],
      ['ចេញម៉ោងប៉ុន្មាន?', '3.00', '1.200', 'Female', 'Excited', 'idle', true, '几点出发']);
    assert.deepEqual(tab.subtitles.map((s) => s.textStart), ['0', '3.00', '9.2'], 'in time order');
    assert.equal(added.voiceRoom, '6.10', 'its voice may run on to shortly before the next line');
  });

  test('nothing missing, or no Gemini key: nothing asked, nothing changes', async () => {
    const full = makeEnv({ condense: () => [] });
    const tab = tabOf();
    tab.textBlur.lines = shown.slice(0, 1);
    full.api.setProjects([tab]);
    assert.deepEqual(await full.api.fillMissingScreenLinesAllTabs(), { added: 0, missing: 0 });
    assert.equal(full.env.requests.length, 0);
    const nokey = makeEnv({ condense: () => [], keys: [] });
    const t2 = tabOf();
    nokey.api.setProjects([t2]);
    assert.deepEqual(await nokey.api.fillMissingScreenLinesAllTabs(), { added: 0, missing: 2 });
    assert.equal(t2.subtitles.length, 2);
  });

  test('Dub Whole Series gives the missed subtitles a line in the Match step, before voices; Stop cancels it', () => {
    const match = src.slice(src.indexOf('      async function matchStep() {'), src.indexOf('      async function generateStep() {'));
    assert.match(match, /await fillMissingScreenLinesAllTabs\(\{\s*checkStop,/);
    assert.match(src, /if \(seriesRun\.step === "generate" \|\| seriesRun\.step === "match"\) cancelFastCondenseRequests\(\);/);
    assert.match(src, /window\.ScreenSync\.matchLeftovers\(items, proj\.textBlur\.lines, matches\);/, 'Match pairs drifted lines again');
  });
});

// VoxCPM2 says Khmer slower than Edge (9 letters a second, not 12): a third of its lines overran
// and were played faster. Before a tab is voiced with it, the clearly rushed lines get the free time
// after them, then Gemini shortens them; each line is voiced once.
describe('VoxCPM2: rushed lines shortened before voicing', () => {
  const TEXT = 'ខ្ញុំមិនដឹងថាត្រូវធ្វើយ៉ាងម៉េចទៀតទេ';
  const letters = KhmerSpeech.normalizeForSpeech(TEXT).replace(/[\p{M}\s​-‍]/gu, '').length; // as said
  const slot = letters / 12 / 1.1; // Edge: 1.1x, not rushed; VoxCPM2: ~1.47x
  const todo = (id, start, end, text = TEXT) => ({ id, textStart: String(start), textEnd: String(end), audioStatus: 'idle', speed: 1, text });

  test('a line too long for VoxCPM2 (fine for Edge) is shortened before it is voiced, once', async () => {
    const { env, api } = makeEnv({ condense: (subs) => subs.map((s) => ({ id: s.id, condensedText: 'ខ្ញុំមិនដឹងទេ' })) });
    const a = todo('a', 0, slot);
    const tab = { duration: 60, subtitles: [a, todo('b', slot, slot + 3, 'ទៅ')] };
    api.setProjects([tab]);
    assert.ok(api.analyzeSubPace(a).effectiveSpeed < 1.15, 'Edge pace: not rushed');
    assert.equal(await api.shortenForVoxCpm2(tab, ['a', 'b']), 1);
    assert.equal(a.text, 'ខ្ញុំមិនដឹងទេ');
    assert.equal(a._voxShortened, true);
    assert.equal(env.requests.length, 1);
    assert.ok(env.requests[0].subtitles[0].speed > 1.4, `Gemini is told VoxCPM2's speed-up (${env.requests[0].subtitles[0].speed})`);
    assert.equal(await api.shortenForVoxCpm2(tab, ['a', 'b']), 0, 'not shortened again');
    assert.equal(env.requests.length, 1);
    // After voicing, the series' Fix Rushed Lines leaves it alone, even if still fast.
    Object.assign(a, { audioStatus: 'ready', file: 'x.mp3', baseAudioDuration: slot * 1.6, audioStart: '0' });
    a.text = TEXT;
    assert.equal((await api.fitFastLinesAllTabs()).rushed, 0);
  });

  test('free time after the line is used first; a line that then fits is not rewritten', async () => {
    const { env, api } = makeEnv({ condense: () => { throw new Error('not asked'); } });
    const a = todo('a', 0, slot);
    const tab = { duration: 60, subtitles: [a, todo('b', 10, 12, 'ទៅ')] };
    api.setProjects([tab]);
    assert.equal(await api.shortenForVoxCpm2(tab, ['a']), 0);
    assert.equal(env.requests.length, 0);
    assert.ok(parseFloat(a.textEnd) > slot, 'its end moved into the free time');
    assert.equal(a.text, TEXT);
  });

  test('a longer answer, a voiced line or a line not being voiced: kept as it is', async () => {
    const { env, api } = makeEnv({ condense: (subs) => subs.map((s) => ({ id: s.id, condensedText: `${s.text} ទៀត` })) });
    const a = todo('a', 0, slot);
    const done = { ...todo('c', slot, slot * 2), audioStatus: 'ready', file: 'x.mp3', baseAudioDuration: slot, audioStart: String(slot) };
    const other = todo('d', slot * 2, slot * 3);
    const tab = { duration: 60, subtitles: [a, done, other, todo('e', slot * 3, slot * 3 + 3, 'ទៅ')] };
    api.setProjects([tab]);
    assert.equal(await api.shortenForVoxCpm2(tab, ['a', 'c']), 0);
    assert.deepEqual(env.requests[0].subtitles.map((s) => s.id), ['a'], 'only the line about to be voiced');
    assert.equal(a.text, TEXT);
    assert.equal(other.text, TEXT);
  });

  test('both VoxCPM2 voicing paths shorten a whole tab first; lines picked by hand are said as written', () => {
    const main = src.replace(/\r\n/g, '\n');
    const gen = main.slice(main.indexOf('    async function generateStandardAudioForProject('));
    assert.match(gen, /if \(isVoxCmp2Enabled && \(isBatch \|\| !explicitIds \|\| explicitIds\.length >= targetProject\.subtitles\.length\)\) \{\n\s+try \{\n\s+await shortenForVoxCpm2\(targetProject, idsToProcess, \(\) => cancelRef\.cancelled\);/);
    assert.match(main, /if \(!proj\._selectedIds\) \{\n\s+try \{\n\s+await shortenForVoxCpm2\(proj, pendingSubs\.map\(\(s\) => s\.id\), \(\) => cancelRef\.cancelled\);/);
  });
});
