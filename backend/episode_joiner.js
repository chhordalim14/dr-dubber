// Join Episodes: turn a folder of short episodes (60-200+ files of 1-3 minutes) into
// a few ~1 hour parts that can be dubbed as single projects.
//
// Joining is where downloaded series usually break, so each part is built like this:
//   audio - every episode is decoded on its own (repairing mid-file AAC format changes,
//           picking the default track), resampled to 48kHz stereo, padded/trimmed to that
//           episode's exact length and streamed into ONE AAC encoder. The result can't
//           contain mixed formats and can't drift out of sync over 40 episodes.
//   video - stream-copied only when every episode has byte-identical video settings
//           (codec, size, frame rate, SPS/PPS). Otherwise each episode is first encoded
//           with one fixed set of settings, then those are joined. (Copy-joining
//           mismatched headers corrupts playback, exactly like mismatched audio.)
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.m4v', '.avi', '.wmv', '.flv', '.ts', '.m2ts', '.mts', '.webm', '.mpg', '.mpeg', '.3gp', '.vob', '.rmvb', '.rm', '.asf', '.f4v', '.ogv', '.divx']);
const AUDIO_RATE = 48000;
const MAX_EPISODES_PER_PART = 80; // keeps FFmpeg command lines well under Windows' 32KB limit

