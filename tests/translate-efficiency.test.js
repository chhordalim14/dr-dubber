// Translate: fewer tokens (little thinking, the fixed rules as a cacheable system instruction),
// the same names and forms of address in every batch and episode (character sheet), and lines
// sized to the time they have (the overlong check before the app's timing fix).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    buildTranslateSystemPrompt, buildTranslateUserPrompt, buildTranslatePrompt,
    parseSrtBlocksForTranslate, estimateSpeechSeconds, findOverlongLines
} = require('../backend/lib/khmer-prompts');
const {
    normalizeSheet, mergeSheets, applyGlossaryToSheet, formatSheetForPrompt, buildCharacterSheetPrompt,
    loadSeriesSheet, saveSeriesSheet, withSeriesLock
} = require('../backend/lib/character-sheet');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

// geminiThinkingConfig / addTokenUsage lifted out of server.js (requiring it starts the backend).
function liftServer() {
    const start = serverSource.indexOf('const geminiNoThinkingConfigModels');
    const end = serverSource.indexOf('// The first JSON array/object in a model');
    return new Function(`${serverSource.slice(start, end)}; return { geminiThinkingConfig, createTokenUsage, addTokenUsage, formatTokenUsage };`)();
}

describe('low thinking for text jobs', () => {
    const { geminiThinkingConfig } = liftServer();
    test('Gemini 3 by level, 2.5 by budget, older or unknown models get nothing', () => {
        assert.deepEqual(geminiThinkingConfig('gemini-3.8-flash', 'low'), { thinkingLevel: 'low' });
        assert.deepEqual(geminiThinkingConfig('gemini-3.1-pro-preview', 'low'), { thinkingLevel: 'low' });
        assert.deepEqual(geminiThinkingConfig('gemini-2.5-flash', 'low'), { thinkingBudget: 0 });
        assert.deepEqual(geminiThinkingConfig('gemini-2.5-flash-lite', 'low'), { thinkingBudget: 0 });
        assert.deepEqual(geminiThinkingConfig('gemini-2.5-pro', 'low'), { thinkingBudget: 128 }, '2.5 Pro cannot turn thinking off');
        assert.equal(geminiThinkingConfig('gemini-2.0-flash', 'low'), null);
        assert.equal(geminiThinkingConfig('gemini-3.5-transcribe', 'low'), null);
        assert.equal(geminiThinkingConfig('gemini-3.8-flash', null), null, 'audio jobs ask for nothing');
    });

    test('translate, re-translate, shorten and the sheet ask for it; a model that refuses is asked again without', () => {
        assert.equal((serverSource.match(/, thinking: 'low' \}\)/g) || []).length, 4);
        assert.match(serverSource, /geminiNoThinkingConfigModels\.add\(m\)/);
    });
});

describe('Direct transcription: low thinking first, full thinking when the reply looks wrong', () => {
    const start = serverSource.indexOf('function looksIncomplete(');
    const looksIncomplete = new Function(`${serverSource.slice(start, serverSource.indexOf('\n}\n', start) + 3)} return looksIncomplete;`)();

    test('a cut-off reply, or under one line a minute in a clip over 90 s, is asked again', () => {
        assert.equal(looksIncomplete(new Array(50), 540, true), true, 'cut off');
        assert.equal(looksIncomplete(new Array(8), 540, false), true, '8 lines in 9 minutes');
        assert.equal(looksIncomplete(new Array(9), 540, false), false);
        assert.equal(looksIncomplete([], 60, false), false, 'a short clip may be all music');
    });

    test('the first try asks for low thinking, the second for normal thinking, and the better answer is kept', () => {
        assert.match(serverSource, /const thinking = attempt === 0 \? 'low' : null;/);
        assert.match(serverSource, /executeGeminiGenerate\(apiKey, model, payload, signal, \{ stayOnModel, timeoutMs, thinking \}\)/);
        assert.match(serverSource, /if \(lowAnswer && items\.length < lowAnswer\.items\.length && !\(lowAnswer\.truncated && !truncated\)\) return lowAnswer;/);
        assert.match(serverSource, /usage: promptOpts\.usage,\n\s+repair,/);
    });
});

