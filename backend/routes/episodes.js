// "Join Episodes" feature: many short downloaded episodes -> a few ~1 hour
// parts to dub. Thin wrapper around episode_joiner.js's already-isolated
// service object. Extracted verbatim out of server.js.
const express = require('express');
const fs = require('fs');
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
        const { parts, outDir, seriesName, partNumbers } = req.body || {};
        if (!outDir || typeof outDir !== 'string' || isNetworkPath(outDir)) return res.json({ success: false, error: 'No output folder' });
        try {
            const jobId = await episodeJoiner.start({ parts, outDir: resolveLocalFilePath(outDir) || outDir, seriesName, partNumbers });
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

    return router;
};
