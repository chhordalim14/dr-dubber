// Helpers for BGM isolation (/api/remove-vocals and friends), kept out of
// server.js so they can be tested on their own:
//  - a result cache, so the same tab is never separated twice (a series run,
//    a Continue after a pause or a re-isolate all reuse the stems in a second);
//  - the answer /api/bgm-job-status gives for a job id;
//  - how many CPU threads each separator may use;
//  - killing a separator's whole process tree when the user presses Stop.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CACHE_FOLDER = 'bgm-cache';
const BGM_FILE = 'accompaniment.wav';
const VOCAL_FILE = 'vocals.wav';
const META_FILE = 'meta.json';

// Anything that changes the sound of the stems is part of the key: the file
// itself (path, size and modified time - a re-split tab with the same name gets
// a new key) and the engine + model that separated it.
function bgmCacheKey({ sourcePath, size, mtimeMs, engine, model }) {
    let p = path.resolve(String(sourcePath || ''));
    // Windows paths are case-insensitive: C:\A.mp4 and c:\a.mp4 are one file.
    if (process.platform === 'win32') p = p.toLowerCase();
    const parts = [p, Number(size) || 0, Math.round(Number(mtimeMs) || 0), String(engine || ''), String(model || '')];
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function cacheKeyForFile(sourcePath, engine, model) {
    try {
        const st = fs.statSync(sourcePath);
        if (!st.isFile()) return null;
        return bgmCacheKey({ sourcePath, size: st.size, mtimeMs: st.mtimeMs, engine, model });
    } catch (e) {
        return null;
    }
}

function cacheDirFor(separatedDir, key) {
    return path.join(separatedDir, CACHE_FOLDER, key);
}

function nonEmptyFile(p) {
    try {
        const st = fs.statSync(p);
        return st.isFile() && st.size > 0;
    } catch (e) {
        return false;
    }
}

// A hit needs both stems and meta.json (written last, so a half-written entry
// never counts). Returns { bgm, vocal, method } or null.
function lookupCachedStems(separatedDir, key) {
    if (!key) return null;
    const dir = cacheDirFor(separatedDir, key);
    const bgm = path.join(dir, BGM_FILE);
    const vocal = path.join(dir, VOCAL_FILE);
    const metaPath = path.join(dir, META_FILE);
    if (!nonEmptyFile(bgm) || !nonEmptyFile(vocal) || !nonEmptyFile(metaPath)) return null;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {}; } catch (e) { return null; }
    // Touch meta.json so pruning counts from the last use, not from when it was made.
    try { const now = new Date(); fs.utimesSync(metaPath, now, now); } catch (e) {}
    return { bgm, vocal, method: meta.method || null };
}

function moveFile(from, to) {
    try {
        fs.renameSync(from, to);
    } catch (e) {
        // Different drive (custom storage folder): copy, then drop the original.
        fs.copyFileSync(from, to);
        try { fs.unlinkSync(from); } catch (e2) {}
    }
}

// Moves freshly separated stems into the cache and returns their new paths.
// The entry is built in a temp folder and renamed into place, so a crash
// half-way never leaves an entry that looks complete. Returns null (and the
// caller keeps using the original files) if anything goes wrong.
function storeStems(separatedDir, key, { bgm, vocal, method, source }) {
    if (!key || !nonEmptyFile(bgm) || !nonEmptyFile(vocal)) return null;
    const finalDir = cacheDirFor(separatedDir, key);
    const existing = lookupCachedStems(separatedDir, key);
    if (existing) return existing; // another run of the same tab got there first
    const tmpDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        moveFile(bgm, path.join(tmpDir, BGM_FILE));
        moveFile(vocal, path.join(tmpDir, VOCAL_FILE));
        fs.writeFileSync(path.join(tmpDir, META_FILE), JSON.stringify({ method: method || null, source: source || null, created: Date.now() }));
        fs.rmSync(finalDir, { recursive: true, force: true });
        fs.renameSync(tmpDir, finalDir);
        return { bgm: path.join(finalDir, BGM_FILE), vocal: path.join(finalDir, VOCAL_FILE), method: method || null };
    } catch (e) {
        // Put the stems back where the caller expects them before giving up.
        try { if (!fs.existsSync(bgm)) moveFile(path.join(tmpDir, BGM_FILE), bgm); } catch (e2) {}
        try { if (!fs.existsSync(vocal)) moveFile(path.join(tmpDir, VOCAL_FILE), vocal); } catch (e2) {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e2) {}
        return null;
    }
}

// Stems are ~100 MB each per 9-minute tab, so entries not used for maxAgeMs
// are deleted (and so are leftovers from crashed or stopped runs).
function pruneBgmCache(separatedDir, maxAgeMs, now = Date.now()) {
    const root = path.join(separatedDir, CACHE_FOLDER);
    let removed = 0;
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { return 0; }
    for (const name of names) {
        const dir = path.join(root, name);
        let lastUse = 0;
        try {
            lastUse = name.includes('.tmp-') ? fs.statSync(dir).mtimeMs : fs.statSync(path.join(dir, META_FILE)).mtimeMs;
        } catch (e) {
            try { lastUse = fs.statSync(dir).mtimeMs; } catch (e2) { continue; }
        }
        if (now - lastUse > maxAgeMs) {
            try { fs.rmSync(dir, { recursive: true, force: true }); removed++; } catch (e) {}
        }
    }
    return removed;
}

// /api/bgm-job-status answer. An id the server never saw (or forgot after a
// restart) is a failure: answering "done" made the app wait for stems that
// never existed.
function jobStatusFor(jobs, jobId) {
    const job = jobId ? jobs.get(jobId) : null;
    if (!job) return { success: false, status: 'unknown', error: 'Unknown job' };
    return job;
}

// Threads per separator: the app runs `parallelJobs` separations at once (2 for
// Isolate All), so each gets its share of the CPU instead of every torch
// process grabbing all cores and fighting the others.
function pickSeparatorThreads(cpuCount, parallelJobs) {
    const cpus = Math.max(1, Math.floor(Number(cpuCount) || 1));
    const jobs = Math.max(1, Math.floor(Number(parallelJobs) || 1));
    return Math.max(1, Math.floor(cpus / jobs));
}

// Stop must end the separator and everything it started (vocal_separator.py
// runs Demucs/Spleeter as its own child process). On Windows taskkill /T walks
// the tree; elsewhere the separator is started in its own process group
// (spawn detached) and the whole group is killed.
function killProcessTree(child) {
    if (!child || !child.pid || child.exitCode !== null || child.signalCode) return false;
    try {
        if (process.platform === 'win32') {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => { try { child.kill('SIGKILL'); } catch (e) {} });
        } else {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); }
        }
        return true;
    } catch (e) {
        return false;
    }
}

module.exports = {
    CACHE_FOLDER,
    bgmCacheKey,
    cacheKeyForFile,
    cacheDirFor,
    lookupCachedStems,
    storeStems,
    pruneBgmCache,
    jobStatusFor,
    pickSeparatorThreads,
    killProcessTree,
};
