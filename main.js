const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');

// Fast startup, GPU video decoding & CPU/RAM optimization flags
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-accelerated-mjpeg-decode');
app.commandLine.appendSwitch('enable-features', 'VaapiVideoDecoder,CanvasOopRasterization');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

const PORT = 3001;

// Storage directories (safe for packaged app & dev)
const ROOT_DIR = __dirname;
const userDataDir = app.getPath('userData');
const STORAGE_BASE = app.isPackaged ? path.join(userDataDir, 'storage') : path.join(ROOT_DIR, 'storage');
process.env.APP_STORAGE_DIR = STORAGE_BASE;

const EXPORTS_DIR = path.join(STORAGE_BASE, 'exports');
const AUDIO_CACHE_DIR = path.join(STORAGE_BASE, 'audio_cache');

[EXPORTS_DIR, AUDIO_CACHE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }
});

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
            webSecurity: false,
            spellcheck: false,
            backgroundThrottling: true
        }
    });

    mainWindow.maximize();

    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[Renderer Log] ${message}`);
    });

    mainWindow.loadURL(`http://localhost:${PORT}`);

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
        try {
            require('./backend/server');
        } catch (e) {
            console.log('[Server Startup Note]', e.message);
        }

        let retries = 15;
        const checkReady = () => {
            http.get(`http://localhost:${PORT}`, (res) => {
                createWindow();
            }).on('error', () => {
                if (retries-- > 0) {
                    setTimeout(checkReady, 100);
                } else {
                    createWindow();
                }
            });
        };
        checkReady();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });
}

// IPC Handlers
ipcMain.handle('app:getBackendPort', () => PORT);

