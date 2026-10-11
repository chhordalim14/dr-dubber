// One long-running `tts_generator.py --serve` process for /api/generate-audio, instead of
// starting Python (and importing edge_tts) for every voice line. Measured on 12 Khmer lines:
// 10.3s as separate processes 3 at a time, 1.7s through one process 6 at a time.
//
// request() sends one line and resolves with the generator's result ({ success, file,
// duration, ... }). A worker that dies fails only the lines it was working on (the app
// retries them) and is started again on the next request. If it keeps dying before it ever
// answers (e.g. an old Python without asyncio support), usable() turns false and the server
// goes back to one process per line.
const { StringDecoder } = require('string_decoder');

const MAX_FAILED_STARTS = 3;

function createTtsWorker({ spawnWorker, maxInFlight = 6, timeoutMs = 120000, onLog = () => { } }) {
    let child = null;
    let nextId = 1;
    let failedStarts = 0; // deaths in a row without a single answer
    let answeredSinceStart = false;
    const pending = new Map(); // id -> { resolve, timer }
    const waiting = []; // requests queued until a slot is free: { id, msg, resolve }

    function failAll(error) {
        for (const [id, job] of pending) {
            clearTimeout(job.timer);
            job.resolve({ success: false, error, workerDied: true, id });
        }
        pending.clear();
    }

    function start() {
        let proc;
        try {
            proc = spawnWorker();
        } catch (e) {
            failedStarts++;
            return null;
        }
        answeredSinceStart = false;
        const out = new StringDecoder('utf8');
        const err = new StringDecoder('utf8');
        let outBuf = '';
        let errBuf = '';
        proc.stdout.on('data', (d) => {
            outBuf += out.write(d);
            let nl;
            while ((nl = outBuf.indexOf('\n')) >= 0) {
                const line = outBuf.slice(0, nl).trim();
                outBuf = outBuf.slice(nl + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch (e) { continue; }
                const job = pending.get(msg.id);
                if (!job) continue; // timed out or cancelled already
                answeredSinceStart = true;
                failedStarts = 0;
                pending.delete(msg.id);
                clearTimeout(job.timer);
                job.resolve(msg);
                pump();
            }
        });
        proc.stderr.on('data', (d) => {
            errBuf += err.write(d);
            let nl;
            while ((nl = errBuf.indexOf('\n')) >= 0) {
                const line = errBuf.slice(0, nl).trim();
                errBuf = errBuf.slice(nl + 1);
                if (line) onLog(line);
            }
        });
        // EPIPE when writing to a worker that just died: 'close' below handles it.
        proc.stdin.on('error', () => { });
        let ended = false;
        const onEnd = (why) => {
            if (ended) return;
            ended = true;
            if (child === proc) child = null;
            if (!answeredSinceStart) failedStarts++;
            failAll(`The voice generator stopped (${why}).${errBuf.trim() ? ` ${errBuf.trim().slice(-300)}` : ''}`);
            pump();
        };
        proc.on('error', (e) => onEnd(e.message));
        proc.on('close', (code) => onEnd(`exit code ${code}`));
        return proc;
    }

    function pump() {
        while (waiting.length && pending.size < maxInFlight) {
            if (!child) child = start();
            if (!child) {
                waiting.splice(0).forEach((w) => w.resolve({ success: false, error: 'Could not start the voice generator.', workerDied: true, id: w.id }));
                return;
            }
            const w = waiting.shift();
            const timer = setTimeout(() => {
                if (!pending.has(w.id)) return;
                pending.delete(w.id);
                send({ cancel: w.id });
                w.resolve({ success: false, error: `TTS request timed out after ${Math.round(timeoutMs / 1000)}s`, id: w.id });
                pump();
            }, timeoutMs);
            pending.set(w.id, { resolve: w.resolve, timer });
            send(w.msg);
        }
    }

    function send(obj) {
        if (!child) return;
        try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) { }
    }

    // task: { text, voice, rate, pitch, volume, output }. Returns { promise, cancel }.
    function request(task) {
        const id = String(nextId++);
        let resolveFn;
        const promise = new Promise((resolve) => { resolveFn = resolve; });
        waiting.push({ id, msg: { id, ...task }, resolve: resolveFn });
        pump();
        const cancel = () => {
            const qi = waiting.findIndex((w) => w.id === id);
            if (qi >= 0) {
                waiting.splice(qi, 1);
                resolveFn({ success: false, error: 'cancelled', cancelled: true, id });
                return;
            }
            const job = pending.get(id);
            if (!job) return;
            pending.delete(id);
            clearTimeout(job.timer);
            send({ cancel: id });
            job.resolve({ success: false, error: 'cancelled', cancelled: true, id });
            pump();
        };
        return { promise, cancel };
    }

    return {
        request,
        usable: () => failedStarts < MAX_FAILED_STARTS,
        stop: () => { if (child) { try { child.stdin.end(); child.kill(); } catch (e) { } } },
        _state: () => ({ pending: pending.size, waiting: waiting.length, failedStarts, running: !!child }),
    };
}

module.exports = { createTtsWorker, MAX_FAILED_STARTS };
