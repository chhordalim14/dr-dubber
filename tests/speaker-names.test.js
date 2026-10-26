// One character, one voice through a series: the speaker names Transcribe gives, kept for the
// next episode, and titles several people share kept out of the names.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cs = require('../backend/lib/character-sheet');

const sheet = {
    characters: [
        { name: '韩峥', khmer: 'ហានចឹង', gender: 'Male' },
        { name: '韩子昂', khmer: 'ហានជឺអាំង', gender: 'Male' },
        { name: '韩总', khmer: 'លោកប្រធានហាន', gender: 'Male' },
        { name: '陈总', khmer: 'លោកប្រធានឆិន', gender: 'Male' },
    ],
    address: [{ speaker: '韩子昂', listener: '韩总', calls: 'លោកប្រធាន', self: 'ខ្ញុំ' }],
};

test('a surname with a title is left out of the sheet Gemini sees when it fits someone listed', () => {
    const text = cs.formatSheetForPrompt(sheet);
    assert.ok(!text.includes('韩总'), 'shared by 韩峥, 韩子昂 and their father');
    assert.match(text, /陈总 = លោកប្រធានឆិន/, 'the only 陈 stays');
});

test('the speaker names an episode used come back for the next episode of the same folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drd-speakers-'));
    const cues = [
        { speaker: '父亲', gender: 'Male' }, { speaker: '父亲', gender: 'Male' },
        { speaker: '韩峥', gender: 'Male' }, // on the sheet already
        { speaker: '?', gender: 'Female' }, { speaker: '韩总', gender: 'Male' },
        { speaker: '助理', gender: 'Female' },
    ];
    cs.addSeriesSpeakers(dir, 'C:/Drama/Series/E46.mp4', cues, sheet);
    const next = cs.loadSeriesSpeakers(dir, 'C:/Drama/Series/E47.mp4');
    assert.deepEqual(next.map((x) => x.name), ['父亲', '韩峥', '助理'], 'every name it used, once; no "?" or shared title');
    assert.match(cs.formatSpeakersForPrompt(next, sheet), /write exactly this name as "speaker" again:\n- 父亲 \(Male\)\n- 助理 \(Female\)$/,
        'the sheet lists its own names');
    assert.deepEqual(cs.loadSeriesSpeakers(dir, 'C:/Drama/Other/E01.mp4'), [], 'another series keeps its own');
    cs.addSeriesSpeakers(dir, 'C:/Drama/Series/E47.mp4', [{ speaker: '父亲', gender: 'Male' }], sheet);
    assert.equal(cs.loadSeriesSpeakers(dir, 'C:/Drama/Series/E48.mp4').length, 3, 'a name is kept once');
    assert.ok(cs.castDir(dir, 'C:/Drama/Series/E46.mp4').endsWith('.cast'), 'cast pictures beside the sheet');
});

