// Edge TTS silence trimming (tts_generator.py --trim-only) on generated tone clips. Edge pads
// every voice clip with ~0.25s of silence before and ~0.8s after, which made the voice start
// late and short lines look rushed. Skipped when FFmpeg or the app's Python isn't available
// (FFmpeg and python_env are git-ignored, so a fresh checkout or worktree may not have them).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..');
// A git worktree lives under <main checkout>/.claude/worktrees/<name>; its main checkout holds the binaries.
const roots = [repo, path.join(repo, '..', '..', '..'), 'C:\\dr-dubber'];
const find = (...rel) => roots.map((r) => path.join(r, ...rel)).find((p) => fs.existsSync(p));
const exe = process.platform === 'win32' ? '.exe' : '';
const FF = find('backend', 'bin', `ffmpeg${exe}`);
const FP = find('backend', 'bin', `ffprobe${exe}`);
const PY = find('backend', 'python_env', process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python'));
const SCRIPT = path.join(repo, 'backend', 'python', 'tts_generator.py');
const skip = !FF || !FP || !PY ? 'FFmpeg or the app python_env not found' : false;

let dir;
const ff = (args) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const duration = (f) => parseFloat(execFileSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

// Builds an Edge-like clip (mono 24 kHz MP3) from [seconds, 'silence' | 'tone'] parts.
function makeClip(name, parts) {
    const inputs = [], labels = [];
    parts.forEach(([secs, kind], i) => {
        inputs.push('-f', 'lavfi', '-i', kind === 'tone'
            ? `sine=frequency=440:sample_rate=24000:duration=${secs}`
            : `anullsrc=r=24000:cl=mono:d=${secs}`);
        labels.push(`[${i}:a]`);
    });
    const file = path.join(dir, name);
    ff([...inputs, '-filter_complex', `${labels.join('')}concat=n=${parts.length}:v=0:a=1,aformat=sample_fmts=s16:channel_layouts=mono[a]`,
        '-map', '[a]', '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', '24000', file]);
    return file;
}

// [start, end] of each silence (noise=-45dB, d=0.05), the same measure used on real Edge clips.
function parseSilences(file) {
    const r = spawnSync(FF, ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-45dB:d=0.05', '-f', 'null', '-'], { encoding: 'utf8' });
    const spans = [];
    let start = null;
    for (const line of r.stderr.split(/\r?\n/)) {
        const s = line.match(/silence_start: ([\d.]+)/);
        const e = line.match(/silence_end: ([\d.]+)/);
        if (s) start = parseFloat(s[1]);
        if (e && start !== null) { spans.push([start, parseFloat(e[1])]); start = null; }
    }
    if (start !== null) spans.push([start, duration(file)]);
    return spans;
}

function trim(file) {
    const out = execFileSync(PY, [SCRIPT, `--trim-only=${file}`], {
        env: { ...process.env, DR_FFMPEG_PATH: FF, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['ignore', 'pipe', 'pipe'], // the "[TTS trim] kept original" notes go to stderr
    }).toString();
    return JSON.parse(out.trim().split(/\r?\n/).pop());
}

// Silence at the very start / end of the file (0 when the clip starts or ends with sound).
const leadOf = (spans) => (spans.length && spans[0][0] < 0.001 ? spans[0][1] : 0);
const tailOf = (spans, total) => (spans.length && Math.abs(spans[spans.length - 1][1] - total) < 0.03 ? total - spans[spans.length - 1][0] : 0);
const interior = (spans, total) => spans.filter(([s, e]) => s > 0.001 && Math.abs(e - total) >= 0.03);

describe('Edge TTS silence trimming', { skip }, () => {
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drdub-trim-')); });
    after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

    test('trims the lead/tail pads and keeps a short (0.4s) interior pause', () => {
        const file = makeClip('short-pause.mp3', [[0.3, 'silence'], [1, 'tone'], [0.4, 'silence'], [1, 'tone'], [0.9, 'silence']]);
        const before = duration(file);
        const res = trim(file);
        assert.equal(res.success, true);
        assert.equal(res.trimmed, true);
        const total = duration(file);
        const spans = parseSilences(file);
        assert.ok(leadOf(spans) <= 0.12, `lead silence ${leadOf(spans)}`);
        assert.ok(tailOf(spans, total) <= 0.12, `tail silence ${tailOf(spans, total)}`);
        const gaps = interior(spans, total);
        assert.equal(gaps.length, 1, JSON.stringify(spans));
        const gap = gaps[0][1] - gaps[0][0];
        assert.ok(Math.abs(gap - 0.4) < 0.06, `interior pause ${gap}`);
        // 2s of tone + 0.4s pause + 0.04s lead + 0.08s tail: all the sound is still there.
        assert.ok(total >= 2.4 && total <= 2.6, `trimmed duration ${total}`);
        assert.ok(before - total > 0.9, `saved ${before - total}s`);
        // The duration handed back to the app is the trimmed file's real duration.
        assert.ok(Math.abs(res.duration - total) < 0.03, `reported ${res.duration} vs ffprobe ${total}`);
    });

    test('shortens a long (0.8s) interior pause to about 0.3s', () => {
        const file = makeClip('long-pause.mp3', [[0.3, 'silence'], [1, 'tone'], [0.8, 'silence'], [1, 'tone'], [0.9, 'silence']]);
        const res = trim(file);
        assert.equal(res.trimmed, true);
        const total = duration(file);
        const spans = parseSilences(file);
        const gaps = interior(spans, total);
        assert.equal(gaps.length, 1, JSON.stringify(spans));
        const gap = gaps[0][1] - gaps[0][0];
        assert.ok(Math.abs(gap - 0.3) < 0.06, `interior pause ${gap}`);
        assert.ok(total >= 2.3 && total <= 2.5, `trimmed duration ${total}`);
        assert.ok(Math.abs(res.duration - total) < 0.03, `reported ${res.duration} vs ffprobe ${total}`);
    });

    test('never trims a clip down to nothing: near-silent clips stay as they were', () => {
        const file = makeClip('blip.mp3', [[0.5, 'silence'], [0.08, 'tone'], [0.5, 'silence']]);
        const bytes = fs.readFileSync(file);
        const res = trim(file);
        assert.equal(res.trimmed, false);
        assert.ok(fs.readFileSync(file).equals(bytes), 'clip was rewritten');
        assert.ok(res.duration > 1, `duration ${res.duration}`);
    });

    test('a clip it cannot decode is left untouched', () => {
        const file = path.join(dir, 'broken.mp3');
        fs.writeFileSync(file, Buffer.from('not really an mp3'));
        const res = trim(file);
        assert.equal(res.trimmed, false);
        assert.equal(fs.readFileSync(file, 'utf8'), 'not really an mp3');
        assert.equal(fs.readdirSync(dir).some((f) => f.endsWith('.trim.tmp')), false);
    });
});
