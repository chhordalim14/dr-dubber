// Khmer dubbing prompts from backend/lib/khmer-prompts.js. Each case is a contradiction or
// gap that made Gemini's Khmer lines come out rude, cut short, or the wrong length.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    KHMER_SYLLABLES_PER_SEC, KHMER_DUBBING_RULES, khmerMaxSyllables, secondsWithPause, lineSeconds,
    getKhmerDramaRegisterGuidance, parseSrtBlocksForTranslate, translatePromptLine, buildTranslatePrompt
} = require('../backend/lib/khmer-prompts');

// A Windows checkout has CRLF; the multi-line searches below are written with \n.
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'gemini.js'), 'utf8').replace(/\r\n/g, '\n');

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

    // Every example used to turn "you" into "បង", so a father talking to his son came out "បង".
    test('a parent calls the child កូន, and បង is not a default "you"', () => {
        assert.match(KHMER_DUBBING_RULES, /Parent -> child: calls them "កូន" \/ calls self "ប៉ា" \/ "ម៉ាក់"/);
        assert.match(KHMER_DUBBING_RULES, /Child -> parent:[^\n]*calls self "កូន"/);
        for (const pair of ['Grandparent -> grandchild', 'Uncle / aunt -> niece / nephew', 'Older sibling -> younger',
            'Parent-in-law ->', 'Pupil -> teacher', 'Disciple -> master', 'Servant / guard -> master', 'Same-age friends']) {
            assert.ok(KHMER_DUBBING_RULES.includes(pair), pair);
        }
        assert.match(KHMER_DUBBING_RULES, /"វា" ONLY for a child, an animal, a thing or in contempt/);
        assert.match(KHMER_DUBBING_RULES, /"បង" is NOT a default/);
        assert.match(KHMER_DUBBING_RULES, /she to him "បងទៅណា\?" \/ he to her "អូនទៅណា\?" \/ parent to child: "កូនទៅណា\?"/);
        assert.match(getKhmerDramaRegisterGuidance('modern'), /parent to child "កូនធ្វើអីហ្នឹង\?"/);
        assert.ok(!serverSource.includes('-> ✅ "បងធ្វើអីនៅនេះ?"\n'), 'refactor example still maps អ្នក to បង');
    });

    test('lovers never say ឯង to each other in the examples', () => {
        const modern = getKhmerDramaRegisterGuidance('modern');
        assert.ok(!modern.includes('ឯង'), 'modern register offers ឯង');
        assert.ok(!KHMER_DUBBING_RULES.includes('ខ្ញុំស្រឡាញ់ឯង'));
        assert.match(modern, /"បងស្រឡាញ់អូន" \/ "អូនស្រឡាញ់បង"/);
    });

    // E60: a man asking his lover "你怎么回来了?" came out "ម៉េចក៏បង..." - the examples only showed her side.
    test('a lover\'s "you" follows the speaker: she says បង, he says អូន', () => {
        assert.match(KHMER_DUBBING_RULES, /she says "បង" to him, he says "អូន" to her/);
        assert.match(KHMER_DUBBING_RULES, /"ម៉េចក៏អូនត្រឡប់មកវិញ\?"/);
        assert.match(KHMER_DUBBING_RULES, /she to him "បងធ្វើអីនៅនេះ\?" \/ he to her "អូនធ្វើអីនៅនេះ\?"/);
        assert.match(getKhmerDramaRegisterGuidance('modern'), /he to his lover "អូនធ្វើអីហ្នឹង\?"/);
        assert.match(getKhmerDramaRegisterGuidance('modern'), /he to her "អូនមិនអីទេ\?" \/ she to him "បងមិនអីទេ\?"/);
    });

    test('strict negative constraints forbid wrong spouse and parent/child address', () => {
        // Lovers / Spouses
        assert.match(KHMER_DUBBING_RULES, /Male speaker \(ប្រុស \/ Piseth\) speaking to his female partner/);
        assert.match(KHMER_DUBBING_RULES, /MUST call her: "អូន"/);
        assert.match(KHMER_DUBBING_RULES, /MUST call himself: "បង"/);
        assert.match(KHMER_DUBBING_RULES, /NEVER call her "បង" \(fatal error!\)/);
        assert.match(KHMER_DUBBING_RULES, /Female speaker \(ស្រី \/ Sreymom\) speaking to her male partner/);
        assert.match(KHMER_DUBBING_RULES, /MUST call him: "បង"/);
        assert.match(KHMER_DUBBING_RULES, /MUST call herself: "អូន"/);
        assert.match(KHMER_DUBBING_RULES, /NEVER call herself "បង" \(fatal error!\)/);

        // Family / Parent & Child
        assert.match(KHMER_DUBBING_RULES, /A parent NEVER calls their child "បង", "អូន", or "ឯង"/);
        assert.match(KHMER_DUBBING_RULES, /A child NEVER calls parents "បង", "អូន", "ឯង", "លោក", or "អ្នក"/);
    });

    test('TTS normalization standards: dictionary compliance, numbers in words, transliterations', () => {
        assert.match(KHMER_DUBBING_RULES, /KHMER TTS & PRONUNCIATION NORMALIZATION/);
        assert.match(KHMER_DUBBING_RULES, /Chuon Nath \/ NCKL/);
        assert.match(KHMER_DUBBING_RULES, /Numbers \(0-9 and ០-៩\) must be normalized into full Khmer words/);
        assert.match(KHMER_DUBBING_RULES, /Decimals: Spoken natural style with "ចុច"/);
        assert.match(KHMER_DUBBING_RULES, /Repetition mark ៗ: Expand to spoken repetition/);
        assert.match(KHMER_DUBBING_RULES, /Transliterate all English words and brand names/);
    });
});

