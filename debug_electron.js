const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');

const PORT = 3001;
const ROOT_DIR = __dirname;

try {
    require('./backend/server');
} catch (e) {}

let mainWindow;

app.whenReady().then(async () => {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(ROOT_DIR, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        console.log(`[PAGE CONSOLE L${line}] ${message}`);
    });

    mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
        console.error(`[PAGE LOAD FAILED] ${code}: ${desc}`);
    });

    mainWindow.loadURL(`http://localhost:${PORT}`);

    mainWindow.webContents.once('did-finish-load', async () => {
        console.log("Page finished loading! Testing button execution in renderer...");
        
        const testResult = await mainWindow.webContents.executeJavaScript(`
            (function() {
                try {
                    const btn = document.getElementById("btn-load-video");
                    const hasElectronAPI = !!window.electronAPI;
                    const hasOpenMulti = window.electronAPI && typeof window.electronAPI.openMultiFile === "function";
                    const hasClick = !!btn;
                    return {
                        hasBtn: hasClick,
                        hasElectronAPI,
                        hasOpenMulti,
                        title: document.title
                    };
                } catch(e) {
                    return { error: e.message, stack: e.stack };
                }
            })()
        `);
        console.log("Renderer Test Result:", testResult);
        
        setTimeout(() => {
            app.quit();
        }, 1500);
    });
});
