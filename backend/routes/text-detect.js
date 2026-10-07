// On-screen subtitle detection for a tab's video (blurred in the render while they show).
// Thin HTTP wrapper around text_detect_service.js. Mounted at /api.
const express = require('express');
const { resolveLocalFilePath } = require('../lib/paths');

module.exports = function createTextDetectRouter({ textDetect }) {
    const router = express.Router();

    // { videoPath } -> { jobId, status: queued|running|done|error, progress, result? }
    router.post('/detect-text', (req, res) => {
        const videoPath = resolveLocalFilePath((req.body || {}).videoPath);
        if (!videoPath) return res.status(400).json({ success: false, error: 'Video file not found.' });
        res.json(textDetect.start(videoPath));
    });

    router.get('/detect-text-status', (req, res) => {
        res.json(textDetect.status(String(req.query.jobId || '')));
    });

    router.post('/cancel-detect-text', (req, res) => {
        res.json(textDetect.cancel(String((req.body || {}).jobId || '')));
    });

    return router;
};
