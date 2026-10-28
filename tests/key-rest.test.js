// backend/lib/key-rest.js: which Gemini keys are resting (refused by Google, out for the day),
// kept on disk so closing the app doesn't forget them.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKeyRest } = require('../backend/lib/key-rest');

const HOUR = 3600 * 1000;
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'key-rest-')), 'gemini_key_rest.json');

describe('resting Gemini keys', () => {
  test('a dead key and a daily limit come back after the app restarts; the key text is never saved', () => {
    const file = tmpFile();
    let t = 1e12;
    const a = createKeyRest({ file, now: () => t });
    a.invalid.set('AIzaDEAD1234567890abcdef', { until: t + 24 * HOUR, dead: true, message: 'service account deleted' });
    a.keyLimits.set('AIzaDAILY234567890abcdef', { until: t + 5 * HOUR, daily: true });
    a.modelLimits.set('AIzaMODEL234567890abcdef|gemini-3.8-flash', { until: t + 3 * HOUR, daily: true, msg: 'quota' });
    a.save();
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/AIza/.test(text), 'keys are saved as a hash');

    t += HOUR;
    const b = createKeyRest({ file, now: () => t });
    assert.equal(b.invalid.get('AIzaDEAD1234567890abcdef').dead, true);
    assert.equal(b.keyLimits.get('AIzaDAILY234567890abcdef').until, 1e12 + 5 * HOUR);
    assert.equal(b.modelLimits.get('AIzaMODEL234567890abcdef|gemini-3.8-flash').daily, true);
    assert.equal(b.invalid.get('AIzaOTHER234567890abcdef'), undefined);
  });

  test('short rests are not saved: a per-minute limit, a 10-minute refusal', () => {
    const file = tmpFile();
    const t = 1e12;
    const a = createKeyRest({ file, now: () => t });
    a.keyLimits.set('k-minute', { until: t + 20000, daily: false });
    a.invalid.set('k-403', { until: t + 10 * 60000, dead: false, message: 'forbidden' });
    a.save();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).keys, {});
  });

  test('a rest that is over is dropped', () => {
    const file = tmpFile();
    let t = 1e12;
    const a = createKeyRest({ file, now: () => t });
    a.invalid.set('k-dead', { until: t + 24 * HOUR, dead: true });
    a.save();
    t += 25 * HOUR;
    const b = createKeyRest({ file, now: () => t });
    assert.equal(b.invalid.has('k-dead'), false);
    b.save();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).keys, {});
  });

  test('a key not used yet this run keeps its saved rest when another key changes', () => {
    const file = tmpFile();
    const t = 1e12;
    const a = createKeyRest({ file, now: () => t });
    a.invalid.set('k-dead', { until: t + 24 * HOUR, dead: true });
    a.save();
    const b = createKeyRest({ file, now: () => t });
    b.keyLimits.set('k-other', { until: t + 2 * HOUR, daily: true });
    b.save();
    const c = createKeyRest({ file, now: () => t });
    assert.equal(c.invalid.get('k-dead').dead, true);
    assert.equal(c.keyLimits.get('k-other').daily, true);
  });

  test('a key added again (its refusal deleted) is not resting after a restart', () => {
    const file = tmpFile();
    const t = 1e12;
    const a = createKeyRest({ file, now: () => t });
    a.invalid.set('k-dead', { until: t + 24 * HOUR, dead: true });
    a.save();
    const b = createKeyRest({ file, now: () => t });
    assert.equal(b.invalid.delete('k-dead'), true);
    b.save();
    assert.equal(createKeyRest({ file, now: () => t }).invalid.has('k-dead'), false);
  });

  test('a broken or missing file starts with nothing resting', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{not json');
    assert.equal(createKeyRest({ file }).invalid.has('k'), false);
    assert.equal(createKeyRest({ file: path.join(path.dirname(file), 'none.json') }).invalid.has('k'), false);
  });
});
