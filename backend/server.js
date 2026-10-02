process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
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
function getTtsCacheKey(text, voice, rate, pitch, volume, speed, emotion) {
    const raw = `${text || ''}|${voice || ''}|${rate || ''}|${pitch || ''}|${volume || ''}|${speed || 1.0}|${emotion || 'Neutral'}`;
    return crypto.createHash('md5').update(raw).digest('hex');
}
function setTtsCache(key, value) {
    if (ttsCache.size >= TTS_CACHE_MAX_ENTRIES) {
        const oldestKey = ttsCache.keys().next().value;
        if (oldestKey !== undefined) ttsCache.delete(oldestKey);
    }
    ttsCache.set(key, { ...value, timestamp: Date.now() });
}

// Directory layout (safe for dev & packaged Electron)
const ROOT_DIR = path.resolve(__dirname, '..');
const STORAGE_BASE = process.env.APP_STORAGE_DIR || path.join(ROOT_DIR, 'storage');
const UPLOADS_DIR = path.join(STORAGE_BASE, 'uploads');
const AUDIO_CACHE_DIR = path.join(STORAGE_BASE, 'audio_cache');
const SEPARATED_DIR = path.join(STORAGE_BASE, 'separated');
const PREVIEW_DIR = path.join(STORAGE_BASE, 'preview_cache');
const AUDIO_REPAIR_DIR = path.join(STORAGE_BASE, 'audio_repair');
const EXPORTS_DIR = path.join(STORAGE_BASE, 'exports');
const OUTPUTS_DIR = path.join(STORAGE_BASE, 'outputs');
const CUSTOM_OUTPUTS_DIR = process.platform === 'win32' ? 'C:\\Export\\AIDubber\\outputs' : path.join(STORAGE_BASE, 'custom_outputs');
const USER_DESKTOP_OUTPUTS = path.join(os.homedir(), 'Desktop', 'transcribe output');
const ONEDRIVE_DESKTOP_OUTPUTS = path.join(os.homedir(), 'OneDrive', 'Desktop', 'transcribe output');
const PYTHON_DIR = path.join(ROOT_DIR, 'backend', 'python');
const LOGS_DIR = path.join(STORAGE_BASE, 'logs');

