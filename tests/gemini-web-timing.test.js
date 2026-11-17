// Gemini Web Router line timing (backend/lib/gemini-web-timing.js retimeLines): each line takes
// the time of its own Chinese characters heard by the PC, and `coverage` (share of the heard
// speech the lines cover) decides whether a clip is asked again (< 0.75 in routes/gemini.js).
// A video that isn't Chinese has nothing to match: coverage must be "unknown" (null), not 0 -
// 0 made every clip of a Korean/Thai/English video go to the Gmails twice.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { retimeLines } = require('../backend/lib/gemini-web-timing');

// timeline: [char, start, end] for each Chinese character (or Latin word) the PC heard
const timeline = [['我', 1.0, 1.2], ['们', 1.2, 1.4], ['走', 1.4, 1.7], ['吧', 1.7, 1.9], ['好', 5.0, 5.3], ['的', 5.3, 5.5]];

test('Chinese lines take the PC times of their own characters, full coverage', () => {
    const out = retimeLines([
        { start: '00:03.00', end: '00:04.00', originalText: '我们走吧', text: 'x' },
        { start: '00:08.00', end: '00:09.00', originalText: '好的', text: 'y' }
    ], timeline);
    assert.equal(out[0].start, 1.0);
    assert.equal(out[0].end, 1.9);
    assert.equal(out[1].start, 5.0);
    assert.equal(out[0].timedBy, 'pc');
    assert.equal(out.coverage, 1);
});

test('a Chinese answer that skipped lines has low coverage (asked again)', () => {
    const out = retimeLines([{ start: 1, end: 2, originalText: '好的', text: 'y' }], timeline);
    assert.ok(out.coverage < 0.75, `coverage ${out.coverage}`);
});

test('a non-Chinese video: coverage is unknown (null), so the clip is not asked twice', () => {
    const korean = retimeLines([
        { start: '00:01.00', end: '00:02.00', originalText: '같이 가자', text: 'x' },
        { start: '00:05.00', end: '00:06.00', originalText: '좋아', text: 'y' }
    ], timeline); // the Chinese speech model still "hears" something in Korean audio
    assert.equal(korean.coverage, null);
    assert.equal(korean[0].start, 1);
    assert.equal(korean[0].timedBy, 'shifted');
});

test('no lines at all while the PC heard speech: coverage 0 (asked again)', () => {
    assert.equal(retimeLines([], timeline).coverage, 0);
});

test('the PC heard nothing: coverage 1 (nothing to ask again for)', () => {
    assert.equal(retimeLines([{ start: 1, end: 2, originalText: '好的' }], []).coverage, 1);
});
