// One-click VoxCPM2 install (Settings -> VoxCPM2 AI -> Install VoxCPM2). Runs in the
// main process. Builds a self-contained folder that "Start Server" already knows how
// to run (main.js voxcpm2:startServer looks for app.py and venv\Scripts\python.exe):
//
//   <dir>/venv/          private Python (3.10-3.12) with PyTorch + voxcpm
//   <dir>/cache/         HF_HOME: the model, and pip's cache
//   <dir>/app.py         backend/python/voxcpm2_server.py (the API the app speaks)
//   <dir>/drdubber-voxcpm2.json   what was installed, for the Settings card
//
// Every step is safe to run again, so the same button also resumes or repairs.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const MODEL_ID = 'openbmb/VoxCPM2';
const MARKER = 'drdubber-voxcpm2.json';
const TORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu124';
const TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu';
const MIN_CUDA_VRAM_MB = 6000; // VoxCPM2 (2B, bf16) wants about 8 GB; under 6 it runs out
const NEED_FREE_GB = 12;
const STALL_MS = 120000; // model download with no new bytes for this long is restarted
const MODEL_TRIES = 4;
const isWin = process.platform === 'win32';

// Weights of each step in the overall bar (they add up to 100).
const STEPS = [
    { id: 'python', label: 'Checking Python', w: 2 },
    { id: 'venv', label: 'Creating a private Python environment', w: 4 },
    { id: 'torch', label: 'Installing PyTorch', w: 30 },
    { id: 'voxcpm', label: 'Installing VoxCPM2', w: 14 },
    { id: 'model', label: 'Downloading the VoxCPM2 model', w: 48 },
    { id: 'finish', label: 'Finishing', w: 2 },
];

function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 20000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
            resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || '').trim() });
        });
    });
}

const venvPython = (dir) => (isWin ? path.join(dir, 'venv', 'Scripts', 'python.exe') : path.join(dir, 'venv', 'bin', 'python'));

async function pythonVersion(cmd, pre = []) {
    const r = await run(cmd, [...pre, '-c', 'import sys, venv; print("%d.%d" % sys.version_info[:2]); print(sys.executable)']);
    if (!r.ok) return null;
    const [ver, exe] = r.out.split(/\r?\n/);
    const [maj, min] = String(ver).split('.').map(Number);
    return { version: ver, exe: (exe || '').trim(), ok: maj === 3 && min >= 10 && min <= 12 };
}

// A Python VoxCPM2 supports (3.10-3.12): the py launcher's newest first, then PATH.
async function findPython() {
    const tries = isWin
        ? [['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']], ['python', []], ['python3', []]]
        : [['python3.12', []], ['python3.11', []], ['python3.10', []], ['python3', []], ['python', []]];
    let seen = null;
    for (const [cmd, pre] of tries) {
        const v = await pythonVersion(cmd, pre);
        if (v && v.ok) return { cmd: v.exe || cmd, version: v.version };
        if (v && !seen) seen = v.version;
    }
    return { cmd: null, version: seen };
}

async function findNvidia() {
    const r = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
    if (!r.ok || !r.out) return null;
    const [name, mem] = r.out.split(/\r?\n/)[0].split(',').map((s) => s.trim());
    return { name, vramMB: Number(mem) || 0 };
}

async function freeGB(dir) {
    try {
        let p = dir;
        while (p && !fs.existsSync(p)) p = path.dirname(p);
        const st = await fs.promises.statfs(p);
        return (st.bavail * st.bsize) / 1024 ** 3;
    } catch (e) {
        return null;
    }
}

function readMarker(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); } catch (e) { return null; }
}

function isInstalled(dir) {
    return !!(dir && fs.existsSync(path.join(dir, 'app.py')) && fs.existsSync(venvPython(dir)) && readMarker(dir)?.complete);
}

