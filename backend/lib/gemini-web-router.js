// Gemini Web Router: DR Dubber's transcribe / translate requests answered by gemini.google.com
// with spare Gmail accounts instead of API keys (no key, no API quota; each free account has its
// own credits). Pieces:
//  - python/gemini_web_server.py: one Gemini connection per Gmail from its saved sign-in
//    cookies (no browser), round robin, credits. Runs in its own small venv (gemini_webapi).
//  - Add Gmail: email + password typed into a hidden Chrome (lib/gemini-web.js drives it);
//    when Google asks for a code the app shows a box for it; the cookies are then saved and
//    Chrome closes. Passwords are never stored.
//  - Each ready account is a pool key "gweb:<id>" (keysForDubber), so the existing key rotation,
//    lanes and retries in routes/gemini.js work unchanged; executeGeminiGenerate hands such a
//    key to generate() here. Transcription then retimes the lines on the PC (gemini-web-timing).

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { STORAGE_BASE } = require('./paths');
const { trackProcess } = require('./process-tracker');
const { GeminiWebSession } = require('./gemini-web');

const KEY_PREFIX = 'gweb:';
const DIR = path.join(STORAGE_BASE, 'gemini_web');
const ACCOUNTS_FILE = path.join(DIR, 'accounts.json');
const SETTINGS_FILE = path.join(DIR, 'settings.json');
const COOKIE_DIR = path.join(DIR, 'cookies');
const ENV_DIR = path.join(os.homedir(), 'DR Dubber Gemini Web');
const isWin = process.platform === 'win32';
// The sign-in Chrome profiles live here, outside the app folder: Chrome puts its built-in
// extensions (with their own *.test.js files) in them, which `npm test` would pick up.
const PROFILE_DIR = path.join(ENV_DIR, 'profiles');
const VENV_PY = path.join(ENV_DIR, 'venv', isWin ? 'Scripts\\python.exe' : 'bin/python');
const SERVER_SCRIPT = path.join(__dirname, '..', 'python', 'gemini_web_server.py').replace('app.asar', 'app.asar.unpacked');
const LIB_VERSION = '2.1.1';
const SERVICE_PORT = 8790;
const SIGNIN_TIMEOUT_MS = 6 * 60 * 1000;
const KEEPER_MS = 10 * 60 * 1000;           // how often sign-ins are checked

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
function writeJson(f, data) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(data, null, 1));
    fs.renameSync(`${f}.tmp`, f);
}

function run(cmd, args, onLine) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args, { windowsHide: true });
        trackProcess(p);
        let out = '';
        const take = (d) => {
            const s = d.toString('utf8');
            out += s;
            if (onLine) s.split(/\r?\n/).filter(Boolean).forEach(onLine);
        };
        p.stdout.on('data', take);
        p.stderr.on('data', take);
        p.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
        p.on('close', (code) => resolve({ code, out }));
    });
}

