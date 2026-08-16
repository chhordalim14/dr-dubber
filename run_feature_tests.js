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
    console.log('          DR DUBBER PRO - FULL SYSTEM FEATURE TEST SUITE        ');
    console.log('================================================================\n');

    // -------------------------------------------------------------
    // CATEGORY 1: SYSTEM & DEPENDENCY CHECKS
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 1: System & Dependencies ---');

    // 1.1 Node.js
    const nodeVer = process.version;
    recordResult('Dependencies', 'Node.js Version Check', !!nodeVer, `Node ${nodeVer}`);

    // 1.2 Python
    const pyCheck = await runCmd('python', ['--version']);
    recordResult('Dependencies', 'Python 3 Executable Check', pyCheck.code === 0, pyCheck.stdout || pyCheck.stderr);

    // 1.3 Edge-TTS Python Library
    const edgeCheck = await runCmd('python', ['-c', 'import edge_tts; print(edge_tts.__version__)']);
    recordResult('Dependencies', 'Edge-TTS Library', edgeCheck.code === 0, `edge_tts v${edgeCheck.stdout}`);

    // 1.4 FFmpeg
    const ffmpegCheck = await runCmd('ffmpeg', ['-version']);
    const ffmpegOk = ffmpegCheck.code === 0 && ffmpegCheck.stdout.includes('ffmpeg version');
    const firstFfmpegLine = ffmpegCheck.stdout.split('\n')[0];
    recordResult('Dependencies', 'FFmpeg Multimedia Engine', ffmpegOk, firstFfmpegLine);

    // 1.5 FFprobe
    const ffprobeCheck = await runCmd('ffprobe', ['-version']);
    recordResult('Dependencies', 'FFprobe Stream Analyzer', ffprobeCheck.code === 0, ffprobeCheck.stdout.split('\n')[0]);

    // 1.6 Spleeter Python Environment
    const spleeterPy = 'C:\\Software\\DAI-Dubber-PRO\\spleeter-env\\Scripts\\python.exe';
    const spleeterExists = fs.existsSync(spleeterPy);
    recordResult('Dependencies', 'Spleeter AI Environment Check', spleeterExists, spleeterExists ? spleeterPy : 'Not found (will use FFmpeg fallback)');

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
        const memOk = memRes.statusCode === 200 && memRes.json && typeof memRes.json.percent === 'number';
        recordResult('Backend APIs', 'System Memory & Telemetry (/api/system-memory)', memOk, `Used: ${memRes.json?.usedGB} GB / ${memRes.json?.totalGB} GB (${memRes.json?.percent}%)`);
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

    // 2.5 Movie Title Suggestion API
    try {
        const titleRes = await httpRequest('POST', '/api/suggest-movie-title', {});
        const titleOk = titleRes.statusCode === 200 && Array.isArray(titleRes.json?.titles) && titleRes.json.titles.length > 0;
        recordResult('Backend APIs', 'Khmer Movie Title AI Suggestions (/api/suggest-movie-title)', titleOk, `Sample: ${titleRes.json?.titles?.[0]?.khmer}`);
    } catch (e) {
        recordResult('Backend APIs', 'Khmer Movie Title AI Suggestions (/api/suggest-movie-title)', false, e.message);
    }

    // 2.6 Video Preview Check API
    try {
        const testCheck = await httpRequest('POST', '/api/check-video-preview', { filePath: path.join(ROOT_DIR, 'package.json') });
        const checkOk = testCheck.statusCode === 200 && testCheck.json?.success === true;
        recordResult('Backend APIs', 'Video Preview Verifier (/api/check-video-preview)', checkOk, `Success: ${testCheck.json?.success}`);
    } catch (e) {
        recordResult('Backend APIs', 'Video Preview Verifier (/api/check-video-preview)', false, e.message);
    }

    // -------------------------------------------------------------
    // CATEGORY 3: NEURAL SPEECH GENERATION (EDGE-TTS KHMER)
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 3: Neural Khmer Speech Generation (TTS) ---');

    let maleAudioPath = '';
    let femaleAudioPath = '';

    // 3.1 Male Voice (Piseth)
    try {
        const maleText = 'សួស្តីបងប្អូនទាំងអស់គ្នា សូមស្វាគមន៍មកកាន់ DR Dubber Pro!';
        const maleRes = await httpRequest('POST', '/api/generate-audio', {
            text: maleText,
            gender: 'Male',
            language: 'Khmer',
            speed: 1.0,
            tempPath: TEST_DIR,
            index: 'test_male'
        });
        const maleOk = maleRes.statusCode === 200 && maleRes.json?.success && fs.existsSync(maleRes.json.file);
        maleAudioPath = maleRes.json?.file || '';
        recordResult('TTS Engine', 'Khmer Male Voice (Piseth Neural)', maleOk, `Duration: ${maleRes.json?.duration}s, File: ${path.basename(maleAudioPath)}`);
    } catch (e) {
        recordResult('TTS Engine', 'Khmer Male Voice (Piseth Neural)', false, e.message);
    }

    // 3.2 Female Voice (Sreymom)
    try {
        const femaleText = 'នេះគឺជាការសាកល្បងសំឡេងស្រីស្វ័យប្រវត្តិកម្រិតខ្ពស់។';
        const femaleRes = await httpRequest('POST', '/api/generate-audio', {
            text: femaleText,
            gender: 'Female',
            language: 'Khmer',
            speed: 1.0,
            tempPath: TEST_DIR,
            index: 'test_female'
        });
        const femaleOk = femaleRes.statusCode === 200 && femaleRes.json?.success && fs.existsSync(femaleRes.json.file);
        femaleAudioPath = femaleRes.json?.file || '';
        recordResult('TTS Engine', 'Khmer Female Voice (Sreymom Neural)', femaleOk, `Duration: ${femaleRes.json?.duration}s, File: ${path.basename(femaleAudioPath)}`);
    } catch (e) {
        recordResult('TTS Engine', 'Khmer Female Voice (Sreymom Neural)', false, e.message);
    }

    // 3.3 Speed / Rate Control (+30% faster)
    try {
        const fastRes = await httpRequest('POST', '/api/generate-audio', {
            text: 'ការសាកល្បងល្បឿនលឿន។',
            gender: 'Male',
            speed: 1.3,
            tempPath: TEST_DIR,
            index: 'test_fast'
        });
        const fastOk = fastRes.statusCode === 200 && fastRes.json?.success;
        recordResult('TTS Engine', 'Speed/Rate Modifier (+30%)', fastOk, `Duration: ${fastRes.json?.duration}s`);
    } catch (e) {
        recordResult('TTS Engine', 'Speed/Rate Modifier (+30%)', false, e.message);
    }

    // 3.4 Pitch & Volume Control
    try {
        const pitchRes = await httpRequest('POST', '/api/generate-audio', {
            text: 'ការសាកល្បងកម្រិតសំឡេង និង Pitch។',
            gender: 'Male',
            pitch: '+5Hz',
            volume: '+10%',
            tempPath: TEST_DIR,
            index: 'test_pitch'
        });
        const pitchOk = pitchRes.statusCode === 200 && pitchRes.json?.success;
        recordResult('TTS Engine', 'Pitch (+5Hz) & Volume (+10%) Controls', pitchOk, `Duration: ${pitchRes.json?.duration}s`);
    } catch (e) {
        recordResult('TTS Engine', 'Pitch & Volume Controls', false, e.message);
    }

    // 3.5 VoxCPM2 Endpoint
    try {
        const voxRes = await httpRequest('POST', '/api/generate-voxcmp2', {
            text: 'សាកល្បង VoxCPM2 ជំនាន់ថ្មី។',
            gender: 'Male',
            tempPath: TEST_DIR,
            index: 'test_vox'
        });
        const voxOk = voxRes.statusCode === 200 && voxRes.json?.success;
        recordResult('TTS Engine', 'VoxCPM2 Endpoint (/api/generate-voxcmp2)', voxOk, `File: ${path.basename(voxRes.json?.file || '')}`);
    } catch (e) {
        recordResult('TTS Engine', 'VoxCPM2 Endpoint', false, e.message);
    }

    // -------------------------------------------------------------
    // CATEGORY 4: AUDIO STREAMING ENDPOINT (/api/audio)
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 4: Audio Streaming & Range Header Support ---');

    if (maleAudioPath && fs.existsSync(maleAudioPath)) {
        // 4.1 Full Stream
        try {
            const streamRes = await httpRequest('GET', `/api/audio?path=${encodeURIComponent(maleAudioPath)}`);
            const isMp3 = streamRes.statusCode === 200 && streamRes.headers['content-type'] === 'audio/mpeg';
            recordResult('Audio Streaming', 'Full File Streaming (HTTP 200)', isMp3, `Content-Type: ${streamRes.headers['content-type']}, Size: ${streamRes.raw.length} bytes`);
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

        // 4.3 404 for non-existent file
        try {
            const notFoundRes = await httpRequest('GET', `/api/audio?path=${encodeURIComponent('C:\\non_existent_audio_file.mp3')}`);
            const is404 = notFoundRes.statusCode === 404;
            recordResult('Audio Streaming', 'Missing File Handling (HTTP 404)', is404, `HTTP ${notFoundRes.statusCode}`);
        } catch (e) {
            recordResult('Audio Streaming', 'Missing File Handling', false, e.message);
        }
    }

    // -------------------------------------------------------------
    // CATEGORY 5: MEDIA CREATION & EXTRACTION
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 5: Media Processing & Audio Extraction ---');

    // 5.1 Create Synthetic Test Video (4 seconds, 1280x720, 30fps with sine wave audio)
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

    // 5.2 Create Synthetic BGM audio (4 seconds harmonic chord)
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
    let extractedAudioPath = '';
    try {
        const extractRes = await httpRequest('POST', '/api/extract-audio', {
            videoPath: testVideoPath
        });
        const extractOk = extractRes.statusCode === 200 && extractRes.json?.success && fs.existsSync(extractRes.json.audioPath);
        extractedAudioPath = extractRes.json?.audioPath || '';
        recordResult('Media Engine', 'Audio Extraction from Video (/api/extract-audio)', extractOk, `Extracted: ${path.basename(extractedAudioPath)}`);
    } catch (e) {
        recordResult('Media Engine', 'Audio Extraction from Video (/api/extract-audio)', false, e.message);
    }

    // 5.4 BGM / Vocal Separation (/api/remove-vocals & /api/bgm-job-status)
    try {
        const sepRes = await httpRequest('POST', '/api/remove-vocals', {
            audioPath: testBgmPath,
            jobId: 'test_sep_job_2'
        });
        const jobStarted = sepRes.statusCode === 200 && sepRes.json?.success;

        // Poll status (allow up to 30s for Spleeter neural model execution)
        let pollCount = 0;
        let jobDone = false;
        let jobResult = null;
        while (pollCount++ < 50) {
            await sleep(600);
            const statusRes = await httpRequest('GET', '/api/bgm-job-status?jobId=test_sep_job_2');
            if (statusRes.json && (statusRes.json.status === 'done' || statusRes.json.progress === 100)) {
                jobDone = true;
                jobResult = statusRes.json;
                break;
            }
        }
        const bgmExists = jobResult?.bgmPath && fs.existsSync(jobResult.bgmPath);
        const vocalExists = jobResult?.vocalPath && fs.existsSync(jobResult.vocalPath);
        const sepOk = jobStarted && jobDone && bgmExists && vocalExists;
        recordResult('Vocal Separator', 'BGM Isolation / Vocal Separation Pipeline', sepOk, `BGM: ${path.basename(jobResult?.bgmPath || '')}, Vocal: ${path.basename(jobResult?.vocalPath || '')}`);
    } catch (e) {
        recordResult('Vocal Separator', 'BGM Isolation Pipeline', false, e.message);
    }

    // -------------------------------------------------------------
    // CATEGORY 6: SUBTITLE PARSER & EXPORTER (PYTHON TRANSCRIBER)
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 6: Subtitle Parser & SRT Synchronizer ---');

    const sampleSrtPath = path.join(TEST_DIR, 'sample.srt');
    const srtContent = `1
00:00:00,000 --> 00:00:02,000
សួស្តីអ្នកទាំងអស់គ្នា

2
00:00:02,500 --> 00:00:04,000
សូមស្វាគមន៍
`;
    fs.writeFileSync(sampleSrtPath, srtContent, 'utf8');

    // 6.1 Parse SRT
    const transcriberPy = path.join(ROOT_DIR, 'backend', 'python', 'transcriber.py');
    const parseRes = await runCmd('python', [transcriberPy, '--parse-srt', sampleSrtPath]);
    let parsedSubs = [];
    try {
        const pData = JSON.parse(parseRes.stdout);
        parsedSubs = pData.subtitles || [];
    } catch (e) {}
    const parseOk = parsedSubs.length === 2 && parsedSubs[0].originalText === 'សួស្តីអ្នកទាំងអស់គ្នា';
    recordResult('Subtitle Engine', 'SRT Subtitle Parser (transcriber.py)', parseOk, `Parsed ${parsedSubs.length} subtitle cues`);

    // 6.2 Export SRT
    const exportSrtPath = path.join(TEST_DIR, 'exported.srt');
    const exportRes = await runCmd('python', [transcriberPy, '--export-srt', exportSrtPath, '--data', JSON.stringify(parsedSubs)]);
    const exportOk = fs.existsSync(exportSrtPath) && fs.readFileSync(exportSrtPath, 'utf8').includes('សួស្តីអ្នកទាំងអស់គ្នា');
    recordResult('Subtitle Engine', 'SRT Subtitle Exporter (transcriber.py)', exportOk, `Exported ${exportSrtPath}`);

    // -------------------------------------------------------------
    // CATEGORY 7: VIDEO RENDERING PIPELINE
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 7: Full Video Rendering & Color Adjustments Pipeline ---');

    const renderedVideoPath = path.join(TEST_DIR, 'test_final_render.mp4');
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
            },
            isFlippedH: true,
            isFlippedV: false
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

        // Verify with ffprobe
        let probeDetails = '';
        if (renderFileExists) {
            const probeRes = await runCmd('ffprobe', [
                '-v', 'error',
                '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration,size',
                '-of', 'json',
                renderedVideoPath
            ]);
            try {
                const pJson = JSON.parse(probeRes.stdout);
                const streams = pJson.streams || [];
                const vStream = streams.find(s => s.codec_type === 'video');
                const aStream = streams.find(s => s.codec_type === 'audio');
                probeDetails = `Video: ${vStream?.codec_name} (${vStream?.width}x${vStream?.height}), Audio: ${aStream?.codec_name}, Duration: ${pJson.format?.duration}s, Size: ${(pJson.format?.size / 1024).toFixed(1)} KB`;
            } catch (e) {
                probeDetails = `File size: ${fs.statSync(renderedVideoPath).size} bytes`;
            }
        }

        recordResult('Render Engine', 'Full Video Render with Subtitle Burn-In, Sidechain BGM Ducking, & Color Grading', renderSuccess, probeDetails || finalProgress?.error || 'Render timeout');
    } catch (e) {
        recordResult('Render Engine', 'Full Video Render Pipeline', false, e.message);
    }

    // -------------------------------------------------------------
    // CATEGORY 8: FRONTEND SCRIPT & ASSET INTEGRITY
    // -------------------------------------------------------------
    console.log('\n--- CATEGORY 8: Frontend Assets & Script Integrity ---');

    // 8.1 Check Frontend Assets
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
    const missingAssets = [];
    for (const a of essentialAssets) {
        const full = path.join(ROOT_DIR, a);
        if (!fs.existsSync(full)) {
            allAssetsOk = false;
            missingAssets.push(a);
        }
    }
    recordResult('Frontend & Electron', 'Core Frontend & Electron Assets Integrity', allAssetsOk, missingAssets.length ? `Missing: ${missingAssets.join(', ')}` : 'All 9 essential files present');

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
