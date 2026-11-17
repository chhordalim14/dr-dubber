// Export encoder default: "GPU (Auto)" unless the user picked CPU in Settings. Auto must still
// export on a PC with no usable GPU: FFmpeg lists hardware encoders it was built with, every
// test encode fails, and the render goes to libx264 exactly as the CPU setting does.
// FFmpeg is faked (as in render-hw-decode.test.js): no GPU needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');

const renders = []; // args of every render FFmpeg was started with
const tested = []; // encoders the 1-frame test was run with

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
    if (args.includes('-frames:v')) { // the encoder check: no GPU, so every hardware encoder fails
        tested.push(args[args.indexOf('-c:v') + 1]);
        return fakeProcess(1);
    }
    const out = args[args.length - 1];
    if (!out.endsWith('.mp4')) return fakeProcess(0);
    renders.push(args);
    return fakeProcess(0, () => fs.writeFileSync(out, 'video'));
};
const fakeExecFile = (bin, args, opts, cb) => { (typeof opts === 'function' ? opts : cb)(null, '', ''); };
fakeExecFile[util.promisify.custom] = async (bin, args) => ({
    // A full FFmpeg build: hardware encoders compiled in, though this PC can't use any of them.
    stdout: args.includes('-encoders')
        ? [' V....D h264_nvenc', ' V....D h264_qsv', ' V....D h264_amf', ' V....D h264_videotoolbox', ' V....D libx264'].join('   H.264\n')
        : '5.0\n',
    stderr: '',
});
cp.execFile = fakeExecFile;
const { renderVideo } = require('../backend/render_service');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const codec = (args) => args[args.indexOf('-c:v') + 1];

test('Auto on a PC with no usable GPU: every hardware encoder is tested, the export uses libx264', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-default-'));
    try {
        const videoPath = path.join(dir, 'in.mp4');
        fs.writeFileSync(videoPath, 'source');
        const outputPath = path.join(dir, 'out.mp4');
        const out = await new Promise((resolve, reject) => renderVideo(
            { videoPath, outputPath, audioTracks: [], subtitles: [], showSubtitles: false, duration: 5, videoDuration: 5, encoder: 'auto' },
            () => {}, resolve, reject));
        assert.equal(out, outputPath);
        assert.ok(tested.includes('h264_nvenc') && tested.includes('h264_qsv') && tested.includes('h264_amf'), `tested: ${tested.join(', ')}`);
        assert.equal(renders.length, 1);
        assert.equal(codec(renders[0]), 'libx264');
        assert.ok(!renders[0].includes('-hwaccel'), 'no NVIDIA decoding without a working NVENC');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the window defaults to "auto" and keeps a saved choice', () => {
    const src = read('frontend/js/studio-main.js');
    assert.match(src, /function renderEngineSetting\(\)[\s\S]{0,120}localStorage\.getItem\("aiDubberRenderEngine"\) \|\| "auto"/);
    assert.doesNotMatch(src, /getItem\("aiDubberRenderEngine"\) \|\| "cpu"/, 'a read still defaults to CPU');
    assert.ok((src.match(/renderEngine: renderEngineSetting\(\)/g) || []).length >= 2, 'both export paths use the setting');
});

test('the server maps the setting: cpu -> libx264, anything else -> auto', () => {
    assert.match(read('backend/routes/render.js'), /renderOpts\.renderEngine === 'cpu' \? 'libx264' : 'auto'/);
});
