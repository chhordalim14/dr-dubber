// backend/lib/split-lines.js: Gemini's split of a joined line is kept only when it has one part
// per pause, every part has Khmer, and the words were kept (not translated again).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSplitLinesPrompt, checkSplitLine } = require('../backend/lib/split-lines');

const item = { id: '0', line: 'អ្វីគេ? ថ្ម? មានជីវិត?', original: '什么东西? 石头? 活的?', parts: ['什么东西', '石头 活的'] };

test('a split with one part per pause, keeping the words, is taken', () => {
    assert.deepEqual(checkSplitLine({ id: '0', parts: [' អ្វីគេ? ', 'ថ្ម? មានជីវិត?'] }, item), ['អ្វីគេ?', 'ថ្ម? មានជីវិត?']);
});

test('the wrong number of parts, an empty or non-Khmer part, or a rewritten line is refused', () => {
    assert.equal(checkSplitLine({ id: '0', parts: ['អ្វីគេ? ថ្ម? មានជីវិត?'] }, item), null);
    assert.equal(checkSplitLine({ id: '0', parts: ['អ្វីគេ?', ''] }, item), null);
    assert.equal(checkSplitLine({ id: '0', parts: ['什么东西', 'ថ្ម? មានជីវិត?'] }, item), null);
    assert.equal(checkSplitLine({ id: '0', parts: ['អ្វី?', 'ថ្ម?'] }, item), null, 'much shorter: words left out');
    assert.equal(checkSplitLine({ id: '0', parts: ['អ្វីគេ? អ្វីគេនៅទីនេះទៅ?', 'ថ្ម? មានជីវិត? ពិតមែនឬ?'] }, item), null, 'much longer: translated again');
    assert.equal(checkSplitLine(null, item), null);
});

test('the prompt gives each line with its parts in order', () => {
    const p = buildSplitLinesPrompt({ items: [item] });
    assert.match(p, /"parts":\["什么东西","石头 活的"\]/);
    assert.match(p, /do not translate again/);
});
