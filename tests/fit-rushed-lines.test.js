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

// keys: the API keys in Settings. delayMs: how long each fake Gemini answer takes (to see
// requests overlap). env.maxParallel: most requests that were running at once.
function makeEnv({ condense, keys = ['k1'], delayMs = 0 }) {
  const env = {
    projects: [], activeProjectIndex: -1, subtitles: [], activeAudios: {}, duration: 0,
    requests: [], running: 0, maxParallel: 0, cancelled: [],
  };
  const factory = new Function('env', 'condense', 'keysJson', 'delayMs', 'KhmerSpeech', `
    let { projects, activeProjectIndex, subtitles, activeAudios, duration } = env;
    const saveCurrentProjectState = () => { }, renderSubtitles = () => { }, updateContextualControls = () => { };
    const showToast = () => { }, saveStateToPast = () => { }, saveProjectStateDirectly = () => { };
    const isSpeakableText = (t) => /[\\p{L}\\p{N}]/u.test(t || '');
    const targetLanguage = 'Khmer', activeDramaGenre = 'historical', getDramaGlossaryDict = () => null;
    const localStorage = { getItem: (k) => (k === 'aiDubberApiKeys' ? keysJson : null) };
    const document = { getElementById: () => null, querySelector: () => null };
    const CSS = { escape: (s) => s };
    const window = { KhmerSpeech };
    const fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (url.endsWith('/api/cancel-transcribe')) {
        env.cancelled.push(body.requestId);
        return { json: async () => ({ success: true }) };
      }
      env.requests.push(body);
      env.running++;
      env.maxParallel = Math.max(env.maxParallel, env.running);
      await new Promise((r) => setTimeout(r, delayMs));
      env.running--;
      return { json: async () => ({ success: true, results: condense(body.subtitles) }) };
    };
    ${voiceSlotSrc}
    ${fastBlock}
    return { fitFastLinesAllTabs, refitShortenedLinesAllTabs, analyzeSubPace, settleMatchedSubtitles, setProjects: (p) => { projects = p; }, setActive: (i, live) => { activeProjectIndex = i; subtitles = live; }, getLive: () => subtitles };
  `);
  return { env, api: factory(env, condense, JSON.stringify(keys), delayMs, KhmerSpeech) };
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
