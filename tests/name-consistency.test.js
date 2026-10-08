// Tests for frontend/js/name-consistency.js - the logic behind the
// "Make names consistent" All Tabs action (same Khmer spelling for each
// character/place across every part of a movie).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const NC = require('../frontend/js/name-consistency.js');

// Part 1 and part 5 of one movie. "林峰" (Lin Feng) and "青云山" (Qingyun
// Mountain) got different Khmer spellings in each part.
const tabs = [
  {
    id: 'part1',
    lines: [
      { id: 'a1', originalText: '林峰，你来了。', text: 'លីនហ្វេង អ្នកមកហើយ។' },
      { id: 'a2', originalText: '林峰在哪里？', text: 'លីនហ្វេងនៅឯណា?' },
      { id: 'a3', originalText: '我们去青云山。', text: 'យើងទៅភ្នំឈីងយុន។' },
    ],
  },
  {
    id: 'part5',
    lines: [
      { id: 'b1', originalText: '林峰，快走！', text: 'លីនហ្វុង ទៅលឿន!' },
      { id: 'b2', originalText: '青云山很远。', text: 'ភ្នំឆីងយ៉ុន ឆ្ងាយណាស់។' },
      { id: 'b3', originalText: '林峰哥哥。', text: 'បងលីនហ្វេង។' },
      // Khmer mentions a spelling, but the original line does not contain the name.
      { id: 'b4', originalText: '他是谁？', text: 'លីនហ្វុង គឺជានរណា?' },
      { id: 'b5', originalText: '他走了。', text: 'គាត់ទៅហើយ។' },
    ],
  },
];

const extracted = NC.mergeExtracted([
  [{ original: '林峰', type: 'person', khmer: ['លីនហ្វេង', 'បងលីនហ្វេង'] }],
  [
    // Same name from another chunk: spellings are merged.
    { original: '林峰', type: 'person', khmer: ['លីនហ្វុង', 'ហ្វេងហ្វេងហ្វេង'] }, // last one never occurs (invented)
    { original: '青云山', type: 'place', khmer: ['ភ្នំឈីងយុន', 'ភ្នំឆីងយ៉ុន'] },
    { original: '王小明', type: 'person', khmer: ['វ៉ាងស្យាវមីង'] }, // not in any original line
  ],
]);

describe('mergeExtracted', () => {
  test('merges the same name from different chunks', () => {
    const lin = extracted.find((n) => n.original === '林峰');
    assert.deepEqual(lin.spellings.slice().sort(), ['បងលីនហ្វេង', 'លីនហ្វុង', 'លីនហ្វេង', 'ហ្វេងហ្វេងហ្វេង'].sort());
  });

  test('treats Latin names case-insensitively', () => {
    const merged = NC.mergeExtracted([[{ original: 'Lin Feng', khmer: ['A'] }], [{ original: 'lin feng', khmer: ['B'] }]]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].spellings, ['A', 'B']);
  });
});

describe('analyzeNames', () => {
  const names = NC.analyzeNames(tabs, extracted, null);
  const lin = names.find((n) => n.original === '林峰');
  const mountain = names.find((n) => n.original === '青云山');

  test('suggests the most-used spelling and flags the different one', () => {
    assert.equal(lin.suggested, 'លីនហ្វេង');
    assert.equal(lin.source, 'most-used');
    assert.deepEqual(lin.conflicting, ['លីនហ្វុង']);
  });

  test('drops spellings Gemini invented', () => {
    assert.ok(!lin.spellings.some((s) => s.khmer === 'ហ្វេងហ្វេងហ្វេង'));
  });

  test('does not flag a related form (name with an honorific)', () => {
    assert.ok(!lin.conflicting.includes('បងលីនហ្វេង'));
  });

  test('breaks a tie with the spelling that appears first in the movie', () => {
    assert.equal(mountain.suggested, 'ភ្នំឈីងយុន');
    assert.deepEqual(mountain.conflicting, ['ភ្នំឆីងយ៉ុន']);
  });

  test('skips names that never appear in the original text', () => {
    assert.ok(!names.some((n) => n.original === '王小明'));
  });

  test('prefers the Character Glossary spelling', () => {
    const withGlossary = NC.analyzeNames(tabs, extracted, [{ original: '青云山', khmer: 'ភ្នំឆីងយ៉ុន' }]);
    const m = withGlossary.find((n) => n.original === '青云山');
    assert.equal(m.suggested, 'ភ្នំឆីងយ៉ុន');
    assert.equal(m.source, 'glossary');
    assert.deepEqual(m.conflicting, ['ភ្នំឈីងយុន']);
  });

  test('lists inconsistent names first', () => {
    assert.ok(names[0].conflicting.length > 0);
  });
});

