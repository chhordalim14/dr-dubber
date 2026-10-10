// Every man is voiced by one Edge voice and every woman by another, so the pitch must not move
// with the line's emotion: it used to go from -8 Hz (Royal) to +15 Hz (Fear), and the same
// character sounded deep on one line and light on the next. Runs the real server function.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('function getEmotionProsody(');
const end = src.indexOf('\n}\n', start);
assert.ok(start >= 0 && end > start, 'getEmotionProsody not found');
const getEmotionProsody = new Function(`${src.slice(start, end + 2)}\nreturn getEmotionProsody;`)();

const EMOTIONS = ['Neutral', 'Angry', 'Sad', 'Whisper', 'Excited', 'Royal', 'Romantic', 'Fear'];

test('every emotion keeps the voice at its own pitch', () => {
  for (const base of ['+0Hz', '-10Hz', '+10Hz']) {
    for (const emotion of EMOTIONS) {
      const expected = base === '+0Hz' ? '+0Hz' : base;
      assert.equal(getEmotionProsody(emotion, base, '+0%', 1, '+0%').pitch, expected, `${emotion} at ${base}`);
    }
  }
});

test('emotion still shapes pace and loudness', () => {
  const neutral = getEmotionProsody('Neutral', '+0Hz', '+0%', 1, '+0%');
  const angry = getEmotionProsody('Angry', '+0Hz', '+0%', 1, '+0%');
  const sad = getEmotionProsody('Sad', '+0Hz', '+0%', 1, '+0%');
  assert.equal(neutral.rate, '+0%');
  assert.equal(angry.rate, '+12%');
  assert.equal(angry.volume, '+15%');
  assert.equal(sad.rate, '-12%');
});

test('only two voices: a role (Hero, Mother...) is plain Male or Female, no pitch or pace of its own', () => {
  const from = src.indexOf('const CHARACTER_PRESETS = {');
  const to = src.indexOf('// Helper: Calculate emotional prosody');
  assert.ok(from >= 0 && to > from, 'voice presets not found');
  const resolve = new Function(`${src.slice(from, to)}\nreturn resolveCharacterPreset;`)();
  const expected = { Hero: 'Male', Villain: 'Male', Elder: 'Male', Father: 'Male', Heroine: 'Female', Mother: 'Female', Queen: 'Female', Child: 'Female', Male: 'Male', Female: 'Female' };
  for (const [role, gender] of Object.entries(expected)) {
    const p = resolve(role);
    assert.equal(p.id, gender, role);
    assert.equal(p.pitch, '+0Hz', role);
    assert.equal(p.rate, '+0%', role);
  }
  assert.equal(resolve('km-KH-SreymomNeural').id, 'Female');
  assert.equal(resolve(undefined).id, 'Male');
});
