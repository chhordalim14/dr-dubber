// How much the app does at once, from the PC it runs on.
//
// Every limit used to be the same on an 8 GB, 4-core laptop as on a 32 GB desktop (2 exports,
// 8 tabs transcribed, 2 previews...), so a small PC was overloaded and froze. The PC is put in
// one of three groups from its RAM and CPU threads, and each group has its own limits:
//   light    - under ~12 GB of RAM, or 4 CPU threads or fewer
//   standard - the rest (a 16 GB laptop: the limits the app always had)
//   strong   - 30 GB of RAM or more and 12 threads or more
// Settings > Performance can pick a group by hand ("auto" = from the hardware); the choice is
// kept in <storage>/performance.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MODES = ['auto', 'light', 'standard', 'strong'];
const GB = 1024 ** 3;

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

// The group a PC belongs in. Unknown values (0) never make a PC "light".
function tierFor({ ramGB = 0, cores = 0 } = {}) {
    if ((ramGB > 0 && ramGB < 11.5) || (cores > 0 && cores <= 4)) return 'light';
    if (ramGB >= 30 && cores >= 12) return 'strong';
    return 'standard';
}

// What each group may run at once. Standard keeps the numbers the app always had (measured on
// the 16 GB RTX 3060 laptop), so a PC like it works exactly as before.
//   renders        exports at once (measured 2026-11-08: 2 is where the gain is; with no
//                  hardware encoder two CPU exports only fight over the cores)
//   previews       video previews converted at once
//   isolateTabs    tabs Isolate BGM All separates at once (one separation takes 1-1.7 GB)
//   textDetect     subtitle searches at once (each keeps ~2.6 CPU threads busy)
//   transcribeCuts FFmpeg cuts for Transcribe at once, across every tab (each is an encode)
//   transcribeTabs tabs Dub Whole Series transcribes at once (its saved "Episodes at once" wins)
//   batchTabs      tabs Batch Transcribe works on at once
//   fitTabs        tabs shortened at once (Fit rushed lines)
//   voiceRequests  voice lines the window asks for at once
function limitsFor(tier, { ramGB = 0, cores = 0, hwEncoder = null } = {}) {
    const threads = cores > 0 ? cores : 4;
    if (tier === 'light') {
        // transcribeTabs 3: one of the "Episodes at once" choices, which shows it.
        return { renders: 1, previews: 1, isolateTabs: 1, textDetect: 1, transcribeCuts: 2, transcribeTabs: 3, batchTabs: 3, fitTabs: 3, voiceRequests: 3 };
    }
    return {
        renders: hwEncoder === false ? 1 : 2,
        previews: 2,
        // 16 GB or less: one tab at a time (two together froze a 16 GB Mac beside a series run).
        isolateTabs: tier === 'strong' || ramGB > 16.5 ? 2 : 1,
        textDetect: clamp(Math.floor(threads / 4), 1, 4),
        transcribeCuts: clamp(Math.floor(threads / 2), 2, 8),
        transcribeTabs: 8,
        batchTabs: 6,
        fitTabs: 6,
        voiceRequests: 5,
    };
}

function readHardware() {
    return { ramGB: Math.round((os.totalmem() / GB) * 10) / 10, cores: (os.cpus() || []).length };
}

// The NVIDIA GPU, if there is one (nvidia-smi comes with its driver). Shown in Settings only.
function readNvidiaGpu(run = execFile) {
    return new Promise((resolve) => {
        try {
            run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
                if (err || !stdout) return resolve(null);
                const [name, mem] = String(stdout).split(/\r?\n/)[0].split(',').map((s) => s.trim());
                const vramGB = Math.round((Number(mem) / 1024) * 10) / 10;
                resolve(name ? { name, vramGB: vramGB > 0 ? vramGB : null } : null);
            });
        } catch (e) {
            resolve(null);
        }
    });
}

function createPcProfile({ settingsFile, hardware = readHardware(), detectEncoders = null, readGpu = readNvidiaGpu } = {}) {
    let mode = 'auto';
    let hwEncoder = null; // unknown until the encoders are read: the standard 2 exports
    let gpu = null;
    let hwRead = null;

    try {
        const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        if (MODES.includes(saved && saved.mode)) mode = saved.mode;
    } catch (e) { /* none saved yet: auto */ }

    // The slower facts (GPU, hardware encoders) are read once in the background.
    function readSlowFacts() {
        if (!hwRead) {
            hwRead = Promise.all([
                Promise.resolve(readGpu()).then((g) => { gpu = g; }).catch(() => { }),
                detectEncoders
                    ? Promise.resolve(detectEncoders()).then((enc) => {
                        if (enc && typeof enc === 'object') hwEncoder = !!(enc.nvenc || enc.qsv || enc.amf || enc.videotoolbox);
                    }).catch(() => { })
                    : Promise.resolve(),
            ]);
        }
        return hwRead;
    }

    const detectedTier = () => tierFor(hardware);
    const tier = () => (mode === 'auto' ? detectedTier() : mode);
    const limits = () => limitsFor(tier(), { ...hardware, hwEncoder });

    function setMode(next) {
        if (!MODES.includes(next)) throw new Error(`Unknown performance mode "${next}"`);
        mode = next;
        try {
            fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
            const tmp = `${settingsFile}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ mode }));
            fs.renameSync(tmp, settingsFile);
        } catch (e) {
            console.warn(`[Performance] Could not save the choice: ${e.message}`);
        }
    }

    function describe() {
        return { mode, tier: tier(), detectedTier: detectedTier(), hardware: { ...hardware, gpu, hwEncoder }, limits: limits() };
    }

    return { tier, limits, setMode, describe, readSlowFacts, get mode() { return mode; } };
}

module.exports = { MODES, tierFor, limitsFor, readHardware, readNvidiaGpu, createPcProfile };
