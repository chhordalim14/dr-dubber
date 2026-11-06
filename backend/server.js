// IPv4-first DNS: see main.js. Repeated here so `npm run server` gets it too.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) {}
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec, execFile, execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const multer = require('multer');
const { ensureFFmpegInPath, getFFmpegBinary, getFFprobeBinary } = require('./ffmpeg_env');
const { createPreviewService } = require('./media_preview');
const { createAudioRepair } = require('./audio_repair');
const { createEpisodeJoiner } = require('./episode_joiner');
const { createVideoSplitter } = require('./video_splitter');
const { renderVideo, cancelRender, getRenderProgress, detectAvailableEncoders } = require('./render_service');

const app = express();
const PORT = process.env.PORT || 3001;

// Force UTF-8 I/O on every spawned Python child so non-ASCII text (Khmer, Thai,
// Chinese, emoji log markers) can't crash the process with UnicodeEncodeError
// when stdio is piped instead of attached to a real console (common on Windows).
const PYTHON_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

// High-speed TTS Audio In-Memory & Disk Cache. Unbounded across a long dubbing session
// (hundreds of unique lines) would leak memory forever, so cap size and add TTL eviction.
const ttsCache = new Map();
const TTS_CACHE_MAX_ENTRIES = 2000;
const TTS_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
// 'trim1': clips now have Edge's silent lead/tail trimmed, so a cached entry made before
// that (with a longer duration) must never be reused. Bump it if the trimming changes.
const TTS_CACHE_VERSION = 'trim1';
function getTtsCacheKey(text, voice, rate, pitch, volume, speed, emotion) {
    const raw = `${TTS_CACHE_VERSION}|${text || ''}|${voice || ''}|${rate || ''}|${pitch || ''}|${volume || ''}|${speed || 1.0}|${emotion || 'Neutral'}`;
    return crypto.createHash('md5').update(raw).digest('hex');
}
// tts_generator.py writes "[TTS trim] kept original (...)" to stderr whenever it can't trim a
// clip (no FFmpeg, a failed re-encode, a locked file...). The clip is still fine, so the TTS
// call succeeds and its stderr would otherwise be dropped - pass those notes on, so a trim
// that silently stopped working (every voice back to Edge's ~1s of padding) shows up in the
// server log. A whole batch can hit the same problem, so only the first few are printed.
const TTS_TRIM_NOTES_SHOWN = 5;
function logTtsTrimNotes(stderr) {
    const notes = String(stderr || '').split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('[TTS trim]'));
    notes.slice(0, TTS_TRIM_NOTES_SHOWN).forEach(l => console.warn(l));
    if (notes.length > TTS_TRIM_NOTES_SHOWN) {
        console.warn(`[TTS trim] ...and ${notes.length - TTS_TRIM_NOTES_SHOWN} more clip(s) kept their original padding`);
    }
    return notes.length;
}
function setTtsCache(key, value) {
    if (ttsCache.size >= TTS_CACHE_MAX_ENTRIES) {
        const oldestKey = ttsCache.keys().next().value;
        if (oldestKey !== undefined) ttsCache.delete(oldestKey);
    }
    ttsCache.set(key, { ...value, timestamp: Date.now() });
}

// Directory layout (safe for dev & packaged Electron)
// Storage layout, the local-file-path resolver and child-process tracking
// now live in backend/lib/ so the route modules under backend/routes/ can
// use them too without depending on this whole file.
const {
    ROOT_DIR, STORAGE_BASE, UPLOADS_DIR, AUDIO_CACHE_DIR, SEPARATED_DIR,
    PREVIEW_DIR, AUDIO_REPAIR_DIR, EXPORTS_DIR, OUTPUTS_DIR, CUSTOM_OUTPUTS_DIR,
    USER_DESKTOP_OUTPUTS, PYTHON_DIR, LOGS_DIR,
    MIME_MAP, resolveLocalFilePath
} = require('./lib/paths');
const security = require('./lib/security');
const { isNetworkPath, isServableMedia, isAudioFile } = security;
// Everything the server prints also goes to <storage>/logs/server.log (see lib/server-log.js).
require('./lib/server-log').installServerLog(LOGS_DIR);
const { hasForeignText, stripForeignScript, collapseRepeatedPartSuffix, buildTtsArgv } = require('./lib/text-rules');
const { trackProcess } = require('./lib/process-tracker');
// Which Gemini keys are resting (refused, or over a limit) - kept on disk across restarts.
const keyRest = require('./lib/key-rest').createKeyRest({ file: path.join(STORAGE_BASE, 'gemini_key_rest.json') });
process.on('exit', () => keyRest.save());
const { createTtsWorker } = require('./lib/tts-worker');
const { secureFetch, fetchBackend } = require('./lib/secure-fetch');
const { createCodeCraftClient } = require('./lib/codecraft');
const { KHMER_SYLLABLES_PER_SEC, KHMER_DUBBING_RULES, khmerMaxSyllables, lineSeconds, getKhmerDramaRegisterGuidance, parseSrtBlocksForTranslate, translatePromptLine, buildTranslateSystemPrompt, buildTranslateUserPrompt, buildReviewSystemPrompt, buildReviewUserPrompt, estimateSpeechSeconds, findOverlongLines } = require('./lib/khmer-prompts');
const { MISSING_RESPONSE_SCHEMA, buildMissingLinesPrompt, checkMissingLine } = require('./lib/missing-lines');
const { CHARACTER_SHEET_SCHEMA, normalizeSheet, mergeSheets, sheetSize, applyGlossaryToSheet, formatSheetForPrompt, buildCharacterSheetPrompt, loadSeriesSheet, saveSeriesSheet, loadSeriesSpeakers, saveSeriesSpeakers, addSeriesSpeakers, seriesNameOf, foldSpeakers, formatSpeakersForPrompt, castDir, withSeriesLock } = require('./lib/character-sheet');

// Clean stale temporary cache files (> 7 days old) asynchronously to prevent disk bloat
function cleanStaleTempFiles() {
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    [AUDIO_CACHE_DIR, UPLOADS_DIR, SEPARATED_DIR, PREVIEW_DIR, AUDIO_REPAIR_DIR].forEach((dir) => {
        if (!fs.existsSync(dir)) return;
        fs.readdir(dir, (err, files) => {
            if (err || !files) return;
            files.forEach((file) => {
                const fp = path.join(dir, file);
                fs.stat(fp, (err, stats) => {
                    if (!err && stats && stats.isFile() && (now - stats.mtimeMs > maxAgeMs)) {
                        fs.unlink(fp, () => {});
                    }
                });
            });
        });
    });
}
setTimeout(cleanStaleTempFiles, 5000);
setInterval(cleanStaleTempFiles, 60 * 60 * 1000);

