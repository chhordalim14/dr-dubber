// main.js (the Electron shell) cannot be loaded outside Electron, so the pieces that broke in
// the field are lifted out of its source and run here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const pageSrc = fs.readFileSync(path.join(root, 'frontend', 'js', 'studio-main.js'), 'utf8').replace(/\r\n/g, '\n');
const preloadSrc = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function between(src, from, to) {
    const a = src.indexOf(from);
    assert.ok(a >= 0, `"${from}" not found`);
    const b = src.indexOf(to, a);
    assert.ok(b > a, `"${to}" not found after "${from}"`);
    return src.slice(a, b);
}

// "Get a key from AI Studio": the handler as main.js has it, with a clipboard and a clock we control.
function loadGoogleLogin({ clipboard, waitMs = 5 * 60 * 1000 }) {
    const body = between(mainSrc, 'const AI_STUDIO_KEYS_URL', '// Whisper Local Transcription Handlers')
        .replace('const KEY_WAIT_MS = 5 * 60 * 1000;', `const KEY_WAIT_MS = ${waitMs};`);
    const handlers = {};
    const opened = [];
    const fastTimeout = (fn) => setTimeout(fn, 1); // the handler looks once a second; here at once
    new Function('clipboard', 'shell', 'handle', 'setTimeout', body)(
        clipboard,
        { openExternal: async (url) => { opened.push(url); } },
        (channel, fn) => { handlers[channel] = fn; },
        fastTimeout,
    );
    return { login: handlers['dr-router:googleLogin'], opened };
}

const KEY_A = 'AIza' + 'a'.repeat(35);
const KEY_B = 'AIza' + 'b'.repeat(35);

test('AI Studio key: Electron 44 hands the clipboard over as a promise - the new key is still found', async () => {
    let text = `old ${KEY_A}`;
    const clipboard = { readText: () => Promise.resolve(text) }; // Electron 44+
    const { login, opened } = loadGoogleLogin({ clipboard });
    const waiting = login();
    setTimeout(() => { text = `here it is: ${KEY_B}\n`; }, 20);
    assert.deepEqual(await waiting, { success: true, email: '', apiKey: KEY_B });
    assert.deepEqual(opened, ['https://aistudio.google.com/app/apikey']);
});

test('AI Studio key: an older Electron returning the text itself works the same', async () => {
    let text = '';
    const { login } = loadGoogleLogin({ clipboard: { readText: () => text } });
    const waiting = login();
    setTimeout(() => { text = KEY_A; }, 20);
    assert.equal((await waiting).apiKey, KEY_A);
});

test('AI Studio key: a key already on the clipboard does not count, and nothing new ends in a clear message', async () => {
    const { login } = loadGoogleLogin({ clipboard: { readText: async () => KEY_A }, waitMs: 30 });
    const res = await login();
    assert.equal(res.success, false);
    assert.match(res.error, /No new API key was copied/);
});

test('AI Studio key: a clipboard that cannot be read is "no key yet", never a crash', async () => {
    let calls = 0;
    const clipboard = { readText: async () => { if (++calls < 4) throw new Error('clipboard busy'); return KEY_B; } };
    const { login } = loadGoogleLogin({ clipboard });
    assert.equal((await login()).apiKey, KEY_B);
});

test('AI Studio key: a second click shares the running watch and reopens the page', async () => {
    let text = '';
    const { login, opened } = loadGoogleLogin({ clipboard: { readText: async () => text } });
    const first = login();
    const second = login();
    setTimeout(() => { text = KEY_A; }, 20);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.apiKey, KEY_A);
    assert.deepEqual(b, a);
    assert.equal(opened.length, 2);
});

test('VoxCPM2 server: an old process ending never marks a newer server as stopped', () => {
    const start = between(mainSrc, "handle('voxcpm2:startServer'", '// One-click VoxCPM2 install');
    assert.match(start, /const replaced = \(\) => !!activeVoxServerJob && activeVoxServerJob\.child !== child;/);
    // Both ways a process can end check it before touching the job or telling the page.
    for (const event of ["child.on('close'", "child.on('error'"]) {
        const handler = start.slice(start.indexOf(event));
        assert.ok(handler.indexOf('if (replaced()) return;') < handler.indexOf('activeVoxServerJob = null'), `${event} checks first`);
    }
    // Stop Server answers only when the process is gone (or after 5 s at most).
    const stop = between(mainSrc, "handle('voxcpm2:stopServer'", "handle('voxcpm2:serverStatus'");
    assert.match(stop, /child\.once\('close', resolve\)/);
    assert.match(stop, /await Promise\.race\(\[gone,/);
    assert.ok(stop.indexOf('activeVoxServerJob = null') < stop.indexOf('killProcessTree(child)'));
});

test('VoxCPM2 server: the page reads the "stopped" message the way preload.js sends it', () => {
    // preload passes one argument (the data) ...
    assert.match(preloadSrc, /onVoxServerStopped: \(cb\) => ipcRenderer\.on\('voxcpm2:serverStopped', \(e, d\) => cb\(d\)\)/);
    // ... so the page's listener takes one argument, and tells a crash from a Stop click.
    assert.match(pageSrc, /onVoxServerStopped\(\(data\) => \{/);
    assert.doesNotMatch(pageSrc, /onVoxServerStopped\(\(_e, data\)/);
    assert.match(pageSrc, /data\?\.code && !data\.byUser/);
    assert.match(mainSrc, /send\('voxcpm2:serverStopped', \{ code, byUser \}\)/);
});

test('VoxCPM2 progress bars stay out of server.log but still reach the page', () => {
    const start = between(mainSrc, "child.stderr.on('data'", 'const replaced');
    assert.match(start, /const kept = withoutProgressBars\(str\);\s+if \(kept\) console\.warn\('\[VoxCPM2 Stderr\]', kept\);/);
    assert.match(start, /send\('voxcpm2:log', \{ type: 'stderr', text: str \}\)/);
});
