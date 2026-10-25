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
    assert.match(src, /const castParts = videoSource \? seriesCastParts\(castDir\(CHARACTER_SHEETS_DIR, sourceFilePath\), seriesSpeakers\) : \[\];/);
    assert.match(src, /castParts: clipMime === 'video\/mp4' \? castParts : null/, 'only beside the video, not the sound-only gap check');
    assert.match(src, /\.\.\.\(\(promptOpts && promptOpts\.castParts\) \|\| \[\]\),\n\s+\{ inlineData: \{ mimeType, data: audioBase64 \} \}/);
    assert.match(src, /captureCastFrames\(\{ video: videoSource, cues: allCues/);
});
