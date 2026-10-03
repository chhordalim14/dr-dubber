// Any-format video preview: probes the file and, if Chromium can't play it,
// builds a playable copy in the background (see media_preview.js). Thin
// wrapper around that already-isolated service object. Extracted verbatim
// out of server.js. Mounted at /api (route paths aren't nested the way
// episodes/split are).
const express = require('express');
const fs = require('fs');
const { resolveLocalFilePath } = require('../lib/paths');

module.exports = function createPreviewRouter({ previewService }) {
    const router = express.Router();

    router.post('/check-video-preview', async (req, res) => {
        const { filePath, force } = req.body || {};
        const resolved = resolveLocalFilePath(filePath);
        if (!resolved || !fs.existsSync(resolved)) {
            return res.json({ success: false, error: 'File not found' });
        }
        try {
            const result = await previewService.check(resolved, force === 'video' || force === 'audio' ? force : null);
            res.json({ success: true, ...result });
        } catch (e) {
            console.warn('[Preview] Probe failed:', e.message);
            res.json({ success: false, error: e.message });
        }
    });

    router.get('/preview-status', (req, res) => {
        const st = previewService.status(String(req.query.jobId || ''));
        res.json(st ? { success: true, ...st } : { success: false, error: 'Unknown job' });
    });

    router.post('/cancel-preview', (req, res) => {
        res.json({ success: previewService.cancel(String((req.body || {}).jobId || '')) });
    });

    return router;
};