describe('translate-srt keeps timing', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:03,000\r\n[Male] 你在干什么？\r\n\r\n'
        + '2\r\n00:00:03,500 --> 00:00:03,700\r\n嗯\r\n\r\n'
        + '3\r\nnot a time line\r\nskipped\r\n\r\n'
        + '4\r\n00:01:00,000 --> 00:01:05,500\r\n第一行\r\n第二行';

    // Chinese says a lot in few syllables: a budget from the line's own time alone left 57% of
    // lines fewer Khmer syllables than the Chinese had, so the budget counts the pause before
    // the next line too (up to 1 s), and "seconds" stays the line's own duration.
    test('parses start/end/seconds and a syllable budget per block, the pause before the next line included', () => {
        const lines = parseSrtBlocksForTranslate(srt);
        assert.equal(lines.length, 3);
        // 1-3 s, next line at 3.5 s: 2 s + 0.45 s pause = 2.45 s -> 11 syllables
        assert.deepEqual(lines[0], { text: '你在干什么？', gender: 'Male', start: 1, end: 3, seconds: 2, maxSyllables: 11 });
        // a 0.2 s blip with a long silence after it: at most 1 s of pause -> 1.2 s -> 5
        assert.equal(lines[1].maxSyllables, 5);
        // the last line: no next line known, no pause
        assert.deepEqual(lines[2], { text: '第一行\n第二行', gender: null, start: 60, end: 65.5, seconds: 5.5, maxSyllables: 25 });
    });

    test('a blip right before the next line still gets at least 2 syllables', () => {
        const lines = parseSrtBlocksForTranslate('1\n00:00:01,000 --> 00:00:01,200\n嗯\n\n2\n00:00:01,200 --> 00:00:02,000\n好');
        assert.equal(lines[0].maxSyllables, 2);
    });

    test('secondsWithPause adds the pause before the next line, at most 1 s, never a negative one', () => {
        assert.equal(secondsWithPause(1, 3, 3.5), 2.45);
        assert.equal(secondsWithPause(1, 3, 10), 3);
        assert.equal(secondsWithPause(1, 3, 2.5), 2, 'overlapping next line: no pause');
        assert.equal(secondsWithPause(1, 3, null), 2);
        assert.equal(secondsWithPause(1, 3, undefined), 2);
        assert.equal(secondsWithPause(3, 3, 5), null);
    });

    test('the prompt line carries seconds and maxSyllables only when timing is known', () => {
        const [first] = parseSrtBlocksForTranslate(srt);
        assert.deepEqual(translatePromptLine(4, first), { i: 4, text: '你在干什么？', seconds: 2, maxSyllables: 11, gender: 'Male' });
        assert.deepEqual(translatePromptLine(0, { text: 'x', seconds: null }), { i: 0, text: 'x' });
        const prompt = buildTranslatePrompt({ lines: [translatePromptLine(4, first)], glossaryHint: '', genreGuidance: '', previousLines: [] });
        assert.match(prompt, /"maxSyllables":11/);
        assert.match(prompt, /"maxSyllables" its Khmer syllable budget \(it already counts the short pause before the next line\)/);
        assert.match(prompt, /go a little over rather than drop what the line means/);
        assert.match(prompt, /never repeat a neighbouring line's Khmer/);
    });

    test('the reviews of Transcribe and Translate size lines with the pause too', () => {
        assert.match(serverSource, /seconds: secondsWithPause\(c\._start, c\._end, allCues\[i \+ 1\] \? allCues\[i \+ 1\]\._start : null\)/);
        assert.match(serverSource, /seconds: l\.seconds && secondsWithPause\(l\.start, l\.end, sourceLines\[i \+ 1\] \? sourceLines\[i \+ 1\]\.start : null\)/);
    });
});

