// Export on a Mac (no NVIDIA): VideoToolbox decodes the video (the same frames bit for bit, a
// little less CPU), and a render that fails with it is done again with the CPU decoding, same
// encoder; after that the session stops asking for it. FFmpeg and the platform are faked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');

Object.defineProperty(process, 'platform', { value: 'darwin' });

const renders = [];
let hwDecodeWorks = true;

function fakeProcess(code, onClose) {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = { write() {}, end() {} };
    p.kill = () => {};
    setImmediate(() => { if (onClose) onClose(); p.emit('close', code); });
    return p;
}
cp.spawn = (bin, args) => {
    if (args.includes('-frames:v')) return fakeProcess(0); // the encoder check: VideoToolbox works
    const out = args[args.length - 1];
    if (!out.endsWith('.mp4')) return fakeProcess(0);
    renders.push(args);
    const ok = hwDecodeWorks || !args.includes('-hwaccel');
    return fakeProcess(ok ? 0 : 1, () => { if (ok) fs.writeFileSync(out, 'video'); });
};
const fakeExecFile = (bin, args, opts, cb) => { (typeof opts === 'function' ? opts : cb)(null, '', ''); };
fakeExecFile[util.promisify.custom] = async (bin, args) => ({
    stdout: args.includes('-encoders') ? ' V....D h264_videotoolbox   VideoToolbox H.264 Encoder\n V....D libx264   libx264 H.264' : '5.0\n',
    stderr: '',
});
cp.execFile = fakeExecFile;
const { renderVideo } = require('../backend/render_service');

function render(dir, name) {
    const videoPath = path.join(dir, 'in.mp4');
    fs.writeFileSync(videoPath, 'source');
    return new Promise((resolve, reject) => renderVideo(
        { videoPath, outputPath: path.join(dir, name), audioTracks: [], subtitles: [], showSubtitles: false, duration: 5, videoDuration: 5 },
        () => {}, resolve, reject));
}
const decoder = (args) => (args.includes('-hwaccel') ? args[args.indexOf('-hwaccel') + 1] : null);
const codec = (args) => args[args.indexOf('-c:v') + 1];

test('a Mac decodes with VideoToolbox, before the main input, and encodes with it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtdec-'));
    try {
        hwDecodeWorks = true;
        renders.length = 0;
        await render(dir, 'a.mp4');
        assert.equal(renders.length, 1);
        assert.equal(decoder(renders[0]), 'videotoolbox');
        assert.ok(renders[0].indexOf('-hwaccel') < renders[0].indexOf('-i'));
        assert.equal(codec(renders[0]), 'h264_videotoolbox');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a render that fails with VideoToolbox decoding is redone with the CPU decoding; later renders skip it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtdec-'));
    try {
        hwDecodeWorks = false;
        renders.length = 0;
        const out = await render(dir, 'b.mp4');
        assert.equal(out, path.join(dir, 'b.mp4'));
        assert.equal(renders.length, 2);
        assert.equal(decoder(renders[0]), 'videotoolbox');
        assert.equal(decoder(renders[1]), null);
        assert.equal(codec(renders[1]), 'h264_videotoolbox');

        await render(dir, 'c.mp4');
        assert.equal(renders.length, 3);
        assert.equal(decoder(renders[2]), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
