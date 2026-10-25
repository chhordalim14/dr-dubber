// Dub Whole Series checkpoints: the open part's tabs (subtitles, voices, BGM, blur...) and a
// finished part's export queue, kept on disk while the series works. The app closing - power
// cut, crash, closed by hand - loses the tabs and the render queue, which live only in the page;
// Continue reads them back from here instead of dubbing the part again. Mounted at /api.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { STORAGE_BASE } = require('../lib/paths');
const { isNetworkPath } = require('../lib/security');

const CHECKPOINT_DIR = path.join(STORAGE_BASE, 'series_checkpoints');
const KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // a series left that long is not continued

function fileFor(dir, key) {
    return KEY_RE.test(String(key || '')) ? path.join(dir, `${key}.json`) : null;
}

// Checkpoints of series nobody continued for a month go.
function removeOld(dir = CHECKPOINT_DIR, now = Date.now()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names) {
        const p = path.join(dir, name);
        try { if (now - fs.statSync(p).mtimeMs > MAX_AGE_MS) fs.rmSync(p, { force: true }); } catch (e) { }
    }
}

module.exports = function createSeriesCheckpointRouter({ dir = CHECKPOINT_DIR } = {}) {
    const router = express.Router();
    const at = (key) => fileFor(dir, key);
    removeOld(dir);

    router.post('/series-checkpoint', (req, res) => {
        const { key, data } = req.body || {};
        const file = at(key);
        if (!file || data === undefined) return res.status(400).json({ success: false, error: 'Bad checkpoint' });
        try {
            fs.mkdirSync(dir, { recursive: true });
            // Written beside it and renamed over it: a power cut mid-write leaves the last good one.
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data));
            fs.renameSync(tmp, file);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    router.get('/series-checkpoint', (req, res) => {
        const file = at(req.query.key);
        if (!file) return res.status(400).json({ success: false, error: 'Bad checkpoint' });
        try {
            res.json({ success: true, data: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null });
        } catch (e) {
            res.json({ success: true, data: null }); // unreadable: as if there were none
        }
    });

    // Which of a part's exported videos are on disk (not empty). Only answers; never makes or
    // touches a file (the app:checkPathExists IPC makes a folder at a missing path).
    router.post('/series-checkpoint/files-exist', (req, res) => {
        const paths = [].concat((req.body || {}).paths || []).slice(0, 200);
        res.json({
            success: true,
            exists: paths.map((p) => {
                if (typeof p !== 'string' || !path.isAbsolute(p) || isNetworkPath(p)) return false;
                try { const st = fs.statSync(p); return st.isFile() && st.size > 0; } catch (e) { return false; }
            }),
        });
    });

    router.post('/series-checkpoint/delete', (req, res) => {
        const keys = [].concat((req.body || {}).keys || []);
        for (const key of keys) {
            const file = at(key);
            if (file) try { fs.rmSync(file, { force: true }); } catch (e) { }
        }
        res.json({ success: true });
    });

    return router;
};
module.exports._removeOld = removeOld;
