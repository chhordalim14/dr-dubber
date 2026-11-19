// Holds the next heavy job (an export, Isolate BGM, Remove music, a subtitle search, a video
// preview) while the PC is short of free RAM and another job of ours is still running - that
// job ends and gives its memory back. Starting anyway is what froze small PCs: Windows pages
// to disk, then everything (the window too) crawls.
//
// Never holds when nothing of ours is running (there would be nothing to wait for), and never
// longer than MAX_HOLD_MS, so a job that hangs can't stop the others for good.
const os = require('os');
const { execFile } = require('child_process');

const MB = 1024 * 1024;
const MAX_HOLD_MS = 20 * 60 * 1000;
const POLL_MS = 3000;

// Free RAM each kind of job needs to start (measured peaks, rounded up).
const NEED_MB = {
    separation: 2000, // MDX-Net on the CPU 1.7 GB (0.9 GB on the GPU); Demucs about the same
    music: 2500,      // Remove music (Demucs CDX23) 1.9 GB on the CPU
    render: 800,      // one FFmpeg export
    textDetect: 800,  // one subtitle search
    preview: 500,     // one 720p preview conversion
};

// macOS: os.freemem() leaves out memory macOS frees on demand (inactive, purgeable, speculative
// pages), so a Mac with plenty to spare looks full. vm_stat has the real numbers.
function parseVmStat(text) {
    const page = Number((String(text).match(/page size of (\d+) bytes/) || [])[1]) || 4096;
    const count = (label) => {
        const m = String(text).match(new RegExp(`Pages ${label}:\\s+(\\d+)`));
        return m ? Number(m[1]) : 0;
    };
    const pages = count('free') + count('inactive') + count('speculative') + count('purgeable');
    return pages > 0 ? Math.round((pages * page) / MB) : null;
}

function createMemoryGuard({
    platform = process.platform,
    freemem = () => os.freemem(),
    run = execFile,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = console,
} = {}) {
    const activities = new Map(); // name -> () => number of our jobs of that kind running
    let macFreeMB = null;
    let macReadAt = -Infinity; // the first ask always reads
    let macReading = false;

    function refreshMac() {
        if (macReading || now() - macReadAt < 2000) return;
        macReading = true;
        try {
            run('/usr/bin/vm_stat', [], { timeout: 3000 }, (err, stdout) => {
                macReading = false;
                macReadAt = now();
                macFreeMB = err ? null : parseVmStat(stdout);
            });
        } catch (e) {
            macReading = false;
        }
    }

    // Free RAM in MB, or null when it isn't known (then nothing is held).
    function freeMB() {
        if (platform === 'darwin') {
            refreshMac();
            return macFreeMB;
        }
        const free = Number(freemem());
        return free > 0 ? Math.round(free / MB) : null;
    }

    function registerActivity(name, countFn) {
        activities.set(name, countFn);
    }

    function runningJobs() {
        let n = 0;
        for (const count of activities.values()) {
            try { n += Math.max(0, Number(count()) || 0); } catch (e) { }
        }
        return n;
    }

    // Why `kind` should wait now, or null to go ahead.
    function holdReason(kind) {
        const need = NEED_MB[kind] || 800;
        const free = freeMB();
        if (free == null || free >= need) return null;
        const running = runningJobs();
        if (running === 0) return null;
        return { freeMB: free, needMB: need, running };
    }

    // Waits until `kind` may start. isCancelled() ends the wait early (returns false); onWait is
    // called once, with the reason, when the job has to wait.
    async function waitForRoom(kind, { isCancelled = () => false, onWait = () => { } } = {}) {
        const started = now();
        let told = false;
        for (;;) {
            if (isCancelled()) return false;
            const reason = holdReason(kind);
            if (!reason) return true;
            if (now() - started >= MAX_HOLD_MS) {
                log.warn(`[Memory] ${kind} waited ${Math.round(MAX_HOLD_MS / 60000)} min for free RAM; starting anyway (${reason.freeMB} MB free).`);
                return true;
            }
            if (!told) {
                told = true;
                log.log(`[Memory] ${kind} waits: ${reason.freeMB} MB free, needs ${reason.needMB} MB, ${reason.running} job(s) still running.`);
                try { onWait(reason); } catch (e) { }
            }
            await sleep(POLL_MS);
        }
    }

    return { freeMB, registerActivity, runningJobs, holdReason, waitForRoom };
}

// One guard for the whole server: each module registers what it runs.
const shared = createMemoryGuard();

module.exports = { NEED_MB, MAX_HOLD_MS, parseVmStat, createMemoryGuard, memoryGuard: shared };
