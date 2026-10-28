// Capture Voice from Movie (VoxCPM2): cut a short reference clip of one actor
// straight out of the loaded video, so it can become a voice profile.
//   POST /voice-capture/window  the minute around the playhead, as a mono wav the
//                               page decodes to draw the wave, check and preview
//   POST /voice-capture/save    the picked 3-7 s, cleaned / EQ'd / levelled,
//                               written as a wav into the captures folder
//   POST /voice-capture/speakers  Clone Voices from Video: who speaks each line
//                               (asked of the VoxCPM2 server), and a reference clip
//                               of each new speaker cut into the captures folder
// All read the original file (never the preview proxy) and the same audio track
// the preview plays.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { resolveLocalFilePath, STORAGE_BASE, SEPARATED_DIR } = require('../lib/paths');
const { isNetworkPath, safeOutputFileName } = require('../lib/security');
const { secureFetch } = require('../lib/secure-fetch');
const { loadSeriesSheet, loadSeriesSpeakers, seriesNameOf, seriesEnglishOf } = require('../lib/character-sheet');

const DEFAULT_CAPTURE_DIR = path.join(STORAGE_BASE, 'VoiceCaptures');
const CHARACTER_SHEETS_DIR = path.join(STORAGE_BASE, 'character_sheets'); // as server.js
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

