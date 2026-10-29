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
        // Inside a matched line, with room after it: moved there (its length kept), not left overlapping.
        assert.deepEqual(placed[3], { start: 6.0, end: 6.4 });
    });

    test('an unmatched line its neighbours moved past goes into the room between them', () => {
        const placed = SS.placeUnmatched([
            { start: 7.0, end: 8.5, matched: true },
            { start: 10.0, end: 11.0, matched: false }, // its next neighbour was moved back to 9.8
            { start: 9.8, end: 12.0, matched: true },
        ]);
        const r = (v) => Math.round(v * 1000) / 1000;
        assert.deepEqual({ start: r(placed[1].start), end: r(placed[1].end) }, { start: 8.8, end: 9.8 }, 'its 1 s kept, ending where the next line starts');
        const noRoom = SS.placeUnmatched([
            { start: 1.0, end: 3.0, matched: true },
            { start: 2.0, end: 2.5, matched: false },
            { start: 3.1, end: 5.0, matched: true },
        ]);
        assert.deepEqual(noRoom[1], { start: 2.0, end: 2.5 }, 'only 0.1 s between the neighbours: unchanged');
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

describe('no subtitle without a line, no line late', () => {
    // On screen: four lines. Transcribed: the same four, the last two 6 s late (drift).
    const LINES4 = [[0, 1.5, '我们走吧'], [2, 3.5, '你先别上去'], [10, 11.5, '他是新郎'], [12, 13.5, '这个戒指']].map(([start, end, text]) => ({ start, end, text }));
    const DRIFTED = [[0, 1.5, '我们走吧'], [2, 3.5, '你先别上去'], [16, 17.5, '他是新郎'], [18, 19.5, '这个戒指']].map(([start, end, text]) => ({ start, end, text }));

    test('lines drifted past the first pass are paired again by their text - no delay', () => {
        const m = SS.matchSubtitles(DRIFTED, LINES4);
        assert.equal(m[2], null, 'more than 2.5 s off: the first pass leaves it');
        SS.matchLeftovers(DRIFTED, LINES4, m);
        assert.deepEqual(m.map((x) => x && x.start), [0, 2, 10, 12]);
    });

    test('the second pass never pairs by time alone, nor moves a line past its neighbours', () => {
        const other = DRIFTED.map((s, i) => (i === 2 ? { ...s, text: '完全不同的话' } : s));
        const m = SS.matchLeftovers(other, LINES4, SS.matchSubtitles(other, LINES4));
        assert.equal(m[2], null, 'other words: not paired');
        // A line whose text is on screen only before its matched neighbour stays where it is.
        const subs = [{ start: 20, end: 21, text: '我们走吧' }, { start: 2, end: 3.5, text: '你先别上去' }];
        const lines = [{ start: 0, end: 1.5, text: '我们走吧' }, { start: 2, end: 3.5, text: '你先别上去' }];
        const m2 = SS.matchLeftovers(subs, lines, SS.matchSubtitles(subs, lines));
        assert.equal(m2[0], null);
        assert.equal(m2[1].start, 2);
    });

    // A tab's on-screen lines every 3 s, with words that share letters (as dialogue does), and
    // Transcribe's times for them drifting 0 -> 15 s late over 4 minutes (measured: 0.6 -> 12 s).
    const WORDS = ['我们现在就走吧', '你先别上去了', '他才是新郎官', '这个戒指给你', '我不想再等了', '你到底想怎样', '今天的事别说', '我知道你想走',
        '这件事我想起来了', '不好意思是我误会', '那今晚我们一起', '你怕我做坏事吗', '老婆你真的爱我', '先自己休息一下', '我问问姑妈酒店', '那你打电话问问'];
    const SCREEN = Array.from({ length: 80 }, (_, k) => ({ start: k * 3, end: k * 3 + 2.4, text: `${WORDS[k % WORDS.length]}${k}` }));
    const drift = (t) => 15 * t / 240;
    const LATE = SCREEN.map((l) => ({ start: l.start + drift(l.start), end: l.end + drift(l.start), text: l.text }));

    test('a tab whose times drift 15 s: every line still finds its own on-screen line', () => {
        const old = SS.matchSubtitles(LATE, SCREEN);
        SS.matchLeftovers(LATE, SCREEN, old);
        assert.ok(old.filter((m, i) => m && m.start === SCREEN[i].start).length < 60, 'without following the drift many were lost');
        const m = SS.matchFollowingDrift(LATE, SCREEN);
        assert.deepEqual(m.map((x) => x && x.start), SCREEN.map((l) => l.start));
    });

    test('a jump (a part transcribed apart) is followed too', () => {
        const jumped = SCREEN.map((l) => (l.start >= 120 ? { ...l, start: l.start + 7, end: l.end + 7 } : l));
        assert.deepEqual(SS.matchFollowingDrift(jumped, SCREEN).map((x) => x && x.start), SCREEN.map((l) => l.start));
    });

    test('a line with nothing on screen is moved by the drift around it, not left at its late time', () => {
        const hidden = new Set([30, 31, 32, 50]);
        const shown = SCREEN.filter((_, k) => !hidden.has(k));
        const m = SS.matchFollowingDrift(LATE, shown);
        const times = SS.driftShifted(LATE, m);
        for (const k of hidden) {
            assert.equal(m[k], null);
            assert.ok(Math.abs(times[k].start - SCREEN[k].start) < 0.3, `line ${k}: ${times[k].start} for ${SCREEN[k].start} (was ${LATE[k].start})`);
        }
        assert.deepEqual(m.filter(Boolean).map((x) => x.start), shown.map((l) => l.start), 'the others: their own line');
    });

    test('nothing is paired by time alone however far it moves', () => {
        const other = LATE.map((s, k) => (k === 40 ? { ...s, text: '完全不同的一句话' } : s));
        assert.equal(SS.matchFollowingDrift(other, SCREEN)[40], null);
    });

    test('on-screen lines no subtitle covers: the ones to give a line', () => {
        const m = SS.matchSubtitles(DRIFTED.slice(0, 2), LINES4);
        assert.deepEqual(SS.uncoveredLines(LINES4, m).map((l) => l.text), ['他是新郎', '这个戒指']);
        assert.deepEqual(SS.uncoveredLines([...LINES4, { start: 20, end: 20.3, text: '啊' }], [...m, { start: 10, end: 14 }]).map((l) => l.text), [], 'too short to be a line: left');
    });

    test("only the video's subtitles - centred - not chat bubbles on a phone or signs", () => {
        const shown = [
            { start: 1, end: 2, text: '她有律师函', x: 40, w: 20.6 }, // a subtitle: 0.3% off the middle
            { start: 3, end: 4, text: '几点出发', x: 10, w: 16.6 }, // a chat bubble: 31.7% left
            { start: 5, end: 6, text: '中国', x: 70, w: 4 }, // a sign: 22% right
        ];
        assert.deepEqual(SS.uncoveredLines(shown, []).map((l) => l.text), ['她有律师函']);
    });
});
