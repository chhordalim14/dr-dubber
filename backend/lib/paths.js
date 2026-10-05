// Storage-path layout and the local-file-path resolver shared by server.js
// and the route modules under backend/routes/. Extracted verbatim out of
// server.js so routes can depend on these without requiring the whole
// server.js monolith.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { isNetworkPath } = require('./security');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const STORAGE_BASE = process.env.APP_STORAGE_DIR || path.join(ROOT_DIR, 'storage');
const UPLOADS_DIR = path.join(STORAGE_BASE, 'uploads');
const AUDIO_CACHE_DIR = path.join(STORAGE_BASE, 'audio_cache');
const SEPARATED_DIR = path.join(STORAGE_BASE, 'separated');
const PREVIEW_DIR = path.join(STORAGE_BASE, 'preview_cache');
const AUDIO_REPAIR_DIR = path.join(STORAGE_BASE, 'audio_repair');
const EXPORTS_DIR = path.join(STORAGE_BASE, 'exports');
const OUTPUTS_DIR = path.join(STORAGE_BASE, 'outputs');
const CUSTOM_OUTPUTS_DIR = process.platform === 'win32' ? 'C:\\Export\\AIDubber\\outputs' : path.join(STORAGE_BASE, 'custom_outputs');
// The user's real Desktop. With OneDrive "Desktop backup" on, Windows moves the
// Desktop to %USERPROFILE%\OneDrive\Desktop; Electron's app.getPath('desktop')
// returns whichever one is actually in use. Under plain Node (standalone server,
// tests) fall back to the conventional location.
function resolveDesktopDir() {
    try {
        const electron = require('electron');
        if (electron && typeof electron === 'object' && electron.app && typeof electron.app.getPath === 'function') {
            return electron.app.getPath('desktop');
        }
    } catch (e) { /* not running inside Electron */ }
    return path.join(os.homedir(), 'Desktop');
}
const USER_DESKTOP_OUTPUTS = path.join(resolveDesktopDir(), 'transcribe output');
const PYTHON_DIR = path.join(ROOT_DIR, 'backend', 'python');
const LOGS_DIR = path.join(STORAGE_BASE, 'logs');

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
    // Network shares (\\host\share) are never opened: on Windows even checking
    // one sends the user's credentials to that host.
    if (isNetworkPath(p)) return null;

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
            if (isNetworkPath(decoded)) return null;
            if (fs.existsSync(decoded)) return decoded;
            p = decoded;
        } catch (e) {}
    }

    // 6. Windows drive letter cleanup: /D:/... -> D:/...
    if (process.platform === 'win32') {
        p = p.replace(/^\/([a-zA-Z]:)/, '$1');
    }

    if (isNetworkPath(p)) return null;

    // 7. Final check
    try {
        if (fs.existsSync(p)) return p;
    } catch (e) {}

    return p;
}

module.exports = {
    ROOT_DIR,
    STORAGE_BASE,
    UPLOADS_DIR,
    AUDIO_CACHE_DIR,
    SEPARATED_DIR,
    PREVIEW_DIR,
    AUDIO_REPAIR_DIR,
    EXPORTS_DIR,
    OUTPUTS_DIR,
    CUSTOM_OUTPUTS_DIR,
    USER_DESKTOP_OUTPUTS,
    PYTHON_DIR,
    LOGS_DIR,
    MIME_MAP,
    resolveLocalFilePath
};
