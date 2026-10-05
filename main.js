const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec, execFile } = require('child_process');

// Prefer IPv4 for all Node-side network calls (Gemini, TTS tunnels, updates).
// Node 18 (Electron <=28) fetch() connected to the first DNS answer only
// (no Happy Eyeballs). On networks with broken IPv6, Google's AAAA records come
// first and every request dies with "fetch failed / ENETUNREACH".
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) {}

// Auto-detect and add FFmpeg to PATH across the entire app
try { require('./backend/ffmpeg_env'); } catch (e) {}

// Fast startup, GPU video decoding & CPU/RAM optimization flags
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-accelerated-mjpeg-decode');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,CanvasOopRasterization');

const PORT = 3001;
const APP_ORIGIN = `http://localhost:${PORT}`;

// Per-launch secret for the local backend. It only lives in this process and
// in an HttpOnly cookie of the app's own session, so other programs and web
// pages can't call the API (see backend/lib/security.js).
const security = require('./backend/lib/security');
const API_TOKEN = crypto.randomBytes(32).toString('hex');
security.setApiToken(API_TOKEN);

// Storage directories (safe for packaged app & dev)
const ROOT_DIR = __dirname;
const userDataDir = app.getPath('userData');
const STORAGE_BASE = app.isPackaged ? path.join(userDataDir, 'storage') : path.join(ROOT_DIR, 'storage');
process.env.APP_STORAGE_DIR = STORAGE_BASE;

const EXPORTS_DIR = path.join(STORAGE_BASE, 'exports');
const AUDIO_CACHE_DIR = path.join(STORAGE_BASE, 'audio_cache');
const LOGS_DIR = path.join(STORAGE_BASE, 'logs');

[EXPORTS_DIR, AUDIO_CACHE_DIR, LOGS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
});

// Previously there was no process-level safety net at all: any uncaught
// exception or unhandled promise rejection anywhere in the main process
// (main.js, or backend/server.js since it's require()'d into this same
// process) would either crash the entire app instantly with zero
// diagnostics, or - for unhandled rejections - just be silently ignored.
// Neither is acceptable for a production user who can't attach a debugger.
function logCrash(label, err) {
    try {
        const line = `[${new Date().toISOString()}] ${label}: ${err && err.stack ? err.stack : String(err)}\n`;
        fs.appendFileSync(path.join(LOGS_DIR, 'crash.log'), line, 'utf8');
    } catch (e) {}
}

process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception]', err);
    logCrash('uncaughtException', err);
    try {
        dialog.showErrorBox(
            'DR Dubber Pro — Unexpected Error',
            `Something went wrong and has been logged.\n\n${err && err.message ? err.message : err}\n\nThe app will keep running, but if you see this repeatedly, please report it along with the log at:\n${path.join(LOGS_DIR, 'crash.log')}`
        );
    } catch (e) {}
    // Intentionally not calling app.quit()/app.exit(): most uncaught
    // exceptions here happen inside an IPC handler or async callback and
    // leave the rest of the app (window, backend server) perfectly usable.
    // Forcibly killing the whole app over one bad handler is worse UX than
    // logging it and letting the user keep working.
});

process.on('unhandledRejection', (reason) => {
    console.error('[Unhandled Rejection]', reason);
    logCrash('unhandledRejection', reason);
});

// ── IPC + navigation security ─────────────────────────────────────────────
// The preload bridge can read/write files and start local programs, so only
// the app's own page (http://localhost:PORT) may use it. Anything else that
// ends up in a window (an external site after a stray navigation, an iframe)
// gets nothing.
function isTrustedSender(event) {
    const frame = event && event.senderFrame;
    if (!frame) return false;
    try { return new URL(frame.url).origin === APP_ORIGIN; } catch (e) { return false; }
}

function handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedSender(event)) throw new Error(`Blocked "${channel}" from an untrusted page`);
        return fn(event, ...args);
    });
}

function on(channel, fn) {
    ipcMain.on(channel, (event, ...args) => {
        if (isTrustedSender(event)) fn(event, ...args);
    });
}

function isAppUrl(url) {
    try { return new URL(url).origin === APP_ORIGIN; } catch (e) { return false; }
}

function isWebUrl(url) {
    try { return ['https:', 'http:'].includes(new URL(url).protocol); } catch (e) { return false; }
}

