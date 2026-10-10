// Khmer dubbing prompts from backend/lib/khmer-prompts.js. Each case is a contradiction or
// gap that made Gemini's Khmer lines come out rude, cut short, or the wrong length.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    KHMER_SYLLABLES_PER_SEC, KHMER_DUBBING_RULES, khmerMaxSyllables, lineSeconds,
    getKhmerDramaRegisterGuidance, parseSrtBlocksForTranslate, translatePromptLine, buildTranslatePrompt
} = require('../backend/lib/khmer-prompts');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');

describe('dubbing rules do not contradict each other', () => {
    test('"តើ" is banned at the start of questions and not offered as a particle', () => {
        assert.match(KHMER_DUBBING_RULES, /BAN "តើ\.\.\."/);
        const particles = KHMER_DUBBING_RULES.split('\n').find(l => l.includes('Localize Asian particles'));
        assert.ok(particles, 'particle rule present');
        assert.ok(!particles.includes('តើ'), particles);
    });

    test('no fixed 3-10 syllable cap and no "core punchline" summarizing', () => {
        for (const text of [KHMER_DUBBING_RULES, buildTranslatePrompt({ lines: [], glossaryHint: '', genreGuidance: '', previousLines: [] }), serverSource]) {
            assert.ok(!/strictly 3 to (6|7|10)/i.test(text));
            assert.ok(!/core punchline/i.test(text));
        }
    });

    test('length is sized to the line duration at the shared pace', () => {
        assert.equal(KHMER_SYLLABLES_PER_SEC, 4.5);
        assert.match(KHMER_DUBBING_RULES, /4 to 5 Khmer syllables per second of the line's duration/);
        assert.match(KHMER_DUBBING_RULES, /Never summarize content away, and never pad/);
    });
});

describe('forms of address', () => {
    test('section is present with the lover, polite, royal and rude rules', () => {
        assert.match(KHMER_DUBBING_RULES, /FORMS OF ADDRESS \(របៀបហៅគ្នា\)/);
        assert.match(KHMER_DUBBING_RULES, /calls himself "បង" and her "អូន"/);
        assert.match(KHMER_DUBBING_RULES, /"ខ្ញុំបាទ" \/ "នាងខ្ញុំ"/);
        assert.match(KHMER_DUBBING_RULES, /ONLY in a historical \/ palace register/);
        assert.match(KHMER_DUBBING_RULES, /"ឯង" \/ "អញ" \/ "ហ្អែង" ONLY for anger/);
        assert.match(KHMER_DUBBING_RULES, /for the whole scene/);
    });

    test('lovers never say ឯង to each other in the examples', () => {
        const modern = getKhmerDramaRegisterGuidance('modern');
        assert.ok(!modern.includes('ឯង'), 'modern register offers ឯង');
        assert.ok(!KHMER_DUBBING_RULES.includes('ខ្ញុំស្រឡាញ់ឯង'));
        assert.match(modern, /"បងស្រឡាញ់អូន" \/ "អូនស្រឡាញ់បង"/);
    });
});

describe('translate-srt keeps timing', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:03,000\r\n[Male] 你在干什么？\r\n\r\n'
        + '2\r\n00:00:03,500 --> 00:00:03,700\r\n嗯\r\n\r\n'
        + '3\r\nnot a time line\r\nskipped\r\n\r\n'
        + '4\r\n00:01:00,000 --> 00:01:05,500\r\n第一行\r\n第二行';

    test('parses start/end/seconds and a syllable budget per block', () => {
        const lines = parseSrtBlocksForTranslate(srt);
        assert.equal(lines.length, 3);
        assert.deepEqual(lines[0], { text: '你在干什么？', gender: 'Male', start: 1, end: 3, seconds: 2, maxSyllables: 9 });
        assert.equal(lines[1].maxSyllables, 2, 'a blip still gets at least 2 syllables');
        assert.deepEqual(lines[2], { text: '第一行\n第二行', gender: null, start: 60, end: 65.5, seconds: 5.5, maxSyllables: 25 });
    });

    test('the prompt line carries seconds and maxSyllables only when timing is known', () => {
        const [first] = parseSrtBlocksForTranslate(srt);
        assert.deepEqual(translatePromptLine(4, first), { i: 4, text: '你在干什么？', seconds: 2, maxSyllables: 9, gender: 'Male' });
        assert.deepEqual(translatePromptLine(0, { text: 'x', seconds: null }), { i: 0, text: 'x' });
        const prompt = buildTranslatePrompt({ lines: [translatePromptLine(4, first)], glossaryHint: '', genreGuidance: '', previousLines: [] });
        assert.match(prompt, /"maxSyllables":9/);
        assert.match(prompt, /"maxSyllables" its Khmer syllable budget/);
    });
});

describe('translate-srt keeps the voice heard by Transcribe', () => {
    // A text-only translation used to guess every line's gender again, so a line Transcribe
    // heard as a man (or the user set to Male) could come back Female and change voice.
    test('a role or gender tag becomes the line\'s known gender', () => {
        const srt = ['[Heroine] 你好', '[Villain:p1] 站住', '[female] 嗯', '没有标签']
            .map((t, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},900\n${t}`).join('\n\n');
        const lines = parseSrtBlocksForTranslate(srt);
        assert.deepEqual(lines.map((l) => l.gender), ['Female', 'Male', 'Female', null]);
        assert.deepEqual(lines.map((l) => l.text), ['你好', '站住', '嗯', '没有标签']);
    });

    test('the prompt tells the model to keep a given gender', () => {
        const prompt = buildTranslatePrompt({ lines: [], glossaryHint: '', genreGuidance: '', previousLines: [] });
        assert.match(prompt, /already has a "gender" was heard from the audio: output that same gender/);
    });

    test('the server overrides the model\'s guess for a tagged line', () => {
        assert.ok(serverSource.includes('results[i] = { ...item, text: clean, ...(sourceLines[i].gender && { gender: sourceLines[i].gender }) }'));
    });
});

describe('shared syllable budget', () => {
    test('khmerMaxSyllables rounds seconds * pace, min 2, null when unknown', () => {
        assert.equal(khmerMaxSyllables(1), 5);
        assert.equal(khmerMaxSyllables(2.26), 10);
        assert.equal(khmerMaxSyllables(0.2), 2);
        assert.equal(khmerMaxSyllables(0), null);
        assert.equal(khmerMaxSyllables(NaN), null);
    });

    test('lineSeconds reads a slot, editor textStart/textEnd, or start/end', () => {
        assert.equal(lineSeconds({ slotDuration: '1.8' }), 1.8);
        assert.equal(lineSeconds({ textStart: '12.50', textEnd: '15.00' }), 2.5);
        assert.equal(lineSeconds({ start: '00:00:01,000', end: '00:00:02,500' }), 1.5);
        assert.equal(lineSeconds({ text: 'no timing' }), null);
        assert.equal(lineSeconds({ start: 5, end: 4 }), null);
    });

    test('condense, rewrite and refactor use the shared budget and keep pronouns', () => {
        assert.ok(!/Remove redundant pronouns/i.test(serverSource));
        assert.match(serverSource, /Keep forms of address and pronouns \(បង, អូន, លោក, ព្រះអង្គ \.\.\.\) and names unchanged/);
        assert.ok(!/slot \* 3\.5/.test(serverSource));
        assert.match(serverSource, /maxSyllables: khmerMaxSyllables\(slot\)/);
        assert.ok(!/0\.8 seconds/.test(serverSource));
    });
});