// A man only called by a title both brothers share was named after the other brother; pictures of
// each person from earlier episodes go to Transcribe with the video, and frames of new speakers are
// kept after it.
test('Transcribe shows Gemini the cast pictures and keeps frames of the speakers it named', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(src, /const castParts = videoSource \? seriesCastParts\(castDir\(CHARACTER_SHEETS_DIR, sourceFilePath\), seriesSpeakers, seriesSheet\) : \[\];/);
    assert.match(src, /castParts: clipMime === 'video\/mp4' \? castParts : null/, 'only beside the video, not the sound-only gap check');
    assert.match(src, /\.\.\.\(\(promptOpts && promptOpts\.castParts\) \|\| \[\]\),\n\s+\{ inlineData: \{ mimeType, data: audioBase64 \} \}/);
    assert.match(src, /captureCastFrames\(\{ video: videoSource, cues: allCues/);
});

// One person written several ways (陆宴辞 / 陆晏辞 / 晏辞, 心柔 / 苏心柔) was a new voice in every
// episode that spelled them differently: a spelling the sheet lists as an alias, or a sheet name
// with one surname in front, is that person everywhere.
const madam = {
    characters: [
        { name: '简微', khmer: 'ជៀនវ៉ី', gender: 'Female', aliases: ['简薇', '简小姐'] },
        { name: '晏辞', khmer: 'យ៉ានស៊ី', gender: 'Male', aliases: ['宴辞'] },
        { name: '心柔', khmer: 'ស៊ីនរ៉ូវ', gender: 'Female' },
        { name: '陆宴辞', khmer: 'លូយ៉ានស៊ី', gender: 'Male' },
        { name: '苏心柔', khmer: 'ស៊ីនរ៉ូវ', gender: 'Female' },
        { name: '老夫人', khmer: 'លោកស្រីចាស់', gender: 'Female' },
        { name: '陆老夫人', khmer: 'លោកស្រីចាស់', gender: 'Female' },
        { name: '太太', khmer: 'លោកស្រី', gender: 'Female' },
        { name: '老太太', khmer: 'លោកយាយ', gender: 'Female' },
        { name: '简微奶奶', khmer: 'យាយ', gender: 'Female' },
        { name: '奶奶', khmer: 'លោកយាយ', gender: 'Female' },
        { name: '陆总', khmer: 'លោកប្រធាន', gender: 'Male' },
    ],
    address: [{ speaker: '苏心柔', listener: '简薇', calls: 'នាង', self: 'ខ្ញុំ' }],
};

test('every spelling of one person comes back as their one name', () => {
    const nameOf = cs.seriesNameOf(madam, [{ name: '林心柔', gender: 'Female' }, { name: '医生', gender: 'Male' }]);
    assert.equal(nameOf('简薇'), '简微', 'alias from the sheet');
    assert.equal(nameOf('陆晏辞'), '晏辞', 'surname + a sheet name');
    assert.equal(nameOf('陆宴辞'), '晏辞', 'through the alias 宴辞');
    assert.equal(nameOf('林心柔'), '心柔', 'a made-up surname from the speakers list');
    assert.equal(nameOf('陆老夫人'), '老夫人');
    assert.equal(nameOf('老太太'), '老太太', '老 is not a surname');
    assert.equal(nameOf('简微奶奶'), '简微奶奶', 'her grandmother is someone else');
    assert.equal(nameOf('陆总'), '陆总', 'a shared title stays out');
    assert.equal(nameOf('医生'), '医生');
    assert.equal(nameOf('新人'), '新人', 'a name nobody lists');
});

test('a man and a woman are never one person, whatever the alias says', () => {
    const nameOf = cs.seriesNameOf({ characters: [
        { name: '林峰', khmer: 'លីនហ្វេង', gender: 'Male', aliases: ['林菲'] },
        { name: '林菲', khmer: 'លីនហ្វី', gender: 'Female' },
    ] }, []);
    assert.equal(nameOf('林菲'), '林菲');
});

test('the sheet Gemini sees has one entry per person, the other spellings beside it', () => {
    const folded = cs.foldSheet(madam);
    const names = folded.characters.map((c) => c.name);
    assert.ok(names.includes('晏辞') && !names.includes('陆宴辞') && !names.includes('苏心柔') && !names.includes('陆老夫人'));
    assert.deepEqual(folded.characters.find((c) => c.name === '晏辞').aliases, ['宴辞', '陆宴辞']);
    assert.deepEqual(folded.address, [{ speaker: '心柔', listener: '简微', calls: 'នាង', self: 'ខ្ញុំ' }]);
    assert.match(cs.formatSheetForPrompt(madam), /- 简微 = ជៀនវ៉ី \(Female; also written 简薇, 简小姐\)/);
    // A later part's Gemini answer joins two names already on the sheet.
    const merged = cs.mergeSheets(madam, { characters: [{ name: '简微', khmer: 'ជៀនវ៉ី', gender: 'Female', aliases: ['陆太太'] }] });
    assert.ok(merged.characters.find((c) => c.name === '简微').aliases.includes('陆太太'));
});

test('the speakers list keeps one entry per person, counts their lines and keeps the main cast', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drd-speakers-'));
    fs.mkdirSync(path.dirname(cs.castDir(dir, 'C:/Drama/Madam/E1.mp4')), { recursive: true });
    cs.saveSeriesSpeakers(dir, 'C:/Drama/Madam/E1.mp4', [
        { name: '陆宴辞', gender: 'Male', frames: ['a.jpg'] },
        { name: '晏辞', gender: 'Male', frames: ['b.jpg'] },
    ]);
    const list = cs.addSeriesSpeakers(dir, 'C:/Drama/Madam/E2.mp4', [
        { speaker: '陆晏辞', gender: 'Male' }, { speaker: '晏辞', gender: 'Male' }, { speaker: '简薇', gender: 'Female' },
    ], madam);
    assert.deepEqual(list.map((x) => [x.name, x.lines || 0]), [['晏辞', 2], ['简微', 1]]);
    assert.deepEqual(list[0].frames, ['a.jpg', 'b.jpg'], 'pictures of every spelling kept');
    // Over the cap, those who said least go, not the first ones.
    const many = [{ name: '主角', gender: 'Male', lines: 50 }, ...Array.from({ length: 45 }, (_, i) => ({ name: `路人${i}`, gender: 'Male', lines: 1 }))];
    cs.saveSeriesSpeakers(dir, 'C:/Drama/Madam/E3.mp4', many);
    const kept = cs.loadSeriesSpeakers(dir, 'C:/Drama/Madam/E3.mp4');
    assert.equal(kept.length, 40);
    assert.equal(kept[0].name, '主角');
});

test('Clone Voices and Transcribe use the one name per person', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
    assert.match(src, /allCues\.forEach\(c => \{ if \(c\.speaker\) c\.speaker = speakerNameOf\(c\.speaker\); \}\);/);
    assert.match(src, /people\.sort\(\(a, b\) => \(named\.has\(b\.s\.name\) - named\.has\(a\.s\.name\)\)/, 'main cast pictures first');
    const route = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'voice-capture.js'), 'utf8');
    assert.match(route, /lines\.forEach\(\(l\) => \{ if \(l\.name\) l\.name = nameOf\(l\.name\); \}\);/);
    assert.match(route, /name: k && k\.name \? nameOf\(String\(k\.name\)\) : null/);
});