describe('planChanges', () => {
  const decisions = [
    { original: '林峰', use: 'លីនហ្វេង', replace: ['លីនហ្វុង', 'បងលីនហ្វេង'] },
    { original: '青云山', use: 'ភ្នំឈីងយុន', replace: ['ភ្នំឆីងយ៉ុន'] },
  ];
  const changes = NC.planChanges(tabs, decisions);
  const byId = Object.fromEntries(changes.map((c) => [c.lineId, c]));

  test('rewrites the other spellings to the chosen one, across tabs', () => {
    assert.equal(byId.b1.after, 'លីនហ្វេង ទៅលឿន!');
    assert.equal(byId.b2.after, 'ភ្នំឈីងយុន ឆ្ងាយណាស់។');
    assert.equal(byId.b1.tabId, 'part5');
  });

  test('only touches lines whose original text contains the name', () => {
    assert.equal(byId.b4, undefined);
  });

  test('never rewrites a related form or an already-correct line', () => {
    assert.equal(byId.b3, undefined);
    assert.equal(byId.a1, undefined);
  });

  test('changes exactly the expected lines', () => {
    assert.deepEqual(changes.map((c) => c.lineId).sort(), ['b1', 'b2']);
  });

  test('never rewrites a very short spelling', () => {
    const t = [{ id: 't', lines: [{ id: 'x', originalText: '林', text: 'ក ទៅ' }] }];
    assert.deepEqual(NC.planChanges(t, [{ original: '林', use: 'លីន', replace: ['ក'] }]), []);
  });

  test('never rewrites a spelling that is the chosen spelling of another name', () => {
    const t = [{ id: 't', lines: [{ id: 'x', originalText: '林峰和林枫', text: 'លីនហ្វុង និង លីនហ្វេង' }] }];
    const out = NC.planChanges(t, [
      { original: '林峰', use: 'លីនហ្វេង', replace: ['លីនហ្វុង'] },
      { original: '林枫', use: 'លីនហ្វុង', replace: [] },
    ]);
    assert.deepEqual(out, []);
  });
});

describe('replaceSpellings', () => {
  test('does not edit inside a protected spelling', () => {
    // "លីន" is a wrong spelling for one name but also part of "លីនហ្វេង".
    assert.equal(NC.replaceSpellings('លីនហ្វេង និង លីន', ['លីន'], 'លិន', ['លីនហ្វេង']), 'លីនហ្វេង និង លិន');
  });

  test('replaces in a single pass (no cascading replacements)', () => {
    assert.equal(NC.replaceSpellings('AB', ['A', 'B'], 'BA', []), 'BABA');
  });
});

describe('mergeIntoGlossary', () => {
  test('adds new names and updates existing ones', () => {
    const r = NC.mergeIntoGlossary(
      [{ original: '林峰', khmer: 'លីនហ្វុង' }, { original: '王爷', khmer: 'ព្រះអង្គម្ចាស់' }],
      [{ original: '林峰', khmer: 'លីនហ្វេង' }, { original: '青云山', khmer: 'ភ្នំឈីងយុន' }],
    );
    assert.equal(r.added, 1);
    assert.equal(r.updated, 1);
    assert.deepEqual(r.list, [
      { original: '林峰', khmer: 'លីនហ្វេង' },
      { original: '王爷', khmer: 'ព្រះអង្គម្ចាស់' },
      { original: '青云山', khmer: 'ភ្នំឈីងយុន' },
    ]);
  });
});
