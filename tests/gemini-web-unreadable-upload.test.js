// 2026-11-27: Google could not open the clips the Gmails uploaded (every Gmail, with or without a
// proxy). The Gmails said so in words, or answered "[]", and a piece came back with 0 lines: tabs
// ended with "No spoken dialogue was detected in this audio." gwebUploadUnreadable and
// gwebEmptyAnswerIsFailure from backend/routes/gemini.js, lifted out of the source (requiring
// it starts the backend).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'gemini.js'), 'utf8').replace(/\r\n/g, '\n');
const pick = (re) => { const m = src.match(re); assert.ok(m, `not found: ${re}`); return m[0]; };
const consts = ['GWEB_UPLOAD_OPEN_FAIL_RE', 'GWEB_UPLOAD_FILE_RE'].map((n) => pick(new RegExp(`const ${n} = [^\\n]+;`))).join('\n');
const fns = ['gwebUploadUnreadable', 'gwebEmptyAnswerIsFailure']
    .map((n) => pick(new RegExp(`function ${n}\\([\\s\\S]*?\\n\\}\\n`))).join('\n');
const { gwebUploadUnreadable, gwebEmptyAnswerIsFailure } = new Function(`${consts}\n${fns}\nreturn { gwebUploadUnreadable, gwebEmptyAnswerIsFailure };`)();

describe('a Gmail saying it could not open the upload', () => {
    // Replies from the log of 2026-11-27.
    const replies = [
        "It looks like the attached audio file (`part1.mp3`) could not be opened, so I can't listen to or transcribe the dialogue right now.",
        "I can't open the attached audio file (`part1.mp3`), so I can't listen to the dialogue to transcribe and adapt it into Khmer.",
        "I cannot hear anything because `part1.mp3` could not be opened.",
        "The video file `part11.mp4` could not be opened or loaded, so I cannot hear the audio or extract dialogue timestamps from it.",
        "It looks like `part1.mp3` could not be opened or isn't attached properly, so I can't hear any audio to transcribe or translate into Khmer.",
        "It looks like the audio file (`part1.mp3`) could not be opened or wasn't received properly, so I can't listen to the dialogue yet.",
        '无法打开音频文件 `part1.mp3`，因此目前没有可转写和翻译的语音内容。',
        '抱歉，附加的音訊檔案 `part1.mp3` 無法開啟或讀取，因此目前無法聽取內容並產出高棉語配音字幕的 JSON。',
        '目前无法直接读取或打开该音频文件（`[The file \'part1.mp3\' could not be opened]`），因此无法提取语音内容。',
        'សូមអភ័យទោស ឯកសារអូឌីយ៉ូ `part1.mp3` មិនអាចបើកបានទេ',
    ];
    for (const r of replies) {
        test(r.slice(0, 60), () => assert.equal(gwebUploadUnreadable(r), true));
    }

    test('a normal transcript or other refusal is not taken for it', () => {
        assert.equal(gwebUploadUnreadable('[{"start":"00:01.0","end":"00:02.0","text":"បើកទ្វារ"}]'), false);
        assert.equal(gwebUploadUnreadable("I'm having a hard time fulfilling your request. Can I help you with something else instead?"), false);
        assert.equal(gwebUploadUnreadable(''), false);
        assert.equal(gwebUploadUnreadable(null), false);
    });
});

describe('a Gmail answer with no lines', () => {
    const speech = Array.from({ length: 40 }, (_, i) => ['话', i, i + 0.3]);
    test('is a failure when the PC heard speech in the clip', () => {
        assert.equal(gwebEmptyAnswerIsFailure(0, 30, speech), true);
    });
    test('stands when the PC heard no speech, or only a stray character', () => {
        assert.equal(gwebEmptyAnswerIsFailure(0, 180, []), false);
        assert.equal(gwebEmptyAnswerIsFailure(0, 180, [['啊', 3, 3.2]]), false);
    });
    test('without PC timing: a failure for a long piece only', () => {
        assert.equal(gwebEmptyAnswerIsFailure(0, 180, null), true);
        assert.equal(gwebEmptyAnswerIsFailure(0, 40, null), false);
    });
    test('an answer with lines is never a failure', () => {
        assert.equal(gwebEmptyAnswerIsFailure(3, 180, speech), false);
    });
});

describe('transcribeClipWithGeminiWeb', () => {
    const fn = pick(/async function transcribeClipWithGeminiWeb\([\s\S]*?\n\}\n/);
    test('hands an unreadable upload to the next key without asking the same Gmail again', () => {
        assert.match(fn, /gwebUploadUnreadable\(raw\)[\s\S]*?code: 'GWEB_FILE_UNREADABLE'[\s\S]*?break;/);
    });
    test('an empty answer for a piece with speech goes to the next key', () => {
        assert.match(fn, /gwebEmptyAnswerIsFailure\([\s\S]*?code: 'GWEB_EMPTY'/);
    });
    test('while uploads are failing, audio skips the Gmails when an API key is there', () => {
        assert.match(fn, /ctx\.apiBackup && gwebAudioPauseLeftMs\(\) > 0/);
    });
    test('both failures are ones the key loop moves on from (status 5xx)', () => {
        for (const code of ['GWEB_FILE_UNREADABLE', 'GWEB_EMPTY', 'GWEB_AUDIO_PAUSED']) {
            assert.match(fn, new RegExp(`status: 502, code: '${code}'`));
        }
    });
});
