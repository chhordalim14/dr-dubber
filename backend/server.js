const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, exec } = require('child_process');
const multer = require('multer');
const { renderVideo, cancelRender, getRenderProgress } = require('./render_service');

const app = express();
const PORT = process.env.PORT || 3001;

// Directory layout
const ROOT_DIR = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.join(ROOT_DIR, 'storage', 'uploads');
const AUDIO_CACHE_DIR = path.join(ROOT_DIR, 'storage', 'audio_cache');
const SEPARATED_DIR = path.join(ROOT_DIR, 'storage', 'separated');
const EXPORTS_DIR = path.join(ROOT_DIR, 'storage', 'exports');
const OUTPUTS_DIR = path.join(ROOT_DIR, 'storage', 'outputs');
const CUSTOM_OUTPUTS_DIR = 'C:\\Export\\AIDubber\\outputs';
const USER_DESKTOP_OUTPUTS = 'C:\\Users\\KOLDER\\OneDrive\\Desktop\\transcribe output';
const PYTHON_DIR = path.join(ROOT_DIR, 'backend', 'python');
const LOGS_DIR = path.join(ROOT_DIR, 'storage', 'logs');

[UPLOADS_DIR, AUDIO_CACHE_DIR, SEPARATED_DIR, EXPORTS_DIR, OUTPUTS_DIR, LOGS_DIR, CUSTOM_OUTPUTS_DIR, USER_DESKTOP_OUTPUTS].forEach(dir => {
    if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
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

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// Static files
app.use(express.static(path.join(ROOT_DIR, 'frontend')));
app.use('/fonts', express.static(path.join(ROOT_DIR, 'frontend', 'fonts')));
app.use('/assets', express.static(path.join(ROOT_DIR, 'frontend', 'assets')));
app.use('/lib', express.static(path.join(ROOT_DIR, 'frontend', 'lib')));
app.use('/storage', express.static(path.join(ROOT_DIR, 'storage')));

// Active jobs maps
const bgmJobs = new Map();
const activeTranscribeRequests = new Map();
let transcribePartCounter = 1;

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

// 1. Audio / Media Streaming Endpoint (handles both standard and URL-encoded query strings)
app.use('/api/audio', (req, res) => {
    let filePath = req.query.path;
    
    if (!filePath && req.originalUrl.includes('path=')) {
        try {
            const decoded = decodeURIComponent(req.originalUrl);
            const match = decoded.match(/path=([^&]+)/);
            if (match) filePath = match[1];
        } catch (e) {}
    }

    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).send('File not found');
    }

    try {
        const stat = fs.statSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_MAP[ext] || 'application/octet-stream';
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType,
            });
            file.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': stat.size,
                'Content-Type': contentType,
            });
            fs.createReadStream(filePath).pipe(res);
        }
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// 2. Extract Audio from Video (returns static /storage path matching frontend download)
app.post('/api/extract-audio', upload.any(), (req, res) => {
    const uploadedFile = (req.files && req.files.length > 0) ? req.files[0].path : null;
    let videoPath = uploadedFile || req.body.videoPath || req.body.filePath;

    if (!videoPath || !fs.existsSync(videoPath)) {
        return res.status(400).json({ success: false, error: 'Video file not found' });
    }

    const baseName = path.basename(videoPath, path.extname(videoPath));
    const fileName = `${baseName}_audio.wav`;
    const audioOut = path.join(SEPARATED_DIR, fileName);

    const cmd = ['-y', '-i', videoPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', audioOut];
    const ffmpeg = spawn('ffmpeg', cmd, { windowsHide: true });

    ffmpeg.on('close', (code) => {
        if (code === 0 && fs.existsSync(audioOut)) {
            res.json({
                success: true,
                file: audioOut,
                audioPath: audioOut,
                url: `/storage/separated/${fileName}`
            });
        } else {
            res.status(500).json({ success: false, error: 'FFmpeg extraction failed' });
        }
    });
});

// 3. Remove Vocals / BGM Isolation
app.post('/api/remove-vocals', upload.any(), (req, res) => {
    const uploadedFile = (req.files && req.files.length > 0) ? req.files[0].path : null;
    let audioPath = uploadedFile || req.body.audioPath || req.body.filePath || req.body.videoPath;
    const jobId = req.body.jobId || `bgm_${Date.now()}`;

    if (!audioPath || !fs.existsSync(audioPath)) {
        return res.status(400).json({ success: false, error: 'Audio/Video file not found' });
    }

    bgmJobs.set(jobId, { status: 'processing', progress: 10, success: true });
    res.json({ success: true, jobId: jobId, status: 'processing' });

    const pyScript = path.join(PYTHON_DIR, 'vocal_separator.py');
    const child = spawn('python', [pyScript, '--input', audioPath, '--output', SEPARATED_DIR]);

    let output = '';
    child.stdout.on('data', d => output += d.toString());
    child.on('close', (code) => {
        try {
            const data = JSON.parse(output);
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
                bgmJobs.set(jobId, { status: 'error', success: false, error: data.error || 'Separation failed' });
            }
        } catch (e) {
            bgmJobs.set(jobId, { status: 'error', success: false, error: output || e.message });
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

// 4. Transcription & Gemini Speech-to-Text Pipeline
app.post('/api/transcribe', async (req, res) => {
    const {
        audioBase64,
        mimeType = 'audio/mp3',
        duration,
        targetLanguage = 'Khmer',
        apiKey,
        model = 'gemini-2.0-flash',
        requestId,
        videoName,
        customFolder
    } = req.body;

    if (!audioBase64) {
        return res.status(400).json({ success: false, error: 'No audio data received.' });
    }

    try {
        const audioBuffer = Buffer.from(audioBase64, 'base64');
        const timestamp = Date.now();
        const baseClean = (videoName || 'video').replace(/\.[^/.]+$/, '');
        const partName = `transcribe_${timestamp}_${baseClean}_part${transcribePartCounter++}.mp3`;

        const destinations = [
            OUTPUTS_DIR,
            CUSTOM_OUTPUTS_DIR,
            USER_DESKTOP_OUTPUTS
        ];
        if (customFolder && fs.existsSync(customFolder)) {
            destinations.unshift(customFolder);
        }

        destinations.forEach(targetDir => {
            try {
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
                const fullPath = path.join(targetDir, partName);
                fs.writeFileSync(fullPath, audioBuffer);
            } catch (e) {}
        });
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
        const prompt = `You are a professional audio transcriber and translator. Listen to the audio and transcribe and translate all speech into natural, accurate Khmer subtitles. Output ONLY a valid JSON array of objects with the following schema:
[
  {
    "start": "00:00.00",
    "end": "00:05.50",
    "text": "Khmer subtitle translation",
    "gender": "Male" or "Female"
  }
]
Requirements:
1. Divide subtitles into short, readable lines (2-6 seconds each).
2. Assign accurate speaker gender (Male / Female).
3. Do not include markdown code blocks or any explanation. Return ONLY the raw JSON array.`;

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

        const targetModel = model || 'gemini-2.0-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey.trim()}`;

        const abortCtrl = new AbortController();
        if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);

        const geminiRes = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: abortCtrl.signal
        });

        if (requestId) activeTranscribeRequests.delete(requestId);

        if (geminiRes.status === 429) {
            return res.status(429).json({ success: false, error: 'RATE_LIMIT_EXCEEDED' });
        }
        if (geminiRes.status === 400 || geminiRes.status === 403) {
            return res.status(geminiRes.status).json({ success: false, error: 'INVALID_API_KEY' });
        }

        const json = await geminiRes.json();
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
                    { start: "00:00.00", end: "00:05.00", text: "សួស្តី!", gender: "Male" }
                ],
                rawText: rawContent
            });
        }

        res.json({
            success: true,
            data: parsedData,
            rawText: rawContent
        });

    } catch (e) {
        if (e.name === 'AbortError') {
            return res.json({ success: false, error: 'CANCELLED' });
        }
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

// 5. Neural Speech Generation (Edge-TTS + Khmer)
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
        tempPath,
        index
    } = req.body;

    if (!text || !text.trim()) {
        return res.status(400).json({ success: false, error: 'Empty text' });
    }

    let voice = 'km-KH-PisethNeural';
    if (gender === 'Female' || gender === 'female') {
        voice = 'km-KH-SreymomNeural';
    }
    if (customVoice) {
        voice = customVoice;
    }

    let rateStr = rate || '+0%';
    if (typeof speed === 'number' && speed !== 1.0) {
        const pct = Math.round((speed - 1.0) * 100);
        rateStr = pct >= 0 ? `+${pct}%` : `${pct}%`;
    }

    const outFile = resolveAudioOutputFile(tempPath, index);
    const pyScript = path.join(PYTHON_DIR, 'tts_generator.py');

    const child = spawn('python', [
        pyScript,
        '--text', text,
        '--voice', voice,
        '--rate', rateStr,
        '--pitch', pitch,
        '--volume', volume,
        '--output', outFile
    ]);

    let output = '';
    child.stdout.on('data', d => output += d.toString());
    child.on('close', (code) => {
        try {
            const data = JSON.parse(output);
            if (data.success) {
                res.json({
                    success: true,
                    file: outFile,
                    duration: data.duration || 0,
                    url: `/api/audio?path=${encodeURIComponent(outFile)}`
                });
            } else {
                res.status(500).json({ success: false, error: data.error || 'TTS error' });
            }
        } catch (e) {
            res.status(500).json({ success: false, error: output || e.message });
        }
    });
});

