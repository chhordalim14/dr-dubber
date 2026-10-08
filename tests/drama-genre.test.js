// One saved drama genre for the whole app. The studio's genre button (studio-main.js) owns it;
// the DAI window's two genre dropdowns and Dub Whole Series show and change the same value.
// Before, the DAI dropdowns reset to Ancient/Royal on every start, so Dub Whole Series
// translated modern dramas with royal court words. These tests run the real code blocks.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const studioSrc = fs.readFileSync(path.join(root, 'frontend', 'js', 'studio-main.js'), 'utf8');
const daiSrc = fs.readFileSync(path.join(root, 'frontend', 'js', 'dai-transcribe-studio.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');

const between = (src, startMark, endMark) => {
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark, a);
  assert.ok(a >= 0 && b > a, `block not found: ${startMark}`);
  return src.slice(a, b);
};

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

// Runs the studio's genre block (state, setter, button wiring) with a fake page.
const studioBlock = between(studioSrc, '    // --- DRAMA GENRE REGISTER STATE ---', '    // --- GEMINI AI TRANSCRIPTION LOGIC ---');
function loadStudio(saved) {
  const localStorage = fakeStorage(saved === undefined ? {} : { dr_dubber_drama_genre: saved });
  const events = [];
  const window = { dispatchEvent: (e) => events.push(e) };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const document = { getElementById: () => null, addEventListener: () => { } };
  const fn = new Function('localStorage', 'window', 'document', 'CustomEvent', 'showToast',
    `${studioBlock}\nreturn { get: () => activeDramaGenre, set: setDramaGenre, DRAMA_GENRES };`);
  const api = fn(localStorage, window, document, CustomEvent, () => { });
  return { api, window, localStorage, events };
}

// Runs the DAI window's genre helpers with fake dropdowns.
const daiBlock = between(daiSrc, '  // ── Drama genre', '  // ── end drama genre ──');
function loadDai(window, localStorage) {
  const selects = { 'dai-genre-select': { value: 'historical' }, 'dai-trans-genre-select': { value: 'historical' } };
  const $ = (id) => selects[id] || null;
  const fn = new Function('$', 'window', 'localStorage',
    `${daiBlock}\nreturn { getDramaGenre, setSharedDramaGenre, syncGenreSelects };`);
  return { dai: fn($, window, localStorage), selects };
}

describe('studio genre (the one saved value)', () => {
  test('defaults to historical only when nothing was ever saved', () => {
    assert.equal(loadStudio().api.get(), 'historical');
    assert.equal(loadStudio('modern').api.get(), 'modern');
    assert.equal(loadStudio('comedy').api.get(), 'comedy');
  });

  test('old or unknown values are mapped to a real genre', () => {
    assert.equal(loadStudio('neutral').api.get(), 'modern'); // the server gave neutral the modern register
    assert.equal(loadStudio('nonsense').api.get(), 'historical');
  });

  test('setting it saves it, exposes it on window and tells the other controls', () => {
    const { api, window, localStorage, events } = loadStudio('historical');
    events.length = 0;
    window.dramaGenre.set('modern');
    assert.equal(api.get(), 'modern');
    assert.equal(window.dramaGenre.get(), 'modern');
    assert.equal(localStorage.data.dr_dubber_drama_genre, 'modern');
    assert.deepEqual(events.map((e) => [e.type, e.detail.genre]), [['dr-drama-genre-change', 'modern']]);
  });
});

describe('DAI window genre dropdowns', () => {
  test('show the saved studio genre instead of their own Ancient/Royal default', () => {
    const studio = loadStudio('modern');
    const { dai, selects } = loadDai(studio.window, studio.localStorage);
    dai.syncGenreSelects();
    assert.equal(selects['dai-genre-select'].value, 'modern');
    assert.equal(selects['dai-trans-genre-select'].value, 'modern');
    assert.equal(dai.getDramaGenre(), 'modern');
  });

  test('changing one dropdown changes the studio genre and the other dropdown', () => {
    const studio = loadStudio('historical');
    const { dai, selects } = loadDai(studio.window, studio.localStorage);
    dai.setSharedDramaGenre('action');
    assert.equal(studio.api.get(), 'action');
    assert.equal(studio.localStorage.data.dr_dubber_drama_genre, 'action');
    assert.equal(selects['dai-genre-select'].value, 'action');
    assert.equal(selects['dai-trans-genre-select'].value, 'action');
  });

  test('without the studio it still reads and writes the saved value', () => {
    const localStorage = fakeStorage({ dr_dubber_drama_genre: 'comedy' });
    const { dai, selects } = loadDai({}, localStorage);
    assert.equal(dai.getDramaGenre(), 'comedy');
    dai.setSharedDramaGenre('modern');
    assert.equal(localStorage.data.dr_dubber_drama_genre, 'modern');
    assert.equal(selects['dai-trans-genre-select'].value, 'modern');
  });

  test('Transcribe and Translate read the shared genre, not a dropdown', () => {
    assert.doesNotMatch(daiSrc, /\$\('dai-(trans-)?genre-select'\)\?\.value/);
    const startBatch = between(daiSrc, 'async function startBatch', 'const glossaryDict');
    assert.match(startBatch, /const genre = getDramaGenre\(\)/);
  });
});

describe('genre choices', () => {
  const optionValues = (id) => {
    const m = html.match(new RegExp(`<select id="${id}"[\\s\\S]*?</select>`));
    assert.ok(m, `select #${id} not found`);
    return [...m[0].matchAll(/<option value="([^"]+)"/g)].map((x) => x[1]);
  };

  test('every genre control offers exactly the same values', () => {
    const { DRAMA_GENRES } = loadStudio().api;
    const button = [...between(html, 'id="genre-dropdown-menu"', '</div>').matchAll(/data-genre="([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(button, DRAMA_GENRES);
    for (const id of ['dai-genre-select', 'dai-trans-genre-select', 'ds-genre']) {
      assert.deepEqual(optionValues(id), DRAMA_GENRES, id);
    }
  });
});