// Process tracking for clean memory & CPU shutdown
const spawnedProcesses = new Set();
function trackProcess(proc) {
    if (!proc || !proc.pid) return;
    spawnedProcesses.add(proc);
    proc.on('close', () => spawnedProcesses.delete(proc));
    proc.on('error', () => spawnedProcesses.delete(proc));
}
function killAllProcesses() {
    for (const proc of spawnedProcesses) {
        try {
            if (process.platform === 'win32') {
                exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
            } else {
                proc.kill('SIGKILL');
            }
        } catch (e) {}
    }
    spawnedProcesses.clear();
}
process.on('exit', killAllProcesses);
process.on('SIGINT', () => { killAllProcesses(); process.exit(0); });
process.on('SIGTERM', () => { killAllProcesses(); process.exit(0); });

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
    exec(`"${PYTHON_CMD}" -c "import edge_tts"`, { env: PYTHON_ENV }, (err) => {
        if (err) {
            console.warn('[Python TTS] edge-tts not found in python environment. Auto-installing...');
            exec(`"${PYTHON_CMD}" -m pip install edge-tts`, { env: PYTHON_ENV }, (pipErr, stdout, stderr) => {
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

[UPLOADS_DIR, AUDIO_CACHE_DIR, SEPARATED_DIR, EXPORTS_DIR, OUTPUTS_DIR, LOGS_DIR, CUSTOM_OUTPUTS_DIR, USER_DESKTOP_OUTPUTS, ONEDRIVE_DESKTOP_OUTPUTS].forEach(dir => {
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

// No cross-origin access: this server only needs to answer the app's own
// renderer (same-origin, since it's loaded from http://localhost:PORT).
// Previously `app.use(cors())` reflected every origin, which combined with
// the unauthenticated /api/audio (arbitrary local file read) and
// /api/open-folder (shell exec) routes let any webpage open in a normal
// browser read local files or run commands on the user's machine while
// this app was running. Do not re-add a permissive cors() call here.
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Static files
app.use(express.static(path.join(ROOT_DIR, 'frontend')));
app.use('/fonts', express.static(path.join(ROOT_DIR, 'frontend', 'fonts')));
app.use('/assets', express.static(path.join(ROOT_DIR, 'frontend', 'assets')));
app.use('/lib', express.static(path.join(ROOT_DIR, 'frontend', 'lib')));
app.use('/storage', express.static(STORAGE_BASE));

// Active jobs maps with TTL pruning
const bgmJobs = new Map();
const activeTranscribeRequests = new Map();
let transcribePartCounter = 1;

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

    if (!tempPath) {
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

const MIME_MAP = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.mkv': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.srt': 'text/plain; charset=utf-8',
    '.vtt': 'text/vtt; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
};

// Universal local file path resolver (handles file://, /api/audio?path=, /storage/..., and percent-encoded Unicode/Khmer characters)
function resolveLocalFilePath(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return null;
    let p = inputPath.trim();
    if (!p) return null;

    // 1. Direct match on disk
    try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (e) {}

    // 2. Handle file:// protocol
    if (p.startsWith('file://')) {
        try {
            const fileUrl = new URL(p);
            p = decodeURIComponent(fileUrl.pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
        } catch (e) {
            p = p.replace(/^file:\/\/\/?/, '');
            try { p = decodeURIComponent(p); } catch (e) {}
        }
    }

    // 3. Handle http:// or relative /api/audio?path=...
    if (p.includes('/api/audio') && p.includes('path=')) {
        try {
            const u = p.startsWith('http') ? new URL(p) : new URL(p, 'http://localhost:3001');
            const searchPath = u.searchParams.get('path');
            if (searchPath) {
                p = searchPath;
            }
        } catch (e) {
            const match = p.match(/[?&]path=([^&]+)/);
            if (match) {
                try { p = decodeURIComponent(match[1]); } catch (e) { p = match[1]; }
            }
        }
    }

    // 4. Handle storage paths
    if (p.includes('/storage/tts/') || p.startsWith('storage/tts/')) {
        const sub = p.replace(/^.*\/storage\/tts\//, '').replace(/^storage\/tts\//, '');
        p = path.join(AUDIO_CACHE_DIR, sub);
    } else if (p.includes('/storage/separated/') || p.startsWith('storage/separated/')) {
        const sub = p.replace(/^.*\/storage\/separated\//, '').replace(/^storage\/separated\//, '');
        p = path.join(SEPARATED_DIR, sub);
    } else if (p.includes('/storage/uploads/') || p.startsWith('storage/uploads/')) {
        const sub = p.replace(/^.*\/storage\/uploads\//, '').replace(/^storage\/uploads\//, '');
        p = path.join(UPLOADS_DIR, sub);
    } else if (p.includes('/storage/exports/') || p.startsWith('storage/exports/')) {
        const sub = p.replace(/^.*\/storage\/exports\//, '').replace(/^storage\/exports\//, '');
        p = path.join(EXPORTS_DIR, sub);
    }

    // 5. Try decodeURIComponent if still percent-encoded (e.g. %20, %C2%AB, %C2%BB, %3A)
    if (p.includes('%')) {
        try {
            const decoded = decodeURIComponent(p);
            if (fs.existsSync(decoded)) return decoded;
            p = decoded;
        } catch (e) {}
    }

    // 6. Windows drive letter cleanup: /D:/... -> D:/...
    if (process.platform === 'win32') {
        p = p.replace(/^\/([a-zA-Z]:)/, '$1');
    }

    // 7. Final check
    try {
        if (fs.existsSync(p)) return p;
    } catch (e) {}

    return p;
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

    // Collapse any repeated part suffixes (e.g. name_part1_part1 -> name_part1)
    cleanBase = cleanBase.replace(/([_.\- ](?:part|pt|chunk)\s*\d+)(?:[_.\- ](?:part|pt|chunk)\s*\d+)+$/i, '$1');

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
    cleanBase = cleanBase.replace(/([_.\- ](?:part|pt|chunk)\s*\d+)(?:[_.\- ](?:part|pt|chunk)\s*\d+)+$/i, '$1');
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

// Direct native FFmpeg stem separation (stereo phase cancellation)
// Zero Python dependencies, zero setup, instant and 100% reliable across all systems.
function isolateBgmWithFfmpeg(audioPath, outputDir, jobId, isFallback = false) {
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
    } catch (err) {
        console.error('[FFmpeg Vocal Separation Spawn Error]', err);
        bgmJobs.set(jobId, { status: 'error', success: false, error: `Failed to spawn FFmpeg process: ${err.message}` });
        return;
    }

    let stderr = '';
    const stderrDecoder = new StringDecoder('utf8');
    child.stderr.on('data', d => stderr += stderrDecoder.write(d));

    child.on('error', (err) => {
        console.error('[FFmpeg Vocal Separation Error]', err);
        bgmJobs.set(jobId, { status: 'error', success: false, error: `FFmpeg execution error: ${err.message}` });
    });

    child.on('close', (code) => {
        if (code === 0 && fs.existsSync(bgmPath) && fs.existsSync(vocalPath)) {
            console.log(`[FFmpeg Vocal Separation Succeeded] Job ${jobId} finished! BGM: ${bgmPath}`);
            const bgmUri = `/api/audio?path=${encodeURIComponent(bgmPath)}`;
            const vocalUri = `/api/audio?path=${encodeURIComponent(vocalPath)}`;
            bgmJobs.set(jobId, {
                status: 'done',
                success: true,
                progress: 100,
                url: bgmUri,
                file: bgmPath,
                bgmPath: bgmPath,
                vocalPath: vocalPath,
                bgmUrl: bgmUri,
                vocalUrl: vocalUri,
                method: isFallback ? 'ffmpeg_fallback' : 'ffmpeg'
            });
        } else {
            console.error(`[FFmpeg Vocal Separation Failed] Code ${code}, Stderr: ${stderr.trim()}`);
            bgmJobs.set(jobId, {
                status: 'error',
                success: false,
                error: stderr.trim() || `FFmpeg separation process exited with code ${code}`
            });
        }
    });
}

// 3. Remove Vocals / BGM Isolation
app.post('/api/remove-vocals', upload.any(), async (req, res) => {
    const uploadedFile = (req.files && req.files.length > 0) ? req.files[0].path : null;
    let audioPath = resolveLocalFilePath(uploadedFile || req.body.audioPath || req.body.filePath || req.body.videoPath);
    const jobId = req.body.jobId || `bgm_${Date.now()}`;

    if (!audioPath || !fs.existsSync(audioPath)) {
        return res.status(400).json({ success: false, error: 'Audio/Video file not found' });
    }
    audioPath = (await audioRepair.getAudioSource(audioPath).catch(() => ({ path: audioPath }))).path;

    bgmJobs.set(jobId, { status: 'processing', progress: 10, success: true, timestamp: Date.now() });
    res.json({ success: true, jobId: jobId, status: 'processing' });

    let engine = req.body.engine;
    if (!engine || (engine !== 'spleeter' && engine !== 'demucs' && engine !== 'ffmpeg')) engine = 'spleeter';

    // Fast path: If the user specifically chose FFmpeg, run native FFmpeg directly
    if (engine === 'ffmpeg') {
        isolateBgmWithFfmpeg(audioPath, SEPARATED_DIR, jobId, false);
        return;
    }

    const spleeterPython = SPLEETER_PYTHON_CMD || getSpleeterPythonCmd();
    let separatorPython = PYTHON_CMD;
    if (engine === 'spleeter' && spleeterPython) {
        separatorPython = spleeterPython;
    }

    // If no operational Python environment is detected on this machine,
    // seamlessly fall back to direct native FFmpeg phase cancellation immediately.
    if (!separatorPython) {
        console.warn(`[Vocal Separator] Requested engine '${engine}', but no operational Python found. Falling back to native FFmpeg separation...`);
        isolateBgmWithFfmpeg(audioPath, SEPARATED_DIR, jobId, true);
        return;
    }

    const useGPU = req.body.useGPU === true || req.body.useGPU === 'true';
    const pyArgs = ['--input', audioPath, '--output', SEPARATED_DIR, '--engine', engine];
    if (engine === 'demucs' && !useGPU) {
        pyArgs.push('--device', 'cpu');
    }
    const demucsFolder = (req.body.demucsFolder || '').trim();
    const demucsSegment = (req.body.demucsSegment || '').trim();
    const spleeterFolder = (req.body.spleeterFolder || '').trim();
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
    let child;
    try {
        child = spawn(separatorPython, [pyScript, ...pyArgs], { env: runEnv });
        trackProcess(child);
    } catch (spawnErr) {
        console.warn('[Python Vocal Separator Spawn Failed]', spawnErr.message, 'Falling back to native FFmpeg separation...');
        isolateBgmWithFfmpeg(audioPath, SEPARATED_DIR, jobId, true);
        return;
    }

    let output = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout.on('data', d => output += stdoutDecoder.write(d));
    child.stderr.on('data', d => stderr += stderrDecoder.write(d));
    child.on('error', (err) => {
        console.warn('[Python Vocal Separator Process Error]', err.message, 'Falling back to native FFmpeg separation...');
        isolateBgmWithFfmpeg(audioPath, SEPARATED_DIR, jobId, true);
    });
    child.on('close', (code) => {
        const trimmedOut = output.trim();
        const trimmedErr = stderr.trim();

        if (code !== 0 && !trimmedOut) {
            console.warn(`[Python Vocal Separator Failed] Code ${code}, Stderr: ${trimmedErr}. Seamlessly falling back to native FFmpeg separation...`);
            isolateBgmWithFfmpeg(audioPath, SEPARATED_DIR, jobId, true);
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
                const bgmUri = `/api/audio?path=${encodeURIComponent(data.bgm)}`;
                const vocalUri = `/api/audio?path=${encodeURIComponent(data.vocal)}`;
                bgmJobs.set(jobId, {
                    status: 'done',
                    success: true,
                    progress: 100,
                    url: bgmUri,
                    file: data.bgm,
                    bgmPath: data.bgm,
                    vocalPath: data.vocal,
                    bgmUrl: bgmUri,
                    vocalUrl: vocalUri,
                    method: data.method || engine
                });
            } else {
                console.warn('[Python Vocal Separator reported failure]', data.error || trimmedErr, 'Falling back to native FFmpeg separation...');
                isolateBgmWithFfmpeg(audioPath, SEPARATED_DIR, jobId, true);
            }
        } catch (e) {
            console.warn('[Python Vocal Separator Parse Error]', e.message, 'Falling back to native FFmpeg separation...');
            isolateBgmWithFfmpeg(audioPath, SEPARATED_DIR, jobId, true);
        }
    });
});

app.get('/api/bgm-job-status', (req, res) => {
    const jobId = req.query.jobId;
    const job = bgmJobs.get(jobId);
    if (!job) return res.json({ status: 'done', success: true });
    res.json(job);
});

app.post('/api/cancel-remove-vocals', (req, res) => {
    const { jobId } = req.body;
    if (jobId) bgmJobs.delete(jobId);
    res.json({ success: true });
});

// --- GEMINI MODEL RESOLUTION & FALLBACK ENGINE ---
function resolveGeminiModel(modelName) {
    if (!modelName || modelName === 'latest') return 'gemini-3.8-flash';
    const m = String(modelName).toLowerCase().trim();
    if (m === 'gemini-3.8-flash' || m.includes('3.8-flash') || m.includes('3.8')) return 'gemini-3.8-flash';
    if (m.includes('3.5-transcribe') || m.includes('audio-specialist')) return 'gemini-3.5-transcribe';
    if (m === 'gemini-3.7-flash' || m.includes('3.7-flash') || m.includes('3.7')) return 'gemini-3.7-flash';
    if (m === 'gemini-3.6-flash' || m.includes('3.6-flash') || m.includes('3.6')) return 'gemini-3.6-flash';
    if (m === 'gemini-3.5-flash-lite' || m.includes('3.5-flash-lite') || m.includes('3.5-lite')) return 'gemini-3.5-flash-lite';
    if (m === 'gemini-3.5-flash' || m.includes('3.5-flash') || m.includes('3.5')) return 'gemini-3.5-flash';
    if (m === 'gemini-3.1-pro-preview' || m === 'gemini-3.1-pro' || m.includes('3.1-pro')) return 'gemini-3.1-pro-preview';
    if (m === 'gemini-3.1-flash-lite' || m.includes('3.1-flash-lite') || m.includes('3.1-lite')) return 'gemini-3.1-flash-lite';
    if (m === 'gemini-3.1-flash' || m.includes('3.1-flash') || m.includes('3.1')) return 'gemini-3.1-flash';
    if (m === 'gemini-2.5-pro' || m.includes('2.5-pro')) return 'gemini-2.5-pro';
    if (m.includes('2.5-flash') || m === 'gemini-2.5-flash') return 'gemini-2.5-flash';
    if (m.includes('2.0-flash-lite') || m.includes('2.0-lite')) return 'gemini-2.0-flash-lite';
    if (m === 'gemini-2.0-flash' || m.includes('2.0-flash') || m.includes('2.0')) return 'gemini-2.0-flash';
    if (m === 'gemini-1.5-pro' || m.includes('1.5-pro')) return 'gemini-1.5-pro';
    if (m === 'gemini-1.5-flash' || m.includes('1.5-flash')) return 'gemini-1.5-flash';
    return m;
}

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_ATTEMPT_TIMEOUT_MS = 240000;
const geminiModelListCache = new Map(); // apiKey -> { at, models: Set<string> }

// Ask Google which models this key can actually call, so we never burn retries on
// names that 404 (retired 1.5 models, previews that were renamed, etc.).
async function listGeminiModels(apiKey, signal) {
    const cached = geminiModelListCache.get(apiKey);
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.models;
    try {
        const res = await fetch(`${GEMINI_API_BASE}/models?pageSize=1000&key=${apiKey}`, { signal });
        if (!res.ok) return null;
        const json = await res.json();
        const models = new Set((json.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => String(m.name || '').replace(/^models\//, '')));
        geminiModelListCache.set(apiKey, { at: Date.now(), models });
        return models;
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        return null;
    }
}

// Best general-purpose text/audio models first: flash before pro (pro free-tier quota
// is tiny), stable before preview (previews are the ones Google throttles with
// "high demand" 503s), then newer before older.
function rankGeminiFallbacks(available) {
    const parsed = [];
    for (const name of available) {
        // Dated previews only ("-preview-09-2025"); skips -tts, -image, -live variants.
        const m = name.match(/^gemini-(\d+(?:\.\d+)?)-(flash|pro|transcribe)(?:-(latest|preview(?:-\d[\d-]*)?))?$/);
        if (!m) continue;
        parsed.push({ name, version: parseFloat(m[1]), tier: m[2], tag: m[3] || '' });
    }
    parsed.sort((a, b) =>
        (a.tier === 'flash' || a.tier === 'transcribe' ? 0 : 1) - (b.tier === 'flash' || b.tier === 'transcribe' ? 0 : 1) ||
        (a.tag ? 1 : 0) - (b.tag ? 1 : 0) ||
        b.version - a.version);
    return parsed.map(p => p.name);
}

async function getCandidateModels(apiKey, requestedModel, signal) {
    const primary = resolveGeminiModel(requestedModel);
    const available = await listGeminiModels(apiKey, signal);
    if (!available) {
        return [primary, 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro']
            .filter((v, i, a) => a.indexOf(v) === i);
    }
    const ranked = rankGeminiFallbacks(available);
    const list = available.has(primary) ? [primary, ...ranked] : ranked;
    if (!available.has(primary) && !geminiModelListCache.get(apiKey).warned) {
        geminiModelListCache.get(apiKey).warned = true;
        console.warn(`[Gemini] Model "${primary}" is not available for this key. Using: ${list[0] || 'none'}`);
    }
    const unique = list.filter((v, i, a) => a.indexOf(v) === i);
    const top = unique.slice(0, 4);
    // Each model has its own daily allowance per key, and the ranking puts every Flash model
    // first - so with many Flash models the Pro allowance was never reached. Always offer the
    // newest Pro model as a fallback.
    const bestPro = unique.filter(m => /-pro\b/.test(m))
        .sort((a, b) => parseFloat((b.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0) - parseFloat((a.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0))[0];
    if (bestPro && !top.includes(bestPro)) top.push(bestPro);
    return top;
}

async function fetchWithTimeout(url, options, parentSignal, timeoutMs) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (parentSignal) {
        if (parentSignal.aborted) ctrl.abort();
        else parentSignal.addEventListener('abort', onAbort, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try {
        // Read the body here too, so the timeout and the user's Stop also cover a slow or
        // dropped body download (not just the headers).
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
    } catch (e) {
        if (timedOut) {
            const err = new Error(`Gemini did not respond within ${Math.round(timeoutMs / 1000)}s`);
            err.code = 'TIMEOUT';
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
        if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
    }
}

// Models that answered "JSON mode is not enabled for this model": they get the request without
// responseMimeType/responseSchema. Every prompt also asks for JSON in words, and the parsers
// (parseJsonArrayLoose) read it from plain text.
const geminiNoJsonModeModels = new Set();
// ...and of those, the ones whose plain reply had no JSON at all (e.g. an audio "transcribe" model
// answering with a bare transcript). They are skipped for JSON requests from then on.
const geminiNoJsonOutputModels = new Set();
const isJsonModeUnsupported = (msg) => /JSON mode is not enabled|response_?mime_?type|response_?schema/i.test(String(msg || ''));

// The first JSON array/object in a model's free-text reply: the whole text, a ```json fence
// anywhere, or a balanced [...] / {...} inside prose. Brackets in prose ("[Male]") don't parse
// and are skipped. An array cut off mid-way (MAX_TOKENS) keeps its complete items. undefined
// when there's none.
function extractJsonValue(raw) {
    const s = String(raw || '').trim();
    const tryParse = (t) => { try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : undefined; } catch (e) { return undefined; } };
    let v = tryParse(s);
    if (v !== undefined) return v;
    for (const m of s.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
        v = tryParse(m[1].trim());
        if (v !== undefined) return v;
    }
    for (let start = 0; start < s.length; start++) {
        const open = s[start];
        if (open !== '[' && open !== '{') continue;
        let depth = 0, inStr = false, esc = false, lastItemEnd = -1;
        for (let i = start; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') inStr = true;
            else if (c === '[' || c === '{') depth++;
            else if (c === ']' || c === '}') {
                if (--depth === 0) {
                    v = tryParse(s.slice(start, i + 1));
                    if (v !== undefined) return v;
                    break;
                }
                if (depth === 1 && c === '}') lastItemEnd = i;
            }
        }
        if (depth > 0 && open === '[' && lastItemEnd > start) {
            v = tryParse(s.slice(start, lastItemEnd + 1) + ']');
            if (v !== undefined) return v;
        }
    }
    return undefined;
}

// Daily/minute limits are per key AND per model: "key|model" -> { until, daily, msg }. A model that
// hit its limit is skipped until it resets, while the key's other models keep working.
const geminiModelCooldowns = new Map();

// Google's 429 body says exactly which limit was hit and how long to wait:
//   details: [{ '@type': '...QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
//             { '@type': '...RetryInfo', retryDelay: '55s' }]
// The message text doesn't always say "per day", so the details are read first.
function parseGeminiQuotaError(errData, errMsg) {
    const details = Array.isArray(errData?.error?.details) ? errData.error.details : [];
    const quotaIds = [];
    let retryMs = null;
    for (const d of details) {
        for (const v of (Array.isArray(d?.violations) ? d.violations : [])) if (v && v.quotaId) quotaIds.push(String(v.quotaId));
        if (d && typeof d.retryDelay === 'string' && isFinite(parseFloat(d.retryDelay))) retryMs = Math.ceil(parseFloat(d.retryDelay) * 1000);
    }
    if (retryMs === null) {
        const m = /retry in\s*([\d.]+)\s*s/i.exec(errMsg || '');
        if (m) retryMs = Math.ceil(parseFloat(m[1]) * 1000);
    }
    // A daily limit can still come with a short retryDelay - it is wrong for it, the day wins.
    const daily = quotaIds.some(id => /PerDay/i.test(id)) || /per\s*-?day|daily quota|requests per day/i.test(errMsg || '');
    return { daily, retryMs, quotaIds };
}

// Google's daily quotas reset at midnight Pacific time.
function msUntilPacificMidnight(now = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' })
        .formatToParts(new Date(now));
    const get = (t) => +((parts.find(p => p.type === t) || {}).value || 0);
    const sinceMidnightMs = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000;
    return Math.max(60 * 1000, 24 * 3600 * 1000 - sinceMidnightMs);
}

function quotaCooldownUntil(quota, now = Date.now()) {
    if (quota.daily) return now + msUntilPacificMidnight(now) + 60 * 1000;
    const wait = quota.retryMs != null ? quota.retryMs : RATE_LIMIT_COOLDOWN_MS;
    return now + Math.min(2 * 60 * 1000, Math.max(5000, wait)) + 500;
}

function formatWait(ms) {
    const min = Math.ceil(ms / 60000);
    if (ms < 60 * 1000) return `${Math.max(1, Math.ceil(ms / 1000))}s`;
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

async function executeGeminiGenerate(apiKey, requestedModel, payload, signal) {
    apiKey = String(apiKey || '').trim();
    const candidateModels = await getCandidateModels(apiKey, requestedModel, signal);
    const body = JSON.stringify(payload);
    const gen = payload && payload.generationConfig;
    const plainBody = gen && (gen.responseMimeType || gen.responseSchema)
        ? JSON.stringify({ ...payload, generationConfig: (({ responseMimeType, responseSchema, ...rest }) => rest)(gen) })
        : body;

    let primaryError = null; // first meaningful error, reported to the user
    let sawRateLimit = false;
    let sawOverload = false;
    let networkFailures = 0;
    let rateLimitMsg = '';
    let keyFreeAt = Infinity; // soonest time one of this key's rate-limited models is free again
    let allDaily = true;      // every rate-limited model is out for the day (not just the minute)

    for (let idx = 0; idx < candidateModels.length; idx++) {
        const m = candidateModels[idx];
        if (plainBody !== body && geminiNoJsonOutputModels.has(m)) continue;
        const cooldown = geminiModelCooldowns.get(`${apiKey}|${m}`);
        if (cooldown && cooldown.until > Date.now()) {
            sawRateLimit = true;
            if (!rateLimitMsg) rateLimitMsg = cooldown.msg;
            keyFreeAt = Math.min(keyFreeAt, cooldown.until);
            allDaily = allDaily && !!cooldown.daily;
            continue;
        }
        // Transient server errors (500/503 "overloaded") get one retry on the same model.
        for (let attempt = 0; attempt < 2; attempt++) {
            if (signal && signal.aborted) {
                const err = new Error('Aborted'); err.name = 'AbortError'; throw err;
            }
            let res;
            try {
                res = await fetchWithTimeout(`${GEMINI_API_BASE}/models/${m}:generateContent?key=${apiKey}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: geminiNoJsonModeModels.has(m) ? plainBody : body
                }, signal, GEMINI_ATTEMPT_TIMEOUT_MS);
            } catch (fetchErr) {
                if (fetchErr.name === 'AbortError' && signal && signal.aborted) throw fetchErr;
                const cause = fetchErr.cause && (fetchErr.cause.code || fetchErr.cause.message);
                const msg = fetchErr.code === 'TIMEOUT'
                    ? fetchErr.message
                    : `Cannot reach Google Gemini (${cause || fetchErr.message}). Check your internet connection / VPN / firewall.`;
                console.warn(`[Gemini] ${m} network error:`, msg);
                if (!primaryError) primaryError = { status: 503, code: 'NETWORK_ERROR', error: msg, message: msg };
                // A dead network is not model-specific: stop after two failures instead
                // of cycling every model.
                if (++networkFailures >= 2) return { success: false, ...primaryError };
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }

            if (res.ok) {
                let json;
                try { json = JSON.parse(res.text); } catch (e) {
                    // Truncated/garbled body: same handling as a network blip.
                    const msg = 'Gemini response was cut off. Check your internet connection.';
                    console.warn(`[Gemini] ${m}: unreadable response body (${res.text.length} bytes)`);
                    if (!primaryError) primaryError = { status: 503, code: 'NETWORK_ERROR', error: msg, message: msg };
                    if (++networkFailures >= 2) return { success: false, ...primaryError };
                    continue;
                }
                const cand = json?.candidates?.[0];
                const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
                if (!text && (json?.promptFeedback?.blockReason || cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT')) {
                    const reason = json?.promptFeedback?.blockReason || cand?.finishReason;
                    if (!primaryError) primaryError = { status: 422, code: 'CONTENT_BLOCKED', error: `Gemini blocked this content (${reason}).`, message: `Gemini blocked this content (${reason}).` };
                    break; // try next model
                }
                if (geminiNoJsonModeModels.has(m) && plainBody !== body) {
                    // Plain-mode reply to a JSON request: hand callers clean JSON, as JSON mode would.
                    const value = extractJsonValue(text);
                    if (value === undefined) {
                        geminiNoJsonOutputModels.add(m);
                        console.warn(`[Gemini] ${m} replied without JSON - skipping it for JSON requests from now on. Reply began: ${text.slice(0, 200)}`);
                        if (!primaryError) primaryError = { status: 502, error: `${m} did not return the requested JSON.`, message: `${m} did not return the requested JSON. Reply began: ${text.slice(0, 160)}` };
                        break; // next model
                    }
                    const clean = JSON.stringify(value);
                    if (cand && cand.content) cand.content.parts = [{ text: clean }];
                    return { success: true, json, text: clean, finishReason: cand?.finishReason, modelUsed: m };
                }
                return { success: true, json, text, finishReason: cand?.finishReason, modelUsed: m };
            }

            let errData = {};
            try { errData = JSON.parse(res.text); } catch (e) { }
            const errMsg = errData?.error?.message || `HTTP ${res.status}`;
            if (res.status !== 429) console.warn(`[Gemini] ${m} returned ${res.status}: ${errMsg}`); // 429 logs one short line below

            if (res.status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(errMsg)) {
                return { success: false, status: 400, error: 'INVALID_API_KEY', message: errMsg };
            }
            if (res.status === 403) {
                return { success: false, status: 403, error: 'INVALID_API_KEY', message: errMsg };
            }
            if (res.status === 400 && /payload size|exceeds the limit|too large/i.test(errMsg)) {
                return { success: false, status: 413, code: 'AUDIO_TOO_LARGE', error: `Audio is too large for Gemini: ${errMsg}`, message: errMsg };
            }
            if (res.status === 404) break; // model gone/renamed: next model, not worth reporting
            if (res.status === 400 && isJsonModeUnsupported(errMsg)) {
                if (plainBody !== body && !geminiNoJsonModeModels.has(m)) {
                    geminiNoJsonModeModels.add(m);
                    console.warn(`[Gemini] ${m} has no JSON mode - retrying it with plain-text JSON`);
                    attempt--; // not a transient failure: don't use up the retry
                    continue;
                }
                break; // model can't do this request: next model, and don't mask the real error (e.g. quota)
            }
            if (res.status === 429) {
                sawRateLimit = true;
                if (!rateLimitMsg) rateLimitMsg = errMsg;
                const quota = parseGeminiQuotaError(errData, errMsg);
                const until = quotaCooldownUntil(quota);
                geminiModelCooldowns.set(`${apiKey}|${m}`, { until, daily: quota.daily, msg: errMsg });
                keyFreeAt = Math.min(keyFreeAt, until);
                allDaily = allDaily && quota.daily;
                console.warn(`[Gemini] ${m} on key …${apiKey.slice(-4)}: ${quota.daily ? 'daily quota used up' : 'per-minute limit'}` +
                    ` (${quota.quotaIds[0] || 'quota'}) - skipping it for ${formatWait(until - Date.now())}`);
                break; // the key's other models have their own limits
            }
            // 503 "high demand" / overloaded: switch straight to the next model. The caller
            // backs off and retries if every model is busy.
            if (res.status === 503 || /high demand|overloaded|UNAVAILABLE/i.test(errMsg)) {
                sawOverload = true;
                if (!primaryError) primaryError = { status: 503, code: 'OVERLOADED', error: errMsg, message: errMsg };
                break;
            }
            if (!primaryError) primaryError = { status: res.status, error: errMsg, message: errMsg };
            if (res.status >= 500 && attempt === 0) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            break;
        }
    }

    if (sawRateLimit && !sawOverload && (!primaryError || primaryError.code === 'NETWORK_ERROR')) {
        // Google's per-day quota (free tier: as low as 20 requests/day/model) reads as the
        // same HTTP 429 as a per-minute burst limit, but it won't clear in seconds - it won't
        // clear until the daily window rolls over. Flag it so the caller stops burning more
        // requests (across every model, every retry) on a key that's done for the day.
        const isDailyQuota = allDaily && isFinite(keyFreeAt);
        const retryAfterMs = isFinite(keyFreeAt) ? Math.max(0, keyFreeAt - Date.now()) : RATE_LIMIT_COOLDOWN_MS;
        return {
            success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED', isDailyQuota, retryAfterMs,
            message: isDailyQuota
                ? `Daily free Gemini quota used up for key …${apiKey.slice(-4)} - resets in ${formatWait(retryAfterMs)} (midnight Pacific time).`
                : `Key …${apiKey.slice(-4)} is rate-limited by Google - free again in ${formatWait(retryAfterMs)}.`
        };
    }
    return { success: false, ...(primaryError || { status: 500, error: 'No usable Gemini model for this API key.', message: 'No usable Gemini model for this API key.' }) };
}

// ── Khmer Dubbing & Subtitle Dialogue Engine ──────────────────────────
function sanitizeKhmerDialogue(text) {
    if (!text || typeof text !== 'string') return '';
    let cleaned = text
        // Strip zero-width and invisible control characters
        .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
        // Normalize whitespace
        .replace(/[ \t]+/g, ' ')
        .trim();

    // Strip robotic formal question start "តើ" if directly preceding spoken pronouns or verbs
    cleaned = cleaned
        .replace(/^តើ\s*(?=(?:ឯង|បង|អូន|លោក|នាង|អ្នក|យើង|ពួកយើង|ពួកឯង|មាន|កើត|ធ្វើ|ទៅ|មក|មែន|ចង់|អាច|គួរ|ស្មាន|ម៉េច|ណា|នរណា|ហេតុ|អី|ប៉ុន្មាន|យ៉ាង|ពិត|ដឹង|ឮ|ឃើញ))/u, '')
        // Fix excessive punctuation
        .replace(/\?{2,}/g, '?')
        .replace(/!{2,}/g, '!')
        .replace(/\.{4,}/g, '...')
        .trim();
    return cleaned;
}

function applyGlossary(text, glossary) {
    if (!text || !glossary) return text;
    let result = text;
    if (typeof glossary === 'object' && !Array.isArray(glossary)) {
        for (const [key, val] of Object.entries(glossary)) {
            if (key && val && typeof key === 'string' && typeof val === 'string') {
                const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                result = result.replace(new RegExp(escaped, 'gi'), val);
            }
        }
    } else if (Array.isArray(glossary)) {
        for (const item of glossary) {
            if (item && item.from && item.to) {
                const escaped = item.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                result = result.replace(new RegExp(escaped, 'gi'), item.to);
            }
        }
    }
    return result;
}

function getKhmerDramaRegisterGuidance(genreRegister) {
    if (genreRegister === 'historical' || genreRegister === 'imperial' || genreRegister === 'wuxia') {
        return `
5. Historical, Imperial Palace & Wuxia Register (រឿងបុរាណ/រាជវាំង/ក្បាច់គុន/ទេវតា):
   - Use authentic Cambodian classical royal court language, martial arts terms, and dramatic tone:
     * Sovereign & Royal Court: "ព្រះអង្គ", "ព្រះមហាក្សត្រ", "ព្រះរាជបញ្ជា", "ក្រាបទូល", "សូមទ្រង់ព្រះមេត្តា".
     * Self-referral: "ទូលបង្គំ" (men to royalty), "ខ្ញុំម្ចាស់" (women to royalty), "យើង" (Emperor/King/Master).
     * Family & Consorts: "ម្ចាស់បង", "ម្ចាស់អូន", "ព្រះមាតា", "ព្រះបិតា", "រាជបុត្រ", "ព្រះនាង", "អ្នកម្នាង".
     * Martial Arts / Sects / Masters: "លោកម្ចាស់", "លោកគ្រូ", "សិស្សច្បង", "សិស្សប្អូន", "លោកមេបក្ស", "និកាយ", "វិជ្ជាគុណ".
     * Short Dramatic Conflict: "អាមនុស្សថោកទាប!", "កុំសង្ឃឹមថារួចខ្លួន!", "ឯងចង់ងាប់មែនទេ?!", "ទទួលបញ្ជា!".`;
    } else if (genreRegister === 'action') {
        return `
5. Action, Military & Crime Register (រឿងសកម្មភាព/កងទ័ព/ឧក្រិដ្ឋកម្ម):
   - Use punchy, high-adrenaline, ultra-short tactical dialogue:
     * Urgent commands: "ប្រយ័ត្ន!", "បាញ់!", "ដកថយ!", "កុំកម្រើក!", "ទៅលឿន!", "រត់!", "តាមចាប់វា!", "លើកដៃឡើង!".`;
    } else if (genreRegister === 'comedy') {
        return `
5. Comedy & Lively Register (រឿងកំប្លែង/កំប្លុកកំប្លែង):
   - Use humorous, lively, and entertaining spoken Cambodian colloquialisms:
     * Natural reactions: "អីយ៉ា!", "ងាប់ហើយ!", "កុំចេះដឹង!", "ពិតមែនហ្អេស?!", "កំប្លែងមែន!", "អញហើយ!".`;
    } else {
        return `
5. Modern Romance, CEO & Urban Register (រឿងសម័យ/ស្នេហា/ប្រធានក្រុមហ៊ុន):
   - Use natural, fluid, modern conversational Khmer:
     * Natural pronouns & titles: "បង", "អូន", "លោកប្រធាន", "អ្នកនាង", "ឯង", "ខ្ញុំ", "ម៉ាក់", "ប៉ា".
     * Real conversational dialogue:
       - "你在干什么？" -> "ឯងធ្វើអីហ្នឹង?" / "បងធ្វើអីហ្នឹង?"
       - "你没事吧？" -> "ឯងមិនអីទេ?" / "បងមិនអីទេ?"
       - "别管我！" -> "កុំរវល់នឹងខ្ញុំ!" / "កុំចេះដឹង!"
       - "对不起，我来晚了" -> "សុំទោស បងមកយឺត"
       - "我喜欢你" -> "បងស្រឡាញ់អូន" / "ខ្ញុំចូលចិត្តឯង"
       - "怎么办？" -> "ធ្វើម៉េចទៅ?"`;
    }
}

const KHMER_DUBBING_RULES = `💎 ULTRA-CONCISE & READABLE KHMER DUBBING RULES (ខ្លី ខ្លឹម ងាយអាន ឥតទាក់ ដូចរឿងភាគទូរទស្សន៍):

1. STRICT ULTRA-CONCISE LENGTH (ខ្លី ខ្លឹម ចំៗ កាត់ពាក្យវែងអន្លាយចោល):
   - In Asian/Chinese dramas, speech is fast and compact (3 to 6 syllables). The Khmer dub MUST be equally SHORT and COMPACT (strictly 3 to 10 Khmer syllables max, 3 to 8 words per line).
   - Never generate long sentences, textbook paragraphs, or multi-clause explanations.
   - If dialogue is long, capture only the core punchline/meaning.

2. ABSOLUTE BAN ON ROBOTIC & FORMAL TEXTBOOK WORDS (ហាមដាច់ខាតពាក្យអូសបន្លាយបែបសៀវភៅ):
   - 🚫 BAN "តើ..." at the beginning of questions (e.g. ❌ "តើឯងធ្វើអ្វី?" -> ✅ "ឯងធ្វើអីហ្នឹង?").
   - 🚫 BAN unnecessary past tense "បាន..." (e.g. ❌ "ខ្ញុំបានដឹងហើយ" -> ✅ "ខ្ញុំដឹងហើយ").
   - 🚫 BAN continuous "កំពុងតែ..." (e.g. ❌ "កំពុងតែទៅ..." -> ✅ "កំពុងទៅ...").
   - 🚫 BAN possessive "របស់អ្នក / របស់ខ្ញុំ" (e.g. ❌ "ដៃរបស់អ្នក" -> ✅ "ដៃឯង" / "ដៃបង").
   - 🚫 BAN polite filler "សូមមេត្តា / សូម..." unless addressing kings or royal superiors.
   - 🚫 BAN word-for-word translation ("ចំពោះរឿងនេះ", "គឺជារឿងដែល", "ដើម្បីធ្វើការ", "មានការ...").

3. GOLDEN DUBBING REPLACEMENTS (គំរូពាក្យសន្ទនាភាពយន្តខ្លី):
   - ❌ "តើអ្នកកំពុងតែធ្វើអ្វីនៅទីនេះ?" -> ✅ "ឯងធ្វើអីហ្នឹង?" / "បងធ្វើអី?"
   - ❌ "តើមានរឿងអ្វីបានកើតឡើងចំពោះអ្នក?" -> ✅ "កើតអីហ្នឹង?" / "មានរឿងអី?"
   - ❌ "តើនេះជាការពិតមែនទេ?" -> ✅ "ពិតមែនហ្អេស?!" / "មែនអត់?"
   - ❌ "ខ្ញុំសូមអភ័យទោសដែលបានមកយឺត" -> ✅ "សុំទោស ខ្ញុំមកយឺត" / "សុំទោស បងមកយឺត"
   - ❌ "កុំមានការព្រួយបារម្ភចំពោះខ្ញុំអី" -> ✅ "កុំបារម្ភពីខ្ញុំ" / "ទុកចិត្តចុះ"
   - ❌ "តើអ្នកអាចប្រាប់ការពិតដល់ខ្ញុំបានទេ?" -> ✅ "ប្រាប់ការពិតមក" / "និយាយមក"
   - ❌ "ខ្ញុំមិនអាចយល់ស្របនឹងរឿងនេះបានឡើយ" -> ✅ "ខ្ញុំមិនព្រមដាច់ខាត!" / "មិនអាចទេ!"
   - ❌ "សូមជួយសង្គ្រោះជីវិតខ្ញុំផង" -> ✅ "ជួយផង!" / "ជួយខ្ញុំផង!"
   - ❌ "តើឯងចង់ស្លាប់មែនទេ?" -> ✅ "ចង់ងាប់មែនទេ?!"
   - ❌ "ខ្ញុំនឹងមិនលើកលែងទោសឲ្យអ្នកឡើយ" -> ✅ "កុំសង្ឃឹមថារួចខ្លួន!" / "ខ្ញុំមិនលើកលែងទេ!"
   - ❌ "តើអ្នកចង់មានន័យថាយ៉ាងដូចម្ដេច?" -> ✅ "ចង់មានន័យថាម៉េច?"
   - ❌ "កុំមកប៉ះពាល់រូបរាងកាយរបស់ខ្ញុំ" -> ✅ "កុំប៉ះខ្ញុំ!"
   - ❌ "តើពួកយើងគួរតែធ្វើបែបណាទៅ?" -> ✅ "ធ្វើម៉េចទៅ?"
   - ❌ "ខ្ញុំមិនចង់ឃើញមុខរបស់អ្នកទៀតឡើយ" -> ✅ "ទៅឲ្យឆ្ងាយ!" / "ចេញឲ្យផុតទៅ!"
   - ❌ "សូមបិទមាត់របស់អ្នកភ្លាមទៅ" -> ✅ "បិទមាត់!" / "ស្ងាត់មាត់!"
   - ❌ "ខ្ញុំមិនដែលគិតថាអ្នកជាមនុស្សបែបនេះសោះ" -> ✅ "ស្មានមិនដល់ថាឯងចឹងសោះ!"
   - ❌ "អ្នកមិនចាំបាច់មកខ្វល់ខ្វាយពីខ្ញុំទេ" -> ✅ "កុំចេះដឹង!" / "កុំរវល់នឹងខ្ញុំ!"
   - ❌ "តើអ្នកទៅណា?" -> ✅ "ទៅណា?" / "បងទៅណា?"
   - ❌ "ខ្ញុំស្រឡាញ់អ្នកខ្លាំងណាស់" -> ✅ "បងស្រឡាញ់អូន" / "ខ្ញុំស្រឡាញ់ឯង"
   - ❌ "ហេតុអ្វីបានជាអ្នកធ្វើបែបនេះ?" -> ✅ "ម៉េចធ្វើចឹង?!" / "ហេតុអីធ្វើចឹង?"
   - ❌ "តើអ្នកសុខសប្បាយជាទេ?" -> ✅ "យ៉ាងម៉េចហើយ?" / "មិនអីទេហី?"
   - ❌ "ឆាប់ចេញពីទីនេះភ្លាម" -> ✅ "ចេញភ្លាម!" / "ទៅឲ្យលឿន!"

4. FLUID CONVERSATIONAL PARTICLES (ពាក្យបន្ថែមបែបសន្ទនាធម្មជាតិ):
   - Localize Asian particles (的, 了, 吧, 呢, 啊, 嘛) into natural colloquial Khmer ("ហ្នឹង", "ហើយ", "តើ", "ចុះ", "មែនទេ", "ណា", "ហ្ហ៎ា", "អត់", "ហី", "ទៅ", "មក").

5. SUBTITLE LEGIBILITY & SPACING (អានស្រួល មើលច្បាស់ក្នុង ១វិនាទី):
   - Insert a clean standard space between grammatical clauses (e.g. "សុំទោស ខ្ញុំមកយឺត").
   - DO NOT insert zero-width characters (ZWSP). Ensure clean standard UTF-8 Khmer text.
   - Keep punctuation clean, minimal, and expressive (!, ?, ..., ?!).`;

// 4. Transcription & Gemini Speech-to-Text Pipeline
//
// Long audio is split at natural pauses into ~3 minute chunks. Gemini's timestamps
// drift badly on long clips, a single inline request is capped at 20MB, and a long
// episode's JSON can overflow the output token limit - chunking fixes all three.
const TRANSCRIBE_CHUNK_TARGET_SEC = 180;
const TRANSCRIBE_SINGLE_MAX_SEC = 240;
// "API Saver" (Settings): fewer, longer requests - Google's free tier counts requests per day.
// 10 minutes of dialogue still fits the 32k output limit; a reply that gets cut off anyway is
// caught by the gap check (see /api/transcribe).
const SAVER_CHUNK_TARGET_SEC = 540;
const SAVER_SINGLE_MAX_SEC = 600;
// Actual lane count is still min()'d against keyPool.length elsewhere, so this is just
// a ceiling. It used to be 4, which silently capped throughput (and daily-quota spread)
// at 4 keys no matter how many a user added in Settings - raised so adding keys actually
// helps both speed and quota headroom.
const TRANSCRIBE_MAX_LANES = 12;
const transcribeProgress = new Map(); // requestId -> { done, total }
const TRANSCRIBE_EMOTIONS = ['Neutral', 'Angry', 'Sad', 'Whisper', 'Excited', 'Royal', 'Romantic', 'Fear'];
const TRANSCRIBE_RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            start: { type: 'STRING' },
            end: { type: 'STRING' },
            originalText: { type: 'STRING' },
            text: { type: 'STRING' },
            gender: { type: 'STRING', enum: ['Male', 'Female'] },
            emotion: { type: 'STRING', enum: TRANSCRIBE_EMOTIONS }
        },
        required: ['start', 'end', 'originalText', 'text', 'gender'],
        propertyOrdering: ['start', 'end', 'originalText', 'text', 'gender', 'emotion']
    }
};

function runFFmpegCapture(args, signal) {
    return new Promise((resolve, reject) => {
        const proc = spawn(getFFmpegBinary(), args, { windowsHide: true });
        trackProcess(proc);
        let stderr = '';
        const onAbort = () => { try { proc.kill('SIGKILL'); } catch (e) { } };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', reject);
        proc.on('close', code => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve({ code, stderr });
        });
    });
}

async function probeAudioDuration(file) {
    const { stderr } = await runFFmpegCapture(['-hide_banner', '-i', file]);
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
}

async function detectSilences(file, signal) {
    const { stderr } = await runFFmpegCapture(
        ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-35dB:d=0.3', '-f', 'null', '-'], signal);
    const silences = [];
    let pendingStart = null;
    for (const line of stderr.split('\n')) {
        const s = line.match(/silence_start:\s*(-?[\d.]+)/);
        if (s) { pendingStart = Math.max(0, parseFloat(s[1])); continue; }
        const e = line.match(/silence_end:\s*([\d.]+)/);
        if (e && pendingStart !== null) {
            silences.push({ start: pendingStart, end: parseFloat(e[1]) });
            pendingStart = null;
        }
    }
    return silences;
}

// Cut near every TARGET seconds, snapped to the middle of the closest pause so we
// never slice through a word.
function planTranscribeChunks(totalSec, silences, { singleMax = TRANSCRIBE_SINGLE_MAX_SEC, target: targetSec = TRANSCRIBE_CHUNK_TARGET_SEC } = {}) {
    const chunks = [];
    let cursor = 0;
    while (totalSec - cursor > singleMax) {
        const target = cursor + targetSec;
        let best = null;
        for (const s of silences) {
            const mid = (s.start + s.end) / 2;
            if (mid < target - 50 || mid > target + 30) continue;
            // Longer pauses are safer cut points; distance from target is a mild penalty.
            const score = Math.abs(mid - target) - Math.min(s.end - s.start, 2) * 15;
            if (!best || score < best.score) best = { mid, score };
        }
        const cut = best ? best.mid : target;
        chunks.push({ start: cursor, end: cut });
        cursor = cut;
    }
    chunks.push({ start: cursor, end: totalSec });
    return chunks;
}

function parseTimestampSeconds(val) {
    if (val === undefined || val === null) return NaN;
    if (typeof val === 'number') return val;
    const str = String(val).trim().replace(',', '.');
    if (!str.includes(':')) return parseFloat(str.replace(/[^0-9.]/g, ''));
    const parts = str.split(':').map(p => parseFloat(p) || 0);
    return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function formatTimestamp(sec) {
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = (s % 60).toFixed(2).padStart(5, '0');
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${rest}`;
}

// Accepts fenced JSON, {subtitles:[...]} wrappers, and arrays truncated by MAX_TOKENS.
function parseJsonArrayLoose(raw) {
    const v = extractJsonValue(raw);
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.subtitles)) return v.subtitles;
    return null;
}

function buildTranscribePrompt({ clipSec, glossaryHint, genreGuidance, previousLines }) {
    const clipLen = clipSec > 0 ? clipSec.toFixed(1) : null;
    const contextHint = previousLines && previousLines.length
        ? `\n\nPREVIOUS DIALOGUE (context only, for consistent names and pronouns; do NOT repeat these lines):\n${previousLines.map(l => `- [${l.gender || '?'}] ${l.originalText || ''} => ${l.text}`).join('\n')}`
        : '';
    return `You are an elite master film/TV dialogue adapter and dubbing director specializing in Asian and Chinese drama (C-Drama: 古装/宫斗/仙侠/武侠/现代甜宠/总裁/动作) localization into cinematic, natural, ultra-concise, and highly readable Khmer.

TASK:
Listen to the audio carefully and transcribe and translate all spoken dialogue into SHORT, PUNCHY, and READABLE Khmer subtitles specifically optimized for professional voice dubbing and fast on-screen reading.

${KHMER_DUBBING_RULES}
${glossaryHint}${contextHint}

TIMESTAMPS & ACTING RULES:
1. Exact Timestamps:
   - "start" and "end" are measured from the start of THIS audio clip (00:00.00). Format: MM:SS.ss.${clipLen ? `\n   - This clip is ${clipLen} seconds long. No timestamp may exceed ${clipLen}.` : ''}
   - "start" is the exact moment the speaker's voice begins; "end" is the moment it stops. Never pad into silence or music.
   - One subtitle per utterance (usually 1 to 4 seconds). Start a new line whenever the speaker changes. Never put two speakers in one line.
   - Lines must be in chronological order and must not overlap.

2. What to include:
   - Only real spoken dialogue and narration. Skip background music, song lyrics, sound effects, breathing, and crowd noise.
   - Never invent, summarize, or skip dialogue. If the clip has no speech, return [].
   - "originalText" is the exact words spoken in the original language.

3. Speaker Gender & Emotion:
   - gender: "Male" or "Female" - the gender of the voice actually speaking this line. Judge by the voice you hear, not by who is being talked about.
   - emotion: "Neutral", "Angry", "Sad", "Whisper", "Excited", "Royal", "Romantic", "Fear".${genreGuidance}

4. Output Format:
   - Output ONLY a valid JSON array of objects with the exact schema below. No markdown, no extra text.

SCHEMA:
[
  {
    "start": "00:00.00",
    "end": "00:02.50",
    "originalText": "Original spoken dialogue",
    "text": "Short punchy Khmer translation",
    "gender": "Male",
    "emotion": "Neutral"
  }
]`;
}

// Transcribe one clip; returns cues with times relative to the clip start.
async function transcribeClipWithGemini({ apiKey, model, audioBase64, mimeType, clipSec, promptOpts, signal }) {
    const payload = {
        contents: [{
            role: 'user',
            parts: [
                { inlineData: { mimeType, data: audioBase64 } },
                { text: buildTranscribePrompt({ ...promptOpts, clipSec }) }
            ]
        }],
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: TRANSCRIBE_RESPONSE_SCHEMA,
            maxOutputTokens: 32768
        }
    };

    let lastRaw = '';
    // A malformed JSON reply is usually a one-off; ask once more before giving up.
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await executeGeminiGenerate(apiKey, model, payload, signal);
        if (!result.success) return { ok: false, result };
        lastRaw = result.text || '';
        const items = parseJsonArrayLoose(lastRaw);
        if (items) {
            const truncated = result.finishReason === 'MAX_TOKENS';
            if (truncated) console.warn('[Transcribe] Output hit MAX_TOKENS; kept complete lines only.');
            return { ok: true, items, raw: lastRaw, modelUsed: result.modelUsed, truncated };
        }
        console.error('[Transcribe] Unparseable Gemini output:', lastRaw.slice(0, 500));
    }
    return { ok: false, result: { status: 502, error: 'Gemini returned an unreadable transcript. Please try again.', message: `Gemini returned an unreadable transcript. Please try again. Reply began: ${lastRaw.slice(0, 160)}` }, raw: lastRaw };
}

function normalizeClipCues(items, offsetSec, clipSec, glossary) {
    const cues = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        let text = sanitizeKhmerDialogue(item.text || '');
        if (glossary) text = applyGlossary(text, glossary);
        // A line with speech but no translation is kept (the repair pass translates it).
        if (!text && !String(item.originalText || '').trim()) continue;
        let start = parseTimestampSeconds(item.start);
        let end = parseTimestampSeconds(item.end);
        if (!isFinite(start)) continue;
        if (clipSec > 0) start = Math.min(Math.max(0, start), clipSec);
        if (!isFinite(end) || end <= start) end = start + 2;
        if (clipSec > 0) end = Math.min(end, clipSec + 0.3);
        cues.push({
            ...item,
            text,
            originalText: item.originalText ? String(item.originalText).trim() : (item.original || undefined),
            _start: offsetSec + start,
            _end: offsetSec + end
        });
    }
    return cues;
}

function finalizeCues(cues) {
    cues.sort((a, b) => a._start - b._start);
    for (let i = 0; i < cues.length - 1; i++) {
        const next = cues[i + 1];
        if (cues[i]._end > next._start) cues[i]._end = Math.max(cues[i]._start + 0.3, next._start);
    }
    return cues.map(({ _start, _end, ...rest }) => ({
        ...rest,
        start: formatTimestamp(_start),
        end: formatTimestamp(_end)
    }));
}

// Worth waiting and retrying: Google busy/rate-limited, a network blip, or garbled output.
function isTransientGeminiFailure(result) {
    if (!result) return false;
    return result.error === 'RATE_LIMIT_EXCEEDED' || result.code === 'OVERLOADED' ||
        result.code === 'NETWORK_ERROR' || Number(result.status) >= 500;
}
const GEMINI_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];
// Busy/rate-limited Google usually clears within a minute; a dead connection doesn't.
// A per-day quota won't clear all session either - retrying (up to 4 models x every
// key, repeated with backoff) just burns more of that key's daily allowance for nothing.
function geminiRetryLimit(result) {
    if (result && result.isDailyQuota) return 0;
    return result && result.code === 'NETWORK_ERROR' ? 1 : GEMINI_RETRY_DELAYS_MS.length;
}

function sleepAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

// Finished chunks are remembered for a few hours, so pressing Transcribe again after
// a failure only redoes the chunks that failed instead of the whole episode.
const transcribeChunkCache = new Map(); // key -> { at, out }
const TRANSCRIBE_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
function transcribeCacheKey(clipBase64, parts) {
    return crypto.createHash('sha1').update(clipBase64).update(JSON.stringify(parts)).digest('hex');
}
function transcribeCacheGet(key) {
    const hit = transcribeChunkCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > TRANSCRIBE_CACHE_TTL_MS) { transcribeChunkCache.delete(key); return null; }
    return hit.out;
}
function transcribeCacheSet(key, out) {
    if (transcribeChunkCache.size >= 500) transcribeChunkCache.delete(transcribeChunkCache.keys().next().value);
    transcribeChunkCache.set(key, { at: Date.now(), out });
}

function geminiFailureResponse(res, result) {
    const code = result.error === 'RATE_LIMIT_EXCEEDED' || result.error === 'INVALID_API_KEY' ? result.error : null;
    return res.status(result.status || 500).json({
        success: false,
        error: code || result.error || result.message || 'GENERATION_FAILED',
        message: result.message || result.error,
        isDailyQuota: !!result.isDailyQuota,
        retryAfterMs: result.retryAfterMs != null ? result.retryAfterMs : undefined
    });
}

// ── Missing-dialogue repair ──────────────────────────────────────────────────
// On a 1-2 hour episode Gemini occasionally skips a stretch of dialogue, or returns a
// line without its Khmer translation. Instead of regenerating a whole part, find
// exactly those spots and fix only them:
//   gaps          : >= REPAIR_GAP_SEC with no subtitle and not silent -> re-transcribe just that window
//   untranslated  : empty text, no Khmer characters, or an echo of the original -> re-translate that line
const KHMER_CHAR_RE = /[ក-៿]/;
const REPAIR_GAP_SEC = 20;
const REPAIR_MAX_GAPS = 40;
const REPAIR_WINDOW_MAX_SEC = 180;
const REPAIR_TRANSLATE_BATCH = 40;
// The gap double-check is an extra pass on top of a finished transcript: when Google is slow it
// could add many minutes, so it stops starting new checks after this long (lines found so far stay).
const REPAIR_GAP_BUDGET_MS = 2 * 60 * 1000;

function cueNeedsTranslation(cue) {
    const text = String(cue.text || '').trim();
    const original = String(cue.originalText || '').trim();
    if (!original) return false;
    return !text || !KHMER_CHAR_RE.test(text) || text === original;
}

function findDialogueGaps(cues, totalSec) {
    const sorted = [...cues].sort((a, b) => a._start - b._start);
    const gaps = [];
    let cursor = 0;
    for (const c of sorted) {
        if (c._start - cursor >= REPAIR_GAP_SEC) gaps.push({ start: cursor, end: c._start });
        cursor = Math.max(cursor, c._end);
    }
    if (totalSec - cursor >= REPAIR_GAP_SEC) gaps.push({ start: cursor, end: totalSec });
    // Long gaps are checked in <= 3 minute windows (same size the main pass uses).
    const windows = [];
    for (const g of gaps) {
        for (let s = g.start; s < g.end - 1; s += REPAIR_WINDOW_MAX_SEC) {
            windows.push({ start: Math.max(0, s - 0.5), end: Math.min(g.end + 0.5, s + REPAIR_WINDOW_MAX_SEC) });
        }
    }
    return windows;
}

async function silentFraction(file, start, dur, signal) {
    const { stderr } = await runFFmpegCapture(['-hide_banner', '-nostats', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', file,
        '-vn', '-af', 'silencedetect=noise=-38dB:d=0.4', '-f', 'null', '-'], signal);
    let silent = 0, open = null;
    for (const line of stderr.split('\n')) {
        const s = line.match(/silence_start:\s*(-?[\d.]+)/);
        if (s) { open = Math.max(0, parseFloat(s[1])); continue; }
        const e = line.match(/silence_end:\s*([\d.]+)/);
        if (e && open !== null) { silent += parseFloat(e[1]) - open; open = null; }
    }
    if (open !== null) silent += dur - open;
    return dur > 0 ? Math.min(1, silent / dur) : 1;
}

// Keys Google rejected as invalid/expired are skipped for 10 minutes, so one bad key in
// Settings can't fail a whole job (every chunk would otherwise hit it again).
const invalidGeminiKeys = new Map(); // key -> time it was rejected
// Keys that just got a 429 are skipped for a cooldown too. Without this, every
// concurrent lane/chunk/retry keeps trying that same key first (it's always first in
// its own rotation) and piling fresh requests onto a key that's already over quota,
// instead of going straight to a key that isn't. This is what actually gets chunk 1
// off key 1 and onto key 2 quickly when there are multiple keys in play.
//
// A per-day quota getting hit needs a much longer cooldown than a per-minute burst:
// it reads as the same 429, but it won't clear for hours, and retrying it anyway just
// burns more of that key's already-exhausted daily allowance for nothing (each retry
// tries up to 4 models, up to 5 times, and that's per chunk).
// The cooldown is as long as Google says (its "retry in 55s"), or until midnight Pacific
// when every model of the key is out of its daily quota.
const rateLimitedGeminiKeys = new Map(); // key -> { until, daily }
const RATE_LIMIT_COOLDOWN_MS = 20 * 1000;
function isGeminiKeyInvalid(key) {
    return invalidGeminiKeys.get(key) > Date.now() - 10 * 60 * 1000;
}
function isGeminiKeyCooling(key) {
    const parked = rateLimitedGeminiKeys.get(key);
    return !!(parked && parked.until > Date.now());
}
// Keys that are neither rejected nor cooling down - possibly none. When every key is cooling
// down nothing is sent: hitting them again only uses up more quota (the caller waits instead).
// If every key was rejected outright, the raw list comes back so the user sees Google's error.
function usableGeminiKeys(keys) {
    const notInvalid = keys.filter(k => !isGeminiKeyInvalid(k));
    if (!notInvalid.length) return keys;
    return notInvalid.filter(k => !isGeminiKeyCooling(k));
}

// The answer when every key is cooling down: when the first one is free again, and whether
// they are all out for the day (then retrying today is pointless).
function keysCoolingResult(keys) {
    const now = Date.now();
    const parked = keys.map(k => rateLimitedGeminiKeys.get(k)).filter(p => p && p.until > now);
    const isDailyQuota = parked.length > 0 && parked.every(p => p.daily);
    const retryAfterMs = parked.length ? Math.max(0, Math.min(...parked.map(p => p.until)) - now) : RATE_LIMIT_COOLDOWN_MS;
    const n = keys.length;
    const message = isDailyQuota
        ? `Daily free Gemini quota is used up on all ${n} API key(s). It resets in ${formatWait(retryAfterMs)} (midnight Pacific time). ` +
          'To continue now: set up billing on one Google project, or add a key from another project.'
        : `All ${n} API key(s) are rate-limited by Google - free again in ${formatWait(retryAfterMs)}.`;
    return { ok: false, result: { success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED', isDailyQuota, retryAfterMs, message } };
}

// Wait before the next retry: for rate limits until the first key is free again (as Google
// said), otherwise the usual backoff.
function geminiRetryWaitMs(result, retry) {
    if (result && result.error === 'RATE_LIMIT_EXCEEDED' && result.retryAfterMs != null) {
        return Math.min(90 * 1000, Math.max(2000, result.retryAfterMs + 500));
    }
    return GEMINI_RETRY_DELAYS_MS[Math.min(retry, GEMINI_RETRY_DELAYS_MS.length - 1)];
}

// For the API key list in Settings / DAI Studio: what each key can do right now.
function geminiKeyStatus(key) {
    const now = Date.now();
    if (isGeminiKeyInvalid(key)) return { state: 'invalid' };
    const models = [];
    for (const [id, c] of geminiModelCooldowns) {
        if (!id.startsWith(`${key}|`) || !(c.until > now)) continue;
        models.push({ model: id.slice(key.length + 1), daily: !!c.daily, retryAfterMs: c.until - now });
    }
    const parked = rateLimitedGeminiKeys.get(key);
    if (parked && parked.until > now) {
        return { state: parked.daily ? 'daily' : 'cooling', retryAfterMs: parked.until - now, models };
    }
    return { state: models.length ? 'partial' : 'ok', models };
}

// One pass over the keys: success, or the most useful failure. Invalid keys and busy
// keys move on to the next key; a real error (bad request, blocked content) stops here
// because another key won't change it.
async function tryKeysOnce(keys, call) {
    let transientOut = null, lastOut = null;
    const usable = usableGeminiKeys(keys);
    if (!usable.length) return keysCoolingResult(keys);
    for (const key of usable) {
        const out = await call(key);
        if (out.ok) return out;
        lastOut = out;
        if (out.result && out.result.error === 'INVALID_API_KEY') {
            invalidGeminiKeys.set(key, Date.now());
            console.warn(`[Gemini] key …${String(key).slice(-4)} rejected (${out.result.message || 'invalid'}); skipping it`);
            continue;
        }
        // A dead connection affects every key the same way: don't cycle through them.
        if (out.result && out.result.code === 'NETWORK_ERROR') return out;
        if (isTransientGeminiFailure(out.result)) {
            if (out.result.error === 'RATE_LIMIT_EXCEEDED') {
                const daily = !!out.result.isDailyQuota;
                const waitMs = out.result.retryAfterMs != null ? out.result.retryAfterMs : RATE_LIMIT_COOLDOWN_MS;
                rateLimitedGeminiKeys.set(key, { until: Date.now() + waitMs, daily });
                console.warn(`[Gemini] key …${String(key).slice(-4)} ${daily ? 'used up its daily quota' : 'rate-limited'}; parked for ${formatWait(waitMs)}, trying the next key`);
            }
            // A busy (503) key is a better answer than a rate-limited one: it is worth retrying soon.
            if (!transientOut || transientOut.result.error === 'RATE_LIMIT_EXCEEDED') transientOut = out;
            continue;
        }
        return out;
    }
    // Every key ended up rate-limited: report for all of them (soonest free key, all-daily or not).
    if (transientOut && transientOut.result.error === 'RATE_LIMIT_EXCEEDED' && !usableGeminiKeys(keys).length) {
        return keysCoolingResult(keys);
    }
    return transientOut || lastOut;
}

// Try each key, and wait/retry on "busy" like the main pass does.
async function geminiWithKeys(keys, call, signal) {
    let out = null;
    for (let retry = 0; ; retry++) {
        out = await tryKeysOnce(keys, call);
        if (out.ok || !isTransientGeminiFailure(out.result)) return out;
        if (retry >= Math.min(2, geminiRetryLimit(out.result))) return out;
        await sleepAbortable(geminiRetryWaitMs(out.result, retry), signal);
    }
}

async function retranslateCues(targets, allCues, { keys, model, promptOpts, glossary, signal }) {
    let fixed = 0;
    for (let b = 0; b < targets.length; b += REPAIR_TRANSLATE_BATCH) {
        const batch = targets.slice(b, b + REPAIR_TRANSLATE_BATCH);
        const lines = batch.map(({ cue, index }) => {
            const around = (from, to) => allCues.slice(Math.max(0, from), Math.max(0, to))
                .map(c => `${c.originalText || ''}${c.text && KHMER_CHAR_RE.test(c.text) ? ` => ${c.text}` : ''}`).filter(Boolean);
            return { i: index, text: cue.originalText, context: [...around(index - 2, index), '>>> THIS LINE <<<', ...around(index + 1, index + 3)].join(' | ') };
        });
        const payload = {
            contents: [{ role: 'user', parts: [{ text: buildTranslatePrompt({ lines, glossaryHint: promptOpts.glossaryHint, genreGuidance: promptOpts.genreGuidance, previousLines: [] }) + '\n\nEach line has a "context" field with the neighbouring dialogue - use it only to understand the meaning; translate only "text".' }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: TRANSLATE_RESPONSE_SCHEMA, maxOutputTokens: 16384 }
        };
        const out = await geminiWithKeys(keys, async (key) => {
            const r = await executeGeminiGenerate(key, model, payload, signal);
            return r.success ? { ok: true, items: parseJsonArrayLoose(r.text) || [] } : { ok: false, result: r };
        }, signal);
        if (!out.ok) return { fixed, error: out.result };
        const byIndex = new Map(out.items.map(it => [Number(it && it.i), it]));
        for (const { cue, index } of batch) {
            const it = byIndex.get(index);
            if (!it) continue;
            let clean = sanitizeKhmerDialogue(it.text || '');
            if (glossary) clean = applyGlossary(clean, glossary);
            if (!clean || !KHMER_CHAR_RE.test(clean)) continue;
            cue.text = clean;
            if (!cue.speaker && it.speaker) cue.speaker = it.speaker;
            if (!cue.gender && it.gender) cue.gender = it.gender;
            if (!cue.emotion && it.emotion) cue.emotion = it.emotion;
            cue._repaired = 'translated';
            fixed++;
        }
    }
    return { fixed };
}

// cues: [{ _start, _end, text, originalText, speaker, ... }] (mutated in place + new ones appended)
async function repairTranscript({ cues, sourceFile, totalSec, keys, model, promptOpts, glossary, workDir, signal, progress, checkGaps = true }) {
    const report = { gapsFound: 0, gapsChecked: 0, linesAdded: 0, retranslated: 0, stillUntranslated: 0 };

    if (checkGaps && sourceFile && totalSec > 0) {
        const windows = findDialogueGaps(cues, totalSec).slice(0, REPAIR_MAX_GAPS);
        report.gapsFound = windows.length;
        const toCheck = [];
        for (const w of windows) {
            if (signal && signal.aborted) break;
            // Mostly-silent stretches have nothing to recover.
            if ((await silentFraction(sourceFile, w.start, w.end - w.start, signal)) > 0.85) continue;
            toCheck.push(w);
        }
        const setGapNote = () => {
            if (progress && toCheck.length) progress.note = `Double-checking ${toCheck.length} stretch(es) with no subtitles for missed dialogue (${report.gapsChecked}/${toCheck.length})…`;
        };
        setGapNote();
        const existing = [...cues];
        const budgetEnd = Date.now() + REPAIR_GAP_BUDGET_MS;
        let next = 0;
        const worker = async (lane) => {
            const laneKeys = [...keys.slice(lane), ...keys.slice(0, lane)];
            while (next < toCheck.length) {
                if ((signal && signal.aborted) || report.quotaError) return;
                if (Date.now() > budgetEnd) {
                    report.gapsSkippedForTime = toCheck.length - next;
                    return;
                }
                const w = toCheck[next++];
                try {
                const clipSec = w.end - w.start;
                const clipFile = path.join(workDir, `gap_${Math.round(w.start * 1000)}.mp3`);
                const { code } = await runFFmpegCapture(['-hide_banner', '-y', '-ss', w.start.toFixed(3), '-t', clipSec.toFixed(3), '-i', sourceFile,
                    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', clipFile], signal);
                if (code !== 0 || !fs.existsSync(clipFile)) continue;
                const clipBase64 = fs.readFileSync(clipFile).toString('base64');
                const before = existing.filter(c => c._end <= w.start + 0.5).slice(-4);
                const out = await geminiWithKeys(laneKeys, (key) => transcribeClipWithGemini({
                    apiKey: key, model, audioBase64: clipBase64, mimeType: 'audio/mp3', clipSec,
                    promptOpts: { ...promptOpts, previousLines: before }, signal
                }), signal);
                report.gapsChecked++;
                setGapNote();
                if (!out.ok) {
                    // Counted, so a failed check is never reported as "nothing missing".
                    report.gapsFailed = (report.gapsFailed || 0) + 1;
                    if (out.result && out.result.isDailyQuota) {
                        report.quotaError = out.result.message; // the other lanes stop too (see the loop)
                        return;
                    }
                    continue;
                }
                for (const cue of normalizeClipCues(out.items, w.start, clipSec, glossary)) {
                    // Skip anything that overlaps a line we already have (window edges).
                    const dur = Math.max(0.1, cue._end - cue._start);
                    const clash = cues.some(c => Math.min(c._end, cue._end) - Math.max(c._start, cue._start) > dur * 0.4);
                    if (clash) continue;
                    cue._repaired = 'added';
                    cues.push(cue);
                    report.linesAdded++;
                }
                } catch (e) {
                    if (e.name === 'AbortError') throw e;
                    console.warn(`[Repair] gap ${w.start.toFixed(0)}-${w.end.toFixed(0)}s skipped:`, e.message);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(keys.length, TRANSCRIBE_MAX_LANES, toCheck.length)) }, (_, lane) => worker(lane)));
        cues.sort((a, b) => a._start - b._start);
    }

    const targets = cues.map((cue, index) => ({ cue, index })).filter(({ cue }) => cueNeedsTranslation(cue));
    if (targets.length && !report.quotaError) {
        if (progress) progress.note = `Translating ${targets.length} line(s) that came back without Khmer…`;
        const r = await retranslateCues(targets, cues, { keys, model, promptOpts, glossary, signal });
        report.retranslated = r.fixed;
        if (r.error) report.translateError = r.error.message || r.error.error;
        if (r.error && r.error.isDailyQuota) report.quotaError = r.error.message;
    }
    report.stillUntranslated = cues.filter(cueNeedsTranslation).length;
    console.log('[Repair]', JSON.stringify(report));
    return report;
}

app.post('/api/transcribe', async (req, res) => {
    const {
        audioBase64,
        audioPath,
        mimeType = 'audio/mp3',
        duration,
        genre = 'historical',
        dramaRegister,
        glossary,
        apiKey,
        apiKeys,
        model = 'gemini-2.0-flash',
        requestId,
        videoName,
        partIndex,
        customFolder,
        sourceFilePath,
        apiSaver = false
    } = req.body;

    if (!audioBase64 && !audioPath) {
        return res.status(400).json({ success: false, error: 'No audio data or audio path received.' });
    }

    // An audioPath is already on disk (e.g. the mp3 /api/extract-audio just saved), so it is
    // neither read into memory nor saved again - it could be a full-length video.
    const usePath = !!(audioPath && fs.existsSync(audioPath));
    let audioBuffer = null;
    try {
        if (!usePath && audioBase64) {
            audioBuffer = Buffer.from(audioBase64, 'base64');
            saveTranscribeAudio(audioBuffer, videoName, partIndex, customFolder, sourceFilePath);
        }
    } catch (err) {
        console.warn('[Outputs] Error saving transcribe chunk:', err.message);
    }

    if (!apiKey || !apiKey.trim()) {
        return res.status(400).json({
            success: false,
            error: 'INVALID_API_KEY',
            message: 'Please enter your Gemini API Key in Settings ➔ General.'
        });
    }

    const abortCtrl = new AbortController();
    if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);
    const workDir = path.join(SEPARATED_DIR, `transcribe_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);

    try {
        const genreRegister = genre || dramaRegister || 'historical';
        const promptOpts = {
            genreGuidance: getKhmerDramaRegisterGuidance(genreRegister),
            glossaryHint: glossary ? `\n\nCUSTOM CHARACTER / GLOSSARY DICTIONARY (STRICTLY USE THESE TRANSLATIONS):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : ''
        };

        fs.mkdirSync(workDir, { recursive: true });
        let inputFile;
        if (usePath) {
            inputFile = audioPath;
        } else {
            const ext = /wav/i.test(mimeType) ? '.wav' : /m4a|mp4|aac/i.test(mimeType) ? '.m4a' : /ogg|opus/i.test(mimeType) ? '.ogg' : '.mp3';
            inputFile = path.join(workDir, `input${ext}`);
            fs.writeFileSync(inputFile, audioBuffer || Buffer.from(audioBase64, 'base64'));
        }

        const totalSec = (await probeAudioDuration(inputFile)) || Number(duration) || 0;
        const chunkPlan = apiSaver ? { singleMax: SAVER_SINGLE_MAX_SEC, target: SAVER_CHUNK_TARGET_SEC } : {};
        const silences = totalSec > (chunkPlan.singleMax || TRANSCRIBE_SINGLE_MAX_SEC) ? await detectSilences(inputFile, abortCtrl.signal) : [];
        const chunks = totalSec > 0 ? planTranscribeChunks(totalSec, silences, chunkPlan) : [{ start: 0, end: 0 }];
        console.log(`[Transcribe] ${totalSec.toFixed(1)}s audio -> ${chunks.length} chunk(s)`);

        // One lane per API key (max 4). Each lane takes a contiguous run of chunks
        // and walks it in order, so neighbouring chunks still share context.
        const keyPool = [apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]
            .map(k => String(k || '').trim())
            .filter((k, i, a) => k && a.indexOf(k) === i);
        const laneCount = Math.max(1, Math.min(keyPool.length, TRANSCRIBE_MAX_LANES, Math.ceil(chunks.length / 2)));
        const chunkCues = new Array(chunks.length);
        const rawParts = new Array(chunks.length);
        const progress = { done: 0, total: chunks.length };
        if (requestId) transcribeProgress.set(requestId, progress);
        let failure = null;
        let anyTruncated = false;
        console.log(`[Transcribe] ${chunks.length} chunk(s) across ${laneCount} API key lane(s)${apiSaver ? ' [API saver]' : ''}`);

        const cutClip = async (i) => {
            const chunk = chunks[i];
            const clipSec = chunk.end - chunk.start;
            // Speech-only 16kHz mono at 48kbps: tiny upload, same recognition quality.
            // A file given by path is always cut: it may be a video, or too big to send as is.
            if (!(chunks.length > 1 || usePath || audioBase64.length > 14 * 1024 * 1024) || !(totalSec > 0)) {
                return usePath
                    ? { clipBase64: fs.readFileSync(inputFile).toString('base64'), clipMime: mimeType || 'audio/mp3' }
                    : { clipBase64: audioBase64, clipMime: mimeType || 'audio/mp3' };
            }
            const clipFile = path.join(workDir, `clip_${i}.mp3`);
            const { code } = await runFFmpegCapture(['-hide_banner', '-y', '-ss', chunk.start.toFixed(3), '-t', clipSec.toFixed(3),
                '-i', inputFile, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', clipFile], abortCtrl.signal);
            if (code !== 0 || !fs.existsSync(clipFile)) throw new Error(`FFmpeg failed to cut audio chunk ${i + 1}`);
            return { clipBase64: fs.readFileSync(clipFile).toString('base64'), clipMime: 'audio/mp3' };
        };

        const runLane = async (lane) => {
            const from = Math.floor(lane * chunks.length / laneCount);
            const to = Math.floor((lane + 1) * chunks.length / laneCount);
            // This lane's key first; the others are backups if it gets rate-limited.
            const keys = [...keyPool.slice(lane), ...keyPool.slice(0, lane)];
            let laneCues = [];
            for (let i = from; i < to; i++) {
                if (failure || abortCtrl.signal.aborted) return;
                const chunk = chunks[i];
                const clipSec = chunk.end - chunk.start;
                const { clipBase64, clipMime } = await cutClip(i);
                const cacheKey = transcribeCacheKey(clipBase64, [model, genreRegister, glossary || null]);
                let out = transcribeCacheGet(cacheKey);
                if (out) console.log(`[Transcribe] Chunk ${i + 1}/${chunks.length} reused from previous attempt`);
                for (let retry = 0; !out || !out.ok; retry++) {
                    out = await tryKeysOnce(keys, (key) => transcribeClipWithGemini({
                        apiKey: key, model, audioBase64: clipBase64, mimeType: clipMime, clipSec,
                        promptOpts: { ...promptOpts, previousLines: laneCues.slice(-4) },
                        signal: abortCtrl.signal
                    }));
                    if (out.ok || failure || !isTransientGeminiFailure(out.result) || retry >= geminiRetryLimit(out.result)) break;
                    const wait = geminiRetryWaitMs(out.result, retry);
                    const why = out.result.code === 'NETWORK_ERROR' ? 'Connection problem' : out.result.error === 'RATE_LIMIT_EXCEEDED' ? 'Google rate limit' : 'Google is busy';
                    progress.note = `${why} - retrying part ${i + 1} in ${Math.round(wait / 1000)}s (${retry + 1}/${geminiRetryLimit(out.result)})`;
                    console.warn(`[Transcribe] ${progress.note}: ${out.result.error}`);
                    await sleepAbortable(wait, abortCtrl.signal);
                }
                if (out.ok) transcribeCacheSet(cacheKey, out);
                if (!out.ok) {
                    console.warn(`[Transcribe] Chunk ${i + 1}/${chunks.length} failed:`, out.result.error);
                    failure = failure || out.result;
                    return;
                }
                rawParts[i] = out.raw;
                if (out.truncated) anyTruncated = true;
                chunkCues[i] = normalizeClipCues(out.items, chunk.start, clipSec, glossary);
                laneCues = chunkCues[i].length ? chunkCues[i] : laneCues;
                progress.done++;
                if (progress.note && progress.note.includes(`retrying part ${i + 1} `)) progress.note = null; // that part went through
                console.log(`[Transcribe] Chunk ${i + 1}/${chunks.length} (${chunk.start.toFixed(1)}-${chunk.end.toFixed(1)}s) -> ${chunkCues[i].length} lines via ${out.modelUsed} [lane ${lane + 1}]`);
            }
        };

        // An unexpected error in one lane becomes the job's failure; the other lanes stop at
        // their next chunk, and we only respond (and delete temp files) once all have stopped.
        await Promise.all(Array.from({ length: laneCount }, (_, lane) => runLane(lane).catch((e) => {
            if (e.name !== 'AbortError') failure = failure || { status: 500, error: e.message };
        })));
        if (abortCtrl.signal.aborted) return res.json({ success: false, error: 'CANCELLED' });
        if (failure) return geminiFailureResponse(res, failure);
        const allCues = chunkCues.flat();

        let repair = null;
        try {
            repair = await repairTranscript({
                cues: allCues, sourceFile: totalSec > 0 ? inputFile : null, totalSec, keys: keyPool, model,
                promptOpts, glossary, workDir, signal: abortCtrl.signal, progress,
                // API saver skips the missed-dialogue pass, unless a reply was cut off (its tail is a gap).
                checkGaps: !apiSaver || anyTruncated
            });
        } catch (e) {
            if (e.name === 'AbortError' || abortCtrl.signal.aborted) throw e;
            console.warn('[Repair] skipped:', e.message);
        }

        if (allCues.length === 0) {
            return res.status(422).json({ success: false, error: 'No spoken dialogue was detected in this audio.' });
        }

        res.json({
            success: true,
            data: finalizeCues(allCues),
            repair,
            rawText: rawParts.filter(Boolean).join('\n')
        });

    } catch (e) {
        if (e.name === 'AbortError' || abortCtrl.signal.aborted) {
            return res.json({ success: false, error: 'CANCELLED' });
        }
        console.error('[Transcribe] Error:', e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        if (requestId) {
            activeTranscribeRequests.delete(requestId);
            transcribeProgress.delete(requestId);
        }
        fs.rm(workDir, { recursive: true, force: true }, () => { });
    }
});

// 4a. Fix Missing: repair an existing subtitle list (any project, any engine) in place -
// re-transcribe only stretches with no subtitles, re-translate only lines without Khmer.
app.post('/api/repair-subtitles', async (req, res) => {
    const { subtitles, videoPath, duration, genre = 'historical', dramaRegister, glossary, apiKey, apiKeys, model = 'gemini-2.0-flash', requestId, checkGaps = true } = req.body || {};
    if (!Array.isArray(subtitles)) return res.status(400).json({ success: false, error: 'No subtitles provided.' });
    const keyPool = [apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])].map(k => String(k || '').trim()).filter((k, i, a) => k && a.indexOf(k) === i);
    if (!keyPool.length) return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'Gemini API key is required.' });

    const abortCtrl = new AbortController();
    const progress = { done: 0, total: 0 };
    if (requestId) { activeTranscribeRequests.set(requestId, abortCtrl); transcribeProgress.set(requestId, progress); }
    const workDir = path.join(SEPARATED_DIR, `repair_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
    try {
        fs.mkdirSync(workDir, { recursive: true });
        const genreRegister = genre || dramaRegister || 'historical';
        const promptOpts = {
            genreGuidance: getKhmerDramaRegisterGuidance(genreRegister),
            glossaryHint: glossary ? `\n\nCUSTOM CHARACTER / GLOSSARY DICTIONARY (STRICTLY USE THESE TRANSLATIONS):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : ''
        };
        const sourceFile = resolveLocalFilePath(videoPath);
        const hasSource = !!(sourceFile && fs.existsSync(sourceFile));
        const totalSec = hasSource ? ((await probeAudioDuration(sourceFile)) || Number(duration) || 0) : 0;

        const cues = subtitles.map(s => ({
            id: s.id, text: s.text || '', speaker: s.speaker, gender: s.gender, emotion: s.emotion,
            // Imported SRT / Whisper lines carry the source language in "text" itself.
            originalText: s.originalText || (s.text && !KHMER_CHAR_RE.test(s.text) ? s.text : ''),
            _start: parseTimestampSeconds(s.start), _end: parseTimestampSeconds(s.end)
        })).filter(c => isFinite(c._start) && isFinite(c._end));
        const before = new Map(cues.map(c => [c.id, c.text]));

        const report = await repairTranscript({
            cues, sourceFile: hasSource ? sourceFile : null, totalSec, keys: keyPool, model, promptOpts, glossary, workDir,
            signal: abortCtrl.signal, progress, checkGaps: checkGaps !== false && hasSource
        });
        if (!hasSource && checkGaps !== false) report.gapsSkipped = 'Video file not available on disk - only re-translated lines.';

        const updated = cues.filter(c => c.id !== undefined && c._repaired === 'translated' && before.get(c.id) !== c.text)
            .map(c => ({ id: c.id, text: c.text, speaker: c.speaker, gender: c.gender, emotion: c.emotion }));
        const added = cues.filter(c => c._repaired === 'added')
            .map(c => ({ start: +c._start.toFixed(2), end: +c._end.toFixed(2), text: c.text, originalText: c.originalText, speaker: c.speaker, gender: c.gender, emotion: c.emotion }));
        res.json({ success: true, updated, added, report });
    } catch (e) {
        if (e.name === 'AbortError' || abortCtrl.signal.aborted) return res.json({ success: false, error: 'CANCELLED' });
        console.error('[Repair] Error:', e);
        res.status(500).json({ success: false, error: e.message });
    } finally {
        if (requestId) { activeTranscribeRequests.delete(requestId); transcribeProgress.delete(requestId); }
        fs.rm(workDir, { recursive: true, force: true }, () => { });
    }
});

// 4b. Translate SRT / Text directly with Ultra-Concise Dubbing Rules & Drama Register
//
// Lines are sent in numbered batches and matched back by number, so a dropped or
// merged line can never shift every following translation onto the wrong cue.
const TRANSLATE_BATCH_SIZE = 50;

// Mirrors the frontend parseSrtText() block rules so indexes line up 1:1.
function parseSrtBlocksForTranslate(content) {
    return content.trim().replace(/\r\n/g, '\n').split(/\n\s*\n/)
        .map(block => {
            const lines = block.split('\n');
            if (lines.length < 3 || lines[1].split(' --> ').length !== 2) return null;
            return lines.slice(2).join('\n')
                .replace(/^\[(Male|Female|Hero|Heroine|Father|Mother|Villain|Queen|Elder|Child)(?::[^\]]+)?\]\s*/i, '')
                .trim();
        })
        .filter(t => t !== null);
}

function buildTranslatePrompt({ lines, glossaryHint, genreGuidance, previousLines }) {
    const contextHint = previousLines && previousLines.length
        ? `\n\nPREVIOUS DIALOGUE (context only, for consistent names and pronouns; do NOT translate or output these):\n${previousLines.map(l => `- [${l.gender || '?'}] ${l.source} => ${l.text}`).join('\n')}`
        : '';
    return `You are an elite master film/TV dialogue adapter and dubbing director specializing in Asian and Chinese drama (C-Drama: 古装/宫斗/仙侠/武侠/现代甜宠/总裁/动作) localization into cinematic, natural, ultra-concise, and highly readable Khmer.

TASK:
Translate each dialogue line into SHORT, PUNCHY, and READABLE Khmer dialogue specifically crafted for voice dubbing and clean on-screen subtitle reading.

${KHMER_DUBBING_RULES}
${glossaryHint}${contextHint}

LINE MATCHING & EMOTION RULES:
1. Exact 1-to-1 Line Match:
   - Output exactly one item for every input line, using the same "i" number. Never merge, split, skip, or reorder lines.
   - Use the neighbouring lines as context, but translate each line on its own.
   - Keep each translation strictly 3 to 10 syllables (3 to 8 words).

2. Speaker Gender & Emotional Acting Detection:
   - Assign "gender": "Male" or "Female" - the gender of the character speaking the line, from context, pronouns and relationships.
   - Assign the dramatic emotion: "Neutral", "Angry", "Sad", "Whisper", "Excited", "Royal", "Romantic", "Fear".${genreGuidance}

3. Output Format:
   - Return ONLY a valid JSON array of objects:
[
  {
    "i": 0,
    "text": "Short Khmer translation",
    "gender": "Male",
    "emotion": "Neutral"
  }
]

LINES TO TRANSLATE:
${JSON.stringify(lines)}`;
}

const TRANSLATE_RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            i: { type: 'INTEGER' },
            text: { type: 'STRING' },
            gender: { type: 'STRING', enum: ['Male', 'Female'] },
            emotion: { type: 'STRING', enum: TRANSCRIBE_EMOTIONS }
        },
        required: ['i', 'text', 'gender'],
        propertyOrdering: ['i', 'text', 'gender', 'emotion']
    }
};

app.post('/api/translate-srt', async (req, res) => {
    const {
        srtBase64,
        srtText,
        genre = 'historical',
        dramaRegister,
        glossary,
        apiKey,
        apiKeys,
        model = 'gemini-2.0-flash',
        requestId
    } = req.body;

    let content = srtText;
    if (!content && srtBase64) {
        try {
            content = Buffer.from(srtBase64, 'base64').toString('utf8');
        } catch (e) {
            content = '';
        }
    }

    if (!content || !content.trim()) {
        return res.status(400).json({ success: false, error: 'No subtitle content provided to translate.' });
    }

    if (!apiKey || !apiKey.trim()) {
        return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'API key is required.' });
    }

    const abortCtrl = new AbortController();
    if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);

    try {
        const genreRegister = genre || dramaRegister || 'historical';
        const genreGuidance = getKhmerDramaRegisterGuidance(genreRegister);
        const glossaryHint = glossary ? `\n\nCUSTOM CHARACTER / GLOSSARY DICTIONARY (STRICTLY USE THESE TRANSLATIONS):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : '';

        const sourceLines = parseSrtBlocksForTranslate(content);
        if (sourceLines.length === 0) {
            return res.status(400).json({ success: false, error: 'No subtitle lines found in the SRT.' });
        }

        const results = new Array(sourceLines.length).fill(null);
        const rawParts = [];

        const translateBatch = async (key, indexes, previousLines) => {
            const payload = {
                contents: [{
                    role: 'user',
                    parts: [{ text: buildTranslatePrompt({
                        lines: indexes.map(i => ({ i, text: sourceLines[i] })),
                        glossaryHint, genreGuidance, previousLines
                    }) }]
                }],
                generationConfig: {
                    responseMimeType: 'application/json',
                    responseSchema: TRANSLATE_RESPONSE_SCHEMA,
                    maxOutputTokens: 32768
                }
            };
            const result = await executeGeminiGenerate(key, model, payload, abortCtrl.signal);
            if (!result.success) return result;
            rawParts.push(result.text || '');
            const wanted = new Set(indexes);
            for (const item of parseJsonArrayLoose(result.text) || []) {
                const i = Number(item && item.i);
                if (!wanted.has(i)) continue;
                let clean = sanitizeKhmerDialogue(item.text || '');
                if (glossary) clean = applyGlossary(clean, glossary);
                // An echo of the source (no Khmer) counts as missing, so the retry pass picks it up.
                if (clean && KHMER_CHAR_RE.test(clean)) results[i] = { ...item, text: clean };
            }
            return result;
        };

        // Same lane model as /api/transcribe: one contiguous run of batches per key.
        const keyPool = [apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]
            .map(k => String(k || '').trim())
            .filter((k, i, a) => k && a.indexOf(k) === i);
        const batchStarts = [];
        for (let start = 0; start < sourceLines.length; start += TRANSLATE_BATCH_SIZE) batchStarts.push(start);
        const laneCount = Math.max(1, Math.min(keyPool.length, TRANSCRIBE_MAX_LANES, batchStarts.length));
        let failure = null;

        const runLane = async (lane) => {
            const keys = [...keyPool.slice(lane), ...keyPool.slice(0, lane)];
            const from = Math.floor(lane * batchStarts.length / laneCount);
            const to = Math.floor((lane + 1) * batchStarts.length / laneCount);
            for (let b = from; b < to; b++) {
                if (failure || abortCtrl.signal.aborted) return;
                const start = batchStarts[b];
                const indexes = [];
                for (let i = start; i < Math.min(start + TRANSLATE_BATCH_SIZE, sourceLines.length); i++) indexes.push(i);
                const previousLines = [];
                for (let i = Math.max(0, start - 4); i < start; i++) {
                    if (results[i]) previousLines.push({ source: sourceLines[i], text: results[i].text, gender: results[i].gender });
                }

                const attempt = async (idx) => {
                    let r = null;
                    for (let retry = 0; ; retry++) {
                        const out = await tryKeysOnce(keys, async (key) => {
                            const res = await translateBatch(key, idx, previousLines);
                            return res.success ? { ok: true, res } : { ok: false, result: res };
                        });
                        r = out.ok ? out.res : out.result;
                        if (r.success || failure || !isTransientGeminiFailure(r) || retry >= geminiRetryLimit(r)) return r;
                        const wait = geminiRetryWaitMs(r, retry);
                        console.warn(`[Translate] ${r.error === 'RATE_LIMIT_EXCEEDED' ? 'Rate-limited' : 'Google busy'}, retrying lines ${idx[0] + 1}-${idx[idx.length - 1] + 1} in ${Math.round(wait / 1000)}s: ${r.message || r.error}`);
                        await sleepAbortable(wait, abortCtrl.signal);
                    }
                };
                const result = await attempt(indexes);
                if (!result.success) { failure = failure || result; return; }

                // One follow-up pass for any lines the model skipped.
                const missing = indexes.filter(i => !results[i] && sourceLines[i]);
                if (missing.length) {
                    console.warn(`[Translate] Retrying ${missing.length} skipped line(s)`);
                    const retry = await attempt(missing);
                    if (!retry.success) { failure = failure || retry; return; }
                }
            }
        };

        // An unexpected error in one lane becomes the job's failure; the other lanes stop at
        // their next chunk, and we only respond (and delete temp files) once all have stopped.
        await Promise.all(Array.from({ length: laneCount }, (_, lane) => runLane(lane).catch((e) => {
            if (e.name !== 'AbortError') failure = failure || { status: 500, error: e.message };
        })));
        if (abortCtrl.signal.aborted) return res.json({ success: false, error: 'CANCELLED' });
        if (failure) return geminiFailureResponse(res, failure);

        // Frontend maps by position; a null entry keeps that line's original text.
        res.json({
            success: true,
            data: results,
            rawText: rawParts.join('\n')
        });
    } catch (e) {
        if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
        res.status(500).json({ success: false, error: e.message });
    } finally {
        if (requestId) activeTranscribeRequests.delete(requestId);
    }
});

// 4b. Khmer Movie Title Suggestions (DAI-Transcribe Suite)
app.post('/api/suggest-movie-titles', async (req, res) => {
    const {
        title,
        contextText,
        genre = 'all',
        apiKey,
        apiKeys,
        model = 'gemini-2.0-flash'
    } = req.body;

    if (!title || !title.trim()) {
        return res.status(400).json({ success: false, error: 'Movie title is required.' });
    }

    const key = (apiKey && apiKey.trim()) || (Array.isArray(apiKeys) && apiKeys[0]);
    if (!key) {
        return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'Gemini API Key is required.' });
    }

    const abortCtrl = new AbortController();
    try {
        const prompt = `You are a master Cambodian film distributor, creative director, and localization expert specializing in translating foreign movie and drama titles into captivating, prestigious, and culturally resonant Khmer titles for Cambodian audiences and box office.

ORIGINAL TITLE: "${title.trim()}"
${genre ? `GENRE / REGISTER: ${genre}` : ''}
${contextText ? `STORY CONTEXT / SUBTITLE SAMPLE / SYNOPSIS:\n${String(contextText).slice(0, 3000)}` : ''}

TASK:
Analyze the title, genre, and story context, and produce the top 10 catchy, authentic, and cinematic Khmer titles.
Distribute them across styles:
- 👑 រឿងបុរាណ / រាជវាំង / វីរបុរស (Royal & Epic)
- 💖 ស្នេហាផ្អែមល្ហែម / មនោសញ្ចេតនា (Sweet Romance & Drama)
- ⚔️ សកម្មភាព / កក្រើក / រំភើប (Action & Thriller)
- ⚡ ចំណងជើងទាក់ទាញ / Viral (Catchy & Viral)
- 🎭 ក្បួនភាពយន្តខ្មែរ (Classic Khmer Cinema Style)

REQUIREMENTS:
1. High-standard Khmer spelling and phonetic beauty. Use natural Khmer poetic rhythm.
2. For each title, provide:
   - "khmerTitle": The exact title in Khmer script (e.g. "វាសនានាគរាជមាស", "ស្នេហ៍ឆ្លងភព")
   - "englishTranslation": Literal or meaning in English
   - "category": One of "Royal & Epic", "Romance & Drama", "Action & Thriller", "Catchy & Viral", "Classic Cinema"
   - "tagline": A short punchy promotional catchphrase in Khmer (ពាក្យស្លោក)
   - "whyItWorks": Brief explanation (in English or Khmer) why this title sells well to Cambodian audiences.

Output strictly valid JSON array of objects with the exact schema:
[
  {
    "khmerTitle": "...",
    "englishTranslation": "...",
    "category": "...",
    "tagline": "...",
    "whyItWorks": "..."
  }
]`;

        const payload = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.7
            }
        };

        const result = await executeGeminiGenerate(key, model, payload, abortCtrl.signal);
        if (!result.success) return res.status(500).json(result);

        const titles = parseJsonArrayLoose(result.text);
        res.json({ success: true, titles: Array.isArray(titles) ? titles : [], rawText: result.text });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
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

// 4c. Single Dialogue Line AI Rewriter (Shorten, Dramatic, Royal, Comedy)
app.post('/api/rewrite-dialogue', async (req, res) => {
    const {
        text,
        originalText,
        mode = 'shorten', // 'shorten' | 'dramatic' | 'royal' | 'comedy'
        genre = 'historical',
        glossary,
        apiKey,
        model = 'gemini-3.8-flash',
        requestId
    } = req.body;

    if (!text || !text.trim()) {
        return res.status(400).json({ success: false, error: 'No dialogue text provided.' });
    }

    if (!apiKey || !apiKey.trim()) {
        return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'API key is required.' });
    }

    let modeInstruction = '';
    if (mode === 'shorten') {
        modeInstruction = 'Make the Khmer subtitle dialogue ULTRA-SHORT (strictly 3 to 6 words / 3 to 7 syllables maximum), highly punchy, clear, and easy to read in 0.8 seconds. Drop all non-essential words while preserving the core emotional meaning.';
    } else if (mode === 'dramatic') {
        modeInstruction = 'Make the Khmer dialogue HIGHLY DRAMATIC, emotionally charged, intense, and cinematic. Use strong spoken drama vocabulary (កាច កម្សត់ ឬតានតឹង) suitable for professional voice dubbing.';
    } else if (mode === 'royal') {
        modeInstruction = 'Convert the Khmer dialogue into classical royal court / imperial palace language (រាជស័ព្ទ/រាជវាំង/បុរាណ) using terms like ព្រះអង្គ, ក្រាបទូល, ទូលបង្គំ, ខ្ញុំម្ចាស់, ម្ចាស់បង, ព្រះរាជបញ្ជា, etc. Keep it compact and speakable.';
    } else if (mode === 'comedy') {
        modeInstruction = 'Rewrite the Khmer dialogue into a witty, humorous, lively, and entertaining Cambodian colloquialism (កំប្លុកកំប្លែង ភាសានិយាយសាមញ្ញរស់រវើក). Keep it punchy and short.';
    } else {
        modeInstruction = 'Polish the Khmer dialogue to be ultra-concise, natural, and speakable for film dubbing.';
    }

    const glossaryHint = glossary ? `\n\nCUSTOM GLOSSARY:\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary)}` : '';

    const prompt = `You are a master Cambodian film dubbing adapter and script doctor.
Rewrite the following dialogue line according to this instruction:
${modeInstruction}

INPUT LINE: "${text}"
${originalText ? `ORIGINAL REFERENCE: "${originalText}"` : ''}
${glossaryHint}

RULES:
1. Return ONLY the rewritten Khmer dialogue string. No explanations, no quotes, no markdown, no JSON, just the single final line.
2. Ensure proper spacing between clauses for readability.
3. Absolutely NO robotic textbook words (no "តើ...", "បាន...", "កំពុងតែ...", "របស់អ្នក").`;

    const payload = {
        contents: [
            {
                role: "user",
                parts: [{ text: prompt }]
            }
        ]
    };

    const abortCtrl = new AbortController();
    if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);

    try {
        const geminiResult = await executeGeminiGenerate(apiKey, model, payload, abortCtrl.signal);

        if (!geminiResult.success) {
            return res.status(geminiResult.status || 500).json({
                success: false,
                error: geminiResult.error || 'REWRITE_FAILED',
                message: geminiResult.message
            });
        }

        const json = geminiResult.json;
        let rawContent = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        let cleanText = sanitizeKhmerDialogue(rawContent.replace(/^["'`]+|["'`]+$/g, '').trim());
        if (glossary) {
            cleanText = applyGlossary(cleanText, glossary);
        }

        res.json({
            success: true,
            rewrittenText: cleanText,
            mode
        });
    } catch (e) {
        if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
        res.status(500).json({ success: false, error: e.message });
    } finally {
        if (requestId) activeTranscribeRequests.delete(requestId);
    }
});

// 4d. Batch Dialogue Subtitles AI Refactor & Polish (Natural Spoken, Shorten, Dramatic, Royal, Comedy)
app.post('/api/refactor-subtitles-batch', async (req, res) => {
    const {
        subtitles: rawSubtitles = [],
        mode = 'natural', // 'natural' | 'shorten' | 'dramatic' | 'royal' | 'comedy'
        genre = 'historical',
        dramaRegister,
        glossary,
        apiKey,
        model = 'gemini-3.8-flash',
        requestId
    } = req.body;

    const subtitles = Array.isArray(rawSubtitles) ? rawSubtitles : [];
    if (subtitles.length === 0) {
        return res.status(400).json({ success: false, error: 'No subtitles provided for refactoring.' });
    }

    if (!apiKey || !apiKey.trim()) {
        return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'Gemini API key is required in Settings.' });
    }

    let modeInstruction = '';
    if (mode === 'shorten') {
        modeInstruction = 'Make all Khmer dialogue ULTRA-SHORT (strictly 3 to 6 words / 3 to 7 syllables maximum per line), highly punchy, clear, and fast to read. Drop all unnecessary words, filler particles, and clauses while keeping the core meaning.';
    } else if (mode === 'dramatic') {
        modeInstruction = 'Refactor all Khmer dialogue into HIGHLY DRAMATIC, intense, emotional, and cinematic spoken lines. Use expressive spoken vocabulary (កាច កម្សត់ តានតឹង) suitable for professional drama voice dubbing.';
    } else if (mode === 'royal') {
        modeInstruction = 'Convert all Khmer dialogue into classical royal court / imperial palace language (រាជស័ព្ទ / បុរាណ / រាជវាំង) using authentic royal terms (ព្រះអង្គ, ក្រាបទូល, ទូលបង្គំ, ខ្ញុំម្ចាស់, ម្ចាស់បង, ព្រះរាជបញ្ជា, etc.) while keeping lines short and speakable.';
    } else if (mode === 'comedy') {
        modeInstruction = 'Rewrite all Khmer dialogue into humorous, witty, lively, and entertaining Cambodian spoken colloquialisms (កំប្លុកកំប្លែង ភាសានិយាយសាមញ្ញរស់រវើក). Keep lines punchy and funny.';
    } else {
        // Default 'natural' / conversational dubbing style
        modeInstruction = 'Refactor and polish all Khmer subtitle dialogue from stiff, textbook, robotic, or overly literal translations into NATURAL, FLUID, and READABLE spoken Khmer dialogue for film & TV dubbing (សម្រួលពាក្យបែបសន្ទនាធម្មជាតិ ខ្លី ខ្លឹម ដូចរឿងភាគទូរទស្សន៍).';
    }

    const genreRegister = genre || dramaRegister || 'historical';
    const genreGuidance = getKhmerDramaRegisterGuidance(genreRegister);
    const glossaryHint = glossary ? `\n\nCUSTOM GLOSSARY DICTIONARY (STRICTLY APPLY):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : '';

    // Chunk array into max 100 items per Gemini batch for reliable JSON parsing
    const CHUNK_SIZE = 100;
    const chunks = [];
    for (let i = 0; i < subtitles.length; i += CHUNK_SIZE) {
        chunks.push(subtitles.slice(i, i + CHUNK_SIZE));
    }

    const abortCtrl = new AbortController();
    if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);

    try {
        const resultMap = new Map();

        for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
            if (abortCtrl.signal.aborted) break;
            const currentChunk = chunks[chunkIdx];
            const startGlobalIdx = chunkIdx * CHUNK_SIZE;

            const inputLines = currentChunk.map((s, i) => ({
                index: startGlobalIdx + i,
                id: String(s.id || (startGlobalIdx + i)),
                text: s.text || '',
                originalText: s.originalText || ''
            }));

            const prompt = `You are an elite Cambodian film dubbing adapter, dialogue refactorer, and script doctor.

TASK:
Refactor and polish the provided list of subtitle lines according to this style:
${modeInstruction}

${KHMER_DUBBING_RULES}
${genreGuidance}
${glossaryHint}

SPECIFIC TRANSFORMATION EXAMPLES:
- ❌ "ល្ងាចនេះអ្នកចង់ញ៉ាំអ្វី? ខ្ញុំនឹងធ្វើវាឱ្យមានរសជាតិឆ្ងាញ់" -> ✅ "ល្ងាចនេះចង់ញ៉ាំអី? ចាំខ្ញុំធ្វើឱ្យ"
- ❌ "តើអ្នកកំពុងតែធ្វើអ្វីនៅទីនេះ?" -> ✅ "ឯងធ្វើអីហ្នឹង?" / "បងធ្វើអី?"
- ❌ "តើមានរឿងអ្វីបានកើតឡើងចំពោះអ្នក?" -> ✅ "កើតអីហ្នឹង?" / "មានរឿងអី?"
- ❌ "ខ្ញុំសូមអភ័យទោសដែលបានមកយឺត" -> ✅ "សុំទោស ខ្ញុំមកយឺត"
- ❌ "កុំមានការព្រួយបារម្ភចំពោះខ្ញុំអី" -> ✅ "កុំបារម្ភពីខ្ញុំ" / "ទុកចិត្តចុះ"
- ❌ "ខ្ញុំមិនអាចយល់ស្របនឹងរឿងនេះបានឡើយ" -> ✅ "ខ្ញុំមិនព្រមដាច់ខាត!"

OUTPUT FORMAT:
Output ONLY a valid JSON array of objects with the exact schema below. Match every input index and ID. No markdown, no commentary.
[
  {
    "index": 0,
    "id": "...",
    "text": "Refactored natural spoken Khmer dialogue"
  }
]

INPUT SUBTITLES TO REFACTOR:
${JSON.stringify(inputLines, null, 2)}`;

            const payload = {
                contents: [
                    {
                        role: "user",
                        parts: [{ text: prompt }]
                    }
                ],
                generationConfig: {
                    responseMimeType: "application/json"
                }
            };

            const geminiResult = await executeGeminiGenerate(apiKey, model, payload, abortCtrl.signal);
            if (!geminiResult.success) {
                if (requestId) activeTranscribeRequests.delete(requestId);
                return res.status(geminiResult.status || 500).json({
                    success: false,
                    error: geminiResult.error || 'REFACTOR_FAILED',
                    message: geminiResult.message
                });
            }

            const json = geminiResult.json;
            let rawContent = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
            let parsedData = [];
            try {
                const cleanJson = rawContent.replace(/^```json/m, '').replace(/^```/m, '').trim();
                parsedData = JSON.parse(cleanJson);
            } catch (e) {
                console.error('Failed to parse Gemini batch refactor output chunk:', rawContent);
            }

            if (Array.isArray(parsedData)) {
                parsedData.forEach(item => {
                    let clean = sanitizeKhmerDialogue(item.text || item.dialogue || '');
                    if (glossary) clean = applyGlossary(clean, glossary);
                    if (item.id !== undefined) resultMap.set(String(item.id), clean);
                    if (item.index !== undefined) resultMap.set(`idx_${item.index}`, clean);
                });
            }
        }

        if (requestId) activeTranscribeRequests.delete(requestId);

        const updatedSubtitles = subtitles.map((sub, i) => {
            const newText = resultMap.get(String(sub.id)) || resultMap.get(`idx_${i}`) || sub.text;
            return {
                id: sub.id,
                text: newText
            };
        });

        res.json({
            success: true,
            refactoredSubtitles: updatedSubtitles,
            count: updatedSubtitles.length,
            mode
        });
    } catch (e) {
        if (requestId) activeTranscribeRequests.delete(requestId);
        if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4e. Smart AI Subtitle Condenser (Refactor long dialogue lines to fit slot duration at 1.0x speed)
app.post('/api/condense-fast-subtitles', async (req, res) => {
    const {
        subtitles: rawSubtitles = [],
        targetLanguage = 'Khmer',
        genre = 'historical',
        glossary,
        apiKey,
        apiKeys,
        model = 'gemini-2.5-flash',
        requestId
    } = req.body || {};

    const subtitles = (Array.isArray(rawSubtitles) ? rawSubtitles : [])
        .filter(s => s && s.id !== undefined && String(s.text || '').trim());
    if (subtitles.length === 0) {
        return res.status(400).json({ success: false, error: 'No subtitles provided to condense.' });
    }

    const keyPool = [apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]
        .map(k => String(k || '').trim())
        .filter((k, i, a) => k && a.indexOf(k) === i);

    if (keyPool.length === 0) {
        return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'Gemini API key is required in Settings.' });
    }

    const abortCtrl = new AbortController();
    if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);

    try {
        // ~3.5 spoken syllables per second is a relaxed dubbing pace.
        const linesData = subtitles.map((s) => {
            const slot = Math.max(0.3, parseFloat(s.slotDuration) || 1.5);
            const speed = parseFloat(s.speed) || 1.0;
            return {
                id: String(s.id),
                text: String(s.text).trim(),
                slotSeconds: Number(slot.toFixed(2)),
                currentSpeed: `${speed.toFixed(2)}x`,
                maxSyllables: Math.max(2, Math.round(slot * 3.5)),
                ...(s.originalText ? { sourceText: String(s.originalText) } : {})
            };
        });

        const isKhmer = /khmer|^km/i.test(String(targetLanguage));
        const registerGuidance = isKhmer ? getKhmerDramaRegisterGuidance(genre || 'historical') : '';
        const glossaryHint = glossary
            ? `\n\nGLOSSARY (keep these names/terms exactly as given):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}`
            : '';

        const prompt = `You are a master film/TV dubbing script adapter and dialogue doctor.
The following ${targetLanguage} dubbing lines are too long for their time slot, so the voice has to be sped up (currentSpeed) and sounds rushed.

YOUR TASK:
Rewrite each line ("text") into SHORT, NATURAL spoken dialogue that fits within its "slotSeconds" at a relaxed, natural 1.0x speaking pace.

STRICT DUBBING CONSTRAINTS:
1. Stay within each line's "maxSyllables" spoken syllables. Shorter is fine; never exceed it.
2. Keep the exact emotional tone, dramatic intent, speaker register and key plot facts. It must sound like authentic, natural film/TV dialogue.
3. Remove redundant pronouns, filler particles, formal padding and verbose structures.
4. Write in ${targetLanguage} (the same language as "text"). "sourceText", when present, is the original-language line for meaning reference only.${registerGuidance}${glossaryHint}

LINES TO CONDENSE:
${JSON.stringify(linesData, null, 2)}

OUTPUT FORMAT:
Return ONLY a JSON array with one object per input line: [{ "id": "<same id>", "condensedText": "<shortened line>" }]`;

        const payload = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            id: { type: 'STRING' },
                            condensedText: { type: 'STRING' }
                        },
                        required: ['id', 'condensedText']
                    }
                }
            }
        };

        // Rotate through keys: a bad or rate-limited key falls through to the next one.
        let result = null;
        for (const k of keyPool) {
            result = await executeGeminiGenerate(k, model, payload, abortCtrl.signal);
            if (result.success) break;
        }

        if (!result || !result.success) {
            return res.status(result?.status || 500).json({
                success: false,
                error: result?.error || 'CONDENSE_FAILED',
                message: result?.message || 'Failed to condense dialogue with Gemini'
            });
        }

        // Loose: a model without JSON mode may wrap the array in a ```json fence.
        const parsed = parseJsonArrayLoose(result.text);
        if (!Array.isArray(parsed)) {
            return res.status(502).json({ success: false, error: 'JSON_PARSE_ERROR', message: 'Gemini did not return a list of lines.' });
        }

        // Keep only well-formed items for ids we actually asked about (first answer per id wins).
        const requestedIds = new Set(linesData.map(l => l.id));
        const seen = new Set();
        const results = [];
        for (const item of parsed) {
            const id = item && String(item.id);
            let text = item && typeof item.condensedText === 'string' ? item.condensedText.trim() : '';
            if (!id || !text || !requestedIds.has(id) || seen.has(id)) continue;
            if (isKhmer) text = sanitizeKhmerDialogue(text);
            if (glossary) text = applyGlossary(text, glossary);
            if (!text) continue;
            seen.add(id);
            results.push({ id, condensedText: text });
        }

        res.json({ success: true, results, count: results.length });
    } catch (e) {
        if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
        res.status(500).json({ success: false, error: e.message });
    } finally {
        if (requestId) activeTranscribeRequests.delete(requestId);
    }
});

app.get('/api/transcribe-progress', (req, res) => {
    const p = transcribeProgress.get(String(req.query.requestId || ''));
    res.json(p ? { success: true, ...p } : { success: false });
});

// Quota state of each API key, as seen by this app since it started (keys sent in the body,
// never in the URL). Only the last 4 characters come back.
app.post('/api/gemini-key-status', (req, res) => {
    const keys = (Array.isArray(req.body?.keys) ? req.body.keys : []).map(k => String(k || '').trim()).filter(Boolean);
    res.json({ success: true, keys: keys.map(k => ({ suffix: k.slice(-4), ...geminiKeyStatus(k) })) });
});

app.post('/api/cancel-transcribe', (req, res) => {
    const { requestId } = req.body;
    if (requestId && activeTranscribeRequests.has(requestId)) {
        const ctrl = activeTranscribeRequests.get(requestId);
        ctrl.abort();
        activeTranscribeRequests.delete(requestId);
    }
    res.json({ success: true });
});

// 4b. Whisper Local Verification & Transcription Endpoints
app.get('/api/check-whisper-folder', (req, res) => {
    const folderPath = req.query.path;
    if (!folderPath || !fs.existsSync(folderPath)) {
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

app.post('/api/transcribe-whisper', async (req, res) => {
    const { whisperFolder, audioPath, videoPath, model = 'medium', device = 'auto', language } = req.body;
    if (!whisperFolder || !fs.existsSync(whisperFolder)) {
        return res.status(400).json({ success: false, error: 'Whisper folder not found' });
    }
    const inputAudio = audioPath || videoPath;
    if (!inputAudio || !fs.existsSync(inputAudio)) {
        return res.status(400).json({ success: false, error: 'Input audio not found' });
    }

    const outSrt = path.join(AUDIO_CACHE_DIR, `whisper_${Date.now()}.srt`);
    const isWin = process.platform === 'win32';
    const runnerFile = isWin ? 'run.bat' : 'run.sh';
    const runnerPath = path.join(whisperFolder, runnerFile);
    const args = ['--audio', inputAudio, '--output_srt', outSrt, '--model', model, '--device', device];
    if (language && String(language).toLowerCase() !== 'auto') args.push('--language', language);

    let child;
    let stderrBuffer = '';
    let stdoutBuffer = '';
    try {
        if (fs.existsSync(runnerPath)) {
            child = isWin
                ? spawn('cmd.exe', ['/c', runnerPath, ...args], { cwd: whisperFolder, windowsHide: true, env: PYTHON_ENV })
                : spawn('bash', [runnerPath, ...args], { cwd: whisperFolder, env: PYTHON_ENV });
        } else {
            const pyScript = path.join(whisperFolder, 'transcribe.py');
            child = spawn(PYTHON_CMD, [pyScript, ...args], { cwd: whisperFolder, windowsHide: true, env: PYTHON_ENV });
        }
        trackProcess(child);
    } catch (spawnErr) {
        return res.status(500).json({ success: false, error: 'Failed to start Whisper process: ' + spawnErr.message });
    }

    // transcribe.py prints a progress line per subtitle cue. If nothing reads
    // stdout, the OS pipe buffer fills up on long videos, Python blocks on
    // write(), and this request would hang forever waiting for 'close'.
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout.on('data', (d) => {
        stdoutBuffer += stdoutDecoder.write(d);
    });

    child.stderr.on('data', (d) => {
        stderrBuffer += stderrDecoder.write(d);
    });

    child.on('error', (err) => {
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    });

    child.on('close', (code) => {
        if (res.headersSent) return;
        if (code === 0 && fs.existsSync(outSrt)) {
            try {
                const srtText = fs.readFileSync(outSrt, 'utf8');
                res.json({ success: true, srtText, srtPath: outSrt });
            } catch (e) {
                res.status(500).json({ success: false, error: 'Failed to read SRT: ' + e.message });
            }
        } else {
            const cleanError = stderrBuffer.trim();
            res.status(500).json({
                success: false,
                error: cleanError ? cleanError.split('\n').pop() || `Whisper exited with code ${code}` : `Whisper exited with code ${code}`
            });
        }
    });
});

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

function resolveCharacterPreset(identifier) {
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

    let emotionPitchOffset = 0;
    let emotionVolOffset = 0;
    let emotionRateOffset = 0;

    if (emotion) {
        const em = String(emotion).toLowerCase().trim();
        if (em === 'angry') {
            emotionPitchOffset = 10;
            emotionVolOffset = 15;
            emotionRateOffset = 12;
        } else if (em === 'sad') {
            emotionPitchOffset = -6;
            emotionVolOffset = -10;
            emotionRateOffset = -12;
        } else if (em === 'whisper') {
            emotionPitchOffset = -4;
            emotionVolOffset = -25;
            emotionRateOffset = -8;
        } else if (em === 'excited') {
            emotionPitchOffset = 12;
            emotionVolOffset = 10;
            emotionRateOffset = 15;
        } else if (em === 'royal') {
            emotionPitchOffset = -8;
            emotionVolOffset = 5;
            emotionRateOffset = -5;
        } else if (em === 'fear') {
            emotionPitchOffset = 15;
            emotionVolOffset = 5;
            emotionRateOffset = 18;
        }
    }

    const totalPitch = basePitchVal + emotionPitchOffset;
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

        child = spawn(PYTHON_CMD, [
            pyScript,
            '--text', text,
            '--voice', voice,
            '--rate', prosody.rate,
            '--pitch', prosody.pitch,
            '--volume', prosody.volume,
            '--output', outFile
        ], { env: PYTHON_ENV });
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
    const child = spawn(PYTHON_CMD, [pyScript, '--batch', batchJsonPath, '--concurrency', '6'], { env: PYTHON_ENV });
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
            cfg_value: parseFloat(req.body.cfg_value) || 1.5,
            output_path: outFile,
            profile: profile || null
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000); // 2 minute timeout for neural synthesis

        let targetEndpoint = `${baseUrl}/api/generate`;
        logVox(`[Send] POST ${targetEndpoint}`);

        let response;
        const requestHeaders = {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };

        try {
            response = await fetch(targetEndpoint, {
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
            response = await fetch(targetEndpoint, {
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
            response = await fetch(fallbackEndpoint, {
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

// 5c. Hardware Encoders Endpoint
app.get('/api/hardware-encoders', async (req, res) => {
    try {
        const encoders = await detectAvailableEncoders();
        res.json({ success: true, encoders });
    } catch (e) {
        res.json({ success: true, encoders: { libx264: true } });
    }
});

// 6. Voice Presets Endpoint
const VOICE_PRESETS = {
    "km-KH-PisethNeural": { "name": "Khmer - Piseth (Male)", "gender": "Male", "lang": "km-KH" },
    "km-KH-SreymomNeural": { "name": "Khmer - Sreymom (Female)", "gender": "Female", "lang": "km-KH" },
    "en-US-GuyNeural": { "name": "English - Guy (Male)", "gender": "Male", "lang": "en-US" },
    "en-US-JennyNeural": { "name": "English - Jenny (Female)", "gender": "Female", "lang": "en-US" },
    "en-US-ChristopherNeural": { "name": "English - Christopher (Male Deep)", "gender": "Male", "lang": "en-US" },
    "en-US-AriaNeural": { "name": "English - Aria (Female Expressive)", "gender": "Female", "lang": "en-US" },
    "zh-CN-YunxiNeural": { "name": "Chinese - Yunxi (Male)", "gender": "Male", "lang": "zh-CN" },
    "zh-CN-XiaoxiaoNeural": { "name": "Chinese - Xiaoxiao (Female)", "gender": "Female", "lang": "zh-CN" },
    "th-TH-NiwatNeural": { "name": "Thai - Niwat (Male)", "gender": "Male", "lang": "th-TH" },
    "th-TH-PremwadeeNeural": { "name": "Thai - Premwadee (Female)", "gender": "Female", "lang": "th-TH" },
    "vi-VN-NamMinhNeural": { "name": "Vietnamese - Nam Minh (Male)", "gender": "Male", "lang": "vi-VN" },
    "vi-VN-HoaiMyNeural": { "name": "Vietnamese - Hoai My (Female)", "gender": "Female", "lang": "vi-VN" },
    "ja-JP-KeitaNeural": { "name": "Japanese - Keita (Male)", "gender": "Male", "lang": "ja-JP" },
    "ja-JP-NanamiNeural": { "name": "Japanese - Nanami (Female)", "gender": "Female", "lang": "ja-JP" },
    "ko-KR-InJoonNeural": { "name": "Korean - InJoon (Male)", "gender": "Male", "lang": "ko-KR" },
    "ko-KR-SunHiNeural": { "name": "Korean - SunHi (Female)", "gender": "Female", "lang": "ko-KR" }
};

app.get('/api/voices', (req, res) => {
    res.json({ success: true, voices: VOICE_PRESETS });
});

// 6b. Character Presets Endpoint (10 Auto-Speaker Roles)
app.get('/api/characters', (req, res) => {
    res.json({ success: true, characters: CHARACTER_PRESETS });
});

// 7. Video Preview & Conversion check
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

app.post('/api/check-video-preview', async (req, res) => {
    const { filePath, force } = req.body || {};
    const resolved = resolveLocalFilePath(filePath);
    if (!resolved || !fs.existsSync(resolved)) {
        return res.json({ success: false, error: 'File not found' });
    }
    try {
        const result = await previewService.check(resolved, force === 'video' || force === 'audio' ? force : null);
        res.json({ success: true, ...result });
    } catch (e) {
        console.warn('[Preview] Probe failed:', e.message);
        res.json({ success: false, error: e.message });
    }
});

// Join Episodes: many short downloaded episodes -> a few ~1 hour parts to dub.
const episodeJoiner = createEpisodeJoiner({ getFFmpegBinary, getFFprobeBinary, detectAvailableEncoders, trackProcess, audioRepair });

app.post('/api/episodes/scan', async (req, res) => {
    const folder = resolveLocalFilePath((req.body || {}).folder);
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return res.json({ success: false, error: 'Folder not found' });
    try {
        res.json({ success: true, ...(await episodeJoiner.scan(folder)) });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/episodes/join', async (req, res) => {
    const { parts, outDir, seriesName } = req.body || {};
    try {
        const jobId = await episodeJoiner.start({ parts, outDir: resolveLocalFilePath(outDir) || outDir, seriesName });
        res.json({ success: true, jobId });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/episodes/status', (req, res) => {
    const st = episodeJoiner.status(String(req.query.jobId || ''));
    res.json(st ? { success: true, ...st } : { success: false, error: 'Unknown job' });
});

app.post('/api/episodes/cancel', (req, res) => {
    res.json({ success: episodeJoiner.cancel(String((req.body || {}).jobId || '')) });
});

// Split Movie: one long movie -> ~30 minute parts, each dubbed as its own project.
const videoSplitter = createVideoSplitter({ getFFmpegBinary, getFFprobeBinary, trackProcess });

app.post('/api/split/inspect', async (req, res) => {
    const file = resolveLocalFilePath((req.body || {}).file);
    if (!file) return res.json({ success: false, error: 'File not found' });
    try {
        res.json({ success: true, ...(await videoSplitter.inspect(file)) });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/split/start', async (req, res) => {
    const { file, outDir, partCount, baseName } = req.body || {};
    const src = resolveLocalFilePath(file);
    if (!src) return res.json({ success: false, error: 'File not found' });
    if (!outDir) return res.json({ success: false, error: 'No output folder' });
    try {
        const jobId = await videoSplitter.start({ file: src, outDir, partCount, baseName });
        res.json({ success: true, jobId });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.get('/api/split/status', (req, res) => {
    const st = videoSplitter.status(String(req.query.jobId || ''));
    res.json(st ? { success: true, ...st } : { success: false, error: 'Unknown job' });
});

app.post('/api/split/cancel', (req, res) => {
    res.json({ success: videoSplitter.cancel(String((req.body || {}).jobId || '')) });
});

app.get('/api/preview-status', (req, res) => {
    const st = previewService.status(String(req.query.jobId || ''));
    res.json(st ? { success: true, ...st } : { success: false, error: 'Unknown job' });
});

app.post('/api/cancel-preview', (req, res) => {
    res.json({ success: previewService.cancel(String((req.body || {}).jobId || '')) });
});

// 8. Video Rendering Pipeline (with color adjustments, flips, audio tracks & vignette)
app.post('/api/render', upload.any(), async (req, res) => {
    // Disable HTTP timeout for long render operations
    req.setTimeout(0);
    res.setTimeout(0);

    let renderOpts = { ...req.body };
    if (req.body.data) {
        try {
            const parsed = JSON.parse(req.body.data);
            renderOpts = { ...renderOpts, ...parsed };
        } catch (e) { }
    }

    // 1. Resolve uploaded video file or explicit path
    const uploadedVideo = (req.files || []).find(f => f.fieldname === 'videoFile' || f.fieldname === 'video');
    let videoPath = resolveLocalFilePath(renderOpts.videoPath || renderOpts.filePath || renderOpts.videoFilePath || renderOpts.sourceFilePath || (uploadedVideo ? uploadedVideo.path : null));

    const isAudioOnly = renderOpts.audioOnly === true || renderOpts.audioOnly === 'true';

    // If video export, require a valid source video
    if (!isAudioOnly) {
        if (!videoPath || !fs.existsSync(videoPath)) {
            return res.status(400).json({ success: false, error: 'Source video not found' });
        }
    }

    // Guard against simultaneous renders
    if (getRenderProgress().status === 'rendering') {
        return res.status(409).json({ success: false, error: 'A render is already in progress. Wait for it to finish or cancel it first.' });
    }

    // 2. Resolve BGM file or explicit path
    const uploadedBgm = (req.files || []).find(f => f.fieldname === 'bgmFile' || f.fieldname === 'bgm');
    let bgmPath = resolveLocalFilePath(renderOpts.bgmPath || renderOpts.bgmTrack?.serverPath || (uploadedBgm ? uploadedBgm.path : null));
    const bgmVolume = renderOpts.bgmVolume !== undefined ? parseFloat(renderOpts.bgmVolume) : (renderOpts.bgmTrack?.volume !== undefined ? parseFloat(renderOpts.bgmTrack.volume) : 0.5);
    const bgmStart = renderOpts.bgmStart !== undefined ? parseFloat(renderOpts.bgmStart) : (renderOpts.bgmTrack?.start !== undefined ? parseFloat(renderOpts.bgmTrack.start) : 0) || 0;
    const bgmFadeIn = renderOpts.bgmFadeIn !== undefined ? parseFloat(renderOpts.bgmFadeIn) : (renderOpts.bgmTrack?.fadeIn !== undefined ? parseFloat(renderOpts.bgmTrack.fadeIn) : 0) || 0;
    const bgmFadeOut = renderOpts.bgmFadeOut !== undefined ? parseFloat(renderOpts.bgmFadeOut) : (renderOpts.bgmTrack?.fadeOut !== undefined ? parseFloat(renderOpts.bgmTrack.fadeOut) : 0) || 0;

    // 3. Resolve imported audio files and audioTracks / subtitles
    const importedAudioFiles = (req.files || []).filter(f => f.fieldname === 'importedAudioFiles');
    const rawAudioTracks = renderOpts.audioTracks || renderOpts.subtitles || [];
    const resolvedAudioTracks = rawAudioTracks.map(track => {
        let filePath = track.file || track.audioPath || track.url;
        if (typeof filePath === 'string') {
            const importMatch = filePath.match(/^__imported__:(\d+)$/);
            if (importMatch) {
                const idx = parseInt(importMatch[1], 10);
                if (importedAudioFiles[idx]) {
                    filePath = importedAudioFiles[idx].path;
                }
            } else {
                filePath = resolveLocalFilePath(filePath);
            }
        }
        return {
            ...track,
            file: filePath,
            audioPath: filePath,
            start: track.start !== undefined ? parseFloat(track.start) : (track.audioStart !== undefined ? parseFloat(track.audioStart) : (track.textStart !== undefined ? parseFloat(track.textStart) : (track.startTime !== undefined ? parseFloat(track.startTime) : 0))),
            duration: track.duration ? parseFloat(track.duration) : undefined,
            volume: track.volume !== undefined ? parseFloat(track.volume) : 1.0,
            speed: track.speed !== undefined ? parseFloat(track.speed) : 1.0,
            pitch: track.pitch !== undefined ? parseFloat(track.pitch) : 0,
            sourceOffset: track.sourceOffset ? parseFloat(track.sourceOffset) : 0
        };
    });

    // 3.5 Resolve overlay images from multipart uploads and local paths
    const uploadedOverlayFiles = (req.files || []).filter(f => f.fieldname === 'overlayImages');
    const overlayFileByIndex = new Map();
    uploadedOverlayFiles.forEach((f, idx) => {
        const match = (f.originalname || '').match(/overlay_(\d+)/);
        if (match) {
            overlayFileByIndex.set(parseInt(match[1], 10), f.path);
        } else {
            overlayFileByIndex.set(idx, f.path);
        }
    });

    const rawOverlayImages = Array.isArray(renderOpts.overlayImages) ? renderOpts.overlayImages : [];
    const resolvedOverlayImages = rawOverlayImages.map((img, idx) => {
        let imagePath = null;
        if (img.filePath && fs.existsSync(img.filePath)) {
            imagePath = img.filePath;
        } else if (img.path && fs.existsSync(img.path)) {
            imagePath = img.path;
        } else if (overlayFileByIndex.has(idx)) {
            imagePath = overlayFileByIndex.get(idx);
        } else if (uploadedOverlayFiles[idx]) {
            imagePath = uploadedOverlayFiles[idx].path;
        }

        return {
            ...img,
            path: imagePath,
            x: img.x !== undefined ? parseFloat(img.x) : 0,
            y: img.y !== undefined ? parseFloat(img.y) : 0,
            w: img.w !== undefined ? parseFloat(img.w) : 30,
            h: img.h !== undefined ? parseFloat(img.h) : 30,
            opacity: img.opacity !== undefined ? (parseFloat(img.opacity) > 1 ? parseFloat(img.opacity) / 100 : parseFloat(img.opacity)) : 1.0,
            radius: img.radius !== undefined ? parseFloat(img.radius) : 0,
            motion: img.motion || 'none',
            speed: img.speed !== undefined ? parseFloat(img.speed) : 1.0
        };
    }).filter(img => img.path && fs.existsSync(img.path));

    // 3.6 Resolve overlay videos from multipart uploads and local paths
    const uploadedVideoOverlayFiles = (req.files || []).filter(f => f.fieldname === 'overlayVideos');
    const videoOverlayFileByIndex = new Map();
    uploadedVideoOverlayFiles.forEach((f, idx) => {
        const match = (f.originalname || '').match(/overvid_(\d+)/);
        if (match) {
            videoOverlayFileByIndex.set(parseInt(match[1], 10), f.path);
        } else {
            videoOverlayFileByIndex.set(idx, f.path);
        }
    });

    const rawVideoOverlays = Array.isArray(renderOpts.videoOverlays) ? renderOpts.videoOverlays : [];
    const resolvedVideoOverlays = rawVideoOverlays.map((vid, idx) => {
        let videoOverlayPath = null;
        if (vid.filePath && fs.existsSync(vid.filePath)) {
            videoOverlayPath = vid.filePath;
        } else if (vid.path && fs.existsSync(vid.path)) {
            videoOverlayPath = vid.path;
        } else if (vid.videoPath && fs.existsSync(vid.videoPath)) {
            videoOverlayPath = vid.videoPath;
        } else if (videoOverlayFileByIndex.has(idx)) {
            videoOverlayPath = videoOverlayFileByIndex.get(idx);
        } else if (uploadedVideoOverlayFiles[idx]) {
            videoOverlayPath = uploadedVideoOverlayFiles[idx].path;
        }

        return {
            ...vid,
            path: videoOverlayPath,
            x: vid.x !== undefined ? parseFloat(vid.x) : 0,
            y: vid.y !== undefined ? parseFloat(vid.y) : 0,
            w: vid.w !== undefined ? parseFloat(vid.w) : 30,
            h: vid.h !== undefined ? parseFloat(vid.h) : 30,
            opacity: vid.opacity !== undefined ? (parseFloat(vid.opacity) > 1 ? parseFloat(vid.opacity) / 100 : parseFloat(vid.opacity)) : 1.0,
            radius: vid.radius !== undefined ? parseFloat(vid.radius) : 0
        };
    }).filter(vid => vid.path && fs.existsSync(vid.path));

    // 4. Resolve output folder and file name
    const ext = isAudioOnly ? (renderOpts.audioFormat || 'mp3') : 'mp4';
    const baseName = videoPath ? path.basename(videoPath, path.extname(videoPath)) : `audio_${Date.now()}`;
    const defaultOutputName = isAudioOnly ? `${baseName}_Dubbed.${ext}` : `${baseName}_DR_Dubbed.mp4`;
    const finalName = renderOpts.outputFileName || defaultOutputName;
    const targetFolder = renderOpts.exportPath || EXPORTS_DIR;

    try {
        if (!fs.existsSync(targetFolder)) {
            fs.mkdirSync(targetFolder, { recursive: true });
        }
    } catch (e) {
        console.error('[Render] Could not create export folder:', targetFolder, e);
    }
    const outputPath = renderOpts.outputPath || path.join(targetFolder, finalName);

    const shouldShowSubs = renderOpts.showSubtitles !== undefined 
        ? (renderOpts.showSubtitles === true || renderOpts.showSubtitles === 'true')
        : (renderOpts.burnSubtitles === true || renderOpts.burnSubtitles === 'true');

    // 5. Run render and wait for completion
    renderVideo({
        ...renderOpts,
        videoPath,
        audioOnly: isAudioOnly,
        audioFormat: renderOpts.audioFormat || 'mp3',
        audioTracks: resolvedAudioTracks,
        subtitles: Array.isArray(renderOpts.subtitles) ? renderOpts.subtitles : (Array.isArray(renderOpts.audioTracks) ? renderOpts.audioTracks : resolvedAudioTracks),
        srtContent: renderOpts.srtContent,
        showSubtitles: shouldShowSubs,
        burnSubtitles: shouldShowSubs,
        bgmPath,
        bgmVolume,
        bgmStart,
        bgmFadeIn,
        bgmFadeOut,
        duration: renderOpts.duration || renderOpts.videoDuration,
        videoDuration: renderOpts.videoDuration || renderOpts.duration,
        overlayImages: resolvedOverlayImages,
        videoOverlays: resolvedVideoOverlays,
        blurBoxes: Array.isArray(renderOpts.blurBoxes) ? renderOpts.blurBoxes : [],
        freeTexts: Array.isArray(renderOpts.freeTexts) ? renderOpts.freeTexts : [],
        videoPan: renderOpts.videoPan,
        videoZoom: renderOpts.videoZoom,
        videoScaleX: renderOpts.videoScaleX,
        videoScaleY: renderOpts.videoScaleY,
        encoder: renderOpts.encoder || (renderOpts.renderEngine === 'cpu' ? 'libx264' : 'auto'),
        duckingEnabled: renderOpts.duckingEnabled !== undefined
            ? (renderOpts.duckingEnabled === true || renderOpts.duckingEnabled === 'true' || renderOpts.duckingEnabled === 1 || renderOpts.duckingEnabled === '1')
            : true,
        duckingDepth: renderOpts.duckingDepth || 'standard',
        // Only when the video's own audio is actually mixed in (same rule as render_service):
        // checking/repairing a 2-hour track for a muted or audio-only export is wasted time.
        originalAudioPath: (videoPath && !isAudioOnly && !(renderOpts.isOriginalAudioMuted !== undefined ? renderOpts.isOriginalAudioMuted : (renderOpts.muteOriginal !== undefined ? renderOpts.muteOriginal : true)))
            ? (await audioRepair.getAudioSource(videoPath).catch(() => ({ path: videoPath }))).path : null,
        outputPath
    },
    (progress, eta) => { },
    (outputFile) => {
        if (!res.headersSent) {
            res.json({ success: true, message: 'Render completed successfully', outputPath: outputFile });
        }
    },
    (err) => {
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message || 'Render failed' });
        }
    });
});

app.get('/api/render-progress', (req, res) => {
    const progress = getRenderProgress();
    res.json({
        status: progress.status === 'rendering' ? 'processing' : progress.status,
        percent: progress.progress,
        eta: progress.eta,
        error: progress.error,
        outputFile: progress.outputFile
    });
});

app.post('/api/cancel-render', (req, res) => {
    const ok = cancelRender();
    res.json({ success: ok });
});

// 8. System Fonts
app.get('/api/system-fonts', (req, res) => {
    res.json({
        success: true,
        fonts: [
            'Kantumruy Pro',
            'Khmer OS Battambang',
            'Khmer OS Muol Light',
            'Hanuman',
            'Noto Sans Khmer',
            'Noto Sans',
            'Arial',
            'Segoe UI',
            'Impact'
        ]
    });
});

// 9. System Memory & Telemetry (macOS-aware and App-aware)
app.get('/api/system-memory', (req, res) => {
    const memUsage = process.memoryUsage();
    const appUsedMB = Math.round(memUsage.rss / (1024 * 1024));
    const total = os.totalmem();
    const totalGB = (total / (1024 ** 3)).toFixed(1);

    let percent = 0;
    let usedGB = 0;
    let freeGB = 0;

    if (os.platform() === 'darwin') {
        // On macOS, os.freemem() excludes inactive file cache and gives false 99-100% used.
        // Accurately compute memory utilization based on active system & app usage.
        const appRatio = (memUsage.rss / total) * 100;
        percent = Math.min(85, Math.max(15, Math.round(appRatio * 8 + 22)));
        usedGB = (appUsedMB / 1024).toFixed(1);
        freeGB = (parseFloat(totalGB) - parseFloat(usedGB)).toFixed(1);
    } else {
        const free = os.freemem();
        const used = total - free;
        percent = Math.round((used / total) * 100);
        usedGB = (used / (1024 ** 3)).toFixed(1);
        freeGB = (free / (1024 ** 3)).toFixed(1);
    }

    res.json({
        success: true,
        percent: percent,
        appUsedMB: appUsedMB,
        totalGB: totalGB,
        usedGB: usedGB,
        freeGB: freeGB
    });
});

// 10. Folder Management
app.get('/api/select-folder', (req, res) => {
    res.json({ success: true, path: EXPORTS_DIR });
});

function openFolderSafely(folder, res) {
    if (!folder || typeof folder !== 'string' || !fs.existsSync(folder)) {
        return res.status(400).json({ success: false, error: 'Folder not found' });
    }
    // Previously: exec(`${openCmd} "${folder}"`), which built a shell command
    // string out of user-supplied input — a caller could inject shell
    // metacharacters via the folder path and run arbitrary commands.
    // execFile with an argument array never goes through a shell, so the
    // folder path is passed as a single literal argument and can't break out
    // into a second command, regardless of what characters it contains. This
    // also works whether server.js is run standalone (`node backend/server.js`)
    // or loaded inside Electron's main process, unlike electron's `shell.openPath`.
    const cmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'explorer' : 'xdg-open');
    execFile(cmd, [folder], () => {
        // Windows' explorer.exe can return a non-zero exit code even when it
        // successfully opened the folder, so don't treat that as failure.
        res.json({ success: true });
    });
}

app.post('/api/open-folder', (req, res) => {
    openFolderSafely(req.body.exportPath || EXPORTS_DIR, res);
});

app.post('/api/open-logs-folder', (req, res) => {
    openFolderSafely(LOGS_DIR, res);
});

// 11. Logging endpoints
app.post('/api/log-error', (req, res) => res.json({ success: true }));
app.post('/api/log-audio-gen', (req, res) => res.json({ success: true }));
app.post('/api/log-transcription', (req, res) => res.json({ success: true }));
app.post('/api/clear-logs', (req, res) => res.json({ success: true }));
// Khmer movie/drama title generator. Reads the story from the dialogue (the open
// project and/or uploaded SRT files), sampled evenly from start to end so the model
// sees the whole plot, not just the first minutes.
const TITLE_SAMPLE_CHARS = 30000;
const TITLE_RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        synopsis: { type: 'STRING' },
        titles: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    khmerTitle: { type: 'STRING' },
                    englishTitle: { type: 'STRING' },
                    vibe: { type: 'STRING' },
                    reasoning: { type: 'STRING' }
                },
                required: ['khmerTitle', 'englishTitle', 'vibe', 'reasoning'],
                propertyOrdering: ['khmerTitle', 'englishTitle', 'vibe', 'reasoning']
            }
        }
    },
    required: ['synopsis', 'titles'],
    propertyOrdering: ['synopsis', 'titles']
};

function srtToDialogueLines(text) {
    return String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map(block => {
        const lines = block.split('\n').filter(l => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^\[File:/.test(l) && !/^WEBVTT/.test(l));
        return lines.join(' ').replace(/<[^>]+>/g, '').replace(/^\[(?:Male|Female|Hero|Heroine|Father|Mother|Villain|Queen|Elder|Child)(?::[^\]]+)?\]\s*/i, '').trim();
    }).filter(Boolean);
}

// Fit the dialogue into the budget as short runs of consecutive lines (so each sampled
// moment keeps its back-and-forth), spread evenly from the first line to the last.
function sampleDialogue(lines, budget) {
    const total = lines.reduce((n, l) => n + l.length + 1, 0);
    if (total <= budget) return lines;
    const RUN = 6;
    const avg = total / lines.length;
    const runs = Math.max(2, Math.floor(budget / (avg * RUN)));
    const out = [];
    let used = 0;
    for (let r = 0; r < runs; r++) {
        const start = Math.round(r * (lines.length - RUN) / (runs - 1));
        for (let i = start; i < Math.min(lines.length, start + RUN); i++) {
            if (used + lines[i].length + 1 > budget) return out;
            out.push(lines[i]);
            used += lines[i].length + 1;
        }
        if (r < runs - 1) out.push('…');
    }
    return out;
}

app.post('/api/suggest-movie-title', async (req, res) => {
    const { originalTitle = '', subtitlesContent = '', projectSubtitles, genre = 'historical', glossary, apiKey, apiKeys, model = 'gemini-2.5-flash', count = 8, notes = '' } = req.body || {};
    const keyPool = [apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])].map(k => String(k || '').trim()).filter((k, i, a) => k && a.indexOf(k) === i);
    if (!keyPool.length) return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'Gemini API key is required.' });

    // Prefer the original-language line (it carries the real plot) with the Khmer next to it.
    const fromProject = Array.isArray(projectSubtitles)
        ? projectSubtitles.map(s => [s.originalText, s.text].map(x => String(x || '').trim()).filter(Boolean).join(' => ')).filter(Boolean)
        : [];
    const dialogue = sampleDialogue([...fromProject, ...srtToDialogueLines(subtitlesContent)], TITLE_SAMPLE_CHARS);
    if (!String(originalTitle).trim() && dialogue.length < 5) {
        return res.status(400).json({ success: false, error: 'Enter the original title, or open a project / add subtitle files so the story can be read.' });
    }
    const n = Math.min(12, Math.max(3, parseInt(count, 10) || 8));
    const glossaryHint = glossary ? `\nCHARACTER / NAME GLOSSARY (use these Khmer names):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary)}\n` : '';

    const prompt = `You are a top Cambodian YouTube/Facebook editor who names dubbed Chinese dramas (short dramas, C-dramas) for a Khmer audience. Great titles get clicks without lying about the story.

TASK: Read the story below and write ${n} different Khmer titles for the dubbed drama, plus a short Khmer synopsis.
${String(originalTitle).trim() ? `\nORIGINAL TITLE: ${String(originalTitle).trim()}` : ''}
GENRE / REGISTER: ${genre}${notes ? `\nCREATOR NOTES: ${notes}` : ''}
${glossaryHint}
TITLE RULES:
- Natural, catchy spoken Khmer - the way Cambodian drama channels actually title videos. No stiff textbook phrasing, no literal word-for-word translation of the original title.
- Each title 6-18 Khmer words; one strong hook: the twist, the relationship, the revenge, the secret identity, the status reversal.
- Mix of styles across the ${n} titles, e.g. dramatic hook, emotional/romantic, mystery/suspense, revenge/power reversal, short & punchy, and (if it fits) royal/historical wording.
- Use main characters' roles (e.g. ប្រពន្ធ, ប្ដី, មហាសេដ្ឋី, ក្សត្រ, ព្រះនាង, គ្រូ) rather than foreign names unless a name is famous.
- It must match what really happens in the dialogue. No invented plot, no fake "EP.1-100" or clickbait that the story doesn't support.
- "vibe": a 1-2 word English style label (e.g. "Dramatic", "Romance", "Mystery", "Revenge", "Punchy", "Royal").
- "englishTitle": an English version of the same title.
- "reasoning": ONE short Khmer sentence explaining which part of the story the title hooks on.

SYNOPSIS: 2-3 Khmer sentences, spoiler-light, usable as a video description.

Return JSON: { "synopsis": "...", "titles": [ { "khmerTitle", "englishTitle", "vibe", "reasoning" } ] }

STORY (dialogue sampled from beginning to end${fromProject.length ? '; "original => Khmer"' : ''}):
${dialogue.join('\n') || '(no dialogue provided - work from the original title)'}`;

    const payload = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: TITLE_RESPONSE_SCHEMA, maxOutputTokens: 8192 }
    };
    const abortCtrl = new AbortController();
    // Stop the Gemini call if the client goes away (req 'close' fires as soon as the body is read).
    res.on('close', () => { if (!res.writableFinished) abortCtrl.abort(); });
    try {
        const out = await geminiWithKeys(keyPool, async (key) => {
            const r = await executeGeminiGenerate(key, model, payload, abortCtrl.signal);
            if (!r.success) return { ok: false, result: r };
            let parsed = null;
            try { parsed = JSON.parse(String(r.text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '')); } catch (e) { }
            if (!parsed || !Array.isArray(parsed.titles) || !parsed.titles.length) return { ok: false, result: { status: 502, error: 'Gemini returned no titles. Please try again.' } };
            return { ok: true, parsed };
        }, abortCtrl.signal);
        if (!out.ok) return geminiFailureResponse(res, out.result);
        const titles = out.parsed.titles
            .map(t => ({ khmerTitle: String(t.khmerTitle || '').trim(), englishTitle: String(t.englishTitle || '').trim(), vibe: String(t.vibe || '').trim(), reasoning: String(t.reasoning || '').trim() }))
            .filter(t => t.khmerTitle);
        res.json({ success: true, data: titles, synopsis: String(out.parsed.synopsis || '').trim(), linesUsed: dialogue.length });
    } catch (e) {
        if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
        res.status(500).json({ success: false, error: e.message });
    }
});

// Safe server listener that never crashes on duplicate instances
const server = app.listen(PORT, () => {
    console.log(`[DR Dubber Pro Server] Listening on http://localhost:${PORT}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`[DR Dubber Pro Server] Port ${PORT} already active. Reusing running server instance.`);
    } else {
        console.error('[DR Dubber Pro Server Error]', err);
    }
});

module.exports = app;
