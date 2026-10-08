// Finished Batch Transcribe parts, kept on disk so a restart (or a second Start Batch) doesn't
// send a part to Gemini again. The saved SRT can't stand in for this: it has only the Khmer
// text, not the original line, gender and emotion the voices need.
//
// A result belongs to one video file as it is now: path + size + modified time. A re-exported
// or replaced file gets transcribed again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function resultFile(dir, sourceFilePath) {
    if (!sourceFilePath || typeof sourceFilePath !== 'string') return null;
    let st;
    try { st = fs.statSync(sourceFilePath); } catch (e) { return null; }
    if (!st.isFile()) return null;
    const id = crypto.createHash('sha1').update(`${path.resolve(sourceFilePath)}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex');
    return path.join(dir, `${id}.json`);
}

function loadBatchResult(dir, sourceFilePath) {
    const file = resultFile(dir, sourceFilePath);
    if (!file) return null;
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        return saved && Array.isArray(saved.data) && saved.data.length ? saved : null;
    } catch (e) {
        return null; // none yet, or a half-written file
    }
}

function saveBatchResult(dir, sourceFilePath, result) {
    const file = resultFile(dir, sourceFilePath);
    if (!file || !result || !Array.isArray(result.data) || !result.data.length) return false;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...result, savedAt: Date.now(), sourceFilePath }), 'utf8');
    fs.renameSync(tmp, file); // never leaves a half-written result behind
    return true;
}

module.exports = { loadBatchResult, saveBatchResult };