// The folder captures go to: the one picked in Settings, else the default.
function captureDir(outDir) {
    let dir = DEFAULT_CAPTURE_DIR;
    const want = typeof outDir === 'string' ? outDir.trim() : '';
    if (want) {
        // A full local path only: on Windows "\folder" is "the current
        // drive's root", which is never what the folder picker returns.
        const full = process.platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(want) : path.isAbsolute(want);
        if (isNetworkPath(want) || !full) {
            throw Object.assign(new Error('Captures can only be saved to a folder on this PC.'), { status: 400 });
        }
        dir = want;
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// "<label>.wav", or "<label> (2).wav"... when that name is taken.
function freeName(dir, label) {
    let name = safeOutputFileName(`${String(label || '').trim() || 'Voice'}.wav`, ['.wav'], 'Voice.wav');
    const stem = name.slice(0, -4);
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stem} (${i}).wav`;
    return name;
}

// ── Clone Voices from Video: who speaks each line ────────────────────────
const SPEAKER_RATE = 16000;     // what the speaker model listens at
const SPEAKER_MAX_LINE = 15;    // seconds of one line sent for its voice print
const SPEAKER_GAP = 0.3;        // silence between lines in what is sent
const REF_TARGET = 6;           // seconds of a speaker's voice to clone from...
const REF_MAX = 10;             // ...and at most (VoxCPM2 cuts longer clips to 12 s)
const REF_PIECES = 4;           // lines joined into one clip at most
const REF_TRIM = 0.04;          // trimmed off each end of a line: no breath of the line before

// The lines' audio back to back (16 kHz mono wav), and each line's place in it.
// The movie is raw s16le at SPEAKER_RATE, `size` bytes long; read(a, b) gives bytes a..b of it
// (a 2-hour movie is 230 MB: only the lines are read).
function linesWav(read, size, lines) {
    const bps = SPEAKER_RATE * 2;
    const gap = Buffer.alloc(Math.round(SPEAKER_GAP * SPEAKER_RATE) * 2);
    const parts = [];
    const sent = [];
    let at = 0;
    for (const l of lines) {
        const a = Math.max(0, Math.floor(l.start * SPEAKER_RATE) * 2);
        const b = Math.min(size, Math.floor(Math.min(l.end, l.start + SPEAKER_MAX_LINE) * SPEAKER_RATE) * 2);
        if (!(b > a)) continue;
        parts.push(read(a, b), gap);
        sent.push({ id: l.id, start: +(at / bps).toFixed(3), end: +((at + b - a) / bps).toFixed(3), gender: l.gender, ...(l.name && { name: l.name }), ...(l.exact && { exact: true }) });
        at += b - a + gap.length;
    }
    const data = Buffer.concat(parts);
    const head = Buffer.alloc(44);
    head.write('RIFF', 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVEfmt ', 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);          // PCM
    head.writeUInt16LE(1, 22);          // mono
    head.writeUInt32LE(SPEAKER_RATE, 24);
    head.writeUInt32LE(bps, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36);
    head.writeUInt32LE(data.length, 40);
    return { wav: Buffer.concat([head, data]), sent };
}

// A speaker's clearest lines (best first), joined until there is enough voice to clone from.
function refPieces(lines) {
    const pieces = [];
    let total = 0;
    for (const l of lines) {
        const a = l.start + REF_TRIM;
        const b = Math.min(l.end - REF_TRIM, a + REF_MAX - total);
        if (!(b - a >= 0.8)) continue;
        pieces.push({ start: a, end: b });
        total += b - a;
        if (total >= REF_TARGET || total >= REF_MAX - 0.8 || pieces.length >= REF_PIECES) break;
    }
    return pieces;
}

// The feelings Transcribe hears on a line (server.js TRANSCRIBE_EMOTIONS).
const EMOTIONS = ['Neutral', 'Angry', 'Sad', 'Whisper', 'Excited', 'Royal', 'Romantic', 'Fear'];
const CALM_MIN = 3;       // seconds of calm lines for the main clip to be cut from them alone
const FEELING_MIN = 2.5;  // seconds of one feeling for that feeling to get a clip of its own
const CLIP_SHORT = 4;     // a main clip found here that is not calm and shorter than this...
const CLIP_GAIN = 1;      // ...is replaced by one at least this many seconds longer
const span = (pieces) => pieces.reduce((t, p) => t + p.end - p.start, 0);
const emotionOf = (v) => EMOTIONS.find((e) => e.toLowerCase() === String(v || '').trim().toLowerCase()) || 'Neutral';

// The clips to cut for one speaker, so each line is cloned from the actor in the same feeling:
// a calm main clip (VoxCPM2 copies the feeling of its clip: one cut from shouting made every
// line angry), and one clip per feeling they speak enough of. refLines are their clearest lines,
// best first, each with its .emotion. `have` is what an earlier episode already gave this voice
// ('Neutral' = a calm main clip, plus feelings), or null for a new speaker. `main`: that voice's
// main clip { seconds, own } (own: found here, not picked by hand), when known.
// Returns [{ emotion: null for the main clip | 'Angry'..., calm, pieces }].
function planClips(refLines, have, main = null) {
    const plans = [];
    const of = (e) => refLines.filter((l) => l.emotion === e);
    if (!have || !have.has('Neutral')) {
        const calm = refPieces(of('Neutral'));
        // A voice first heard in a few short lines got its clip from them: 1.3 s of one excited
        // line (员工, E47) sounded least like its actor of 11 voices (ERes2NetV2 0.31, the rest
        // 0.42-0.61). A later episode with more of them gives it a longer one.
        const short = !!(main && main.own && main.seconds < CLIP_SHORT);
        if (span(calm) >= CALM_MIN) {
            plans.push({ emotion: null, calm: true, pieces: calm });
        } else if (!have || short) {
            const any = refPieces(refLines); // hardly a calm word: their clearest lines, whatever the feeling
            if (any.length && (!have || span(any) >= main.seconds + CLIP_GAIN)) plans.push({ emotion: null, calm: false, pieces: any });
        }
    }
    for (const e of EMOTIONS.slice(1)) {
        if (have && have.has(e)) continue;
        const pieces = refPieces(of(e));
        if (span(pieces) >= FEELING_MIN) plans.push({ emotion: e, calm: false, pieces });
    }
    return plans;
}

// ── A line's own voice, for VoxCPM2 to take its feeling from ─────────────
// A shorter line is too little to clone from: measured on 21 lines under 1.6 s, cloning from the
// line itself misheard more of the Khmer (+3 points, worse on 29% of them by over 10) and lost some
// of the voice, where on 56 longer lines it misheard less (-2.5 points). The page then uses the
// actor's clip of the line's feeling.
const LINE_MIN = 1.6;
const LINE_MAX = 12;     // VoxCPM2 cuts a longer reference to 12 s anyway
const LINE_EDGE = 0.05;  // kept around the line's times: its first and last sounds
const LEVEL_RATE = 8000; // enough to hear how loud speech is

// How loud speech is (dB), from the power of its 50 ms frames: the mean of those within 30 dB of
// the loudest ones, so the pauses between words and the quiet between lines do not count.
function speechLevelDb(frames) {
    const sorted = frames.filter((p) => p > 1e-10).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const top = sorted[Math.floor((sorted.length - 1) * 0.99)];
    const speech = sorted.filter((p) => p >= top / 1000);
    return 10 * Math.log10(speech.reduce((s, p) => s + p, 0) / speech.length);
}

// Collects the power of each 50 ms frame of 16-bit mono PCM fed to it in pieces of any size.
function framePowers(rate) {
    const hop = Math.max(1, Math.round(rate * 0.05));
    const frames = [];
    let sum = 0, n = 0, odd = null;
    return {
        frames,
        push(buf) {
            if (odd) { buf = Buffer.concat([odd, buf]); odd = null; }
            const even = buf.length - (buf.length % 2);
            for (let i = 0; i < even; i += 2) {
                const v = buf.readInt16LE(i);
                sum += v * v;
                if (++n === hop) { frames.push(sum / hop / (32768 * 32768)); sum = 0; n = 0; }
            }
            if (even < buf.length) odd = buf.subarray(even);
        },
    };
}

// The data chunk of a 16-bit wav file.
function wavData(buf) {
    let at = 12;
    while (at + 8 <= buf.length) {
        const size = buf.readUInt32LE(at + 4);
        if (buf.toString('ascii', at, at + 4) === 'data') return buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
        at += 8 + size + (size % 2);
    }
    return Buffer.alloc(0);
}

// Seconds of a wav file from its header, or null when it cannot be read as one.
function wavSeconds(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(4096);
        const n = fs.readSync(fd, head, 0, head.length, 0);
        if (n < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
        let at = 12;
        let byteRate = 0;
        while (at + 8 <= n) {
            const id = head.toString('ascii', at, at + 4);
            const size = head.readUInt32LE(at + 4);
            if (id === 'fmt ') byteRate = head.readUInt32LE(at + 16);
            if (id === 'data') return byteRate > 0 ? Math.min(size, fs.fstatSync(fd).size - at - 8) / byteRate : null;
            at += 8 + size + (size % 2);
        }
        return null;
    } catch (e) {
        return null;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { }
    }
}

module.exports = function createVoiceCaptureRouter({ getFFmpegBinary, getFFprobeBinary, audioRepair, trackProcess, findVocalStem }) {
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
        const vocalStem = findVocalStem ? findVocalStem(resolved) : null;
        return { resolved, info, hasCenter, map, vocalStem };
    }

    router.post('/voice-capture/window', async (req, res) => {
        try {
            const body = req.body || {};
            const { resolved, info, hasCenter, map, vocalStem } = await source(req);
            const span = num(body.span, 5, MAX_WINDOW, 60);
            const total = info.duration || 0;
            const center = num(body.center, 0, total || 1e9, 0);
            let start = Math.max(0, center - span / 2);
            if (total && start + span > total) start = Math.max(0, total - span);
            const dur = total ? Math.min(span, total - start) : span;
            if (!(dur > 0.2)) return res.json({ success: false, error: 'The playhead is past the end of the movie.' });

            const audioInput = vocalStem || resolved;
            const inputMap = vocalStem ? [] : (map ? ['-map', map] : []);
            const opts = { center: !vocalStem && !!body.center_only, hasCenter: !vocalStem && hasCenter, denoise: !!body.denoise };
            const id = crypto.createHash('sha1')
                .update(`${audioInput}|${start.toFixed(2)}|${dur.toFixed(2)}|${opts.center && hasCenter}|${opts.denoise}`)
                .digest('hex').slice(0, 16);
            const fileName = `vcap_${id}.wav`;
            const out = path.join(SEPARATED_DIR, fileName);
            if (!fs.existsSync(out)) {
                fs.mkdirSync(SEPARATED_DIR, { recursive: true });
                const filters = cleanFilters(opts);
                const tmp = `${out}.${process.pid}.tmp.wav`;
                await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-ss', start.toFixed(3), '-t', dur.toFixed(3),
                    '-i', audioInput, ...inputMap, '-vn',
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
            const { resolved, info, hasCenter, map, vocalStem } = await source(req);
            const start = num(body.start, 0, info.duration || 1e9, 0);
            const end = num(body.end, start, (info.duration || 1e9), start);
            const dur = Math.min(MAX_CLIP, end - start);
            if (!(dur >= 0.5)) return res.json({ success: false, error: 'Pick at least half a second of speech.' });

            const dir = captureDir(body.outDir);
            const name = freeName(dir, body.name);
            const out = path.join(dir, name);

            const fade = Math.min(0.02, dur / 10).toFixed(3);
            const audioInput = vocalStem || resolved;
            const inputMap = vocalStem ? [] : (map ? ['-map', map] : []);
            // The separated vocals when the movie has them: no music under the voice to clone.
            const filters = [
                ...cleanFilters({ center: !vocalStem && !!body.center_only, hasCenter: !vocalStem && hasCenter, denoise: !!body.denoise }),
                ...eqFilters(body.eq),
                // A steady level: VoxCPM2 copies loudness as well as timbre.
                'loudnorm=I=-18:TP=-2:LRA=11',
                `afade=t=in:st=0:d=${fade}`,
                `afade=t=out:st=${Math.max(0, dur - Number(fade)).toFixed(3)}:d=${fade}`
            ];
            const tmp = path.join(dir, `.${name}.${process.pid}.tmp.wav`);
            try {
                await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-ss', start.toFixed(3), '-t', dur.toFixed(3),
                    '-i', audioInput, ...inputMap, '-vn', '-af', filters.join(','),
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

    // The movie's audio as raw 16 kHz mono s16le (the dialogue channel of a 5.1 track: less
    // music under the voices), cached beside the other separated audio.
    async function dialoguePcm(resolved, hasCenter, map, vocalStem) {
        const audioInput = vocalStem || resolved;
        const st = fs.statSync(audioInput);
        const id = crypto.createHash('sha1').update(`${audioInput}|${st.size}|${st.mtimeMs}|${map}|${hasCenter}`).digest('hex').slice(0, 16);
        const out = path.join(SEPARATED_DIR, `spk_${id}.pcm`);
        if (!fs.existsSync(out)) {
            fs.mkdirSync(SEPARATED_DIR, { recursive: true });
            const tmp = `${out}.${process.pid}.tmp`;
            try {
                await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', audioInput, ...(!vocalStem && map ? ['-map', map] : []), '-vn',
                    ...(!vocalStem && hasCenter ? ['-af', 'pan=mono|c0=FC'] : []),
                    '-ac', '1', '-ar', String(SPEAKER_RATE), '-f', 's16le', '-c:a', 'pcm_s16le', tmp]);
                fs.renameSync(tmp, out);
            } finally {
                try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { }
            }
        }
        return out;
    }

    // One speaker's reference clip: their clearest lines cut from the isolated vocals or file,
    // joined with a short pause, cleaned and levelled like a capture.
    async function cutReference({ resolved, hasCenter, map, pieces, out, vocalStem }) {
        const audioInput = vocalStem || resolved;
        const args = ['-hide_banner', '-nostdin', '-y'];
        pieces.forEach((p) => args.push('-ss', p.start.toFixed(3), '-t', (p.end - p.start).toFixed(3), '-i', audioInput));
        const stream = vocalStem || !map ? 'a:0' : map.split(':')[1];
        const clean = vocalStem ? [] : cleanFilters({ center: true, hasCenter, denoise: false });
        const chains = pieces.map((p, i) => {
            const fade = Math.min(0.02, (p.end - p.start) / 10).toFixed(3);
            return `[${i}:${stream}]${[...clean, 'aformat=channel_layouts=mono', `afade=t=in:st=0:d=${fade}`,
            `afade=t=out:st=${Math.max(0, p.end - p.start - Number(fade)).toFixed(3)}:d=${fade}`,
            ...(i < pieces.length - 1 ? ['apad=pad_dur=0.15'] : [])].join(',')}[p${i}]`;
        });
        const graph = `${chains.join(';')};${pieces.map((p, i) => `[p${i}]`).join('')}concat=n=${pieces.length}:v=0:a=1,loudnorm=I=-18:TP=-2:LRA=11[out]`;
        const tmp = path.join(path.dirname(out), `.${path.basename(out)}.${process.pid}.tmp.wav`);
        try {
            await runFfmpeg([...args, '-filter_complex', graph, '-map', '[out]', '-ac', '1', '-ar', String(SAVE_RATE), '-c:a', 'pcm_s16le', tmp]);
            fs.renameSync(tmp, out);
        } finally {
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { }
        }
    }

    // Clone Voices from Video: groups the lines by who speaks them (the VoxCPM2 server's
    // /api/speakers) and cuts each speaker's clips (planClips: a calm one, and one per feeling)
    // that an earlier episode has not given their voice yet.
    // Lines: [{ id, start, end, gender, emotion }] in the movie's own time.
    router.post('/voice-capture/speakers', async (req, res) => {
        let sentFile = null;
        try {
            const body = req.body || {};
            const lines = (Array.isArray(body.lines) ? body.lines : [])
                .map((l) => ({
                    id: String(l && l.id),
                    start: Number(l && l.start),
                    end: Number(l && l.end),
                    gender: /^(male|female)$/i.test(String(l && l.gender)) ? String(l.gender) : null,
                    emotion: emotionOf(l && l.emotion),
                    // The character Transcribe named, and whether the times are the video's own subtitle's.
                    name: l && l.name ? String(l.name).trim().slice(0, 60) : null,
                    exact: !!(l && l.exact),
                }))
                .filter((l) => Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start);
            if (!lines.length) return res.status(400).json({ success: false, error: 'There are no timed lines to listen to.' });
            const { resolved, hasCenter, map, vocalStem } = await source(req);
            // Names by their person: an earlier episode's voice for 陆宴辞 is 陆晏辞's in this one
            // (transcripts made before Transcribe gave one name per person still have both).
            const seriesSheet = loadSeriesSheet(CHARACTER_SHEETS_DIR, resolved);
            const seriesSpeakers = loadSeriesSpeakers(CHARACTER_SHEETS_DIR, resolved);
            const nameOf = seriesNameOf(seriesSheet, seriesSpeakers);
            const englishOf = seriesEnglishOf(seriesSheet, seriesSpeakers); // the name the page shows
            lines.forEach((l) => { if (l.name) l.name = nameOf(l.name); });

            // Same host rule as /api/generate-voxcmp2 (Node 18+ resolves localhost to ::1 first).
            let base = String(body.serverUrl || 'http://127.0.0.1:8808').trim().replace(/\/+$/, '').replace('localhost', '127.0.0.1');
            if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
            const local = /^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(base);

            const pcm = await dialoguePcm(resolved, hasCenter, map, vocalStem);
            const fd = fs.openSync(pcm, 'r');
            let packed;
            try {
                const read = (a, b) => {
                    const buf = Buffer.alloc(b - a);
                    fs.readSync(fd, buf, 0, b - a, a);
                    return buf;
                };
                packed = linesWav(read, fs.fstatSync(fd).size, lines);
            } finally {
                fs.closeSync(fd);
            }
            const known = Array.isArray(body.known) ? body.known.slice(0, 1000) : [];
            // The clips each earlier voice already has: only the feelings it lacks are cut.
            const haveOf = new Map();
            const mainOf = new Map(); // id -> { seconds, own } of its main clip
            known.forEach((k) => {
                if (!k || !k.id) return;
                const have = haveOf.get(k.id) || new Set();
                (Array.isArray(k.emotions) ? k.emotions : []).forEach((e) => have.add(emotionOf(e)));
                haveOf.set(k.id, have);
                if (!mainOf.has(k.id) && k.own) {
                    // Voices made before the page kept the clip's length: read it from the clip.
                    const seconds = Number(k.clipSeconds) > 0 ? Number(k.clipSeconds) : wavSeconds(resolveLocalFilePath(k.clip));
                    if (seconds != null) mainOf.set(k.id, { seconds, own: true });
                }
            });
            const payload = { lines: packed.sent, known: known.map((k) => ({ id: k && k.id, gender: k && k.gender, embedding: k && k.embedding, model: k && k.model, name: k && k.name ? nameOf(String(k.name)) : null })) };
            if (local) {
                // A local server reads the file itself instead of a JSON body hundreds of MB long.
                sentFile = path.join(SEPARATED_DIR, `spk_lines_${crypto.randomUUID()}.wav`);
                fs.writeFileSync(sentFile, packed.wav);
                payload.audio_path = sentFile;
            } else {
                payload.audio_base64 = packed.wav.toString('base64');
            }

            let r;
            try {
                r = await secureFetch(`${base}/api/speakers`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(15 * 60 * 1000),
                });
            } catch (e) {
                return res.status(503).json({ success: false, error: 'The VoxCPM2 server is not running. Start it in Settings → VoxCPM2 AI.' });
            }
            if (r.status === 404) {
                return res.status(501).json({ success: false, error: 'This VoxCPM2 server cannot find speakers yet. Restart it from Settings → VoxCPM2 AI (Stop, then Start Server) to update it.' });
            }
            const data = await r.json().catch(() => ({}));
            if (!r.ok || !data.success) throw new Error(data.error || `The VoxCPM2 server answered ${r.status}.`);

            const byId = new Map(lines.map((l) => [l.id, l]));
            const dir = captureDir(body.outDir);
            const stem = String(body.name || '').trim() || 'Speaker';
            const speakers = [];
            for (const s of Array.isArray(data.speakers) ? data.speakers : []) {
                const sp = {
                    key: s.key,
                    gender: s.gender || null,
                    name: s.name || null,
                    english: (s.name && englishOf(s.name)) || null,
                    lines: Array.isArray(s.lines) ? s.lines.map(String) : [],
                    seconds: s.seconds || 0,
                    embedding: Array.isArray(s.embedding) ? s.embedding : null,
                    known: s.known || null,
                    emotionClips: {},
                };
                const refLines = (s.refs || []).map((id) => byId.get(String(id))).filter(Boolean);
                const have = sp.known ? haveOf.get(sp.known) || new Set() : null;
                for (const plan of planClips(refLines, have, sp.known ? mainOf.get(sp.known) : null)) {
                    const name = freeName(dir, `${stem} - ${s.key}${plan.emotion ? ` - ${plan.emotion}` : ''}`);
                    const out = path.join(dir, name);
                    await cutReference({ resolved, hasCenter, map, pieces: plan.pieces, out, vocalStem });
                    const seconds = +span(plan.pieces).toFixed(1);
                    if (plan.emotion) sp.emotionClips[plan.emotion] = { filePath: out, fileName: name, seconds };
                    else Object.assign(sp, { filePath: out, fileName: name, clipSeconds: seconds, calm: plan.calm });
                }
                speakers.push(sp);
            }
            // The model that made the embeddings: prints of different models are never compared.
            // source: what the prints were made from ('vocals' once Isolate BGM has the stems).
            res.json({ success: true, speakers, dir, printModel: data.print_model || 'campplus', source: vocalStem ? 'vocals' : 'mix' });
        } catch (e) {
            res.status(e.status || 500).json({ success: false, error: e.message });
        } finally {
            try { if (sentFile && fs.existsSync(sentFile)) fs.unlinkSync(sentFile); } catch (e) { }
        }
    });

    // One line as the actor said it (wav, base64), for VoxCPM2 to speak the dub line the same
    // way: from this file's separated vocals once an ML engine has isolated it (Isolate BGM
    // runs beside the voicing in a series), else the dialogue of the original track (the
    // VoxCPM2 server cleans a noisy clip). Body: { filePath, start, end } in the video's time.
    // How loud the dialogue of a whole file is (dB, speechLevelDb), measured once per file.
    const levelCache = new Map(); // src|size|mtime|filters -> Promise<dB | null>
    function dialogueLevel(src, map, filters) {
        let key;
        try {
            const st = fs.statSync(src);
            key = `${src}|${st.size}|${st.mtimeMs}|${map}|${filters.join(',')}`;
        } catch (e) { return Promise.resolve(null); }
        if (levelCache.has(key)) return levelCache.get(key);
        const job = new Promise((resolve) => {
            const fp = framePowers(LEVEL_RATE);
            const ff = spawn(getFFmpegBinary(), ['-hide_banner', '-nostdin', '-i', src, ...(map ? ['-map', map] : []), '-vn',
                ...(filters.length ? ['-af', filters.join(',')] : []), '-ac', '1', '-ar', String(LEVEL_RATE), '-f', 's16le', 'pipe:1'],
                { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            if (trackProcess) trackProcess(ff);
            ff.stdout.on('data', (d) => fp.push(d));
            ff.on('error', () => resolve(null));
            ff.on('close', (code) => resolve(code === 0 ? speechLevelDb(fp.frames) : null));
        });
        levelCache.set(key, job);
        if (levelCache.size > 32) levelCache.delete(levelCache.keys().next().value);
        job.then((v) => { if (v == null) levelCache.delete(key); });
        return job;
    }

    router.post('/voice-capture/line', async (req, res) => {
        let tmp = null;
        try {
            const body = req.body || {};
            const start = Number(body.start);
            const end = Number(body.end);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < LINE_MIN) {
                return res.json({ success: false, error: 'The line is too short to take its delivery from.' });
            }
            const { resolved, hasCenter, map, vocalStem } = await source(req);
            const stem = vocalStem;
            const a = Math.max(0, start - LINE_EDGE);
            const dur = Math.min(LINE_MAX, end - start + 2 * LINE_EDGE);
            const fade = Math.min(0.02, dur / 10).toFixed(3);
            const pick = stem ? [] : cleanFilters({ center: true, hasCenter, denoise: false });
            const filters = [
                ...pick,
                'aformat=channel_layouts=mono',
                `afade=t=in:st=0:d=${fade}`,
                `afade=t=out:st=${Math.max(0, dur - Number(fade)).toFixed(3)}:d=${fade}`,
            ];
            fs.mkdirSync(SEPARATED_DIR, { recursive: true });
            tmp = path.join(SEPARATED_DIR, `line_${crypto.randomUUID()}.wav`);
            await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-ss', a.toFixed(3), '-t', dur.toFixed(3),
                '-i', stem || resolved, ...(!stem && map ? ['-map', map] : []), '-vn', '-af', filters.join(','),
                '-ac', '1', '-ar', String(SAVE_RATE), '-c:a', 'pcm_s16le', tmp]);
            const wav = fs.readFileSync(tmp);
            // How loud the actor said it against the film's dialogue as a whole (+ a shout, - a
            // whisper), so the dub line can be as loud: the voice server levels every line alike.
            const lineFp = framePowers(SAVE_RATE);
            lineFp.push(wavData(wav));
            const lineDb = speechLevelDb(lineFp.frames);
            const filmDb = lineDb == null ? null : await dialogueLevel(stem || resolved, stem ? null : map, pick);
            // source: 'vocals' (separated), 'center' (a 5.1 track's dialogue channel) or 'mix' (the
            // music under it too: the page does not clone a line's delivery from that).
            res.json({
                success: true,
                audio_base64: wav.toString('base64'),
                source: stem ? 'vocals' : hasCenter ? 'center' : 'mix',
                seconds: +dur.toFixed(2),
                level_db: lineDb != null && filmDb != null ? +(lineDb - filmDb).toFixed(1) : null,
            });
        } catch (e) {
            res.status(e.status || 500).json({ success: false, error: e.message });
        } finally {
            try { if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { }
        }
    });

    router.get('/voice-capture/default-dir', (req, res) => {
        res.json({ success: true, dir: DEFAULT_CAPTURE_DIR });
    });

    return router;
};

module.exports.layoutHasCenter = layoutHasCenter;
module.exports.eqFilters = eqFilters;
module.exports.linesWav = linesWav;
module.exports.refPieces = refPieces;
module.exports.planClips = planClips;
module.exports.speechLevelDb = speechLevelDb;
module.exports.framePowers = framePowers;
module.exports.wavData = wavData;
module.exports.wavSeconds = wavSeconds;
