// Microsoft's voice service refusing edge-tts (403 at the WebSocket handshake, Oct 15, 2026) is
// told apart from a busy server: a refused line gets one more try instead of eight, and Dub Whole
// Series pauses with a message a person can act on. isEdgeTtsRefusal from frontend/js/studio-main.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8');
const line = src.split('\n').find((l) => l.includes('const isEdgeTtsRefusal ='));
const isEdgeTtsRefusal = new Function(`${line}; return isEdgeTtsRefusal;`)();

test('the 403 handshake refusal from the server log is recognised', () => {
  assert.ok(line, 'isEdgeTtsRefusal moved - update this test');
  assert.equal(isEdgeTtsRefusal("403, message='Invalid response status', url='wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&Sec-MS-GEC-Version=1-143.0.3650.75'"), true);
  assert.equal(isEdgeTtsRefusal('aiohttp.client_exceptions.WSServerHandshakeError: 403'), true);
});

test('busy servers, timeouts and other errors still get every retry', () => {
  for (const msg of ['Failed to fetch', 'TTS timed out after 120s', '503 Service Unavailable', 'No audio was received', '', undefined]) {
    assert.equal(isEdgeTtsRefusal(msg), false, String(msg));
  }
});
