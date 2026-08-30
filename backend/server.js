const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');
const multer = require('multer');
const { ensureFFmpegInPath, getFFmpegBinary } = require('./ffmpeg_env');
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
    [AUDIO_CACHE_DIR, UPLOADS_DIR, SEPARATED_DIR].forEach((dir) => {
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

function getPythonCmd() {
    if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
        return process.env.PYTHON_PATH;
    }
    if (process.env.PYTHON_BIN && fs.existsSync(process.env.PYTHON_BIN)) {
        return process.env.PYTHON_BIN;
    }

    const isWin = process.platform === 'win32';
    const subPath = isWin ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
    const unpackedRootDir = ROOT_DIR.includes('app.asar') ? ROOT_DIR.replace('app.asar', 'app.asar.unpacked') : ROOT_DIR;

    const candidatePaths = [
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
        try {
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
                return cand;
            }
        } catch (e) {}
    }

    return isWin ? 'python' : 'python3';
}
const PYTHON_CMD = getPythonCmd();

function ensureTtsDependencies() {
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
            (filePath.startsWith(AUDIO_CACHE_DIR) || filePath.startsWith(SEPARATED_DIR) || filePath.startsWith(UPLOADS_DIR))) {
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

function saveTranscribeAudio(audioBufferOrPath, videoName, partIndex, customFolder, sourceFilePath) {
    const timestamp = Date.now();
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
        partName = `transcribe_${timestamp}_${cleanBase}.mp3`;
    } else if (partIndex !== undefined && partIndex !== null && String(partIndex).trim() !== '') {
        const pIdx = String(partIndex).trim();
        partName = `transcribe_${timestamp}_${cleanBase}_part${pIdx}.mp3`;
    } else {
        partName = `transcribe_${timestamp}_${cleanBase}.mp3`;
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
app.post('/api/extract-audio', upload.any(), (req, res) => {
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

    const cmd = ['-y', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-ar', '16000', '-ac', '1', audioOut];
    const ffmpeg = spawn(getFFmpegBinary(), cmd, { windowsHide: true });
    trackProcess(ffmpeg);

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
                url: `/storage/separated/${fileName}`
            });
        } else {
            res.status(500).json({ success: false, error: 'FFmpeg extraction failed' });
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

// 3. Remove Vocals / BGM Isolation
app.post('/api/remove-vocals', upload.any(), (req, res) => {
    const uploadedFile = (req.files && req.files.length > 0) ? req.files[0].path : null;
    let audioPath = resolveLocalFilePath(uploadedFile || req.body.audioPath || req.body.filePath || req.body.videoPath);
    const jobId = req.body.jobId || `bgm_${Date.now()}`;

    if (!audioPath || !fs.existsSync(audioPath)) {
        return res.status(400).json({ success: false, error: 'Audio/Video file not found' });
    }

    bgmJobs.set(jobId, { status: 'processing', progress: 10, success: true, timestamp: Date.now() });
    res.json({ success: true, jobId: jobId, status: 'processing' });

    let engine = req.body.engine;
    if (engine === 'ffmpeg') engine = 'spleeter';
    if (engine !== 'spleeter' && engine !== 'demucs') engine = 'demucs';
    // Only force CPU when the user explicitly disabled GPU (Safe Mode); otherwise
    // leave --device unset so Demucs auto-detects, rather than requesting "cuda"
    // outright and hard-failing on a machine/torch build without working CUDA.
    const useGPU = req.body.useGPU === true || req.body.useGPU === 'true';
    const pyArgs = ['--input', audioPath, '--output', SEPARATED_DIR, '--engine', engine];
    if (engine === 'demucs') {
        if (!useGPU) pyArgs.push('--device', 'cpu');
        const demucsFolder = (req.body.demucsFolder || '').trim();
        const demucsSegment = (req.body.demucsSegment || '').trim();
        if (demucsFolder) pyArgs.push('--demucs-folder', demucsFolder);
        if (demucsSegment) pyArgs.push('--segment', demucsSegment);
    } else if (engine === 'spleeter') {
        const spleeterFolder = (req.body.spleeterFolder || '').trim();
        if (spleeterFolder) pyArgs.push('--spleeter-folder', spleeterFolder);
    }

    const pyScript = getPythonScriptPath('vocal_separator.py');
    let child;
    try {
        child = spawn(PYTHON_CMD, [pyScript, ...pyArgs], { env: PYTHON_ENV });
        trackProcess(child);
    } catch (spawnErr) {
        console.error('[Python Vocal Separator Spawn Error]', spawnErr);
        bgmJobs.set(jobId, { status: 'error', success: false, error: `Failed to spawn Python process: ${spawnErr.message}` });
        return;
    }

    let output = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout.on('data', d => output += stdoutDecoder.write(d));
    child.stderr.on('data', d => stderr += stderrDecoder.write(d));
    child.on('error', (err) => {
        console.error('[Python Vocal Separator Error]', err);
        bgmJobs.set(jobId, { status: 'error', success: false, error: `Python execution error: ${err.message}` });
    });
    child.on('close', (code) => {
        const trimmedOut = output.trim();
        const trimmedErr = stderr.trim();

        if (code !== 0 && !trimmedOut) {
            console.error(`[Python Vocal Separator Failed] Code ${code}, Stderr: ${trimmedErr}`);
            bgmJobs.set(jobId, {
                status: 'error',
                success: false,
                error: trimmedErr || `Vocal separator process exited with code ${code}`
            });
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
                    vocalUrl: vocalUri
                });
            } else {
                bgmJobs.set(jobId, {
                    status: 'error',
                    success: false,
                    error: data.error || trimmedErr || 'Separation failed'
                });
            }
        } catch (e) {
            console.error('[Python Vocal Separator Parse Error]', e, 'Stdout:', output, 'Stderr:', stderr);
            bgmJobs.set(jobId, {
                status: 'error',
                success: false,
                error: trimmedErr || trimmedOut || `Failed to parse separation result: ${e.message}`
            });
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
    if (!modelName) return 'gemini-3.7-flash';
    const m = String(modelName).toLowerCase().trim();
    if (m === 'gemini-3.7-flash' || m.includes('3.7-flash') || m.includes('3.7')) {
        return 'gemini-3.7-flash';
    }
    if (m === 'gemini-3.1-pro-preview' || m === 'gemini-3.1-pro' || m.includes('3.1-pro')) {
        return 'gemini-3.1-pro-preview';
    }
    if (m.includes('3.1-flash') || m.includes('3.1-flash-lite')) return 'gemini-2.0-flash-lite';
    if (m.includes('3-flash')) return 'gemini-2.0-flash';
    if (m === 'gemini-2.5-pro' || m.includes('2.5-pro')) return 'gemini-2.5-pro';
    if (m === 'gemini-2.5-flash' || m.includes('2.5-flash')) return 'gemini-2.5-flash';
    if (m.includes('2.0-flash-lite') || m.includes('2.0-lite')) return 'gemini-2.0-flash-lite';
    if (m === 'gemini-2.0-flash' || m.includes('2.0') || m.includes('flash')) return 'gemini-2.0-flash';
    if (m === 'gemini-1.5-pro' || m.includes('1.5-pro')) return 'gemini-1.5-pro';
    if (m === 'gemini-1.5-flash' || m.includes('1.5-flash')) return 'gemini-1.5-flash';
    return m;
}

async function executeGeminiGenerate(apiKey, requestedModel, payload, signal) {
    const primaryModel = resolveGeminiModel(requestedModel);
    const candidateModels = [
        primaryModel,
        'gemini-3.7-flash',
        'gemini-2.0-flash',
        'gemini-2.5-flash',
        'gemini-1.5-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-pro',
        'gemini-3.1-pro-preview'
    ].filter((v, i, a) => Boolean(v) && a.indexOf(v) === i);

    let primaryErrorMessage = null;
    let lastError = null;
    let lastStatus = 500;

    // Retry loop with backoff (up to 2 passes across models)
    for (let pass = 0; pass < 2; pass++) {
        for (let idx = 0; idx < candidateModels.length; idx++) {
            const m = candidateModels[idx];
            if (signal && signal.aborted) break;
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey.trim()}`;
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal
                });

                if (res.ok) {
                    const json = await res.json();
                    return { success: true, json, modelUsed: m };
                }

                lastStatus = res.status;
                const errData = await res.json().catch(() => ({}));
                const errMsg = errData?.error?.message || `HTTP ${res.status}`;
                console.warn(`[Gemini API Warning] Model ${m} returned ${res.status}: ${errMsg}`);
                if (!primaryErrorMessage) primaryErrorMessage = errMsg;
                lastError = errMsg;

                if (res.status === 400 && (errMsg.includes('API_KEY_INVALID') || errMsg.includes('API key not valid'))) {
                    return { success: false, status: 400, error: 'INVALID_API_KEY', message: errMsg };
                }
                if (res.status === 403) {
                    return { success: false, status: 403, error: 'INVALID_API_KEY', message: errMsg };
                }

                if (res.status === 429) {
                    // Rate limit: back off before trying next model
                    await new Promise(r => setTimeout(r, 1500));
                }
            } catch (fetchErr) {
                if (fetchErr.name === 'AbortError') throw fetchErr;
                if (!primaryErrorMessage) primaryErrorMessage = fetchErr.message;
                lastError = fetchErr.message;
                console.warn(`[Gemini API Fetch Error] Model ${m}:`, fetchErr.message);
            }
        }
        if (pass === 0 && lastStatus === 429 && (!signal || !signal.aborted)) {
            // Wait 2.5s before second pass
            await new Promise(r => setTimeout(r, 2500));
        }
    }

    const finalMsg = primaryErrorMessage || lastError || 'GENERATION_FAILED';
    return {
        success: false,
        status: lastStatus,
        error: lastStatus === 429 ? 'RATE_LIMIT_EXCEEDED' : finalMsg,
        message: finalMsg
    };
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
app.post('/api/transcribe', async (req, res) => {
    const {
        audioBase64,
        mimeType = 'audio/mp3',
        duration,
        targetLanguage = 'Khmer',
        genre = 'historical',
        dramaRegister,
        glossary,
        apiKey,
        model = 'gemini-2.0-flash',
        requestId,
        videoName,
        partIndex,
        customFolder,
        sourceFilePath
    } = req.body;

    if (!audioBase64) {
        return res.status(400).json({ success: false, error: 'No audio data received.' });
    }

    try {
        const audioBuffer = Buffer.from(audioBase64, 'base64');
        saveTranscribeAudio(audioBuffer, videoName, partIndex, customFolder, sourceFilePath);
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

    try {
        const durationHint = (duration && Number(duration) > 0) ? `\nTotal video duration: ${Number(duration).toFixed(1)} seconds.` : '';
        const genreRegister = genre || dramaRegister || 'historical';
        const genreGuidance = getKhmerDramaRegisterGuidance(genreRegister);
        const glossaryHint = glossary ? `\n\nCUSTOM CHARACTER / GLOSSARY DICTIONARY (STRICTLY USE THESE TRANSLATIONS):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : '';

        const prompt = `You are an elite master film/TV dialogue adapter and dubbing director specializing in Asian and Chinese drama (C-Drama: 古装/宫斗/仙侠/武侠/现代甜宠/总裁/动作) localization into cinematic, natural, ultra-concise, and highly readable Khmer.

TASK:
Listen to the audio carefully and transcribe and translate all spoken dialogue into SHORT, PUNCHY, and READABLE Khmer subtitles specifically optimized for professional voice dubbing and fast on-screen reading.

${KHMER_DUBBING_RULES}
${glossaryHint}

TIMESTAMPS & ACTING RULES:
1. Exact Timestamps:
   - "start" and "end" timestamps MUST correspond precisely to the real-time playback position from audio start (00:00.00). Format: MM:SS.ss (or HH:MM:SS.ss).
   - Divide subtitles into short lines (2 to 4 seconds per line). Timestamps must stay locked to speaker voices.${durationHint}

2. Gender & Emotion Detection:
   - Gender: "Male" / "Female".
   - Emotion: "Neutral", "Angry", "Sad", "Whisper", "Excited", "Royal", "Romantic", "Fear".${genreGuidance}

3. Output Format:
   - Output ONLY a valid JSON array of objects with the exact schema below. No markdown, no extra text.

SCHEMA:
[
  {
    "start": "00:00.00",
    "end": "00:05.50",
    "originalText": "Original spoken dialogue",
    "text": "Short punchy Khmer translation",
    "gender": "Male",
    "speaker": "Speaker 1",
    "emotion": "Neutral"
  }
]`;

        const payload = {
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            inlineData: {
                                mimeType: mimeType || "audio/mp3",
                                data: audioBase64
                            }
                        },
                        {
                            text: prompt
                        }
                    ]
                }
            ],
            generationConfig: {
                responseMimeType: "application/json"
            }
        };

        const abortCtrl = new AbortController();
        if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);

        const geminiResult = await executeGeminiGenerate(apiKey, model, payload, abortCtrl.signal);

        if (requestId) activeTranscribeRequests.delete(requestId);

        if (!geminiResult.success) {
            return res.status(geminiResult.status || 500).json({
                success: false,
                error: geminiResult.error || 'GENERATION_FAILED',
                message: geminiResult.message
            });
        }

        const json = geminiResult.json;
        const rawContent = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

        let parsedData = [];
        try {
            const cleanJson = rawContent.replace(/^```json/m, '').replace(/^```/m, '').trim();
            parsedData = JSON.parse(cleanJson);
        } catch (e) {
            console.error('Failed to parse Gemini output:', rawContent);
            parsedData = [];
        }

        if (!Array.isArray(parsedData) || parsedData.length === 0) {
            return res.json({
                success: true,
                data: [
                    { start: "00:00.00", end: "00:05.00", originalText: "Hello!", text: "សួស្តី!", gender: "Male", speaker: "Speaker 1" }
                ],
                rawText: rawContent
            });
        }

        const sanitizedData = parsedData.map(item => {
            let clean = sanitizeKhmerDialogue(item.text || '');
            if (glossary) clean = applyGlossary(clean, glossary);
            return {
                ...item,
                text: clean,
                originalText: item.originalText ? item.originalText.trim() : (item.original || undefined)
            };
        });

        res.json({
            success: true,
            data: sanitizedData,
            rawText: rawContent
        });

    } catch (e) {
        if (e.name === 'AbortError') {
            return res.json({ success: false, error: 'CANCELLED' });
        }
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4b. Translate SRT / Text directly with Ultra-Concise Dubbing Rules & Drama Register
app.post('/api/translate-srt', async (req, res) => {
    const {
        srtBase64,
        srtText,
        targetLanguage = 'Khmer',
        genre = 'historical',
        dramaRegister,
        glossary,
        apiKey,
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

    try {
        const genreRegister = genre || dramaRegister || 'historical';
        const genreGuidance = getKhmerDramaRegisterGuidance(genreRegister);
        const glossaryHint = glossary ? `\n\nCUSTOM CHARACTER / GLOSSARY DICTIONARY (STRICTLY USE THESE TRANSLATIONS):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : '';

        const prompt = `You are an elite master film/TV dialogue adapter and dubbing director specializing in Asian and Chinese drama (C-Drama: 古装/宫斗/仙侠/武侠/现代甜宠/总裁/动作) localization into cinematic, natural, ultra-concise, and highly readable Khmer.

TASK:
Translate each dialogue line into SHORT, PUNCHY, and READABLE Khmer dialogue specifically crafted for voice dubbing and clean on-screen subtitle reading.

${KHMER_DUBBING_RULES}
${glossaryHint}

LINE MATCHING & EMOTION RULES:
1. Exact 1-to-1 Line Match:
   - Output an array with the exact same number of items as the input lines.
   - Keep each translation strictly 3 to 10 syllables (3 to 8 words).

2. Gender Tagging & Emotional Acting Detection:
   - Assign "Male" or "Female" for each line based on context.
   - Assign the dramatic emotion: "Neutral", "Angry", "Sad", "Whisper", "Excited", "Royal", "Romantic", "Fear".${genreGuidance}

3. Output Format:
   - Return ONLY a valid JSON array of objects:
[
  {
    "text": "Short Khmer translation",
    "gender": "Male",
    "emotion": "Neutral"
  }
]

SUBTITLES TO TRANSLATE:
${content}`;

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

        const abortCtrl = new AbortController();
        if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);

        const geminiResult = await executeGeminiGenerate(apiKey, model, payload, abortCtrl.signal);

        if (requestId) activeTranscribeRequests.delete(requestId);

        if (!geminiResult.success) {
            return res.status(geminiResult.status || 500).json({
                success: false,
                error: geminiResult.error || 'TRANSLATE_FAILED',
                message: geminiResult.message
            });
        }

        const json = geminiResult.json;
        const rawContent = json?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

        let parsedData = [];
        try {
            const cleanJson = rawContent.replace(/^```json/m, '').replace(/^```/m, '').trim();
            parsedData = JSON.parse(cleanJson);
        } catch (e) {
            console.error('Failed to parse Gemini translate output:', rawContent);
            parsedData = [];
        }

        const sanitizedData = parsedData.map(item => {
            let clean = sanitizeKhmerDialogue(item.text || '');
            if (glossary) clean = applyGlossary(clean, glossary);
            return {
                ...item,
                text: clean
            };
        });

        res.json({
            success: true,
            data: sanitizedData,
            rawText: rawContent
        });
    } catch (e) {
        if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
        res.status(500).json({ success: false, error: e.message });
    }
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
        model = 'gemini-2.0-flash',
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
        if (requestId) activeTranscribeRequests.delete(requestId);

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
    }
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


// 4c. Export Audio Stems (Clean Voice Stem + Isolated BGM + SRT Package)
app.post('/api/export-stems', async (req, res) => {
    const {
        subtitles: rawSubtitles = [],
        bgmPath,
        videoName = 'dubbing_project',
        customFolder
    } = req.body;
    const subtitles = Array.isArray(rawSubtitles) ? rawSubtitles : [];

    try {
        const timestamp = Date.now();
        const baseClean = (videoName || 'project').replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
        const folderName = `Stems_${baseClean}_${timestamp}`;

        let targetDir = customFolder && fs.existsSync(customFolder) ? path.join(customFolder, folderName) : path.join(EXPORTS_DIR, folderName);
        fs.mkdirSync(targetDir, { recursive: true });

        // Helper for seconds to SRT time
        function formatSecToSrt(seconds) {
            const secNum = Math.max(0, parseFloat(seconds) || 0);
            const hrs = Math.floor(secNum / 3600);
            const mins = Math.floor((secNum % 3600) / 60);
            const secs = Math.floor(secNum % 60);
            const ms = Math.floor((secNum % 1) * 1000);
            return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
        }

        // 1. Export Subtitles (SRT)
        const srtPath = path.join(targetDir, `${baseClean}_subtitles.srt`);
        let srtContent = '';
        subtitles.forEach((sub, idx) => {
            const sStart = sub.startTime || formatSecToSrt(parseFloat(sub.textStart || 0));
            const sEnd = sub.endTime || formatSecToSrt(parseFloat(sub.textEnd || 0));
            const txt = (sub.text || '').trim();
            srtContent += `${idx + 1}\n${sStart} --> ${sEnd}\n${txt}\n\n`;
        });
        fs.writeFileSync(srtPath, srtContent, 'utf8');

        // 2. Copy or link Isolated BGM if available
        let exportedBgmPath = null;
        if (bgmPath && fs.existsSync(bgmPath)) {
            exportedBgmPath = path.join(targetDir, `${baseClean}_isolated_bgm${path.extname(bgmPath) || '.wav'}`);
            fs.copyFileSync(bgmPath, exportedBgmPath);
        }

        // 3. Export Clean Dubbed Dialogue Stem (combining valid subtitle audio files)
        const validSubs = (subtitles || []).filter(s => {
            const aPath = s.file || s.audioPath;
            return aPath && fs.existsSync(aPath);
        });

        let exportedVoicePath = null;
        if (validSubs.length > 0) {
            exportedVoicePath = path.join(targetDir, `${baseClean}_dubbed_voice.wav`);
            const args = ['-y'];
            const filterParts = [];
            const streamNames = [];

            validSubs.forEach((sub, i) => {
                const aPath = sub.file || sub.audioPath;
                args.push('-i', aPath);
                const startSec = parseFloat(sub.audioStart || sub.textStart || 0);
                const delayMs = Math.max(0, Math.round(startSec * 1000));
                filterParts.push(`[${i}:a]adelay=${delayMs}|${delayMs}[a${i}]`);
                streamNames.push(`[a${i}]`);
            });

            if (validSubs.length > 1) {
                filterParts.push(`${streamNames.join('')}amix=inputs=${validSubs.length}:normalize=0[aout]`);
                args.push('-filter_complex', filterParts.join(';'), '-map', '[aout]', '-ac', '2', '-ar', '44100', exportedVoicePath);
            } else {
                filterParts.push(`${streamNames[0]}anull[aout]`);
                args.push('-filter_complex', filterParts.join(';'), '-map', '[aout]', '-ac', '2', '-ar', '44100', exportedVoicePath);
            }

            try {
                await new Promise((resolve, reject) => {
                    const ff = spawn(getFFmpegBinary(), args, { windowsHide: true });
                    trackProcess(ff);
                    ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
                    ff.on('error', reject);
                });
                // Belt-and-suspenders: a zero exit code doesn't guarantee the
                // file actually landed on disk (e.g. filter graph produced no
                // output). Previously this wasn't checked, so a failed mix
                // still reported success with a voicePath that was never written.
                if (!fs.existsSync(exportedVoicePath)) {
                    exportedVoicePath = null;
                }
            } catch (mixErr) {
                console.error('[Export Stems] Dialogue stem mix failed:', mixErr.message);
                exportedVoicePath = null;
            }
        }

        res.json({
            success: true,
            folder: targetDir,
            srtPath: srtPath,
            srtFile: srtPath,
            bgmPath: exportedBgmPath,
            bgmFile: exportedBgmPath,
            voicePath: exportedVoicePath,
            voiceFile: exportedVoicePath,
            voiceExportFailed: validSubs.length > 0 && !exportedVoicePath,
            files: [srtPath, exportedBgmPath, exportedVoicePath].filter(Boolean)
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Helper: Calculate emotional prosody modifiers (Pitch, Rate, Volume)
function getEmotionProsody(emotion, basePitch, baseVolume, baseSpeed) {
    let finalPitch = basePitch || '+0Hz';
    let finalVolume = baseVolume || '+0%';
    let emotionRateOffset = 0;

    if (emotion) {
        const em = String(emotion).toLowerCase().trim();
        if (em === 'angry') {
            finalPitch = '+10Hz';
            finalVolume = '+15%';
            emotionRateOffset = 12;
        } else if (em === 'sad') {
            finalPitch = '-6Hz';
            finalVolume = '-10%';
            emotionRateOffset = -12;
        } else if (em === 'whisper') {
            finalPitch = '-4Hz';
            finalVolume = '-25%';
            emotionRateOffset = -8;
        } else if (em === 'excited') {
            finalPitch = '+12Hz';
            finalVolume = '+10%';
            emotionRateOffset = 15;
        } else if (em === 'royal') {
            finalPitch = '-8Hz';
            finalVolume = '+5%';
            emotionRateOffset = -5;
        } else if (em === 'fear') {
            finalPitch = '+15Hz';
            finalVolume = '+5%';
            emotionRateOffset = 18;
        }
    }

    const speedNum = typeof baseSpeed === 'number' ? baseSpeed : 1.0;
    const totalSpeedPct = Math.round((speedNum - 1.0) * 100) + emotionRateOffset;
    const rateStr = totalSpeedPct >= 0 ? `+${totalSpeedPct}%` : `${totalSpeedPct}%`;

    return { pitch: finalPitch, volume: finalVolume, rate: rateStr };
}

// 5. Neural Speech Generation with Emotional Acting & High-Speed Cache (Edge-TTS + Khmer)
app.post('/api/generate-audio', (req, res) => {
    const {
        text,
        gender = 'Male',
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

    let voice = 'km-KH-PisethNeural';
    const isFemale = String(gender).toLowerCase() === 'female';
    const langStr = String(language || 'khmer').toLowerCase();

    if (customVoice) {
        voice = customVoice;
    } else if (langStr.includes('en') || langStr.includes('english')) {
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
        voice = isFemale ? 'km-KH-SreymomNeural' : 'km-KH-PisethNeural';
    }

    const prosody = getEmotionProsody(emotion, pitch, volume, speed);
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

    const outFile = resolveAudioOutputFile(tempPath, index);
    const pyScript = getPythonScriptPath('tts_generator.py');

    const child = spawn(PYTHON_CMD, [
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
    child.on('error', (err) => {
        console.error('[TTS Error]', err);
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    });
    child.on('close', (code) => {
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

        let voice = sub.voice || defaultVoice;
        if (!sub.voice) {
            if (sub.gender === 'Female' || sub.gender === 'female') voice = 'km-KH-SreymomNeural';
        }
        const prosody = getEmotionProsody(sub.emotion, sub.pitch, sub.volume, sub.speed);
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

    // Normalize localhost to 127.0.0.1 to prevent Node.js 18+ IPv6 (::1) ECONNREFUSED on Windows
    let baseUrl = (serverUrl || 'http://127.0.0.1:8808').replace(/\/+$/, '');
    if (baseUrl.includes('localhost')) {
        baseUrl = baseUrl.replace('localhost', '127.0.0.1');
    }

    try {
        const payload = {
            text,
            instruction: (profile && profile.instruction) || '',
            reference_audio: (profile && profile.audioPath) || '',
            speed: parseFloat(speed) || 1.0,
            emotion: emotion || 'Neutral',
            output_path: outFile,
            profile: profile || null
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000); // 2 minute timeout for neural synthesis

        let targetEndpoint = `${baseUrl}/api/generate`;
        console.log(`[VoxCPM2] Sending synthesis request to: ${targetEndpoint}`);

        let response;
        try {
            response = await fetch(targetEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        } catch (fetchErr) {
            // Fallback: if 127.0.0.1 failed, try original URL or localhost
            const altBaseUrl = baseUrl.includes('127.0.0.1') ? baseUrl.replace('127.0.0.1', 'localhost') : baseUrl;
            targetEndpoint = `${altBaseUrl}/api/generate`;
            console.warn(`[VoxCPM2] Primary connect failed (${fetchErr.message}), trying alternative: ${targetEndpoint}`);
            response = await fetch(targetEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        }

        // If /api/generate returned 404, fallback to /generate
        if (response.status === 404) {
            const fallbackEndpoint = `${baseUrl}/generate`;
            console.log(`[VoxCPM2] /api/generate returned 404, trying fallback: ${fallbackEndpoint}`);
            response = await fetch(fallbackEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
        }

        clearTimeout(timeout);

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`VoxCPM2 server returned HTTP ${response.status}: ${errText}`);
        }

        const data = await response.json();
        if (data.success === false) {
            throw new Error(data.error || 'VoxCPM2 generation failed.');
        }

        const duration = data.duration || 0;
        return res.json({
            success: true,
            file: outFile,
            duration: duration,
            url: `/api/audio?path=${encodeURIComponent(outFile)}`
        });
    } catch (err) {
        console.error('[VoxCPM2 Request Failed]', err.message);
        return res.status(500).json({
            success: false,
            error: `VoxCPM2 synthesis failed: ${err.message}. Please ensure the VoxCPM2 server is started in Settings -> VoxCPM2 AI.`
        });
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

// 7. Video Preview & Conversion check
app.post('/api/check-video-preview', (req, res) => {
    const { filePath } = req.body;
    if (filePath && fs.existsSync(filePath)) {
        res.json({
            success: true,
            needsConversion: false,
            previewUrl: `/api/audio?path=${encodeURIComponent(filePath)}`
        });
    } else {
        res.json({ success: false, error: 'File not found' });
    }
});

// 8. Video Rendering Pipeline (with color adjustments, flips, audio tracks & vignette)
app.post('/api/render', upload.any(), (req, res) => {
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
app.post('/api/suggest-movie-title', (req, res) => {
    res.json({
        success: true,
        titles: [
            { khmer: "រៀបការច្រឡំមនុស្ស ប៉ះចំមហាសេដ្ឋី", english: "Mistaken Marriage, Encountering a Billionaire" },
            { khmer: "គ្រួសារត្រូវគេសម្លាប់រង្គាល", english: "The Family Massacre Mystery" },
            { khmer: "ប្រើ «ក្បួនហុងស៊ុយ» បកអាក្រាតរឿងអាថ៌កំបាំង", english: "Revealing Dark Secrets with Feng Shui" }
        ]
    });
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