function createVoxcpmInstaller({ scriptsDir, killProcessTree, approveProgram }) {
    let job = null; // { child, cancelled }

    async function info(dir) {
        const [py, gpu, free] = await Promise.all([findPython(), findNvidia(), freeGB(dir)]);
        const useCuda = !!(gpu && gpu.vramMB >= MIN_CUDA_VRAM_MB);
        return {
            dir,
            installed: isInstalled(dir),
            marker: readMarker(dir),
            python: py,
            gpu,
            device: useCuda ? 'cuda' : 'cpu',
            freeGB: free,
            needGB: NEED_FREE_GB,
            downloadGB: useCuda ? 7.5 : 5,
            running: !!job,
        };
    }

    // Streams a child's output line by line (pip and huggingface print with \r too).
    function stream(cmd, args, { env, cwd, onLine }) {
        return new Promise((resolve, reject) => {
            if (job.cancelled) return reject(Object.assign(new Error('Install cancelled.'), { cancelled: true }));
            const child = spawn(cmd, args, { env, cwd, windowsHide: true });
            job.child = child;
            let tail = '';
            const feed = (d) => {
                String(d).split(/\r?\n|\r/).forEach((l) => {
                    const line = l.trim();
                    if (!line) return;
                    tail = (tail + '\n' + line).slice(-4000);
                    onLine(line);
                });
            };
            child.stdout.on('data', feed);
            child.stderr.on('data', feed);
            child.on('error', reject);
            child.on('close', (code) => {
                job.child = null;
                if (job.cancelled) return reject(Object.assign(new Error('Install cancelled.'), { cancelled: true }));
                if (code === 0) return resolve();
                const last = tail.split('\n').filter(Boolean).slice(-3).join(' · ');
                reject(new Error(`${path.basename(cmd)} exited with code ${code}${last ? `: ${last}` : ''}`));
            });
        });
    }

    async function install(dir, onProgress) {
        if (job) throw new Error('VoxCPM2 is already being installed.');
        job = { child: null, cancelled: false };
        let done = 0; // weight of finished steps
        const step = (id, frac = 0, extra = {}) => {
            const s = STEPS.find((x) => x.id === id);
            onProgress({ step: id, label: extra.label || s.label, pct: Math.min(100, done + s.w * Math.max(0, Math.min(1, frac))), ...extra });
        };
        const finish = (id) => { done += STEPS.find((x) => x.id === id).w; step(id, 0); };
        const line = (id) => (text) => onProgress({ step: id, line: text });
        try {
            fs.mkdirSync(path.join(dir, 'cache', 'pip'), { recursive: true });
            const env = {
                ...process.env,
                HF_HOME: path.join(dir, 'cache'),
                PIP_CACHE_DIR: path.join(dir, 'cache', 'pip'),
                PIP_DISABLE_PIP_VERSION_CHECK: '1',
                PYTHONUTF8: '1',
                PYTHONUNBUFFERED: '1',
                // Hugging Face's newer "Xet" transfer stalled on a slow line ("connection
                // struggling", stuck at 70 MB); plain HTTP downloads steadily and resumes.
                HF_HUB_DISABLE_XET: '1',
            };
            delete env.PYTHONHOME;
            delete env.PYTHONPATH;

            // 1. Python
            step('python');
            const free = await freeGB(dir);
            if (free != null && free < NEED_FREE_GB) throw new Error(`Only ${free.toFixed(1)} GB free on that drive; VoxCPM2 needs about ${NEED_FREE_GB} GB. Pick another folder or free some space.`);
            const gpu = await findNvidia();
            const useCuda = !!(gpu && gpu.vramMB >= MIN_CUDA_VRAM_MB);
            let py = fs.existsSync(venvPython(dir)) ? { cmd: venvPython(dir), version: (await pythonVersion(venvPython(dir)))?.version } : null;
            if (!py || !py.version) {
                const found = await findPython();
                if (!found.cmd) {
                    throw Object.assign(new Error(found.version
                        ? `Python ${found.version} is installed, but VoxCPM2 needs Python 3.10, 3.11 or 3.12.`
                        : 'Python is not installed. VoxCPM2 needs Python 3.10, 3.11 or 3.12.'), { needPython: true });
                }
                py = found;
            }
            onProgress({ step: 'python', line: `Python ${py.version} · ${useCuda ? `NVIDIA ${gpu.name} (${Math.round(gpu.vramMB / 1024)} GB): GPU build` : gpu ? `NVIDIA ${gpu.name} has under 6 GB: CPU build` : 'no NVIDIA GPU: CPU build'}` });
            finish('python');

            // 2. venv
            step('venv');
            if (!fs.existsSync(venvPython(dir))) {
                await stream(py.cmd, ['-m', 'venv', path.join(dir, 'venv')], { env, cwd: dir, onLine: line('venv') });
            }
            const vpy = venvPython(dir);
            await stream(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools'], { env, cwd: dir, onLine: line('venv') });
            finish('venv');

            // 3. PyTorch: progress from the "Downloading … (N MB)" lines pip prints.
            const torchIndex = useCuda ? TORCH_CUDA_INDEX : TORCH_CPU_INDEX;
            step('torch', 0, { label: `Installing PyTorch (${useCuda ? 'NVIDIA GPU' : 'CPU'})` });
            let pkgs = 0;
            await stream(vpy, ['-m', 'pip', 'install', 'torch>=2.5', 'torchaudio>=2.5', '--index-url', torchIndex], {
                env, cwd: dir,
                onLine: (t) => {
                    if (/^(Downloading|Collecting)\b/.test(t)) step('torch', Math.min(0.95, ++pkgs / 24), { label: `Installing PyTorch (${useCuda ? 'NVIDIA GPU' : 'CPU'})` });
                    line('torch')(t);
                },
            });
            finish('torch');

            // 4. voxcpm (the same torch index stays available, so pip keeps that build)
            step('voxcpm');
            pkgs = 0;
            await stream(vpy, ['-m', 'pip', 'install', '--upgrade', 'voxcpm', 'soundfile', 'numpy', 'huggingface_hub', 'psutil', '--extra-index-url', torchIndex], {
                env, cwd: dir,
                onLine: (t) => {
                    if (/^(Downloading|Collecting)\b/.test(t)) step('voxcpm', Math.min(0.95, ++pkgs / 60));
                    line('voxcpm')(t);
                },
            });
            finish('voxcpm');

            // 5. the model, with a real byte progress
            const fetchScript = path.join(dir, 'fetch_model.py');
            fs.copyFileSync(path.join(scriptsDir, 'voxcpm2_fetch_model.py'), fetchScript);
            step('model');
            // A download that stops moving for STALL_MS is restarted; it resumes from the
            // partial file, so a flaky connection costs a restart, not the whole 4.6 GB.
            for (let attempt = 1; ; attempt++) {
                let lastBytes = -1;
                let lastMove = Date.now();
                let stalled = false;
                const watchdog = setInterval(() => {
                    if (Date.now() - lastMove > STALL_MS && job.child) {
                        stalled = true;
                        onProgress({ step: 'model', line: `No data for ${Math.round(STALL_MS / 1000)}s — restarting the download (try ${attempt + 1} of ${MODEL_TRIES})…` });
                        killProcessTree(job.child);
                    }
                }, 5000);
                try {
                    await stream(vpy, [fetchScript, MODEL_ID], {
                        env, cwd: dir,
                        onLine: (t) => {
                            const m = /^PROGRESS (\d+) (\d+)/.exec(t);
                            if (m) {
                                const got = Number(m[1]);
                                const total = Number(m[2]);
                                if (got !== lastBytes) {
                                    lastBytes = got;
                                    lastMove = Date.now();
                                }
                                const gb = (b) => (b / 1024 ** 3).toFixed(2);
                                step('model', total ? got / total : 0, { label: `Downloading the VoxCPM2 model · ${gb(got)}${total ? ` / ${gb(total)}` : ''} GB` });
                                return;
                            }
                            if (/^(TOTAL|DONE) /.test(t)) return;
                            line('model')(t);
                        },
                    });
                    break;
                } catch (e) {
                    if (e.cancelled || job.cancelled || attempt >= MODEL_TRIES) throw stalled ? new Error('The model download keeps stalling. Check the internet connection and click Install again — it carries on where it stopped.') : e;
                    if (!stalled) onProgress({ step: 'model', line: `Download interrupted (${e.message}) — retrying (try ${attempt + 1} of ${MODEL_TRIES})…` });
                } finally {
                    clearInterval(watchdog);
                }
            }
            finish('model');

            // 6. the server the app talks to
            step('finish');
            const appPy = path.join(dir, 'app.py');
            fs.copyFileSync(path.join(scriptsDir, 'voxcpm2_server.py'), appPy);
            fs.copyFileSync(path.join(scriptsDir, 'voxcpm2_speakers.py'), path.join(dir, 'voxcpm2_speakers.py'));
            const marker = { complete: true, model: MODEL_ID, device: useCuda ? 'cuda' : 'cpu', gpu: gpu ? gpu.name : null, python: py.version, installedAt: new Date().toISOString() };
            fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(marker, null, 2));
            // We wrote app.py ourselves: Start Server need not ask whether to allow it.
            if (approveProgram) approveProgram(appPy);
            done = 100;
            onProgress({ step: 'finish', label: 'VoxCPM2 is installed', pct: 100 });
            return { success: true, dir, appPath: appPy, ...marker };
        } finally {
            job = null;
        }
    }

    function cancel() {
        if (!job) return false;
        job.cancelled = true;
        if (job.child) killProcessTree(job.child);
        return true;
    }

    return { info, install, cancel, isInstalled };
}

module.exports = { createVoxcpmInstaller, isInstalled, MODEL_ID };
