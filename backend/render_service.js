const { spawn, execSync, exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const fs = require('fs');
const os = require('os');

let activeRenderProcess = null;
let currentRenderJob = {
    status: 'idle',
    progress: 0,
    eta: '0s',
    outputFile: null,
    error: null
};

let _subtitlesFilterSupported = null;
function hasSubtitlesFilter() {
    if (_subtitlesFilterSupported !== null) return _subtitlesFilterSupported;
    try {
        const filters = execSync('ffmpeg -filters', { encoding: 'utf8' });
        _subtitlesFilterSupported = filters.includes(' subtitles ') || filters.includes('subtitles ');
    } catch (e) {
        _subtitlesFilterSupported = false;
    }
    return _subtitlesFilterSupported;
}

// Tries a throwaway 1-frame encode to confirm a hardware encoder actually
// works, not just that ffmpeg was compiled with it. Verified with a real
// render: a build with NVENC compiled in reports h264_nvenc as present even
// on a machine with only an integrated Intel/AMD GPU and no NVIDIA hardware;
// "auto" then picked h264_nvenc and every render failed at runtime with
// "Terminating thread with return code -1 (Operation not permitted)" /
// "Nothing was written into output file".
function canEncodeWith(codec) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            resolve(ok);
        };
        let p;
        try {
            p = spawn('ffmpeg', [
                '-hide_banner', '-loglevel', 'error',
                '-f', 'lavfi', '-i', 'color=black:s=64x64',
                '-frames:v', '1', '-c:v', codec, '-f', 'null', '-'
            ], { windowsHide: true });
        } catch (e) {
            return finish(false);
        }
        p.on('error', () => finish(false));
        p.on('close', (code) => finish(code === 0));
        setTimeout(() => { try { p.kill(); } catch (e) {} finish(false); }, 4000);
    });
}

