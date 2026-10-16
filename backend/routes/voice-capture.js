// Capture Voice from Movie (VoxCPM2): cut a short reference clip of one actor
// straight out of the loaded video, so it can become a voice profile.
//   POST /voice-capture/window  the minute around the playhead, as a mono wav the
//                               page decodes to draw the wave, check and preview
//   POST /voice-capture/save    the picked 3-7 s, cleaned / EQ'd / levelled,
//                               written as a wav into the captures folder
// Both read the original file (never the preview proxy) and the same audio track
// the preview plays.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { resolveLocalFilePath, STORAGE_BASE, SEPARATED_DIR } = require('../lib/paths');
const { isNetworkPath, safeOutputFileName } = require('../lib/security');

const DEFAULT_CAPTURE_DIR = path.join(STORAGE_BASE, 'VoiceCaptures');
const WINDOW_RATE = 22050;     // enough for a wave, checks and a clear preview
const SAVE_RATE = 44100;
const MAX_WINDOW = 180;        // seconds the page may ask for in one go
const MAX_CLIP = 30;           // VoxCPM2 wants seconds, not minutes
const EQ_TYPES = new Set(['lowshelf', 'peaking', 'highshelf']);

// Layouts that carry a front-centre (dialogue) channel.
function layoutHasCenter(layout, channels) {
    const l = String(layout || '').toLowerCase();
    if (l) {
        if (/front\)$/.test(l)) return false; // 6.0(front) / 6.1(front) have no FC
        return /^(3\.0|3\.1|4\.0|4\.1|5\.0|5\.1|6\.0|6\.1|7\.0|7\.1|hexagonal|octagonal|hexadecagonal|22\.2)/.test(l);
    }
    return channels >= 6; // unlabelled 6+ channel track: almost always 5.1
}

const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
};

// The cleaning chain shared by the window (what you hear) and the save (what you get).
function cleanFilters({ center, hasCenter, denoise }) {
    const f = [];
    if (center && hasCenter) f.push('pan=mono|c0=FC');
    if (denoise) f.push('highpass=f=70', 'afftdn=nr=14:nf=-35:tn=1', 'lowpass=f=11000');
    return f;
}

function eqFilters(eq) {
    if (!Array.isArray(eq)) return [];
    return eq.slice(0, 8).map((b) => {
        const type = EQ_TYPES.has(b && b.type) ? b.type : 'peaking';
        const f = Math.round(num(b && b.f, 20, 20000, 1000));
        const g = num(b && b.g, -18, 18, 0).toFixed(2);
        const q = num(b && b.q, 0.1, 10, 1).toFixed(3);
        if (Math.abs(Number(g)) < 0.05) return null;
        if (type === 'lowshelf') return `lowshelf=f=${f}:g=${g}:t=q:w=${q}`;
        if (type === 'highshelf') return `highshelf=f=${f}:g=${g}:t=q:w=${q}`;
        return `equalizer=f=${f}:t=q:w=${q}:g=${g}`;
    }).filter(Boolean);
}

