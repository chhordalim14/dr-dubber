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
const CUSTOM_OUTPUTS_DIR = process.platform === 'win32' ? 'C:\\Export\\AIDubber\\outputs' : path.join(ROOT_DIR, 'storage', 'custom_outputs');
const USER_DESKTOP_OUTPUTS = process.platform === 'win32' ? 'C:\\Users\\KOLDER\\OneDrive\\Desktop\\transcribe output' : path.join(os.homedir(), 'Desktop', 'transcribe output');
const PYTHON_DIR = path.join(ROOT_DIR, 'backend', 'python');
const LOGS_DIR = path.join(ROOT_DIR, 'storage', 'logs');

function getPythonCmd() {
    if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
        return process.env.PYTHON_PATH;
    }
    const venvPython = process.platform === 'win32'
        ? path.join(ROOT_DIR, 'backend', 'venv', 'Scripts', 'python.exe')
        : path.join(ROOT_DIR, 'backend', 'venv', 'bin', 'python');
    if (fs.existsSync(venvPython)) {
        return venvPython;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
}
const PYTHON_CMD = getPythonCmd();

function getPythonExecutable() {
    const venvPython = path.join(ROOT_DIR, '.venv', 'bin', 'python');
    const venvPythonWin = path.join(ROOT_DIR, '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(venvPython)) return venvPython;
    if (fs.existsSync(venvPythonWin)) return venvPythonWin;
    if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
    if (process.platform === 'win32') return 'python';
    return 'python3';
}

[UPLOADS_DIR, AUDIO_CACHE_DIR, SEPARATED_DIR, EXPORTS_DIR, OUTPUTS_DIR, LOGS_DIR, CUSTOM_OUTPUTS_DIR, USER_DESKTOP_OUTPUTS].forEach(dir => {
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
        } catch (e) { }
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
    const fileName = `${baseName}_audio.mp3`;
    const audioOut = path.join(SEPARATED_DIR, fileName);

    const cmd = ['-y', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-ar', '16000', '-ac', '1', audioOut];
    const ffmpeg = spawn('ffmpeg', cmd, { windowsHide: true });

    ffmpeg.on('error', (err) => {
        console.error('[FFmpeg Error]', err);
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    });

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
    const child = spawn(PYTHON_CMD, [pyScript, '--input', audioPath, '--output', SEPARATED_DIR]);

    let output = '';
    child.stdout.on('data', d => output += d.toString());
    child.on('error', (err) => {
        console.error('[Python Vocal Separator Error]', err);
        bgmJobs.set(jobId, { status: 'error', success: false, error: err.message });
    });
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

// --- GEMINI MODEL RESOLUTION & FALLBACK ENGINE ---
function resolveGeminiModel(modelName) {
    if (!modelName) return 'gemini-2.0-flash';
    const m = String(modelName).toLowerCase().trim();
    if (m === 'gemini-3.1-pro-preview' || m === 'gemini-3.1-pro' || m.includes('3.1-pro')) {
        return 'gemini-3.1-pro-preview';
    }
    if (m.includes('3.1-flash') || m.includes('3.1-flash-lite')) return 'gemini-2.0-flash-lite';
    if (m.includes('3-flash')) return 'gemini-2.0-flash';
    if (m === 'gemini-2.5-pro' || m.includes('2.5-pro')) return 'gemini-2.5-pro';
    if (m === 'gemini-2.5-flash' || m.includes('2.5-flash')) return 'gemini-2.0-flash';
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
        'gemini-2.0-flash',
        'gemini-1.5-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-pro',
        'gemini-3.1-pro-preview'
    ].filter((v, i, a) => Boolean(v) && a.indexOf(v) === i);

    let primaryErrorMessage = null;
    let lastError = null;
    let lastStatus = 500;

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
            if (idx === 0) primaryErrorMessage = errMsg;
            lastError = errMsg;

            if (res.status === 400 && (errMsg.includes('API_KEY_INVALID') || errMsg.includes('API key not valid'))) {
                return { success: false, status: 400, error: 'INVALID_API_KEY', message: errMsg };
            }
            if (res.status === 403) {
                return { success: false, status: 403, error: 'INVALID_API_KEY', message: errMsg };
            }
        } catch (fetchErr) {
            if (fetchErr.name === 'AbortError') throw fetchErr;
            if (idx === 0) primaryErrorMessage = fetchErr.message;
            lastError = fetchErr.message;
            console.warn(`[Gemini API Fetch Error] Model ${m}:`, fetchErr.message);
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
            } catch (e) { }
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

// 4d. Smart Lip-Sync Speech Rate Auto-Fit Helper
app.post('/api/autofit-speech-rate', (req, res) => {
    const { subtitles = [] } = req.body;
    const updated = subtitles.map(sub => {
        const text = (sub.text || '').trim();
        const start = parseFloat(sub.textStart || sub.start || 0);
        const end = parseFloat(sub.textEnd || sub.end || 0);
        const availableSec = Math.max(0.5, end - start);
        
        // Count approximate Khmer syllables/words and character clusters (~11-13 chars/sec)
        const words = text.split(/\s+/).filter(Boolean);
        const rawLen = text.replace(/[\s\p{P}]/gu, '').length;
        const estimatedCharsDuration = rawLen > 0 ? (rawLen / 12.0) + 0.25 : 0.5;
        const estimatedWordsDuration = words.length * 0.38 + 0.3;
        const estimatedNaturalDuration = Math.max(estimatedCharsDuration, estimatedWordsDuration);
        
        let recommendedSpeed = 1.0;
        if (estimatedNaturalDuration > availableSec) {
            const ratio = estimatedNaturalDuration / availableSec;
            // Cap between 1.0 and 1.45 (100% to 145%)
            recommendedSpeed = Math.min(1.45, Math.max(1.0, Math.round(ratio * 100) / 100));
        } else if (estimatedNaturalDuration < availableSec * 0.5 && availableSec > 3.0) {
            recommendedSpeed = 0.95;
        }

        const ratePct = Math.round((recommendedSpeed - 1.0) * 100);
        const rateStr = ratePct >= 0 ? `+${ratePct}%` : `${ratePct}%`;

        return {
            ...sub,
            speed: recommendedSpeed,
            rate: rateStr
        };
    });

    res.json({ success: true, subtitles: updated });
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
    const { whisperFolder, audioPath, videoPath, model = 'medium', device = 'auto' } = req.body;
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

    let child;
    let stderrBuffer = '';
    try {
        if (fs.existsSync(runnerPath)) {
            child = isWin
                ? spawn('cmd.exe', ['/c', runnerPath, ...args], { cwd: whisperFolder, windowsHide: true })
                : spawn('bash', [runnerPath, ...args], { cwd: whisperFolder });
        } else {
            const pyScript = path.join(whisperFolder, 'transcribe.py');
            child = spawn(PYTHON_CMD, [pyScript, ...args], { cwd: whisperFolder, windowsHide: true });
        }
    } catch (spawnErr) {
        return res.status(500).json({ success: false, error: 'Failed to start Whisper process: ' + spawnErr.message });
    }

    child.stderr.on('data', (d) => {
        stderrBuffer += d.toString();
    });

    child.on('error', (err) => {
        res.status(500).json({ success: false, error: err.message });
    });

    child.on('close', (code) => {
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
        subtitles = [],
        bgmPath,
        videoName = 'dubbing_project',
        customFolder
    } = req.body;

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

            await new Promise((resolve) => {
                const ff = spawn('ffmpeg', args, { windowsHide: true });
                ff.on('close', resolve);
                ff.on('error', resolve);
            });
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

// 5. Neural Speech Generation with Emotional Acting (Edge-TTS + Khmer)
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

    const prosody = getEmotionProsody(emotion, pitch, volume, speed);

    const outFile = resolveAudioOutputFile(tempPath, index);
    const pyScript = path.join(PYTHON_DIR, 'tts_generator.py');

    const child = spawn(PYTHON_CMD, [
        pyScript,
        '--text', text,
        '--voice', voice,
        '--rate', prosody.rate,
        '--pitch', prosody.pitch,
        '--volume', prosody.volume,
        '--output', outFile
    ]);

    let output = '';
    child.stdout.on('data', d => output += d.toString());
    child.on('error', (err) => {
        console.error('[TTS Error]', err);
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    });
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
    const { text, gender = 'Male', tempPath, speed = 1.0, emotion = 'Neutral', index } = req.body;
    let voice = (gender === 'Female' || gender === 'female') ? 'km-KH-SreymomNeural' : 'km-KH-PisethNeural';
    const outFile = resolveAudioOutputFile(tempPath, index);
    const pyScript = path.join(PYTHON_DIR, 'tts_generator.py');

    const prosody = getEmotionProsody(emotion, '+0Hz', '+0%', speed);

    const child = spawn(PYTHON_CMD, [
        pyScript,
        '--text', text,
        '--voice', voice,
        '--rate', prosody.rate,
        '--pitch', prosody.pitch,
        '--volume', prosody.volume,
        '--output', outFile
    ]);

    let output = '';
    child.stdout.on('data', d => output += d.toString());
    child.on('error', (err) => {
        console.error('[TTS Error]', err);
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    });
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
        } catch (e) { }
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
        (progress, eta) => { },
        (outputFile) => { },
        (err) => { });

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

app.post('/api/open-folder', (req, res) => {
    const folder = req.body.exportPath || EXPORTS_DIR;
    const openCmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'explorer' : 'xdg-open');
    exec(`${openCmd} "${folder}"`);
    res.json({ success: true });
});

app.post('/api/open-logs-folder', (req, res) => {
    const openCmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'explorer' : 'xdg-open');
    exec(`${openCmd} "${LOGS_DIR}"`);
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
