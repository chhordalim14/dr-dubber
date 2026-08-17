const { spawn } = require('child_process');
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

function renderVideo(options, onProgress, onComplete, onError) {
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
        outputPath,
        videoColorAdj,
        colorAdjustments,
        videoVignette,
        isFlippedH,
        isFlippedV
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

        // 1. Build FFmpeg command arguments
        const args = ['-y'];

        // Main video input (input 0)
        args.push('-i', videoPath);

        // BGM input (input 1, if present)
        let bgmInputIndex = -1;
        if (bgmPath && fs.existsSync(bgmPath)) {
            args.push('-i', bgmPath);
            bgmInputIndex = 1;
        }

        // Subtitle audio inputs (inputs 2, 3, ...)
        const audioInputIndices = [];
        let nextInputIndex = bgmInputIndex >= 0 ? 2 : 1;

        for (const sub of validSubs) {
            const aPath = sub.file || sub.audioPath;
            args.push('-i', aPath);
            audioInputIndices.push({
                index: nextInputIndex++,
                startSec: parseTimeToSeconds(sub.audioStart || sub.textStart || sub.startTime || 0),
                volume: parseFloat(sub.volume || '1.0') || 1.0
            });
        }

        // 2. Build Filter Graph for Audio & Video
        const filterComplex = [];

        // Audio mixing
        if (audioInputIndices.length > 0) {
            const dubbedStreams = [];
            for (let i = 0; i < audioInputIndices.length; i++) {
                const item = audioInputIndices[i];
                const delayMs = Math.max(0, Math.round(item.startSec * 1000));
                const padName = `dub_${i}`;
                filterComplex.push(`[${item.index}:a]adelay=${delayMs}|${delayMs},volume=${voiceVolume}[${padName}]`);
                dubbedStreams.push(`[${padName}]`);
            }

            const totalDubbed = dubbedStreams.length;
            if (totalDubbed > 1) {
                filterComplex.push(`${dubbedStreams.join('')}amix=inputs=${totalDubbed}:normalize=0[dubbed_all]`);
            } else {
                filterComplex.push(`${dubbedStreams[0]}anull[dubbed_all]`);
            }

            if (bgmInputIndex >= 0) {
                const bgmVol = bgmVolume;
                if (duckingEnabled) {
                    filterComplex.push(`[${bgmInputIndex}:a]volume=${bgmVol}[bgm_vol]`);
                    filterComplex.push(`[bgm_vol][dubbed_all]sidechaincompress=threshold=0.08:ratio=6:attack=20:release=350[bgm_ducked]`);
                    // Spectral vocal bleed filter (cleans residual speech frequencies during dialogue)
                    filterComplex.push(`[bgm_ducked]equalizer=f=1100:t=q:w=1.5:g=-6[bgm_clean]`);
                    filterComplex.push(`[bgm_clean][dubbed_all]amix=inputs=2:normalize=0[final_audio]`);
                } else {
                    filterComplex.push(`[${bgmInputIndex}:a]volume=${bgmVol}[bgm_vol]`);
                    filterComplex.push(`[bgm_vol][dubbed_all]amix=inputs=2:normalize=0[final_audio]`);
                }
            } else {
                filterComplex.push(`[dubbed_all]anull[final_audio]`);
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
        const brightness = ca.brightness !== undefined ? (parseFloat(ca.brightness) - 100) / 100 : 0; // -1.0 to 1.0
        const contrast = ca.contrast !== undefined ? parseFloat(ca.contrast) / 100 : 1.0; // 0.0 to 2.0
        const saturation = ca.saturation !== undefined ? parseFloat(ca.saturation) / 100 : 1.0; // 0.0 to 2.0
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

        // Subtitles burning
        if (burnSubtitles && subtitles.length > 0) {
            const srtPath = path.join(tempDir, 'subtitles_burn.srt');
            createSrtFile(subtitles, srtPath);
            const escapedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
            const fontsDir = path.join(__dirname, '..', 'frontend', 'fonts').replace(/\\/g, '/').replace(/:/g, '\\:');
            
            const subStyle = `Fontname=${subtitleFont},Fontsize=${subtitleFontSize},PrimaryColour=${subtitleFontColor},OutlineColour=${subtitleOutlineColor},BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=30`;
            filterComplex.push(`${videoFilterStr}subtitles='${escapedSrtPath}':fontsdir='${fontsDir}':force_style='${subStyle}'[final_video]`);
        } else {
            filterComplex.push(`${videoFilterStr}null[final_video]`);
        }

        // Write complex filter to temp script file
        const filterScriptPath = path.join(tempDir, 'filter_complex.txt');
        fs.writeFileSync(filterScriptPath, filterComplex.join(';\n'), 'utf8');

        args.push('-filter_complex_script', filterScriptPath);
        args.push('-map', '[final_video]');
        args.push('-map', '[final_audio]');

        // Codec & Encoding settings
        args.push('-c:v', encoder === 'h264_qsv' ? 'h264_qsv' : 'libx264');
        args.push('-preset', 'fast');
        args.push('-crf', '20');
        args.push('-c:a', 'aac');
        args.push('-b:a', '192k');
        args.push('-pix_fmt', 'yuv420p');
        args.push(outputPath);

        console.log(`[Render] Spawning FFmpeg to render: ${outputPath}`);
        const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });
        activeRenderProcess = ffmpeg;

        ffmpeg.stderr.on('data', (data) => {
            const text = data.toString();
            const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
            if (timeMatch) {
                const currentSec = parseFloat(timeMatch[1]) * 3600 + parseFloat(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
                const progressPct = Math.min(99, Math.round((currentSec / 60) * 100));
                currentRenderJob.progress = progressPct;
                if (onProgress) onProgress(progressPct, 'Rendering...');
            }
        });

        ffmpeg.on('close', (code) => {
            activeRenderProcess = null;
            if (code === 0 && fs.existsSync(outputPath)) {
                currentRenderJob.status = 'done';
                currentRenderJob.progress = 100;
                if (onComplete) onComplete(outputPath);
            } else {
                currentRenderJob.status = 'error';
                currentRenderJob.error = `FFmpeg exited with code ${code}`;
                if (onError) onError(new Error(currentRenderJob.error));
            }
        });

        ffmpeg.on('error', (err) => {
            activeRenderProcess = null;
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
        activeRenderProcess.kill('SIGKILL');
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
    getRenderProgress
};