// Episode number from a filename: "EP12", "E12", "第12集", "Episode 12", "_part35", else
// the last number once tags like [1080p], (2024), x264 and 4K are removed.
function episodeNumber(fileName) {
    // "_", "-" and "." count as word characters for \b, so treat them as spaces first.
    const base = fileName.replace(/\.[^.]+$/, '').replace(/[_\-.]+/g, ' ');
    const tagged = base.match(/(?:\bep(?:isode)?|\be|第|\bpart|\bpt|集)\s*[-_.#]?\s*(\d{1,4})/i) || base.match(/(\d{1,4})\s*(?:集|話|话|回)/);
    if (tagged) return parseInt(tagged[1], 10);
    const cleaned = base
        .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, ' ')
        .replace(/\b\d{3,4}p\b|\b[248]k\b|\b[xh]\.?26[45]\b|\b(?:19|20)\d{2}\b/gi, ' ');
    const nums = cleaned.match(/\d+/g);
    return nums ? parseInt(nums[nums.length - 1], 10) : null;
}

function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function fmtClock(sec) {
    const s = Math.max(0, Math.round(sec));
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function createEpisodeJoiner({ getFFmpegBinary, getFFprobeBinary, detectAvailableEncoders, trackProcess, audioRepair }) {
    const jobs = new Map();

    const probe = (file) => new Promise((resolve) => {
        execFile(getFFprobeBinary(), ['-v', 'error', '-show_format', '-show_streams', '-show_data', '-of', 'json', file],
            { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
                if (err) return resolve({ error: (err.message || '').split('\n')[0] });
                try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ error: 'unreadable probe output' }); }
            });
    });

    function describe(info) {
        const streams = info.streams || [];
        const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        const audios = streams.filter(s => s.codec_type === 'audio');
        const a = audios.find(s => s.disposition && s.disposition.default) || audios[0];
        const duration = parseFloat(info.format && info.format.duration) || 0;
        return {
            duration,
            video: v ? {
                codec: v.codec_name, width: v.width, height: v.height, fps: v.r_frame_rate, pixFmt: v.pix_fmt,
                bitRate: parseInt(v.bit_rate || (info.format && info.format.bit_rate) || 0, 10) || 0,
                // Stream copy is only safe when the codec headers match exactly.
                signature: crypto.createHash('sha1').update(`${v.codec_name}|${v.codec_tag_string}|${v.profile}|${v.width}x${v.height}|${v.r_frame_rate}|${v.pix_fmt}|${String(v.extradata || '').replace(/\s+/g, '')}`).digest('hex'),
            } : null,
            audio: a ? { index: a.index, codec: a.codec_name, sampleRate: parseInt(a.sample_rate, 10), channels: a.channels } : null,
        };
    }

    async function scan(folder) {
        const entries = fs.readdirSync(folder, { withFileTypes: true })
            .filter(e => e.isFile() && !e.name.startsWith('.') && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()))
            .map(e => e.name);
        const files = entries.map(name => ({ name, path: path.join(folder, name), episode: episodeNumber(name) }));
        files.sort((a, b) => (a.episode ?? 1e9) - (b.episode ?? 1e9) || naturalCompare(a.name, b.name));

        // Probe 4 at a time.
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
            while (next < files.length) {
                const f = files[next++];
                const info = await probe(f.path);
                if (info.error) { f.error = info.error; continue; }
                Object.assign(f, describe(info));
                if (!f.video) f.error = 'no video stream';
                else if (!(f.duration > 0)) f.error = 'unknown duration';
            }
        }));

        const warnings = [];
        const nums = files.map(f => f.episode).filter(n => n !== null);
        const seen = new Map();
        nums.forEach(n => seen.set(n, (seen.get(n) || 0) + 1));
        const dupes = [...seen].filter(([, c]) => c > 1).map(([n]) => n);
        if (dupes.length) warnings.push(`Duplicate episode numbers: ${dupes.slice(0, 10).join(', ')}${dupes.length > 10 ? '…' : ''} - check the order.`);
        if (nums.length) {
            const min = Math.min(...nums), max = Math.max(...nums);
            const missing = [];
            for (let n = min; n <= max && missing.length < 50; n++) if (!seen.has(n)) missing.push(n);
            if (missing.length) warnings.push(`Missing episode${missing.length > 1 ? 's' : ''}: ${missing.slice(0, 15).join(', ')}${missing.length > 15 ? '…' : ''}`);
        }
        const unnumbered = files.filter(f => f.episode === null).length;
        if (unnumbered) warnings.push(`${unnumbered} file(s) have no episode number and were sorted by name.`);
        const broken = files.filter(f => f.error);
        if (broken.length) warnings.push(`${broken.length} file(s) can't be read and will be skipped: ${broken.slice(0, 5).map(f => f.name).join(', ')}${broken.length > 5 ? '…' : ''}`);

        return {
            folder,
            seriesName: path.basename(folder).replace(/[<>:"/\\|?*]+/g, '').trim() || 'Drama',
            files: files.map(f => ({ name: f.name, path: f.path, episode: f.episode, duration: f.duration || 0, error: f.error || null,
                video: f.video ? { codec: f.video.codec, width: f.video.width, height: f.video.height, fps: f.video.fps } : null,
                audio: f.audio ? { codec: f.audio.codec, sampleRate: f.audio.sampleRate, channels: f.audio.channels } : null })),
            totalDuration: files.reduce((s, f) => s + (f.error ? 0 : f.duration || 0), 0),
            warnings
        };
    }

    function runFFmpeg(job, args, { onProgressSec } = {}) {
        return new Promise((resolve) => {
            const proc = spawn(getFFmpegBinary(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            job.proc = proc;
            if (trackProcess) trackProcess(proc);
            let tail = '';
            proc.stdout.on('data', (d) => {
                const m = String(d).match(/out_time_us=(\d+)/g);
                if (m && onProgressSec) onProgressSec(parseInt(m[m.length - 1].split('=')[1], 10) / 1e6);
            });
            proc.stderr.on('data', (d) => { tail = (tail + d).slice(-3000); });
            proc.on('error', (e) => resolve({ code: -1, tail: e.message }));
            proc.on('close', (code) => { job.proc = null; resolve({ code, tail }); });
        });
    }

    const lastLine = (t) => String(t || '').split('\n').map(l => l.trim()).filter(Boolean).pop() || '';

    async function videoEncoderArgs(bitRate) {
        let enc = {};
        try { enc = await detectAvailableEncoders(); } catch (e) { }
        const kbps = Math.round(Math.min(12000, Math.max(2500, (bitRate || 5000000) * 1.3 / 1000)));
        if (enc.videotoolbox) return ['-c:v', 'h264_videotoolbox', '-b:v', `${kbps}k`, '-allow_sw', '1'];
        if (enc.nvenc) return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-b:v', `${kbps}k`];
        if (enc.qsv) return ['-c:v', 'h264_qsv', '-b:v', `${kbps}k`];
        if (enc.amf) return ['-c:v', 'h264_amf', '-b:v', `${kbps}k`];
        return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
    }

    // One continuous AAC track for the whole part, sample-accurate per episode.
    async function buildPartAudio(job, part, outPath, progress) {
        const encoder = spawn(getFFmpegBinary(), ['-hide_banner', '-nostdin', '-y', '-f', 's16le', '-ar', String(AUDIO_RATE), '-ac', '2', '-i', 'pipe:0',
            '-c:a', 'aac', '-b:a', '192k', '-f', 'mp4', outPath], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        job.encoder = encoder;
        if (trackProcess) trackProcess(encoder);
        let encTail = '';
        encoder.stderr.on('data', (d) => { encTail = (encTail + d).slice(-2000); });
        encoder.stdin.on('error', () => { });
        const encoderDone = new Promise((resolve) => { encoder.on('close', resolve); encoder.on('error', () => resolve(-1)); });
        try {
            for (const ep of part.episodes) {
                if (job.cancelled) throw new Error('cancelled');
                let src = { path: ep.path, repaired: false };
                if (audioRepair && ep.audio) src = await audioRepair.getAudioSource(ep.path).catch(() => src);
                if (src.repaired) job.repairedEpisodes.push(ep.name);
                const map = !ep.audio ? null : src.repaired ? '0:a:0' : (await audioRepair?.defaultAudioMap(ep.path)) || '0:a:0';
                const d = ep.duration.toFixed(6);
                // aresample=async pads a delayed audio start so each episode stays aligned to its video.
                const args = ['-hide_banner', '-nostdin', '-max_error_rate', '1'];
                if (map) args.push('-i', src.path, '-map', map, '-af', `aresample=${AUDIO_RATE}:async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=stereo,apad,atrim=end=${d}`);
                else args.push('-f', 'lavfi', '-i', `anullsrc=r=${AUDIO_RATE}:cl=stereo`, '-af', `atrim=end=${d}`);
                args.push('-f', 's16le', '-ar', String(AUDIO_RATE), '-ac', '2', 'pipe:1');
                const dec = spawn(getFFmpegBinary(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
                job.proc = dec;
                if (trackProcess) trackProcess(dec);
                await new Promise((resolve, reject) => {
                    dec.stdout.on('data', (chunk) => {
                        if (!encoder.stdin.write(chunk)) { dec.stdout.pause(); encoder.stdin.once('drain', () => dec.stdout.resume()); }
                    });
                    dec.on('error', reject);
                    dec.on('close', (code) => (code === 0 || job.cancelled) ? resolve() : reject(new Error(`audio of ${ep.name} could not be decoded (exit ${code})`)));
                });
                progress(ep.duration);
            }
        } finally {
            encoder.stdin.end();
        }
        const code = await encoderDone;
        job.encoder = null;
        if (job.cancelled) throw new Error('cancelled');
        if (code !== 0) throw new Error(`audio encoding failed: ${lastLine(encTail)}`);
    }

    async function buildPartVideo(job, part, workDir, outPath, progress) {
        const eps = part.episodes;
        const sameVideo = eps.every(e => e.video.signature === eps[0].video.signature);
        const copyable = sameVideo && ['h264', 'hevc'].includes(eps[0].video.codec);
        let sources = eps.map(e => e.path);
        if (!copyable) {
            // Encode every episode with identical settings (size/fps of the first episode),
            // so the pieces can then be joined without re-encoding.
            job.videoMode = 'converted';
            // Target the most common size/fps in the part (ties -> the larger), so one odd
            // low-res episode doesn't downscale the whole part.
            const mostCommon = (key) => {
                const counts = new Map();
                eps.forEach(e => counts.set(key(e), (counts.get(key(e)) || 0) + 1));
                return [...counts].sort((a, b) => b[1] - a[1] || String(b[0]).localeCompare(String(a[0]), undefined, { numeric: true }))[0][0];
            };
            const [w0, h0] = mostCommon(e => `${String(e.video.width).padStart(5, '0')}x${String(e.video.height).padStart(5, '0')}`).split('x').map(Number);
            const W = w0 % 2 ? w0 + 1 : w0;
            const H = h0 % 2 ? h0 + 1 : h0;
            const fpsCommon = mostCommon(e => e.video.fps || '30');
            const fps = fpsCommon && fpsCommon !== '0/0' ? fpsCommon : '30';
            const enc = await videoEncoderArgs(Math.max(...eps.map(e => e.video.bitRate || 0)));
            sources = [];
            for (let i = 0; i < eps.length; i++) {
                if (job.cancelled) throw new Error('cancelled');
                const out = path.join(workDir, `v${String(i).padStart(4, '0')}.mp4`);
                let done = 0;
                const r = await runFFmpeg(job, ['-hide_banner', '-nostdin', '-y', '-i', eps[i].path, '-map', '0:v:0', '-an', '-sn', '-dn',
                    '-vf', `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`,
                    ...enc, '-g', '48', '-t', eps[i].duration.toFixed(6), '-progress', 'pipe:1', '-nostats', out],
                    { onProgressSec: (s) => { progress(s - done); done = s; } });
                if (r.code !== 0) throw new Error(`could not convert ${eps[i].name}: ${lastLine(r.tail)}`);
                progress(Math.max(0, eps[i].duration - done));
                sources.push(out);
            }
        } else {
            job.videoMode = 'copied';
        }
        // Each episode occupies exactly its own duration on the timeline (matches the audio).
        const listFile = path.join(workDir, 'concat.txt');
        fs.writeFileSync(listFile, sources.map((p, i) => `file '${p.replace(/'/g, "'\\''")}'\nduration ${eps[i].duration.toFixed(6)}`).join('\n') + '\n');
        const r = await runFFmpeg(job, ['-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
            '-map', '0:v:0', '-c', 'copy', ...(eps[0].video.codec === 'hevc' && copyable ? ['-tag:v', 'hvc1'] : []), '-an', '-sn', '-dn', outPath]);
        if (r.code !== 0) throw new Error(`could not join video: ${lastLine(r.tail)}`);
    }

    async function runJob(job) {
        try {
            for (let p = 0; p < job.parts.length; p++) {
                if (job.cancelled) break;
                const part = job.parts[p];
                job.current = p;
                const workDir = path.join(job.outDir, `.join_tmp_${job.id.slice(0, 8)}_${p}`);
                fs.mkdirSync(workDir, { recursive: true });
                const partDur = part.episodes.reduce((s, e) => s + e.duration, 0);
                // Progress: audio pass + video pass (video pass is ~free when copied).
                let doneSec = 0;
                const weight = 2;
                const progress = (sec) => {
                    doneSec += Math.max(0, sec);
                    part.percent = Math.min(99, Math.round(doneSec / (partDur * weight) * 100));
                };
                try {
                    part.status = 'running';
                    const audioPath = path.join(workDir, 'audio.m4a');
                    const videoPath = path.join(workDir, 'video.mp4');
                    await buildPartAudio(job, part, audioPath, progress);
                    await buildPartVideo(job, part, workDir, videoPath, progress);
                    part.videoMode = job.videoMode;
                    const partial = part.outPath + '.part.mp4';
                    const r = await runFFmpeg(job, ['-hide_banner', '-nostdin', '-y', '-i', videoPath, '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0',
                        '-c', 'copy', '-movflags', '+faststart', '-shortest', partial]);
                    if (r.code !== 0) throw new Error(`could not combine audio and video: ${lastLine(r.tail)}`);
                    fs.renameSync(partial, part.outPath);
                    // Episode start times: handy for YouTube chapters and for finding an episode.
                    let t = 0;
                    const lines = part.episodes.map(e => { const l = `${fmtClock(t)} ${e.episode !== null ? `EP${e.episode}` : e.name}`; t += e.duration; return l; });
                    fs.writeFileSync(part.outPath.replace(/\.mp4$/i, '_episodes.txt'), lines.join('\n') + '\n');
                    part.status = 'done';
                    part.percent = 100;
                    console.log(`[Join] ${path.basename(part.outPath)}: ${part.episodes.length} episodes, ${fmtClock(partDur)}, video ${part.videoMode}`);
                } catch (e) {
                    if (job.cancelled) { part.status = 'cancelled'; break; }
                    part.status = 'error';
                    part.error = e.message;
                    console.warn(`[Join] Part ${p + 1} failed:`, e.message);
                } finally {
                    fs.rm(workDir, { recursive: true, force: true }, () => { });
                    fs.rm(part.outPath + '.part.mp4', { force: true }, () => { });
                }
            }
        } finally {
            job.status = job.cancelled ? 'cancelled' : job.parts.every(p => p.status === 'done') ? 'done' : 'finished_with_errors';
        }
    }

    // parts: [[filePath, ...], ...] in order (from the scan + the user's grouping)
    async function start({ parts, outDir, seriesName }) {
        if (!Array.isArray(parts) || !parts.length) throw new Error('No parts to join.');
        fs.mkdirSync(outDir, { recursive: true });
        const safeName = String(seriesName || 'Drama').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Drama';
        const job = { id: crypto.randomUUID(), status: 'running', current: 0, cancelled: false, proc: null, encoder: null, outDir, repairedEpisodes: [], parts: [] };
        for (let p = 0; p < parts.length; p++) {
            if (parts[p].length > MAX_EPISODES_PER_PART) throw new Error(`Part ${p + 1} has ${parts[p].length} episodes; the maximum is ${MAX_EPISODES_PER_PART}.`);
            const episodes = [];
            for (const file of parts[p]) {
                const info = await probe(file);
                if (info.error) continue;
                const d = describe(info);
                if (!d.video || !(d.duration > 0)) continue;
                episodes.push({ path: file, name: path.basename(file), episode: episodeNumber(path.basename(file)), ...d });
            }
            if (!episodes.length) continue;
            job.parts.push({ episodes, status: 'queued', percent: 0, error: null,
                outPath: path.join(outDir, `${safeName}_part${String(job.parts.length + 1).padStart(2, '0')}.mp4`) });
        }
        if (!job.parts.length) throw new Error('None of the selected files can be read.');
        jobs.set(job.id, job);
        runJob(job);
        return job.id;
    }

    function status(jobId) {
        const job = jobs.get(jobId);
        if (!job) return null;
        return {
            status: job.status, current: job.current, repairedEpisodes: job.repairedEpisodes,
            parts: job.parts.map(p => ({ status: p.status, percent: p.percent, error: p.error, outPath: p.outPath, videoMode: p.videoMode || null,
                episodes: p.episodes.length, duration: p.episodes.reduce((s, e) => s + e.duration, 0),
                first: p.episodes[0].episode, last: p.episodes[p.episodes.length - 1].episode }))
        };
    }

    function cancel(jobId) {
        const job = jobs.get(jobId);
        if (!job) return false;
        job.cancelled = true;
        for (const pr of [job.proc, job.encoder]) if (pr) { try { pr.kill('SIGKILL'); } catch (e) { } }
        return true;
    }

    return { scan, start, status, cancel, episodeNumber };
}

module.exports = { createEpisodeJoiner, episodeNumber };
