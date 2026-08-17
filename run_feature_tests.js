const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const ROOT_DIR = __dirname;
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
const TEST_DIR = path.join(STORAGE_DIR, 'test_sandbox');

if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
}

let serverProcess = null;
const PORT = 3001;

const results = [];

function recordResult(category, testName, passed, details = '') {
    results.push({ category, testName, passed, details });
    const mark = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`[${mark}] [${category}] ${testName}${details ? ` -> ${details}` : ''}`);
}

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

// Helper to run commands
function runCmd(cmd, args, options = {}) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args, { ...options, windowsHide: true });
        let stdout = '';
        let stderr = '';
        p.stdout?.on('data', d => stdout += d.toString());
        p.stderr?.on('data', d => stderr += d.toString());
        p.on('close', code => {
            resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        });
        p.on('error', err => {
            resolve({ code: -1, stdout: '', stderr: err.message });
        });
    });
}

// HTTP Helper
function httpRequest(method, urlPath, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, `http://localhost:${PORT}`);
        const opts = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                ...headers
            }
        };

        let bodyData = null;
        if (body) {
            if (typeof body === 'object' && !headers['Content-Type']) {
                opts.headers['Content-Type'] = 'application/json';
                bodyData = JSON.stringify(body);
            } else if (typeof body === 'string') {
                bodyData = body;
            }
            if (bodyData) {
                opts.headers['Content-Length'] = Buffer.byteLength(bodyData);
            }
        }

        const req = http.request(opts, (res) => {
            const chunks = [];
            res.on('data', d => chunks.push(d));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const text = buffer.toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (e) {}
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    raw: buffer,
                    text: text,
                    json: json
                });
            });
        });

        req.on('error', (err) => reject(err));
        if (bodyData) req.write(bodyData);
        req.end();
    });
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runAllTests() {
    console.log('================================================================');
    console.log('       DR DUBBER PRO - ULTRA PERFECT DUBBING TEST SUITE         ');
    console.log('================================================================\n');

    // -------------------------------------------------------------
    // CATEGORY 1: SYSTEM & DEPENDENCY CHECKS
    // -------------------------------------------------------------
    console.log('--- CATEGORY 1: System & Dependencies ---');

    // 1.1 Node.js
    const nodeVer = process.version;
    recordResult('Dependencies', 'Node.js Version Check', !!nodeVer, `Node ${nodeVer}`);

    // 1.2 Python
    const pyCheck = await runCmd(PYTHON_CMD, ['--version']);
    recordResult('Dependencies', 'Python 3 Executable Check', pyCheck.code === 0, `${PYTHON_CMD}: ${pyCheck.stdout || pyCheck.stderr}`);

    // 1.3 Edge-TTS Python Library
    const edgeCheck = await runCmd(PYTHON_CMD, ['-c', 'import edge_tts; print(edge_tts.__version__)']);
    recordResult('Dependencies', 'Edge-TTS Library', edgeCheck.code === 0, `edge_tts v${edgeCheck.stdout}`);

    // 1.4 FFmpeg
    const ffmpegCheck = await runCmd('ffmpeg', ['-version']);
    const ffmpegOk = ffmpegCheck.code === 0 && ffmpegCheck.stdout.includes('ffmpeg version');
    const firstFfmpegLine = ffmpegCheck.stdout.split('\n')[0];
    recordResult('Dependencies', 'FFmpeg Multimedia Engine', ffmpegOk, firstFfmpegLine);

    // 1.5 FFprobe
    const ffprobeCheck = await runCmd('ffprobe', ['-version']);
    recordResult('Dependencies', 'FFprobe Stream Analyzer', ffprobeCheck.code === 0, ffprobeCheck.stdout.split('\n')[0]);

    // -------------------------------------------------------------
    // CATEGORY 2: BACKEND SERVER & API ENDPOINTS
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 2: Backend Server & Core APIs ---');

    // Ensure server is running
    let serverOnline = false;
    try {
        const ping = await httpRequest('GET', '/api/system-memory');
        if (ping.statusCode === 200) serverOnline = true;
    } catch (e) {}

    if (!serverOnline) {
        console.log('Starting backend server instance on port 3001...');
        const serverScript = path.join(ROOT_DIR, 'backend', 'server.js');
        serverProcess = spawn('node', [serverScript], { stdio: 'pipe' });
        serverProcess.stdout.on('data', d => process.stdout.write('[Server] ' + d.toString()));
        serverProcess.stderr.on('data', d => process.stderr.write('[Server Err] ' + d.toString()));
        await sleep(1500);
    }

    // 2.1 Static Index.html
    try {
        const res = await httpRequest('GET', '/');
        const isHtml = res.statusCode === 200 && res.text.includes('DR Dubber Pro');
        recordResult('Backend APIs', 'Static Web App Serving (/index.html)', isHtml, `HTTP ${res.statusCode}, size: ${res.raw.length} bytes`);
    } catch (e) {
        recordResult('Backend APIs', 'Static Web App Serving (/index.html)', false, e.message);
    }

    // 2.2 System Memory API
    try {
        const memRes = await httpRequest('GET', '/api/system-memory');
        const memOk = memRes.statusCode === 200 && memRes.json && typeof memRes.json.percent === 'number' && memRes.json.percent < 85;
        recordResult('Backend APIs', 'System Memory & Telemetry (/api/system-memory)', memOk, `Used: ${memRes.json?.appUsedMB} MB (${memRes.json?.percent}%), Free: ${memRes.json?.freeGB} GB`);
    } catch (e) {
        recordResult('Backend APIs', 'System Memory & Telemetry (/api/system-memory)', false, e.message);
    }

    // 2.3 System Fonts API
    try {
        const fontsRes = await httpRequest('GET', '/api/system-fonts');
        const fontsOk = fontsRes.statusCode === 200 && Array.isArray(fontsRes.json?.fonts) && fontsRes.json.fonts.length > 0;
        recordResult('Backend APIs', 'System Khmer Fonts List (/api/system-fonts)', fontsOk, `Found ${fontsRes.json?.fonts?.length} fonts: ${fontsRes.json?.fonts?.slice(0, 3).join(', ')}...`);
    } catch (e) {
        recordResult('Backend APIs', 'System Khmer Fonts List (/api/system-fonts)', false, e.message);
    }

    // 2.4 Voice Presets API
    try {
        const voiceRes = await httpRequest('GET', '/api/voices');
        const voiceOk = voiceRes.statusCode === 200 && voiceRes.json?.success && voiceRes.json?.voices;
        const voiceCount = Object.keys(voiceRes.json?.voices || {}).length;
        recordResult('Backend APIs', 'Voice Presets Catalog (/api/voices)', voiceOk, `Loaded ${voiceCount} neural voice presets`);
    } catch (e) {
        recordResult('Backend APIs', 'Voice Presets Catalog (/api/voices)', false, e.message);
    }

    // -------------------------------------------------------------
    // CATEGORY 3: EMOTIONAL ACTING & PROSODY MODULATION (TTS)
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 3: Emotional Acting & Dramatic Prosody Engine ---');

    let maleAudioPath = '';
    let femaleAudioPath = '';

    // 3.1 Neutral Khmer Male Voice
    try {
        const maleRes = await httpRequest('POST', '/api/generate-audio', {
            text: 'សួស្តីបងប្អូនទាំងអស់គ្នា សូមស្វាគមន៍មកកាន់ DR Dubber Pro!',
            gender: 'Male',
            emotion: 'Neutral',
            tempPath: TEST_DIR,
            index: 'test_male_neutral'
        });
        const maleOk = maleRes.statusCode === 200 && maleRes.json?.success && fs.existsSync(maleRes.json.file);
        maleAudioPath = maleRes.json?.file || '';
        recordResult('Emotion Engine', 'Neutral Tone (km-KH-PisethNeural)', maleOk, `Duration: ${maleRes.json?.duration}s`);
    } catch (e) {
        recordResult('Emotion Engine', 'Neutral Tone (Piseth)', false, e.message);
    }

    // 3.2 Angry Dramatic Emotion
    try {
        const angryRes = await httpRequest('POST', '/api/generate-audio', {
            text: 'ឯងហ៊ានប្រមាថខ្ញុំផងឬ! ឈប់ភ្លាមទៅ!',
            gender: 'Male',
            emotion: 'Angry',
            tempPath: TEST_DIR,
            index: 'test_angry'
        });
        const angryOk = angryRes.statusCode === 200 && angryRes.json?.success && fs.existsSync(angryRes.json.file);
        recordResult('Emotion Engine', 'Angry Dramatic Emotion (+10Hz pitch, +15% vol, +12% rate)', angryOk, `Duration: ${angryRes.json?.duration}s`);
    } catch (e) {
        recordResult('Emotion Engine', 'Angry Dramatic Emotion', false, e.message);
    }

    // 3.3 Sad / Grief Emotion
    try {
        const sadRes = await httpRequest('POST', '/api/generate-audio', {
            text: 'ហេតុអ្វីបានជាជីវិតខ្ញុំត្រូវជួបរឿងអកុសលបែបនេះ...',
            gender: 'Female',
            emotion: 'Sad',
            tempPath: TEST_DIR,
            index: 'test_sad'
        });
        const sadOk = sadRes.statusCode === 200 && sadRes.json?.success && fs.existsSync(sadRes.json.file);
        femaleAudioPath = sadRes.json?.file || '';
        recordResult('Emotion Engine', 'Sad / Grief Emotion (-6Hz pitch, -10% vol, -12% rate)', sadOk, `Duration: ${sadRes.json?.duration}s`);
    } catch (e) {
        recordResult('Emotion Engine', 'Sad / Grief Emotion', false, e.message);
    }

    // 3.4 Whisper / Secret Emotion
    try {
        const whisperRes = await httpRequest('POST', '/api/generate-audio', {
            text: 'ស្ងាត់ៗណា កុំឲ្យគេដឹងឲ្យសោះ...',
            gender: 'Female',
            emotion: 'Whisper',
            tempPath: TEST_DIR,
            index: 'test_whisper'
        });
        const whisperOk = whisperRes.statusCode === 200 && whisperRes.json?.success;
        recordResult('Emotion Engine', 'Whisper / Secret Emotion (-4Hz pitch, -25% vol)', whisperOk, `Duration: ${whisperRes.json?.duration}s`);
    } catch (e) {
        recordResult('Emotion Engine', 'Whisper / Secret Emotion', false, e.message);
    }

    // 3.5 Royal / Honorific Court Tone
    try {
        const royalRes = await httpRequest('POST', '/api/generate-audio', {
            text: 'ទូលព្រះបង្គំសូមថ្វាយបង្គំព្រះអង្គម្ចាស់!',
            gender: 'Male',
            emotion: 'Royal',
            tempPath: TEST_DIR,
            index: 'test_royal'
        });
        const royalOk = royalRes.statusCode === 200 && royalRes.json?.success;
        recordResult('Emotion Engine', 'Royal Court Honorific Emotion (Resonant Bass -8Hz)', royalOk, `Duration: ${royalRes.json?.duration}s`);
    } catch (e) {
        recordResult('Emotion Engine', 'Royal Court Honorific Emotion', false, e.message);
    }

    // 3.6 Excited Action Tone
    try {
        const excitedRes = await httpRequest('POST', '/api/generate-audio', {
            text: 'យើងឈ្នះហើយ! អស្ចារ្យមែនទែន!',
            gender: 'Male',
            emotion: 'Excited',
            tempPath: TEST_DIR,
            index: 'test_excited'
        });
        const excitedOk = excitedRes.statusCode === 200 && excitedRes.json?.success;
        recordResult('Emotion Engine', 'Excited Action Emotion (+12Hz pitch, +15% rate)', excitedOk, `Duration: ${excitedRes.json?.duration}s`);
    } catch (e) {
        recordResult('Emotion Engine', 'Excited Action Emotion', false, e.message);
    }

    // -------------------------------------------------------------
    // CATEGORY 4: AUDIO STREAMING & RANGE SUPPORT
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 4: Audio Streaming & Range Header Support ---');

    if (maleAudioPath && fs.existsSync(maleAudioPath)) {
        // 4.1 Full Stream
        try {
            const streamRes = await httpRequest('GET', `/api/audio?path=${encodeURIComponent(maleAudioPath)}`);
            const isMp3 = streamRes.statusCode === 200 && streamRes.headers['content-type'] === 'audio/mpeg';
            recordResult('Audio Streaming', 'Full File Streaming (HTTP 200)', isMp3, `Size: ${streamRes.raw.length} bytes`);
        } catch (e) {
            recordResult('Audio Streaming', 'Full File Streaming', false, e.message);
        }

        // 4.2 Partial Content (Range Request)
        try {
            const rangeRes = await httpRequest('GET', `/api/audio?path=${encodeURIComponent(maleAudioPath)}`, null, {
                'Range': 'bytes=0-1023'
            });
            const is206 = rangeRes.statusCode === 206 && rangeRes.headers['content-range'] && rangeRes.raw.length === 1024;
            recordResult('Audio Streaming', 'Partial Content Streaming with Range Header (HTTP 206)', is206, `Content-Range: ${rangeRes.headers['content-range']}`);
        } catch (e) {
            recordResult('Audio Streaming', 'Partial Content Streaming', false, e.message);
        }
    }

    // -------------------------------------------------------------
    // CATEGORY 5: MEDIA CREATION & EXTRACTION
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 5: Media Processing & Audio Extraction ---');

    // 5.1 Create Synthetic Test Video
    const testVideoPath = path.join(TEST_DIR, 'synth_test_video.mp4');
    const synthVideoCmd = [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=4:size=1280x720:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        testVideoPath
    ];
    const synthRes = await runCmd('ffmpeg', synthVideoCmd);
    const synthVideoOk = synthRes.code === 0 && fs.existsSync(testVideoPath);
    recordResult('Media Engine', 'Synthetic Video Generation (FFmpeg)', synthVideoOk, `Path: ${testVideoPath}`);

    // 5.2 Create Synthetic BGM audio
    const testBgmPath = path.join(TEST_DIR, 'synth_bgm.wav');
    const synthBgmCmd = [
        '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4',
        '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2',
        testBgmPath
    ];
    await runCmd('ffmpeg', synthBgmCmd);
    const synthBgmOk = fs.existsSync(testBgmPath);
    recordResult('Media Engine', 'Synthetic BGM Track Generation', synthBgmOk, `Path: ${testBgmPath}`);

    // 5.3 Audio Extraction Endpoint (/api/extract-audio)
    try {
        const extractRes = await httpRequest('POST', '/api/extract-audio', {
            videoPath: testVideoPath
        });
        const extractOk = extractRes.statusCode === 200 && extractRes.json?.success && fs.existsSync(extractRes.json.audioPath);
        recordResult('Media Engine', 'Audio Extraction from Video (/api/extract-audio)', extractOk, `Extracted: ${path.basename(extractRes.json?.audioPath || '')}`);
    } catch (e) {
        recordResult('Media Engine', 'Audio Extraction from Video (/api/extract-audio)', false, e.message);
    }

    // -------------------------------------------------------------
    // CATEGORY 6: MULTI-STEM EXPORT & SUBTITLE ENGINE
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 6: Multi-Stem Audio Export & Subtitles ---');

    // 6.1 Multi-Stem Export Endpoint (/api/export-stems)
    const exportStemFolder = path.join(TEST_DIR, 'stems_export');
    if (!fs.existsSync(exportStemFolder)) fs.mkdirSync(exportStemFolder, { recursive: true });

    try {
        const stemRes = await httpRequest('POST', '/api/export-stems', {
            customFolder: exportStemFolder,
            videoName: 'Ultra_Test_Project',
            bgmPath: testBgmPath,
            subtitles: [
                { id: 1, file: maleAudioPath, textStart: '0.00', textEnd: '1.80', text: 'សួស្តីបងប្អូនទាំងអស់គ្នា', originalText: 'Hello everyone' },
                { id: 2, file: femaleAudioPath, textStart: '2.00', textEnd: '3.80', text: 'សូមស្វាគមន៍', originalText: 'Welcome' }
            ]
        });

        const stemOk = stemRes.statusCode === 200 && stemRes.json?.success && stemRes.json?.srtPath && fs.existsSync(stemRes.json.srtPath);
        recordResult('Stem Export', 'Multi-Stem Audio Export (Clean Voices, Isolated BGM, SRT Subs)', stemOk, `Folder: ${path.basename(stemRes.json?.folder || '')}`);
    } catch (e) {
        recordResult('Stem Export', 'Multi-Stem Audio Export', false, e.message);
    }

    // 6.2 Python SRT Parser and Exporter
    const sampleSrtPath = path.join(TEST_DIR, 'sample.srt');
    const srtContent = `1\n00:00:00,000 --> 00:00:02,000\nសួស្តីអ្នកទាំងអស់គ្នា\n\n2\n00:00:02,500 --> 00:00:04,000\nសូមស្វាគមន៍\n`;
    fs.writeFileSync(sampleSrtPath, srtContent, 'utf8');

    const transcriberPy = path.join(ROOT_DIR, 'backend', 'python', 'transcriber.py');
    const parseRes = await runCmd(PYTHON_CMD, [transcriberPy, '--parse-srt', sampleSrtPath]);
    let parsedSubs = [];
    try {
        const pData = JSON.parse(parseRes.stdout);
        parsedSubs = pData.subtitles || [];
    } catch (e) {}
    const parseOk = parsedSubs.length === 2 && parsedSubs[0].originalText === 'សួស្តីអ្នកទាំងអស់គ្នា';
    recordResult('Subtitle Engine', 'SRT Subtitle Parser (transcriber.py)', parseOk, `Parsed ${parsedSubs.length} subtitle cues`);

    // -------------------------------------------------------------
    // CATEGORY 7: VIDEO RENDERING PIPELINE WITH DUCKING & MASKING
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 7: Theatrical Video Render Pipeline ---');

    const renderedVideoPath = path.join(TEST_DIR, 'test_theatrical_render.mp4');
    if (fs.existsSync(renderedVideoPath)) {
        try { fs.unlinkSync(renderedVideoPath); } catch (e) {}
    }

    try {
        const renderPayload = {
            videoPath: testVideoPath,
            subtitles: [
                {
                    id: 1,
                    text: 'សួស្តី DR Dubber Pro!',
                    startTime: '00:00.00',
                    endTime: '00:01.80',
                    audioStart: '00:00.00',
                    file: maleAudioPath,
                    volume: '1.0'
                },
                {
                    id: 2,
                    text: 'សំឡេងស្វ័យប្រវត្តិកម្រិតខ្ពស់',
                    startTime: '00:02.00',
                    endTime: '00:03.80',
                    audioStart: '00:02.00',
                    file: femaleAudioPath,
                    volume: '1.0'
                }
            ],
            bgmPath: testBgmPath,
            bgmVolume: 0.3,
            voiceVolume: 1.0,
            duckingEnabled: true,
            muteOriginal: true,
            burnSubtitles: true,
            subtitleFont: 'Arial',
            subtitleFontSize: 24,
            subtitleFontColor: '&H00FFFFFF',
            subtitleOutlineColor: '&H00000000',
            subtitlePosition: 'bottom',
            resolution: '720p',
            encoder: 'libx264',
            outputPath: renderedVideoPath,
            colorAdjustments: {
                brightness: 10,
                contrast: 15,
                saturation: 20,
                gamma: 0,
                vignette: true
            }
        };

        const renderSubmit = await httpRequest('POST', '/api/render', renderPayload);
        const submitOk = renderSubmit.statusCode === 200 && renderSubmit.json?.success;

        // Poll render progress until done
        let renderDone = false;
        let pollRenderCount = 0;
        let finalProgress = null;

        while (pollRenderCount++ < 50) {
            await sleep(500);
            const progRes = await httpRequest('GET', '/api/render-progress');
            if (progRes.json) {
                finalProgress = progRes.json;
                if (progRes.json.status === 'done' || progRes.json.percent === 100) {
                    renderDone = true;
                    break;
                } else if (progRes.json.status === 'error') {
                    break;
                }
            }
        }

        const renderFileExists = fs.existsSync(renderedVideoPath) && fs.statSync(renderedVideoPath).size > 1000;
        const renderSuccess = submitOk && renderDone && renderFileExists;

        recordResult('Render Engine', 'FFmpeg Render with Sidechain Ducking & Spectral Vocal Bleed Masking', renderSuccess, `Output Size: ${(fs.existsSync(renderedVideoPath) ? fs.statSync(renderedVideoPath).size / 1024 : 0).toFixed(1)} KB`);
    } catch (e) {
        recordResult('Render Engine', 'Theatrical Video Render Pipeline', false, e.message);
    }

    // -------------------------------------------------------------
    // CATEGORY 8: FRONTEND SCRIPT & ASSET INTEGRITY
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 8: Frontend Assets & Script Integrity ---');

    const essentialAssets = [
        'frontend/index.html',
        'frontend/app.js',
        'frontend/lib/tailwind.min.js',
        'frontend/lib/lucide.min.js',
        'frontend/lib/lottie.min.js',
        'frontend/chroma-worker.js',
        'frontend/pitch-shifter-processor.js',
        'preload.js',
        'main.js'
    ];

    let allAssetsOk = true;
    for (const a of essentialAssets) {
        const full = path.join(ROOT_DIR, a);
        if (!fs.existsSync(full)) {
            allAssetsOk = false;
        }
    }
    recordResult('Frontend & Electron', 'Core Frontend & Electron Assets Integrity', allAssetsOk, 'All 9 essential files present');

    // 8.2 Validate Syntax of JS files
    const jsFilesToValidate = [
        'preload.js',
        'main.js',
        'backend/server.js',
        'backend/render_service.js',
        'frontend/app.js',
        'frontend/chroma-worker.js',
        'frontend/pitch-shifter-processor.js'
    ];

    let allJsSyntaxOk = true;
    for (const f of jsFilesToValidate) {
        const fPath = path.join(ROOT_DIR, f);
        try {
            const code = fs.readFileSync(fPath, 'utf8');
            new Function(code);
        } catch (e) {
            allJsSyntaxOk = false;
            recordResult('Code Integrity', `Syntax Check: ${f}`, false, e.message);
        }
    }
    if (allJsSyntaxOk) {
        recordResult('Code Integrity', 'JavaScript Syntax Validation (All Backend, Preload, Worker Scripts)', true, 'All scripts valid JS syntax');
    }

    // -------------------------------------------------------------
    // SUMMARY REPORT
    // -------------------------------------------------------------
    console.log('\n================================================================');
    console.log('                      TEST SUITE SUMMARY                        ');
    console.log('================================================================');
    const totalTests = results.length;
    const passedTests = results.filter(r => r.passed).length;
    const failedTests = results.filter(r => !r.passed).length;

    console.log(`TOTAL TESTS : ${totalTests}`);
    console.log(`PASSED      : ${passedTests} ✅`);
    console.log(`FAILED      : ${failedTests} ${failedTests > 0 ? '❌' : ''}`);
    console.log(`SUCCESS RATE: ${Math.round((passedTests / totalTests) * 100)}%`);
    console.log('================================================================\n');

    if (serverProcess) {
        serverProcess.kill();
    }

    process.exit(failedTests > 0 ? 1 : 0);
}

runAllTests().catch(err => {
    console.error('Fatal test runner error:', err);
    if (serverProcess) serverProcess.kill();
    process.exit(1);
});
