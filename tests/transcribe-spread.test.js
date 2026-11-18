// Dub Whole Series lends a tab spare keys ("spread"): the tab is cut into one piece per key so
// the pieces are asked at the same time. spreadChunkPlan / planTranscribeChunks from
// backend/routes/gemini.js, lifted out of the source (requiring it starts the backend).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// CRLF on a Windows checkout (core.autocrlf) would hide the '\n}\n' the functions end at.
const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'gemini.js'), 'utf8').replace(/\r\n/g, '\n');
const pick = (re) => { const m = src.match(re); assert.ok(m, `not found: ${re}`); return m[0]; };
const consts = ['TRANSCRIBE_CHUNK_TARGET_SEC', 'TRANSCRIBE_SINGLE_MAX_SEC', 'SPREAD_MIN_CHUNK_SEC']
    .map((n) => pick(new RegExp(`const ${n} = [^;]+;`))).join('\n');
const fns = ['spreadChunkPlan', 'planTranscribeChunks']
    .map((n) => pick(new RegExp(`function ${n}\\([\\s\\S]*?\\n\\}\\n`))).join('\n');
const { spreadChunkPlan, planTranscribeChunks } = new Function(`${consts}\n${fns}\nreturn { spreadChunkPlan, planTranscribeChunks };`)();
const lengths = (chunks) => chunks.map((c) => Math.round(c.end - c.start));

describe('spread: one piece per lent key', () => {
    test('a 7-minute tab with 4 keys: four pieces of about 2 minutes, none over the usual length', () => {
        const chunks = planTranscribeChunks(420, [], spreadChunkPlan(420, 4));
        assert.deepEqual(lengths(chunks), [120, 120, 120, 60]);
    });

    test('a 6.4-minute tab with 3 keys: three pieces', () => {
        const chunks = planTranscribeChunks(384, [], spreadChunkPlan(384, 3));
        assert.equal(chunks.length, 3);
        assert.ok(lengths(chunks).every((s) => s <= 160));
    });

    test('a 2-minute tab stays one piece (too short to cut)', () => {
        assert.equal(planTranscribeChunks(130, [], spreadChunkPlan(130, 4)).length, 1);
    });

    test('a long tab with few keys keeps the usual 3-minute pieces', () => {
        const plan = spreadChunkPlan(900, 2);
        assert.equal(plan.target, 180);
        assert.ok(lengths(planTranscribeChunks(900, [], plan)).every((s) => s <= 240));
    });

    test('cuts land on a silence near the target', () => {
        const chunks = planTranscribeChunks(420, [{ start: 128, end: 129 }], spreadChunkPlan(420, 4));
        assert.equal(Math.round(chunks[0].end * 10) / 10, 128.5);
    });

    test('the route asks every piece at once when spread, and keeps API Saver\'s gap rule', () => {
        assert.match(src, /\(fastMode \|\| spreadLanes > 1\) \? chunks\.length/);
        assert.match(src, /checkGaps: !saverOn \|\| anyTruncated/);
    });
});

describe('how long one audio request may hang', () => {
    const attempt = Number(src.match(/const GEMINI_ATTEMPT_TIMEOUT_MS = (\d+);/)[1]);
    const fn = pick(/function audioAttemptTimeoutMs\([\s\S]*?\n\}\n/);
    const audioAttemptTimeoutMs = new Function(`const GEMINI_ATTEMPT_TIMEOUT_MS = ${attempt};\n${fn}\nreturn audioAttemptTimeoutMs;`)();

    test('a 2-minute piece: 2.5 minutes (it answers in about 1), not 4', () => {
        assert.equal(audioAttemptTimeoutMs(120), 150000);
    });
    test('a whole 7-minute tab keeps the full 4 minutes', () => {
        assert.equal(audioAttemptTimeoutMs(420), attempt);
    });
    test('short pieces get at least 2 minutes; unknown length: the full limit', () => {
        assert.equal(audioAttemptTimeoutMs(30), 120000);
        assert.equal(audioAttemptTimeoutMs(0), attempt);
    });
    test('the chunk requests use it (not the Gemini Web Router)', () => {
        assert.match(src, /timeoutMs: webLanes \? GEMINI_ATTEMPT_TIMEOUT_MS : audioAttemptTimeoutMs\(clipSec\)/);
    });
});

