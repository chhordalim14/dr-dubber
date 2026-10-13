// Khmer UI: frontend/js/i18n.js looks strings up in frontend/js/i18n-km.js, keyed by
// the English text. Checks the lookup (exact, {n} patterns, whitespace) without a DOM,
// and that every Khmer entry keeps its key's placeholders and tag markers, since a
// missing {0} drops a number from a message and a missing <0> drops a bold word.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', 'frontend', 'js');
const i18nSrc = fs.readFileSync(path.join(dir, 'i18n.js'), 'utf8');

// Runs i18n.js with a stub page; returns its window.I18N.
function load(dict, stored = 'km') {
  const dialogs = [];
  const window = {
    I18N_KM: dict,
    alert: (m) => dialogs.push(m),
    confirm: (m) => (dialogs.push(m), true),
    prompt: (m) => (dialogs.push(m), ''),
  };
  const context = {
    window,
    localStorage: { getItem: () => stored, setItem() {} },
    document: { readyState: 'loading', addEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    CustomEvent: class {},
  };
  vm.runInNewContext(i18nSrc, context);
  return { I18N: window.I18N, window, dialogs };
}

const DICT = {
  'Export SRT': 'នាំចេញ SRT',
  'Settings': 'ការកំណត់',
  'Preset "{0}" saved!': 'បានរក្សាទុកគំរូកំណត់ "{0}"!',
  'Applied to all {0} tab{1}!': 'បានអនុវត្តលើផ្ទាំងទាំង {0}!',
  'Drama Register set to: {0}': 'បានកំណត់ប្រភេទរឿង៖ {0}',
  'Comedy': 'កំប្លែង',
  '{0} ({1})': 'never used: no words outside placeholders',
};

test('exact strings translate, keeping surrounding whitespace', () => {
  const { I18N } = load(DICT);
  assert.equal(I18N.lang, 'km');
  assert.equal(I18N.t('Export SRT'), 'នាំចេញ SRT');
  assert.equal(I18N.t('\n    Settings  '), '\n    ការកំណត់  ');
  assert.equal(I18N.t('Export   SRT'), 'នាំចេញ SRT', 'inner whitespace is collapsed for the lookup');
});

test('unknown text, numbers and Khmer pass through unchanged', () => {
  const { I18N } = load(DICT);
  assert.equal(I18N.t('Something new'), 'Something new');
  assert.equal(I18N.t('42%'), '42%');
  assert.equal(I18N.t('បកប្រែរឿង'), 'បកប្រែរឿង');
  assert.ok(I18N.missing().includes('Something new'));
});

test('{n} keys match text built at runtime', () => {
  const { I18N } = load(DICT);
  assert.equal(I18N.t('Preset "Night Blue" saved!'), 'បានរក្សាទុកគំរូកំណត់ "Night Blue"!');
  assert.equal(I18N.t('Applied to all 3 tabs!'), 'បានអនុវត្តលើផ្ទាំងទាំង 3!', 'plural suffix dropped');
  assert.equal(I18N.t('Applied to all 1 tab!'), 'បានអនុវត្តលើផ្ទាំងទាំង 1!');
});

test('a captured value that is itself a key is translated', () => {
  const { I18N } = load(DICT);
  assert.equal(I18N.t('Drama Register set to: Comedy'), 'បានកំណត់ប្រភេទរឿង៖ កំប្លែង');
  assert.equal(I18N.t('Drama Register set to: Wuxia'), 'បានកំណត់ប្រភេទរឿង៖ Wuxia');
});

test('a key that is only placeholders never matches', () => {
  const { I18N } = load(DICT);
  assert.equal(I18N.t('Gemini (Flash)'), 'Gemini (Flash)');
});

test('English mode leaves everything as is', () => {
  const { I18N } = load(DICT, 'en');
  assert.equal(I18N.lang, 'en');
  assert.equal(I18N.t('Export SRT'), 'Export SRT');
});

test('alert / confirm / prompt messages are translated', () => {
  const { window, dialogs } = load(DICT);
  window.alert('Settings');
  assert.equal(window.confirm('Export SRT'), true);
  assert.deepEqual(dialogs, ['ការកំណត់', 'នាំចេញ SRT']);
});

test('i18n-km.js: every entry keeps its placeholders and tag markers', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'i18n-km.js'), 'utf8'), { window });
  const dict = window.I18N_KM;
  assert.ok(dict && Object.keys(dict).length > 1000, 'dictionary loaded');
  const markers = (s) => (s.match(/<\/?\d+\/?>/g) || []).sort();
  const holes = (s) => new Set(s.match(/\{\d+\}/g) || []);
  const problems = [];
  for (const [en, km] of Object.entries(dict)) {
    if (typeof km !== 'string' || !km.trim()) problems.push(`empty: ${en}`);
    else if (markers(en).join() !== markers(km).join()) problems.push(`markers: ${en}`);
    // A placeholder may only be dropped when it was an English plural ending ("tab{1}").
    else
      for (const h of holes(km)) if (!holes(en).has(h)) problems.push(`unknown ${h}: ${en}`);
  }
  assert.deepEqual(problems, []);
});