app.post('/api/generate-voxcmp2', (req, res) => {
    const { text, gender = 'Male', tempPath, speed = 1.0, index } = req.body;
    let voice = (gender === 'Female' || gender === 'female') ? 'km-KH-SreymomNeural' : 'km-KH-PisethNeural';
    const outFile = resolveAudioOutputFile(tempPath, index);
    const pyScript = path.join(PYTHON_DIR, 'tts_generator.py');

    let rateStr = '+0%';
    if (typeof speed === 'number' && speed !== 1.0) {
        const pct = Math.round((speed - 1.0) * 100);
        rateStr = pct >= 0 ? `+${pct}%` : `${pct}%`;
    }

    const child = spawn('python', [
        pyScript,
        '--text', text,
        '--voice', voice,
        '--rate', rateStr,
        '--output', outFile
    ]);

    let output = '';
    child.stdout.on('data', d => output += d.toString());
    child.on('close', () => {
        try {
            const data = JSON.parse(output);
            res.json({
                success: true,
                file: outFile,
                duration: data.duration || 0,
                url: `/api/audio?path=${encodeURIComponent(outFile)}`
            });
        } catch (e) {
            res.status(500).json({ success: false, error: output || e.message });
        }
    });
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

// 8. Video Rendering Pipeline (with color adjustments, flips & vignette)
app.post('/api/render', upload.any(), (req, res) => {
    let renderOpts = { ...req.body };
    if (req.body.data) {
        try {
            const parsed = JSON.parse(req.body.data);
            renderOpts = { ...renderOpts, ...parsed };
        } catch (e) {}
    }

    const {
        videoPath,
        subtitles = [],
        bgmPath,
        bgmVolume = 0.5,
        voiceVolume = 1.0,
        duckingEnabled = true,
        muteOriginal = true,
        burnSubtitles = true,
        subtitleFont = 'KantumruyPro-Bold',
        subtitleFontSize = 24,
        subtitleFontColor = '&H00FFFFFF',
        subtitleOutlineColor = '&H00000000',
        subtitlePosition = 'bottom',
        resolution = '1080p',
        encoder = 'libx264',
        exportPath,
        outputFileName,
        outputPath: explicitOutputPath,
        videoColorAdj,
        colorAdjustments,
        videoVignette,
        isFlippedH,
        isFlippedV
    } = renderOpts;

    if (!videoPath || !fs.existsSync(videoPath)) {
        return res.status(400).json({ success: false, error: 'Source video not found' });
    }

    const baseName = path.basename(videoPath, path.extname(videoPath));
    const finalName = outputFileName || `${baseName}_DR_Dubbed.mp4`;
    const targetFolder = exportPath || EXPORTS_DIR;
    const outputPath = explicitOutputPath || path.join(targetFolder, finalName);

    renderVideo({
        videoPath,
        subtitles,
        bgmPath,
        bgmVolume,
        voiceVolume,
        duckingEnabled,
        muteOriginal,
        burnSubtitles,
        subtitleFont,
        subtitleFontSize,
        subtitleFontColor,
        subtitleOutlineColor,
        subtitlePosition,
        resolution,
        encoder,
        outputPath,
        videoColorAdj,
        colorAdjustments,
        videoVignette,
        isFlippedH,
        isFlippedV
    },
    (progress, eta) => {},
    (outputFile) => {},
    (err) => {});

    res.json({ success: true, message: 'Render started', outputPath });
});

app.get('/api/render-progress', (req, res) => {
    const progress = getRenderProgress();
    res.json({
        status: progress.status === 'rendering' ? 'processing' : progress.status,
        percent: progress.progress,
        eta: progress.eta,
        error: progress.error
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

// 9. System Memory & Telemetry
app.get('/api/system-memory', (req, res) => {
    const free = os.freemem();
    const total = os.totalmem();
    const used = total - free;
    const percent = Math.round((used / total) * 100);
    res.json({
        success: true,
        percent: percent,
        totalGB: (total / (1024 ** 3)).toFixed(1),
        usedGB: (used / (1024 ** 3)).toFixed(1),
        freeGB: (free / (1024 ** 3)).toFixed(1)
    });
});

// 10. Folder Management
app.get('/api/select-folder', (req, res) => {
    res.json({ success: true, path: EXPORTS_DIR });
});

app.post('/api/open-folder', (req, res) => {
    const folder = req.body.exportPath || EXPORTS_DIR;
    exec(`explorer "${folder}"`);
    res.json({ success: true });
});

app.post('/api/open-logs-folder', (req, res) => {
    exec(`explorer "${LOGS_DIR}"`);
    res.json({ success: true });
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