let _detectedEncoders = null;
async function detectAvailableEncoders() {
    if (_detectedEncoders) return _detectedEncoders;
    let compiled = { nvenc: false, qsv: false, amf: false, mf: false, videotoolbox: false, libx264: true };
    try {
        const { stdout: out } = await execAsync('ffmpeg -encoders', { encoding: 'utf8', timeout: 5000 });
        compiled = {
            nvenc: out.includes('h264_nvenc'),
            qsv: out.includes('h264_qsv'),
            amf: out.includes('h264_amf'),
            mf: out.includes('h264_mf'),
            videotoolbox: out.includes('h264_videotoolbox'),
            libx264: out.includes('libx264')
        };
    } catch (e) {
        _detectedEncoders = { libx264: true };
        return _detectedEncoders;
    }

    const codecByKey = { nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf', mf: 'h264_mf', videotoolbox: 'h264_videotoolbox' };
    const verified = { ...compiled };
    for (const [key, codec] of Object.entries(codecByKey)) {
        if (compiled[key]) verified[key] = await canEncodeWith(codec);
    }

    _detectedEncoders = verified;
    return _detectedEncoders;
}

async function getVideoDurationAsync(videoPath) {
    // execSync here blocked the entire Node event loop (audio streaming, TTS
    // generation, progress polling for every other tab) for as long as ffprobe
    // took, on every single render. This isn't memoized like the encoder/filter
    // probes above since duration is per-video, so it ran unconditionally.
    try {
        const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`, { encoding: 'utf8', timeout: 5000 });
        const dur = parseFloat(stdout.trim());
        return (dur && !isNaN(dur) && dur > 0) ? dur : null;
    } catch (e) {
        return null;
    }
}

function parseTimeToSeconds(timeStr) {
    if (typeof timeStr === 'number') return timeStr;
    if (!timeStr) return 0;
    const parts = String(timeStr).replace(',', '.').split(':');
    if (parts.length === 3) {
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
        return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(timeStr) || 0;
}

function formatSrtTimestamp(seconds) {
    const secNum = Math.max(0, parseFloat(seconds) || 0);
    const hrs = Math.floor(secNum / 3600);
    const mins = Math.floor((secNum % 3600) / 60);
    const secs = Math.floor(secNum % 60);
    const ms = Math.floor((secNum % 1) * 1000);
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function createSrtFile(subtitles, outputPath) {
    let srtContent = '';
    subtitles.forEach((sub, idx) => {
        const startSec = parseTimeToSeconds(sub.startTime || sub.textStart || sub.start || 0);
        const endSec = parseTimeToSeconds(sub.endTime || sub.textEnd || sub.end || (startSec + 2));
        const text = (sub.text || '').trim();
        if (text) {
            srtContent += `${idx + 1}\n${formatSrtTimestamp(startSec)} --> ${formatSrtTimestamp(endSec)}\n${text}\n\n`;
        }
    });
    fs.writeFileSync(outputPath, srtContent, 'utf8');
}

/**
 * Fast Dialogue Stem Pre-Assembly.
 * Combines all subtitle audio cues into a single master PCM dialogue track in a lightning-fast pass.
 * This prevents passing 100-500 inputs into the main video render filter graph.
 */
async function assembleDialogueStem(validSubs, tempDir, voiceVolume = 1.0) {
    if (!validSubs || validSubs.length === 0) return null;
    const stemPath = path.join(tempDir, 'dialogue_stem.wav');

    if (validSubs.length === 1) {
        const item = validSubs[0];
        const aPath = item.file || item.audioPath;
        const startSec = parseTimeToSeconds(item.audioStart || item.textStart || item.startTime || 0);
        const delayMs = Math.max(0, Math.round(startSec * 1000));
        const subVol = parseFloat(item.volume || '1.0') || 1.0;
        const totalVol = (voiceVolume * subVol).toFixed(2);
        const args = [
            '-y', '-i', aPath,
            '-af', `adelay=${delayMs}|${delayMs},volume=${totalVol}`,
            '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2',
            stemPath
        ];
        await new Promise((resolve, reject) => {
            const p = spawn('ffmpeg', args, { windowsHide: true });
            p.on('close', code => (code === 0 && fs.existsSync(stemPath)) ? resolve() : reject(new Error(`Stem exit code ${code}`)));
            p.on('error', reject);
        });
        return fs.existsSync(stemPath) ? stemPath : null;
    }

    const args = ['-y'];
    const filterParts = [];
    const streamNames = [];

    validSubs.forEach((sub, i) => {
        const aPath = sub.file || sub.audioPath;
        args.push('-i', aPath);
        const startSec = parseTimeToSeconds(sub.audioStart || sub.textStart || sub.startTime || 0);
        const delayMs = Math.max(0, Math.round(startSec * 1000));
        const subVol = parseFloat(sub.volume || '1.0') || 1.0;
        const totalVol = (voiceVolume * subVol).toFixed(2);
        filterParts.push(`[${i}:a]adelay=${delayMs}|${delayMs},volume=${totalVol}[a${i}]`);
        streamNames.push(`[a${i}]`);
    });

    filterParts.push(`${streamNames.join('')}amix=inputs=${validSubs.length}:normalize=0[aout]`);

    const filterScriptPath = path.join(tempDir, 'audio_stem_filter.txt');
    fs.writeFileSync(filterScriptPath, filterParts.join(';\n'), 'utf8');

    args.push('-filter_complex_script', filterScriptPath);
    args.push('-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', stemPath);

    await new Promise((resolve, reject) => {
        const p = spawn('ffmpeg', args, { windowsHide: true });
        p.on('close', code => (code === 0 && fs.existsSync(stemPath)) ? resolve() : reject(new Error(`Stem exit code ${code}`)));
        p.on('error', reject);
    });

    return fs.existsSync(stemPath) ? stemPath : null;
}

async function applyEncoderSettings(args, encoderPreference, resolution) {
    const encoders = await detectAvailableEncoders();
    let chosen = encoderPreference || 'auto';

    if (chosen === 'auto') {
        if (encoders.nvenc) chosen = 'h264_nvenc';
        else if (encoders.qsv) chosen = 'h264_qsv';
        else if (encoders.mf && process.platform === 'win32') chosen = 'h264_mf';
        else if (encoders.amf) chosen = 'h264_amf';
        else if (encoders.videotoolbox && process.platform === 'darwin') chosen = 'h264_videotoolbox';
        else chosen = 'libx264';
    }

    const cpuCores = (os.cpus() && os.cpus().length) || 4;
    const renderThreads = Math.max(2, Math.min(cpuCores - 1, 8));
    args.push('-threads', String(renderThreads));

    if (chosen === 'h264_nvenc' && encoders.nvenc) {
        args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-b:v', resolution === '1080p' ? '6500k' : '4500k');
    } else if (chosen === 'h264_qsv' && encoders.qsv) {
        args.push('-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', resolution === '1080p' ? '6500k' : '4500k');
    } else if (chosen === 'h264_amf' && encoders.amf) {
        args.push('-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'speed', '-b:v', resolution === '1080p' ? '6500k' : '4500k');
    } else if (chosen === 'h264_mf' && encoders.mf) {
        args.push('-c:v', 'h264_mf', '-b:v', resolution === '1080p' ? '6500k' : '4500k');
    } else if (chosen === 'h264_videotoolbox' && encoders.videotoolbox) {
        args.push('-c:v', 'h264_videotoolbox', '-b:v', resolution === '1080p' ? '6500k' : '4500k');
    } else {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'fastdecode', '-crf', '20');
    }
}

async function renderVideo(options, onProgress, onComplete, onError) {
    const {
        videoPath,
        subtitles = [],
        bgmPath,
        bgmVolume = 0.5,
        voiceVolume = 1.0,
        duckingEnabled = true,
        duckingDepth = 'standard', // 'light' | 'standard' | 'deep'
        muteOriginal = true,
        burnSubtitles = true,
        subtitlePreset = 'classic', // 'classic' | 'tiktok_pop' | 'neon_cyan' | 'royal_gold'
        subtitleFont = 'KantumruyPro-Bold',
        subtitleFontSize = 24,
        subtitleFontColor = '&H00FFFFFF',
        subtitleOutlineColor = '&H00000000',
        subtitlePosition = 'bottom',
        resolution = '1080p',
        encoder = 'auto',
        outputPath,
        videoColorAdj,
        colorAdjustments,
        videoVignette,
        isFlippedH,
        isFlippedV,
        duration: providedDuration
    } = options;

    try {
        currentRenderJob = {
            status: 'rendering',
            progress: 0,
            eta: 'Calculating...',
            outputFile: outputPath,
            error: null
        };

        const tempDir = path.join(os.tmpdir(), 'dr_dubber_render_' + Date.now());
        fs.mkdirSync(tempDir, { recursive: true });

        // Filter valid subtitles with generated audio
        const validSubs = (subtitles || []).filter(s => {
            const aPath = s.file || s.audioPath;
            return aPath && fs.existsSync(aPath);
        });

        // 1. Pre-assemble dialogue stem in background (eliminates hundreds of stream inputs)
        let dialogueStemPath = null;
        if (validSubs.length > 0) {
            try {
                dialogueStemPath = await assembleDialogueStem(validSubs, tempDir, voiceVolume);
            } catch (stemErr) {
                console.warn('[Render Warning] Fast dialogue stem pre-assembly failed, falling back to direct inputs:', stemErr.message);
                dialogueStemPath = null;
            }
        }

        // Determine real video duration for accurate progress & ETA
        const videoDuration = providedDuration || await getVideoDurationAsync(videoPath) || 60;
        const renderStartTime = Date.now();

        // 2. Build FFmpeg command arguments
        const args = ['-y'];

        // Main video input (input 0)
        args.push('-i', videoPath);

        // BGM input (input 1, if present)
        let bgmInputIndex = -1;
        let nextInputIndex = 1;
        if (bgmPath && fs.existsSync(bgmPath)) {
            args.push('-i', bgmPath);
            bgmInputIndex = nextInputIndex++;
        }

        // Dialogue audio input
        let dialogueInputIndex = -1;
        if (dialogueStemPath && fs.existsSync(dialogueStemPath)) {
            args.push('-i', dialogueStemPath);
            dialogueInputIndex = nextInputIndex++;
        }

        // 3. Build Filter Graph for Audio & Video
        const filterComplex = [];

        // Audio mixing & Studio Auto-Ducking
        if (dialogueInputIndex >= 0) {
            if (bgmInputIndex >= 0) {
                const bgmVol = bgmVolume;
                if (duckingEnabled) {
                    let sidechainParams = 'threshold=0.08:ratio=7:attack=15:release=350';
                    if (duckingDepth === 'light') {
                        sidechainParams = 'threshold=0.12:ratio=4:attack=25:release=400';
                    } else if (duckingDepth === 'deep') {
                        sidechainParams = 'threshold=0.04:ratio=12:attack=10:release=300';
                    }
                    filterComplex.push(`[${bgmInputIndex}:a]volume=${bgmVol}[bgm_vol]`);
                    filterComplex.push(`[bgm_vol][${dialogueInputIndex}:a]sidechaincompress=${sidechainParams}[bgm_ducked]`);
                    filterComplex.push(`[bgm_ducked]equalizer=f=1100:t=q:w=1.5:g=-6[bgm_clean]`);
                    filterComplex.push(`[bgm_clean][${dialogueInputIndex}:a]amix=inputs=2:normalize=0[final_audio]`);
                } else {
                    filterComplex.push(`[${bgmInputIndex}:a]volume=${bgmVol}[bgm_vol]`);
                    filterComplex.push(`[bgm_vol][${dialogueInputIndex}:a]amix=inputs=2:normalize=0[final_audio]`);
                }
            } else {
                filterComplex.push(`[${dialogueInputIndex}:a]anull[final_audio]`);
            }
        } else if (bgmInputIndex >= 0) {
            filterComplex.push(`[${bgmInputIndex}:a]volume=${bgmVolume}[final_audio]`);
        } else {
            filterComplex.push(`[0:a]volume=1.0[final_audio]`);
        }

        // Video Filters: Color Filters, Presets, Flips, Scaling & Subtitle Burning
        let videoFilterStr = '[0:v]';
        let currentVTag = 'v_proc';
        const vFilters = [];

        // Flips
        if (isFlippedH) vFilters.push('hflip');
        if (isFlippedV) vFilters.push('vflip');

        // Color Adjustments & Filters
        const ca = colorAdjustments || videoColorAdj || {};
        const brightness = ca.brightness !== undefined ? (parseFloat(ca.brightness) - 100) / 100 : 0;
        const contrast = ca.contrast !== undefined ? parseFloat(ca.contrast) / 100 : 1.0;
        const saturation = ca.saturation !== undefined ? parseFloat(ca.saturation) / 100 : 1.0;
        const hue = ca.hue !== undefined ? parseFloat(ca.hue) : 0;
        const sharpness = ca.sharpness !== undefined ? parseFloat(ca.sharpness) : 0;

        if (brightness !== 0 || contrast !== 1.0 || saturation !== 1.0) {
            vFilters.push(`eq=brightness=${brightness.toFixed(2)}:contrast=${contrast.toFixed(2)}:saturation=${saturation.toFixed(2)}`);
        }
        if (hue !== 0) {
            vFilters.push(`hue=h=${hue.toFixed(1)}`);
        }
        if (sharpness > 0) {
            vFilters.push(`unsharp=5:5:${(sharpness * 0.4).toFixed(2)}:5:5:0.0`);
        }

        // Vignette
        if (videoVignette && videoVignette.enabled) {
            const rad = videoVignette.radius || 0.5;
            vFilters.push(`vignette=angle=${(rad * Math.PI / 2).toFixed(2)}`);
        }

        // Resolution scaling
        let scaleFilter = '';
        if (resolution === '1080p') {
            scaleFilter = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
        } else if (resolution === '720p') {
            scaleFilter = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2';
        } else if (resolution === '9:16') {
            scaleFilter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2';
        }
        if (scaleFilter) vFilters.push(scaleFilter);

        if (vFilters.length > 0) {
            filterComplex.push(`${videoFilterStr}${vFilters.join(',')}[${currentVTag}]`);
            videoFilterStr = `[${currentVTag}]`;
        }

        // Subtitles burning or soft muxing
        let softSrtInputIndex = -1;
        if (burnSubtitles && subtitles.length > 0) {
            const srtPath = path.join(tempDir, 'subtitles_burn.srt');
            createSrtFile(subtitles, srtPath);
            const escapedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
            const fontsDir = path.join(__dirname, '..', 'frontend', 'fonts').replace(/\\/g, '/').replace(/:/g, '\\:');

            if (hasSubtitlesFilter()) {
                let subStyle = `Fontname=${subtitleFont},Fontsize=${subtitleFontSize},PrimaryColour=${subtitleFontColor},OutlineColour=${subtitleOutlineColor},BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=30`;
                if (subtitlePreset === 'tiktok_pop') {
                    subStyle = `Fontname=${subtitleFont},Fontsize=${Math.round(subtitleFontSize * 1.15)},PrimaryColour=&H0000E5FF,OutlineColour=&H00000000,BorderStyle=1,Outline=4,Shadow=2,Alignment=2,MarginV=45,Bold=1`;
                } else if (subtitlePreset === 'neon_cyan') {
                    subStyle = `Fontname=${subtitleFont},Fontsize=${subtitleFontSize},PrimaryColour=&H00FFFF00,OutlineColour=&H00111111,BorderStyle=1,Outline=3,Shadow=2,Alignment=2,MarginV=35,Bold=1`;
                } else if (subtitlePreset === 'royal_gold') {
                    subStyle = `Fontname=${subtitleFont},Fontsize=${subtitleFontSize},PrimaryColour=&H003AD3F5,OutlineColour=&H00151535,BorderStyle=1,Outline=3,Shadow=2,Alignment=2,MarginV=35,Bold=1`;
                }

                filterComplex.push(`${videoFilterStr}subtitles=filename='${escapedSrtPath}':fontsdir='${fontsDir}':force_style='${subStyle}'[final_video]`);
            } else {
                filterComplex.push(`${videoFilterStr}null[final_video]`);
                softSrtInputIndex = nextInputIndex++;
                args.push('-i', srtPath);
            }
        } else {
            filterComplex.push(`${videoFilterStr}null[final_video]`);
        }

        // Write complex filter to temp script file
        const filterScriptPath = path.join(tempDir, 'filter_complex.txt');
        fs.writeFileSync(filterScriptPath, filterComplex.join(';\n'), 'utf8');

        args.push('-filter_complex_script', filterScriptPath);
        args.push('-map', '[final_video]');
        args.push('-map', '[final_audio]');
        if (softSrtInputIndex >= 0) {
            args.push('-map', `${softSrtInputIndex}:s?`);
            args.push('-c:s', 'mov_text');
        }

        // Hardware-Accelerated Video Encoder Configuration
        await applyEncoderSettings(args, encoder, resolution);

        args.push('-c:a', 'aac');
        args.push('-b:a', '192k');
        args.push('-pix_fmt', 'yuv420p');
        args.push(outputPath);

        console.log(`[Render] Spawning FFmpeg to render: ${outputPath}`);
        const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });
        activeRenderProcess = ffmpeg;

        function cleanupTempDir() {
            try {
                if (tempDir && fs.existsSync(tempDir)) {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                }
            } catch (e) {}
        }

        let fullStderr = '';
        ffmpeg.stderr.on('data', (data) => {
            const text = data.toString();
            fullStderr += text;
            const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
            if (timeMatch) {
                const currentSec = parseFloat(timeMatch[1]) * 3600 + parseFloat(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
                const progressPct = Math.min(99, Math.max(1, Math.round((currentSec / videoDuration) * 100)));
                const elapsedSec = (Date.now() - renderStartTime) / 1000;
                const speed = currentSec / (elapsedSec || 0.001);
                const etaSec = Math.max(0, Math.round((videoDuration - currentSec) / (speed || 1)));
                const etaStr = etaSec < 60 ? `${etaSec}s` : `${Math.floor(etaSec / 60)}m ${etaSec % 60}s`;

                currentRenderJob.progress = progressPct;
                currentRenderJob.eta = etaStr;
                if (onProgress) onProgress(progressPct, etaStr);
            }
        });

        ffmpeg.on('close', (code) => {
            activeRenderProcess = null;
            cleanupTempDir();
            if (code === 0 && fs.existsSync(outputPath)) {
                currentRenderJob.status = 'done';
                currentRenderJob.progress = 100;
                currentRenderJob.eta = '0s';
                if (onComplete) onComplete(outputPath);
            } else {
                console.error(`[Render FFmpeg Error Code ${code}] Full stderr:\n`, fullStderr);
                currentRenderJob.status = 'error';
                currentRenderJob.error = `FFmpeg exited with code ${code}: ${fullStderr.slice(-400)}`;
                if (onError) onError(new Error(currentRenderJob.error));
            }
        });

        ffmpeg.on('error', (err) => {
            activeRenderProcess = null;
            cleanupTempDir();
            currentRenderJob.status = 'error';
            currentRenderJob.error = err.message;
            if (onError) onError(err);
        });

    } catch (err) {
        currentRenderJob.status = 'error';
        currentRenderJob.error = err.message;
        if (onError) onError(err);
    }
}

function cancelRender() {
    if (activeRenderProcess) {
        try {
            if (process.platform === 'win32') {
                const { exec } = require('child_process');
                exec(`taskkill /pid ${activeRenderProcess.pid} /T /F`, () => {});
            } else {
                activeRenderProcess.kill('SIGKILL');
            }
        } catch (e) {}
        activeRenderProcess = null;
        currentRenderJob.status = 'cancelled';
        return true;
    }
    return false;
}

function getRenderProgress() {
    return currentRenderJob;
}

module.exports = {
    renderVideo,
    cancelRender,
    getRenderProgress,
    detectAvailableEncoders
};
