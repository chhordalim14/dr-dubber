// Real line times for the Gemini Web Router.
// The Gemini website writes good lines but guesses their times (measured 2026-11-07: starts a
// median 3.7 s off on a 3-min clip). The PC hears the same clip (python/gemini_web_timing.py:
// VAD + Paraformer + fa-zh, in the VoxCPM2 venv) and knows when every Chinese character is
// spoken; each Gemini line then takes the time of its own characters (longest common
// subsequence over the characters). Measured: starts a median 0.23 s from the API's.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { trackProcess } = require('./process-tracker');

const VOX_DIR = path.join(os.homedir(), 'DR Dubber VoxCPM2');
const PYTHON = path.join(VOX_DIR, 'venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
const SCRIPT = path.join(__dirname, '..', 'python', 'gemini_web_timing.py').replace('app.asar', 'app.asar.unpacked');
const IDLE_STOP_MS = 10 * 60 * 1000;

function faModelDir() {
    const snaps = path.join(VOX_DIR, 'cache', 'models', 'iic--speech_timestamp_prediction-v1-16k-offline', 'snapshots');
    try {
        const sub = fs.readdirSync(snaps).find(d => fs.existsSync(path.join(snaps, d, 'model.pt')));
        return sub ? path.join(snaps, sub) : null;
    } catch (e) { return null; }
}

// Measured 2026-11-07 on a 3-min clip: CPU 20 s, GPU 12-14 s (1.2 GB of the 6 GB card), two CPU
// workers side by side 15.7 s each. A CPU worker beside the GPU one slowed both (4 clips: 78 s
// either way), so: one GPU worker when at least 2.5 GB of the card is free (VoxCPM2 keeps the
// GPU when it needs it), else up to two CPU workers, the second only while clips are waiting.
const MAX_WORKERS = Math.max(1, parseInt(process.env.GW_TIMING_MAX_WORKERS, 10) || 2);
const GPU_FREE_MB = 2500;
const workers = [];   // { proc, device, ready: Promise, busy, job }
const queue = [];     // { wav, resolve }
let seq = 0;
let idleTimer = null;
let lastError = null;

function available() {
    return fs.existsSync(PYTHON) && fs.existsSync(SCRIPT);
}

function gpuFreeMB() {
    try {
        const out = require('child_process').execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5000 }).toString();
        return parseInt(out.split(/\r?\n/)[0], 10) || 0;
    } catch (e) { return 0; }
}

function startWorker(device) {
    const proc = spawn(PYTHON, ['-I', SCRIPT, faModelDir() || ''], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GW_TIMING_DEVICE: device }
    });
    trackProcess(proc);
    const w = { proc, device, state: 'starting', busy: false, job: null, buf: '', alive: true };
    w.ready = new Promise((resolve, reject) => { w.onReady = resolve; w.onFail = reject; });
    w.ready.catch(() => {});
    proc.stdout.on('data', (d) => {
        w.buf += d.toString('utf8');
        let i;
        while ((i = w.buf.indexOf('\n')) >= 0) {
            const line = w.buf.slice(0, i).trim();
            w.buf = w.buf.slice(i + 1);
            if (!line.startsWith('{')) continue;
            let msg;
            try { msg = JSON.parse(line); } catch (e) { continue; }
            if ('ready' in msg) {
                if (msg.ready) { w.state = 'ready'; console.log(`[GeminiWeb timing] ${device.toUpperCase()} worker ready in ${(msg.loadMs / 1000).toFixed(1)} s`); w.onReady(); }
                else { w.state = 'failed'; lastError = msg.error; w.onFail(new Error(msg.error)); }
                continue;
            }
            const job = w.job;
            w.job = null;
            w.busy = false;
            if (job) job.resolve(msg);
            pump();
        }
    });
    let errTail = '';
    proc.stderr.on('data', (d) => { errTail = (errTail + d.toString('utf8')).slice(-2000); });
    proc.on('close', (code) => {
        w.alive = false;
        w.state = 'failed';
        const at = workers.indexOf(w);
        if (at >= 0) workers.splice(at, 1);
        const err = new Error(`Timing worker (${device}) stopped (code ${code}): ${errTail.split('\n').filter(Boolean).slice(-2).join(' | ')}`);
        w.onFail(err);
        if (w.job) { w.job.resolve({ ok: false, error: err.message }); w.job = null; }
        pump();
    });
    workers.push(w);
    // A GPU worker that cannot load (card busy, driver) is replaced by a CPU one.
    w.ready.then(() => pump(), () => {
        if (device === 'cuda') {
            console.warn(`[GeminiWeb timing] GPU worker failed (${lastError || 'stopped'}); using the CPU`);
            if (!workers.some(x => x.alive && x.device === 'cpu')) startWorker('cpu');
        }
        pump();
    });
    return w;
}

