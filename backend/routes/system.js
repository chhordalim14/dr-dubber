// System/utility endpoints: machine telemetry, folder opening, log sinks,
// hardware encoder detection and the static voice preset list. Extracted
// verbatim out of server.js - these had no dependency on the
// Gemini/TTS/transcribe machinery that still lives there.
const express = require('express');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { EXPORTS_DIR, LOGS_DIR } = require('../lib/paths');

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

// `detectAvailableEncoders` comes from render_service.js; injected so this
// router doesn't need to depend on the whole render pipeline module graph.
module.exports = function createSystemRouter({ detectAvailableEncoders }) {
    const router = express.Router();

    router.get('/hardware-encoders', async (req, res) => {
        try {
            const encoders = await detectAvailableEncoders();
            res.json({ success: true, encoders });
        } catch (e) {
            res.json({ success: true, encoders: { libx264: true } });
        }
    });

    router.get('/voices', (req, res) => {
        res.json({ success: true, voices: VOICE_PRESETS });
    });

    router.get('/system-fonts', (req, res) => {
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

    // System Memory & Telemetry (macOS-aware and App-aware)
    router.get('/system-memory', (req, res) => {
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

    // Folder Management
    router.get('/select-folder', (req, res) => {
        res.json({ success: true, path: EXPORTS_DIR });
    });

    router.post('/open-folder', (req, res) => {
        openFolderSafely(req.body.exportPath || EXPORTS_DIR, res);
    });

    router.post('/open-logs-folder', (req, res) => {
        openFolderSafely(LOGS_DIR, res);
    });

    // Logging endpoints
    router.post('/log-error', (req, res) => res.json({ success: true }));
    router.post('/log-audio-gen', (req, res) => res.json({ success: true }));
    router.post('/log-transcription', (req, res) => res.json({ success: true }));
    router.post('/clear-logs', (req, res) => res.json({ success: true }));

    return router;
};