function findChrome() {
    const pf = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const list = isWin
        ? [...pf.map(p => path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')), ...pf.map(p => path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))]
        : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];
    return list.find(p => fs.existsSync(p)) || null;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.unref();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

// payload (Gemini API request) -> one prompt text + files for the website.
function payloadToPrompt(payload, tmpDir) {
    const EXT = { 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/flac': '.flac', 'audio/aac': '.aac', 'audio/mp4': '.m4a', 'audio/webm': '.webm', 'video/mp4': '.mp4', 'video/webm': '.webm', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
    const texts = [];
    const files = [];
    const sys = payload && payload.systemInstruction && payload.systemInstruction.parts;
    if (Array.isArray(sys)) texts.push(sys.map(p => p.text || '').join('\n'));
    let pictures = 0;
    for (const c of (payload && payload.contents) || []) {
        for (const p of c.parts || []) {
            if (p.text) texts.push(p.text);
            const d = p.inlineData || p.inline_data;
            if (d && d.data) {
                const mime = d.mimeType || d.mime_type || 'application/octet-stream';
                const f = path.join(tmpDir, `part${files.length + 1}${EXT[mime] || '.bin'}`);
                fs.writeFileSync(f, Buffer.from(d.data, 'base64'));
                files.push(f);
                if (/^image\//.test(mime)) texts.push(`[attached picture ${++pictures}]`);
                else if (/^audio\//.test(mime)) texts.push('[the attached audio file]');
                else if (/^video\//.test(mime)) texts.push('[the attached video file]');
            }
        }
    }
    const gen = payload && payload.generationConfig;
    if (gen && (gen.responseMimeType === 'application/json' || gen.responseSchema)) {
        texts.push('Output ONLY the raw JSON. No markdown code fences, no words before or after it.');
    }
    return { prompt: texts.filter(Boolean).join('\n\n'), files };
}

function maskProxy(url) {
    return url ? String(url).replace(/\/\/([^:@/]*):[^@/]*@/, '//$1:****@') : null;
}

function stripFences(t) {
    const s = String(t || '').trim();
    const m = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/);
    return m ? m[1].trim() : s;
}

class GeminiWebRouter {
    constructor() {
        this.proc = null;
        this.starting = null;
        this.statusCache = { at: 0, accounts: [] };
        this.signIns = new Map(); // id -> { state, message, detail, chrome, session, password, code }
        this.inFlight = new Map(); // account id -> requests from this app being answered right now
        this.refreshTried = new Map(); // account id -> last refresh from its Chrome profile (ms)
        this.refreshFailed = new Set(); // Gmails whose Chrome profile is signed out too (need Sign in again)
        this.failLogged = new Map(); // "id|code" -> last time that failure was logged
        this.install = { running: false, lines: [], error: null };
        this.serviceError = null;
        fs.mkdirSync(COOKIE_DIR, { recursive: true });
    }

    // ---- settings / accounts ---------------------------------------------------------------
    // model: '' = each Gmail's own default (free Gmails only have Auto); thinking: standard | extended.
    // routerFirst: Gmails before API keys (see orderPool in routes/gemini.js). Read for every
    // request, so cached for a few seconds.
    settings() {
        if (this._settings && Date.now() - this._settings.at < 3000) return this._settings.value;
        const value = { useForDubbing: true, model: '', thinking: 'standard', routerFirst: true, gmailOnly: false, ...readJson(SETTINGS_FILE, {}) };
        this._settings = { at: Date.now(), value };
        return value;
    }
    setSettings(patch) {
        const clean = {};
        if ('useForDubbing' in patch) clean.useForDubbing = !!patch.useForDubbing;
        if ('routerFirst' in patch) clean.routerFirst = !!patch.routerFirst;
        if ('gmailOnly' in patch) clean.gmailOnly = !!patch.gmailOnly;
        if ('model' in patch) clean.model = String(patch.model || '').slice(0, 80);
        if ('thinking' in patch) clean.thinking = patch.thinking === 'extended' ? 'extended' : 'standard';
        const s = { ...this.settings(), ...clean };
        writeJson(SETTINGS_FILE, s);
        this._settings = { at: Date.now(), value: s };
        return s;
    }
    accounts() { return readJson(ACCOUNTS_FILE, []).filter(a => a && a.id); }
    saveAccounts(list) { writeJson(ACCOUNTS_FILE, list); }

    // A proxy from DR Router PRO's list ({proxyId}) or typed in ({proxy}); '' / null = none.
    resolveProxy({ proxyId, proxy } = {}) {
        const { parseProxyString, getDRRouterManager } = require('./dr-router');
        if (proxyId) {
            const p = (getDRRouterManager().proxies || []).find(x => x.id === proxyId);
            if (!p) throw new Error('That proxy is no longer in DR Router PRO.');
            return p.url;
        }
        if (!proxy || !String(proxy).trim()) return null;
        const parsed = parseProxyString(String(proxy));
        if (!parsed) throw new Error('Could not read that proxy. Use host:port, host:port:user:pass or http://user:pass@host:port.');
        if (!/^(https?|socks5h?|socks4)$/.test(parsed.protocol)) throw new Error(`Proxy type "${parsed.protocol}" is not supported (http, https or socks5).`);
        return parsed.url;
    }

    proxyChoices() {
        try {
            const { getDRRouterManager } = require('./dr-router');
            return (getDRRouterManager().proxies || []).filter(p => p.enabled !== false)
                .map(p => ({ id: p.id, label: maskProxy(p.url), status: p.status || null }));
        } catch (e) { return []; }
    }

    addAccount(email, proxy) {
        email = String(email || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Type a full Gmail address.');
        const list = this.accounts();
        const have = list.find(a => a.email === email);
        if (have) {
            if (proxy !== undefined) { have.proxy = proxy || null; this.saveAccounts(list); }
            return have;
        }
        const acc = { id: `g${crypto.randomBytes(4).toString('hex')}`, email, enabled: true, addedAt: Date.now(), proxy: proxy || null };
        list.push(acc);
        this.saveAccounts(list);
        return acc;
    }

    async setProxy(id, proxy) {
        if (!this.accounts().some(a => a.id === id)) throw new Error('Unknown account.');
        this.saveAccounts(this.accounts().map(a => (a.id === id ? { ...a, proxy: proxy || null } : a)));
        await this.reload();
    }

    async removeAccount(id) {
        this.cancelSignIn(id);
        this.saveAccounts(this.accounts().filter(a => a.id !== id));
        fs.rmSync(path.join(COOKIE_DIR, `${id}.json`), { force: true });
        fs.rmSync(path.join(PROFILE_DIR, id), { recursive: true, force: true });
        await this.reload();
    }

    async setEnabled(id, enabled) {
        this.saveAccounts(this.accounts().map(a => (a.id === id ? { ...a, enabled: !!enabled } : a)));
        await this.reload();
    }

    // ---- Python environment ----------------------------------------------------------------
    envReady() { return fs.existsSync(VENV_PY) && fs.existsSync(path.join(ENV_DIR, 'ready.json')); }

    async installEnv() {
        if (this.install.running) return;
        this.install = { running: true, lines: [], error: null };
        const say = (l) => { this.install.lines.push(l); if (this.install.lines.length > 200) this.install.lines.shift(); };
        try {
            fs.mkdirSync(ENV_DIR, { recursive: true });
            if (!fs.existsSync(VENV_PY)) {
                const tries = isWin ? [['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']], ['python', []]] : [['python3', []], ['python', []]];
                let made = false;
                for (const [cmd, pre] of tries) {
                    const v = await run(cmd, [...pre, '-c', 'import sys; print(sys.version_info[:2] >= (3, 10))']);
                    if (v.code !== 0 || !/True/.test(v.out)) continue;
                    say(`Creating a private Python environment with ${cmd} ${pre.join(' ')}`);
                    const r = await run(cmd, [...pre, '-m', 'venv', path.join(ENV_DIR, 'venv')], say);
                    if (r.code === 0) { made = true; break; }
                }
                if (!made) throw new Error('Python 3.10 or newer was not found on this PC. Install it from python.org, then try again.');
            }
            say(`Installing gemini_webapi ${LIB_VERSION}`);
            const r = await run(VENV_PY, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', `gemini_webapi==${LIB_VERSION}`], say);
            if (r.code !== 0) throw new Error('Installing gemini_webapi failed (see the log above).');
            writeJson(path.join(ENV_DIR, 'ready.json'), { lib: LIB_VERSION, at: Date.now() });
            say('Done.');
        } catch (e) {
            this.install.error = e.message;
            say(`Error: ${e.message}`);
        } finally {
            this.install.running = false;
        }
    }

    // ---- the service -----------------------------------------------------------------------
    async call(pathname, body, timeoutMs = 15000) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(`http://127.0.0.1:${SERVICE_PORT}${pathname}`, body === undefined
                ? { signal: ctrl.signal }
                : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
            const j = await res.json();
            if (j && Array.isArray(j.accounts)) this.statusCache = { at: Date.now(), accounts: j.accounts };
            return j;
        } finally { clearTimeout(t); }
    }

    running() { return !!this.proc; }

    async ensureService() {
        if (this.proc) return true;
        if (this.starting) return this.starting;
        if (!this.envReady()) { this.serviceError = 'The Gemini Web Python part is not installed yet.'; return false; }
        this.starting = (async () => {
            // A service left over from an earlier run (or the other copy of the app) answers already.
            try { const j = await this.call('/status', undefined, 1500); if (j && j.ok) { this.external = true; return true; } } catch (e) { }
            const p = spawn(VENV_PY, ['-I', SERVER_SCRIPT, '--dir', DIR, '--port', String(SERVICE_PORT)], { windowsHide: true });
            trackProcess(p);
            let tail = '';
            const onData = (d) => {
                const s = d.toString('utf8');
                tail = (tail + s).slice(-3000);
                s.split(/\r?\n/).filter(l => l.startsWith('[GeminiWeb]')).forEach(l => console.log(l));
            };
            p.stdout.on('data', onData);
            p.stderr.on('data', onData);
            p.on('close', (code) => {
                if (this.proc === p) this.proc = null;
                this.serviceError = `Gemini Web service stopped (code ${code}): ${tail.split('\n').filter(Boolean).slice(-2).join(' | ')}`;
                console.warn(`[GeminiWeb] ${this.serviceError}`);
            });
            this.proc = p;
            for (let i = 0; i < 120; i++) {
                await sleep(500);
                if (!this.proc) return false;
                try { const j = await this.call('/status', undefined, 1500); if (j && j.ok) { this.serviceError = null; this.startKeeper(); return true; } } catch (e) { }
            }
            this.serviceError = 'Gemini Web service did not start in 60 s.';
            return false;
        })();
        try { return await this.starting; } finally { this.starting = null; }
    }

    stopService() {
        clearInterval(this.keeperTimer);
        this.keeperTimer = null;
        if (this.proc) { try { this.proc.kill(); } catch (e) { } this.proc = null; }
    }

    // ---- keeping sign-ins alive -------------------------------------------------------------
    // Google ends a session whose cookies are used outside the browser that signed in, after a
    // few hours (2026-11-08: a Gmail signed in at 09:10 was signed out by ~12:30; four signed
    // in the evening before were all out by morning). The sign-in Chrome profile stays signed
    // in, so its fresh cookies bring the Gmail back - no password. Checked every KEEPER_MS (and
    // at once when a request is refused as signed out); a working Gmail is left alone.
    startKeeper() {
        if (this.keeperTimer) return;
        const run = () => this.keepSessionsAlive().catch((e) => console.warn(`[GeminiWeb] keeping sign-ins alive failed: ${e.message}`));
        setTimeout(run, 15000);
        this.keeperTimer = setInterval(run, KEEPER_MS);
        if (this.keeperTimer.unref) this.keeperTimer.unref();
    }

    async keepSessionsAlive() {
        if (this.keeping) return;
        this.keeping = true;
        try {
            const st = await this.call('/status').catch(() => null);
            if (!st || !Array.isArray(st.accounts)) return;
            const list = this.accounts();
            for (const live of st.accounts) {
                const acc = list.find((a) => a.id === live.id);
                if (!acc || !acc.enabled || this.signIns.has(acc.id)) continue;
                if (!fs.existsSync(path.join(PROFILE_DIR, acc.id))) continue; // nothing to refresh from
                // Only a Gmail Google signed out. A planned refresh of working ones (every 2 h)
                // was tried and did harm: 2026-11-08 it caught Chrome before it had renewed the
                // session, wrote dead cookies and took all five Gmails out for ~30 min.
                if (live.state !== 'signed_out') continue;
                if (Date.now() - (this.refreshTried.get(acc.id) || 0) < 10 * 60 * 1000) continue;
                this.refreshTried.set(acc.id, Date.now());
                const ok = await this.refreshFromProfile(acc.id);
                if (ok) this.refreshFailed.delete(acc.id); else this.refreshFailed.add(acc.id);
                console.log(`[GeminiWeb] ${acc.email}: ${ok ? 'signed in again from its Chrome profile' : 'still signed out - its Chrome profile could not bring it back: sign in again'}`);
            }
        } finally { this.keeping = false; }
    }

    // Opens the Gmail's sign-in Chrome profile hidden; if Gemini there is signed in as that
    // Gmail, its cookies replace the saved ones and the service reconnects it. true / false.
    async refreshFromProfile(id) {
        const acc = this.accounts().find((a) => a.id === id);
        const chromePath = findChrome();
        const profile = path.join(PROFILE_DIR, id);
        if (!acc || !chromePath || !fs.existsSync(profile) || this.signIns.has(id)) return false;
        const port = await freePort();
        const chrome = spawn(chromePath, [
            `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
            '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
            '--window-position=-32000,-32000', '--window-size=1000,900', '--lang=en-US',
            ...(acc.proxy ? (() => { const p = require('./dr-router').parseProxyString(acc.proxy); return p && !(/^socks/.test(p.protocol) && (p.username || p.password)) ? [`--proxy-server=${p.protocol.replace(/^socks5h$/, 'socks5')}://${p.host}:${p.port}`] : []; })() : []),
            'about:blank'
        ], { windowsHide: false, stdio: 'ignore' });
        trackProcess(chrome);
        let session = null;
        try {
            for (let i = 0; i < 40 && !session; i++) {
                await sleep(500);
                try { session = await new GeminiWebSession({ port, match: null }).connect(); } catch (e) { }
            }
            if (!session) return false;
            if (acc.proxy) {
                const p = require('./dr-router').parseProxyString(acc.proxy);
                if (p && (p.username || p.password)) {
                    session.cdp.listeners.add((msg) => {
                        if (msg.sessionId !== session.sid) return;
                        if (msg.method === 'Fetch.authRequired') session.cdp.send('Fetch.continueWithAuth', { requestId: msg.params.requestId, authChallengeResponse: msg.params.authChallenge && msg.params.authChallenge.source === 'Proxy' ? { response: 'ProvideCredentials', username: p.username, password: p.password } : { response: 'Default' } }, session.sid).catch(() => {});
                        else if (msg.method === 'Fetch.requestPaused') session.cdp.send('Fetch.continueRequest', { requestId: msg.params.requestId }, session.sid).catch(() => {});
                    });
                    await session.cdp.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] }, session.sid);
                }
            }
            // Chrome renews the session a little after the page opens; cookies taken too early
            // are already dead (seen 2026-11-08). So: copy, check the Gmail really comes back,
            // and if not, reload Gemini, wait longer and copy again.
            for (let attempt = 1; attempt <= 3; attempt++) {
                await session.cdp.send('Page.navigate', { url: 'https://gemini.google.com/app' }, session.sid);
                await session.waitFor('editor()', 45000, 'the Gemini page');
                await sleep(attempt * 5000);
                const who = await session.account();
                if (!who.signedIn || (who.email && who.email.toLowerCase() !== acc.email.toLowerCase())) return false;
                const { cookies } = await session.cdp.send('Storage.getCookies');
                const jar = {};
                for (const c of cookies.filter((c) => /(^|\.)google\.com$/.test(c.domain))) jar[c.name] = c.value;
                if (!jar['__Secure-1PSID']) return false;
                writeJson(path.join(COOKIE_DIR, `${id}.json`), jar);
                this.saveAccounts(this.accounts().map((a) => (a.id === id ? { ...a, refreshedAt: Date.now() } : a)));
                await this.reload();
                for (let i = 0; i < 20; i++) {
                    const st = await this.call('/status').catch(() => null);
                    const live = st && st.accounts && st.accounts.find((a) => a.id === id);
                    if (live && live.state === 'ready') return true;
                    if (live && live.state !== 'starting') break;
                    await sleep(1500);
                }
                console.log(`[GeminiWeb] ${acc.email}: fresh cookies not accepted yet (try ${attempt} of 3)`);
            }
            return false;
        } catch (e) {
            return false;
        } finally {
            try { if (session) await session.cdp.send('Browser.close'); } catch (e) { }
            try { if (session) session.close(); } catch (e) { }
            setTimeout(() => { try { if (chrome.exitCode === null) chrome.kill(); } catch (e) { } }, 3000);
        }
    }

    async reload() {
        if (!(await this.ensureService())) return null;
        return this.call('/reload', {}, 120000).catch(() => null);
    }

    async status({ quota = false } = {}) {
        let svc = null;
        if (this.envReady()) {
            const up = await this.ensureService();
            if (up) svc = await this.call(quota ? '/quota' : '/status', quota ? {} : undefined, 60000).catch(() => null);
        }
        const live = new Map(((svc && svc.accounts) || []).map(a => [a.id, a]));
        return {
            envReady: this.envReady(),
            install: this.install,
            running: !!svc,
            serviceError: svc ? null : this.serviceError,
            settings: this.settings(),
            chrome: !!findChrome(),
            timing: require('./gemini-web-timing').available(),
            proxyChoices: this.proxyChoices(),
            accounts: this.accounts().map(a => ({
                ...a,
                ...(live.get(a.id) || { state: fs.existsSync(path.join(COOKIE_DIR, `${a.id}.json`)) ? 'starting' : 'signed_out' }),
                proxy: maskProxy(a.proxy), // never the password
                signIn: this.signInInfo(a.id)
            }))
        };
    }

    // Pool keys for DR Dubber's jobs: ready accounts, when the router is switched on.
    keysForDubber() {
        if (!this.settings().useForDubbing) return [];
        if (!this.proc && !this.external) { this.ensureService().catch(() => {}); return []; }
        if (Date.now() - this.statusCache.at > 15000) this.call('/status').catch(() => {});
        // Most credits left first, so the work spreads over the Gmails instead of draining the
        // first one in the list (a job's first lane takes the first key).
        const left = (a) => (a.quota && a.quota.total ? a.quota.remaining / a.quota.total : 1);
        // Gmails only: a Gmail Google just signed out stays in the list while its Chrome profile
        // signs it back in (seconds) - its requests wait and retry instead of going to API keys.
        const gmailOnly = this.settings().gmailOnly === true;
        const usable = (a) => a.state === 'ready' || (gmailOnly && a.state === 'signed_out' && !this.refreshFailed.has(a.id) && fs.existsSync(path.join(PROFILE_DIR, a.id)));
        return this.statusCache.accounts.filter(a => a.enabled && usable(a))
            .sort((a, b) => (a.state === 'ready' ? 0 : 1) - (b.state === 'ready' ? 0 : 1) || left(b) - left(a))
            .map(a => KEY_PREFIX + a.id);
    }

    isKey(key) { return typeof key === 'string' && key.startsWith(KEY_PREFIX); }
    emailOf(key) { const a = this.accounts().find(x => KEY_PREFIX + x.id === key); return a ? a.email : key; }

    // executeGeminiGenerate-shaped answer for a "gweb:<id>" key.
    // noWait: a Gmail already working answers "busy" at once (the caller has an API key to use
    // instead) rather than queueing the request behind the one it is doing.
    // The "busy" answer for a Gmail already working on a request from this app, else null.
    busyResult(key) {
        const id = key.slice(KEY_PREFIX.length);
        if (!(this.inFlight.get(id) > 0)) return null;
        const msg = `Gemini Web (${this.emailOf(key)}) is busy with another request`;
        return { success: false, status: 502, code: 'GWEB_BUSY', error: msg, message: msg };
    }

    async generate(key, payload, signal, { timeoutMs = 10 * 60 * 1000, noWait = false } = {}) {
        const id = key.slice(KEY_PREFIX.length);
        if (noWait) { const busy = this.busyResult(key); if (busy) return busy; }
        this.inFlight.set(id, (this.inFlight.get(id) || 0) + 1);
        try { return await this.generateOnce(key, id, payload, signal, timeoutMs, noWait); }
        finally { this.inFlight.set(id, Math.max(0, (this.inFlight.get(id) || 1) - 1)); }
    }

    async generateOnce(key, id, payload, signal, timeoutMs, noWait) {
        if (!(await this.ensureService())) {
            return { success: false, status: 403, error: 'INVALID_API_KEY', message: this.serviceError || 'Gemini Web Router is not running.' };
        }
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gweb_'));
        try {
            const { prompt, files } = payloadToPrompt(payload, tmp);
            const set = this.settings();
            const req = this.call('/generate', {
                account: id, prompt, files, timeoutSec: Math.round(timeoutMs / 1000),
                model: set.model || null, extendedThinking: set.thinking === 'extended', noWait: !!noWait
            }, timeoutMs + 30000);
            const aborted = signal ? new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true })) : null;
            const r = await (aborted ? Promise.race([req, aborted]) : req);
            this.call('/status').catch(() => {});
            if (r && r.ok) {
                const text = stripFences(r.text);
                return { success: true, text, finishReason: 'STOP', modelUsed: `gemini-web: ${r.model || 'auto'}`, fellBack: false, gweb: { email: r.email, ms: r.ms, model: r.model } };
            }
            const msg = `Gemini Web (${(r && r.email) || this.emailOf(key)}): ${(r && r.error) || 'no answer'}`;
            // Logged (once a minute per Gmail and kind): these used to fail silently, the job
            // just moving on to an API key - a whole series ran on API keys unnoticed.
            const code = (r && r.code) || 'ERROR';
            const fk = `${id}|${code}`;
            if (code !== 'BUSY' && Date.now() - (this.failLogged.get(fk) || 0) > 60000) {
                this.failLogged.set(fk, Date.now());
                console.warn(`[GeminiWeb] ${code}: ${msg}`);
            }
            if (code === 'SIGNED_OUT' || code === 'NOT_READY') this.keepSessionsAlive().catch(() => {}); // sign it back in now
            switch (r && r.code) {
                // Busy with another job: a passing "server" failure, so the key rotation moves
                // straight on to the next key without parking this Gmail.
                case 'BUSY': return { success: false, status: 502, code: 'GWEB_BUSY', error: msg, message: msg };
                case 'QUOTA': return { success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED', isDailyQuota: true, retryAfterMs: 30 * 60 * 1000, message: msg };
                case 'BLOCKED': return { success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED', retryAfterMs: 15 * 60 * 1000, message: msg };
                // Signed out by Google (or not back yet): a passing failure, not a bad key - it
                // was parked 10 min like a refused API key, its episodes going to API keys. The
                // keeper signs it back in from its Chrome profile meanwhile (started above).
                case 'SIGNED_OUT': case 'NOT_READY': return { success: false, status: 502, code: 'GWEB_SIGNED_OUT', error: msg, message: msg };
                case 'NO_ACCOUNT': return { success: false, status: 403, error: 'INVALID_API_KEY', message: msg };
                case 'TIMEOUT': return { success: false, status: 504, error: msg, message: msg };
                default: return { success: false, status: 502, error: msg, message: msg };
            }
        } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            return { success: false, status: 502, error: `Gemini Web: ${e.message}`, message: `Gemini Web: ${e.message}` };
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    // ---- Add Gmail: sign in in a hidden Chrome --------------------------------------------
    signInInfo(id) {
        const s = this.signIns.get(id);
        return s ? { state: s.state, message: s.message, detail: s.detail || null, visible: !!s.visible } : null;
    }

    cancelSignIn(id) {
        const s = this.signIns.get(id);
        if (!s) return;
        s.cancelled = true;
        this.closeChrome(s);
        this.signIns.delete(id);
    }

    async closeChrome(s) {
        try { if (s.session) await s.session.cdp.send('Browser.close'); } catch (e) { }
        try { if (s.session) s.session.close(); } catch (e) { }
        setTimeout(() => { try { if (s.chrome && s.chrome.exitCode === null) s.chrome.kill(); } catch (e) { } }, 3000);
        s.session = null;
    }

    async startSignIn(id, password) {
        const acc = this.accounts().find(a => a.id === id);
        if (!acc) throw new Error('Unknown account.');
        const chromePath = findChrome();
        if (!chromePath) throw new Error('Google Chrome (or Edge) is needed for the one-time sign-in.');
        this.cancelSignIn(id);
        const s = { state: 'working', message: 'Opening Google sign-in…', password: String(password || ''), email: acc.email, code: null };
        this.signIns.set(id, s);
        this.runSignIn(id, s, chromePath).catch((e) => {
            if (s.cancelled) return;
            s.state = 'failed';
            s.message = e.message;
            this.closeChrome(s);
        });
        return this.signInInfo(id);
    }

    submitCode(id, code) {
        const s = this.signIns.get(id);
        if (!s || s.state !== 'need_code') throw new Error('No code is being asked for.');
        s.code = String(code || '').trim();
        s.state = 'working';
        s.message = 'Sending the code…';
        return this.signInInfo(id);
    }

    async showSignInWindow(id) {
        const s = this.signIns.get(id);
        if (!s || !s.session) throw new Error('No sign-in window is open.');
        const { windowId } = await s.session.cdp.send('Browser.getWindowForTarget', { targetId: s.session.targetId });
        await s.session.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        await s.session.cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 40, width: 1000, height: 900 } });
        s.visible = true;
        s.message = 'Finish the sign-in in the Chrome window. It closes by itself when Gemini opens.';
        return this.signInInfo(id);
    }

    async runSignIn(id, s, chromePath) {
        const profile = path.join(PROFILE_DIR, id);
        fs.mkdirSync(profile, { recursive: true });
        const port = await freePort();
        // The sign-in goes through the Gmail's proxy too, so Google sees one address from the start.
        const acc = this.accounts().find(a => a.id === id) || {};
        let proxy = null;
        if (acc.proxy) {
            proxy = require('./dr-router').parseProxyString(acc.proxy);
            if (proxy && /^socks/.test(proxy.protocol) && (proxy.username || proxy.password)) {
                throw new Error('Chrome cannot sign in through a SOCKS proxy with a password. Use an http proxy for this Gmail, or none.');
            }
        }
        s.chrome = spawn(chromePath, [
            `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
            '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
            '--window-position=-32000,-32000', '--window-size=1000,900', '--lang=en-US',
            ...(proxy ? [`--proxy-server=${proxy.protocol.replace(/^socks5h$/, 'socks5')}://${proxy.host}:${proxy.port}`, '--proxy-bypass-list=<-loopback>'] : []),
            'about:blank'
        ], { windowsHide: false, stdio: 'ignore' });
        trackProcess(s.chrome);
        for (let i = 0; i < 40 && !s.session; i++) {
            await sleep(500);
            try { s.session = await new GeminiWebSession({ port, match: null }).connect(); } catch (e) { }
        }
        if (!s.session) throw new Error('Chrome did not start.');
        const page = s.session;
        if (proxy && (proxy.username || proxy.password)) {
            // Answer the proxy's password request; let every other request through untouched.
            page.cdp.listeners.add((msg) => {
                if (msg.sessionId !== page.sid) return;
                if (msg.method === 'Fetch.authRequired') {
                    const isProxy = msg.params.authChallenge && msg.params.authChallenge.source === 'Proxy';
                    page.cdp.send('Fetch.continueWithAuth', {
                        requestId: msg.params.requestId,
                        authChallengeResponse: isProxy ? { response: 'ProvideCredentials', username: proxy.username, password: proxy.password } : { response: 'Default' }
                    }, page.sid).catch(() => {});
                } else if (msg.method === 'Fetch.requestPaused') {
                    page.cdp.send('Fetch.continueRequest', { requestId: msg.params.requestId }, page.sid).catch(() => {});
                }
            });
            await page.cdp.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] }, page.sid);
        }
        s.message = proxy ? `Opening Google sign-in through ${proxy.host}…` : 'Opening Google sign-in…';
        await page.cdp.send('Page.navigate', { url: `https://accounts.google.com/ServiceLogin?hl=en&continue=${encodeURIComponent('https://gemini.google.com/app')}` }, page.sid);
        const typeInto = async (sel, text) => {
            await page.eval(`const el = $q(${JSON.stringify(sel)}); el.focus(); el.select && el.select(); return 1;`);
            await page.cdp.send('Input.insertText', { text }, page.sid);
            await sleep(300);
            for (const type of ['keyDown', 'keyUp']) {
                await page.cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }, page.sid);
            }
        };
        const done = { email: false, password: false, code: null };
        const until = Date.now() + SIGNIN_TIMEOUT_MS;
        while (Date.now() < until) {
            if (s.cancelled) return;
            await sleep(700);
            let st;
            try {
                st = await page.eval(`
                    const vis = (sel) => { const e = $q(sel); return !!(e && e.offsetParent !== null); };
                    const codeSel = ['input[name=totpPin]', 'input#idvPin', 'input[name=Pin]', 'input[type=tel]', 'input[name=code]', 'input[autocomplete=one-time-code]'].find(vis) || null;
                    return {
                        url: location.href,
                        gemini: location.hostname === 'gemini.google.com' && !!editor(),
                        email: vis('input#identifierId') || vis('input[type=email]'),
                        password: vis('input[name=Passwd]') || vis('input[type=password]'),
                        codeSel,
                        heading: (($q('h1') || {}).innerText || '').trim(),
                        text: (document.body ? document.body.innerText : '').slice(0, 1500)
                    };`);
            } catch (e) { continue; } // page in the middle of loading
            if (st.gemini) break;
            const text = st.text || '';
            if (/couldn.t sign you in|browser or app may not be secure|this browser.*not be secure/i.test(text)) {
                s.state = 'need_window';
                s.message = 'Google did not allow the hidden sign-in. Click "Show window" and sign in there once.';
                continue;
            }
            if (/wrong password|password was changed/i.test(text) && done.password && !st.codeSel) {
                throw new Error('Google says the password is wrong.');
            }
            if (/couldn.t find your google account/i.test(text)) throw new Error('Google could not find that Gmail address.');
            if (st.email && !done.email) {
                s.message = 'Typing the Gmail address…';
                await typeInto(st.email ? 'input#identifierId, input[type=email]' : 'input[type=email]', s.email);
                done.email = true;
                continue;
            }
            if (st.password && !done.password) {
                if (!s.password) { s.state = 'need_window'; s.message = 'Type the password: click "Show window".'; continue; }
                s.message = 'Typing the password…';
                await typeInto('input[name=Passwd], input[type=password]', s.password);
                done.password = true;
                s.password = '';
                continue;
            }
            if (st.codeSel) {
                if (s.code && s.code !== done.code) {
                    s.message = 'Sending the code…';
                    await typeInto(st.codeSel, s.code);
                    done.code = s.code;
                    continue;
                }
                if (s.state !== 'need_code' || !s.code || s.code === done.code) {
                    s.state = 'need_code';
                    s.message = st.heading || 'Google asks for a code';
                    s.detail = text.split('\n').map(l => l.trim()).filter(l => l && l.length < 200).slice(0, 8).join('\n');
                    s.code = s.code === done.code ? null : s.code;
                }
                continue;
            }
            if (/challenge|signin\/v2|speedbump|signin\/rejected|recovery/i.test(st.url) && done.password && !s.visible) {
                s.state = 'need_action';
                s.message = st.heading || 'Google wants to confirm it is you';
                s.detail = text.split('\n').map(l => l.trim()).filter(l => l && l.length < 200).slice(0, 8).join('\n');
                continue;
            }
            if (s.state !== 'need_window' && s.state !== 'need_code') { s.state = 'working'; if (done.password) s.message = 'Signing in…'; }
        }
        if (s.cancelled) return;
        const ok = await page.eval(`return location.hostname === 'gemini.google.com' && !!editor();`).catch(() => false);
        if (!ok) throw new Error('Sign-in did not finish in 6 minutes.');
        s.message = 'Signed in. Saving…';
        await sleep(1500);
        const { cookies } = await page.cdp.send('Storage.getCookies');
        const jar = {};
        for (const c of cookies.filter(c => /(^|\.)google\.com$/.test(c.domain))) jar[c.name] = c.value;
        if (!jar['__Secure-1PSID']) throw new Error('Signed in, but Google gave no sign-in cookie. Try again.');
        writeJson(path.join(COOKIE_DIR, `${id}.json`), jar);
        await this.closeChrome(s);
        s.state = 'done';
        s.message = 'Signed in';
        this.refreshFailed.delete(id);
        this.saveAccounts(this.accounts().map(a => (a.id === id ? { ...a, signedInAt: Date.now() } : a)));
        await this.reload();
        setTimeout(() => { if (this.signIns.get(id) === s) this.signIns.delete(id); }, 60000);
    }
}

let instance = null;
function getGeminiWebRouter() { return instance || (instance = new GeminiWebRouter()); }

module.exports = { getGeminiWebRouter, KEY_PREFIX, payloadToPrompt, stripFences };
