// Finished Batch Transcribe parts kept on disk (backend/lib/batch-results.js), so a restart
// doesn't send a finished part to Gemini again.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBatchResult, saveBatchResult } = require('../backend/lib/batch-results');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-results-'));
  const video = path.join(root, 'part01.mp4');
  fs.writeFileSync(video, 'video bytes');
  return { dir: path.join(root, 'results'), video };
}

const result = { data: [{ start: '00:00:01,000', end: '00:00:02,000', text: 'សួស្តី', originalText: '你好', gender: 'Female', emotion: 'Neutral' }], repair: {}, fallbackModels: [] };

describe('batch results', () => {
  test('a saved part comes back with its original text, gender and emotion', () => {
    const { dir, video } = setup();
    assert.equal(saveBatchResult(dir, video, result), true);
    const saved = loadBatchResult(dir, video);
    assert.deepEqual(saved.data, result.data);
  });

  test('nothing saved yet: null', () => {
    const { dir, video } = setup();
    assert.equal(loadBatchResult(dir, video), null);
  });

  test('a replaced video file is transcribed again', () => {
    const { dir, video } = setup();
    saveBatchResult(dir, video, result);
    fs.writeFileSync(video, 'a different, longer video');
    assert.equal(loadBatchResult(dir, video), null);
  });

  test('an empty result or a missing file is not kept', () => {
    const { dir, video } = setup();
    assert.equal(saveBatchResult(dir, video, { data: [] }), false);
    assert.equal(saveBatchResult(dir, path.join(path.dirname(video), 'gone.mp4'), result), false);
    assert.equal(loadBatchResult(dir, null), null);
  });

  test('a damaged saved file counts as nothing saved', () => {
    const { dir, video } = setup();
    saveBatchResult(dir, video, result);
    for (const f of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, f), '{ half');
    assert.equal(loadBatchResult(dir, video), null);
  });
});