app.on('web-contents-created', (event, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    // Links to websites open in the user's browser; the app window itself never leaves the app.
    contents.setWindowOpenHandler(({ url }) => {
        if (isWebUrl(url) && !isAppUrl(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    const guardNavigation = (e, url) => {
        if (isAppUrl(url)) return;
        e.preventDefault();
        if (isWebUrl(url)) shell.openExternal(url);
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
});

// Paths a user has OK'd for running (Whisper folder, VoxCPM2 script). The page
// only stores a path string, so before the main process runs a program from a
// path it hasn't run before, the user confirms it in a native dialog that page
// scripts can't click through. Approvals are remembered in userData.
const APPROVED_EXEC_FILE = path.join(userDataDir, 'approved-programs.json');

function loadApprovedPrograms() {
    try {
        const list = JSON.parse(fs.readFileSync(APPROVED_EXEC_FILE, 'utf8'));
        return new Set(Array.isArray(list) ? list : []);
    } catch (e) {
        return new Set();
    }
}

function canonicalPath(p) {
    try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); }
}

const pendingApprovals = new Map();

// Async on purpose: the backend runs in this process, so a blocking dialog would
// stall every request. Parallel jobs for the same path share one prompt.
async function confirmProgramRun(targetPath, what) {
    if (security.isNetworkPath(targetPath)) return false;
    const shownPath = canonicalPath(targetPath);
    const key = normalizePathForCompare(shownPath);
    if (loadApprovedPrograms().has(key)) return true;
    if (pendingApprovals.has(key)) return pendingApprovals.get(key);
    const ask = (async () => {
        const opts = {
            type: 'warning',
            buttons: ['Cancel', 'Allow and run'],
            defaultId: 0,
            cancelId: 0,
            title: 'DR Dubber Pro',
            message: `Allow DR Dubber Pro to run ${what}?`,
            detail: `${shownPath}\n\nOnly allow this if you installed it yourself. You will only be asked once for this location.`
        };
        const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
        if (response !== 1) return false;
        const approved = loadApprovedPrograms();
        approved.add(key);
        try { fs.writeFileSync(APPROVED_EXEC_FILE, JSON.stringify([...approved], null, 2), 'utf8'); } catch (e) {}
        return true;
    })();
    pendingApprovals.set(key, ask);
    try { return await ask; } finally { pendingApprovals.delete(key); }
}

let mainWindow = null;

function createWindow() {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 1560,
        height: 960,
        minWidth: 1200,
        minHeight: 750,
        backgroundColor: '#0c0e14',
        icon: path.join(ROOT_DIR, 'assets', 'drdubberpro.png'),
        show: false,
        webPreferences: {
            preload: path.join(ROOT_DIR, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false,
            spellcheck: false,
            backgroundThrottling: false
        }
    });

    mainWindow.maximize();

    mainWindow.webContents.on('console-message', (event) => {
        console.log(`[Renderer Log] ${event.message}`);
    });

    mainWindow.loadURL(APP_ORIGIN);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        // Only the app's own page gets permissions (clipboard etc.).
        session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
            callback(isAppUrl((details && details.requestingUrl) || wc.getURL()));
        });
        session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => requestingOrigin === APP_ORIGIN);

        try {
            const server = require('./backend/server');
            await server.locals.ready;
        } catch (e) {
            // If the port is taken, whatever answers on it is not our backend, and
            // loading its page would hand it the preload bridge. Stop instead.
            const inUse = e && e.code === 'EADDRINUSE';
            dialog.showErrorBox(
                'DR Dubber Pro could not start',
                inUse
                    ? `Port ${PORT} is already in use by another program (possibly a copy of the DR Dubber Pro server started from a terminal).\n\nClose that program and open DR Dubber Pro again.`
                    : `The local engine failed to start:\n\n${e && e.message ? e.message : e}`
            );
            app.quit();
            return;
        }

        await session.defaultSession.cookies.set({
            url: APP_ORIGIN,
            name: security.TOKEN_COOKIE,
            value: API_TOKEN,
            httpOnly: true,
            sameSite: 'strict'
        });
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

// IPC Handlers
handle('app:getBackendPort', () => PORT);

// The renderer previously had its own hardcoded `CURRENT_APP_VERSION = "1.0.0"`
// string that never got updated when a new version was released, so the
// About panel and update check always compared against a stale version
// number regardless of what was actually built. app.getVersion() reads the
// real version from package.json, so this can never drift out of sync again.
handle('app:getVersion', () => app.getVersion());

handle('app:checkPathExists', (event, targetPath) => {
    if (!targetPath || typeof targetPath !== 'string' || security.isNetworkPath(targetPath)) return { exists: true, path: AUDIO_CACHE_DIR };
    try {
        if (!fs.existsSync(targetPath)) {
            fs.mkdirSync(targetPath, { recursive: true });
        }
        return { exists: true, path: targetPath };
    } catch (e) {
        return { exists: true, path: AUDIO_CACHE_DIR };
    }
});