module.exports = function createVoiceCaptureRouter({ getFFmpegBinary, getFFprobeBinary, audioRepair, trackProcess }) {
    const router = express.Router();
    const probeCache = new Map(); // file key -> Promise<{ duration, stream }>

    function probe(filePath) {
        let key;
        try {
            const st = fs.statSync(filePath);
            key = `${filePath}|${st.size}|${st.mtimeMs}`;
        } catch (e) { return Promise.reject(e); }
        if (probeCache.has(key)) return probeCache.get(key);
        const job = new Promise((resolve, reject) => {
            execFile(getFFprobeBinary(), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
                { timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
                    if (err) return reject(err);
                    try {
                        const info = JSON.parse(stdout);
                        const audio = (info.streams || []).filter(s => s.codec_type === 'audio');
                        const stream = audio.find(s => s.disposition && s.disposition.default) || audio[0] || null;
                        const duration = parseFloat(info.format && info.format.duration) || parseFloat(stream && stream.duration) || 0;
                        resolve({ duration, stream });
                    } catch (e) { reject(e); }
                });
        });
        probeCache.set(key, job);
        if (probeCache.size > 16) probeCache.delete(probeCache.keys().next().value);
        job.catch(() => probeCache.delete(key));
        return job;
    }

    function runFfmpeg(args) {
        return new Promise((resolve, reject) => {
            const ff = spawn(getFFmpegBinary(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
            if (trackProcess) trackProcess(ff);
            let tail = '';
            ff.stderr.on('data', (d) => { tail = (tail + d).slice(-3000); });
            ff.on('error', reject);
            ff.on('close', (code) => {
                if (code === 0) return resolve();
                const last = tail.split('\n').map(l => l.trim()).filter(Boolean).pop();
                reject(new Error(`FFmpeg failed${last ? `: ${last}` : ''}`));
            });
        });
    }

    async function source(req) {
        const resolved = resolveLocalFilePath((req.body || {}).filePath);
        if (!resolved || !fs.existsSync(resolved)) throw Object.assign(new Error('The movie file was not found on disk.'), { status: 400 });
        const info = await probe(resolved);
        if (!info.stream) throw Object.assign(new Error('This video has no audio track.'), { status: 400 });
        const hasCenter = layoutHasCenter(info.stream.channel_layout, info.stream.channels || 0);
        const map = audioRepair ? await audioRepair.defaultAudioMap(resolved) : null;
        return { resolved, info, hasCenter, map };
    }

    router.post('/voice-capture/window', async (req, res) => {
        try {
            const body = req.body || {};
            const { resolved, info, hasCenter, map } = await source(req);
            const span = num(body.span, 5, MAX_WINDOW, 60);
            const total = info.duration || 0;
            const center = num(body.center, 0, total || 1e9, 0);
            let start = Math.max(0, center - span / 2);
            if (total && start + span > total) start = Math.max(0, total - span);
            const dur = total ? Math.min(span, total - start) : span;
            if (!(dur > 0.2)) return res.json({ success: false, error: 'The playhead is past the end of the movie.' });

            const opts = { center: !!body.center_only, hasCenter, denoise: !!body.denoise };
            const id = crypto.createHash('sha1')
                .update(`${resolved}|${start.toFixed(2)}|${dur.toFixed(2)}|${opts.center && hasCenter}|${opts.denoise}`)
                .digest('hex').slice(0, 16);
            const fileName = `vcap_${id}.wav`;
            const out = path.join(SEPARATED_DIR, fileName);
            if (!fs.existsSync(out)) {
                fs.mkdirSync(SEPARATED_DIR, { recursive: true });
                const filters = cleanFilters(opts);
                const tmp = `${out}.${process.pid}.tmp.wav`;
                await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-ss', start.toFixed(3), '-t', dur.toFixed(3),
                    '-i', resolved, ...(map ? ['-map', map] : []), '-vn',
                    ...(filters.length ? ['-af', filters.join(',')] : []),
                    '-ac', '1', '-ar', String(WINDOW_RATE), '-c:a', 'pcm_s16le', tmp]);
                fs.renameSync(tmp, out);
            }
            res.json({
                success: true,
                url: `/storage/separated/${fileName}`,
                start,
                duration: dur,
                movieDuration: total,
                hasCenter,
                channels: info.stream.channels || 0,
                layout: info.stream.channel_layout || ''
            });
        } catch (e) {
            res.status(e.status || 500).json({ success: false, error: e.message });
        }
    });

    router.post('/voice-capture/save', async (req, res) => {
        try {
            const body = req.body || {};
            const { resolved, info, hasCenter, map } = await source(req);
            const start = num(body.start, 0, info.duration || 1e9, 0);
            const end = num(body.end, start, (info.duration || 1e9), start);
            const dur = Math.min(MAX_CLIP, end - start);
            if (!(dur >= 0.5)) return res.json({ success: false, error: 'Pick at least half a second of speech.' });

            let dir = DEFAULT_CAPTURE_DIR;
            const want = typeof body.outDir === 'string' ? body.outDir.trim() : '';
            if (want) {
                // A full local path only: on Windows "\folder" is "the current
                // drive's root", which is never what the folder picker returns.
                const full = process.platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(want) : path.isAbsolute(want);
                if (isNetworkPath(want) || !full) {
                    return res.status(400).json({ success: false, error: 'Captures can only be saved to a folder on this PC.' });
                }
                dir = want;
            }
            fs.mkdirSync(dir, { recursive: true });

            let name = safeOutputFileName(`${String(body.name || '').trim() || 'Voice'}.wav`, ['.wav'], 'Voice.wav');
            const stem = name.slice(0, -4);
            for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stem} (${i}).wav`;
            const out = path.join(dir, name);

            const fade = Math.min(0.02, dur / 10).toFixed(3);
            const filters = [
                ...cleanFilters({ center: !!body.center_only, hasCenter, denoise: !!body.denoise }),
                ...eqFilters(body.eq),
                // A steady level: VoxCPM2 copies loudness as well as timbre.
                'loudnorm=I=-18:TP=-2:LRA=11',
                `afade=t=in:st=0:d=${fade}`,
                `afade=t=out:st=${Math.max(0, dur - Number(fade)).toFixed(3)}:d=${fade}`
            ];
            const tmp = path.join(dir, `.${name}.${process.pid}.tmp.wav`);
            try {
                await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-ss', start.toFixed(3), '-t', dur.toFixed(3),
                    '-i', resolved, ...(map ? ['-map', map] : []), '-vn', '-af', filters.join(','),
                    '-ac', '1', '-ar', String(SAVE_RATE), '-c:a', 'pcm_s16le', tmp]);
                fs.renameSync(tmp, out);
            } finally {
                try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { }
            }
            res.json({ success: true, filePath: out, fileName: name, dir, duration: dur });
        } catch (e) {
            res.status(e.status || 500).json({ success: false, error: e.message });
        }
    });

    router.get('/voice-capture/default-dir', (req, res) => {
        res.json({ success: true, dir: DEFAULT_CAPTURE_DIR });
    });

    return router;
};

module.exports.layoutHasCenter = layoutHasCenter;
module.exports.eqFilters = eqFilters;
