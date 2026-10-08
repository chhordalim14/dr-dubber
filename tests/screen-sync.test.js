// frontend/js/screen-sync.js: pairing transcribed subtitles with the lines burned into the
// video (backend/python/text_detector.py output), so each subtitle shows while its line does.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const SS = require('../frontend/js/screen-sync.js');

// Real lines the detector found in a drama episode (E01, 1080x1924), times to the frame.
const LINES = [
    [0.0, 1.72, '怎么穿书到了古代末日'],
    [1.92, 3.32, '遇到了上古巨兽'],
    [5.92, 7.12, '空间灵兽'],
    [28.72, 30.48, '我穿进大乾风云了'],
    [31.64, 32.84, '还是兵部尚书府'],
    [32.84, 34.2, '不受宠的庶女'],
    [34.52, 36.44, '原主一家被皇帝下旨流放'],
    [37.2, 38.0, '不久'],
    [38.0, 39.48, '天灾骤然降至'],
    [39.48, 40.92, '末世来临'],
    [41.48, 43.48, '原主一家死在了流放路上'],
    [43.92, 44.88, '我去'],
    [44.88, 46.24, '还是个BE'],
    [46.24, 48.36, '看来明天开始得先囤货了'],
    [49.68, 50.76, '空间灵兽'],
    [50.76, 52.04, '还好有你'],
].map(([start, end, text]) => ({ start, end, text }));
const sub = (start, end, text) => ({ start, end, text });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

describe('matching subtitles to on-screen lines', () => {
    test('one subtitle per line, times guessed from the audio: each takes its line\'s exact times', () => {
        const subs = LINES.map((l, i) => sub(l.start + (i % 2 ? 0.6 : -0.45), l.end + (i % 3 ? -0.5 : 0.4), l.text));
        const m = SS.matchSubtitles(subs, LINES);
        m.forEach((r, i) => {
            assert.ok(r, `subtitle ${i} matched`);
            near(r.start, LINES[i].start, `start ${i}`);
            near(r.end, LINES[i].end, `end ${i}`);
            assert.equal(r.parts, null);
        });
    });

    test('the same words twice (空间灵兽 at 6s and 50s) go to the right one by time', () => {
        const m = SS.matchSubtitles([sub(5.5, 7.5, '空间灵兽'), sub(49.4, 51.0, '空间灵兽')], LINES);
        near(m[0].start, 5.92, 'first');
        near(m[1].start, 49.68, 'second');
    });

    test('a misread letter or different punctuation still matches', () => {
        const m = SS.matchSubtitles([sub(46.0, 48.0, '看來明天開始得先囤貨了！'), sub(43.8, 45.0, '我去。')], LINES);
        near(m[0].start, 46.24, 'traditional characters');
        near(m[1].start, 43.92, 'punctuation');
    });

    test('one subtitle over two screens: spans both, its text split by their lengths', () => {
        const m = SS.matchSubtitles([sub(31.2, 34.6, '还是兵部尚书府不受宠的庶女')], LINES);
        near(m[0].start, 31.64, 'start');
        near(m[0].end, 34.2, 'end');
        assert.equal(m[0].parts.length, 2);
        near(m[0].parts[0].start, 31.64, 'part 1 start');
        near(m[0].parts[0].end, 32.84, 'part 1 end');
        near(m[0].parts[1].start, 32.84, 'part 2 start');
        near(m[0].parts[0].share, 7 / 13, 'part 1 share');
    });

    test('two subtitles out of one screen line share its time, in order', () => {
        const m = SS.matchSubtitles([sub(34.3, 35.4, '原主一家'), sub(35.4, 36.9, '被皇帝下旨流放')], LINES);
        near(m[0].start, 34.52, 'first start');
        near(m[1].end, 36.44, 'second end');
        near(m[0].end, m[1].start, 'they meet');
        assert.ok(m[0].end > 34.52 && m[0].end < 36.44);
        near((m[0].end - 34.52) / (36.44 - 34.52), 4 / 11, 'split by letters');
    });

    test('speech without an on-screen line stays unmatched; a line without speech stays unused', () => {
        const m = SS.matchSubtitles([sub(10, 12, '旁白说了一句话'), sub(37.0, 38.2, '不久')], LINES);
        assert.equal(m[0], null);
        near(m[1].start, 37.2, 'matched one');
    });

    test('too far in time is not a match, even with the same words', () => {
        const m = SS.matchSubtitles([sub(12, 13, '空间灵兽')], LINES);
        assert.equal(m[0], null);
    });

    test('no original text (a subtitle typed by hand): matched by a clear overlap in time only', () => {
        const m = SS.matchSubtitles([sub(28.9, 30.3, ''), sub(55, 56, '')], LINES);
        near(m[0].start, 28.72, 'overlapping');
        assert.equal(m[1], null);
    });

    test('nothing to match with', () => {
        assert.deepEqual(SS.matchSubtitles([sub(1, 2, 'x')], []), [null]);
        assert.deepEqual(SS.matchSubtitles([], LINES), []);
    });

    test('unmatched subtitles move off their matched neighbours, or stay put if no room', () => {
        const placed = SS.placeUnmatched([
            { start: 1.0, end: 3.0, matched: true },
            { start: 2.5, end: 5.0, matched: false },
            { start: 4.8, end: 6.0, matched: true },
            { start: 5.5, end: 5.9, matched: false },
        ]);
        assert.deepEqual(placed[1], { start: 3.0, end: 4.8 });
        assert.deepEqual(placed[3], { start: 5.5, end: 5.9 }); // no room left: unchanged
    });
});

