const { spawn, execSync, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFFmpegBinary, getFFprobeBinary } = require('./ffmpeg_env');

let activeRenderProcess = null;

function escapeFfmpegFilterPath(p) {
    if (!p || typeof p !== 'string') return '';
    // Normalize to forward slashes, escape colons for FFmpeg filter parser, and escape single quotes.
    // Inside a filter arg already wrapped in '...', a literal quote must become '\'' (close, escaped
    // quote, reopen) — NOT '\\'' (extra backslash), which breaks filtergraph parsing for any path
    // containing an apostrophe (e.g. a Windows user folder like C:\Users\O'Brien).
    return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
}
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
        const ffBin = getFFmpegBinary();
        const filters = execSync(`"${ffBin}" -filters`, { encoding: 'utf8', windowsHide: true });
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
            p = spawn(getFFmpegBinary(), [
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
        const { stdout: out } = await execFileAsync(getFFmpegBinary(), ['-encoders'], { timeout: 5000 });
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

// Keyed by path+mtime so an edited/replaced file at the same path still gets a fresh probe.
// (execSync here used to block the entire Node event loop — audio streaming, TTS
// generation, progress polling for every other tab — for as long as ffprobe took,
// on every single render; execFileAsync also avoids shell-interpolating videoPath.)
const _videoDurationCache = new Map();
async function getVideoDuration(videoPath) {
    let cacheKey = videoPath;
    try {
        cacheKey = `${videoPath}:${fs.statSync(videoPath).mtimeMs}`;
        if (_videoDurationCache.has(cacheKey)) return _videoDurationCache.get(cacheKey);
    } catch (e) {}

    try {
        const { stdout } = await execFileAsync(getFFprobeBinary(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], { timeout: 5000 });
        const dur = parseFloat(stdout.trim());
        const result = (dur && !isNaN(dur) && dur > 0) ? dur : null;
        _videoDurationCache.set(cacheKey, result);
        return result;
    } catch (e) {
        return null;
    }
}

function parseTimeToSeconds(timeStr) {
    if (typeof timeStr === 'number') return isNaN(timeStr) ? 0 : timeStr;
    if (!timeStr) return 0;
    const parts = String(timeStr).replace(',', '.').split(':');
    if (parts.length === 3) {
        const val = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        return isNaN(val) ? 0 : val;
    } else if (parts.length === 2) {
        const val = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        return isNaN(val) ? 0 : val;
    }
    const val = parseFloat(timeStr);
    return isNaN(val) ? 0 : val;
}

function formatSrtTimestamp(seconds) {
    const secNum = Math.max(0, parseFloat(seconds) || 0);
    if (isNaN(secNum) || !isFinite(secNum)) return '00:00:00,000';
    const hrs = Math.floor(secNum / 3600);
    const mins = Math.floor((secNum % 3600) / 60);
    const secs = Math.floor(secNum % 60);
    const ms = Math.min(999, Math.floor((secNum % 1) * 1000));
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function sanitizeSrtContent(rawSrt) {
    if (!rawSrt || typeof rawSrt !== 'string') return '';
    // Strip HTML/font tags
    const cleaned = rawSrt.replace(/<\/?font[^>]*>/gi, '').replace(/<[^>]+>/g, '').trim();
    if (!cleaned) return '';

    const blocks = cleaned.split(/\r?\n\r?\n+/);
    const validBlocks = [];
    let cueIndex = 1;

    for (const block of blocks) {
        const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;

        const timeLineIdx = lines.findIndex(l => l.includes('-->'));
        if (timeLineIdx === -1) continue;

        const timeLine = lines[timeLineIdx];
        const timeParts = timeLine.split('-->').map(t => t.trim());
        if (timeParts.length !== 2) continue;

        const startSec = parseTimeToSeconds(timeParts[0]);
        const endSec = parseTimeToSeconds(timeParts[1]);
        if (isNaN(startSec) || isNaN(endSec) || endSec <= startSec) continue;

        const textLines = lines.slice(timeLineIdx + 1).join('\n').trim();
        if (!textLines) continue;

        validBlocks.push(`${cueIndex++}\n${formatSrtTimestamp(startSec)} --> ${formatSrtTimestamp(endSec)}\n${textLines}`);
    }

    return validBlocks.join('\n\n');
}

function createSrtFile(subtitles, outputPath) {
    let srtContent = '';
    let cueIndex = 1;
    (subtitles || []).forEach((sub) => {
        const text = (sub.text || '').trim();
        if (!text) return;
        const rawStart = sub.startTime !== undefined ? sub.startTime : (sub.textStart !== undefined ? sub.textStart : (sub.start !== undefined ? sub.start : (sub.audioStart !== undefined ? sub.audioStart : 0)));
        const startSec = Math.max(0, parseTimeToSeconds(rawStart));
        const rawEnd = sub.endTime !== undefined ? sub.endTime : (sub.textEnd !== undefined ? sub.textEnd : (sub.end !== undefined ? sub.end : (sub.audioEnd !== undefined ? sub.audioEnd : (startSec + 2))));
        const endSec = Math.max(startSec + 0.1, parseTimeToSeconds(rawEnd));
        if (isNaN(startSec) || isNaN(endSec) || endSec <= startSec) return;
        srtContent += `${cueIndex++}\n${formatSrtTimestamp(startSec)} --> ${formatSrtTimestamp(endSec)}\n${text}\n\n`;
    });
    if (srtContent.trim().length > 0) {
        fs.writeFileSync(outputPath, srtContent.trim() + '\n', 'utf8');
        return true;
    }
    return false;
}

/**
 * Fast Dialogue Stem Pre-Assembly.
 * Combines all subtitle audio cues into a single master PCM dialogue track in a lightning-fast pass.
 * This prevents passing 100-500 inputs into the main video render filter graph.
 */
async function assembleDialogueStem(validSubs, tempDir, voiceVolume = 1.0) {
    if (!validSubs || validSubs.length === 0) return null;
    const stemPath = path.join(tempDir, 'dialogue_stem.wav');

    // Filter to only items where file exists on disk and is non-empty
    const existing = validSubs.filter(sub => {
        const aPath = sub.file || sub.audioPath;
        if (!aPath) return false;
        try {
            return fs.existsSync(aPath) && fs.statSync(aPath).size > 0;
        } catch (e) {
            return false;
        }
    });
    if (existing.length === 0) return null;

    if (existing.length === 1) {
        const item = existing[0];
        const aPath = item.file || item.audioPath;
        const rawStart = item.start !== undefined ? item.start : (item.audioStart !== undefined ? item.audioStart : (item.textStart !== undefined ? item.textStart : (item.startTime || 0)));
        const startSec = Math.max(0, parseTimeToSeconds(rawStart));
        const delayMs = Math.round(startSec * 1000);
        const subVol = parseFloat(item.volume || '1.0') || 1.0;
        const totalVol = (voiceVolume * subVol).toFixed(2);

        const afParts = [];
        if (item.sourceOffset && parseFloat(item.sourceOffset) > 0) {
            afParts.push(`atrim=start=${parseFloat(item.sourceOffset)}`);
        }
        if (item.speed && parseFloat(item.speed) !== 1.0) {
            afParts.push(`atempo=${parseFloat(item.speed)}`);
        }
        afParts.push(`adelay=${delayMs}|${delayMs}`, `volume=${totalVol}`);

        const args = [
            '-y', '-i', aPath,
            '-af', afParts.join(','),
            '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2',
            stemPath
        ];
        await new Promise((resolve, reject) => {
            const p = spawn(getFFmpegBinary(), args, { windowsHide: true });
            p.on('close', code => (code === 0 && fs.existsSync(stemPath)) ? resolve() : reject(new Error(`Stem exit code ${code}`)));
            p.on('error', reject);
        });
        return fs.existsSync(stemPath) ? stemPath : null;
    }

    const args = ['-y'];
    const filterParts = [];
    const streamNames = [];

    existing.forEach((sub, i) => {
        const aPath = sub.file || sub.audioPath;
        args.push('-i', aPath);
        const rawStart = sub.start !== undefined ? sub.start : (sub.audioStart !== undefined ? sub.audioStart : (sub.textStart !== undefined ? sub.textStart : (sub.startTime || 0)));
        const startSec = Math.max(0, parseTimeToSeconds(rawStart));
        const delayMs = Math.round(startSec * 1000);
        const subVol = parseFloat(sub.volume || '1.0') || 1.0;
        const totalVol = (voiceVolume * subVol).toFixed(2);

        const afParts = [];
        if (sub.sourceOffset && parseFloat(sub.sourceOffset) > 0) {
            afParts.push(`atrim=start=${parseFloat(sub.sourceOffset)}`);
        }
        if (sub.speed && parseFloat(sub.speed) !== 1.0) {
            afParts.push(`atempo=${parseFloat(sub.speed)}`);
        }
        afParts.push(`adelay=${delayMs}|${delayMs}`, `volume=${totalVol}`);

        filterParts.push(`[${i}:a]${afParts.join(',')}[a${i}]`);
        streamNames.push(`[a${i}]`);
    });

    filterParts.push(`${streamNames.join('')}amix=inputs=${existing.length}:normalize=0:duration=longest[aout]`);

    const filterScriptPath = path.join(tempDir, 'audio_stem_filter.txt');
    fs.writeFileSync(filterScriptPath, filterParts.join(';\n'), 'utf8');

    args.push('-filter_complex_script', filterScriptPath);
    args.push('-map', '[aout]', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', stemPath);

    await new Promise((resolve, reject) => {
        const p = spawn(getFFmpegBinary(), args, { windowsHide: true });
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
        audioOnly = false,
        audioFormat = 'mp3',
        audioTracks = [],
        subtitles = [],
        srtContent,
        showSubtitles,
        bgmPath,
        bgmVolume = 0.5,
        voiceVolume = 1.0,
        duckingEnabled = true,
        duckingDepth = 'standard', // 'light' | 'standard' | 'deep'
        muteOriginal = true,
        isOriginalAudioMuted,
        burnSubtitles = true,
        subtitlePreset = 'classic', // 'classic' | 'tiktok_pop' | 'neon_cyan' | 'royal_gold'
        subtitleFont = 'Kantumruy Pro',
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

        // Ensure output parent directory exists
        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
        }

        // Gather all audio items (from audioTracks or subtitles)
        const allAudioItems = (audioTracks && audioTracks.length > 0) ? audioTracks : subtitles;
        const validSubs = (allAudioItems || []).filter(s => {
            const aPath = s.file || s.audioPath;
            return aPath && fs.existsSync(aPath);
        });

        // 1. Pre-assemble dialogue stem
        let dialogueStemPath = null;
        if (validSubs.length > 0) {
            try {
                dialogueStemPath = await assembleDialogueStem(validSubs, tempDir, voiceVolume);
            } catch (stemErr) {
                console.warn('[Render Warning] Fast dialogue stem pre-assembly failed:', stemErr.message);
                dialogueStemPath = null;
            }
        }

        const renderStartTime = Date.now();

        // ─────────────────────────────────────────────────────────────
        // AUDIO ONLY EXPORT
        // ─────────────────────────────────────────────────────────────
        if (audioOnly) {
            console.log(`[Render] Audio Only export to: ${outputPath}`);
            const args = ['-y'];
            let currentIn = 0;
            let dIndex = -1;
            let bIndex = -1;

            if (dialogueStemPath && fs.existsSync(dialogueStemPath)) {
                args.push('-i', dialogueStemPath);
                dIndex = currentIn++;
            }
            if (bgmPath && fs.existsSync(bgmPath)) {
                args.push('-i', bgmPath);
                bIndex = currentIn++;
            }

            if (dIndex >= 0 && bIndex >= 0) {
                const fComplex = [
                    `[${bIndex}:a]volume=${bgmVolume}[bgm_vol]`,
                    `[bgm_vol][${dIndex}:a]sidechaincompress=threshold=0.08:ratio=7:attack=15:release=350[bgm_ducked]`,
                    `[bgm_ducked]equalizer=f=1100:t=q:w=1.5:g=-6[bgm_clean]`,
                    `[bgm_clean][${dIndex}:a]amix=inputs=2:normalize=0:duration=longest[final_audio]`
                ];
                args.push('-filter_complex', fComplex.join(';'));
                args.push('-map', '[final_audio]');
            } else if (dIndex >= 0) {
                args.push('-map', `${dIndex}:a`);
            } else if (bIndex >= 0) {
                args.push('-af', `volume=${bgmVolume}`);
                args.push('-map', `${bIndex}:a`);
            } else {
                throw new Error('No audio track or BGM found to export.');
            }

            if (audioFormat === 'wav') {
                args.push('-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2', outputPath);
            } else {
                args.push('-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', '-ac', '2', outputPath);
            }

            const ffmpeg = spawn(getFFmpegBinary(), args, { windowsHide: true });
            activeRenderProcess = ffmpeg;

            ffmpeg.on('close', (code) => {
                activeRenderProcess = null;
                try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
                if (code === 0 && fs.existsSync(outputPath)) {
                    currentRenderJob.status = 'done';
                    currentRenderJob.progress = 100;
                    currentRenderJob.eta = '0s';
                    if (onComplete) onComplete(outputPath);
                } else {
                    currentRenderJob.status = 'error';
                    currentRenderJob.error = `Audio export exited with code ${code}`;
                    if (onError) onError(new Error(currentRenderJob.error));
                }
            });

            ffmpeg.on('error', (err) => {
                activeRenderProcess = null;
                try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
                currentRenderJob.status = 'error';
                currentRenderJob.error = err.message;
                if (onError) onError(err);
            });

            return;
        }

        // ─────────────────────────────────────────────────────────────
        // VIDEO EXPORT
        // ─────────────────────────────────────────────────────────────
        const videoDuration = providedDuration || (await getVideoDuration(videoPath)) || 60;

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
        const isMuted = isOriginalAudioMuted !== undefined ? isOriginalAudioMuted : muteOriginal;

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
                    if (!isMuted) {
                        filterComplex.push(`[0:a]volume=1.0[orig_a]`);
                        filterComplex.push(`[bgm_clean][${dialogueInputIndex}:a][orig_a]amix=inputs=3:normalize=0:duration=longest[final_audio]`);
                    } else {
                        filterComplex.push(`[bgm_clean][${dialogueInputIndex}:a]amix=inputs=2:normalize=0:duration=longest[final_audio]`);
                    }
                } else {
                    filterComplex.push(`[${bgmInputIndex}:a]volume=${bgmVol}[bgm_vol]`);
                    if (!isMuted) {
                        filterComplex.push(`[0:a]volume=1.0[orig_a]`);
                        filterComplex.push(`[bgm_vol][${dialogueInputIndex}:a][orig_a]amix=inputs=3:normalize=0:duration=longest[final_audio]`);
                    } else {
                        filterComplex.push(`[bgm_vol][${dialogueInputIndex}:a]amix=inputs=2:normalize=0:duration=longest[final_audio]`);
                    }
                }
            } else {
                if (!isMuted) {
                    filterComplex.push(`[0:a]volume=1.0[orig_a]`);
                    filterComplex.push(`[${dialogueInputIndex}:a][orig_a]amix=inputs=2:normalize=0:duration=longest[final_audio]`);
                } else {
                    filterComplex.push(`[${dialogueInputIndex}:a]anull[final_audio]`);
                }
            }
        } else if (bgmInputIndex >= 0) {
            if (!isMuted) {
                filterComplex.push(`[${bgmInputIndex}:a]volume=${bgmVolume}[bgm_vol]`);
                filterComplex.push(`[0:a]volume=1.0[orig_a]`);
                filterComplex.push(`[bgm_vol][orig_a]amix=inputs=2:normalize=0:duration=longest[final_audio]`);
            } else {
                filterComplex.push(`[${bgmInputIndex}:a]volume=${bgmVolume}[final_audio]`);
            }
        } else {
            if (!isMuted) {
                filterComplex.push(`[0:a]volume=1.0[final_audio]`);
            } else {
                filterComplex.push(`aevalsrc=0:d=1[final_audio]`);
            }
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
        const shouldBurnSubs = (burnSubtitles === true || burnSubtitles === 'true' || showSubtitles === true || showSubtitles === 'true') && burnSubtitles !== false && showSubtitles !== false;

        let validSrtPath = null;
        if (shouldBurnSubs) {
            const srtPath = path.join(tempDir, 'subtitles_burn.srt');
            let srtReady = false;

            if (typeof srtContent === 'string' && srtContent.trim().length > 0) {
                const cleanedSrt = sanitizeSrtContent(srtContent);
                if (cleanedSrt && cleanedSrt.trim().length > 0) {
                    fs.writeFileSync(srtPath, cleanedSrt, 'utf8');
                    srtReady = true;
                }
            }

            if (!srtReady && Array.isArray(subtitles) && subtitles.length > 0) {
                srtReady = createSrtFile(subtitles, srtPath);
            }

            if (srtReady && fs.existsSync(srtPath)) {
                try {
                    const stats = fs.statSync(srtPath);
                    if (stats.size > 0) {
                        validSrtPath = srtPath;
                    }
                } catch (e) {
                    validSrtPath = null;
                }
            }
        }

        if (validSrtPath) {
            const escapedSrtPath = escapeFfmpegFilterPath(validSrtPath);
            const fontsDir = escapeFfmpegFilterPath(path.join(__dirname, '..', 'frontend', 'fonts'));

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
                args.push('-i', validSrtPath);
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
        const ffmpeg = spawn(getFFmpegBinary(), args, { windowsHide: true });
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