// Always open top-level native file picker reliably
handle('dialog:openFile', async (event, opts = {}) => {
    try {
        const res = await dialog.showOpenDialog({
            title: opts.title || 'Open File',
            defaultPath: opts.defaultPath || undefined,
            properties: ['openFile'],
            filters: opts.filters && opts.filters.length > 0 ? opts.filters : [{ name: 'All Files', extensions: ['*'] }]
        });
        if (res.canceled || !res.filePaths || !res.filePaths[0]) {
            return { canceled: true, filePath: null, files: [] };
        }
        const filePath = res.filePaths[0];
        const fileName = path.basename(filePath);
        const fileUrl = `http://localhost:${PORT}/api/audio?path=${encodeURIComponent(filePath)}`;
        const dirPath = path.dirname(filePath);
        return {
            canceled: false,
            filePath,
            fileName,
            fileUrl,
            dirPath,
            files: [{ filePath, fileName, fileUrl }]
        };
    } catch (err) {
        console.error('dialog:openFile error:', err);
        return { canceled: true, filePath: null, files: [] };
    }
});

handle('dialog:openMultiFile', async (event, opts = {}) => {
    try {
        const res = await dialog.showOpenDialog({
            title: opts.title || 'Open Files',
            defaultPath: opts.defaultPath || undefined,
            properties: ['openFile', 'multiSelections'],
            filters: opts.filters && opts.filters.length > 0 ? opts.filters : [{ name: 'All Files', extensions: ['*'] }]
        });
        if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
            return { canceled: true, files: [] };
        }
        const files = res.filePaths.map(fp => ({
            filePath: fp,
            fileName: path.basename(fp),
            fileUrl: `http://localhost:${PORT}/api/audio?path=${encodeURIComponent(fp)}`
        }));
        const dirPath = path.dirname(res.filePaths[0]);
        return {
            canceled: false,
            files,
            dirPath,
            filePath: res.filePaths[0],
            fileName: path.basename(res.filePaths[0]),
            fileUrl: `http://localhost:${PORT}/api/audio?path=${encodeURIComponent(res.filePaths[0])}`
        };
    } catch (err) {
        console.error('dialog:openMultiFile error:', err);
        return { canceled: true, files: [] };
    }
});

handle('dialog:selectFolder', async (event, opts = {}) => {
    try {
        const res = await dialog.showOpenDialog({
            title: opts.title || 'Select Folder',
            defaultPath: opts.defaultPath || undefined,
            properties: ['openDirectory', 'createDirectory']
        });
        if (res.canceled || !res.filePaths || !res.filePaths[0]) {
            return { canceled: true, filePaths: [] };
        }
        return {
            canceled: false,
            path: res.filePaths[0],
            filePaths: res.filePaths
        };
    } catch (err) {
        console.error('dialog:selectFolder error:', err);
        return { canceled: true, filePaths: [] };
    }
});

