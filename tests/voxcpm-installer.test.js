// One-click VoxCPM2 install: what it builds is what "Start Server" runs, the server speaks
// the API backend/server.js calls, and the install folder is checked like any other path.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const { isInstalled } = require('../backend/lib/voxcpm-installer');

test('a folder counts as installed only with app.py, the venv python and a complete marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxinst-'));
    try {
        assert.equal(isInstalled(dir), false);
        fs.writeFileSync(path.join(dir, 'app.py'), '');
        const py = process.platform === 'win32' ? path.join(dir, 'venv', 'Scripts', 'python.exe') : path.join(dir, 'venv', 'bin', 'python');
        fs.mkdirSync(path.dirname(py), { recursive: true });
        fs.writeFileSync(py, '');
        assert.equal(isInstalled(dir), false, 'no marker: a half-finished install');
        fs.writeFileSync(path.join(dir, 'drdubber-voxcpm2.json'), JSON.stringify({ complete: true }));
        assert.equal(isInstalled(dir), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Start Server finds what the installer writes (app.py + venv python)', () => {
    const main = read('main.js');
    assert.match(main, /const candidates = \['app\.py'/);
    assert.match(main, /path\.join\(scriptDir, 'venv', 'Scripts', 'python\.exe'\)/);
    assert.match(main, /HF_HOME: path\.join\(scriptDir, 'cache'\)/);
    const inst = read('backend', 'lib', 'voxcpm-installer.js');
    assert.match(inst, /HF_HOME: path\.join\(dir, 'cache'\)/, 'model goes where the server will look');
    assert.match(inst, /path\.join\(dir, 'app\.py'\)/);
});

test('the server speaks the API the app calls', () => {
    const server = read('backend', 'server.js');
    const py = read('backend', 'python', 'voxcpm2_server.py');
    assert.match(server, /\$\{baseUrl\}\/api\/generate/);
    assert.match(py, /"\/api\/generate"/);
    for (const field of ['text', 'instruction', 'reference_audio_base64', 'cfg_value']) assert.ok(py.includes(`"${field}"`), field);
    assert.match(server, /data\.audio_base64/);
    assert.match(py, /"audio_base64":/);
    assert.match(py, /--port/);
    assert.match(py, /default="127\.0\.0\.1"/, 'local only');
    // the ping loop waits on GET /: 503 while the model loads
    assert.match(py, /\{"ready": 200, "loading": 503\}/);
});

test('install folders are local paths only', () => {
    const main = read('main.js');
    assert.match(main, /function voxInstallDir\(dir\) \{[\s\S]*?isNetworkPath\(d\) \|\| !path\.isAbsolute\(d\)/);
    assert.match(main, /handle\('voxcpm2:install', async/);
    assert.match(read('preload.js'), /voxInstall: \(opts\) => ipcRenderer\.invoke\('voxcpm2:install', opts\)/);
});
