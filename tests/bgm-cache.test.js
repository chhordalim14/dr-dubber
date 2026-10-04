// Unit tests for backend/lib/bgm-cache.js - the BGM isolation helpers behind
// /api/remove-vocals: the stem cache (so a tab is never separated twice), the
// /api/bgm-job-status answer for an unknown job, the per-job thread share and
// the process-tree kill used by Stop.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
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
} = require('../backend/lib/bgm-cache');

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bgm-cache-test-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function writeFile(p, text) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
}

describe('bgmCacheKey', () => {
    const base = { sourcePath: 'C:\\Videos\\tab_part01.mp4', size: 52134173, mtimeMs: 1790000000000, engine: 'demucs', model: 'htdemucs' };

    test('is a stable sha1 hex string', () => {
        const k = bgmCacheKey(base);
        assert.match(k, /^[0-9a-f]{40}$/);
        assert.equal(bgmCacheKey({ ...base }), k);
    });

    test('changes with every input that changes the stems', () => {
        const k = bgmCacheKey(base);
        assert.notEqual(bgmCacheKey({ ...base, sourcePath: 'C:\\Videos\\tab_part02.mp4' }), k);
        assert.notEqual(bgmCacheKey({ ...base, size: base.size + 1 }), k);
        assert.notEqual(bgmCacheKey({ ...base, mtimeMs: base.mtimeMs + 1000 }), k);
        assert.notEqual(bgmCacheKey({ ...base, engine: 'spleeter' }), k);
        assert.notEqual(bgmCacheKey({ ...base, model: 'htdemucs_ft' }), k);
    });

    test('ignores path case on Windows only', { skip: process.platform !== 'win32' }, () => {
        assert.equal(bgmCacheKey({ ...base, sourcePath: base.sourcePath.toUpperCase() }), bgmCacheKey(base));
    });
});

describe('cacheKeyForFile', () => {
    test('uses the file size and modified time', () => {
        const src = writeFile(path.join(tmp, 'src', 'a.mp4'), 'video-bytes');
        const k1 = cacheKeyForFile(src, 'demucs', 'htdemucs');
        assert.match(k1, /^[0-9a-f]{40}$/);
        const st = fs.statSync(src);
        assert.equal(k1, bgmCacheKey({ sourcePath: src, size: st.size, mtimeMs: st.mtimeMs, engine: 'demucs', model: 'htdemucs' }));
        // A re-split tab with the same name is a new file: new key.
        fs.writeFileSync(src, 'other-video-bytes');
        const later = new Date(Date.now() + 5000);
        fs.utimesSync(src, later, later);
        assert.notEqual(cacheKeyForFile(src, 'demucs', 'htdemucs'), k1);
    });

    test('returns null for a missing file or a folder', () => {
        assert.equal(cacheKeyForFile(path.join(tmp, 'nope.mp4'), 'demucs', 'htdemucs'), null);
        assert.equal(cacheKeyForFile(tmp, 'demucs', 'htdemucs'), null);
    });
});

describe('storeStems / lookupCachedStems', () => {
    test('a miss returns null, a stored result is found again with its method', () => {
        const sep = path.join(tmp, 'sep1');
        const key = 'a'.repeat(40);
        assert.equal(lookupCachedStems(sep, key), null);
        assert.equal(lookupCachedStems(sep, null), null);

        const work = path.join(sep, 'bgm-work', 'job1');
        const bgm = writeFile(path.join(work, 'no_vocals.wav'), 'BGM');
        const vocal = writeFile(path.join(work, 'vocals.wav'), 'VOC');
        const stored = storeStems(sep, key, { bgm, vocal, method: 'demucs', source: 'x.mp4' });
        assert.ok(stored);
        assert.equal(path.dirname(stored.bgm), cacheDirFor(sep, key));
        assert.equal(path.dirname(cacheDirFor(sep, key)), path.join(sep, CACHE_FOLDER));
        assert.equal(fs.readFileSync(stored.bgm, 'utf8'), 'BGM');
        assert.equal(fs.readFileSync(stored.vocal, 'utf8'), 'VOC');
        // The stems were moved, not copied.
        assert.equal(fs.existsSync(bgm), false);

        const hit = lookupCachedStems(sep, key);
        assert.deepEqual(hit, { bgm: stored.bgm, vocal: stored.vocal, method: 'demucs' });
    });

    test('an entry with a missing or empty stem is not a hit', () => {
        const sep = path.join(tmp, 'sep2');
        const key = 'b'.repeat(40);
        const work = path.join(sep, 'w');
        storeStems(sep, key, { bgm: writeFile(path.join(work, 'b.wav'), 'B'), vocal: writeFile(path.join(work, 'v.wav'), 'V'), method: 'spleeter' });
        assert.ok(lookupCachedStems(sep, key));
        fs.unlinkSync(path.join(cacheDirFor(sep, key), 'vocals.wav'));
        assert.equal(lookupCachedStems(sep, key), null);

        const key2 = 'c'.repeat(40);
        storeStems(sep, key2, { bgm: writeFile(path.join(work, 'b2.wav'), 'B'), vocal: writeFile(path.join(work, 'v2.wav'), 'V'), method: 'spleeter' });
        fs.writeFileSync(path.join(cacheDirFor(sep, key2), 'accompaniment.wav'), '');
        assert.equal(lookupCachedStems(sep, key2), null);
    });

    test('a folder without meta.json (half-written) is not a hit', () => {
        const sep = path.join(tmp, 'sep3');
        const key = 'd'.repeat(40);
        writeFile(path.join(cacheDirFor(sep, key), 'accompaniment.wav'), 'B');
        writeFile(path.join(cacheDirFor(sep, key), 'vocals.wav'), 'V');
        assert.equal(lookupCachedStems(sep, key), null);
    });

    test('refuses to store missing stems, and leaves them alone', () => {
        const sep = path.join(tmp, 'sep4');
        const vocal = writeFile(path.join(sep, 'w', 'v.wav'), 'V');
        assert.equal(storeStems(sep, 'e'.repeat(40), { bgm: path.join(sep, 'w', 'missing.wav'), vocal, method: 'demucs' }), null);
        assert.equal(fs.existsSync(vocal), true);
        assert.equal(storeStems(sep, null, { bgm: vocal, vocal, method: 'demucs' }), null);
    });

    test('a second store of the same key reuses the first entry', () => {
        const sep = path.join(tmp, 'sep5');
        const key = 'f'.repeat(40);
        const first = storeStems(sep, key, { bgm: writeFile(path.join(sep, 'w1', 'b.wav'), 'B1'), vocal: writeFile(path.join(sep, 'w1', 'v.wav'), 'V1'), method: 'demucs' });
        const second = storeStems(sep, key, { bgm: writeFile(path.join(sep, 'w2', 'b.wav'), 'B2'), vocal: writeFile(path.join(sep, 'w2', 'v.wav'), 'V2'), method: 'demucs' });
        assert.equal(second.bgm, first.bgm);
        assert.equal(fs.readFileSync(first.bgm, 'utf8'), 'B1');
    });
});

