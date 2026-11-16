// backend/lib/server-log.js: the server's console output is kept in logs/server.log.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installServerLog } = require('../backend/lib/server-log');

test('console output goes to server.log, and the file rotates when it grows too big', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drdub-log-'));
    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const quiet = () => { };
    Object.assign(console, { log: quiet, info: quiet, warn: quiet, error: quiet });
    try {
        const file = installServerLog(dir, { maxBytes: 2000 });
        console.warn('[Transcribe] chunk 1 used a fallback model', { model: 'x' });
        for (let i = 0; i < 30; i++) console.log(`line ${i} ${'.'.repeat(40)}`);
        await new Promise((r) => setTimeout(r, 200)); // let the write streams flush
        const text = fs.readFileSync(file, 'utf8');
        assert.match(text, /line 29/);
        assert.ok(fs.existsSync(path.join(dir, 'server.1.log')), 'rotated file kept');
        const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
        assert.match(all, /WARN  \[Transcribe\] chunk 1 used a fallback model \{ model: 'x' \}/);
        assert.ok(fs.readdirSync(dir).length <= 3, 'keeps server.log + 2 old files');
    } finally {
        Object.assign(console, saved);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('progress bars are left out of the log, everything else a helper prints is kept', () => {
    const { withoutProgressBars } = require('../backend/lib/server-log');
    // What VoxCPM2 writes while voicing one line: a bar redrawn with \r, then a real message.
    const chunk = '  0%|          | 0/10 [00:00<?, ?it/s]\r 40%|####      | 4/10 [00:01<00:02,  3.4it/s]\r'
        + '100%|##########| 10/10 [00:03<00:00,  1.2s/it]\nLoaded VoxCPM2Model\n';
    assert.equal(withoutProgressBars(chunk), 'Loaded VoxCPM2Model');
    assert.equal(withoutProgressBars('Downloading:  91%|######### | 10/11 [00:00<00:00, 80.03file/s]'), '');
    assert.equal(withoutProgressBars(' 12%|#2        | 1/8 [00:05<1:02:11,  9.1s/it]\r'), '');
    // Errors and plain lines pass through, one per line, with no blank lines.
    assert.equal(withoutProgressBars('Traceback (most recent call last):\r\n\r\n  File "app.py", line 3\n'),
        'Traceback (most recent call last):\n  File "app.py", line 3');
    assert.equal(withoutProgressBars('CUDA out of memory: tried 50% | of 6 GB'), 'CUDA out of memory: tried 50% | of 6 GB');
    assert.equal(withoutProgressBars(''), '');
});
