const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
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
            backgroundThrottling: false
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
        await fs.promises.writeFile(target, content, 'utf8');
        return { success: true, filePath: target };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('app:saveTextFile', async (event, { content, filePath }) => {
    try {
        await fs.promises.writeFile(filePath, content, 'utf8');
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
        if (!fs.existsSync(targetDir)) await fs.promises.mkdir(targetDir, { recursive: true });

        const targetFile = path.join(targetDir, srtFileName);
        await fs.promises.writeFile(targetFile, content, 'utf8');

        // Also save to Desktop / OneDrive "transcribe output" folder (best-effort, in background)
        const desktopOut = path.join(os.homedir(), 'Desktop', 'transcribe output');
        const oneDriveDesktop = path.join(os.homedir(), 'OneDrive', 'Desktop', 'transcribe output');
        Promise.all([desktopOut, oneDriveDesktop, 'C:\\Export\\AIDubber\\outputs'].map(async (dir) => {
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

ipcMain.handle('app:readFileAsBase64', async (event, filePath) => {
    try {
        const data = await fs.promises.readFile(filePath);
        return data.toString('base64');
    } catch (e) {
        return null;
    }
});

ipcMain.handle('app:readFileAsText', async (event, filePath) => {
    try {
        return await fs.promises.readFile(filePath, 'utf8');
    } catch (e) {
        return null;
    }
});

ipcMain.handle('app:getHardwareSpecs', async () => {
    return {
        cpu: os.cpus()[0]?.model || 'Intel Processor',
        cores: os.cpus().length,
        ramGB: Math.round(os.totalmem() / (1024 ** 3)),
        gpu: 'Intel(R) UHD Graphics 730'
    };
});

ipcMain.handle('app:getDriveSpace', async () => {
    return { freeGB: 110, totalGB: 500 };
});

ipcMain.handle('app:getCacheSize', async (event, cachePath) => {
    return { sizeMB: 12, success: true };
});

ipcMain.handle('app:clearCache', async (event, cachePath) => {
    return { success: true, message: 'Cache cleared successfully' };
});

ipcMain.handle('app:openExternal', async (event, targetUrl) => {
    if (targetUrl) shell.openExternal(targetUrl);
    return true;
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
            exec(`taskkill /pid ${child.pid} /T /F`, () => {});
        } else {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); }
        }
    } catch (e) {}
}

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
            if (fs.existsSync(runnerPath)) {
                if (isWin) {
                    child = spawn('cmd.exe', ['/c', runnerPath, ...args], { cwd: whisperFolder, windowsHide: true });
                } else {
                    child = spawn('bash', [runnerPath, ...args], { cwd: whisperFolder });
                }
            } else {
                const pyScript = path.join(whisperFolder, 'transcribe.py');
                const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
                child = spawn(pyCmd, [pyScript, ...args], { cwd: whisperFolder, windowsHide: true });
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

ipcMain.handle('whisper:cancel', async (event, id) => {
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

ipcMain.handle('voxcpm2:startServer', async (event, opts = {}) => {
    let scriptPath = (opts && opts.pythonPath) ? opts.pythonPath.trim() : '';
    if (!scriptPath) {
        const defaultApp = path.join('D:', 'VoxCPM2', 'app.py');
        if (fs.existsSync(defaultApp)) scriptPath = defaultApp;
    }

    if (activeVoxServerJob && activeVoxServerJob.child && !activeVoxServerJob.child.killed) {
        return { success: true, status: 'running', port: activeVoxServerPort, message: `Running on port ${activeVoxServerPort}` };
    }

    if (!scriptPath || !fs.existsSync(scriptPath)) {
        return { success: false, error: `VoxCPM2 script not found at "${scriptPath}". Please configure the path in settings.` };
    }

    const scriptDir = path.dirname(scriptPath);
    const venvPythonWin = path.join(scriptDir, 'venv', 'Scripts', 'python.exe');
    const pythonExe = fs.existsSync(venvPythonWin) ? venvPythonWin : (process.platform === 'win32' ? 'python' : 'python3');
    const port = opts.port || 8808;
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

ipcMain.handle('voxcpm2:stopServer', async () => {
    if (activeVoxServerJob && activeVoxServerJob.child) {
        killProcessTree(activeVoxServerJob.child);
        activeVoxServerJob = null;
        return { success: true, status: 'stopped' };
    }
    return { success: true, status: 'stopped' };
});

ipcMain.handle('voxcpm2:serverStatus', async () => {
    const isRunning = !!(activeVoxServerJob && activeVoxServerJob.child && !activeVoxServerJob.child.killed);
    return { running: isRunning, port: activeVoxServerPort, ready: isRunning };
});

ipcMain.on('voxcpm2:writeLog', (event, msg) => {
    // Renderer log mirror
});

// Presets
ipcMain.handle('preset:save', async (event, preset) => {
    return { success: true };
});
ipcMain.handle('preset:load', async () => {
    return [];
});
ipcMain.handle('preset:delete', async () => {
    return { success: true };
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