handle('app:saveSrt', async (event, { content, filePath, defaultPath }) => {
    try {
        let target = (typeof filePath === 'string' && path.extname(filePath).toLowerCase() === '.srt' && !security.isNetworkPath(filePath)) ? filePath : null;
        if (!target) {
            const res = await dialog.showSaveDialog({
                title: 'Save SRT Subtitles',
                defaultPath: defaultPath || path.join(EXPORTS_DIR, 'subtitles.srt'),
                filters: [{ name: 'Subtitle Files', extensions: ['srt'] }]
            });
            if (res.canceled) return { success: false };
            target = res.filePath;
        }
        await fs.promises.writeFile(target, content, 'utf8');
        return { success: true, filePath: target };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Always asks where to save: the page proposes a file name, the user picks the place.
handle('app:saveTextFile', async (event, { content, defaultPath, title } = {}) => {
    try {
        const suggested = path.basename(String(defaultPath || 'export.txt')).replace(/[\\/:*?"<>|]/g, '_');
        const res = await dialog.showSaveDialog(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
            title: typeof title === 'string' && title ? title : 'Save Text File',
            defaultPath: path.join(app.getPath('desktop'), suggested.endsWith('.txt') ? suggested : `${suggested}.txt`),
            filters: [{ name: 'Text Files', extensions: ['txt'] }]
        });
        if (res.canceled || !res.filePath) return { success: false, canceled: true };
        await fs.promises.writeFile(res.filePath, String(content ?? ''), 'utf8');
        return { success: true, filePath: res.filePath };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

handle('app:autoSaveSrt', async (event, { content, fileName, mode, sourceFilePath, customFolderPath }) => {
    try {
        const cleanBase = (fileName || 'subtitles').replace(/[/\\?%*:|"<>]/g, '_');
        const srtFileName = cleanBase.endsWith('.srt') ? cleanBase : `${cleanBase}.srt`;

        let targetDir = security.isNetworkPath(customFolderPath) ? null : customFolderPath;
        if (mode === 'source' && sourceFilePath && !security.isNetworkPath(sourceFilePath)) {
            targetDir = path.dirname(sourceFilePath);
        }
        if (!targetDir) targetDir = EXPORTS_DIR;
        if (!fs.existsSync(targetDir)) await fs.promises.mkdir(targetDir, { recursive: true });

        const targetFile = path.join(targetDir, srtFileName);
        await fs.promises.writeFile(targetFile, content, 'utf8');

        // Also save to the Desktop "transcribe output" folder (best-effort, in background).
        // app.getPath('desktop') is the Desktop the user actually sees, including when
        // OneDrive has redirected it; guessing both Desktop and OneDrive\Desktop used to
        // create a stray OneDrive folder tree on machines without OneDrive.
        const desktopOut = path.join(app.getPath('desktop'), 'transcribe output');
        Promise.all([desktopOut, 'C:\\Export\\AIDubber\\outputs'].map(async (dir) => {
            try {
                if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
                await fs.promises.writeFile(path.join(dir, srtFileName), content, 'utf8');
            } catch (e) {}
        })).catch(() => {});

        return { success: true, filePath: targetFile };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

handle('app:readFileAsBase64', async (event, filePath) => {
    try {
        if (!filePath || typeof filePath !== 'string') {
            return { success: false, error: 'Invalid file path' };
        }
        if (!security.isAudioFile(filePath)) {
            return { success: false, error: 'Only audio files can be read' };
        }
        if (!fs.existsSync(filePath)) {
            return { success: false, error: `File does not exist: ${filePath}` };
        }
        const data = await fs.promises.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        let mime = 'audio/wav';
        if (ext === '.mp3') mime = 'audio/mpeg';
        else if (ext === '.wav') mime = 'audio/wav';
        else if (ext === '.ogg') mime = 'audio/ogg';
        else if (ext === '.flac') mime = 'audio/flac';
        else if (ext === '.m4a' || ext === '.aac') mime = 'audio/mp4';

        return {
            success: true,
            base64: data.toString('base64'),
            mime
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

handle('app:readFileAsText', async (event, filePath) => {
    try {
        if (typeof filePath !== 'string' || security.isNetworkPath(filePath) || !/\.(srt|vtt|ass|ssa|txt)$/i.test(filePath)) return null;
        return await fs.promises.readFile(filePath, 'utf8');
    } catch (e) {
        return null;
    }
});

// Real GPU name with lifetime cache
let _cachedGpuName = null;
function detectGpuName() {
    if (_cachedGpuName) return Promise.resolve(_cachedGpuName);
    return new Promise((resolve) => {
        let cmd;
        if (process.platform === 'win32') {
            cmd = 'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)"';
        } else if (process.platform === 'darwin') {
            cmd = "system_profiler SPDisplaysDataType | grep 'Chipset Model' | head -1 | sed 's/.*: //'";
        } else {
            cmd = "lspci | grep -i 'vga\\|3d controller' | head -1 | sed 's/^.*: //'";
        }
        exec(cmd, { timeout: 5000 }, (err, stdout) => {
            const name = (stdout || '').trim();
            _cachedGpuName = name || 'Unknown GPU';
            resolve(_cachedGpuName);
        });
    });
}

// Drive space info with 30s TTL cache to avoid spawning subshells on every check
let _driveSpaceCache = { data: null, timestamp: 0 };
function getDriveSpaceInfo(targetPath) {
    if (_driveSpaceCache.data && (Date.now() - _driveSpaceCache.timestamp < 30000)) {
        return Promise.resolve(_driveSpaceCache.data);
    }
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            const letter = path.parse(targetPath).root.replace(/[\\/:]/g, '') || 'C';
            const cmd = `powershell -NoProfile -Command "Get-PSDrive -Name '${letter}' | Select-Object Free,Used | ConvertTo-Json"`;
            exec(cmd, { timeout: 5000 }, (err, stdout) => {
                if (err) return resolve(_driveSpaceCache.data || null);
                try {
                    const data = JSON.parse(stdout);
                    const res = {
                        freeGB: Math.round(data.Free / (1024 ** 3)),
                        totalGB: Math.round((data.Free + data.Used) / (1024 ** 3))
                    };
                    _driveSpaceCache = { data: res, timestamp: Date.now() };
                    resolve(res);
                } catch (e) { resolve(_driveSpaceCache.data || null); }
            });
        } else {
            exec(`df -k "${targetPath}"`, { timeout: 5000 }, (err, stdout) => {
                if (err) return resolve(_driveSpaceCache.data || null);
                try {
                    const lines = stdout.trim().split('\n');
                    const parts = lines[lines.length - 1].split(/\s+/);
                    const totalKB = parseInt(parts[1], 10);
                    const availKB = parseInt(parts[3], 10);
                    const res = { freeGB: Math.round(availKB / (1024 * 1024)), totalGB: Math.round(totalKB / (1024 * 1024)) };
                    _driveSpaceCache = { data: res, timestamp: Date.now() };
                    resolve(res);
                } catch (e) { resolve(_driveSpaceCache.data || null); }
            });
        }
    });
}

async function getDirSizeBytes(dir, protectedPaths = new Set()) {
    let total = 0;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return 0; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (protectedPaths.has(normalizePathForCompare(full))) continue;
        try {
            if (entry.isDirectory()) total += await getDirSizeBytes(full, protectedPaths);
            else total += (await fs.promises.stat(full)).size;
        } catch (e) {}
    }
    return total;
}

function normalizePathForCompare(p) {
    try { return path.resolve(p).toLowerCase(); } catch (e) { return String(p).toLowerCase(); }
}

async function clearDirContents(dir, protectedPaths = new Set()) {
    let entries;
    try { entries = await fs.promises.readdir(dir); } catch (e) { return; }
    for (const name of entries) {
        const full = path.join(dir, name);
        if (protectedPaths.has(normalizePathForCompare(full))) continue;
        try { await fs.promises.rm(full, { recursive: true, force: true }); } catch (e) {}
    }
}

// These caches genuinely grow without bound (TTS output cache, extracted/separated
// audio) since nothing else ever prunes them, so unlike the fake stubs before,
// size/clear here are real operations against real disk usage.
const CACHE_DIRS = [AUDIO_CACHE_DIR, path.join(STORAGE_BASE, 'separated'), path.join(STORAGE_BASE, 'uploads'), path.join(STORAGE_BASE, 'preview_cache'), path.join(STORAGE_BASE, 'audio_repair')];

handle('app:getHardwareSpecs', async () => {
    return {
        cpu: os.cpus()[0]?.model || 'Unknown CPU',
        cores: os.cpus().length,
        ramGB: Math.round(os.totalmem() / (1024 ** 3)),
        gpu: await detectGpuName()
    };
});

handle('app:getDriveSpace', async () => {
    return (await getDriveSpaceInfo(STORAGE_BASE)) || { freeGB: 0, totalGB: 0 };
});

handle('app:getCacheSize', async (event, payload) => {
    const protectedPaths = new Set((payload?.protectedFiles || []).map(normalizePathForCompare));
    let totalBytes = 0;
    for (const dir of CACHE_DIRS) totalBytes += await getDirSizeBytes(dir, protectedPaths);
    return { sizeMB: Math.round(totalBytes / (1024 * 1024)), success: true };
});

handle('app:clearCache', async (event, payload) => {
    const protectedPaths = new Set((payload?.protectedFiles || []).map(normalizePathForCompare));
    for (const dir of CACHE_DIRS) await clearDirContents(dir, protectedPaths);
    return { success: true, message: 'Cache cleared successfully' };
});

// Web links open in the browser. A file:// URL is only used by the page to show
// an output folder, so it must be an existing local folder (never a file, which
// the OS would launch, and never a network share). Other schemes are refused.
handle('app:openExternal', async (event, targetUrl) => {
    if (typeof targetUrl !== 'string' || !targetUrl) return false;
    let url;
    try { url = new URL(targetUrl); } catch (e) { return false; }
    if (url.protocol === 'https:' || url.protocol === 'http:') {
        await shell.openExternal(url.href);
        return true;
    }
    if (url.protocol === 'file:' && !security.isNetworkPath(targetUrl)) {
        let dir = decodeURIComponent(url.pathname);
        if (process.platform === 'win32') dir = dir.replace(/^\/([a-zA-Z]:)/, '$1');
        try {
            if (fs.statSync(dir).isDirectory()) {
                await shell.openPath(dir);
                return true;
            }
        } catch (e) {}
    }
    return false;
});

// preload.js exposes getDeviceFingerprint()/confirmQuit() but neither had a
// matching handler here, so every call rejected at runtime with
// "No handler registered for 'app:getDeviceFingerprint'" (etc).
const DEVICE_ID_FILE = path.join(userDataDir, 'device_id.txt');
handle('app:getDeviceFingerprint', async () => {
    try {
        if (fs.existsSync(DEVICE_ID_FILE)) {
            const existing = fs.readFileSync(DEVICE_ID_FILE, 'utf8').trim();
            if (existing) return existing;
        }
        const id = crypto.randomUUID();
        fs.writeFileSync(DEVICE_ID_FILE, id, 'utf8');
        return id;
    } catch (e) {
        return null;
    }
});

handle('app:confirmQuit', async () => {
    return { confirmed: true };
});

// Whisper Local Transcription Handlers
const activeWhisperJobs = new Map();

// Kills the whole process tree for a spawned job. On Windows, jobs are launched via
// `cmd.exe /c run.bat`, so killing just the cmd.exe wrapper leaves the actual python/whisper
// process running in the background (orphaned, still burning CPU/GPU).
function killProcessTree(child) {
    if (!child || !child.pid) return;
    try {
        if (process.platform === 'win32') {
            execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], () => {});
        } else {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); }
        }
    } catch (e) {}
}

handle('whisper:checkFolder', async (event, folderPath) => {
    if (!folderPath || typeof folderPath !== 'string' || security.isNetworkPath(folderPath) || !fs.existsSync(folderPath)) {
        return { valid: false, missing: ['Folder does not exist'] };
    }
    const isWin = process.platform === 'win32';
    const runner = isWin ? 'run.bat' : 'run.sh';
    const script = 'transcribe.py';
    
    const missing = [];
    if (!fs.existsSync(path.join(folderPath, script))) missing.push(script);
    if (!fs.existsSync(path.join(folderPath, runner))) missing.push(runner);
    
    return {
        valid: missing.length === 0,
        missing
    };
});

handle('whisper:transcribe', async (event, { id, whisperFolder, audioPath, videoPath, model, device, language, beamSize }) => {
    if (!whisperFolder || typeof whisperFolder !== 'string' || security.isNetworkPath(whisperFolder) || !fs.existsSync(whisperFolder)) {
        return { success: false, error: 'Whisper folder not found' };
    }
    const inputAudio = audioPath || videoPath;
    if (!inputAudio || typeof inputAudio !== 'string' || security.isNetworkPath(inputAudio) || !fs.existsSync(inputAudio)) {
        return { success: false, error: 'Input audio not found' };
    }
    // Options are passed on a command line: allow plain names only.
    const SAFE_OPTION = /^[A-Za-z0-9._-]{1,40}$/;
    if ((model && !SAFE_OPTION.test(model)) || (device && !SAFE_OPTION.test(device)) || (language && !SAFE_OPTION.test(language))) {
        return { success: false, error: 'Invalid Whisper model, device or language' };
    }
    beamSize = beamSize ? Math.min(10, Math.max(1, parseInt(beamSize, 10) || 1)) : null;
    const jobTag = /^[A-Za-z0-9-]{1,64}$/.test(String(id || '')) ? id : 'job';

    const outSrt = path.join(AUDIO_CACHE_DIR, `whisper_${Date.now()}_${jobTag}.srt`);
    const isWin = process.platform === 'win32';
    const runnerFile = isWin ? 'run.bat' : 'run.sh';
    const runnerPath = path.join(whisperFolder, runnerFile);
    // cmd.exe re-parses its command line, so on Windows no argument may contain its special characters.
    if (isWin && [runnerPath, inputAudio, outSrt].some(a => /[&|<>^%!"]/.test(a))) {
        return { success: false, error: 'The Whisper folder or audio file path contains a character Windows cannot pass safely (& | < > ^ % ! "). Rename it and try again.' };
    }
    if (!(await confirmProgramRun(whisperFolder, 'the local Whisper installation in this folder'))) {
        return { success: false, error: 'Running Whisper from this folder was not allowed.' };
    }
    
    return new Promise((resolve) => {
        let child;
        let stderrBuffer = '';
        const args = ['--audio', inputAudio, '--output_srt', outSrt];
        if (model) args.push('--model', model);
        if (device) args.push('--device', device);
        if (language && String(language).toLowerCase() !== 'auto') args.push('--language', language);
        if (beamSize) args.push('--beam_size', String(beamSize));

        try {
            // Force UTF-8 I/O: transcribe.py prints non-ASCII transcript text
            // (Khmer/Thai/Chinese/etc.) plus emoji log markers, and on Windows a
            // piped stdout otherwise falls back to the system codepage, which can
            // throw UnicodeEncodeError and crash mid-transcription.
            const pyEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
            if (fs.existsSync(runnerPath)) {
                if (isWin) {
                    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', runnerPath, ...args], { cwd: whisperFolder, windowsHide: true, env: pyEnv });
                } else {
                    child = spawn('bash', [runnerPath, ...args], { cwd: whisperFolder, env: pyEnv });
                }
            } else {
                const pyScript = path.join(whisperFolder, 'transcribe.py');
                const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
                child = spawn(pyCmd, [pyScript, ...args], { cwd: whisperFolder, windowsHide: true, env: pyEnv });
            }
        } catch (spawnErr) {
            return resolve({ success: false, error: 'Failed to start Whisper process: ' + spawnErr.message });
        }

        if (id) activeWhisperJobs.set(id, { child, outSrt });

        // Whisper CLIs (tqdm-style) can emit many small chunks per second; forwarding each
        // one as its own IPC message forces a renderer re-render per chunk and visibly jank
        // the UI. Buffer and flush on an interval instead.
        let logBuffer = '';
        const flushLog = () => {
            if (!logBuffer) return;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('whisper:log', logBuffer);
            }
            logBuffer = '';
        };
        const flushTimer = setInterval(flushLog, 150);

        child.stdout.on('data', (d) => {
            const str = d.toString();
            console.log('[Whisper]', str);
            logBuffer += str;
        });

        child.stderr.on('data', (d) => {
            const str = d.toString();
            stderrBuffer += str;
            console.warn('[Whisper Stderr]', str);
            logBuffer += str;
        });

        child.on('error', (err) => {
            clearInterval(flushTimer);
            flushLog();
            if (id) activeWhisperJobs.delete(id);
            resolve({ success: false, error: err.message });
        });

        child.on('close', (code) => {
            clearInterval(flushTimer);
            flushLog();
            if (id) activeWhisperJobs.delete(id);
            if (fs.existsSync(outSrt)) {
                try {
                    const srtText = fs.readFileSync(outSrt, 'utf8');
                    if (srtText && srtText.trim().length > 0) {
                        return resolve({ success: true, srtText, srtPath: outSrt, partial: code !== 0 });
                    }
                } catch (e) {}
            }
            if (code === 0) {
                resolve({ success: true, srtText: '', srtPath: outSrt });
            } else {
                const cleanError = stderrBuffer.trim();
                resolve({
                    success: false,
                    error: cleanError ? cleanError.split('\n').pop() || `Whisper exited with code ${code}` : `Whisper exited with code ${code}`
                });
            }
        });
    });
});

handle('whisper:cancel', async (event, id) => {
    if (id && activeWhisperJobs.has(id)) {
        const job = activeWhisperJobs.get(id);
        const child = job.child || job;
        const outSrt = job.outSrt;
        killProcessTree(child);
        activeWhisperJobs.delete(id);

        let partialSrt = '';
        if (outSrt && fs.existsSync(outSrt)) {
            try {
                partialSrt = fs.readFileSync(outSrt, 'utf8');
            } catch (e) {}
        }
        return { success: true, cancelled: true, srtText: partialSrt, srtPath: outSrt };
    }
    return { success: false };
});

// VoxCPM2 Server handlers
let activeVoxServerJob = null;
let activeVoxServerPort = 8808;

handle('voxcpm2:startServer', async (event, opts = {}) => {
    let rawPath = (opts && typeof opts.pythonPath === 'string') ? opts.pythonPath.trim().replace(/^["']|["']$/g, '').trim() : '';

    if (activeVoxServerJob && activeVoxServerJob.child && !activeVoxServerJob.child.killed) {
        return { success: true, status: 'running', port: activeVoxServerPort, message: `Running on port ${activeVoxServerPort}` };
    }

    if (!rawPath) {
        return { success: false, error: 'No VoxCPM2 path specified. Please install VoxCPM2 locally and paste the folder path or app.py path in Settings -> VoxCPM2 AI.' };
    }

    let scriptPath = rawPath;
    let scriptDir = '';

    if (!fs.existsSync(scriptPath)) {
        return { success: false, error: `VoxCPM2 path not found at "${rawPath}". Please check the folder or file path in settings.` };
    }

    try {
        const stat = fs.statSync(scriptPath);
        if (stat.isDirectory()) {
            scriptDir = scriptPath;
            const candidates = ['app.py', 'main.py', 'server.py', 'run.py', 'webui.py'];
            let found = null;
            for (const c of candidates) {
                const target = path.join(scriptDir, c);
                if (fs.existsSync(target)) {
                    found = target;
                    break;
                }
            }
            if (found) {
                scriptPath = found;
            } else {
                return { success: false, error: `Could not find an entry script (e.g. app.py, main.py, server.py) inside folder "${rawPath}".` };
            }
        } else {
            scriptDir = path.dirname(scriptPath);
        }
    } catch (e) {
        return { success: false, error: `Error accessing VoxCPM2 path: ${e.message}` };
    }

    // Detect virtualenv or embedded Python if available, else system python
    const possiblePythons = [
        path.join(scriptDir, 'venv', 'Scripts', 'python.exe'),
        path.join(scriptDir, '.venv', 'Scripts', 'python.exe'),
        path.join(scriptDir, 'env', 'Scripts', 'python.exe'),
        path.join(scriptDir, 'venv', 'bin', 'python'),
        path.join(scriptDir, '.venv', 'bin', 'python'),
        path.join(scriptDir, 'env', 'bin', 'python'),
        path.join(scriptDir, 'python', 'python.exe'),
        path.join(scriptDir, 'python.exe')
    ];
    let pythonExe = process.platform === 'win32' ? 'python' : 'python3';
    for (const p of possiblePythons) {
        if (fs.existsSync(p)) {
            pythonExe = p;
            break;
        }
    }

    if (security.isNetworkPath(scriptPath) || !(await confirmProgramRun(scriptPath, 'this VoxCPM2 server script'))) {
        return { success: false, error: 'Running this VoxCPM2 script was not allowed.' };
    }

    const port = Number.isInteger(Number(opts.port)) && Number(opts.port) >= 1024 && Number(opts.port) <= 65535 ? Number(opts.port) : 8808;
    activeVoxServerPort = port;

    const env = Object.assign({}, process.env, {
        HF_HOME: path.join(scriptDir, 'cache'),
        MODELSCOPE_CACHE: path.join(scriptDir, 'cache'),
        PIP_CACHE_DIR: path.join(scriptDir, 'cache', 'pip'),
        PYTHONUNBUFFERED: '1'
    });

    try {
        const child = spawn(pythonExe, [scriptPath, '--port', String(port)], {
            cwd: scriptDir,
            env,
            windowsHide: true
        });

        activeVoxServerJob = { child, scriptPath, port };

        child.stdout.on('data', (d) => {
            const str = d.toString();
            console.log('[VoxCPM2]', str);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('voxcpm2:log', { type: 'stdout', text: str });
            }
        });

        child.stderr.on('data', (d) => {
            const str = d.toString();
            console.warn('[VoxCPM2 Stderr]', str);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('voxcpm2:log', { type: 'stderr', text: str });
            }
        });

        child.on('close', (code) => {
            console.log(`[VoxCPM2] Process exited with code ${code}`);
            activeVoxServerJob = null;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('voxcpm2:serverStopped', { code });
            }
        });

        child.on('error', (err) => {
            console.error('[VoxCPM2 Error]', err);
            activeVoxServerJob = null;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('voxcpm2:serverStopped', { error: err.message });
            }
        });

        return { success: true, status: 'running', port, message: `Server starting on port ${port}...` };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

handle('voxcpm2:stopServer', async () => {
    if (activeVoxServerJob && activeVoxServerJob.child) {
        killProcessTree(activeVoxServerJob.child);
        activeVoxServerJob = null;
        return { success: true, status: 'stopped' };
    }
    return { success: true, status: 'stopped' };
});

handle('voxcpm2:serverStatus', async () => {
    const isRunning = !!(activeVoxServerJob && activeVoxServerJob.child && !activeVoxServerJob.child.killed);
    return { running: isRunning, port: activeVoxServerPort, ready: isRunning };
});

on('voxcpm2:writeLog', (event, msg) => {
    // Renderer log mirror
});

// Presets
// Previously these three handlers didn't persist anything at all: save always
// "succeeded" without writing, load always returned [], delete always
// "succeeded" — any preset a user saved vanished immediately. Now backed by a
// real JSON file in userData.
const PRESETS_FILE = path.join(userDataDir, 'presets.json');

function loadPresetsFromDisk() {
    try {
        if (!fs.existsSync(PRESETS_FILE)) return [];
        const raw = fs.readFileSync(PRESETS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function savePresetsToDisk(presets) {
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf8');
}

handle('preset:save', async (event, preset) => {
    try {
        if (!preset || typeof preset !== 'object') {
            return { success: false, error: 'Invalid preset' };
        }
        const presets = loadPresetsFromDisk();
        const id = preset.id || crypto.randomUUID();
        const record = { ...preset, id, savedAt: Date.now() };
        const idx = presets.findIndex(p => p.id === id);
        if (idx >= 0) presets[idx] = record;
        else presets.push(record);
        savePresetsToDisk(presets);
        return { success: true, preset: record };
    } catch (e) {
        return { success: false, error: e.message };
    }
});
handle('preset:load', async () => {
    return loadPresetsFromDisk();
});
handle('preset:delete', async (event, id) => {
    try {
        const presets = loadPresetsFromDisk().filter(p => p.id !== id);
        savePresetsToDisk(presets);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Window controls
on('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
});
on('window:maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    }
});
on('window:close', () => {
    if (mainWindow) mainWindow.close();
});
// Taskbar progress (0..1 shows the bar, a negative value removes it), so a long batch
// can be followed from the taskbar while the app is minimised.
on('window:setProgress', (event, value) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(Number(value));
});

// Clean up any lingering background child processes on exit
function cleanupChildProcesses() {
    try {
        if (typeof activeWhisperJobs !== 'undefined') {
            for (const [id, job] of activeWhisperJobs.entries()) {
                // Map values here are { child, outSrt }, not the child process
                // itself. Treating `job` as the process meant proc.pid/proc.killed
                // were always undefined, so taskkill never actually targeted the
                // Whisper subprocess and it kept running (CPU/RAM/GPU) after quit.
                const child = job && (job.child || job);
                if (child && !child.killed) {
                    killProcessTree(child);
                }
            }
            activeWhisperJobs.clear();
        }
        if (activeVoxServerJob && activeVoxServerJob.child && !activeVoxServerJob.child.killed) {
            killProcessTree(activeVoxServerJob.child);
            activeVoxServerJob = null;
        }
    } catch (e) {}
}

app.on('before-quit', cleanupChildProcesses);
app.on('will-quit', cleanupChildProcesses);

app.on('window-all-closed', () => {
    cleanupChildProcesses();
    if (process.platform !== 'darwin') app.quit();
});
