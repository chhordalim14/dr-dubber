// Dub Whole Series, unattended: an export never reports "done" without its voices or its blur,
// Stop stops a render that hasn't started FFmpeg yet, temp files don't pile up across a long
// series, and a short last part shares the series' character sheet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const renderSrc = read('backend', 'render_service.js');
const serverSrc = read('backend', 'server.js');
const joinerSrc = read('backend', 'episode_joiner.js');
const mainSrc = read('frontend', 'js', 'studio-main.js');

test('a render without its voice track fails instead of exporting music only', () => {
    assert.match(renderSrc, /if \(withVoicePath > 0 && validSubs\.length === 0\) \{\n\s+throw new Error/);
    assert.match(renderSrc, /if \(validSubs\.length > 0 && !\(dialogueStemPath && fs\.existsSync\(dialogueStemPath\)\)\) \{\n\s+throw new Error/);
});

test('a blur that can\'t be placed fails the render instead of showing the old subtitles', () => {
    assert.match(renderSrc, /if \(!size\) throw new Error\('Could not read the video size to blur/);
});

test('Stop before FFmpeg starts marks the job; the render checks before every FFmpeg start', () => {
    assert.match(renderSrc, /if \(!activeRenderProcess && currentRenderJob && currentRenderJob\.status === 'rendering'\) \{\n\s+currentRenderJob\.cancelRequested = true;/);
    assert.equal((renderSrc.match(/stopIfCancelled\(\);\n\s+const ffmpeg = spawn\(/g) || []).length, 2);
    assert.match(renderSrc, /currentRenderJob\.status = err\.cancelled \? 'cancelled' : 'error';/);
});

test('separated music is cleaned up every hour, FFmpeg stems after 2 days', () => {
    assert.match(serverSrc, /setInterval\(pruneSeparatedFolders, 60 \* 60 \* 1000\)\.unref\(\);/);
    assert.match(serverSrc, /if \(!\/\^ffmpeg_\\d\+_\\d\+\$\/\.test\(name\)\) continue;/);
    assert.ok(/^ffmpeg_\d+_\d+$/.test('ffmpeg_1234_1760000000000'));
});

test('joins: each job its own partial file, locked folders retried, old leftovers swept', () => {
    assert.match(joinerSrc, /const partialPath = \(job, part\) => `\$\{part\.outPath\}\.\$\{job\.id\.slice\(0, 8\)\}\.part\.mp4`;/);
    assert.ok(!/part\.outPath \+ '\.part\.mp4'/.test(joinerSrc));
    assert.match(joinerSrc, /fs\.rm\(workDir, \{ recursive: true, force: true, maxRetries: 10, retryDelay: 1000 \}/);
    assert.match(joinerSrc, /sweepStaleJoinFiles\(outDir\);/);
    assert.match(mainSrc, /startBackgroundJoin\(partsToJoin\(\)\.filter\(\(k\) => k !== unfinishedIndex\(\)\)\)/);
});

test('a failed export is rendered again from the tabs as they are now', () => {
    assert.match(mainSrc, /if \(!job\.tabsClosed\) window\.seriesRenderApi\.refreshItems\?\.\(job\.items\);/);
});

test('VoxCPM2 never limits a tab to the open tab\'s length', () => {
    assert.match(mainSrc, /const projDuration = proj\.duration > 0 \? proj\.duration : \(isActiveProject && duration > 0 \? duration : Infinity\);/);
});

test('Transcribe step: lines still in Chinese trigger Fix Missing; empty tabs are named', () => {
    assert.match(mainSrc, /const hasUntranslated = partialTabs > 0 \|\| projects\.some/);
    assert.match(mainSrc, /has no subtitles \(exported without a dub\)/);
    assert.match(mainSrc, /if \(fastSpokenLength\(text\) >= fastSpokenLength\(sub\.text\)\) return;/);
});

test('the series\' Direct transcription leaves timing to the later steps; incomplete results are not kept', () => {
    assert.match(serverSrc, /const fitted = fitToTime === false \? 0 : await fitOverlongLines\(\{/);
    const dai = read('frontend', 'js', 'dai-transcribe-studio.js');
    assert.match(dai, /\.\.\.\(forSeries \? \{ fitToTime: false \} : \{\}\)/);
    assert.match(dai, /if \(!item\.reusedSaved && item\.filePath && !incomplete\) \{/);
    assert.match(serverSrc, /if \(!result\.success\) return lowAnswer \? \{ \.\.\.lowAnswer, truncated: true \} : \{ ok: false, result \};/);
});

test('a short last part (the joined file itself) shares the series\' character sheet', () => {
    const { saveSeriesSheet, loadSeriesSheet } = require('../backend/lib/character-sheet');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-split-'));
    try {
        const joined = path.join(dir, 'Series', 'DR Dubber Joined');
        const sheet = { characters: [{ name: '林峰', khmer: 'លីន ហ្វេង', gender: 'Male' }], address: [], terms: [] };
        assert.ok(saveSeriesSheet(path.join(dir, 'sheets'), path.join(joined, 'DR Dubber Split', 'Drama_part01_part01.mp4'), sheet));
        const fromShortPart = loadSeriesSheet(path.join(dir, 'sheets'), path.join(joined, 'Drama_part09.mp4'));
        assert.equal(fromShortPart && fromShortPart.characters[0].khmer, 'លីន ហ្វេង');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
