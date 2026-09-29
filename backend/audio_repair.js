// Repair for AAC audio whose format changes part-way through a file.
//
// Clips joined without re-encoding (common for Douyin/TikTok episodes cut into
// "_partNN" files) can switch AAC settings mid-stream, e.g. 44.1kHz AAC-LC for a
// while, then HE-AAC with a 22.05kHz core. MP4/MKV store only the FIRST clip's
// settings, so every decoder (FFmpeg, Chromium) decodes the other stretches with the
// wrong sample rate: thousands of "Invalid data" errors, silence or noise, and a
// shortened track that throws transcription timestamps off.
//
// Each AAC packet is 1024 samples of its core rate, so the gap between packet
// timestamps reveals the real rate of every stretch. We re-wrap the packets as ADTS
// (each frame carries its own header), fix the sample-rate field in the frames of
// mismatched stretches, and cache the result. No re-encoding; timing is preserved.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const RAW_AAC_CONTAINERS = ['mov', 'mp4', 'm4a', 'matroska', 'webm', 'flv'];
const MIN_RUN_PACKETS = 40; // ~1-2s; shorter blips are timestamp jitter at clip joins
const CACHE_VERSION = 1;

function nearestRateIndex(rate) {
    let best = 0;
    for (let i = 1; i < AAC_RATES.length; i++) {
        if (Math.abs(AAC_RATES[i] - rate) < Math.abs(AAC_RATES[best] - rate)) best = i;
    }
    return best;
}

