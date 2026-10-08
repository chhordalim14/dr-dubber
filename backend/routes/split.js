// "Split Movie" feature: one long movie -> ~30 minute parts, each dubbed as
// its own project. Thin wrapper around video_splitter.js's already-isolated
// service object. Extracted verbatim out of server.js.
const express = require('express');
const { resolveLocalFilePath } = require('../lib/paths');
const { isNetworkPath } = require('../lib/security');

module.exports = function createSplitRouter({ videoSplitter }) {
    const router = express.Router();

    router.post('/inspect', async (req, res) => {
        const file = resolveLocalFilePath((req.body || {}).file);
        if (!file) return res.json({ success: false, error: 'File not found' });
        try {
            res.json({ success: true, ...(await videoSplitter.inspect(file)) });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    router.post('/start', async (req, res) => {
        const { file, outDir, partCount, baseName } = req.body || {};
        const src = resolveLocalFilePath(file);
        if (!src) return res.json({ success: false, error: 'File not found' });
        if (!outDir || typeof outDir !== 'string' || isNetworkPath(outDir)) return res.json({ success: false, error: 'No output folder' });
        try {
            const jobId = await videoSplitter.start({ file: src, outDir, partCount, baseName });
            res.json({ success: true, jobId });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    router.get('/status', (req, res) => {
        const st = videoSplitter.status(String(req.query.jobId || ''));
        res.json(st ? { success: true, ...st } : { success: false, error: 'Unknown job' });
    });

    router.post('/cancel', (req, res) => {
        res.json({ success: videoSplitter.cancel(String((req.body || {}).jobId || '')) });
    });

    return router;
};
