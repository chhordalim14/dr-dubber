// Episode joiner + splitter on real (tiny, generated) media. Skipped when FFmpeg isn't in
// backend/bin. Each case is a bug or a feature of Dub Whole Series.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createEpisodeJoiner } = require('../backend/episode_joiner');
const { createVideoSplitter } = require('../backend/video_splitter');

const bin = (name) => [path.join(__dirname, '..', 'backend', 'bin', `${name}.exe`), path.join(__dirname, '..', 'backend', 'bin', name)].find((p) => fs.existsSync(p));
const FF = bin('ffmpeg'), FP = bin('ffprobe');
const skip = !FF || !FP ? 'FFmpeg not found in backend/bin' : false;

let root, vdir, adir, out, joiner, splitter;
const ff = (args) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const duration = (f) => parseFloat(execFileSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const hasVideo = (f) => execFileSync(FP, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', f]).toString().includes('video');
const waitJob = async (get) => { for (;;) { await new Promise((r) => setTimeout(r, 150)); const st = get(); if (st.status !== 'running') return st; } };
const join = async (parts, partNumbers, seriesName = 'S') => {
    const id = await joiner.start({ parts, partNumbers, outDir: out, seriesName });
    return waitJob(() => joiner.status(id));
};

describe('episode joiner', { skip }, () => {
    before(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'drdub-join-'));
        vdir = path.join(root, 'video'); adir = path.join(root, 'audio'); out = path.join(root, 'out');
        [vdir, adir].forEach((d) => fs.mkdirSync(d));
        const v = (sec, size) => ['-f', 'lavfi', '-i', `testsrc2=s=${size}:r=25:d=${sec}`, '-f', 'lavfi', '-i', `sine=f=440:d=${sec}`, '-shortest'];
        ff([...v(2, '320x240'), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(vdir, 'E01.mp4')]);
        ff([...v(2, '320x240'), '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(vdir, 'E02.mp4')]);
        ff([...v(2, '320x244'), '-c:v', 'mpeg4', '-c:a', 'mp3', path.join(vdir, 'E03.avi')]); // odd size + other container: converted
        ff([...v(2, '320x240'), '-c:v', 'wmv2', '-c:a', 'wmav2', path.join(vdir, 'E04.wmv')]);
        ff(['-f', 'lavfi', '-i', 'sine=d=2', '-c:a', 'libmp3lame', path.join(vdir, 'transcribe_E01.mp3')]); // the app's own file
        ff(['-f', 'lavfi', '-i', 'sine=d=3', '-c:a', 'libmp3lame', path.join(adir, 'E01.mp3')]);
        ff(['-f', 'lavfi', '-i', 'sine=d=3', '-c:a', 'flac', path.join(adir, 'E02.flac')]);
        ff(['-f', 'lavfi', '-i', 'sine=d=3', '-c:a', 'wmav2', path.join(adir, 'E03.wma')]);
        const opts = { getFFmpegBinary: () => FF, getFFprobeBinary: () => FP, trackProcess: null };
        joiner = createEpisodeJoiner({ ...opts, detectAvailableEncoders: async () => ({}), audioRepair: null });
        splitter = createVideoSplitter(opts);
    });
    after(() => fs.rmSync(root, { recursive: true, force: true }));

    test('scan: a video folder lists its videos and ignores audio next to them', async () => {
        const r = await joiner.scan(vdir);
        assert.deepEqual(r.files.map((f) => f.name), ['E01.mp4', 'E02.mp4', 'E03.avi', 'E04.wmv']);
        assert.ok(r.files.every((f) => !f.error));
    });

    test('scan: a folder with only audio is an audio series', async () => {
        const r = await joiner.scan(adir);
        assert.deepEqual(r.files.map((f) => f.name), ['E01.mp3', 'E02.flac', 'E03.wma']);
    });

    test('parts are named by their real number (a background job for parts 2 and 3 must not write _part01)', async () => {
        await join([[path.join(vdir, 'E01.mp4')]], [1]);
        const st = await join([[path.join(vdir, 'E02.mp4')], [path.join(vdir, 'E01.mp4')]], [2, 3]);
        assert.deepEqual(st.parts.map((p) => path.basename(p.outPath)), ['S_part02.mp4', 'S_part03.mp4']);
        const list = (n) => fs.readFileSync(path.join(out, `S_part${n}_episodes.txt`), 'utf8');
        assert.match(list('01'), /EP1\n$/);
        assert.match(list('02'), /EP2\n$/);
    });

    test('a finished part is reused; a file holding other episodes is rebuilt', async () => {
        let st = await join([[path.join(vdir, 'E02.mp4')]], [2]);
        assert.equal(st.parts[0].reused, true);
        fs.writeFileSync(path.join(out, 'S_part02_episodes.txt'), '00:00:00 EP99\n');
        st = await join([[path.join(vdir, 'E02.mp4')]], [2]);
        assert.equal(st.parts[0].status, 'done');
        assert.equal(st.parts[0].reused, false);
    });

    test('a file written after the part was joined (a part dubbed again) rebuilds it', async () => {
        const src = path.join(root, 'redub.mp4');
        fs.copyFileSync(path.join(vdir, 'E01.mp4'), src);
        let st = await join([[src]], [7]);
        assert.equal(st.parts[0].status, 'done');
        st = await join([[src]], [7]);
        assert.equal(st.parts[0].reused, true);
        const later = new Date(Date.now() + 5000);
        fs.utimesSync(src, later, later); // rendered again: same name, same length
        st = await join([[src]], [7]);
        assert.equal(st.parts[0].status, 'done');
        assert.equal(st.parts[0].reused, false);
    });

    test('an episode that can no longer be read fails its part instead of being left out', async () => {
        const broken = path.join(root, 'E05.mp4');
        fs.writeFileSync(broken, 'not a video'); // scanned fine, then damaged or locked
        const st = await join([[path.join(vdir, 'E01.mp4'), broken]], [5]);
        assert.equal(st.parts[0].status, 'error');
        assert.match(st.parts[0].error, /1 episode\(s\) could not be read: E05\.mp4/);
        assert.ok(!fs.existsSync(path.join(out, 'S_part05.mp4')));
    });

    test('mixed formats and sizes join into one playable part of the right length', async () => {
        const files = ['E01.mp4', 'E02.mp4', 'E03.avi', 'E04.wmv'].map((n) => path.join(vdir, n));
        const st = await join([files], [4]);
        assert.equal(st.parts[0].status, 'done', st.parts[0].error);
        assert.ok(Math.abs(duration(st.parts[0].outPath) - 8) < 0.5);
    });

    test('clips are put in at the given times: between files, inside a file, at the end', async () => {
        const clip = path.join(root, 'clip.mp4');
        ff(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=880:d=1', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', clip]);
        const files = [path.join(vdir, 'E01.mp4'), path.join(vdir, 'E02.mp4')]; // 2s each, copyable on their own
        const inserts = [{ at: 0, path: clip }, { at: 3, path: clip }, { at: 4, path: clip }];
        const st = await join([{ files, inserts }], [7], 'Clips');
        assert.equal(st.parts[0].status, 'done', st.parts[0].error);
        assert.equal(st.parts[0].videoMode, 'converted', 'cut inside a file: encoded, not copied');
        const d = duration(st.parts[0].outPath);
        assert.ok(Math.abs(d - 7) < 0.25, `4s of episodes + 3 one-second clips, got ${d}`);
        // clip | E01 | E02 0-1s | clip | E02 1-2s | clip
        assert.deepEqual(fs.readFileSync(path.join(out, 'Clips_part07_episodes.txt'), 'utf8').trim().split('\n').map((l) => l.split(' ')[1]),
            ['clip.mp4', 'EP1', 'EP2', 'clip.mp4', 'EP2', 'clip.mp4']);
    });

    test('an audio-only episode in a video part gets black frames', async () => {
        const st = await join([[path.join(vdir, 'E01.mp4'), path.join(adir, 'E01.mp3')]], [5]);
        assert.equal(st.parts[0].status, 'done', st.parts[0].error);
        assert.ok(hasVideo(st.parts[0].outPath));
        assert.ok(Math.abs(duration(st.parts[0].outPath) - 5) < 0.5);
    });

    test('an audio series joins into an .m4a part', async () => {
        const st = await join([['E01.mp3', 'E02.flac', 'E03.wma'].map((n) => path.join(adir, n))], [1], 'A');
        assert.equal(st.parts[0].status, 'done', st.parts[0].error);
        assert.match(st.parts[0].outPath, /A_part01\.m4a$/);
        assert.equal(hasVideo(st.parts[0].outPath), false);
        assert.ok(Math.abs(duration(st.parts[0].outPath) - 9) < 0.5);
    });

    test('stop works at once, even while the files are still being read', async () => {
        const id = await joiner.start({ parts: [['E01.mp4', 'E02.mp4', 'E03.avi'].map((n) => path.join(vdir, n))], partNumbers: [9], outDir: out, seriesName: 'S' });
        joiner.cancel(id);
        const st = await waitJob(() => joiner.status(id));
        assert.equal(st.status, 'cancelled');
        assert.equal(st.parts[0].error, null); // not "none of its files can be read"
    });

    test('a folder of joined parts is recognised as ready parts', async () => {
        const dir = path.join(root, 'joined');
        fs.mkdirSync(dir);
        for (const n of ['01', '02']) {
            fs.copyFileSync(path.join(out, `S_part${n}.mp4`), path.join(dir, `S_part${n}.mp4`));
            fs.copyFileSync(path.join(out, `S_part${n}_episodes.txt`), path.join(dir, `S_part${n}_episodes.txt`));
        }
        const r = await joiner.scan(dir);
        assert.equal(r.seriesName, 'S');
        assert.deepEqual(r.joinedParts.map((p) => p.number), [1, 2]);
    });

    test('the splitter cuts audio-only files (WMA is converted to .m4a)', async () => {
        const id = await splitter.start({ file: path.join(adir, 'E03.wma'), outDir: path.join(root, 'split'), partCount: 1, baseName: 'W' });
        const st = await waitJob(() => splitter.status(id));
        assert.equal(st.status, 'done', st.error);
        assert.match(st.parts[0].outPath, /W_part01\.m4a$/);
        assert.ok(Math.abs(st.parts[0].duration - 3) < 0.3);
    });
});
