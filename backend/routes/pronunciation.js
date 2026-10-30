// Automatic pronunciation fixes (lib/pronunciation.js): the list the page applies before Edge
// reads a line, the checker's progress, its on/off switch, and taking a fix off the list.
// Mounted at /api.
const express = require('express');
const path = require('path');
const { STORAGE_BASE, ROOT_DIR } = require('../lib/paths');
const { createPronunciationChecker } = require('../lib/pronunciation');

const START_AFTER_MS = 60 * 1000; // let the app settle first

module.exports = function createPronunciationRouter({ getFFmpegBinary, getPythonScriptPath, trackProcess, log = console.log }) {
    const checker = createPronunciationChecker({
        storageDir: STORAGE_BASE,
        batchDir: path.join(STORAGE_BASE, 'batch_results'),
        scriptPath: getPythonScriptPath('pronunciation_checker.py'),
        ffmpegPath: getFFmpegBinary,
        khmerSpeech: require(path.join(ROOT_DIR, 'frontend', 'js', 'khmer-speech.js')),
        onSpawn: trackProcess,
        log,
    });
    setTimeout(checker.kick, START_AFTER_MS).unref();

    const router = express.Router();
    router.get('/pronunciation', (req, res) => res.json({ success: true, ...checker.status() }));
    router.post('/pronunciation/enabled', (req, res) => {
        checker.setEnabled(!!(req.body && req.body.enabled));
        res.json({ success: true, ...checker.status() });
    });
    router.post('/pronunciation/reject', (req, res) => {
        const written = String((req.body && req.body.written) || '');
        res.json({ success: checker.reject(written), ...checker.status() });
    });
    router.checker = checker;
    return router;
};
