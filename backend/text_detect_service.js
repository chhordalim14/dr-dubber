// On-screen subtitle detection jobs: runs backend/python/text_detector.py for a video and
// keeps the result (when burned-in subtitles show, and where), for the render to blur.
//
// One detection runs at a time - it already uses every CPU core - and the others wait their
// turn. A video asked for again while it is queued or running joins that job, and a finished
// result is cached on disk per file (path, size, modification time), so asking again later
// (Continue, another export) is instant.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn: realSpawn, execFile: realExecFile } = require('child_process');
const { StringDecoder } = require('string_decoder');

const DETECTOR_VERSION = 4; // bump when text_detector.py's results change: old cached results are ignored
const JOB_KEEP_MS = 30 * 60 * 1000;

function createTextDetectService({
    pythonCmd, pythonEnv, scriptPath, requirementsPath, ffmpegPath, cacheDir,
    trackProcess = () => { }, killProcessTree = (c) => { try { c.kill(); } catch (e) { } },
    spawn = realSpawn, execFile = realExecFile, log = console,
}) {
    const jobs = new Map();      // id -> job
    const byVideo = new Map();   // cache key -> id of the job queued/running for it
    const queue = [];
    let running = null;
    let depsReady = null;        // Promise<true | error message>

    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) { }

    const cacheKey = (videoPath) => {
        const st = fs.statSync(videoPath);
        return crypto.createHash('sha1').update(`${DETECTOR_VERSION}|${path.resolve(videoPath)}|${st.size}|${st.mtimeMs}`).digest('hex');
    };
    const cacheFile = (key) => path.join(cacheDir, `${key}.json`);
    const readCache = (key) => {
        try { return JSON.parse(fs.readFileSync(cacheFile(key), 'utf8')); } catch (e) { return null; }
    };

    const run = (cmd, args) => new Promise((resolve) => {
        execFile(cmd, args, { env: pythonEnv, windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}` }));
    });

    // The detector's packages are in the bundled Python of an up-to-date install. An older
    // environment gets them once, at exact versions and without pip's own dependency
    // choices (see requirements-textdetect.txt).
    function ensureDeps() {
        if (depsReady) return depsReady;
        depsReady = (async () => {
            if (!pythonCmd) return 'No working Python environment was found for text detection.';
            const check = ['-c', 'import rapidocr_onnxruntime, cv2, onnxruntime'];
            if ((await run(pythonCmd, check)).ok) return true;
            log.warn('[Text detect] Detector packages missing - installing them into the app\'s Python...');
            const pip = await run(pythonCmd, ['-m', 'pip', 'install', '--no-deps', '--disable-pip-version-check', '--no-warn-script-location', '-q', '-r', requirementsPath]);
            if ((await run(pythonCmd, check)).ok) return true;
            depsReady = null; // try again next time (e.g. no internet just now)
            return `Text detection could not be installed: ${pip.out.trim().split(/\r?\n/).slice(-2).join(' ') || 'unknown error'}`;
        })();
        return depsReady;
    }

    const publicJob = (job) => ({
        success: true, jobId: job.id, status: job.status, progress: job.progress,
        ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}),
    });

    function finish(job, fields) {
        Object.assign(job, fields, { finishedAt: Date.now() });
        if (byVideo.get(job.key) === job.id) byVideo.delete(job.key);
        if (running === job) running = null;
        setTimeout(() => jobs.delete(job.id), JOB_KEEP_MS).unref?.();
        pump();
    }

    async function runJob(job) {
        running = job;
        job.status = 'running';
        const deps = await ensureDeps();
        if (job.status === 'cancelled') { if (running === job) running = null; pump(); return; }
        if (deps !== true) return finish(job, { status: 'error', error: deps });

        const child = spawn(pythonCmd, [scriptPath, job.videoPath, '--fps', '4'], {
            env: { ...pythonEnv, DR_FFMPEG_PATH: ffmpegPath }, windowsHide: true,
        });
        job.child = child;
        trackProcess(child);
        const dec = new StringDecoder('utf8');
        let buf = '', last = null, stderr = '';
        child.stdout.on('data', (d) => {
            buf += dec.write(d);
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                const m = line.match(/^PROGRESS (\d+) (\d+)$/);
                if (m) job.progress = Math.min(99, Math.round((Number(m[1]) / Math.max(1, Number(m[2]))) * 100));
                else if (line.startsWith('{')) { try { last = JSON.parse(line); } catch (e) { } }
            }
        });
        child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
        child.on('error', (err) => {
            if (job.status === 'running') finish(job, { status: 'error', error: `Could not start the text detector: ${err.message}` });
        });
        child.on('close', (code) => {
            job.child = null;
            if (job.status !== 'running') return; // cancelled meanwhile
            if (buf.trim().startsWith('{')) { try { last = JSON.parse(buf.trim()); } catch (e) { } }
            if (last && last.success) {
                const result = { row: last.row || null, segments: last.segments || [], lines: last.lines || [], width: last.width, height: last.height, duration: last.duration, seconds: last.seconds };
                try { fs.writeFileSync(cacheFile(job.key), JSON.stringify(result)); } catch (e) { }
                log.log(`[Text detect] ${path.basename(job.videoPath)}: ${result.segments.length} subtitle line(s)${result.row ? ` in the row at ${result.row.y}%` : ', no subtitles'} (${result.seconds}s)`);
                return finish(job, { status: 'done', progress: 100, result });
            }
            const error = (last && last.error) || stderr.trim().split(/\r?\n/).slice(-1)[0] || `Text detector exited with code ${code}`;
            log.warn(`[Text detect] ${path.basename(job.videoPath)} failed: ${error}`);
            finish(job, { status: 'error', error });
        });
    }

    function pump() {
        if (running) return;
        const next = queue.shift();
        if (next) runJob(next);
    }

    // Starts (or joins) detection for a video. Returns the job as the status call does.
    function start(videoPath) {
        let key;
        try { key = cacheKey(videoPath); } catch (e) { return { success: false, error: 'Video file not found.' }; }
        const id = `td_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
        const cached = readCache(key);
        if (cached) {
            const job = { id, key, videoPath, status: 'done', progress: 100, result: cached, createdAt: Date.now() };
            jobs.set(id, job);
            setTimeout(() => jobs.delete(id), JOB_KEEP_MS).unref?.();
            return publicJob(job);
        }
        const existing = byVideo.get(key) && jobs.get(byVideo.get(key));
        if (existing) return publicJob(existing);
        const job = { id, key, videoPath, status: 'queued', progress: 0, createdAt: Date.now() };
        jobs.set(id, job);
        byVideo.set(key, id);
        queue.push(job);
        pump();
        return publicJob(job);
    }

    function status(id) {
        const job = jobs.get(id);
        return job ? publicJob(job) : { success: false, status: 'unknown', error: 'Unknown job' };
    }

    function cancel(id) {
        const job = jobs.get(id);
        if (!job || job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return { success: true };
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        const child = job.child;
        finish(job, { status: 'cancelled', error: 'Cancelled' });
        if (child) killProcessTree(child);
        return { success: true };
    }

    return { start, status, cancel, ensureDeps, _jobs: jobs, _queue: queue };
}

module.exports = { createTextDetectService, DETECTOR_VERSION };
