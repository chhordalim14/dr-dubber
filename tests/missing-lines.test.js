// backend/lib/missing-lines.js: a subtitle on screen with no dubbed line gets one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildMissingLinesPrompt, checkMissingLine, MISSING_RESPONSE_SCHEMA } = require('../backend/lib/missing-lines');

test('the prompt gives each subtitle its text, length and the dubbed lines around it', () => {
  const p = buildMissingLinesPrompt({ items: [{ id: '0', onScreen: '她有律师函', seconds: 0.8, before: [{ onScreen: '怎么办', line: 'ធ្វើម៉េច', gender: 'Female' }], after: [] }] });
  const items = JSON.parse(p.slice(p.indexOf('ITEMS:') + 6, p.indexOf('OUTPUT FORMAT:')).trim());
  assert.deepEqual(items[0], { id: '0', onScreen: '她有律师函', seconds: 0.8, before: [{ onScreen: '怎么办', dubbed: 'ធ្វើម៉េច', gender: 'Female' }], after: [] });
});

test('Gemini does not decide whether a subtitle is voiced: every one gets a line', () => {
  // Asked that, it skipped "Carson下午的时间" (a man says it on screen) on one try and voiced it on the next.
  const p = buildMissingLinesPrompt({ items: [] });
  assert.match(p, /each one is spoken - give every one a line/);
  assert.deepEqual(MISSING_RESPONSE_SCHEMA.items.required, ['id', 'text', 'gender']);
  assert.equal(MISSING_RESPONSE_SCHEMA.items.properties.speech, undefined);
});

test('an answer with Khmer text and a gender is kept; anything else is not', () => {
  assert.deepEqual(checkMissingLine({ id: '3', text: ' តើពួកយើងចេញម៉ោងប៉ុន្មាន? ', gender: 'Female', emotion: 'Excited' }),
    { id: '3', text: 'តើពួកយើងចេញម៉ោងប៉ុន្មាន?', gender: 'Female', emotion: 'Excited' });
  assert.equal(checkMissingLine({ id: '1', text: 'អូ!', gender: 'Male', emotion: 'Bored' }).emotion, 'Neutral', 'unknown feeling: Neutral');
  assert.equal(checkMissingLine({ id: '1', text: '几点出发', gender: 'Male' }), null, 'not translated');
  assert.equal(checkMissingLine({ id: '1', text: 'អូ', gender: '' }), null, 'nobody to voice it');
  assert.equal(checkMissingLine(null), null);
});