describe('token use is counted', () => {
    const { createTokenUsage, addTokenUsage, formatTokenUsage } = liftServer();
    test('Gemini usageMetadata and CodeCraft usage add up', () => {
        const u = createTokenUsage();
        addTokenUsage(u, { success: true, json: { usageMetadata: { promptTokenCount: 5000, cachedContentTokenCount: 3000, candidatesTokenCount: 2000, thoughtsTokenCount: 100 } } });
        addTokenUsage(u, { success: true, json: {}, usage: { prompt_tokens: 1000, completion_tokens: 600, completion_tokens_details: { reasoning_tokens: 100 } } });
        addTokenUsage(u, { success: false });
        assert.deepEqual(u, { requests: 2, input: 6000, cached: 3000, output: 2500, thinking: 200 });
        assert.equal(formatTokenUsage(u), '2 request(s), input 6.0k (3.0k cached), output 2.5k + 200 thinking tokens');
    });
});

describe('translate prompt in a fixed and a per-batch part', () => {
    test('the rules are in the system part only, the lines in the user part only', () => {
        const sys = buildTranslateSystemPrompt({ genreGuidance: '\nREGISTER - X' });
        const user = buildTranslateUserPrompt({ lines: [{ i: 0, text: '你好' }], glossaryHint: '', sheetHint: '', previousLines: [] });
        assert.match(sys, /FORMS OF ADDRESS/);
        assert.match(sys, /REGISTER - X/);
        assert.ok(!sys.includes('LINES TO TRANSLATE'));
        assert.ok(!user.includes('FORMS OF ADDRESS'));
        assert.match(user, /^LINES TO TRANSLATE:\n\[\{"i":0,"text":"你好"\}\]$/);
        assert.equal(buildTranslatePrompt({ lines: [], genreGuidance: '', previousLines: [] }), `${buildTranslateSystemPrompt({ genreGuidance: '' })}\n\n${buildTranslateUserPrompt({ lines: [], previousLines: [] })}`);
    });

    test('a line not translated yet is still given as context (its original only)', () => {
        const user = buildTranslateUserPrompt({
            lines: [], previousLines: [{ source: '你去哪？', text: 'បងទៅណា?', gender: 'Female' }, { source: '回家。', gender: 'Male' }]
        });
        assert.match(user, /- \[Female\] 你去哪？ => បងទៅណា\?\n- \[Male\] 回家。\n/);
    });

    test('the endpoint sends the system part as systemInstruction, the sheet with every batch', () => {
        assert.match(serverSource, /systemInstruction,\n\s+contents: \[\{\n\s+role: 'user',\n\s+parts: \[\{ text: buildTranslateUserPrompt\(\{/);
        assert.match(serverSource, /glossaryHint, sheetHint, previousLines\n/);
        assert.match(serverSource, /const TRANSLATE_BATCH_SIZE = 120;/);
    });
});

describe('character sheet', () => {
    const raw = {
        characters: [
            { name: '林峰', khmer: 'លីន ហ្វេង', gender: 'Male', role: 'prince' },
            { name: '林峰', khmer: 'លីនហ្វុង', gender: 'Male' },
            { name: '苏晴', khmer: 'Su Qing', gender: 'Female' },
            { name: '苏晴', khmer: 'ស៊ូ ឈីង', gender: 'girl' }
        ],
        address: [
            { speaker: '林峰', listener: '苏晴', calls: 'អូន', self: 'បង' },
            { speaker: '林峰', listener: '林峰', calls: 'បង', self: 'បង' },
            { speaker: '苏晴', listener: '林峰', calls: 'you', self: 'me' }
        ],
        terms: [{ original: '天剑门', khmer: 'និកាយដាវស្ថានសួគ៌' }, { original: '林峰', khmer: 'លីន' }]
    };

    test('a model answer is cleaned: Khmer only, no duplicates, no self-address, names are not terms', () => {
        const s = normalizeSheet(raw);
        assert.deepEqual(s.characters, [
            { name: '林峰', khmer: 'លីន ហ្វេង', gender: 'Male', role: 'prince' },
            { name: '苏晴', khmer: 'ស៊ូ ឈីង', gender: 'Unknown' }
        ]);
        assert.deepEqual(s.address, [{ speaker: '林峰', listener: '苏晴', calls: 'អូន', self: 'បង' }]);
        assert.deepEqual(s.terms, [{ original: '天剑门', khmer: 'និកាយដាវស្ថានសួគ៌' }]);
        assert.deepEqual(normalizeSheet(null), { characters: [], address: [], terms: [] });
    });

    test('earlier episodes win, new entries are added', () => {
        const known = normalizeSheet(raw);
        const merged = mergeSheets(known, {
            characters: [{ name: '林峰', khmer: 'លីនហ្វុង', gender: 'Male' }, { name: '王妃', khmer: 'ព្រះនាង', gender: 'Female' }],
            address: [{ speaker: '林峰', listener: '苏晴', calls: 'នាង', self: 'យើង' }, { speaker: '苏晴', listener: '林峰', calls: 'បង', self: 'អូន' }],
            terms: []
        });
        assert.deepEqual(merged.characters.map(c => c.khmer), ['លីន ហ្វេង', 'ស៊ូ ឈីង', 'ព្រះនាង']);
        assert.deepEqual(merged.address.map(a => a.calls), ['អូន', 'បង']);
    });

    test('formatted compactly for the prompt; nothing when empty', () => {
        const text = formatSheetForPrompt(raw);
        assert.match(text, /CHARACTER SHEET/);
        assert.match(text, /- 林峰 = លីន ហ្វេង \(Male, prince\)/);
        assert.match(text, /- 林峰 -> 苏晴: អូន \/ បង/);
        assert.match(text, /- 天剑门 = និកាយដាវស្ថានសួគ៌/);
        assert.equal(formatSheetForPrompt({}), '');
    });

    test('the sheet prompt carries the dialogue, the Khmer already used and the known sheet', () => {
        const prompt = buildCharacterSheetPrompt({
            lines: [{ text: '林峰，你来了。', gender: 'Female', khmer: 'លីន ហ្វេង មកហើយ?' }, { text: '' }],
            known: raw
        });
        assert.match(prompt, /\[Female\] 林峰，你来了。 => លីន ហ្វេង មកហើយ\?/);
        assert.match(prompt, /ALREADY DECIDED in earlier episodes/);
        assert.match(prompt, /FORMS OF ADDRESS/);
    });

    test('a very long episode is cut to the dialogue budget', () => {
        const lines = Array.from({ length: 5000 }, (_, i) => ({ text: `第${i}句台词，很长很长很长` }));
        const prompt = buildCharacterSheetPrompt({ lines });
        assert.ok(prompt.length < 50000, String(prompt.length));
    });

    test('saved per folder: every episode in the folder reads the same sheet', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-'));
        try {
            const ep1 = path.join(dir, 'series', 'ep01.mp4');
            const ep2 = path.join(dir, 'series', 'ep02.mp4');
            const other = path.join(dir, 'other', 'ep01.mp4');
            assert.equal(saveSeriesSheet(path.join(dir, 'sheets'), ep1, raw), true);
            assert.deepEqual(loadSeriesSheet(path.join(dir, 'sheets'), ep2), normalizeSheet(raw));
            assert.equal(loadSeriesSheet(path.join(dir, 'sheets'), other), null);
            assert.equal(loadSeriesSheet(path.join(dir, 'sheets'), null), null);
            assert.equal(saveSeriesSheet(path.join(dir, 'sheets'), ep1, {}), false, 'an empty sheet is not saved');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the Character Glossary wins over the sheet (Dub Whole Series unifies names after each part)', () => {
        const fixed = applyGlossaryToSheet(raw, { 林峰: 'លីនហ្វឹង', 天剑门: 'និកាយដាវទេព', 不在: 'abc' });
        assert.equal(fixed.characters[0].khmer, 'លីនហ្វឹង');
        assert.equal(fixed.characters[1].khmer, 'ស៊ូ ឈីង');
        assert.equal(fixed.terms[0].khmer, 'និកាយដាវទេព');
        assert.equal(applyGlossaryToSheet(raw, [{ original: '苏晴', khmer: 'ស៊ូឈីង' }]).characters[1].khmer, 'ស៊ូឈីង');
        assert.equal(applyGlossaryToSheet(raw, [{ from: '苏晴', to: 'ស៊ូឆីង' }]).characters[1].khmer, 'ស៊ូឆីង');
        assert.deepEqual(applyGlossaryToSheet(raw, null), normalizeSheet(raw));
        assert.match(serverSource, /const known = saved && applyGlossaryToSheet\(saved, glossary\);/);
        assert.match(serverSource, /const seriesSheet = savedSheet && applyGlossaryToSheet\(savedSheet, glossary\);/);
    });

    test('episodes of one series take turns on the sheet', async () => {
        const order = [];
        const step = (name, ms) => withSeriesLock('/sheets', '/series/ep.mp4', async () => {
            order.push(`${name} start`);
            await new Promise(r => setTimeout(r, ms));
            order.push(`${name} end`);
        });
        await Promise.all([step('a', 20), step('b', 1), step('c', 1)]);
        assert.deepEqual(order, ['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
    });
});

describe('timeline fit', () => {
    test('speech time counts letters, not vowel signs or spaces', () => {
        assert.equal(estimateSpeechSeconds('ក ខ'), 2 / 12);
        assert.equal(estimateSpeechSeconds('កា'), 1 / 12, 'the vowel sign adds no time');
        assert.equal(estimateSpeechSeconds(''), 0);
    });

    const srt = [
        '1\n00:00:01,000 --> 00:00:02,000\n短',      // 1s, next line at 2.0: no free time
        '2\n00:00:02,000 --> 00:00:03,000\n短',      // 1s, next line at 6.0: ~3.95s of room
        '3\n00:00:06,000 --> 00:00:07,000\n短'       // last line: its own second only
    ].join('\n\n');
    const lines = parseSrtBlocksForTranslate(srt);
    const long = 'ក'.repeat(24);   // 2.0s at 12 letters a second
    const ok = 'ក'.repeat(14);     // ~1.17s: within 1.3x of a 1s slot

    test('only lines that would still be rushed after using the free time are flagged', () => {
        const flagged = findOverlongLines(lines, [long, long, ok]);
        assert.deepEqual(flagged, [{ i: 0, room: 1, speed: 2 }], 'line 2 has room until the next line, line 3 is within 1.3x');
    });

    test('small overruns and untranslated or untimed lines are left alone', () => {
        assert.deepEqual(findOverlongLines(lines, ['ក'.repeat(16), null, '']), [], 'a 0.33s overrun is not worth a rewrite');
        assert.deepEqual(findOverlongLines([{ text: 'x', start: null, seconds: null }], [long]), []);
    });

    test('always on: Translate and Direct transcription re-word only those lines, and keep a rewrite only when it is shorter', () => {
        assert.match(serverSource, /const overlong = findOverlongLines\(lines, texts\);/);
        assert.match(serverSource, /text\.length >= texts\[i\]\.length\) continue;/);
        assert.equal((serverSource.match(/await fitOverlongLines\(\{/g) || []).length, 2);
        assert.ok(!/fitTimeline/.test(serverSource), 'no off switch');
    });
});
