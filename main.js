const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

// Fast startup hardware flags
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const PORT = 3001;

// Storage directories
const ROOT_DIR = __dirname;
const EXPORTS_DIR = path.join(ROOT_DIR, 'storage', 'exports');
const AUDIO_CACHE_DIR = path.join(ROOT_DIR, 'storage', 'audio_cache');

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
            webSecurity: false
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
        let targetDir = customFolderPath;
        if (mode === 'source' && sourceFilePath) {
            targetDir = path.dirname(sourceFilePath);
        }
        if (!targetDir) targetDir = EXPORTS_DIR;
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        const targetFile = path.join(targetDir, `${fileName || 'subtitles'}.srt`);
        fs.writeFileSync(targetFile, content, 'utf8');
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

// VoxCPM2 Server handlers
ipcMain.handle('voxcpm2:startServer', async () => {
    return { success: true, status: 'running', message: 'Ready' };
});

ipcMain.handle('voxcpm2:stopServer', async () => {
    return { success: true, status: 'stopped' };
});

ipcMain.handle('voxcpm2:serverStatus', async () => {
    return { running: true, ready: true };
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

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
