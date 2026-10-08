// Real unit tests against backend/lib/paths.js - the local-file-path
// resolver used by nearly every route (render, preview, episodes, split,
// audio streaming) to turn a browser-supplied path (which may be a raw
// disk path, a file:// URL, a /storage/... URL, or percent-encoded) back
// into a real path on disk.
//
// This is the first file in the backend that was actually importable in
// isolation - before the server.js route split, this logic was private to
// the 4,298-line monolith and could only be exercised by hitting a live
// HTTP server.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
    resolveLocalFilePath,
    UPLOADS_DIR,
    AUDIO_CACHE_DIR,
    SEPARATED_DIR,
    EXPORTS_DIR
} = require('../backend/lib/paths');

describe('resolveLocalFilePath', () => {
    test('returns null for empty/missing input', () => {
        assert.equal(resolveLocalFilePath(null), null);
        assert.equal(resolveLocalFilePath(undefined), null);
        assert.equal(resolveLocalFilePath(''), null);
        assert.equal(resolveLocalFilePath('   '), null);
    });

    test('maps /storage/uploads/<name> to UPLOADS_DIR', () => {
        const result = resolveLocalFilePath('/storage/uploads/foo.mp4');
        assert.equal(result, path.join(UPLOADS_DIR, 'foo.mp4'));
    });

    test('maps /storage/tts/<name> to AUDIO_CACHE_DIR (the TTS cache folder)', () => {
        const result = resolveLocalFilePath('/storage/tts/bar.mp3');
        assert.equal(result, path.join(AUDIO_CACHE_DIR, 'bar.mp3'));
    });

    test('maps /storage/separated/<name> to SEPARATED_DIR', () => {
        const result = resolveLocalFilePath('/storage/separated/baz.wav');
        assert.equal(result, path.join(SEPARATED_DIR, 'baz.wav'));
    });

    test('maps a relative storage/exports/<name> path (no leading slash) to EXPORTS_DIR', () => {
        const result = resolveLocalFilePath('storage/exports/out.mp4');
        assert.equal(result, path.join(EXPORTS_DIR, 'out.mp4'));
    });

    test('strips a leading slash off a Windows drive-letter path on win32', { skip: process.platform !== 'win32' }, () => {
        const result = resolveLocalFilePath('/D:/some/path.mp4');
        assert.equal(result, 'D:/some/path.mp4');
    });

    test('passes through an already-correct absolute path unchanged', () => {
        // Not a /storage/... URL and doesn't exist on disk, so none of the
        // rewrite rules apply - the function should hand the input back.
        const input = process.platform === 'win32' ? 'C:\\some\\random\\file.mp4' : '/some/random/file.mp4';
        assert.equal(resolveLocalFilePath(input), input);
    });
});
