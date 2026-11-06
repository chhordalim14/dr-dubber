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

  test('the "daily quota" strike count and when Google last answered survive a restart', () => {
    const file = tmpFile();
    let t = 1e12;
    const a = createKeyRest({ file, now: () => t });
    a.dailyStrikes.set('k1|gemini-3.8-flash', { count: 2, at: t });
    a.answered.set('k1', t);
    a.save();
    t += HOUR;
    const b = createKeyRest({ file, now: () => t });
    assert.equal(b.dailyStrikes.get('k1|gemini-3.8-flash').count, 2, 'the next "daily" answer is the third, not the first');
    assert.equal(b.answered.get('k1'), 1e12);
    t += 7 * HOUR; // strikes 6 h apart start over anyway
    const c = createKeyRest({ file, now: () => t });
    assert.equal(c.dailyStrikes.get('k1|gemini-3.8-flash'), undefined);
  });
});

describe('one file shared by two copies of the app', () => {
  test('a limit one app finds reaches the other, and neither save wipes the other\'s', () => {
    const file = tmpFile();
    const t = 1e12;
    const installed = createKeyRest({ file, now: () => t });
    const repo = createKeyRest({ file, now: () => t });
    installed.keyLimits.get('k-a'); // both apps know the keys already
    repo.keyLimits.get('k-a');
    installed.modelLimits.set('k-a|gemini-3.8-flash', { until: t + 5 * HOUR, daily: true, msg: 'quota' });
    installed.save();
    repo.keyLimits.set('k-b', { until: t + 3 * HOUR, daily: true });
    repo.save(); // must not drop the installed app's k-a
    repo.sync();
    assert.equal(repo.modelLimits.get('k-a|gemini-3.8-flash').daily, true, 'the repo copy skips k-a too');
    installed.sync();
    assert.equal(installed.keyLimits.get('k-b').daily, true);
    const fresh = createKeyRest({ file, now: () => t });
    assert.ok(fresh.modelLimits.get('k-a|gemini-3.8-flash') && fresh.keyLimits.get('k-b'));
  });

  test('a refusal cleared in one app (key added again) is not brought back by the other\'s older copy', () => {
    const file = tmpFile();
    let t = 1e12;
    const a = createKeyRest({ file, now: () => t });
    const b = createKeyRest({ file, now: () => t });
    a.invalid.set('k-dead', { until: t + 24 * HOUR, dead: true, message: 'deleted' });
    a.save();
    b.sync();
    b.invalid.get('k-dead');
    t += 1000;
    assert.equal(b.invalid.delete('k-dead'), true);
    b.save();
    a.save(); // a still holds the old refusal in memory
    a.sync();
    assert.equal(a.invalid.has('k-dead'), false, 'cleared in the other app: gone here too');
    assert.equal(createKeyRest({ file, now: () => t }).invalid.has('k-dead'), false);
  });

  test('the per-app file from before is read in once', () => {
    const shared = tmpFile();
    const legacy = tmpFile();
    const t = 1e12;
    const old = createKeyRest({ file: legacy, now: () => t });
    old.keyLimits.set('k-old', { until: t + 2 * HOUR, daily: true });
    old.save();
    const now = createKeyRest({ file: shared, legacyFiles: [legacy], now: () => t });
    assert.equal(now.keyLimits.get('k-old').daily, true);
  });
});