describe('early transcribe: the server keeps the result itself', () => {
    test('saveResult saves the finished tab with its repair report and fallback models', () => {
        assert.match(src, /if \(saveResult === true && sourceFilePath\) \{\s+try \{\s+saveBatchResult\(BATCH_RESULTS_DIR, sourceFilePath, \{ data, repair: repair \|\| \{\}, fallbackModels, early: true \}\);/);
    });
    test('the same folder server.js reads them from', () => {
        const server = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
        assert.match(server, /const BATCH_RESULTS_DIR = path\.join\(STORAGE_BASE, 'batch_results'\);/);
        assert.match(src, /const BATCH_RESULTS_DIR = path\.join\(STORAGE_BASE, 'batch_results'\);/);
    });
});

describe('a tab\'s finished pieces are kept for its next try', () => {
    const os = require('node:os');
    const crypto = require('node:crypto');
    const memSrc = pick(/const PIECE_MEMORY_TTL_MS = [\s\S]*?\nfunction planTranscribeChunks\(/).replace(/\nfunction planTranscribeChunks\($/, '');
    const load = () => new Function('fs', 'path', 'crypto', `${memSrc}\nreturn { pieceMemoryKey, pieceMemoryFor, pieceMemory };`)(fs, path, crypto);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pieces-'));
    const video = path.join(dir, 'tab1.mp4');
    fs.writeFileSync(video, 'video');
    const parts = ['gemini-3.8-flash', 'comedy', '', true];
    const chunks = [{ start: 0, end: 120 }, { start: 120, end: 240 }, { start: 240, end: 360 }];

    test('the next try gets the same cut and the pieces that came back', () => {
        const { pieceMemoryKey, pieceMemoryFor } = load();
        const key = pieceMemoryKey(video, parts);
        const first = pieceMemoryFor(key, 360, chunks);
        first.outs[0] = { ok: true, items: [1] };
        first.outs[2] = { ok: true, items: [3] };
        const again = pieceMemoryFor(key, 360, [{ start: 0, end: 180 }, { start: 180, end: 360 }]);
        assert.equal(again.chunks, chunks, 'same cut as the first try');
        assert.equal(again.outs.filter(Boolean).length, 2);
        assert.equal(again.outs[1], undefined, 'only piece 2 is asked again');
    });

    test('nothing came back: the new cut is used', () => {
        const { pieceMemoryKey, pieceMemoryFor } = load();
        const key = pieceMemoryKey(video, parts);
        pieceMemoryFor(key, 360, chunks);
        const other = [{ start: 0, end: 360 }];
        assert.equal(pieceMemoryFor(key, 360, other).chunks, other);
    });

    test('another model, register, glossary or a changed file: not the same tab', () => {
        const { pieceMemoryKey } = load();
        const key = pieceMemoryKey(video, parts);
        assert.notEqual(pieceMemoryKey(video, ['gemini-3.6-flash', 'comedy', '', true]), key);
        assert.notEqual(pieceMemoryKey(video, ['gemini-3.8-flash', 'historical', '', true]), key);
        assert.notEqual(pieceMemoryKey(video, ['gemini-3.8-flash', 'comedy', 'GLOSSARY', true]), key);
        fs.writeFileSync(video, 'video, exported again');
        assert.notEqual(pieceMemoryKey(video, parts), key);
        assert.equal(pieceMemoryKey(path.join(dir, 'missing.mp4'), parts), null);
    });

    test('the route uses it: kept pieces are not asked, new pieces are kept, a finished tab clears it', () => {
        assert.match(src, /if \(pieces\) chunks = pieces\.chunks;/);
        assert.match(src, /let out = keptOut\(i\);/);
        assert.match(src, /if \(pieces && out\.ok && !out\.truncated && !out\.fellBack && out\.items\.length\) pieces\.outs\[i\] = out;/);
        assert.match(src, /if \(pieces\) pieceMemory\.forEach\(\(e, k\) => \{ if \(e === pieces\) pieceMemory\.delete\(k\); \}\);/);
    });

    test('no spare-key pieces while Google is turning requests away', () => {
        assert.match(src, /const spreadLanes = spread === true && !webLanes && !strained \?/);
    });
});

describe('piece memory keeps only pieces that can stand', () => {
    test('a reply cut off, or from a fallback model, is asked again on the next try (as the cache skips it)', () => {
        const store = src.match(/\n\s*if \(pieces && out\.ok[^\n]*pieces\.outs\[i\] = out;/);
        assert.ok(store, 'the piece memory store moved - update this test');
        assert.match(store[0], /!out\.truncated/);
        assert.match(store[0], /!out\.fellBack/);
        assert.match(src, /if \(out\.ok && !out\.truncated && out\.items\.length\) transcribeCacheSet\(cacheKey, out\);/);
    });
});