ipcMain.handle('app:checkPathExists', (event, targetPath) => {
    if (!targetPath) return { exists: true, path: AUDIO_CACHE_DIR };
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
ipcMain.handle('dialog:openFile', async (event, opts = {}) => {
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

ipcMain.handle('dialog:openMultiFile', async (event, opts = {}) => {
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

ipcMain.handle('dialog:selectFolder', async (event, opts = {}) => {
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

ipcMain.handle('app:saveSrt', async (event, { content, filePath, defaultPath }) => {
    try {
        let target = filePath;
        if (!target) {
            const res = await dialog.showSaveDialog({
                title: 'Save SRT Subtitles',
                defaultPath: defaultPath || path.join(EXPORTS_DIR, 'subtitles.srt'),
                filters: [{ name: 'Subtitle Files', extensions: ['srt'] }]
            });
            if (res.canceled) return { success: false };
            target = res.filePath;
        }
        fs.writeFileSync(target, content, 'utf8');
        return { success: true, filePath: target };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('app:saveTextFile', async (event, { content, filePath }) => {
    try {
        fs.writeFileSync(filePath, content, 'utf8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('app:autoSaveSrt', async (event, { content, fileName, mode, sourceFilePath, customFolderPath }) => {
    try {
        const cleanBase = (fileName || 'subtitles').replace(/[/\\?%*:|"<>]/g, '_');
        const srtFileName = cleanBase.endsWith('.srt') ? cleanBase : `${cleanBase}.srt`;

        let targetDir = customFolderPath;
        if (mode === 'source' && sourceFilePath) {
            targetDir = path.dirname(sourceFilePath);
        }
        if (!targetDir) targetDir = EXPORTS_DIR;
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        const targetFile = path.join(targetDir, srtFileName);
        fs.writeFileSync(targetFile, content, 'utf8');

        // Also save to Desktop / OneDrive "transcribe output" folder
        const desktopOut = path.join(os.homedir(), 'Desktop', 'transcribe output');
        const oneDriveDesktop = path.join(os.homedir(), 'OneDrive', 'Desktop', 'transcribe output');
        [desktopOut, oneDriveDesktop, 'C:\\Export\\AIDubber\\outputs'].forEach(dir => {
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, srtFileName), content, 'utf8');
            } catch (e) {}
        });

        return { success: true, filePath: targetFile };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('app:readFileAsBase64', async (event, filePath) => {
    try {
        const data = fs.readFileSync(filePath);
        return data.toString('base64');
    } catch (e) {
        return null;
    }
});

ipcMain.handle('app:readFileAsText', async (event, filePath) => {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        return null;
    }
});

// Real GPU name (previously hardcoded to "Intel(R) UHD Graphics 730" for every user/machine).
function detectGpuName() {
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
            resolve(name || 'Unknown GPU');
        });
    });
}

// Real free/total space for the drive that hosts app storage (previously
// hardcoded to {freeGB:110, totalGB:500} regardless of the actual disk).
function getDriveSpaceInfo(targetPath) {
    return new Promise((resolve) => {
        if (process.platform === 'win32') {
            const letter = path.parse(targetPath).root.replace(/[\\/:]/g, '') || 'C';
            const cmd = `powershell -NoProfile -Command "Get-PSDrive -Name '${letter}' | Select-Object Free,Used | ConvertTo-Json"`;
            exec(cmd, { timeout: 5000 }, (err, stdout) => {
                if (err) return resolve(null);
                try {
                    const data = JSON.parse(stdout);
                    resolve({
                        freeGB: Math.round(data.Free / (1024 ** 3)),
                        totalGB: Math.round((data.Free + data.Used) / (1024 ** 3))
                    });
                } catch (e) { resolve(null); }
            });
        } else {
            exec(`df -k "${targetPath}"`, { timeout: 5000 }, (err, stdout) => {
                if (err) return resolve(null);
                try {
                    const lines = stdout.trim().split('\n');
                    const parts = lines[lines.length - 1].split(/\s+/);
                    const totalKB = parseInt(parts[1], 10);
                    const availKB = parseInt(parts[3], 10);
                    resolve({ freeGB: Math.round(availKB / (1024 * 1024)), totalGB: Math.round(totalKB / (1024 * 1024)) });
                } catch (e) { resolve(null); }
            });
        }
    });
}

async function getDirSizeBytes(dir) {
    let total = 0;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return 0; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        try {
            if (entry.isDirectory()) total += await getDirSizeBytes(full);
            else total += (await fs.promises.stat(full)).size;
        } catch (e) {}
    }
    return total;
}

async function clearDirContents(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir); } catch (e) { return; }
    for (const name of entries) {
        try { await fs.promises.rm(path.join(dir, name), { recursive: true, force: true }); } catch (e) {}
    }
}

// These caches genuinely grow without bound (TTS output cache, extracted/separated
// audio) since nothing else ever prunes them, so unlike the fake stubs before,
// size/clear here are real operations against real disk usage.
const CACHE_DIRS = [AUDIO_CACHE_DIR, path.join(STORAGE_BASE, 'separated'), path.join(STORAGE_BASE, 'uploads')];

ipcMain.handle('app:getHardwareSpecs', async () => {
    return {
        cpu: os.cpus()[0]?.model || 'Unknown CPU',
        cores: os.cpus().length,
        ramGB: Math.round(os.totalmem() / (1024 ** 3)),
        gpu: await detectGpuName()
    };
});

ipcMain.handle('app:getDriveSpace', async () => {
    return (await getDriveSpaceInfo(STORAGE_BASE)) || { freeGB: 0, totalGB: 0 };
});

ipcMain.handle('app:getCacheSize', async () => {
    let totalBytes = 0;
    for (const dir of CACHE_DIRS) totalBytes += await getDirSizeBytes(dir);
    return { sizeMB: Math.round(totalBytes / (1024 * 1024)), success: true };
});

ipcMain.handle('app:clearCache', async () => {
    for (const dir of CACHE_DIRS) await clearDirContents(dir);
    return { success: true, message: 'Cache cleared successfully' };
});

ipcMain.handle('app:openExternal', async (event, targetUrl) => {
    if (targetUrl) shell.openExternal(targetUrl);
    return true;
});

// preload.js exposes getDeviceFingerprint()/confirmQuit() but neither had a
// matching handler here, so every call rejected at runtime with
// "No handler registered for 'app:getDeviceFingerprint'" (etc).
const DEVICE_ID_FILE = path.join(userDataDir, 'device_id.txt');
ipcMain.handle('app:getDeviceFingerprint', async () => {
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

ipcMain.handle('app:confirmQuit', async () => {
    return { confirmed: true };
});

// Whisper Local Transcription Handlers
const activeWhisperJobs = new Map();

ipcMain.handle('whisper:checkFolder', async (event, folderPath) => {
    if (!folderPath || !fs.existsSync(folderPath)) {
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

ipcMain.handle('whisper:transcribe', async (event, { id, whisperFolder, audioPath, videoPath, model, device }) => {
    if (!whisperFolder || !fs.existsSync(whisperFolder)) {
        return { success: false, error: 'Whisper folder not found' };
    }
    const inputAudio = audioPath || videoPath;
    if (!inputAudio || !fs.existsSync(inputAudio)) {
        return { success: false, error: 'Input audio not found' };
    }

    const outSrt = path.join(AUDIO_CACHE_DIR, `whisper_${Date.now()}_${id || 'job'}.srt`);
    const isWin = process.platform === 'win32';
    const runnerFile = isWin ? 'run.bat' : 'run.sh';
    const runnerPath = path.join(whisperFolder, runnerFile);
    
    return new Promise((resolve) => {
        let child;
        let stderrBuffer = '';
        const args = ['--audio', inputAudio, '--output_srt', outSrt];
        if (model) args.push('--model', model);
        if (device) args.push('--device', device);

        try {
            // Force UTF-8 I/O: transcribe.py prints non-ASCII transcript text
            // (Khmer/Thai/Chinese/etc.) plus emoji log markers, and on Windows a
            // piped stdout otherwise falls back to the system codepage, which can
            // throw UnicodeEncodeError and crash mid-transcription.
            const pyEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
            if (fs.existsSync(runnerPath)) {
                if (isWin) {
                    child = spawn('cmd.exe', ['/c', runnerPath, ...args], { cwd: whisperFolder, windowsHide: true, env: pyEnv });
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

        child.stdout.on('data', (d) => {
            const str = d.toString();
            console.log('[Whisper]', str);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('whisper:log', str);
            }
        });

        child.stderr.on('data', (d) => {
            const str = d.toString();
            stderrBuffer += str;
            console.warn('[Whisper Stderr]', str);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('whisper:log', str);
            }
        });

        child.on('error', (err) => {
            if (id) activeWhisperJobs.delete(id);
            resolve({ success: false, error: err.message });
        });

        child.on('close', (code) => {
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

ipcMain.handle('whisper:cancel', async (event, id) => {
    if (id && activeWhisperJobs.has(id)) {
        const job = activeWhisperJobs.get(id);
        const child = job.child || job;
        const outSrt = job.outSrt;
        try {
            child.kill();
        } catch (e) {}
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
// "VoxCPM2" has no separate model/server of its own — backend's
// /api/generate-voxcmp2 route just re-runs the same Edge-TTS script as normal
// TTS. These handlers used to unconditionally report "running"/"ready" with
// no process ever spawned, so a broken Python env silently looked healthy.
// This at least performs a real readiness check against the engine that's
// actually used, instead of a hardcoded true.
function checkVoxTtsReady() {
    return new Promise((resolve) => {
        const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
        const child = spawn(pyCmd, ['-c', 'import edge_tts'], { windowsHide: true });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
    });
}

function sendVoxLog(text) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('voxcpm2:log', text);
    }
}

ipcMain.handle('voxcpm2:startServer', async () => {
    sendVoxLog('Checking Python TTS engine (edge-tts) availability...\n');
    const ready = await checkVoxTtsReady();
    // The renderer's log box listened for a 'voxcpm2:log' event that main.js
    // never sent, so it stayed empty forever with no indication anything was
    // wrong. There's no separate long-running server to stream output from
    // (see comment above), so this at least reports the real check's outcome.
    sendVoxLog(ready ? 'Ready.\n' : 'edge-tts is not available in the Python environment.\n');
    return ready
        ? { success: true, status: 'running', message: 'Ready' }
        : { success: false, status: 'stopped', message: 'Python TTS engine (edge-tts) not available' };
});

ipcMain.handle('voxcpm2:stopServer', async () => {
    return { success: true, status: 'stopped' };
});

ipcMain.handle('voxcpm2:serverStatus', async () => {
    const ready = await checkVoxTtsReady();
    return { running: ready, ready };
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

ipcMain.handle('preset:save', async (event, preset) => {
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
ipcMain.handle('preset:load', async () => {
    return loadPresetsFromDisk();
});
ipcMain.handle('preset:delete', async (event, id) => {
    try {
        const presets = loadPresetsFromDisk().filter(p => p.id !== id);
        savePresetsToDisk(presets);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Window controls
ipcMain.on('window:minimize', () => {
    if (mainWindow) mainWindow.minimize();
});
ipcMain.on('window:maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    }
});
ipcMain.on('window:close', () => {
    if (mainWindow) mainWindow.close();
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
                const child = job && job.child;
                if (child && !child.killed) {
                    try {
                        if (process.platform === 'win32') {
                            exec(`taskkill /pid ${child.pid} /T /F`, () => {});
                        } else {
                            child.kill('SIGKILL');
                        }
                    } catch (e) {}
                }
            }
            activeWhisperJobs.clear();
        }
    } catch (e) {}
}

app.on('before-quit', cleanupChildProcesses);
app.on('will-quit', cleanupChildProcesses);

app.on('window-all-closed', () => {
    cleanupChildProcesses();
    if (process.platform !== 'darwin') app.quit();
});
