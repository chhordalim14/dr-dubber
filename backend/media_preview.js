// Playable preview copies for any video/audio format.
//
// The editor previews media in Chromium, which only decodes a subset of formats
// (measured in Electron 28: no AC3/E-AC3/DTS/TrueHD/ALAC/WMA/MP2 audio, no MPEG-2/
// Xvid/WMV/ProRes/MJPEG/H.263 video, no TS/FLV/AVI/WMV/MPG/AIFF containers).
// Transcription and export read the original file through FFmpeg, which handles all
// of these, so only the preview needs converting - and we do the cheapest thing:
//   remux : codecs are fine, container isn't      -> copy streams into MP4 (seconds)
//   audio : video is fine, audio codec isn't      -> copy video, audio to AAC (fast)
//   video : video codec isn't playable            -> hardware H.264 720p + AAC
// Results are cached by (path, size, mtime), so reopening a file is instant.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const NATIVE_CONTAINERS = ['mov', 'mp4', 'm4a', 'matroska', 'webm', 'ogg', 'mp3', 'wav', 'flac'];
const NATIVE_VIDEO = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'theora']);
const NATIVE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8']);
const CACHE_VERSION = 1;
const MAX_CONCURRENT_JOBS = 2;

function createPreviewService({ previewDir, getFFmpegBinary, getFFprobeBinary, detectAvailableEncoders, trackProcess, audioRepair }) {
    fs.mkdirSync(previewDir, { recursive: true });
    const jobs = new Map();      // jobId -> job
    const jobsByKey = new Map(); // cacheKey -> jobId (dedupe: same file opened twice)
    const queue = [];
    let running = 0;

    function probe(filePath) {
        return new Promise((resolve, reject) => {
            execFile(getFFprobeBinary(), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
                { timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
                (err, stdout) => {
                    if (err) return reject(new Error(`Cannot read this media file (${err.message.split('\n')[0]})`));
                    try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
                });
        });
    }

    function describe(info) {
        const streams = info.streams || [];
        // Cover art in MP3/M4A shows up as an mjpeg/png "video" stream - it isn't video.
        const video = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        const audio = streams.find(s => s.codec_type === 'audio' && s.disposition && s.disposition.default) ||
            streams.find(s => s.codec_type === 'audio');
        const formats = String(info.format && info.format.format_name || '').split(',');
        return {
            container: formats[0] || 'unknown',
            nativeContainer: formats.some(f => NATIVE_CONTAINERS.includes(f)),
            video: video ? { index: video.index, codec: video.codec_name, width: video.width, height: video.height } : null,
            audio: audio ? { index: audio.index, codec: audio.codec_name, channels: audio.channels } : null,
            duration: parseFloat(info.format && info.format.duration) || 0
        };
    }

    // force: 'video' | 'audio' when the player reported it could not decode that part
    // even though the codec looked supported (e.g. HEVC without GPU decode on Windows).
    function plan(media, force) {
        if (!media.video && !media.audio) return { action: 'unsupported', reason: 'No audio or video streams found' };
        if (media.video && (force === 'video' || !NATIVE_VIDEO.has(media.video.codec))) {
            return { action: 'video', reason: `${String(media.video.codec).toUpperCase()} video` };
        }
        if (media.audio && (force === 'audio' || !NATIVE_AUDIO.has(media.audio.codec))) {
            return { action: 'audio', reason: `${String(media.audio.codec).toUpperCase()} audio` };
        }
        if (!media.nativeContainer) return { action: 'remux', reason: `${media.container.toUpperCase()} file` };
        if (force) return { action: 'video', reason: 'playback failed' };
        return { action: 'none' };
    }

    async function videoEncoderArgs() {
        let enc = {};
        try { enc = await detectAvailableEncoders(); } catch (e) { }
        if (enc.videotoolbox) return ['-c:v', 'h264_videotoolbox', '-b:v', '3000k', '-allow_sw', '1'];
        if (enc.nvenc) return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '3000k'];
        if (enc.qsv) return ['-c:v', 'h264_qsv', '-b:v', '3000k'];
        if (enc.amf) return ['-c:v', 'h264_amf', '-b:v', '3000k'];
        return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26'];
    }

    async function buildArgs(filePath, media, action, outPath, fixedAudioPath) {
        const args = ['-hide_banner', '-nostdin', '-y', '-i', filePath];
        if (fixedAudioPath) args.push('-i', fixedAudioPath);
        if (media.video) args.push('-map', `0:${media.video.index}`);
        if (fixedAudioPath) args.push('-map', '1:a:0');
        else if (media.audio) args.push('-map', `0:${media.audio.index}`);
        const audioToAac = ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'];
        // Chromium only plays HEVC-in-MP4 tagged hvc1 (not hev1).
        const copyVideo = ['-c:v', 'copy', ...(media.video && media.video.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])];
        if (action === 'remux') {
            args.push(...copyVideo, '-c:a', 'copy');
        } else if (action === 'audio') {
            args.push(...copyVideo, ...audioToAac);
        } else {
            // Preview only: 720p is plenty and keeps a 2-hour conversion fast.
            args.push('-vf', "scale=-2:'min(720,ih)':flags=fast_bilinear,format=yuv420p", ...(await videoEncoderArgs()), ...audioToAac);
        }
        args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', media.video ? 'mp4' : 'ipod', outPath);
        return args;
    }

    function cacheKey(filePath, stat, action) {
        return crypto.createHash('sha1').update(`${CACHE_VERSION}|${path.resolve(filePath)}|${stat.size}|${stat.mtimeMs}|${action}`).digest('hex').slice(0, 24);
    }

    function pump() {
        while (running < MAX_CONCURRENT_JOBS && queue.length) {
            const job = queue.shift();
            if (job.status !== 'queued') continue;
            running++;
            runJob(job).finally(() => { running--; pump(); });
        }
    }

    async function runJob(job) {
        job.status = 'running';
        const partPath = job.outPath + '.part';
        let args = await buildArgs(job.filePath, job.media, job.action, partPath, job.fixedAudioPath);
        const attempt = (argv) => new Promise((resolve) => {
            const proc = spawn(getFFmpegBinary(), argv, { windowsHide: true });
            job.proc = proc;
            if (trackProcess) trackProcess(proc);
            let stderr = '';
            proc.stdout.on('data', (d) => {
                const m = String(d).match(/out_time_(?:us|ms)=(\d+)/g);
                if (m && job.media.duration > 0) {
                    const us = parseInt(m[m.length - 1].split('=')[1], 10);
                    job.percent = Math.min(99, Math.round((us / 1e6 / job.media.duration) * 100));
                }
            });
            proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
            proc.on('error', (e) => resolve({ code: -1, stderr: e.message }));
            proc.on('close', (code) => resolve({ code, stderr }));
        });

        let result = await attempt(args);
        // Stream copy can fail for odd inputs (e.g. codecs MP4 can't hold): re-encode instead.
        if (result.code !== 0 && !job.cancelled && job.action !== 'video') {
            console.warn(`[Preview] ${job.action} failed, falling back to full conversion:`, result.stderr.split('\n').slice(-3).join(' '));
            job.action = 'video';
            args = await buildArgs(job.filePath, job.media, 'video', partPath, job.fixedAudioPath);
            result = await attempt(args);
        }
        job.proc = null;
        if (job.cancelled) {
            job.status = 'cancelled';
            fs.rm(partPath, { force: true }, () => { });
            return;
        }
        if (result.code === 0 && fs.existsSync(partPath)) {
            fs.renameSync(partPath, job.outPath);
            job.status = 'done';
            job.percent = 100;
            console.log(`[Preview] Ready (${job.action}): ${path.basename(job.filePath)}`);
        } else {
            job.status = 'error';
            job.error = (result.stderr || 'FFmpeg failed').split('\n').filter(Boolean).slice(-2).join(' ');
            fs.rm(partPath, { force: true }, () => { });
            console.warn('[Preview] Conversion failed:', job.error);
        }
        jobsByKey.delete(job.key);
    }

    async function check(filePath, force) {
        const stat = fs.statSync(filePath);
        const media = describe(await probe(filePath));
        let p = plan(media, force);
        // Audio that switches AAC format mid-file plays as silence/noise in those stretches:
        // preview with the repaired track (the video stream is still just copied).
        const fixed = audioRepair && media.audio ? await audioRepair.getAudioSource(filePath).catch(() => null) : null;
        const fixedAudioPath = fixed && fixed.repaired ? fixed.path : null;
        if (fixedAudioPath && (p.action === 'none' || p.action === 'remux')) {
            p = { action: 'audio', reason: 'Damaged audio (the format changes part-way through)' };
        }
        const info = { hasVideo: !!media.video, hasAudio: !!media.audio, videoCodec: media.video && media.video.codec, audioCodec: media.audio && media.audio.codec, container: media.container };
        if (p.action === 'none') return { needsConversion: false, media: info };
        if (p.action === 'unsupported') return { needsConversion: false, unsupported: true, reason: p.reason, media: info };

        const key = cacheKey(filePath, stat, p.action + (fixedAudioPath ? '+fixedaudio' : ''));
        const outPath = path.join(previewDir, `${key}${media.video ? '.mp4' : '.m4a'}`);
        const previewUrl = `/api/audio?path=${encodeURIComponent(outPath)}`;
        if (fs.existsSync(outPath)) {
            const now = Date.now() / 1000;
            fs.utimes(outPath, now, now, () => { }); // keep it off the stale-file sweep
            return { needsConversion: true, ready: true, previewUrl, action: p.action, reason: p.reason, media: info };
        }
        const existing = jobsByKey.get(key);
        if (existing && jobs.has(existing)) {
            const j = jobs.get(existing);
            return { needsConversion: true, ready: false, jobId: j.id, action: j.action, reason: j.reason, media: info };
        }
        const job = { id: crypto.randomUUID(), key, filePath, media, fixedAudioPath, action: p.action, reason: p.reason, outPath, previewUrl, status: 'queued', percent: 0, error: null, proc: null, cancelled: false, createdAt: Date.now() };
        jobs.set(job.id, job);
        jobsByKey.set(key, job.id);
        queue.push(job);
        console.log(`[Preview] ${path.basename(filePath)}: ${p.reason} -> ${p.action}`);
        pump();
        return { needsConversion: true, ready: false, jobId: job.id, action: job.action, reason: job.reason, media: info };
    }

    function status(jobId) {
        const job = jobs.get(jobId);
        if (!job) return null;
        return { status: job.status, percent: job.percent, action: job.action, reason: job.reason, error: job.error, previewUrl: job.status === 'done' ? job.previewUrl : null };
    }

    function cancel(jobId) {
        const job = jobs.get(jobId);
        if (!job) return false;
        job.cancelled = true;
        if (job.status === 'queued') job.status = 'cancelled';
        if (job.proc) { try { job.proc.kill('SIGKILL'); } catch (e) { } }
        jobsByKey.delete(job.key);
        return true;
    }

    // Forget finished jobs after an hour (the cached file itself stays on disk).
    setInterval(() => {
        const cutoff = Date.now() - 60 * 60 * 1000;
        for (const [id, job] of jobs) if (job.createdAt < cutoff && !['queued', 'running'].includes(job.status)) jobs.delete(id);
    }, 10 * 60 * 1000).unref();

    return { check, status, cancel };
}

module.exports = { createPreviewService };