function isWorkingPython(pythonBin) {
    if (!pythonBin || typeof pythonBin !== 'string') return false;
    if (pythonBin.includes('app.asar') && !pythonBin.includes('app.asar.unpacked')) return false;
    try {
        if (path.isAbsolute(pythonBin) && !fs.existsSync(pythonBin)) return false;
        execFileSync(pythonBin, ['-c', 'import sys; sys.exit(0)'], {
            encoding: 'utf8',
            timeout: 2500,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        return true;
    } catch (e) {
        return false;
    }
}

function getPythonCmd() {
    if (process.env.PYTHON_PATH && isWorkingPython(process.env.PYTHON_PATH)) {
        return process.env.PYTHON_PATH;
    }
    if (process.env.PYTHON_BIN && isWorkingPython(process.env.PYTHON_BIN)) {
        return process.env.PYTHON_BIN;
    }

    const isWin = process.platform === 'win32';
    const subPath = isWin ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
    const unpackedRootDir = ROOT_DIR.includes('app.asar') ? ROOT_DIR.replace('app.asar', 'app.asar.unpacked') : ROOT_DIR;

    const candidatePaths = [
        path.join(unpackedRootDir, 'backend', 'python_env', isWin ? 'python.exe' : 'python'),
        path.join(ROOT_DIR, 'backend', 'python_env', isWin ? 'python.exe' : 'python'),
        path.join(unpackedRootDir, 'backend', 'demucs-env', subPath),
        path.join(ROOT_DIR, 'backend', 'demucs-env', subPath),
        path.join(unpackedRootDir, 'backend', 'spleeter-env', subPath),
        path.join(ROOT_DIR, 'backend', 'spleeter-env', subPath),
        path.join(unpackedRootDir, 'backend', 'venv', subPath),
        path.join(ROOT_DIR, 'backend', 'venv', subPath),
        path.join(unpackedRootDir, '.venv', subPath),
        path.join(ROOT_DIR, '.venv', subPath),
    ];

    if (isWin) {
        const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
        if (localAppData) {
            candidatePaths.push(path.join(localAppData, 'Programs', 'DR Dubber Pro', 'resources', 'app.asar.unpacked', 'backend', 'python_env', 'python.exe'));
            ['Python311', 'Python310', 'Python312', 'Python39', 'Python313'].forEach(v => {
                candidatePaths.push(path.join(localAppData, 'Programs', 'Python', v, 'python.exe'));
            });
        }
        const pf = process.env.ProgramFiles || 'C:\\Program Files';
        ['Python311', 'Python310', 'Python312', 'Python39', 'Python313'].forEach(v => {
            candidatePaths.push(path.join(pf, v, 'python.exe'));
        });
    }

    for (const cand of candidatePaths) {
        if (!cand || (cand.includes('app.asar') && !cand.includes('app.asar.unpacked'))) continue;
        try {
            if (fs.existsSync(cand) && fs.statSync(cand).isFile() && isWorkingPython(cand)) {
                return cand;
            }
        } catch (e) {}
    }

    // Try system python commands only if verified operational
    const systemCommands = isWin ? ['python', 'py -3'] : ['python3', 'python'];
    for (const cmd of systemCommands) {
        if (isWorkingPython(cmd)) {
            return cmd;
        }
    }

    return null;
}
const PYTHON_CMD = getPythonCmd();

function getSpleeterPythonCmd() {
    if (process.env.SPLEETER_PYTHON && isWorkingPython(process.env.SPLEETER_PYTHON)) {
        return process.env.SPLEETER_PYTHON;
    }
    const isWin = process.platform === 'win32';
    const subPath = isWin ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
    const unpackedRootDir = ROOT_DIR.includes('app.asar') ? ROOT_DIR.replace('app.asar', 'app.asar.unpacked') : ROOT_DIR;

    const candidates = [
        path.join(unpackedRootDir, 'backend', 'spleeter-env', subPath),
        path.join(ROOT_DIR, 'backend', 'spleeter-env', subPath),
        path.join(ROOT_DIR, 'spleeter-env', subPath),
    ];
    if (isWin) {
        const pf = process.env.ProgramFiles || 'C:\\Program Files';
        candidates.push(path.join(pf, 'Python310', 'python.exe'));
        candidates.push(path.join(pf, 'Python39', 'python.exe'));
        candidates.push(path.join(pf, 'Python311', 'python.exe'));
        const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
        if (localAppData) {
            candidates.push(path.join(localAppData, 'Programs', 'Python', 'Python310', 'python.exe'));
            candidates.push(path.join(localAppData, 'Programs', 'DR Dubber Pro', 'resources', 'app.asar.unpacked', 'backend', 'spleeter-env', subPath));
        }
    }
    candidates.push(path.join(unpackedRootDir, 'backend', 'python_env', isWin ? 'python.exe' : 'python'));
    candidates.push(path.join(ROOT_DIR, 'backend', 'python_env', isWin ? 'python.exe' : 'python'));

    for (const cand of candidates) {
        if (!cand || !fs.existsSync(cand)) continue;
        try {
            execFileSync(cand, ['-c', 'import sys, spleeter; sys.exit(0)'], {
                encoding: 'utf8',
                timeout: 3500,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });
            return cand;
        } catch (e) {}
    }
    return null;
}
const SPLEETER_PYTHON_CMD = getSpleeterPythonCmd();

function ensureTtsDependencies() {
    if (!PYTHON_CMD) {
        console.warn('[Python TTS] No working Python environment found. Edge-TTS local speech synthesis will not be available.');
        return;
    }
    // Missing, or older than 7.3.1: Microsoft's voice service answers edge-tts 7.2.8 with 403 at
    // the WebSocket handshake (since Oct 15, 2026), so an old copy is as good as none.
    // No quotes inside the script (chr(46) is "."), so it survives both cmd.exe and sh quoting.
    const checkScript = 'import sys, edge_tts.version as v; sys.exit(tuple(map(int, v.__version__.split(chr(46))[:3])) < (7, 3, 1))';
    exec(`"${PYTHON_CMD}" -c "${checkScript}"`, { env: PYTHON_ENV }, (err) => {
        if (err) {
            console.warn('[Python TTS] edge-tts missing or older than 7.3.1. Auto-installing...');
            exec(`"${PYTHON_CMD}" -m pip install --upgrade "edge-tts>=7.3.1"`, { env: PYTHON_ENV }, (pipErr, stdout, stderr) => {
                if (pipErr) {
                    console.error('[Python TTS] Failed to auto-install edge-tts:', stderr || pipErr.message);
                } else {
                    console.log('[Python TTS] edge-tts installed successfully.');
                }
            });
        }
    });
}
ensureTtsDependencies();

function getPythonExecutable() {
    return PYTHON_CMD;
}

// Script location never changes at runtime, so resolving it involves 2-3 fs.existsSync
// calls that would otherwise repeat on every single TTS/vocal-separation spawn.
const _pythonScriptPathCache = new Map();
function getPythonScriptPath(scriptName) {
    if (_pythonScriptPathCache.has(scriptName)) {
        return _pythonScriptPathCache.get(scriptName);
    }

    let resolved;
    const unpackedRootDir = ROOT_DIR.includes('app.asar') ? ROOT_DIR.replace('app.asar', 'app.asar.unpacked') : ROOT_DIR;
    const unpackedScript = path.join(unpackedRootDir, 'backend', 'python', scriptName);
    const devScript = path.join(ROOT_DIR, 'backend', 'python', scriptName);

    if (fs.existsSync(unpackedScript)) {
        resolved = unpackedScript;
    } else if (fs.existsSync(devScript) && !devScript.includes('app.asar')) {
        resolved = devScript;
    } else {
        // If running inside app.asar without unpacked file, extract script to writable STORAGE_BASE/python
        try {
            const storagePyDir = path.join(STORAGE_BASE, 'python');
            if (!fs.existsSync(storagePyDir)) fs.mkdirSync(storagePyDir, { recursive: true });
            const targetPath = path.join(storagePyDir, scriptName);
            const sourceContent = fs.readFileSync(path.join(ROOT_DIR, 'backend', 'python', scriptName), 'utf8');
            fs.writeFileSync(targetPath, sourceContent, 'utf8');
            resolved = targetPath;
        } catch (e) {
            resolved = devScript;
        }
    }

    _pythonScriptPathCache.set(scriptName, resolved);
    return resolved;
}

[UPLOADS_DIR, AUDIO_CACHE_DIR, SEPARATED_DIR, EXPORTS_DIR, OUTPUTS_DIR, LOGS_DIR, CUSTOM_OUTPUTS_DIR, USER_DESKTOP_OUTPUTS].forEach(dir => {
    if (dir && !fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
    }
});

// Multer storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// No cross-origin access: this server only answers the app's own window.
// Every request must come to localhost/127.0.0.1 on our port, from our own
// origin, and carry the per-launch token cookie that main.js puts in the
// Electron session (see lib/security.js). Do not re-add cors(), and do not
// add express.urlencoded(): form-encoded POSTs are what other websites can
// send to localhost without a CORS preflight.
app.disable('x-powered-by');
app.use(security.hostAndOriginGuard(PORT));
app.use(security.securityHeaders(path.join(ROOT_DIR, 'frontend', 'index.html')));
app.use(security.tokenAuth());
app.use(express.json({ limit: '100mb' }));

// Static files
app.use(express.static(path.join(ROOT_DIR, 'frontend')));
app.use('/fonts', express.static(path.join(ROOT_DIR, 'frontend', 'fonts')));
app.use('/assets', express.static(path.join(ROOT_DIR, 'frontend', 'assets')));
app.use('/lib', express.static(path.join(ROOT_DIR, 'frontend', 'lib')));
app.use('/storage', express.static(STORAGE_BASE));

// Active jobs maps with TTL pruning
const bgmJobs = new Map();

// Long requests (transcribe, Fix Missing) can run as background jobs: sent with an
// X-Background-Job: <id> header, the route answers at once and keeps its result for
// GET /api/job-result. A request held open for minutes takes one of the only 6 connections
// Chromium opens to this server; Dub Whole Series transcribing 6 tabs at once took all of them,
// and progress, audio and every other request queued until the browser failed them
// (net::ERR_INSUFFICIENT_RESOURCES).
const backgroundJobs = new Map(); // id -> { done, status, body, endedAt }
const BACKGROUND_JOB_KEEP_MS = 30 * 60 * 1000;
function backgroundable(handler) {
    return (req, res, next) => {
        const id = String(req.get('X-Background-Job') || '').slice(0, 100);
        if (!id) return handler(req, res, next);
        const now = Date.now();
        for (const [k, j] of backgroundJobs) if (j.done && now - j.endedAt > BACKGROUND_JOB_KEEP_MS) backgroundJobs.delete(k);
        const job = { done: false };
        backgroundJobs.set(id, job);
        // Stands in for res: the handlers only call res.status() and res.json().
        const result = {
            statusCode: 200,
            headersSent: false,
            status(code) { this.statusCode = code; return this; },
            json(body) {
                if (!job.done) Object.assign(job, { done: true, status: this.statusCode, body, endedAt: Date.now() });
                this.headersSent = true;
                return this;
            }
        };
        res.json({ success: true, background: true, jobId: id });
        Promise.resolve()
            .then(() => handler(req, result, next))
            .catch((e) => result.status(500).json({ success: false, error: e.message }))
            .finally(() => result.status(500).json({ success: false, error: 'The job ended without a result.' }));
    };
}
app.get('/api/job-result', (req, res) => {
    const job = backgroundJobs.get(String(req.query.id || ''));
    if (!job) return res.json({ success: false, unknown: true });
    if (!job.done) return res.json({ success: true, done: false });
    res.json({ success: true, done: true, status: job.status, body: job.body });
});

// Periodic memory cleanup for completed in-memory jobs (every 15 min)
setInterval(() => {
    const now = Date.now();
    for (const [id, job] of bgmJobs.entries()) {
        if (job && (job.status === 'done' || job.status === 'error') && job.timestamp && (now - job.timestamp > 15 * 60 * 1000)) {
            bgmJobs.delete(id);
        }
    }
    for (const [key, entry] of ttsCache.entries()) {
        if (entry && entry.timestamp && (now - entry.timestamp > TTS_CACHE_TTL_MS)) {
            ttsCache.delete(key);
        }
    }
}, 15 * 60 * 1000);

// Helper to determine output audio file path
function resolveAudioOutputFile(tempPath, index) {
    const subId = index || Date.now();
    const fileName = `subtitle_${subId}_${Date.now()}.mp3`;

    if (!tempPath || typeof tempPath !== 'string' || isNetworkPath(tempPath)) {
        return path.join(AUDIO_CACHE_DIR, fileName);
    }
    // The TTS generator deletes and rewrites this file, so a file target must be audio.
    if (path.extname(tempPath) && !isAudioFile(tempPath)) {
        return path.join(AUDIO_CACHE_DIR, fileName);
    }

    try {
        if (fs.existsSync(tempPath)) {
            const stat = fs.statSync(tempPath);
            if (stat.isDirectory()) {
                return path.join(tempPath, fileName);
            }
            return tempPath;
        } else {
            if (path.extname(tempPath)) {
                fs.mkdirSync(path.dirname(tempPath), { recursive: true });
                return tempPath;
            } else {
                fs.mkdirSync(tempPath, { recursive: true });
                return path.join(tempPath, fileName);
            }
        }
    } catch (e) {
        return path.join(AUDIO_CACHE_DIR, fileName);
    }
}

// 1. Audio / Media Streaming Endpoint (handles both standard and URL-encoded query strings with HTTP Caching)
app.use('/api/audio', (req, res) => {
    let rawPath = req.query.path;

    if (!rawPath && req.originalUrl.includes('path=')) {
        try {
            const decoded = decodeURIComponent(req.originalUrl);
            const match = decoded.match(/path=([^&]+)/);
            if (match) rawPath = match[1];
        } catch (e) { }
    }

    const filePath = resolveLocalFilePath(rawPath);

    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).send('File not found');
    }
    // Only media, subtitle, image and font files are ever streamed to the page.
    if (!isServableMedia(filePath)) {
        return res.status(403).send('File type not allowed');
    }

    try {
        const stat = fs.statSync(filePath);
        const now = Date.now();
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_MAP[ext] || 'application/octet-stream';
        const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;

        // HTTP client cache validation
        if (req.headers['if-none-match'] === etag) {
            return res.status(304).end();
        }

        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'public, max-age=86400');

        // The 7-day stale-file sweep (cleanStaleTempFiles) keys off mtime, so a
        // file belonging to a project that's simply been open-but-idle for a
        // week would otherwise get deleted out from under the user. Refresh
        // mtime on actual playback/use (throttled to once/day so it doesn't
        // spam disk I/O or defeat the ETag cache above on every request).
        if ((now - stat.mtimeMs > 24 * 60 * 60 * 1000) &&
            (filePath.startsWith(AUDIO_CACHE_DIR) || filePath.startsWith(SEPARATED_DIR) || filePath.startsWith(UPLOADS_DIR) || filePath.startsWith(PREVIEW_DIR) || filePath.startsWith(AUDIO_REPAIR_DIR))) {
            const nowSec = now / 1000;
            fs.promises.utimes(filePath, nowSec, nowSec).catch(() => {});
        }

        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Content-Length': chunksize,
                'Content-Type': contentType,
            });
            file.pipe(res);
            res.on('close', () => {
                if (file && !file.destroyed) file.destroy();
            });
        } else {
            res.writeHead(200, {
                'Content-Length': stat.size,
                'Content-Type': contentType,
            });
            const file = fs.createReadStream(filePath);
            file.pipe(res);
            res.on('close', () => {
                if (file && !file.destroyed) file.destroy();
            });
        }
    } catch (e) {
        if (!res.headersSent) res.status(500).send(e.message);
    }
});

// Transcribe Audio Destination Resolver & Saver
function getTranscribeDestinations(customFolder, sourceFilePath) {
    const destinations = [];
    if (isNetworkPath(customFolder)) customFolder = null;
    if (isNetworkPath(sourceFilePath)) sourceFilePath = null;
    if (customFolder && typeof customFolder === 'string' && customFolder.trim()) {
        try {
            const trimmed = customFolder.trim();
            if (fs.existsSync(trimmed)) {
                destinations.push(trimmed);
            }
        } catch (e) {}
    } else if (sourceFilePath && typeof sourceFilePath === 'string') {
        try {
            const srcDir = path.dirname(sourceFilePath);
            if (srcDir && srcDir !== '.' && fs.existsSync(srcDir)) {
                destinations.push(srcDir);
            }
        } catch (e) {}
    }
    
    // If no user destination resolved, fallback to internal app storage
    if (destinations.length === 0) {
        destinations.push(OUTPUTS_DIR);
    }
    return destinations;
}

