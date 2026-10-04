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
