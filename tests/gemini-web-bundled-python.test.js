// Gemini Web Router (backend/lib/gemini-web-router.js) on a PC without Python 3.10+: the library is
// installed with the app's own Python (backend/python_env, the embeddable Python the installer
// ships, which has no venv module) into "DR Dubber Gemini Web/lib" with pip --target, and that
// folder is put first on sys.path. A fake home folder; the tests that run Python are skipped when
// backend/python_env is not set up (CI does not run setup_python_env.bat for tests).
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gweb-bundled-test-'));
process.env.APP_STORAGE_DIR = path.join(tmp, 'storage');
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
const { getGeminiWebRouter, tidyLibDir, BUNDLED_PY, LIB_DIR } = require('../backend/lib/gemini-web-router');

const ENV = path.join(tmp, 'DR Dubber Gemini Web');
const VENV_DIR = path.join(ENV, 'venv');
const VENV_PY = path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
const haveBundled = fs.existsSync(BUNDLED_PY);

beforeEach(() => fs.rmSync(ENV, { recursive: true, force: true }));

describe('Gemini Web Router: which Python runs it', () => {
    test('nothing set up: not installed', () => {
        const gw = getGeminiWebRouter();
        assert.equal(gw.pyEnv(), null);
        assert.equal(gw.envReady(), false);
    });

    test('LIB_DIR is in the fake home folder, next to where the venv would be', () => {
        assert.equal(LIB_DIR, path.join(ENV, 'lib'));
    });

    test('a venv (made from the PC\'s Python) is used as before, even beside a lib folder', () => {
        fs.mkdirSync(path.dirname(VENV_PY), { recursive: true });
        fs.writeFileSync(VENV_PY, '');
        fs.mkdirSync(LIB_DIR, { recursive: true });
        const env = getGeminiWebRouter().pyEnv();
        assert.equal(env.exe, VENV_PY);
        assert.equal(env.bundled, false);
        assert.deepEqual(env.script('s.py', ['--port', '1']), ['-I', 's.py', '--port', '1']);
        assert.deepEqual(env.pipInstall(['x']), ['-m', 'pip', 'install', 'x']);
        assert.deepEqual(env.code('print(1)'), ['-c', 'print(1)']);
    });

    test('no venv: the app\'s Python with the library folder', { skip: !haveBundled && 'backend/python_env not set up' }, () => {
        fs.mkdirSync(LIB_DIR, { recursive: true });
        const gw = getGeminiWebRouter();
        const env = gw.pyEnv();
        assert.equal(env.exe, BUNDLED_PY);
        assert.equal(env.bundled, true);
        const pip = env.pipInstall(['gemini_webapi']);
        assert.deepEqual(pip.slice(0, 7), ['-I', '-m', 'pip', 'install', '--target', LIB_DIR, '--upgrade']);
        assert.equal(pip[pip.length - 1], 'gemini_webapi');
        assert.deepEqual(env.pipFreeze().slice(0, 6), ['-I', '-m', 'pip', 'freeze', '--path', LIB_DIR]);
        assert.equal(gw.envReady(), false, 'not ready until ready.json is written');
        fs.writeFileSync(path.join(ENV, 'ready.json'), '{"lib":"2.1.1"}');
        assert.equal(gw.envReady(), true);
    });

    test('the service script runs with the library folder first, its own path as argv[0] and its arguments',
        { skip: !haveBundled && 'backend/python_env not set up' }, () => {
            fs.mkdirSync(LIB_DIR, { recursive: true });
            fs.writeFileSync(path.join(LIB_DIR, 'gweb_probe_mod.py'), 'WHERE = "lib"\n');
            const script = path.join(tmp, 'probe script.py');
            fs.writeFileSync(script, [
                'import sys, json, gweb_probe_mod',
                'print(json.dumps({"name": __name__, "argv": sys.argv, "first": sys.path[0], "mod": gweb_probe_mod.WHERE}))'
            ].join('\n'));
            const env = getGeminiWebRouter().pyEnv();
            const out = JSON.parse(execFileSync(env.exe, env.script(script, ['--dir', 'D', '--port', '8790']), { encoding: 'utf8' }).trim());
            assert.equal(out.name, '__main__');
            assert.deepEqual(out.argv, [script, '--dir', 'D', '--port', '8790']);
            assert.equal(path.resolve(out.first), path.resolve(LIB_DIR));
            assert.equal(out.mod, 'lib');
            const v = execFileSync(env.exe, env.code('import gweb_probe_mod; print(gweb_probe_mod.WHERE)'), { encoding: 'utf8' }).trim();
            assert.equal(v, 'lib');
        });
});

describe('Gemini Web Router: pip --target leaves the old .dist-info behind', () => {
    const touch = (name, secondsAgo) => {
        const d = path.join(LIB_DIR, name);
        fs.mkdirSync(d, { recursive: true });
        const t = new Date(Date.now() - secondsAgo * 1000);
        fs.utimesSync(d, t, t);
    };
    const left = () => fs.readdirSync(LIB_DIR).sort();

    test('after an update the new version\'s is kept, other packages untouched', () => {
        touch('gemini_webapi-2.0.0.dist-info', 3600);
        touch('gemini_webapi-2.1.1.dist-info', 5);
        touch('gemini_webapi', 5);
        touch('loguru-0.7.3.dist-info', 3600);
        tidyLibDir();
        assert.deepEqual(left(), ['gemini_webapi', 'gemini_webapi-2.1.1.dist-info', 'loguru-0.7.3.dist-info']);
    });

    test('after a rollback the older version, written last, is kept', () => {
        touch('gemini_webapi-2.1.1.dist-info', 3600);
        touch('gemini_webapi-2.0.0.dist-info', 5);
        touch('curl_cffi-0.16.3.dist-info', 3600);
        touch('curl_cffi-0.7.0.dist-info', 5);
        tidyLibDir();
        assert.deepEqual(left(), ['curl_cffi-0.7.0.dist-info', 'gemini_webapi-2.0.0.dist-info']);
    });

    test('no library folder: nothing happens', () => {
        assert.doesNotThrow(() => tidyLibDir());
    });
});
