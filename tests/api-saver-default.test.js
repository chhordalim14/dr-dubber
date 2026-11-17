// API Saver is ON unless the user switched it off, wherever transcription starts: the editor's
// Transcribe and its Settings checkbox, DAI batch / Dub Whole Series, and the server. They used
// to disagree (the editor read an unset value as off, the rest as on).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('every read of aiDubberApiSaver treats an unset value as on', () => {
    const files = ['frontend/js/studio-main.js', 'frontend/js/dai-transcribe-studio.js'];
    let reads = 0;
    for (const f of files) {
        for (const m of read(f).matchAll(/localStorage\.getItem\(\s*["']aiDubberApiSaver["']\s*\)\s*([!=]==)\s*["'](\w+)["']/g)) {
            reads++;
            assert.deepEqual([m[1], m[2]], ['!==', 'false'], `${f}: ${m[0]} reads an unset API Saver as off`);
        }
    }
    assert.ok(reads >= 4, `expected the editor, Settings and DAI reads (found ${reads})`);
});

test('the server default is on', () => {
    assert.match(read('backend/routes/gemini.js'), /apiSaver = true,/);
});
