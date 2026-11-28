// The Character Glossary is one list for every drama (2,117 names in a real install), and every
// request sent all of it as "STRICTLY USE": names from other dramas taught Gemini wrong spellings
// (苏苏 = ស៊ូស៊ូ, then the hero 沈奕 = ស៊ូស៊ូ too), and everyday words saved as names (小心 = សៀវស៊ីង)
// were forced into lines. Two people of one drama also ended up with one Khmer name.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { relevantGlossary, collectSourceText, isUsableGlossaryKey } = require('../backend/lib/glossary-filter');
const cs = require('../backend/lib/character-sheet');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'gemini.js'), 'utf8').replace(/\r\n/g, '\n');

// A drama's sheet as Transcribe saved it: the hero listed under two spellings, his uncle and a
// villain given names that belong to someone else.
const lieling = {
    characters: [
        { name: '沈弈', khmer: 'ស៊ូស៊ូ', gender: 'Male', aliases: ['沈兄弟', '小弈'], english: 'Shen Yi' },
        { name: '沈征', khmer: 'សិនជឹង', gender: 'Male', english: 'Shen Zheng' },
        { name: '沈鸿', khmer: 'ស៊ូស៊ូ', gender: 'Male', aliases: ['叔'], english: 'Shen Hong' },
        { name: '沈奕', khmer: 'ស៊ូស៊ូ', gender: 'Male', aliases: ['小奕', '小弈'], english: 'Shen Yi' },
        { name: '唐峻', khmer: 'ថាងជុន', gender: 'Male', english: 'Tang Jun' },
        { name: '唐总', khmer: 'ថាងជុន', gender: 'Male', english: 'Tang Jun' },
        { name: '左源', khmer: 'ស៊ូវ៉ាន់', gender: 'Male', english: 'Zuo Yuan' },
        { name: '苏远', khmer: 'ស៊ូវ៉ាន់', gender: 'Male', english: 'Su Yuan' }
    ],
    address: [
        { speaker: '唐峻', listener: '沈奕', calls: 'ស៊ូស៊ូ', self: 'ខ្ញុំ' },
        { speaker: '左源', listener: '沈奕', calls: 'លោកស៊ូស៊ូ', self: 'ខ្ញុំ' },
        { speaker: '沈奕', listener: '沈鸿', calls: 'ពូ', self: 'ក្មួយ' }
    ],
    terms: [{ original: '鬼见愁', khmer: 'ជ្រលងភ្នំមរណៈ' }]
};

