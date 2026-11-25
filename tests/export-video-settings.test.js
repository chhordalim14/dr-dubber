// Export bitrate / frame rate (backend/export_video_settings.js). A 3 h series of 720x1280
// HEVC episodes at ~0.3 Mbps was exported at 6500k and joined into a 9 GB file (2026-11-25).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EXPORT_BITRATES_K, exportBitrateK, hwEncoderFromTag, exportFrameRate, sourceVideoKbps } = require('../backend/export_video_settings');

test('a low-bitrate source is no longer exported at 6500k', () => {
    // 720x1280 HEVC at 270-420 kbps, exported at 1080x1920: one step for the whole series.
    for (const src of [270, 330, 420]) {
        assert.equal(exportBitrateK({ outW: 1080, outH: 1920, srcW: 720, srcH: 1280, srcKbps: src }), 3500);
    }
    // HD minimums: 3500k at 1080p, 2000k at 720p.
    assert.equal(exportBitrateK({ outW: 720, outH: 1280, srcW: 720, srcH: 1280, srcKbps: 300 }), 2000);
});

test('never more than the old fixed bitrate, and the old value when the source is unknown', () => {
    assert.equal(exportBitrateK({ outW: 1080, outH: 1920, srcW: 1080, srcH: 1920, srcKbps: 8000 }), 6500);
    assert.equal(exportBitrateK({ outW: 640, outH: 360, srcW: 640, srcH: 360, srcKbps: 8000 }), 4500);
    assert.equal(exportBitrateK({ outW: 1080, outH: 1920, srcW: 1080, srcH: 1920, srcKbps: 0 }), 6500);
    assert.equal(exportBitrateK({}), 6500);
});

test('the bitrate is always one of the steps the joiner tries', () => {
    for (const srcKbps of [50, 300, 700, 1000, 1500, 2500, 4000, 20000]) {
        for (const [w, h] of [[640, 360], [1280, 720], [1080, 1920]]) {
            assert.ok(EXPORT_BITRATES_K.includes(exportBitrateK({ outW: w, outH: h, srcW: 720, srcH: 1280, srcKbps })));
        }
    }
});

test('the encoder is read from the tag FFmpeg writes', () => {
    assert.equal(hwEncoderFromTag('Lavc61.19.101 h264_qsv'), 'h264_qsv');
    assert.equal(hwEncoderFromTag('Lavc61.19.101 h264_nvenc'), 'h264_nvenc');
    assert.equal(hwEncoderFromTag('Lavc61.19.101 libx264'), null);
    assert.equal(hwEncoderFromTag(''), null);
});

test('a frame rate misread as double is corrected, a real one kept', () => {
    assert.equal(exportFrameRate({ r_frame_rate: '50/1', avg_frame_rate: '28203520/1128373' }), '25');
    assert.equal(exportFrameRate({ r_frame_rate: '25/1', avg_frame_rate: '31467520/1258843' }), null);
    assert.equal(exportFrameRate({ r_frame_rate: '60/1', avg_frame_rate: '60/1' }), null);
    assert.equal(exportFrameRate({ r_frame_rate: '30000/1001', avg_frame_rate: '0/0' }), null);
    assert.equal(exportFrameRate(null), null);
});

test("source bitrate: the stream's, else the file's less its audio", () => {
    assert.equal(sourceVideoKbps({ videoStream: { bit_rate: '423615' } }), 423.615);
    assert.equal(sourceVideoKbps({ videoStream: {}, audioStream: { bit_rate: '128000' }, formatBitRate: 1128000 }), 1000);
    assert.equal(sourceVideoKbps({ videoStream: {}, formatBitRate: 0 }), 0);
    assert.equal(sourceVideoKbps(null), 0);
});
