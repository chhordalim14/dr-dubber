// Export with NVIDIA decoding the video (backend/render_service.js): used whenever NVENC works,
// and a render that fails with it is done again with the CPU decoding, with the same encoder;
// after that the session stops asking for it. FFmpeg is faked: no GPU needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');

const renders = []; // args of every render FFmpeg was started with
let hwDecodeWorks = false;

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
    if (args.includes('-frames:v')) return fakeProcess(0); // the encoder check: NVENC works
    const out = args[args.length - 1];
    if (!out.endsWith('.mp4')) return fakeProcess(0);
    renders.push(args);
    const ok = hwDecodeWorks || !args.includes('-hwaccel');
    return fakeProcess(ok ? 0 : 1, () => { if (ok) fs.writeFileSync(out, 'video'); });
};
const fakeExecFile = (bin, args, opts, cb) => { (typeof opts === 'function' ? opts : cb)(null, '', ''); };
fakeExecFile[util.promisify.custom] = async (bin, args) => ({
    stdout: args.includes('-encoders') ? ' V....D h264_nvenc   NVIDIA NVENC H.264 encoder\n V....D libx264   libx264 H.264' : '5.0\n',
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
const hw = (args) => args.includes('-hwaccel') && args[args.indexOf('-hwaccel') + 1] === 'cuda';
const codec = (args) => args[args.indexOf('-c:v') + 1];

test('NVENC available: the video is decoded by NVIDIA, before the main input', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdec-'));
    try {
        hwDecodeWorks = true;
        renders.length = 0;
        await render(dir, 'a.mp4');
        assert.equal(renders.length, 1);
        const args = renders[0];
        assert.ok(hw(args));
        assert.ok(args.indexOf('-hwaccel') < args.indexOf('-i'));
        assert.equal(codec(args), 'h264_nvenc');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a render that fails with NVIDIA decoding is redone with the CPU decoding, same encoder; later renders skip it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdec-'));
    try {
        hwDecodeWorks = false;
        renders.length = 0;
        const out = await render(dir, 'b.mp4');
        assert.equal(out, path.join(dir, 'b.mp4'));
        assert.equal(renders.length, 2);
        assert.ok(hw(renders[0]));
        assert.ok(!hw(renders[1]));
        assert.equal(codec(renders[1]), 'h264_nvenc');

        await render(dir, 'c.mp4');
        assert.equal(renders.length, 3);
        assert.ok(!hw(renders[2]));
        assert.equal(codec(renders[2]), 'h264_nvenc');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