describe('a request gets only the glossary names it can use', () => {
    const glossary = {
        '沈奕': 'ស៊ូស៊ូ', '左源': 'ស៊ូវ៉ាន់', '鬼见愁': 'ជ្រលងភ្នំមរណៈ', '唐瑛': 'ថាងយីង',
        '苏苏': 'ស៊ូស៊ូ', '傅宴洲': 'ភូយានឆឺ', // other dramas
        '小心': 'សៀវស៊ីង', '大哥': 'បងធំ', '见': 'ចៀនលីង', '沈': 'សិន' // everyday words, one character
    };

    test('names in the request\'s own text, and this drama\'s names; never other dramas\' names', () => {
        const g = relevantGlossary(glossary, { text: '唐瑛，你小心点。', sheet: lieling });
        assert.deepEqual(Object.keys(g).sort(), ['唐瑛', '左源', '沈奕', '鬼见愁'].sort());
    });

    test('before the dialogue is known (Transcribe), only this drama\'s names', () => {
        assert.deepEqual(Object.keys(relevantGlossary(glossary, { text: '', sheet: lieling })).sort(), ['左源', '沈奕', '鬼见愁'].sort());
        assert.equal(relevantGlossary(glossary, { text: '', sheet: null }), null, 'a new drama with no text yet: nothing');
    });

    test('single characters and everyday words are never sent', () => {
        assert.equal(isUsableGlossaryKey('小心'), false);
        assert.equal(isUsableGlossaryKey('大哥'), false);
        assert.equal(isUsableGlossaryKey('见'), false);
        assert.equal(isUsableGlossaryKey('沈'), false);
        assert.equal(isUsableGlossaryKey('沈奕'), true);
        assert.equal(isUsableGlossaryKey('VIP'), true);
        const g = relevantGlossary(glossary, { text: '小心！大哥，见了沈先生。' });
        assert.equal(g, null);
    });

    test('accepts the list form too ([{ original, khmer }] and the old { from, to })', () => {
        const g = relevantGlossary([{ original: '左源', khmer: 'ជួ យាន' }, { from: '唐瑛', to: 'ថាងយីង' }], { text: '左源和唐瑛' });
        assert.deepEqual(g, { '左源': 'ជួ យាន', '唐瑛': 'ថាងយីង' });
    });

    test('the request text comes from any dialogue field, never from keys, paths or audio', () => {
        const text = collectSourceText({
            srtText: '1\n00:00:01,000 --> 00:00:02,000\n左源来了',
            tabs: [{ lines: [{ originalText: '唐瑛' }] }],
            glossary: { '傅宴洲': 'x' }, apiKeys: ['沈奕'], sourceFilePath: 'C:/剧/沈奕.mp4', audioBase64: '苏苏'
        });
        assert.ok(text.includes('左源') && text.includes('唐瑛'));
        assert.ok(!text.includes('傅宴洲') && !text.includes('沈奕') && !text.includes('苏苏'));
    });

    test('the server narrows every request\'s glossary and keeps the full list for Transcribe', () => {
        assert.match(serverSource, /router\.use\(\(req, res, next\) => \{[\s\S]*?req\.fullGlossary = body\.glossary;\s*body\.glossary = relevantGlossary\(body\.glossary, \{ text: collectSourceText\(body\), sheet \}\);/);
        assert.match(serverSource, /const lineGlossary = req\.fullGlossary\s*\? relevantGlossary\(req\.fullGlossary, \{ text: allCues\.map\(c => c\.originalText \|\| ''\)\.join\('\\n'\), sheet: savedSheet \}\)/);
        assert.match(serverSource, /glossary: lineGlossary, glossaryHint: lineGlossaryHint, sheetHint/);
    });
});

describe('one person, one Khmer name', () => {
    test('a person listed under a spelling before their own name is still one entry', () => {
        const folded = cs.foldSheet(lieling);
        const shen = folded.characters.filter(c => c.english === 'Shen Yi');
        assert.equal(shen.length, 1);
        assert.equal(shen[0].name, '沈弈', 'the name listed first stays the name');
        assert.ok(shen[0].aliases.includes('沈奕'));
    });

    test('different people with one Khmer name are found; one person\'s spellings and shared titles are not', () => {
        const clashes = cs.findNameClashes(lieling);
        assert.deepEqual(clashes.map(c => [c.khmer, c.names.map(n => n.name)]), [
            ['ស៊ូស៊ូ', ['沈弈', '沈鸿']],
            ['ស៊ូវ៉ាន់', ['左源', '苏远']]
        ]);
        assert.equal(clashes[0].names[0].english, 'Shen Yi');
    });

    test('renaming a person in the glossary renames them in how others call them too', () => {
        const fixed = cs.applyGlossaryToSheet(lieling, { '沈弈': 'សិនអ៊ី', '沈奕': 'សិនអ៊ី', '沈鸿': 'សិនហុង', '左源': 'ជួ យាន' });
        assert.deepEqual(cs.findNameClashes(fixed), []);
        assert.equal(fixed.address.find(x => x.speaker === '唐峻').calls, 'សិនអ៊ី');
        assert.equal(fixed.address.find(x => x.speaker === '左源').calls, 'លោកសិនអ៊ី');
        assert.equal(fixed.address.find(x => x.listener === '沈鸿').calls, 'ពូ', 'nothing to rename');
    });

    test('the sheet builder is told to give every person their own name', () => {
        const p = cs.buildCharacterSheetPrompt({ lines: [{ text: '沈奕' }], known: null });
        assert.match(p, /Every person gets a Khmer name of their own: two different people never share one spelling/);
    });

    test('Transcribe and Translate tell the app about shared names', () => {
        assert.match(serverSource, /\.\.\.\(nameClashes\.length \? \{ nameClashes \} : \{\}\)/);
        assert.match(serverSource, /const nameClashes = seriesNameClashes\(sourceFilePath, req\.fullGlossary \|\| glossary\)/);
        const studio = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8');
        const dai = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'dai-transcribe-studio.js'), 'utf8');
        assert.match(studio, /window\.reportNameClashes = \(data\) =>/);
        assert.equal((studio.match(/window\.reportNameClashes\?\.\(genData\)/g) || []).length, 2);
        assert.equal((dai.match(/window\.reportNameClashes\?\.\(/g) || []).length, 2);
    });

    test('adding a name already in the glossary updates it instead of adding a second one', () => {
        const dai = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'dai-transcribe-studio.js'), 'utf8');
        assert.match(dai, /const same = state\.glossary\.filter\(\(g\) => String\(g\?\.original \?\? g\?\.from \?\? ''\)\.trim\(\) === original\);/);
    });
});
