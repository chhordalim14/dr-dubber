// Timeline waveform data: peaks of a local video's original audio (see
// lib/audio-peaks.js). Results are kept per file (path + size + mtime) so
// switching tabs back and forth never decodes the same episode twice.
const express = require('express');
const fs = require('fs');
const { resolveLocalFilePath } = require('../lib/paths');
const { computeAudioPeaks } = require('../lib/audio-peaks');

const MAX_CACHED = 12;

module.exports = function createWaveformRouter({ getFFmpegBinary }) {
    const router = express.Router();
    const cache = new Map(); // key -> Promise<{ peaksPerSecond, peaks }>

    router.post('/audio-peaks', async (req, res) => {
        const resolved = resolveLocalFilePath((req.body || {}).filePath);
        if (!resolved || !fs.existsSync(resolved)) {
            return res.json({ success: false, error: 'File not found' });
        }
        let key;
        try {
            const st = fs.statSync(resolved);
            key = `${resolved}|${st.size}|${st.mtimeMs}`;
        } catch (e) {
            return res.json({ success: false, error: e.message });
        }
        let job = cache.get(key);
        if (!job) {
            job = computeAudioPeaks({ ffmpegBin: getFFmpegBinary(), filePath: resolved });
            cache.set(key, job);
            if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
            job.catch(() => cache.delete(key));
        } else {
            // Most recently used goes to the back of the eviction line.
            cache.delete(key);
            cache.set(key, job);
        }
        try {
            const { peaksPerSecond, peaks } = await job;
            res.json({ success: true, peaksPerSecond, peaks });
        } catch (e) {
            res.json({ success: false, error: e.message });
        }
    });

    return router;
};
