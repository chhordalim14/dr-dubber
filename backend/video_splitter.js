// Split Movie: cut one long movie (2-3 hours) into ~30 minute parts that are dubbed as
// separate projects. Each part transcribes/translates on its own, so a quota wall or a
// failed chunk only costs that part - finished parts are kept, and the rest can be done
// later (e.g. the next day, when the keys' daily quota has reset).
//
// Parts are stream-copied (no re-encode, takes seconds) with FFmpeg's segment muxer, so
// they are contiguous: no gap, no overlap, and joining the dubbed parts back together
// (Join Episodes) gives the original timeline. Copy cuts can only happen on a video
// keyframe, so each cut is placed on a keyframe that falls inside a quiet moment near the
// even-split point - a line of dialogue is not cut in half.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const SEARCH_WINDOW_SEC = 90;   // look up to this far either side of each even-split point...
const SEARCH_WINDOW_SHARE = 0.15; // ...but no more than 15% of a part, so short parts stay even
const MIN_PART_SEC = 60;
const COPY_EXTS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm']); // other containers are re-wrapped as .mkv

function fmtClock(sec) {
    const s = Math.max(0, Math.round(sec));
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function createVideoSplitter({ getFFmpegBinary, getFFprobeBinary, trackProcess }) {
    const jobs = new Map();

    const probe = (file) => new Promise((resolve) => {
        execFile(getFFprobeBinary(), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
            { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
                // ffprobe's own reason ("<path>: Invalid data found..."), without the path.
                if (err) return resolve({ error: String(stderr || '').split('\n').map(l => l.trim()).filter(Boolean).pop()?.replace(/^.*?:\s+(?=[A-Z])/, '') || 'unknown error' });
                try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ error: 'unreadable probe output' }); }
            });
    });

    async function inspect(file) {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('File not found.');
        const info = await probe(file);
        if (info.error) throw new Error(`This file can't be read as a video (${info.error}).`);
        const streams = info.streams || [];
        const v = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
        const duration = parseFloat(info.format && info.format.duration) || 0;
        if (!v) throw new Error('This file has no video stream.');
        if (!(duration > 0)) throw new Error('Could not read the video length.');
        return {
            path: file,
            name: path.basename(file),
            duration,
            startTime: parseFloat(info.format && info.format.start_time) || 0,
            videoIndex: v.index,
            audioTracks: streams.filter(s => s.codec_type === 'audio').length,
            video: { codec: v.codec_name, width: v.width, height: v.height },
        };
    }

    // Spawns a process, keeps a stderr tail, streams stdout lines to onLine.
    function run(job, bin, args, { onLine } = {}) {
        return new Promise((resolve) => {
            const proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            job.proc = proc;
            if (trackProcess) trackProcess(proc);
            let tail = '', buf = '';
            proc.stdout.on('data', (d) => {
                if (!onLine) return;
                buf += d;
                const lines = buf.split('\n');
                buf = lines.pop();
                lines.forEach(onLine);
            });
            proc.stderr.on('data', (d) => { tail = (tail + d).slice(-20000); });
            proc.on('error', (e) => resolve({ code: -1, tail: e.message }));
            proc.on('close', (code) => {
                if (onLine && buf) onLine(buf);
                job.proc = null;
                resolve({ code, tail });
            });
        });
    }

    const partPath = (job, num) => path.join(job.outDir, `${job.baseName}_part${String(num).padStart(2, '0')}${job.ext}`);

    const lastLine = (t) => String(t || '').split('\n').map(l => l.trim()).filter(Boolean).pop() || '';

    // Video keyframes inside the given windows, as { pts, dts } (absolute stream time). pts is
    // when the frame is shown - what the audio lines up with. dts is what the segment muxer
    // compares cut times against; with B-frames it runs a little behind pts (0.16s is common),
    // so cutting "at pts" would skip to the NEXT keyframe, seconds later. Reads packet headers
    // only, so it's fast even for a 3 hour file.
    async function keyframesIn(job, src, windows) {
        const intervals = windows.map(([a, b]) => `${a.toFixed(3)}%${b.toFixed(3)}`).join(',');
        const byPts = new Map();
        await run(job, getFFprobeBinary(), ['-v', 'error', '-select_streams', String(src.videoIndex), '-read_intervals', intervals,
            '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', src.path], {
            onLine: (line) => {
                const [ptsStr, dtsStr, flags] = line.trim().split(',');
                if (!flags || !flags.includes('K')) return;
                const pts = parseFloat(ptsStr), dts = parseFloat(dtsStr);
                const shown = Number.isFinite(pts) ? pts : dts;
                if (Number.isFinite(shown)) byPts.set(shown, Number.isFinite(dts) ? dts : shown);
            }
        });
        return [...byPts].map(([pts, dts]) => ({ pts, dts })).sort((a, b) => a.pts - b.pts);
    }

    // Speech-band loudness (dB) of every 0.1s block in [from, to], as [time, dB]. Dramas have
    // music under nearly all dialogue, so a fixed silence threshold rarely fires; comparing
    // blocks with each other finds the pauses between lines anyway. 300-3400 Hz is where
    // voices are. Times come from FFmpeg, not from counting blocks: damaged downloads have
    // stretches that don't decode, and those leave gaps rather than shifting everything after.
    async function loudnessIn(job, src, from, to) {
        const blocks = [];
        let t = null;
        // -ss is relative to the file start; `from` is stream time (keyframe times are too).
        await run(job, getFFmpegBinary(), ['-hide_banner', '-nostats', '-loglevel', 'error', '-max_error_rate', '1',
            '-ss', Math.max(0, from - src.startTime).toFixed(3), '-t', (to - from).toFixed(3), '-i', src.path,
            '-vn', '-sn', '-dn', '-af', 'aresample=16000,aformat=channel_layouts=mono,highpass=f=300,lowpass=f=3400,asetnsamples=n=1600:p=0,' +
            'astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
            '-f', 'null', '-'], {
            onLine: (line) => {
                const p = line.match(/pts_time:(-?[\d.]+)/);
                if (p) t = from + parseFloat(p[1]);
                const m = line.match(/RMS_level=(\S+)/);
                if (m && t !== null) blocks.push([t, Math.max(-120, parseFloat(m[1]) || -120)]); // "-inf" = digital silence
            }
        });
        return blocks;
    }

    // Best keyframe near `target`: the one in the quietest spot (loudness at the cut, and a
    // little around it), with a small pull towards the even-split point (0.05 dB per second
    // away). "quiet" means the cut is clearly below the typical loudness around it - a pause,
    // not a word.
    function pickCut(target, keyframes, loud, lo, hi) {
        const cands = keyframes.map(k => k.pts).filter(k => k > lo && k < hi);
        if (!cands.length) return null;
        const closest = cands.reduce((a, b) => Math.abs(b - target) < Math.abs(a - target) ? b : a);
        if (!loud.length) return { time: closest, dts: keyframes.find(k => k.pts === closest).dts, quiet: false }; // no audio, or none of it decodes
        const sorted = loud.map(b => b[1]).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        // Loudest 0.1s block within `reach` of k. No decodable audio there -> unknown, counted as typical.
        const peakNear = (k, reach = 0.3) => {
            let peak = null;
            for (const [bt, db] of loud) if (bt > k - reach - 0.1 && bt < k + reach) peak = peak === null ? db : Math.max(peak, db);
            return peak === null ? median : peak;
        };
        let best = closest, bestScore = Infinity;
        for (const k of cands) {
            // Mostly "is the cut itself in a pause" (±0.1s), partly "is there room around it" (±0.3s).
            const score = 0.6 * peakNear(k, 0.1) + 0.4 * peakNear(k, 0.3) + Math.abs(k - target) * 0.05;
            if (score < bestScore) { best = k; bestScore = score; }
        }
        // Choosing uses ±0.3s so cuts keep a margin; "quiet" only asks whether the cut itself
        // is in a pause, so a keyframe 0.2s before the next line isn't flagged.
        const peak = peakNear(best, 0.1);
        return { time: best, dts: keyframes.find(k => k.pts === best).dts, quiet: peak <= -50 || peak <= median - 10 };
    }

    async function runJob(job) {
        const { src } = job;
        try {
            // 1. Choose cut points.
            job.phase = 'analyzing';
            const n = job.partCount;
            const targets = Array.from({ length: n - 1 }, (_, i) => src.startTime + (i + 1) * src.duration / n);
            const reach = Math.min(SEARCH_WINDOW_SEC, SEARCH_WINDOW_SHARE * src.duration / n);
            const windows = targets.map(t => [Math.max(src.startTime, t - reach), Math.min(src.startTime + src.duration, t + reach)]);
            const keyframes = targets.length ? await keyframesIn(job, src, windows) : [];
            if (job.cancelled) throw new Error('cancelled');
            const cuts = [];
            for (let i = 0; i < targets.length; i++) {
                if (job.cancelled) throw new Error('cancelled');
                const [from, to] = windows[i];
                const loud = await loudnessIn(job, src, from, to);
                const prev = cuts.length ? cuts[cuts.length - 1].time : src.startTime;
                const cut = pickCut(targets[i], keyframes, loud, Math.max(from, prev + MIN_PART_SEC), Math.min(to, src.startTime + src.duration - MIN_PART_SEC));
                if (cut) cuts.push(cut);
                job.percent = Math.round((i + 1) / targets.length * 15);
            }

            // 2. Cut, stream copy. segment_times are relative to the output timeline, which
            // FFmpeg starts at 0 (the input's start_time is subtracted), and are compared with
            // the keyframe's dts. Aim a hair early: the muxer cuts on the first keyframe at or
            // after each time, and the keyframe before is always seconds earlier.
            job.phase = 'splitting';
            const times = cuts.map(c => Math.max(0.01, c.dts - src.startTime - 0.01).toFixed(3));
            const pattern = path.join(job.outDir, `${job.baseName.replace(/%/g, '%%')}_part%02d${job.ext}`);
            const args = ['-hide_banner', '-nostdin', '-y', '-i', src.path,
                '-map', `0:${src.videoIndex}`, '-map', '0:a?', '-sn', '-dn', '-c', 'copy',
                '-f', 'segment', '-reset_timestamps', '1', '-avoid_negative_ts', 'make_zero', '-segment_start_number', '1'];
            if (times.length) args.push('-segment_times', times.join(','));
            else args.push('-segment_time', String(Math.ceil(src.duration + 60)));
            if (job.ext === '.mp4' || job.ext === '.m4v' || job.ext === '.mov') {
                args.push('-segment_format_options', 'movflags=+faststart');
                if (src.video.codec === 'hevc') args.push('-tag:v', 'hvc1');
            }
            args.push('-progress', 'pipe:1', '-nostats', pattern);
            const r = await run(job, getFFmpegBinary(), args, {
                onLine: (line) => {
                    const m = line.match(/^out_time_us=(\d+)/);
                    if (m) job.percent = Math.min(99, 15 + Math.round(parseInt(m[1], 10) / 1e6 / src.duration * 84));
                }
            });
            if (job.cancelled) throw new Error('cancelled');
            if (r.code !== 0) throw new Error(`FFmpeg could not split the video: ${lastLine(r.tail)}`);

            // 3. Report what was written. Durations come from the files themselves.
            const bounds = [src.startTime, ...cuts.map(c => c.time), src.startTime + src.duration];
            let offset = 0;
            for (let i = 0; i < bounds.length - 1; i++) {
                const file = partPath(job, i + 1);
                if (!fs.existsSync(file)) continue;
                const info = await probe(file);
                const duration = parseFloat(info.format && info.format.duration) || (bounds[i + 1] - bounds[i]);
                job.parts.push({ outPath: file, start: offset, duration, quietCut: i === 0 ? true : cuts[i - 1].quiet });
                offset += duration;
            }
            if (!job.parts.length) throw new Error('No parts were written.');
            const lines = job.parts.map((p, i) => `Part ${String(i + 1).padStart(2, '0')}  ${fmtClock(p.start)} - ${fmtClock(p.start + p.duration)}  (${fmtClock(p.duration)})  ${path.basename(p.outPath)}`);
            fs.writeFileSync(path.join(job.outDir, `${job.baseName}_parts.txt`),
                `${src.name}\nSplit into ${job.parts.length} parts. After dubbing, render each part and join them with Join Episodes to get the full movie back.\n\n${lines.join('\n')}\n`);
            job.percent = 100;
            job.status = 'done';
            console.log(`[Split] ${src.name}: ${job.parts.length} parts (${cuts.filter(c => c.quiet).length}/${cuts.length} cuts on a quiet moment)`);
        } catch (e) {
            if (job.cancelled) {
                job.status = 'cancelled';
                // Don't leave half-written parts behind.
                for (let i = 1; i <= job.partCount; i++) fs.rmSync(partPath(job, i), { force: true });
            } else {
                job.status = 'error';
                job.error = e.message;
                console.warn('[Split] Failed:', e.message);
            }
        }
    }

    async function start({ file, outDir, partCount, baseName }) {
        const src = await inspect(file);
        const n = Math.max(1, Math.min(40, Math.round(Number(partCount) || 1)));
        if (n > 1 && src.duration / n < MIN_PART_SEC * 2) throw new Error('Parts would be too short. Choose fewer parts.');
        fs.mkdirSync(outDir, { recursive: true });
        const srcExt = path.extname(src.path).toLowerCase();
        const safeName = String(baseName || path.basename(src.path, srcExt)).replace(/[<>:"/\\|?*]+/g, '').trim() || 'Movie';
        const job = { id: crypto.randomUUID(), status: 'running', phase: 'analyzing', percent: 0, error: null, cancelled: false, proc: null,
            src, outDir, partCount: n, baseName: safeName, ext: COPY_EXTS.has(srcExt) ? srcExt : '.mkv', parts: [] };
        jobs.set(job.id, job);
        runJob(job);
        return job.id;
    }

    function status(jobId) {
        const job = jobs.get(jobId);
        if (!job) return null;
        return {
            status: job.status, phase: job.phase, percent: job.percent, error: job.error, outDir: job.outDir,
            parts: job.parts.map(p => ({ outPath: p.outPath, start: p.start, duration: p.duration, quietCut: p.quietCut }))
        };
    }

    function cancel(jobId) {
        const job = jobs.get(jobId);
        if (!job) return false;
        job.cancelled = true;
        if (job.proc) { try { job.proc.kill('SIGKILL'); } catch (e) { } }
        return true;
    }

    return { inspect, start, status, cancel };
}

module.exports = { createVideoSplitter };