function createAudioRepair({ repairDir, getFFmpegBinary, getFFprobeBinary, trackProcess }) {
    fs.mkdirSync(repairDir, { recursive: true });
    const analysisCache = new Map(); // key -> Promise<analysis>
    const repairJobs = new Map();    // key -> Promise<path|null>
    const failedRepairs = new Set(); // keys whose repair failed: don't redo the expensive work

    const probeJson = (args) => new Promise((resolve, reject) => {
        execFile(getFFprobeBinary(), args, { timeout: 120000, maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout);
        });
    });

    function fileKey(filePath) {
        const st = fs.statSync(filePath);
        return crypto.createHash('sha1').update(`${CACHE_VERSION}|${path.resolve(filePath)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 24);
    }

    // Declared core rate from the AudioSpecificConfig (extradata), which is what
    // decoders use. For explicit HE-AAC (object type 5/29) the first index is the core.
    function declaredCoreRateIndex(extradataHex) {
        const bytes = String(extradataHex || '').replace(/^[0-9a-f]+:\s*/gim, '').replace(/\s{2,}.*$/gm, '').replace(/[^0-9a-f]/gi, '');
        if (bytes.length < 4) return -1;
        const b0 = parseInt(bytes.slice(0, 2), 16), b1 = parseInt(bytes.slice(2, 4), 16);
        if ((b0 >> 3) === 31) return -1; // escaped object type: fields shift, don't guess
        return ((b0 & 0x07) << 1) | (b1 >> 7);
    }

    // The track every step should use: the default-flagged audio track, else the first.
    // (FFmpeg's own pick prefers the track with the most channels, so a 5.1 Cantonese
    // track could be transcribed while the preview plays the default Mandarin one.)
    async function selectAudioStream(filePath) {
        const info = JSON.parse(await probeJson(['-v', 'error', '-show_format', '-show_streams', '-show_data', '-of', 'json', filePath]));
        const audio = (info.streams || []).filter(s => s.codec_type === 'audio');
        const stream = audio.find(s => s.disposition && s.disposition.default) || audio[0] || null;
        return { info, stream };
    }

    async function analyzeUncached(filePath) {
        const { info, stream } = await selectAudioStream(filePath);
        const formats = String(info.format && info.format.format_name || '').split(',');
        if (!stream || stream.codec_name !== 'aac' || !formats.some(f => RAW_AAC_CONTAINERS.includes(f))) return { drift: false };
        const declared = declaredCoreRateIndex(stream.extradata);
        if (declared < 0 || declared >= AAC_RATES.length) return { drift: false };

        const csv = await probeJson(['-v', 'error', '-select_streams', String(stream.index), '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', filePath]);
        const pts = csv.split('\n').map(l => l.trim()).filter(Boolean).map(Number).filter(n => isFinite(n));
        if (pts.length < MIN_RUN_PACKETS * 2) return { drift: false };

        // Implied rate index per packet from the gap to the next packet, smoothed with a
        // median over 15 packets, then grouped into runs.
        const raw = pts.map((t, i) => (i + 1 < pts.length && pts[i + 1] > t) ? nearestRateIndex(1024 / (pts[i + 1] - t)) : -1);
        const smooth = raw.map((_, i) => {
            const win = raw.slice(Math.max(0, i - 7), i + 8).filter(v => v >= 0).sort((a, b) => a - b);
            return win.length ? win[win.length >> 1] : declared;
        });
        const runs = [];
        for (let i = 0; i < smooth.length; i++) {
            const last = runs[runs.length - 1];
            if (last && last.rate === smooth[i]) last.end = i;
            else runs.push({ rate: smooth[i], start: i, end: i });
        }
        // Blips shorter than MIN_RUN_PACKETS belong to the surrounding stretch.
        const merged = [];
        for (const r of runs) {
            const len = r.end - r.start + 1;
            const prev = merged[merged.length - 1];
            if (prev && (len < MIN_RUN_PACKETS || prev.rate === r.rate)) prev.end = r.end;
            else merged.push({ ...r });
        }
        const bad = merged.filter(r => r.rate !== declared && r.end - r.start + 1 >= MIN_RUN_PACKETS);
        if (!bad.length) return { drift: false };
        const stretches = bad.map(r => ({
            fromSec: +pts[r.start].toFixed(2),
            toSec: +pts[Math.min(r.end + 1, pts.length - 1)].toFixed(2),
            rate: AAC_RATES[r.rate]
        }));
        // Expected length of the repaired track: last packet + one frame at its real rate.
        const lastRate = AAC_RATES[smooth[smooth.length - 1]] || AAC_RATES[declared];
        const audioDuration = pts[pts.length - 1] - pts[0] + 1024 / lastRate;
        // FFmpeg starts every input at the earliest stream; audio that begins later (a
        // delayed-audio mux) must keep that lead-in, or it plays early against the video.
        const fileStart = parseFloat(info.format && info.format.start_time) || 0;
        const startOffset = Math.max(0, (parseFloat(stream.start_time) || pts[0] || 0) - fileStart);
        return { drift: true, streamIndex: stream.index, declaredRate: AAC_RATES[declared], declaredIndex: declared, runs: bad, packetCount: pts.length, audioDuration, startOffset, stretches };
    }

    function analyze(filePath) {
        let key;
        try { key = fileKey(filePath); } catch (e) { return Promise.resolve({ drift: false }); }
        if (!analysisCache.has(key)) {
            analysisCache.set(key, analyzeUncached(filePath).catch((e) => {
                console.warn('[AudioRepair] analysis skipped:', e.message);
                return { drift: false };
            }));
        }
        return analysisCache.get(key);
    }

    function runFFmpeg(args) {
        return new Promise((resolve) => {
            const proc = spawn(getFFmpegBinary(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
            if (trackProcess) trackProcess(proc);
            let tail = '';
            proc.stderr.on('data', (d) => { tail = (tail + d).slice(-2000); });
            proc.on('error', (e) => resolve({ code: -1, tail: e.message }));
            proc.on('close', (code) => resolve({ code, tail }));
        });
    }

    async function buildRepaired(filePath, analysis, outPath) {
        const tmp = outPath + '.part.aac';
        const r = await runFFmpeg(['-hide_banner', '-nostdin', '-y', '-i', filePath, '-map', `0:${analysis.streamIndex}`, '-c:a', 'copy', '-f', 'adts', tmp]);
        if (r.code !== 0 || !fs.existsSync(tmp)) throw new Error(`could not read audio packets (${r.tail.split('\n').filter(Boolean).pop() || r.code})`);
        const buf = fs.readFileSync(tmp);
        fs.rm(tmp, { force: true }, () => { });
        const frameRate = new Int8Array(analysis.packetCount).fill(analysis.declaredIndex);
        for (const run of analysis.runs) frameRate.fill(run.rate, run.start, run.end + 1);

        // Walk the ADTS frames, fix each header's sample-rate field, and cut the stream into
        // segments of constant rate.
        const segments = []; // { rate, from, to } byte ranges
        let off = 0, frame = 0, patched = 0;
        while (off + 7 <= buf.length) {
            if (buf[off] !== 0xFF || (buf[off + 1] & 0xF6) !== 0xF0) throw new Error(`ADTS sync lost at byte ${off}`);
            const len = ((buf[off + 3] & 0x03) << 11) | (buf[off + 4] << 3) | (buf[off + 5] >> 5);
            if (len < 7) throw new Error(`bad ADTS frame length at byte ${off}`);
            const want = frame < frameRate.length ? frameRate[frame] : analysis.declaredIndex;
            if (((buf[off + 2] >> 2) & 0x0F) !== want) {
                buf[off + 2] = (buf[off + 2] & ~(0x0F << 2)) | (want << 2);
                patched++;
            }
            const last = segments[segments.length - 1];
            if (last && last.rate === want) last.to = off + len;
            else segments.push({ rate: want, from: off, to: off + len });
            off += len;
            frame++;
        }
        if (frame !== analysis.packetCount) throw new Error(`frame count mismatch (${frame} ADTS frames vs ${analysis.packetCount} packets)`);

        // Decode each constant-rate segment on its own (so no decoder/filter ever sees a
        // mid-stream rate change), resample to 44.1kHz stereo, and stream the PCM back to
        // back into one AAC encoder. Sample-accurate and no multi-GB temp files.
        const m4aTmp = outPath + '.part.m4a';
        const encoder = spawn(getFFmpegBinary(), ['-hide_banner', '-nostdin', '-y', '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0',
            '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-f', 'mp4', m4aTmp], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        if (trackProcess) trackProcess(encoder);
        let encTail = '';
        encoder.stderr.on('data', (d) => { encTail = (encTail + d).slice(-2000); });
        const encoderDone = new Promise((resolve) => { encoder.on('close', resolve); encoder.on('error', () => resolve(-1)); });
        encoder.stdin.on('error', () => { });
        try {
            if (analysis.startOffset > 0.005) {
                // Silence for the audio's original lead-in (s16le stereo: 4 bytes per frame).
                const silence = Buffer.alloc(Math.round(analysis.startOffset * 44100) * 4);
                if (!encoder.stdin.write(silence)) await new Promise(r => encoder.stdin.once('drain', r));
            }
            for (let i = 0; i < segments.length; i++) {
                const segFile = `${outPath}.seg${i}.aac`;
                fs.writeFileSync(segFile, buf.subarray(segments[i].from, segments[i].to));
                const dec = spawn(getFFmpegBinary(), ['-hide_banner', '-nostdin', '-i', segFile, '-af', 'aresample=44100', '-ac', '2', '-f', 's16le', 'pipe:1'],
                    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
                if (trackProcess) trackProcess(dec);
                await new Promise((resolve, reject) => {
                    dec.stdout.on('data', (chunk) => {
                        if (!encoder.stdin.write(chunk)) {
                            dec.stdout.pause();
                            encoder.stdin.once('drain', () => dec.stdout.resume());
                        }
                    });
                    dec.on('error', reject);
                    dec.on('close', (code) => code === 0 ? resolve() : reject(new Error(`segment ${i + 1} decode failed (${code})`)));
                });
                fs.rm(segFile, { force: true }, () => { });
            }
        } finally {
            encoder.stdin.end();
        }
        const encCode = await encoderDone;
        if (encCode !== 0 || !fs.existsSync(m4aTmp)) throw new Error(`could not encode repaired audio (${encTail.split('\n').filter(Boolean).pop() || encCode})`);
        const got = parseFloat(await probeJson(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', m4aTmp])) || 0;
        if (Math.abs(got - (analysis.audioDuration + (analysis.startOffset || 0))) > 1.0) {
            fs.rm(m4aTmp, { force: true }, () => { });
            throw new Error(`repaired audio is ${got.toFixed(1)}s but the original track is ${analysis.audioDuration.toFixed(1)}s`);
        }
        fs.renameSync(m4aTmp, outPath);
        return patched;
    }

    // Returns { path, repaired, stretches } - path is the original file when nothing is wrong.
    async function getAudioSource(filePath) {
        const analysis = await analyze(filePath);
        if (!analysis.drift) return { path: filePath, repaired: false };
        const key = fileKey(filePath);
        const outPath = path.join(repairDir, `${key}.m4a`);
        if (failedRepairs.has(key)) return { path: filePath, repaired: false };
        if (!fs.existsSync(outPath)) {
            if (!repairJobs.has(key)) {
                repairJobs.set(key, buildRepaired(filePath, analysis, outPath)
                    .then((patched) => {
                        console.log(`[AudioRepair] ${path.basename(filePath)}: audio switches format mid-file (${analysis.stretches.map(s => `${s.fromSec}-${s.toSec}s @${s.rate}Hz`).join(', ')}; declared ${analysis.declaredRate}Hz) - fixed ${patched} frames`);
                        return outPath;
                    })
                    .catch((e) => { failedRepairs.add(key); console.warn('[AudioRepair] repair failed, using original audio:', e.message); return null; })
                    .finally(() => repairJobs.delete(key)));
            }
            const built = await repairJobs.get(key);
            if (!built) return { path: filePath, repaired: false };
        } else {
            const now = Date.now() / 1000;
            fs.utimes(outPath, now, now, () => { });
        }
        return { path: outPath, repaired: true, stretches: analysis.stretches };
    }

    // For callers that read the original file: which stream to map ("0:<index>"), or null.
    async function defaultAudioMap(filePath) {
        try {
            const { stream } = await selectAudioStream(filePath);
            return stream ? `0:${stream.index}` : null;
        } catch (e) { return null; }
    }

    async function needsRepair(filePath) {
        const a = await analyze(filePath);
        if (!a.drift) return false;
        try { return !failedRepairs.has(fileKey(filePath)); } catch (e) { return false; }
    }

    return { analyze, getAudioSource, defaultAudioMap, needsRepair };
}

module.exports = { createAudioRepair };