// One file per episode (no timestamp in the name): transcribing the episode again replaces it
// instead of piling up copies.
function saveTranscribeAudio(audioBufferOrPath, videoName, partIndex, customFolder, sourceFilePath) {
    let cleanBase = (videoName || 'video')
        .replace(/[/\\?%*:|"<>]/g, '_')
        .replace(/\.[^/.]+$/, '') // strip file extension
        .replace(/^transcribe_\d+_/i, '') // strip redundant previous timestamp prefixes
        .replace(/^transcribe_/i, '');

    cleanBase = collapseRepeatedPartSuffix(cleanBase); // name_part1_part1 -> name_part1 (part01_part06 kept)

    // Check if filename already ends with a part/chunk designation (e.g. _part1, -part2, .part3, Part 1, pt1)
    const hasPartSuffix = /(?:[_.\- ](?:part|pt|chunk)\s*\d+|\bpart\s*\d+)$/i.test(cleanBase);

    let partName;
    if (hasPartSuffix) {
        // Base name already has part information, do not append an additional part suffix
        partName = `transcribe_${cleanBase}.mp3`;
    } else if (partIndex !== undefined && partIndex !== null && String(partIndex).trim() !== '') {
        const pIdx = String(partIndex).trim();
        partName = `transcribe_${cleanBase}_part${pIdx}.mp3`;
    } else {
        partName = `transcribe_${cleanBase}.mp3`;
    }

    const destinations = getTranscribeDestinations(customFolder, sourceFilePath);
    let firstSavedPath = null;
    const savedPaths = [];

    destinations.forEach(targetDir => {
        try {
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            const fullPath = path.join(targetDir, partName);
            if (Buffer.isBuffer(audioBufferOrPath)) {
                fs.writeFileSync(fullPath, audioBufferOrPath);
            } else if (typeof audioBufferOrPath === 'string' && fs.existsSync(audioBufferOrPath)) {
                fs.copyFileSync(audioBufferOrPath, fullPath);
            }
            if (!firstSavedPath) firstSavedPath = fullPath;
            savedPaths.push(fullPath);
        } catch (e) {
            console.warn('[Outputs] Error saving transcribe chunk to', targetDir, e.message);
        }
    });

    return { partName, filePath: firstSavedPath, savedPaths };
}

// 2. Extract Audio from Video (accepts FormData or direct JSON with videoPath)
app.post('/api/extract-audio', upload.any(), async (req, res) => {
    const uploadedFile = (req.files && req.files.length > 0) ? req.files[0].path : null;
    let videoPath = uploadedFile || req.body?.videoPath || req.body?.filePath;
    const videoName = req.body?.videoName || (videoPath ? path.basename(videoPath) : 'video');
    const partIndex = req.body?.partIndex;
    const customFolder = req.body?.customFolder;
    const sourceFilePath = req.body?.sourceFilePath || videoPath;

    if (!videoPath || !fs.existsSync(videoPath)) {
        return res.status(400).json({ success: false, error: 'Video file not found' });
    }

    const baseName = path.basename(videoPath, path.extname(videoPath)).replace(/[^a-zA-Z0-9_-]/g, '_');
    const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fileName = `${baseName}_${uniqueId}_audio.mp3`;
    const audioOut = path.join(SEPARATED_DIR, fileName);

    // Joined clips can switch AAC format mid-file; read the repaired track if so.
    const audioSource = await audioRepair.getAudioSource(videoPath).catch(() => ({ path: videoPath, repaired: false }));

    // 64kbps mono 16kHz is plenty for speech recognition and keeps long episodes under upload limits.
    // aresample=async keeps the timeline: if some audio still can't be decoded, those
    // frames become silence instead of being dropped (which would shift every subtitle).
    // -max_error_rate 1: a damaged file yields audio with gaps rather than a hard failure.
    // Same audio track the preview plays (repaired copies have just one).
    const audioMap = audioSource.repaired ? null : await audioRepair.defaultAudioMap(audioSource.path);
    const cmd = ['-hide_banner', '-nostdin', '-y', '-max_error_rate', '1', '-i', audioSource.path, ...(audioMap ? ['-map', audioMap] : []), '-vn', '-af', 'aresample=async=1:first_pts=0',
        '-acodec', 'libmp3lame', '-b:a', '64k', '-ar', '16000', '-ac', '1', audioOut];
    // stderr must be drained: a file with thousands of decode warnings fills the pipe
    // and FFmpeg blocks forever (this is what made some videos "never transcribe").
    const ffmpeg = spawn(getFFmpegBinary(), cmd, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    trackProcess(ffmpeg);
    let ffmpegErrTail = '';
    ffmpeg.stderr.on('data', (d) => { ffmpegErrTail = (ffmpegErrTail + d).slice(-3000); });

    ffmpeg.on('error', (err) => {
        console.error('[FFmpeg Error]', err);
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    });

    ffmpeg.on('close', (code) => {
        if (res.headersSent) return;
        if (code === 0 && fs.existsSync(audioOut)) {
            // Automatically save transcribe mp3 to transcribe output destinations
            const saveRes = saveTranscribeAudio(audioOut, videoName, partIndex, customFolder, sourceFilePath);
            res.json({
                success: true,
                file: audioOut,
                audioPath: audioOut,
                savedTranscribePath: saveRes.filePath,
                partName: saveRes.partName,
                audioRepaired: audioSource.repaired,
                repairedStretches: audioSource.stretches,
                url: `/storage/separated/${fileName}`
            });
        } else {
            const lastLine = ffmpegErrTail.split('\n').map(l => l.trim()).filter(Boolean).pop();
            const noAudio = /does not contain any stream|matches no streams|Output file.*does not contain/i.test(ffmpegErrTail);
            res.status(500).json({ success: false, error: noAudio ? 'NO_AUDIO_TRACK' : `FFmpeg extraction failed${lastLine ? `: ${lastLine}` : ''}` });
        }
    });
});

// 2.05 Save Transcribe Audio directly
app.post('/api/save-transcribe-audio', upload.any(), (req, res) => {
    const { videoName, partIndex, customFolder, sourceFilePath, audioPath, audioBase64 } = req.body;
    let audioData = audioPath;
    if (audioBase64) {
        audioData = Buffer.from(audioBase64, 'base64');
    }
    const uploadedFile = (req.files && req.files.length > 0) ? req.files[0].path : null;
    if (uploadedFile) audioData = uploadedFile;

    if (!audioData) {
        return res.status(400).json({ success: false, error: 'No audio data provided' });
    }

    const saveRes = saveTranscribeAudio(audioData, videoName, partIndex, customFolder, sourceFilePath);
    res.json({ success: true, ...saveRes });
});

// 2.1 Save Subtitle SRT directly to folders (transcribe output, custom folder, source folder)
app.post('/api/save-srt', (req, res) => {
    const { content, fileName, sourceFilePath, customFolder } = req.body;
    if (!content) return res.status(400).json({ success: false, error: 'No SRT content provided.' });

    let cleanBase = (fileName || 'subtitles')
        .replace(/[/\\?%*:|"<>]/g, '_')
        .replace(/\.srt$/i, '');
    cleanBase = collapseRepeatedPartSuffix(cleanBase);
    const srtFileName = `${cleanBase}.srt`;

    const destinations = getTranscribeDestinations(customFolder, sourceFilePath);

    let savedPath = null;
    destinations.forEach(targetDir => {
        try {
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            const fullPath = path.join(targetDir, srtFileName);
            fs.writeFileSync(fullPath, content, 'utf8');
            if (!savedPath) savedPath = fullPath;
        } catch (e) {}
    });

    res.json({ success: true, filePath: savedPath });
});

// 4c. Batch Save SRT Subtitle Files
app.post('/api/batch-save-srts', (req, res) => {
    const { items = [], customFolder } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'No subtitle files provided.' });
    }

    const savedFiles = [];
    const errors = [];

    items.forEach((item, idx) => {
        try {
            const { fileName, content, sourceFilePath } = item;
            if (!content) return;

            let cleanBase = (fileName || `subtitle_${idx + 1}`)
                .replace(/[/\\?%*:|"<>]/g, '_')
                .replace(/\.srt$/i, '');
            const srtFileName = `${cleanBase}.srt`;

            const destinations = getTranscribeDestinations(customFolder, sourceFilePath);
            let savedPath = null;
            destinations.forEach(targetDir => {
                try {
                    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
                    const fullPath = path.join(targetDir, srtFileName);
                    fs.writeFileSync(fullPath, content, 'utf8');
                    if (!savedPath) savedPath = fullPath;
                } catch (e) {
                    console.warn('[BatchSave] Could not write to targetDir:', targetDir, e.message);
                }
            });

            if (savedPath) savedFiles.push({ fileName: srtFileName, filePath: savedPath });
        } catch (err) {
            errors.push({ index: idx, error: err.message });
        }
    });

    res.json({ success: true, savedCount: savedFiles.length, savedFiles, errors });
});


// Finished Batch Transcribe parts (see lib/batch-results.js): asked before a part is sent to
// Gemini, saved when it is done.
const { loadBatchResult, saveBatchResult } = require('./lib/batch-results');
const BATCH_RESULTS_DIR = path.join(STORAGE_BASE, 'batch_results');

app.post('/api/batch-result/get', (req, res) => {
    const saved = loadBatchResult(BATCH_RESULTS_DIR, req.body && req.body.sourceFilePath);
    res.json({ success: true, found: !!saved, result: saved || undefined });
});

app.post('/api/batch-result/save', (req, res) => {
    const { sourceFilePath, result } = req.body || {};
    try {
        res.json({ success: saveBatchResult(BATCH_RESULTS_DIR, sourceFilePath, result) });
        pronunciationRouter.checker.kick(); // its new words get checked while the series works
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// --- BGM ISOLATION ---
const { cacheKeyForFile, lookupCachedStems, storeStems, pruneBgmCache, jobStatusFor, pickSeparatorThreads, killProcessTree } = require('./lib/bgm-cache');
// Engines: MDX-Net (the default: UVR's Voc_FT model on onnxruntime, shipped
// with the app; cleanest BGM in our tests, ~4-5 min per 9-minute tab on CPU),
// Spleeter 2stems and Demucs htdemucs (each needs its own Python install) and
// FFmpeg phase cancellation.
const BGM_ENGINES = ['mdx', 'spleeter', 'demucs', 'ffmpeg'];
const DEFAULT_BGM_ENGINE = 'mdx';
const BGM_ENGINE_LABELS = { mdx: 'MDX-Net', spleeter: 'Spleeter', demucs: 'Demucs', ffmpeg: 'FFmpeg' };
const bgmChildren = new Map(); // jobId -> running separator process, so Stop can kill it
// "Remove music from BGM" (music may be copyrighted): a second pass, music_remover.py
// (MVSEP-CDX23, needs the Demucs Python), takes the music out of the finished BGM and keeps
// the sound effects. Its result is cached on its own key, so turning the setting on reuses
// a tab's earlier voice/BGM split. The model is downloaded to <storage>/models (kept across
// app updates).
const NO_MUSIC_MODEL = '+nomusic:cdx23-dbb4db15';
const MUSIC_MODEL_DIR = path.join(STORAGE_BASE, 'models');
const bgmMusicJobs = new Map(); // jobId -> what the music pass needs, until it starts

// Part of the cache key: a new model must not reuse the old model's stems.
function bgmEngineModel(engine) {
    if (engine === 'mdx') return 'UVR-MDX-NET-Voc_FT:ov0.1';
    if (engine === 'demucs') return process.env.DEMUCS_MODEL || 'htdemucs';
    if (engine === 'spleeter') return 'spleeter:2stems';
    return 'stereotools-lr';
}

function isBgmJobCancelled(jobId) {
    const job = bgmJobs.get(jobId);
    return !!(job && job.status === 'cancelled');
}

function bgmDoneJob(bgmPath, vocalPath, extra = {}) {
    const bgmUri = `/api/audio?path=${encodeURIComponent(bgmPath)}`;
    const vocalUri = `/api/audio?path=${encodeURIComponent(vocalPath)}`;
    return {
        status: 'done',
        success: true,
        progress: 100,
        url: bgmUri,
        file: bgmPath,
        bgmPath: bgmPath,
        vocalPath: vocalPath,
        bgmUrl: bgmUri,
        vocalUrl: vocalUri,
        timestamp: Date.now(),
        ...extra
    };
}

function removeDirQuietly(dir) {
    if (!dir) return;
    fs.rm(dir, { recursive: true, force: true }, () => {});
}

// Every finished separation ends here: done at once, or first the music pass when the
// job asked for it.
function finishBgmJob(jobId, bgmPath, vocalPath, extra = {}) {
    const music = bgmMusicJobs.get(jobId);
    bgmMusicJobs.delete(jobId);
    if (!music) {
        bgmJobs.set(jobId, bgmDoneJob(bgmPath, vocalPath, extra));
        return;
    }
    removeMusicFromBgm(jobId, bgmPath, vocalPath, extra, music).catch((e) => {
        if (isBgmJobCancelled(jobId)) return;
        bgmJobs.set(jobId, { status: 'error', success: false, timestamp: Date.now(), error: `Remove music could not run (${e.message})` });
    });
}

// No silent fallback to the BGM with music: the user turned this on to keep copyrighted
// music out, so a failure is an error the app shows.
async function removeMusicFromBgm(jobId, bgmPath, vocalPath, extra, music) {
    if (isBgmJobCancelled(jobId)) return;
    const fail = (error) => {
        if (isBgmJobCancelled(jobId)) return;
        console.error(`[Remove Music] Job ${jobId}: ${error}`);
        bgmJobs.set(jobId, { status: 'error', success: false, timestamp: Date.now(), error });
    };
    if (!PYTHON_CMD) return fail('Remove music could not run (no working Python was found)');
    bgmJobs.set(jobId, { status: 'processing', progress: 60, success: true, stage: 'music', timestamp: Date.now() });

    const workDir = path.join(SEPARATED_DIR, 'bgm-work', `${String(jobId).replace(/[^\w.-]/g, '_')}_nomusic`);
    try { fs.mkdirSync(workDir, { recursive: true }); } catch (e) {}
    const pyArgs = ['--remove-music', '--input', bgmPath, '--output', workDir, '--model-dir', MUSIC_MODEL_DIR,
        '--threads', String(pickSeparatorThreads(os.cpus().length, music.parallelJobs))];
    if (music.demucsFolder) pyArgs.push('--demucs-folder', music.demucsFolder);
    if (!music.useGPU || await lendVoxCpmGpu(music.voxServerUrl) === 'cpu') pyArgs.push('--device', 'cpu');
    if (isBgmJobCancelled(jobId)) {
        removeDirQuietly(workDir);
        return;
    }

    const child = spawn(PYTHON_CMD, [getPythonScriptPath('vocal_separator.py'), ...pyArgs], {
        env: { ...PYTHON_ENV, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
        detached: process.platform !== 'win32'
    });
    trackProcess(child);
    bgmChildren.set(jobId, child);
    let output = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout.on('data', d => output += stdoutDecoder.write(d));
    child.stderr.on('data', d => {
        const text = stderrDecoder.write(d);
        const m = [...text.matchAll(/\[music\] (\d+)\/(\d+)/g)].pop();
        const job = bgmJobs.get(jobId);
        if (m && job && job.status === 'processing') {
            job.progress = 60 + Math.floor(38 * Number(m[1]) / Math.max(1, Number(m[2])));
        }
        stderr += text.replace(/^\[music\] .*(\r?\n|$)/gm, '');
    });
    await new Promise((resolve) => {
        child.on('error', (err) => { stderr += err.message; resolve(); });
        child.on('close', resolve);
    });
    bgmChildren.delete(jobId);
    if (isBgmJobCancelled(jobId)) {
        removeDirQuietly(workDir);
        return;
    }
    const line = output.trim().split(/\r?\n/).reverse().find(l => l.trim().startsWith('{'));
    let data = null;
    try { data = JSON.parse(line); } catch (e) {}
    if (!data || !data.success) {
        removeDirQuietly(workDir);
        const errTail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(-300);
        return fail((data && data.error) || `Remove music could not run (${errTail || 'no result'})`);
    }

    let outBgm = data.bgm;
    let outVocal = vocalPath;
    if (music.cacheKey && extra.method === music.engine) {
        // The cache entry needs its own vocals.wav: a hard link costs no space.
        const vocalCopy = path.join(workDir, 'vocals.wav');
        try {
            try { fs.linkSync(vocalPath, vocalCopy); } catch (e) { fs.copyFileSync(vocalPath, vocalCopy); }
            const stored = storeStems(SEPARATED_DIR, music.cacheKey, { bgm: outBgm, vocal: vocalCopy, method: extra.method, source: music.sourcePath });
            if (stored) {
                outBgm = stored.bgm;
                outVocal = stored.vocal;
                removeDirQuietly(workDir);
            }
        } catch (e) {}
    }
    console.log(`[Remove Music] Job ${jobId}: music removed from the BGM (${data.device || 'cpu'}).`);
    bgmJobs.set(jobId, bgmDoneJob(outBgm, outVocal, { ...extra, musicRemoved: true }));
}

// Cached stems not used for 14 days, work folders left by a crash or Stop, and the FFmpeg
// separator's output (about 160 MB a tab, not cached) after 2 days - by then the tab it was made
// for is exported. Checked at start and every hour: an overnight Dub Whole Series makes many.
const FFMPEG_STEMS_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
function pruneSeparatedFolders() {
    try {
        const removed = pruneBgmCache(SEPARATED_DIR, 14 * 24 * 60 * 60 * 1000);
        if (removed) console.log(`[BGM cache] Removed ${removed} unused entr${removed === 1 ? 'y' : 'ies'}.`);
        const workRoot = path.join(SEPARATED_DIR, 'bgm-work');
        if (fs.existsSync(workRoot)) {
            for (const name of fs.readdirSync(workRoot)) {
                const dir = path.join(workRoot, name);
                try { if (Date.now() - fs.statSync(dir).mtimeMs > 24 * 60 * 60 * 1000) removeDirQuietly(dir); } catch (e) {}
            }
        }
        // Prepared banners and ads older versions kept: nothing reads them now.
        for (const name of ['keyed-overlays', 'encoded-clips']) {
            const dir = path.join(SEPARATED_DIR, name);
            if (fs.existsSync(dir)) removeDirQuietly(dir);
        }
        for (const name of fs.readdirSync(SEPARATED_DIR)) {
            if (!/^ffmpeg_\d+_\d+$/.test(name)) continue;
            const dir = path.join(SEPARATED_DIR, name);
            try { if (Date.now() - fs.statSync(dir).mtimeMs > FFMPEG_STEMS_MAX_AGE_MS) removeDirQuietly(dir); } catch (e) {}
        }
    } catch (e) {}
}
setTimeout(pruneSeparatedFolders, 15000);
setInterval(pruneSeparatedFolders, 60 * 60 * 1000).unref();

// Direct native FFmpeg stem separation (stereo phase cancellation).
// Needs no Python, but it only removes what sits dead-centre in the stereo
// image: on a near-mono drama mix it removes most of the music as well. So it
// runs only when the user picks it, or as a fallback that is always reported
// (method 'ffmpeg_fallback' plus the reason the ML engine failed) - the app
// tells the user instead of exporting tabs with almost no music.
function isolateBgmWithFfmpeg(audioPath, outputDir, jobId, isFallback = false, fallbackReason = '') {
    const ffmpegBin = getFFmpegBinary();
    const jobSuffix = `${process.pid}_${Date.now()}`;
    const jobDir = path.join(outputDir, `ffmpeg_${jobSuffix}`);
    try {
        if (!fs.existsSync(jobDir)) {
            fs.mkdirSync(jobDir, { recursive: true });
        }
    } catch (e) {
        console.error('[FFmpeg Vocal Separation] Could not create job directory:', jobDir, e);
    }

    const bgmPath = path.join(jobDir, 'accompaniment.wav');
    const vocalPath = path.join(jobDir, 'vocals.wav');

    const filterGraph = '[0:a]aformat=channel_layouts=stereo,asplit=2[a_bgm_in][a_voc_in];[a_bgm_in]stereotools=mode=lr>l-r,volume=2.5[bgm];[a_voc_in]stereotools=mode=lr>l+r,highpass=f=200,lowpass=f=3500,volume=1.5[vocal]';

    const args = [
        '-y',
        '-i', audioPath,
        '-filter_complex', filterGraph,
        '-map', '[bgm]', bgmPath,
        '-map', '[vocal]', vocalPath
    ];

    console.log(`[FFmpeg Vocal Separation] Starting separation for job ${jobId} (fallback: ${isFallback}) using ${ffmpegBin}...`);
    let child;
    try {
        child = spawn(ffmpegBin, args, { windowsHide: true });
        trackProcess(child);
        bgmChildren.set(jobId, child);
    } catch (err) {
        console.error('[FFmpeg Vocal Separation Spawn Error]', err);
        bgmJobs.set(jobId, { status: 'error', success: false, timestamp: Date.now(), error: `Failed to spawn FFmpeg process: ${err.message}` });
        return;
    }

    let stderr = '';
    let settled = false;
    const stderrDecoder = new StringDecoder('utf8');
    child.stderr.on('data', d => stderr += stderrDecoder.write(d));

    child.on('error', (err) => {
        if (settled) return;
        settled = true;
        bgmChildren.delete(jobId);
        if (isBgmJobCancelled(jobId)) return;
        console.error('[FFmpeg Vocal Separation Error]', err);
        bgmJobs.set(jobId, { status: 'error', success: false, timestamp: Date.now(), error: `FFmpeg execution error: ${err.message}` });
    });

    child.on('close', (code) => {
        if (settled) return;
        settled = true;
        bgmChildren.delete(jobId);
        // Stopped by the user: keep the 'cancelled' mark instead of re-adding a result.
        if (isBgmJobCancelled(jobId)) {
            removeDirQuietly(jobDir);
            return;
        }
        if (code === 0 && fs.existsSync(bgmPath) && fs.existsSync(vocalPath)) {
            console.log(`[FFmpeg Vocal Separation Succeeded] Job ${jobId} finished! BGM: ${bgmPath}`);
            finishBgmJob(jobId, bgmPath, vocalPath, isFallback
                ? { method: 'ffmpeg_fallback', fallbackReason: fallbackReason || 'The ML separator could not run.' }
                : { method: 'ffmpeg' });
        } else {
            console.error(`[FFmpeg Vocal Separation Failed] Code ${code}, Stderr: ${stderr.trim()}`);
            removeDirQuietly(jobDir);
            const ffErr = stderr.trim().split(/\r?\n/).slice(-2).join(' ') || `FFmpeg separation process exited with code ${code}`;
            bgmJobs.set(jobId, {
                status: 'error',
                success: false,
                timestamp: Date.now(),
                error: fallbackReason ? `${fallbackReason}. The FFmpeg fallback failed too: ${ffErr}` : ffErr
            });
        }
    });
}

// VoxCPM2 (a 2B model) and an ML separator together overfill a 6 GB laptop GPU, and
// Windows then pages video memory: a 98 s episode's MDX-Net isolation, 8 s on its own,
// ran for over 8 minutes beside a loaded VoxCPM2. A local VoxCPM2 server is asked to
// release the GPU first (its next line loads the model again). 'cpu' when one is on the
// GPU but can't release it (an older app.py): the separator then stays off the GPU.
async function lendVoxCpmGpu(serverUrl) {
    const base = String(serverUrl || 'http://127.0.0.1:8808').trim().replace(/\/+$/, '').replace('//localhost', '//127.0.0.1');
    if (!/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(base)) return 'none';
    try {
        const health = await secureFetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
        const info = await health.json().catch(() => ({}));
        if (info.device !== 'cuda' || info.sleeping) return 'none';
        // Waits for a line being spoken to finish.
        const r = await secureFetch(`${base}/api/release`, { method: 'POST', signal: AbortSignal.timeout(180000) });
        if (r.ok) {
            console.log('[Vocal Separator] VoxCPM2 released the GPU for BGM isolation.');
            return 'released';
        }
        return 'cpu';
    } catch (e) {
        return 'none'; // no VoxCPM2 server running
    }
}

// 3. Remove Vocals / BGM Isolation
app.post('/api/remove-vocals', upload.any(), async (req, res) => {
    const uploadedFile = (req.files && req.files.length > 0) ? req.files[0].path : null;
    let audioPath = resolveLocalFilePath(uploadedFile || req.body.audioPath || req.body.filePath || req.body.videoPath);
    const jobId = req.body.jobId || `bgm_${Date.now()}`;

    if (!audioPath || !fs.existsSync(audioPath)) {
        return res.status(400).json({ success: false, error: 'Audio/Video file not found' });
    }
    // The cache is keyed on the user's own file (not the repaired copy below);
    // an upload gets a new temp name every time, so caching it would never hit.
    const sourcePath = uploadedFile ? null : audioPath;

    let engine = req.body.engine;
    if (!BGM_ENGINES.includes(engine)) engine = DEFAULT_BGM_ENGINE;
    const cacheKey = (sourcePath && engine !== 'ffmpeg') ? cacheKeyForFile(sourcePath, engine, bgmEngineModel(engine)) : null;
    const removeMusic = req.body.removeMusic === true || req.body.removeMusic === 'true';
    const noMusicKey = (removeMusic && sourcePath && engine !== 'ffmpeg') ? cacheKeyForFile(sourcePath, engine, bgmEngineModel(engine) + NO_MUSIC_MODEL) : null;

    const cachedNoMusic = lookupCachedStems(SEPARATED_DIR, noMusicKey);
    if (cachedNoMusic) {
        console.log(`[Vocal Separator] Job ${jobId}: reusing cached ${engine} stems without music for ${path.basename(sourcePath)}`);
        bgmJobs.set(jobId, bgmDoneJob(cachedNoMusic.bgm, cachedNoMusic.vocal, { method: cachedNoMusic.method || engine, requestedEngine: engine, cached: true, musicRemoved: true }));
        return res.json({ success: true, jobId: jobId, status: 'processing' });
    }
    if (removeMusic) {
        bgmMusicJobs.set(jobId, {
            engine,
            cacheKey: noMusicKey,
            sourcePath,
            useGPU: req.body.useGPU === true || req.body.useGPU === 'true',
            parallelJobs: parseInt(req.body.parallelJobs, 10) || 1,
            demucsFolder: isNetworkPath(req.body.demucsFolder) ? '' : String(req.body.demucsFolder || '').trim(),
            voxServerUrl: req.body.voxServerUrl,
        });
    }

    // Same file, same engine and model as an earlier run: hand back its stems at once.
    const cached = lookupCachedStems(SEPARATED_DIR, cacheKey);
    if (cached) {
        console.log(`[Vocal Separator] Job ${jobId}: reusing cached ${engine} stems for ${path.basename(sourcePath)}`);
        if (removeMusic) bgmJobs.set(jobId, { status: 'processing', progress: 60, success: true, timestamp: Date.now() });
        finishBgmJob(jobId, cached.bgm, cached.vocal, { method: cached.method || engine, requestedEngine: engine, cached: true });
        return res.json({ success: true, jobId: jobId, status: 'processing' });
    }

    audioPath = (await audioRepair.getAudioSource(audioPath).catch(() => ({ path: audioPath }))).path;
    // Stop pressed while the audio was being prepared.
    if (isBgmJobCancelled(jobId)) {
        return res.json({ success: false, jobId: jobId, status: 'cancelled', error: 'Cancelled' });
    }

    bgmJobs.set(jobId, { status: 'processing', progress: 10, success: true, timestamp: Date.now() });
    res.json({ success: true, jobId: jobId, status: 'processing' });

    // Fast path: If the user specifically chose FFmpeg, run native FFmpeg directly
    if (engine === 'ffmpeg') {
        isolateBgmWithFfmpeg(audioPath, SEPARATED_DIR, jobId, false);
        return;
    }

    const engineLabel = BGM_ENGINE_LABELS[engine];
    // Phase cancellation when no ML engine could run - always reported back with
    // the reason (method 'ffmpeg_fallback'), so the app can warn and retry.
    const fallBack = (reason) => {
        if (isBgmJobCancelled(jobId)) return;
        console.warn(`[Vocal Separator] Job ${jobId}: ${reason}. Falling back to FFmpeg phase cancellation (reported to the app).`);
        isolateBgmWithFfmpeg(audioPath, SEPARATED_DIR, jobId, true, reason);
    };

    const spleeterPython = SPLEETER_PYTHON_CMD || getSpleeterPythonCmd();
    // The separator itself runs in the app's Python (it has onnxruntime for
    // MDX-Net, the stand-in when Spleeter breaks); Spleeter gets its own
    // Python via --spleeter-python. Only with no app Python at all does the
    // Spleeter Python run it.
    const separatorPython = PYTHON_CMD || (engine === 'spleeter' ? spleeterPython : null);

    if (!separatorPython) {
        fallBack(`${engineLabel} could not run (no working Python was found)`);
        return;
    }

    // Each job gets its own work folder, so a finished job's leftovers and a
    // stopped job's partial files can be deleted without touching anyone else's.
    const workDir = path.join(SEPARATED_DIR, 'bgm-work', String(jobId).replace(/[^\w.-]/g, '_'));
    try { fs.mkdirSync(workDir, { recursive: true }); } catch (e) {}

    const useGPU = req.body.useGPU === true || req.body.useGPU === 'true';
    const parallelJobs = parseInt(req.body.parallelJobs, 10) || 1;
    const pyArgs = ['--input', audioPath, '--output', workDir, '--engine', engine];
    // Demucs is also the stand-in when Spleeter fails, so it always gets its CPU share.
    pyArgs.push('--threads', String(pickSeparatorThreads(os.cpus().length, parallelJobs)));
    if (engine === 'demucs' && !useGPU) {
        pyArgs.push('--device', 'cpu');
    }
    // These folders hold a Python install that gets executed: never accept a network share.
    const demucsFolder = isNetworkPath(req.body.demucsFolder) ? '' : String(req.body.demucsFolder || '').trim();
    const demucsSegment = /^\d{1,3}(\.\d+)?$/.test(String(req.body.demucsSegment || '').trim()) ? String(req.body.demucsSegment).trim() : '';
    const spleeterFolder = isNetworkPath(req.body.spleeterFolder) ? '' : String(req.body.spleeterFolder || '').trim();
    if (demucsFolder) pyArgs.push('--demucs-folder', demucsFolder);
    if (demucsSegment) pyArgs.push('--segment', demucsSegment);
    if (spleeterFolder) pyArgs.push('--spleeter-folder', spleeterFolder);
    if (spleeterPython) pyArgs.push('--spleeter-python', spleeterPython);

    const pyScript = getPythonScriptPath('vocal_separator.py');
    const runEnv = {
        ...PYTHON_ENV,
        SPLEETER_PYTHON: spleeterPython || '',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        TF_CPP_MIN_LOG_LEVEL: '2'
    };
    if ((engine === 'mdx' || (engine === 'demucs' && useGPU)) && await lendVoxCpmGpu(req.body.voxServerUrl) === 'cpu') {
        console.warn(`[Vocal Separator] Job ${jobId}: VoxCPM2 is holding the GPU and can't release it; ${engineLabel} runs on the CPU.`);
        runEnv.MDX_DEVICE = 'cpu';
        if (engine === 'demucs') pyArgs.push('--device', 'cpu');
    }
    if (isBgmJobCancelled(jobId)) {
        removeDirQuietly(workDir);
        return;
    }
    let child;
    try {
        // Own process group off Windows, so Stop can kill the separator and its
        // Demucs/Spleeter child together (on Windows taskkill /T does that).
        child = spawn(separatorPython, [pyScript, ...pyArgs], { env: runEnv, windowsHide: true, detached: process.platform !== 'win32' });
        trackProcess(child);
        bgmChildren.set(jobId, child);
    } catch (spawnErr) {
        fallBack(`${engineLabel} could not run (${spawnErr.message})`);
        return;
    }

    let output = '';
    let stderr = '';
    let settled = false;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout.on('data', d => output += stdoutDecoder.write(d));
    child.stderr.on('data', d => {
        const text = stderrDecoder.write(d);
        // MDX-Net reports "[progress] chunk/total": maps onto 10-95%.
        const m = [...text.matchAll(/\[progress\] (\d+)\/(\d+)/g)].pop();
        const job = bgmJobs.get(jobId);
        if (m && job && job.status === 'processing') {
            // 10-60% when the music pass comes after it.
            job.progress = 10 + Math.floor((removeMusic ? 50 : 85) * Number(m[1]) / Math.max(1, Number(m[2])));
        }
        stderr += text.replace(/^\[progress\] .*(\r?\n|$)/gm, '');
    });
    child.on('error', (err) => {
        if (settled) return;
        settled = true;
        bgmChildren.delete(jobId);
        fallBack(`${engineLabel} could not run (${err.message})`);
    });
    child.on('close', (code) => {
        if (settled) return;
        settled = true;
        bgmChildren.delete(jobId);
        // Stopped by the user: don't report a result or start the fallback.
        if (isBgmJobCancelled(jobId)) {
            removeDirQuietly(workDir);
            return;
        }
        const trimmedOut = output.trim();
        const trimmedErr = stderr.trim();
        const errTail = trimmedErr.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-2).join(' ').slice(-300);

        if (code !== 0 && !trimmedOut) {
            fallBack(`${engineLabel} could not run (${errTail || `exit code ${code}`})`);
            return;
        }

        try {
            let jsonStr = trimmedOut;
            if (!jsonStr.startsWith('{') || !jsonStr.endsWith('}')) {
                const lines = trimmedOut.split('\n').map(l => l.trim()).filter(Boolean);
                const lastJsonLine = [...lines].reverse().find(l => l.startsWith('{') && l.endsWith('}'));
                if (lastJsonLine) jsonStr = lastJsonLine;
            }

            const data = JSON.parse(jsonStr);
            if (data.success) {
                const method = data.method || engine;
                let bgmPath = data.bgm;
                let vocalPath = data.vocal;
                // Only stems from the engine that was asked for are cached: if
                // Spleeter stood in for Demucs, the next run should try Demucs again.
                if (cacheKey && method === engine) {
                    const stored = storeStems(SEPARATED_DIR, cacheKey, { bgm: bgmPath, vocal: vocalPath, method, source: sourcePath });
                    if (stored) {
                        bgmPath = stored.bgm;
                        vocalPath = stored.vocal;
                        removeDirQuietly(workDir);
                    }
                }
                const extra = { method, requestedEngine: engine };
                if (data.fallbackReason) extra.fallbackReason = data.fallbackReason;
                finishBgmJob(jobId, bgmPath, vocalPath, extra);
            } else {
                removeDirQuietly(workDir);
                fallBack(data.error || `${engineLabel} could not run (${errTail || 'no result'})`);
            }
        } catch (e) {
            removeDirQuietly(workDir);
            fallBack(`${engineLabel} could not run (${errTail || `unreadable result: ${e.message}`})`);
        }
    });
});

app.get('/api/bgm-job-status', (req, res) => {
    res.json(jobStatusFor(bgmJobs, req.query.jobId));
});

app.post('/api/cancel-remove-vocals', (req, res) => {
    const { jobId } = req.body;
    if (jobId) {
        // Mark it first: the process's close handler then neither reports a
        // result nor starts the FFmpeg fallback for a job the user stopped.
        bgmJobs.set(jobId, { status: 'cancelled', success: false, error: 'Cancelled', timestamp: Date.now() });
        bgmMusicJobs.delete(jobId);
        const child = bgmChildren.get(jobId);
        bgmChildren.delete(jobId);
        if (child) killProcessTree(child);
        setTimeout(() => { if (isBgmJobCancelled(jobId)) bgmJobs.delete(jobId); }, 15 * 60 * 1000).unref();
    }
    res.json({ success: true });
});

// 4b. Whisper Local Verification & Transcription Endpoints
app.get('/api/check-whisper-folder', (req, res) => {
    const folderPath = req.query.path;
    if (!folderPath || typeof folderPath !== 'string' || isNetworkPath(folderPath) || !fs.existsSync(folderPath)) {
        return res.json({ valid: false, missing: ['Folder does not exist'] });
    }
    const isWin = process.platform === 'win32';
    const runner = isWin ? 'run.bat' : 'run.sh';
    const script = 'transcribe.py';
    
    const missing = [];
    if (!fs.existsSync(path.join(folderPath, script))) missing.push(script);
    if (!fs.existsSync(path.join(folderPath, runner))) missing.push(runner);
    
    res.json({
        valid: missing.length === 0,
        missing
    });
});

// (POST /api/transcribe-whisper was removed: the app runs local Whisper via
// main.js IPC, and an HTTP route that executes a script from a caller-chosen
// folder is not something this server should offer.)

// ── 10 CHARACTER AUTO-SPEAKER PRESETS (Edge-TTS Neural Engine) ──────────
const CHARACTER_PRESETS = {
    Male: { id: 'Male', label: '👨 Piseth (Male)', gender: 'Male', baseVoice: 'km-KH-PisethNeural', pitch: '+0Hz', rate: '+0%', color: '#3b82f6' },
    Female: { id: 'Female', label: '👩 Sreymom (Female)', gender: 'Female', baseVoice: 'km-KH-SreymomNeural', pitch: '+0Hz', rate: '+0%', color: '#ec4899' },
    Hero: { id: 'Hero', label: '🦸‍♂️ Hero (តួឯកប្រុស)', gender: 'Male', baseVoice: 'km-KH-PisethNeural', pitch: '+4Hz', rate: '+5%', color: '#06b6d4' },
    Heroine: { id: 'Heroine', label: '👸 Heroine (តួឯកស្រី)', gender: 'Female', baseVoice: 'km-KH-SreymomNeural', pitch: '+10Hz', rate: '+4%', color: '#f43f5e' },
    Father: { id: 'Father', label: '🧔 Father (ឪពុក)', gender: 'Male', baseVoice: 'km-KH-PisethNeural', pitch: '-10Hz', rate: '-4%', color: '#0284c7' },
    Mother: { id: 'Mother', label: '👵 Mother (ម្តាយ)', gender: 'Female', baseVoice: 'km-KH-SreymomNeural', pitch: '-16Hz', rate: '-8%', color: '#f97316' },
    Villain: { id: 'Villain', label: '😈 Villain (តួកាច)', gender: 'Male', baseVoice: 'km-KH-PisethNeural', pitch: '-22Hz', rate: '-6%', color: '#8b5cf6' },
    Queen: { id: 'Queen', label: '👑 Queen (ម្ចាស់ក្សត្រី)', gender: 'Female', baseVoice: 'km-KH-SreymomNeural', pitch: '-12Hz', rate: '-5%', color: '#a855f7' },
    Elder: { id: 'Elder', label: '👴 Elder (តាចាស់/គ្រូ)', gender: 'Male', baseVoice: 'km-KH-PisethNeural', pitch: '-16Hz', rate: '-10%', color: '#f59e0b' },
    Child: { id: 'Child', label: '🧒 Child (កូនក្មេង)', gender: 'Female', baseVoice: 'km-KH-SreymomNeural', pitch: '+22Hz', rate: '+10%', color: '#eab308' }
};

// Only two voices: plain Male or plain Female. A role from an old project or SRT tag (Hero,
// Mother, Villain...) only says which of the two, never its own pitch or pace, so a speaker
// sounds the same on every line.
function resolveCharacterPreset(identifier) {
    return CHARACTER_PRESETS[resolveRolePreset(identifier).gender] || CHARACTER_PRESETS.Male;
}

function resolveRolePreset(identifier) {
    if (!identifier) return CHARACTER_PRESETS.Male;
    const clean = String(identifier).trim().toLowerCase();
    
    // Direct match
    for (const [key, preset] of Object.entries(CHARACTER_PRESETS)) {
        if (key.toLowerCase() === clean || preset.id.toLowerCase() === clean) return preset;
    }

    // Explicit voice actor names
    if (clean.includes('sreymom') || clean.includes('srey mom')) return CHARACTER_PRESETS.Female;
    if (clean.includes('piseth')) return CHARACTER_PRESETS.Male;

    // Semantic matching for drama & Khmer terms
    if (clean.includes('heroine') || clean.includes('ឯកស្រី') || clean.includes('នាង') || clean.includes('girl')) return CHARACTER_PRESETS.Heroine;
    if (clean.includes('hero') || clean.includes('ឯកប្រុស') || clean.includes('កំលោះ')) return CHARACTER_PRESETS.Hero;
    if (clean.includes('father') || clean.includes('dad') || clean.includes('ឪពុក') || clean.includes('ប៉ា') || clean.includes('ពុក')) return CHARACTER_PRESETS.Father;
    if (clean.includes('mother') || clean.includes('mom') || clean.includes('ម្តាយ') || clean.includes('ម៉ាក់') || clean.includes('ម៉ែ')) return CHARACTER_PRESETS.Mother;
    if (clean.includes('villain') || clean.includes('boss') || clean.includes('កាច') || clean.includes('មេកើយ') || clean.includes('ចោរ')) return CHARACTER_PRESETS.Villain;
    if (clean.includes('queen') || clean.includes('empress') || clean.includes('ក្សត្រី') || clean.includes('ម្ចាស់ក្សត្រី')) return CHARACTER_PRESETS.Queen;
    if (clean.includes('elder') || clean.includes('master') || clean.includes('old') || clean.includes('លោកតា') || clean.includes('ព្រឹទ្ធាចារ្យ') || clean.includes('គ្រូ') || clean.includes('ចាស់')) return CHARACTER_PRESETS.Elder;
    if (clean.includes('child') || clean.includes('kid') || clean.includes('ក្មេង') || clean.includes('កូនតូច')) return CHARACTER_PRESETS.Child;
    if (clean.includes('female') || clean.includes('ស្រី') || clean.includes('នារី')) return CHARACTER_PRESETS.Female;
    if (clean.includes('male') || clean.includes('ប្រុស') || clean.includes('បុរស')) return CHARACTER_PRESETS.Male;

    return CHARACTER_PRESETS.Male;
}

// Helper: Calculate emotional prosody modifiers (Pitch, Rate, Volume) combined with character base prosody
function getEmotionProsody(emotion, basePitch, baseVolume, _baseSpeed, baseRate) {
    let basePitchVal = 0;
    if (basePitch) {
        const pNum = parseFloat(String(basePitch).replace('Hz', '').trim());
        if (!isNaN(pNum)) basePitchVal = pNum;
    }

    // Emotion changes only pace and loudness, never pitch: every man shares one voice and every
    // woman another, so a pitch shift per emotion (it was -8 Hz Royal to +15 Hz Fear) made the
    // same character sound deep on one line and light on the next.
    let emotionVolOffset = 0;
    let emotionRateOffset = 0;

    if (emotion) {
        const em = String(emotion).toLowerCase().trim();
        if (em === 'angry') {
            emotionVolOffset = 15;
            emotionRateOffset = 12;
        } else if (em === 'sad') {
            emotionVolOffset = -10;
            emotionRateOffset = -12;
        } else if (em === 'whisper') {
            emotionVolOffset = -25;
            emotionRateOffset = -8;
        } else if (em === 'excited') {
            emotionVolOffset = 10;
            emotionRateOffset = 15;
        } else if (em === 'royal') {
            emotionVolOffset = 5;
            emotionRateOffset = -5;
        } else if (em === 'fear') {
            emotionVolOffset = 5;
            emotionRateOffset = 18;
        }
    }

    const totalPitch = basePitchVal;
    const finalPitch = (totalPitch >= 0 ? `+${totalPitch}` : `${totalPitch}`) + 'Hz';

    let baseVolVal = 0;
    if (baseVolume) {
        const vNum = parseFloat(String(baseVolume).replace('%', '').trim());
        if (!isNaN(vNum)) baseVolVal = vNum;
    }
    const totalVol = baseVolVal + emotionVolOffset;
    const finalVolume = (totalVol >= 0 ? `+${totalVol}` : `${totalVol}`) + '%';

    let baseRateVal = 0;
    if (baseRate) {
        const rNum = parseFloat(String(baseRate).replace('%', '').trim());
        if (!isNaN(rNum)) baseRateVal = rNum;
    }

    // Clip speed (_baseSpeed) is intentionally NOT baked into the TTS rate: the timeline applies it via
    // audio.playbackRate (preview) and ffmpeg atempo (render), and baseAudioDuration is measured from
    // this file. Baking it in as well would compound the speed (e.g. 1.5x → 2.25x audible).
    // Only emotion/character rate shaping is applied here, clamped to a natural range.
    const totalSpeedPct = emotionRateOffset + baseRateVal;
    const clampedRatePct = Math.max(-30, Math.min(25, totalSpeedPct));
    const rateStr = clampedRatePct >= 0 ? `+${clampedRatePct}%` : `${clampedRatePct}%`;

    return { pitch: finalPitch, volume: finalVolume, rate: rateStr };
}

// A line's own pace on top of its emotion's (fitRate, in percent): Dub Whole Series asks Edge to
// say a line slower or faster so it lasts as long as the actor talks - natural speech, where
// stretching the finished voice (atempo) sounded drawn out or rushed. "+12%" + fitRate -15 ->
// "-5%" (the two multiply).
function applyFitRate(rateStr, fitRate) {
    const fit = Math.max(-20, Math.min(40, parseFloat(fitRate) || 0));
    if (!fit) return rateStr;
    const base = parseFloat(String(rateStr || '0').replace('%', '')) || 0;
    const pct = Math.max(-40, Math.min(60, Math.round(((1 + base / 100) * (1 + fit / 100) - 1) * 100)));
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

// ── GLOBAL TTS CONCURRENCY REGULATOR ─────────────────────────────────────────
// Protects Microsoft Edge-TTS from connection flooding across multi-tab generation.
// Allows up to 3 concurrent active syntheses with an 80ms launch stagger.
const MAX_CONCURRENT_TTS = 3;
let activeTtsCount = 0;
const ttsQueue = [];

function processNextTts() {
    if (activeTtsCount >= MAX_CONCURRENT_TTS || ttsQueue.length === 0) return;
    const task = ttsQueue.shift();
    activeTtsCount++;
    task(() => {
        activeTtsCount--;
        setTimeout(processNextTts, 80);
    });
}

function queueTtsTask(task) {
    ttsQueue.push(task);
    processNextTts();
}

// One Python process serving every voice line, TTS_LINES_AT_ONCE at a time (the same as batch
// mode). The regulator above is only for the one-process-per-line fallback.
// 12: Microsoft answered 48 lines at 12 at once in 4.6s against 8.1s at 6, with nothing refused
// (16 was faster still; kept lower so a busy night doesn't look like abuse to it).
const TTS_LINES_AT_ONCE = 12;
let ttsTrimNotesShown = 0;
const ttsWorker = createTtsWorker({
    maxInFlight: TTS_LINES_AT_ONCE,
    spawnWorker: () => {
        if (!PYTHON_CMD) throw new Error('No Python');
        const child = spawn(PYTHON_CMD, [getPythonScriptPath('tts_generator.py'), '--serve', '--concurrency', String(TTS_LINES_AT_ONCE)], {
            env: { ...PYTHON_ENV, DR_FFMPEG_PATH: getFFmpegBinary() }, // FFmpeg trims each clip's silence
            windowsHide: true,
        });
        trackProcess(child);
        return child;
    },
    // Same notes as logTtsTrimNotes, capped over the worker's life instead of per process.
    onLog: (line) => {
        if (!line.startsWith('[TTS trim]')) return;
        if (++ttsTrimNotesShown <= 50) console.warn(line);
        else if (ttsTrimNotesShown === 51) console.warn('[TTS trim] ...more clips kept their original padding (not logged)');
    },
});

// 5. Neural Speech Generation with Emotional Acting & High-Speed Cache (Edge-TTS + Khmer)
app.post('/api/generate-audio', (req, res) => {
    const {
        text,
        gender = 'Male',
        character,
        language = 'Khmer',
        voice: customVoice,
        rate = '+0%',
        pitch = '+0Hz',
        volume = '+0%',
        speed = 1.0,
        emotion = 'Neutral',
        fitRate = 0,
        tempPath,
        index
    } = req.body;

    if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ success: false, error: 'Empty text' });
    }

    // Resolve character preset (Hero, Villain, Father, Mother, Elder, Queen, etc.)
    const charPreset = resolveCharacterPreset(character || gender);
    const isFemale = charPreset.gender === 'Female';
    const langStr = String(language || 'khmer').toLowerCase();

    let voice = customVoice;
    if (!voice) {
        if (langStr.includes('en') || langStr.includes('english')) {
            voice = isFemale ? 'en-US-JennyNeural' : 'en-US-GuyNeural';
        } else if (langStr.includes('zh') || langStr.includes('chinese')) {
            voice = isFemale ? 'zh-CN-XiaoxiaoNeural' : 'zh-CN-YunxiNeural';
        } else if (langStr.includes('th') || langStr.includes('thai')) {
            voice = isFemale ? 'th-TH-PremwadeeNeural' : 'th-TH-NiwatNeural';
        } else if (langStr.includes('vi') || langStr.includes('viet')) {
            voice = isFemale ? 'vi-VN-HoaiMyNeural' : 'vi-VN-NamMinhNeural';
        } else if (langStr.includes('ja') || langStr.includes('japan')) {
            voice = isFemale ? 'ja-JP-NanamiNeural' : 'ja-JP-KeitaNeural';
        } else if (langStr.includes('ko') || langStr.includes('korean')) {
            voice = isFemale ? 'ko-KR-SunHiNeural' : 'ko-KR-InJoonNeural';
        } else {
            voice = charPreset.baseVoice;
        }
    }

    // Merge character default pitch and rate if not explicitly overridden
    const effectivePitch = (pitch && pitch !== '+0Hz') ? pitch : charPreset.pitch;
    const effectiveRate = (rate && rate !== '+0%') ? rate : charPreset.rate;

    const prosody = getEmotionProsody(emotion, effectivePitch, volume, speed, effectiveRate);
    prosody.rate = applyFitRate(prosody.rate, fitRate);
    const cacheKey = getTtsCacheKey(text, voice, prosody.rate, prosody.pitch, prosody.volume, speed, emotion);

    // Instant 0ms cache return if identical audio was previously generated
    if (ttsCache.has(cacheKey)) {
        const cached = ttsCache.get(cacheKey);
        if (cached && fs.existsSync(cached.file)) {
            return res.json({
                success: true,
                file: cached.file,
                duration: cached.duration,
                url: cached.url,
                cached: true
            });
        }
    }

    // spawn(null, ...) throws synchronously (not via the 'error' event), which
    // Express's default handler turns into an HTML error page instead of JSON —
    // the frontend's `await response.json()` then fails with "Unexpected token
    // '<'". Guard here (after the cache check above) so a machine with no
    // working Python/edge-tts gets a clear, actionable JSON error instead of a
    // crash, while a cache hit still succeeds even without Python installed.
    if (!PYTHON_CMD) {
        return res.status(500).json({
            success: false,
            error: 'No working Python environment found for text-to-speech. Install Python 3.9-3.11 (with "Add to PATH" checked) and run: pip install edge-tts'
        });
    }

    const outFile = resolveAudioOutputFile(tempPath, index);
    const pyScript = getPythonScriptPath('tts_generator.py');

    // The long-running generator (lib/tts-worker.js); one process per line only if it can't run.
    if (ttsWorker.usable()) {
        const job = ttsWorker.request({ text, voice, rate: prosody.rate, pitch: prosody.pitch, volume: prosody.volume, output: outFile });
        res.on('close', () => { if (!res.writableEnded) job.cancel(); });
        job.promise.then((data) => {
            if (res.headersSent || data.cancelled) return;
            if (!data.success) return res.status(500).json({ success: false, error: data.error || 'TTS error' });
            const freshUrl = `/api/audio?path=${encodeURIComponent(outFile)}`;
            setTtsCache(cacheKey, { file: outFile, duration: data.duration || 0, size: data.size || 0, url: freshUrl });
            res.json({ success: true, file: outFile, duration: data.duration || 0, url: freshUrl });
        });
        return;
    }

    let isAborted = false;
    let child = null;

    res.on('close', () => {
        if (!res.writableEnded) {
            isAborted = true;
            if (child && !child.killed) {
                try { child.kill(); } catch (_) {}
            }
        }
    });

    queueTtsTask((onTtsDone) => {
        if (isAborted || res.headersSent) {
            onTtsDone();
            return;
        }

        child = spawn(PYTHON_CMD, buildTtsArgv({
            script: pyScript, text, voice, rate: prosody.rate, pitch: prosody.pitch, volume: prosody.volume, output: outFile
        }), { env: { ...PYTHON_ENV, DR_FFMPEG_PATH: getFFmpegBinary() } }); // FFmpeg trims each clip's silence
        trackProcess(child);

        let output = '';
        let stderr = '';
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        child.stdout.on('data', d => output += stdoutDecoder.write(d));
        child.stderr.on('data', d => stderr += stderrDecoder.write(d));

        let doneReported = false;
        const completeTts = () => {
            if (!doneReported) {
                doneReported = true;
                onTtsDone();
            }
        };

        child.on('error', (err) => {
            completeTts();
            console.error('[TTS Error]', err);
            if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
        });

        child.on('close', (code) => {
            completeTts();
            // Node can emit both 'error' and 'close' for the same spawn failure
            // (e.g. ENOENT); without this guard the second handler tries to send
            // a second response and crashes the whole backend with ERR_HTTP_HEADERS_SENT.
            if (res.headersSent) return;
            try {
                if (!output.trim()) {
                    console.error(`[TTS Failed] Code ${code}, Stderr: ${stderr}`);
                    return res.status(500).json({ success: false, error: stderr.trim() || `TTS process exited with code ${code}` });
                }
                const data = JSON.parse(output);
                if (data.success) {
                    logTtsTrimNotes(stderr);
                    const freshUrl = `/api/audio?path=${encodeURIComponent(outFile)}`;
                    setTtsCache(cacheKey, {
                        file: outFile,
                        duration: data.duration || 0,
                        size: data.size || 0,
                        url: freshUrl
                    });

                    res.json({
                        success: true,
                        file: outFile,
                        duration: data.duration || 0,
                        url: freshUrl
                    });
                } else {
                    res.status(500).json({ success: false, error: data.error || 'TTS error' });
                }
            } catch (e) {
                console.error('[TTS Parse Error]', e.message, 'Output:', output, 'Stderr:', stderr);
                res.status(500).json({ success: false, error: output.trim() || stderr.trim() || e.message });
            }
        });
    });
});

// 5b. High-Speed Batch Speech Generation (Processes all dialogue cues concurrently)
app.post('/api/generate-batch-audio', async (req, res) => {
    const { subtitles = [], defaultVoice = 'km-KH-PisethNeural', tempPath } = req.body;
    if (!Array.isArray(subtitles) || subtitles.length === 0) {
        return res.status(400).json({ success: false, error: 'Empty subtitles array' });
    }

    const uncachedTasks = [];
    const updatedSubtitles = [...subtitles];

    for (let i = 0; i < updatedSubtitles.length; i++) {
        const sub = updatedSubtitles[i];
        const text = (sub.dubbedText || sub.text || sub.originalText || '').trim();
        if (!text) continue;

        const charPreset = resolveCharacterPreset(sub.character || sub.gender);
        let voice = sub.voice;
        if (!voice) {
            voice = charPreset.baseVoice;
        }
        const effectivePitch = (sub.pitch && sub.pitch !== '+0Hz') ? sub.pitch : charPreset.pitch;
        const effectiveRate = (sub.rate && sub.rate !== '+0%') ? sub.rate : charPreset.rate;
        const prosody = getEmotionProsody(sub.emotion, effectivePitch, sub.volume, sub.speed, effectiveRate);
        const cacheKey = getTtsCacheKey(text, voice, prosody.rate, prosody.pitch, prosody.volume, sub.speed, sub.emotion);

        if (ttsCache.has(cacheKey)) {
            const cached = ttsCache.get(cacheKey);
            if (cached && fs.existsSync(cached.file)) {
                sub.audioPath = cached.file;
                sub.file = cached.file;
                sub.audioUrl = cached.url;
                sub.generatedDuration = cached.duration;
                sub.audioStatus = 'ready';
                continue;
            }
        }

        const outFile = resolveAudioOutputFile(tempPath, sub.id || i + 1);
        uncachedTasks.push({
            id: sub.id || `sub_${i}`,
            subIndex: i,
            text,
            voice,
            rate: prosody.rate,
            pitch: prosody.pitch,
            volume: prosody.volume,
            output: outFile,
            cacheKey
        });
    }

    if (uncachedTasks.length === 0) {
        return res.json({
            success: true,
            count: updatedSubtitles.length,
            subtitles: updatedSubtitles
        });
    }

    // spawn(null, ...) throws synchronously (not via the 'error' event), which
    // Express's default handler turns into an HTML error page instead of JSON.
    // Only check this once we know we actually need to spawn — an all-cached
    // batch above should still succeed with no Python environment at all.
    if (!PYTHON_CMD) {
        return res.status(500).json({
            success: false,
            error: 'No working Python environment found for text-to-speech. Install Python 3.9-3.11 (with "Add to PATH" checked) and run: pip install edge-tts'
        });
    }

    const batchJsonPath = path.join(AUDIO_CACHE_DIR, `batch_${Date.now()}_${Math.round(Math.random() * 1e6)}.json`);
    fs.writeFileSync(batchJsonPath, JSON.stringify(uncachedTasks), 'utf8');

    const pyScript = getPythonScriptPath('tts_generator.py');
    const child = spawn(PYTHON_CMD, [pyScript, '--batch', batchJsonPath, '--concurrency', String(TTS_LINES_AT_ONCE)], { env: { ...PYTHON_ENV, DR_FFMPEG_PATH: getFFmpegBinary() } }); // FFmpeg trims each clip's silence
    trackProcess(child);

    let output = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout.on('data', d => output += stdoutDecoder.write(d));
    child.stderr.on('data', d => stderr += stderrDecoder.write(d));

    // A child with zero 'error' listeners that emits 'error' (e.g. PYTHON_CMD
    // missing/ENOENT) is an uncaught exception in Node and crashes the whole
    // backend process, not just this request. This was previously unguarded.
    child.on('error', (err) => {
        console.error('[Batch TTS Error]', err);
        try { fs.unlinkSync(batchJsonPath); } catch (e) {}
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    });

    child.on('close', (code) => {
        if (res.headersSent) return;
        try { fs.unlinkSync(batchJsonPath); } catch (e) {}
        try {
            const parsed = JSON.parse(output);
            if (parsed.success && Array.isArray(parsed.results)) {
                logTtsTrimNotes(stderr);
                const taskById = new Map(uncachedTasks.map(t => [t.id, t]));
                for (const r of parsed.results) {
                    if (r.success) {
                        const task = taskById.get(r.id);
                        if (task) {
                            const sub = updatedSubtitles[task.subIndex];
                            const freshUrl = `/api/audio?path=${encodeURIComponent(r.file)}`;
                            sub.audioPath = r.file;
                            sub.file = r.file;
                            sub.audioUrl = freshUrl;
                            sub.generatedDuration = r.duration;
                            sub.audioStatus = 'ready';

                            setTtsCache(task.cacheKey, {
                                file: r.file,
                                duration: r.duration,
                                size: r.size,
                                url: freshUrl
                            });
                        }
                    }
                }
                res.json({
                    success: true,
                    count: updatedSubtitles.length,
                    subtitles: updatedSubtitles
                });
            } else {
                res.status(500).json({ success: false, error: parsed.error || 'Batch generation failed' });
            }
        } catch (e) {
            console.error('[Batch TTS Error]', e.message, output, stderr);
            res.status(500).json({ success: false, error: output || stderr || e.message });
        }
    });
});

app.post('/api/generate-voxcmp2', async (req, res) => {
    const { text, serverUrl = 'http://127.0.0.1:8808', tempPath, profile, index, speed = 1.0, emotion = 'Neutral' } = req.body;
    const outFile = resolveAudioOutputFile(tempPath, index);

    const logVox = (msg) => {
        try {
            const line = `[${new Date().toISOString()}] ${msg}\n`;
            fs.appendFileSync(path.join(LOGS_DIR, 'voxcpm_debug.log'), line, 'utf8');
        } catch (_) {}
    };

    // Normalize localhost to 127.0.0.1 to prevent Node.js 18+ IPv6 (::1) ECONNREFUSED on Windows
    let baseUrl = (serverUrl || 'http://127.0.0.1:8808').replace(/\/+$/, '');
    if (baseUrl.includes('localhost')) {
        baseUrl = baseUrl.replace('localhost', '127.0.0.1');
    }

    logVox(`[Request] text="${(text || '').slice(0, 30)}..." baseUrl=${baseUrl} outFile=${outFile}`);

    try {
        let refAudioBase64 = null;
        if (profile && profile.audioPath && fs.existsSync(profile.audioPath)) {
            try {
                refAudioBase64 = fs.readFileSync(profile.audioPath).toString('base64');
            } catch (refErr) {
                console.warn('[VoxCPM2] Could not read reference audio file:', refErr.message);
                logVox(`[Warn] Read ref audio failed: ${refErr.message}`);
            }
        }

        const payload = {
            text,
            instruction: (profile && profile.instruction) || '',
            reference_audio: (profile && profile.audioPath) || '',
            reference_audio_base64: refAudioBase64,
            speed: parseFloat(speed) || 1.0,
            emotion: emotion || 'Neutral',
            cfg_value: parseFloat(req.body.cfg_value) || 2.0,
            // The line's room: a take that fits it is kept over one that would play rushed.
            fit_seconds: parseFloat(req.body.fit_seconds) || null,
            // How the line is said (the actor's own line, or their clip of this feeling).
            feeling_audio_base64: typeof req.body.feeling_audio_base64 === 'string' ? req.body.feeling_audio_base64 : null,
            feeling_from: String(req.body.feeling_from || ''),
            line_level_db: Number.isFinite(req.body.line_level_db) ? req.body.line_level_db : null,
            output_path: outFile,
            profile: profile || null
        };

        const controller = new AbortController();
        // VoxCPM2 on a CPU (no NVIDIA card) takes about 30 s per second of speech, so a long
        // line needs minutes; 2 minutes cut those off and the page then voiced them again.
        const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000);

        let targetEndpoint = `${baseUrl}/api/generate`;
        logVox(`[Send] POST ${targetEndpoint}`);

        let response;
        const requestHeaders = {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };

        try {
            response = await secureFetch(targetEndpoint, {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } catch (fetchErr) {
            logVox(`[Fetch Primary Error] ${fetchErr.message} (cause: ${fetchErr.cause ? fetchErr.cause.message : 'none'})`);
            const altBaseUrl = baseUrl.includes('127.0.0.1') ? baseUrl.replace('127.0.0.1', 'localhost') : baseUrl;
            targetEndpoint = `${altBaseUrl}/api/generate`;
            logVox(`[Retry Alternative] POST ${targetEndpoint}`);
            response = await secureFetch(targetEndpoint, {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        }

        // If /api/generate returned 404, fallback to /generate
        if (response.status === 404) {
            const fallbackEndpoint = `${baseUrl}/generate`;
            logVox(`[/api/generate returned 404, trying /generate] POST ${fallbackEndpoint}`);
            response = await secureFetch(fallbackEndpoint, {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        }

        clearTimeout(timeout);
        logVox(`[Response Status] HTTP ${response.status}`);

        if (!response.ok) {
            const errText = await response.text();
            logVox(`[Response Error Text] ${errText}`);
            throw new Error(`VoxCPM2 server returned HTTP ${response.status}: ${errText}`);
        }

        const data = await response.json();
        if (data.success === false) {
            logVox(`[Data Failure] ${data.error}`);
            throw new Error(data.error || 'VoxCPM2 generation failed.');
        }

        // If returned as base64 from a remote cloud server (e.g. Google Colab)
        if (data.audio_base64) {
            fs.mkdirSync(path.dirname(outFile), { recursive: true });
            fs.writeFileSync(outFile, Buffer.from(data.audio_base64, 'base64'));
            logVox(`[Audio File Saved] ${outFile}`);
        }

        const duration = data.duration || 0;
        return res.json({
            success: true,
            file: outFile,
            duration: duration,
            url: `/api/audio?path=${encodeURIComponent(outFile)}`
        });
    } catch (err) {
        logVox(`[Crash Error] ${err.message}`);
        console.error('[VoxCPM2 Request Failed]', err.message);
        return res.status(500).json({
            success: false,
            error: `VoxCPM2 synthesis failed: ${err.message}. Please ensure the VoxCPM2 server is started in Settings -> VoxCPM2 AI.`
        });
    }
});

// Endpoint to save audio base64 directly from browser (for remote Colab / cloud GPU synthesis)
app.post('/api/save-audio-file', express.json({ limit: '50mb' }), (req, res) => {
    try {
        const { tempPath, index, audioBase64, filePath } = req.body;
        if (!audioBase64) {
            return res.status(400).json({ success: false, error: 'No audioBase64 provided' });
        }
        if (filePath && !isAudioFile(filePath)) {
            return res.status(400).json({ success: false, error: 'filePath must be an audio file (.mp3, .wav, ...)' });
        }
        const targetFile = filePath || resolveAudioOutputFile(tempPath, index);
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        const buffer = Buffer.from(audioBase64, 'base64');
        fs.writeFileSync(targetFile, buffer);
        
        return res.json({
            success: true,
            file: targetFile,
            size: buffer.length,
            url: `/api/audio?path=${encodeURIComponent(targetFile)}`
        });
    } catch (err) {
        console.error('[Save Audio File Error]', err.message);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 5c-11. Hardware encoders, voices, preview/episodes/split job routes,
// the render pipeline, system telemetry, folder management and logging
// endpoints now live in backend/routes/ (extracted verbatim; see those
// files for the per-route code). CHARACTER_PRESETS stays here since it's
// shared with the TTS generation logic further down this file.
app.get('/api/characters', (req, res) => {
    res.json({ success: true, characters: CHARACTER_PRESETS });
});

// Any-format preview: probes the file and, if Chromium can't play it, builds a playable
// copy in the background (see media_preview.js). Export/transcribe keep using the original.
const audioRepair = createAudioRepair({
    repairDir: AUDIO_REPAIR_DIR,
    getFFmpegBinary,
    getFFprobeBinary,
    trackProcess
});

const previewService = createPreviewService({
    previewDir: PREVIEW_DIR,
    audioRepair,
    getFFmpegBinary,
    getFFprobeBinary,
    detectAvailableEncoders,
    trackProcess
});

// Join Episodes: many short downloaded episodes -> a few ~1 hour parts to dub.
const episodeJoiner = createEpisodeJoiner({ getFFmpegBinary, getFFprobeBinary, detectAvailableEncoders, trackProcess, audioRepair });

// Split Movie: one long movie -> ~30 minute parts, each dubbed as its own project.
const videoSplitter = createVideoSplitter({ getFFmpegBinary, getFFprobeBinary, trackProcess });

app.use('/api', require('./routes/system')({ detectAvailableEncoders }));
app.use('/api', require('./routes/preview')({ previewService }));
app.use('/api', require('./routes/waveform')({ getFFmpegBinary }));
// The separated vocals of a video, when an ML engine has already isolated it (FFmpeg's
// phase-cancel "vocals" are band-limited, no better than the original for a voice).
function findVocalStem(videoPath) {
    for (const engine of BGM_ENGINES.filter((e) => e !== 'ffmpeg')) {
        const hit = lookupCachedStems(SEPARATED_DIR, cacheKeyForFile(videoPath, engine, bgmEngineModel(engine)));
        if (hit) return hit.vocal;
    }
    return null;
}
app.use('/api', require('./routes/voice-capture')({ getFFmpegBinary, getFFprobeBinary, audioRepair, trackProcess, findVocalStem }));
app.use('/api/episodes', require('./routes/episodes')({ episodeJoiner }));
app.use('/api/split', require('./routes/split')({ videoSplitter }));
app.use('/api', require('./routes/render')({ upload, renderVideo, cancelRender, getRenderProgress, audioRepair }));
// On-screen subtitle detection (the render blurs them while they show).
const textDetect = require('./text_detect_service').createTextDetectService({
    pythonCmd: PYTHON_CMD,
    pythonEnv: PYTHON_ENV,
    scriptPath: getPythonScriptPath('text_detector.py'),
    requirementsPath: getPythonScriptPath('requirements-textdetect.txt'),
    ffmpegPath: getFFmpegBinary(),
    cacheDir: path.join(STORAGE_BASE, 'text_detect'),
    trackProcess,
    killProcessTree,
});
app.use('/api', require('./routes/text-detect')({ textDetect }));
app.use('/api', require('./routes/series-checkpoint')());
const pronunciationRouter = require('./routes/pronunciation')({ getFFmpegBinary, getPythonScriptPath, trackProcess });
app.use('/api', pronunciationRouter);

const { getDRRouterManager } = require('./lib/dr-router');
const drRouterManager = getDRRouterManager();
if (drRouterManager.proxyEnabled) drRouterManager.startProxy();
const drRouterApi = require('./routes/dr-router')({ drRouterManager });
app.use('/api/dr-router', drRouterApi);
app.use('/api/dapool', drRouterApi);

const geminiRouter = require('./routes/gemini')({
    getFFmpegBinary,
    getFFprobeBinary,
    audioRepair,
    backgroundable,
    saveTranscribeAudio,
    keyRest
});
app.use('/api', geminiRouter);

// Loopback only: the API reads, writes and launches local files, so it must
// never be reachable from other machines on the network.
const server = app.listen(PORT, '127.0.0.1');

// main.js waits on this before loading the window. If the port is taken, some
// other program owns http://localhost:PORT and the app must not load its page.
app.locals.ready = new Promise((resolve, reject) => {
    server.once('listening', () => {
        console.log(`[DR Dubber Pro Server] Listening on http://localhost:${PORT} (127.0.0.1 only; outgoing HTTPS via ${fetchBackend()})`);
        if (require.main === module) {
            console.log(`[DR Dubber Pro Server] Open http://localhost:${PORT}/?t=${security.getApiToken()} in your browser to sign in.`);
        }
        resolve();
    });
    server.once('error', (err) => {
        console.error('[DR Dubber Pro Server Error]', err);
        reject(err);
    });
});
app.locals.ready.catch(() => {});

module.exports = app;