// Hand waiting clips to idle ready workers; start a worker when none can take them.
function pump() {
    const alive = workers.filter(w => w.alive);
    for (const w of alive) {
        if (!queue.length) break;
        if (w.busy || w.state !== 'ready') continue;
        const job = queue.shift();
        w.busy = true;
        w.job = job;
        w.proc.stdin.write(JSON.stringify({ id: ++seq, wav: job.wav }) + '\n');
    }
    if (!queue.length) return;
    const starting = alive.filter(w => w.state === 'starting').length;
    // A GPU worker works alone: a CPU one beside it slowed both down.
    if (alive.some(w => w.device === 'cuda' && w.state !== 'failed')) return;
    if (alive.length < MAX_WORKERS && starting === 0) {
        const device = !alive.some(w => w.device === 'cuda') && gpuFreeMB() >= GPU_FREE_MB ? 'cuda' : 'cpu';
        startWorker(device);
    }
}

function touchIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, IDLE_STOP_MS);
    if (idleTimer.unref) idleTimer.unref();
}

function stop() {
    clearTimeout(idleTimer);
    for (const w of workers.splice(0)) { try { w.proc.kill(); } catch (e) { } }
}

function toWav16k(ffmpeg, input, output) {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', output], { windowsHide: true });
        trackProcess(p);
        let err = '';
        p.stderr.on('data', d => { err += d; });
        p.on('error', reject);
        p.on('close', c => (c === 0 ? resolve() : reject(new Error(`ffmpeg: ${err.slice(-300)}`))));
    });
}

// [[char, start, end], ...] for an audio file (any format ffmpeg reads), times in seconds.
async function timelineFor(audioFile, { ffmpeg } = {}) {
    if (!available()) throw new Error('PC timing needs the VoxCPM2 install (its Python has the speech recogniser).');
    const ff = ffmpeg || require('../ffmpeg_env').getFFmpegBinary();
    const wav = path.join(os.tmpdir(), `gw_timing_${crypto.randomBytes(5).toString('hex')}.wav`);
    try {
        await toWav16k(ff, audioFile, wav);
        touchIdle();
        const msg = await new Promise((resolve) => { queue.push({ wav, resolve }); pump(); });
        touchIdle();
        if (!msg.ok) throw new Error(msg.error || 'timing failed');
        return msg.timeline;
    } finally {
        fs.promises.unlink(wav).catch(() => {});
    }
}

const sec = (v) => (typeof v === 'number' ? v : String(v || '0').split(':').map(Number).reduce((a, b) => a * 60 + b, 0));
const HAN = /[一-鿿]/g;

// Give each line ({start, end, originalText, ...}, times "MM:SS.ss" or seconds) the times of its
// own characters in the timeline. Lines whose characters are not found keep Gemini's time,
// shifted by how far off the nearest timed line before them was. Returns new line objects with
// numeric start/end plus `timedBy: 'pc' | 'shifted'`.
function retimeLines(lines, timeline) {
    const G = [];
    lines.forEach((l, li) => { for (const c of String(l.originalText || '').match(HAN) || []) G.push({ c, li }); });
    const n = G.length, m = timeline.length;
    const out = lines.map(l => ({ ...l, gStart: sec(l.start), gEnd: sec(l.end) }));
    if (!n || !m) {
        const plain = out.map(o => ({ ...o, start: o.gStart, end: o.gEnd, timedBy: 'shifted' }));
        plain.coverage = m ? 0 : 1;
        return plain;
    }
    // LCS table, rows from the end (Int32: clips are a few thousand characters at most).
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        const row = dp[i], next = dp[i + 1], c = G[i].c;
        for (let j = m - 1; j >= 0; j--) row[j] = c === timeline[j][0] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
    const match = new Int32Array(n).fill(-1);
    for (let i = 0, j = 0; i < n && j < m;) {
        if (G[i].c === timeline[j][0] && dp[i][j] === dp[i + 1][j + 1] + 1) { match[i] = j; i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
    }
    const byLine = out.map(() => []);
    G.forEach((g, i) => { if (match[i] >= 0) byLine[g.li].push(match[i]); });
    out.forEach((o, li) => {
        const total = G.filter(g => g.li === li).length;
        const js = byLine[li];
        if (js.length && js.length >= Math.max(1, total * 0.3)) {
            o.start = timeline[js[0]][1];
            o.end = timeline[js[js.length - 1]][2];
            o.timedBy = 'pc';
        }
    });
    for (let i = 0; i < out.length; i++) {
        if (out[i].timedBy) continue;
        let p = i - 1;
        while (p >= 0 && out[p].timedBy !== 'pc') p--;
        const shift = p >= 0 ? out[p].start - out[p].gStart : 0;
        out[i].start = Math.max(0, out[i].gStart + shift);
        out[i].end = Math.max(out[i].start + 0.3, out[i].gEnd + shift);
        out[i].timedBy = 'shifted';
    }
    // Share of the speech the PC heard that Gemini's lines cover (a short answer skipped lines).
    out.coverage = m ? Array.from(match).filter(j => j >= 0).length / m : 1;
    // Keep them in order without overlaps.
    for (let i = 1; i < out.length; i++) {
        if (out[i].start < out[i - 1].end) out[i].start = out[i - 1].end;
        if (out[i].end <= out[i].start) out[i].end = out[i].start + 0.3;
    }
    return out;
}

module.exports = { available, timelineFor, retimeLines, stop, lastError: () => lastError };
