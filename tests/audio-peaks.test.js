// backend/lib/audio-peaks.js: the Original Audio track's waveform data.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPeakAccumulator, computeAudioPeaks } = require('../backend/lib/audio-peaks');

const pcm = (samples) => {
    const buf = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
    return buf;
};

describe('peak accumulator', () => {
    test('one peak per slice, loudest sample either sign, scaled to 0-255', () => {
        const acc = createPeakAccumulator(4);
        acc.push(pcm([0, 100, -32768, 5, 16384, 0, 0, 0]));
        assert.deepEqual(acc.finish(), [255, 128]);
    });

    test('chunks that split a sample in half decode the same as one buffer', () => {
        const whole = pcm([1000, -2000, 3000, -4000, 5000, 32767, -1, 7]);
        const a = createPeakAccumulator(3);
        a.push(whole);
        const b = createPeakAccumulator(3);
        b.push(whole.subarray(0, 3));
        b.push(whole.subarray(3, 8));
        b.push(whole.subarray(8));
        assert.deepEqual(b.finish(), a.finish());
    });

    test('a short last slice still gives a peak; silence gives nothing', () => {
        const acc = createPeakAccumulator(4);
        acc.push(pcm([0, 0, 0, 0, 16384]));
        assert.deepEqual(acc.finish(), [0, 128]);
        assert.deepEqual(createPeakAccumulator(4).finish(), []);
    });
});

describe('computeAudioPeaks', () => {
    let ffmpegBin = null;
    try {
        ffmpegBin = require('../backend/ffmpeg_env').getFFmpegBinary();
    } catch (e) { /* no ffmpeg on this machine */ }

    test('decodes a real file to ~20 peaks per second', { skip: !ffmpegBin }, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peaks-'));
        const wav = path.join(dir, 'tone.wav');
        const { spawnSync } = require('child_process');
        const made = spawnSync(ffmpegBin, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-y', wav], { windowsHide: true });
        if (made.status !== 0) return;
        try {
            const { peaksPerSecond, peaks } = await computeAudioPeaks({ ffmpegBin, filePath: wav });
            assert.equal(peaksPerSecond, 20);
            assert.ok(Math.abs(peaks.length - 40) <= 1, `got ${peaks.length} peaks`);
            assert.ok(peaks.slice(2, -2).every((p) => p > 20), 'a steady tone is never silent');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a missing file rejects instead of hanging', { skip: !ffmpegBin }, async () => {
        await assert.rejects(computeAudioPeaks({ ffmpegBin, filePath: path.join(os.tmpdir(), 'no-such-file-xyz.mp4') }));
    });
});