// frontend/js/subtitle-layout.js: what a matched subtitle shows over its on-screen lines.
const SL = require('../frontend/js/subtitle-layout.js');

describe('a subtitle shown over several on-screen lines', () => {
    const KM = 'យប់នេះវិមានមេទ័ពជប់លៀងភ្ញៀវ កូនត្រូវតែប្រយ័ត្នប្រយែង ឆាប់ទៅឆាប់មកវិញណា';

    test('its translation is split near the shares, at a space when one is close', () => {
        assert.deepEqual(SL.splitByShares(KM, [0.5, 0.5]), ['យប់នេះវិមានមេទ័ពជប់លៀងភ្ញៀវ', 'កូនត្រូវតែប្រយ័ត្នប្រយែង ឆាប់ទៅឆាប់មកវិញណា']);
        assert.equal(SL.splitByShares(KM, [0.3, 0.4, 0.3]).join(' '), KM);
    });

    test('Khmer without spaces breaks between words, never before a vowel sign', () => {
        const pieces = SL.splitByShares('បន្ទោសតែម៉ែខ្លួនឯង', [0.5, 0.5]);
        assert.equal(pieces.join(''), 'បន្ទោសតែម៉ែខ្លួនឯង');
        pieces.forEach((p) => assert.ok(!/^[឴-៓]/.test(p), p));
    });

    test('too short to split: null (shown whole)', () => {
        assert.equal(SL.splitByShares('ទេ', [0.5, 0.5]), null);
        assert.equal(SL.splitByShares(KM, [1]), null);
    });

    test('display cues follow the parts, and move with the subtitle', () => {
        const sub = { textStart: '10.00', textEnd: '14.00', text: KM, screenParts: [{ from: 0, to: 0.4, share: 0.4 }, { from: 0.4, to: 1, share: 0.6 }] };
        const cues = SL.displayCues(sub);
        assert.equal(cues.length, 2);
        assert.deepEqual([cues[0].start, cues[0].end, cues[1].start, cues[1].end], [10, 11.6, 11.6, 14]);
        assert.equal(cues.map((c) => c.text).join(' '), KM);
        const moved = SL.displayCues({ ...sub, textStart: '20.00', textEnd: '22.00' });
        assert.deepEqual([moved[0].start, moved[0].end, moved[1].end], [20, 20.8, 22]);
    });

    test('a subtitle kept up past the video\'s lines (its voice): the split stays on the line change, the last piece stays up', () => {
        const sub = { textStart: '10.00', textEnd: '16.00', screenLen: '4', text: KM, screenParts: [{ from: 0, to: 0.4, share: 0.4 }, { from: 0.4, to: 1, share: 0.6 }] };
        const cues = SL.displayCues(sub);
        assert.deepEqual([cues[0].start, cues[0].end, cues[1].start, cues[1].end], [10, 11.6, 11.6, 16]);
    });

    test('a plain subtitle shows itself; parts that cannot split show it whole', () => {
        assert.deepEqual(SL.displayCues({ textStart: '1.5', textEnd: '3', text: 'សួស្តី' }), [{ start: 1.5, end: 3, text: 'សួស្តី' }]);
        assert.deepEqual(SL.displayCues({ textStart: '1', textEnd: '3', text: 'ទេ', screenParts: [{ from: 0, to: 0.5, share: 0.5 }, { from: 0.5, to: 1, share: 0.5 }] }),
            [{ start: 1, end: 3, text: 'ទេ' }]);
    });
});
