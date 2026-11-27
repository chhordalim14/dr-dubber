// "Join Episodes" feature: many short downloaded episodes -> a few ~1 hour
// parts to dub. Thin wrapper around episode_joiner.js's already-isolated
// service object. Extracted verbatim out of server.js.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { resolveLocalFilePath } = require('../lib/paths');
const { isNetworkPath } = require('../lib/security');

module.exports = function createEpisodesRouter({ episodeJoiner }) {
    const router = express.Router();

    router.post('/scan', async (req, res) => {
        const folder = resolveLocalFilePath((req.body || {}).folder);
        if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return res.json({ success: false, error: 'Folder not found' });
        try {
            res.json({ success: true, ...(await episodeJoiner.scan(folder)) });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    router.post('/join', async (req, res) => {
        const { parts, outDir, seriesName, partNumbers, fileName } = req.body || {};
        if (!outDir || typeof outDir !== 'string' || isNetworkPath(outDir)) return res.json({ success: false, error: 'No output folder' });
        try {
            const jobId = await episodeJoiner.start({ parts, outDir: resolveLocalFilePath(outDir) || outDir, seriesName, partNumbers, fileName });
            res.json({ success: true, jobId });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    router.get('/status', (req, res) => {
        const st = episodeJoiner.status(String(req.query.jobId || ''));
        res.json(st ? { success: true, ...st } : { success: false, error: 'Unknown job' });
    });

    router.post('/cancel', (req, res) => {
        res.json({ success: episodeJoiner.cancel(String((req.body || {}).jobId || '')) });
    });

    // Dub Whole Series' "Delete working files when done": the joined parts and their split tabs,
    // once every part is exported. Only files straight inside a "DR Dubber Joined" or "DR Dubber
    // Split" folder (the folders the app makes for them), and only media and their lists - any
    // other path is refused, whatever the page sends.
    router.post('/delete-working', (req, res) => {
        const paths = [].concat((req.body || {}).paths || []).slice(0, 2000);
        let deleted = 0, freed = 0;
        const refused = [];
        for (const p of paths) {
            if (!isWorkingFile(p)) { refused.push(String(p)); continue; }
            try {
                const st = fs.statSync(p);
                if (!st.isFile()) continue;
                fs.rmSync(p, { force: true });
                deleted++;
                freed += st.size;
            } catch (e) { /* already gone */ }
        }
        if (refused.length) console.warn(`[Series] Refused to delete ${refused.length} file(s) outside the app's working folders`);
        res.json({ success: true, deleted, freed, refused: refused.length });
    });

    // "Keep only the joined full video": once Name_Dubbed_full.mp4 exists and is non-empty,
    // remove the individual exported part videos sitting beside it in the same export folder.
    // Never touches keepFile itself or anything outside its folder.
    router.post('/delete-part-exports', (req, res) => {
        const body = req.body || {};
        const keepRaw = resolveLocalFilePath(body.keepFile) || body.keepFile;
        if (!isValidFullKeepFile(keepRaw)) {
            return res.json({ success: false, error: 'Joined full video not found' });
        }
        const keepResolved = path.resolve(keepRaw);
        const paths = [].concat(body.paths || []).slice(0, 2000);
        let deleted = 0, freed = 0;
        const refused = [];
        for (const raw of paths) {
            const p = resolveLocalFilePath(raw) || raw;
            if (!isPartExportFile(p, keepResolved)) { refused.push(String(raw)); continue; }
            try {
                const st = fs.statSync(path.resolve(p));
                if (!st.isFile()) continue;
                fs.rmSync(path.resolve(p), { force: true });
                deleted++;
                freed += st.size;
            } catch (e) { /* already gone */ }
        }
        if (refused.length) console.warn(`[Series] Refused to delete ${refused.length} file(s) outside the full export folder`);
        res.json({ success: true, deleted, freed, refused: refused.length });
    });

    return router;
};

const WORKING_DIRS = new Set(['DR Dubber Joined', 'DR Dubber Split']);
const WORKING_EXTS = new Set(['.mp4', '.mkv', '.mov', '.m4v', '.webm', '.m4a', '.mp3', '.txt']);
const EXPORT_VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.m4v', '.webm']);
function isWorkingFile(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || isNetworkPath(p)) return false;
    const resolved = path.resolve(p);
    if (resolved !== path.normalize(p)) return false; // no "..", no tricks
    return WORKING_DIRS.has(path.basename(path.dirname(resolved))) && WORKING_EXTS.has(path.extname(resolved).toLowerCase());
}
function isValidFullKeepFile(keepFile) {
    if (typeof keepFile !== 'string' || !path.isAbsolute(keepFile) || isNetworkPath(keepFile)) return false;
    const resolved = path.resolve(keepFile);
    if (resolved !== path.normalize(keepFile)) return false;
    if (!EXPORT_VIDEO_EXTS.has(path.extname(resolved).toLowerCase())) return false;
    try {
        const st = fs.statSync(resolved);
        return st.isFile() && st.size > 0;
    } catch (e) {
        return false;
    }
}
function isPartExportFile(p, keepFile) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || isNetworkPath(p)) return false;
    if (typeof keepFile !== 'string' || !path.isAbsolute(keepFile) || isNetworkPath(keepFile)) return false;
    const resolved = path.resolve(p);
    const keepResolved = path.resolve(keepFile);
    if (resolved !== path.normalize(p) || keepResolved !== path.normalize(keepFile)) return false;
    if (resolved === keepResolved) return false;
    if (path.dirname(resolved) !== path.dirname(keepResolved)) return false;
    return EXPORT_VIDEO_EXTS.has(path.extname(resolved).toLowerCase());
}
module.exports.isWorkingFile = isWorkingFile;
module.exports.isPartExportFile = isPartExportFile;