// The user (a native Khmer reader) found many lines hard to follow: sayings translated word for
// word (久仰 as "long time no see", 各取所需 as "each go our own way"), facts cut to fit the time,
// pronouns stuck mid-sentence. Examples checked against the kheng.info dictionary.
describe('meaning first, natural Khmer sentences', () => {
    test('meaning comes before length, and length may run a little over to keep it', () => {
        assert.match(KHMER_DUBBING_RULES, /0\. MEANING FIRST - A KHMER VIEWER MUST UNDERSTAND EVERY LINE/);
        assert.match(KHMER_DUBBING_RULES, /\(1\) the line says what the speaker MEANS; \(2\) it sounds like natural spoken Khmer; \(3\) it fits the time/);
        assert.ok(KHMER_DUBBING_RULES.indexOf('0. MEANING FIRST') < KHMER_DUBBING_RULES.indexOf('1. LENGTH FITS THE TIME'));
        assert.match(KHMER_DUBBING_RULES, /may run a little over \(about 20%\)/);
        assert.match(KHMER_DUBBING_RULES, /every "not"/);
    });

    test('sayings and jokes are translated by meaning, with real examples', () => {
        assert.match(KHMER_DUBBING_RULES, /translate what they MEAN, never word for word/);
        assert.match(KHMER_DUBBING_RULES, /久仰[^\n]*"ឮឈ្មោះលោកយូរហើយ"/);
        assert.match(KHMER_DUBBING_RULES, /我们各取所需 -> "យើងម្នាក់បានម្យ៉ាង"/);
        assert.match(KHMER_DUBBING_RULES, /你属狐狸的？[^\n]*"នាងជាកញ្ជ្រោងមែនទេ\?"/);
        assert.match(KHMER_DUBBING_RULES, /测 = វាស់/);
    });

    test('drop clear pronouns, put a needed one first, and verb + object + បាន + how', () => {
        assert.match(KHMER_DUBBING_RULES, /3\. NATURAL KHMER SENTENCES/);
        assert.match(KHMER_DUBBING_RULES, /Drop "you" \/ "I" when the scene makes clear who is meant/);
        assert.match(KHMER_DUBBING_RULES, /"你捆柴挺快" -> "ចងអុសបានលឿនណាស់។"/);
        assert.match(KHMER_DUBBING_RULES, /❌ "ចងអុស អ្នកឯងលឿនណាស់"/);
        assert.match(KHMER_DUBBING_RULES, /\(who\) \+ verb \+ object \+ បាន \+ how/);
    });

    test('បាន after a verb is allowed; only the past-tense បាន before a verb is banned', () => {
        assert.match(KHMER_DUBBING_RULES, /"បាន" AFTER a verb \(can \/ manage to/);
        assert.match(KHMER_DUBBING_RULES, /BAN unnecessary past tense "បាន\.\.\." before a verb[^\n]*"បាន" after a verb \(rule 3\) is fine/);
    });

    test('final particles: តើ only at the end, never to open a question', () => {
        assert.match(KHMER_DUBBING_RULES, /"តើ" at the END = indeed \/ after all/);
        assert.match(KHMER_DUBBING_RULES, /BAN "តើ\.\.\." at the beginning of questions/);
    });

    test('the review looks for lines hard to understand and lines copied from a neighbour', () => {
        const { buildReviewSystemPrompt } = require('../backend/lib/khmer-prompts');
        const p = buildReviewSystemPrompt({ genreGuidance: '' });
        assert.match(p, /HARD TO UNDERSTAND/);
        assert.match(p, /COPIED LINE/);
        assert.match(p, /a clear meaning comes first/);
    });

    test('Transcribe and the timeline fit keep the meaning too', () => {
        assert.match(serverSource, /The meaning comes first \(rule 0\): when it cannot fit, a line may run a little over - never cut what it means/);
        assert.match(serverSource, /Never cut a word the sentence needs to make sense/);
    });

    test('rules are numbered 0 to 9 in order', () => {
        const nums = [...KHMER_DUBBING_RULES.matchAll(/^(\d)\. [A-Z]/gm)].map(m => Number(m[1]));
        assert.deepEqual(nums, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
        assert.match(serverSource, /maxSyllables: khmerMaxSyllables\(seconds\)/);
        assert.ok(!/0\.8 seconds/.test(serverSource));
    });
});

describe('Khmer review pass', () => {
    const { buildReviewSystemPrompt, buildReviewUserPrompt } = require('../backend/lib/khmer-prompts');

    test('checks meaning, forms of address and names with the dubbing rules, and returns only corrected lines', () => {
        const p = buildReviewSystemPrompt({ genreGuidance: getKhmerDramaRegisterGuidance('family') });
        assert.ok(p.includes(KHMER_DUBBING_RULES), 'same rules as translating, so a fix never breaks one');
        assert.match(p, /WRONG MEANING/);
        assert.match(p, /WRONG FORM OF ADDRESS/);
        assert.match(p, /WRONG NAME/);
        assert.match(p, /Do NOT rewrite a line that is already correct/);
        assert.match(p, /Return \[\] when every line is correct/);
        assert.match(p, /REGISTER - Family Drama/);
    });

    test('the batch carries the glossary, the character sheet and the lines before it', () => {
        const u = buildReviewUserPrompt({
            lines: [{ i: 4, source: '爸，我错了', khmer: 'បង ខ្ញុំខុសហើយ', gender: 'Male', seconds: 1.5, maxSyllables: 7 }],
            glossaryHint: '\n\nGLOSSARY X', sheetHint: '\n\nSHEET Y',
            previousLines: [{ source: '你去哪?', khmer: 'កូនទៅណា?', gender: 'Male' }]
        });
        assert.match(u, /GLOSSARY X/);
        assert.match(u, /SHEET Y/);
        assert.match(u, /PREVIOUS DIALOGUE[^\n]*do NOT output/);
        assert.match(u, /- \[Male\] 你去哪\? => កូនទៅណា\?/);
        assert.ok(u.includes('"i":4') && u.includes('"khmer":"បង ខ្ញុំខុសហើយ"'));
    });

    test('runs after Transcribe and Translate, before the timeline fit, and can be turned off', () => {
        for (const tag of ['Transcribe', 'Translate']) {
            const at = serverSource.indexOf(`usage: promptOpts.usage, tag: '${tag}'`) >= 0
                ? serverSource.indexOf(`usage: promptOpts.usage, tag: '${tag}'`)
                : serverSource.search(new RegExp(`usage, tag: '${tag}'\\s*\\}\\);\\s*\\}\\s*fitted`));
            assert.ok(at > 0, `${tag} reviews its lines`);
        }
        assert.equal((serverSource.match(/if \(review !== false\)/g) || []).length, 2);
        assert.ok(serverSource.indexOf('reviewed = await reviewKhmerLines') < serverSource.indexOf("const fitted = fitToTime === false"));
    });
});
