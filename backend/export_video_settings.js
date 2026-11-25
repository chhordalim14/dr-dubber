// Video settings an export is encoded with, shared by render_service (the export) and
// episode_joiner (which re-encodes an odd episode to match the others byte for byte, so a
// series can be joined without re-encoding it all).
//
// Bitrate follows the source. Until 2026-11-25 every export of 720p or more was 6500k: short
// drama sources are often 720x1280 HEVC at 0.2-0.4 Mbps, so a 3 hour series came out at 9 GB
// with no more picture in it than the 2 GB of episodes it was made from.

// A few fixed steps, not any number: the bitrate is written into the H.264 header (HRD), and
// pieces of one series must get the same one to be joined without re-encoding. The joiner also
// finds an export's bitrate by trying these.
const EXPORT_BITRATES_K = [1000, 1500, 2000, 3000, 3500, 4500, 6500];

// outW/outH: the exported picture. srcW/srcH/srcKbps: the source's video stream (0 = unknown).
function exportBitrateK({ outW, outH, srcW, srcH, srcKbps } = {}) {
    const outPx = (outW || 0) * (outH || 0);
    const cap = !outPx || outPx >= 1280 * 720 ? 6500 : 4500; // the old fixed values: never more
    const srcPx = (srcW || 0) * (srcH || 0);
    if (!(srcKbps > 0) || !srcPx || !outPx) return cap;
    // HD whatever the source, and sharp burned-in subtitles. Measured 2026-11-25 (Quick Sync,
    // 720p drama upscaled to 1080x1920 with Khmer subtitles, VMAF): 2000k 96, 3000k 98, 6500k 99.
    const floor = outPx >= 1920 * 1080 * 0.9 ? 3500 : outPx >= 1280 * 720 * 0.9 ? 2000 : 1500;
    // 2.5x: a second generation loses detail, H.264 needs more than the HEVC most sources are,
    // and subtitles / blur boxes add to the picture. An upscaled picture is soft: more pixels,
    // not as many more bits.
    const want = srcKbps * 2.5 * Math.sqrt(Math.max(1, outPx / srcPx));
    const k = Math.min(cap, Math.max(floor, want));
    return EXPORT_BITRATES_K.find(t => t >= k) || cap;
}

// The hardware encoder's arguments for a bitrate (libx264 is CRF, not here).
function hwEncoderArgs(codec, kbps) {
    const b = `${kbps}k`;
    switch (codec) {
        case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', b];
        case 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', b];
        case 'h264_amf': return ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'speed', '-b:v', b];
        case 'h264_mf': return ['-c:v', 'h264_mf', '-b:v', b];
        case 'h264_videotoolbox': return ['-c:v', 'h264_videotoolbox', '-b:v', b];
        default: return null;
    }
}
const HW_ENCODER_KEY = { h264_nvenc: 'nvenc', h264_qsv: 'qsv', h264_amf: 'amf', h264_mf: 'mf', h264_videotoolbox: 'videotoolbox' };

// "Lavc61.19.101 h264_qsv" (the encoder tag FFmpeg writes) -> 'h264_qsv'.
function hwEncoderFromTag(tag) {
    const m = String(tag || '').match(/\b(h264_(?:nvenc|qsv|amf|mf|videotoolbox))\b/);
    return m ? m[1] : null;
}

// A frame rate to force on the export, or null to keep the source's. Some sources (one piece of
// a joined series, 2026-11-24) report r_frame_rate 50 while their frames really come at 25: the
// export then doubled every frame, and its odd header kept the series from being joined as is.
const STANDARD_RATES = ['24000/1001', '24', '25', '30000/1001', '30', '50', '60000/1001', '60'];
const rateValue = (r) => { const [n, d] = String(r || '').split('/').map(Number); return d ? n / d : n || 0; };
function exportFrameRate(videoStream) {
    if (!videoStream) return null;
    const r = rateValue(videoStream.r_frame_rate), avg = rateValue(videoStream.avg_frame_rate);
    if (!(r > 0) || !(avg > 5) || avg > 121 || r < avg * 1.5) return null;
    return STANDARD_RATES.reduce((best, s) => Math.abs(rateValue(s) - avg) < Math.abs(rateValue(best) - avg) ? s : best);
}

// The source video's own bitrate in kbps (0 = unknown): the stream's, else the file's less audio.
function sourceVideoKbps(info) {
    if (!info || !info.videoStream) return 0;
    const v = parseInt(info.videoStream.bit_rate, 10);
    if (v > 0) return v / 1000;
    const total = parseInt(info.formatBitRate, 10);
    const audio = parseInt(info.audioStream && info.audioStream.bit_rate, 10) || 0;
    return total > audio ? (total - audio) / 1000 : 0;
}

module.exports = { EXPORT_BITRATES_K, exportBitrateK, hwEncoderArgs, HW_ENCODER_KEY, hwEncoderFromTag, exportFrameRate, sourceVideoKbps };