describe('pruneBgmCache', () => {
    test('removes entries unused for longer than maxAge, keeps recent ones', () => {
        const sep = path.join(tmp, 'sep6');
        const oldKey = '1'.repeat(40);
        const newKey = '2'.repeat(40);
        for (const k of [oldKey, newKey]) {
            storeStems(sep, k, { bgm: writeFile(path.join(sep, 'w', `${k}b.wav`), 'B'), vocal: writeFile(path.join(sep, 'w', `${k}v.wav`), 'V'), method: 'demucs' });
        }
        const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        fs.utimesSync(path.join(cacheDirFor(sep, oldKey), 'meta.json'), longAgo, longAgo);
        assert.equal(pruneBgmCache(sep, 14 * 24 * 3600 * 1000), 1);
        assert.equal(fs.existsSync(cacheDirFor(sep, oldKey)), false);
        assert.ok(lookupCachedStems(sep, newKey));
    });

    test('a missing cache folder is fine', () => {
        assert.equal(pruneBgmCache(path.join(tmp, 'never-made'), 1000), 0);
    });
});

describe('jobStatusFor', () => {
    test('an unknown job id is a failure, not "done"', () => {
        const jobs = new Map();
        const expected = { success: false, status: 'unknown', error: 'Unknown job' };
        assert.deepEqual(jobStatusFor(jobs, 'bgm_123'), expected);
        assert.deepEqual(jobStatusFor(jobs, undefined), expected);
        assert.deepEqual(jobStatusFor(jobs, ''), expected);
    });

    test('a known job is returned as stored', () => {
        const job = { status: 'processing', success: true, progress: 10 };
        const jobs = new Map([['bgm_1', job]]);
        assert.equal(jobStatusFor(jobs, 'bgm_1'), job);
    });
});

describe('pickSeparatorThreads', () => {
    test('splits the CPU between the jobs running at once', () => {
        assert.equal(pickSeparatorThreads(16, 2), 8);
        assert.equal(pickSeparatorThreads(16, 1), 16);
        assert.equal(pickSeparatorThreads(6, 4), 1);
    });

    test('never returns less than one thread', () => {
        assert.equal(pickSeparatorThreads(0, 0), 1);
        assert.equal(pickSeparatorThreads(2, 8), 1);
        assert.equal(pickSeparatorThreads(undefined, 'x'), 1);
    });
});

describe('killProcessTree', () => {
    test('does nothing for a missing or finished process', () => {
        assert.equal(killProcessTree(null), false);
        assert.equal(killProcessTree({ pid: 0 }), false);
        assert.equal(killProcessTree({ pid: 1234, exitCode: 0, signalCode: null }), false);
    });

    test('kills a process and the child it started', async () => {
        // A node process that starts a long-running grandchild, like
        // vocal_separator.py starting Demucs.
        const script = "const { spawn } = require('child_process');" +
            "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });" +
            "console.log(g.pid); setTimeout(() => {}, 60000);";
        const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true });
        const grandPid = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(parseInt(String(d), 10))));
        const closed = new Promise((resolve) => child.once('close', resolve));
        assert.equal(killProcessTree(child), true);
        await closed;
        const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
        // taskkill is asynchronous on Windows: give the grandchild a moment to go.
        for (let i = 0; i < 50 && alive(grandPid); i++) await new Promise((r) => setTimeout(r, 100));
        assert.equal(alive(grandPid), false);
    });
});
