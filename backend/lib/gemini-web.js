// Gemini Web driver: sends a prompt (and optionally a file) to gemini.google.com in a Chrome
// window that is already signed in, and reads the answer back. No API key, no quota.
// Each Gmail account = one Chrome profile started with --remote-debugging-port, so the
// router (gemini-web-router) can spread requests over several accounts.
// Talks the Chrome DevTools Protocol over Node's built-in WebSocket (Node 22+).

const fs = require('fs');
const path = require('path');

const GEMINI_URL = 'https://gemini.google.com/app';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CdpClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.seq = 0;
        this.pending = new Map();
        this.listeners = new Set();
    }

    open() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.wsUrl);
            this.ws = ws;
            ws.onopen = () => resolve(this);
            ws.onerror = e => reject(new Error(`DevTools connection failed: ${e.message || 'error'}`));
            ws.onclose = () => {
                for (const { reject: rj } of this.pending.values()) rj(new Error('Chrome window closed'));
                this.pending.clear();
            };
            ws.onmessage = ev => {
                const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
                if (msg.id && this.pending.has(msg.id)) {
                    const p = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
                    else p.resolve(msg.result);
                } else if (msg.method) {
                    for (const fn of this.listeners) fn(msg);
                }
            };
        });
    }

    send(method, params = {}, sessionId) {
        const id = ++this.seq;
        const body = { id, method, params };
        if (sessionId) body.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, method });
            this.ws.send(JSON.stringify(body));
        });
    }

    waitEvent(method, sessionId, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => { this.listeners.delete(fn); reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
            const fn = msg => {
                if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
                    clearTimeout(t);
                    this.listeners.delete(fn);
                    resolve(msg.params);
                }
            };
            this.listeners.add(fn);
        });
    }

    close() { try { this.ws.close(); } catch (_) { /* already closed */ } }
}

// In-page helpers, injected once per evaluate. Kept as plain strings so they run in the page.
const PAGE_HELPERS = `
const $q = (sel, root = document) => root.querySelector(sel);
const $qa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const editor = () => $q('rich-textarea .ql-editor[contenteditable="true"]') || $q('div.ql-editor[contenteditable="true"]') || $q('[contenteditable="true"][role="textbox"]');
const sendBtn = () => $q('button.send-button') || $q('button[aria-label*="Send" i]');
const stopBtn = () => $qa('button').find(b => /stop/i.test(b.getAttribute('aria-label') || '') && b.offsetParent !== null);
const responses = () => $qa('model-response');
const lastText = () => { const r = responses().pop(); if (!r) return ''; const m = $q('message-content', r) || r; return m.innerText || ''; };
`;

class GeminiWebSession {
    // match: which tab to drive (default: the Gemini tab, opened if missing); null = any page.
    constructor({ port, host = '127.0.0.1', log = () => {}, match = /gemini\.google\.com/ }) {
        this.port = port;
        this.host = host;
        this.log = log;
        this.match = match;
    }

    async connect() {
        const res = await fetch(`http://${this.host}:${this.port}/json/version`);
        const { webSocketDebuggerUrl } = await res.json();
        this.cdp = await new CdpClient(webSocketDebuggerUrl).open();
        const { targetInfos } = await this.cdp.send('Target.getTargets');
        let page = targetInfos.find(t => t.type === 'page' && (!this.match || this.match.test(t.url)));
        if (!page) {
            const { targetId } = await this.cdp.send('Target.createTarget', { url: GEMINI_URL });
            page = { targetId };
        }
        this.targetId = page.targetId;
        const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
        this.sid = sessionId;
        await this.cdp.send('Page.enable', {}, this.sid);
        await this.cdp.send('Runtime.enable', {}, this.sid);
        return this;
    }

    async eval(expr) {
        const out = await this.cdp.send('Runtime.evaluate', {
            expression: `(async () => { ${PAGE_HELPERS} ${expr} })()`,
            awaitPromise: true, returnByValue: true, userGesture: true
        }, this.sid);
        if (out.exceptionDetails) throw new Error(`Page script failed: ${out.exceptionDetails.exception?.description || out.exceptionDetails.text}`);
        return out.result.value;
    }

    async waitFor(expr, timeoutMs, what) {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            if (await this.eval(`return !!(${expr});`)) return true;
            await sleep(300);
        }
        throw new Error(`Gemini page: ${what} did not appear within ${Math.round(timeoutMs / 1000)} s`);
    }

    // Who is signed in (null when the page shows the sign-in screen).
    async account() {
        return this.eval(`
            const a = $q('a[aria-label*="Google Account" i]') || $q('[aria-label*="Google Account" i]');
            const label = a ? a.getAttribute('aria-label') : '';
            const m = label.match(/[\\w.+-]+@[\\w.-]+/);
            return { signedIn: !!editor() && !!a, email: m ? m[0] : null, label };
        `);
    }

    // Centre of the element `elExpr` (page code) once it has stopped moving (menus slide in,
    // the message box moves after a new chat), or null when it never shows.
    async stillBox(elExpr, timeoutMs = 10000) {
        let box = null;
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            await sleep(200);
            const b = await this.eval(`const el = ${elExpr}; if (!el || !el.offsetParent) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
            if (b && box && Math.abs(b.x - box.x) < 1 && Math.abs(b.y - box.y) < 1) return b;
            box = b;
        }
        return box;
    }

    // Real mouse click on `elExpr` until `doneExpr` (page code) is true.
    async clickUntil(elExpr, doneExpr, what, tries = 4) {
        for (let i = 0; i < tries; i++) {
            const box = await this.stillBox(elExpr);
            if (box) {
                await this.click(box.x, box.y);
                const until = Date.now() + 2500;
                while (Date.now() < until) {
                    if (await this.eval(`return !!(${doneExpr});`)) return true;
                    await sleep(200);
                }
            }
            this.log(`${what}: click ${i + 1} did not work; trying again`);
        }
        throw new Error(`Gemini page: could not open ${what}`);
    }

    // Pick a model in the mode menu by the start of its name ("Auto", "3.1 Pro", "4 Argon").
    async selectMode(name) {
        const picker = `$qa('button').find(b => /mode picker/i.test(b.getAttribute('aria-label') || '') && b.offsetParent)`;
        await this.waitFor(picker, 20000, 'the mode menu button');
        const label = () => this.eval(`const b = ${picker}; return b ? b.getAttribute('aria-label') : '';`);
        if ((await label()).toLowerCase().includes(name.toLowerCase())) return label();
        const item = `$qa('[role=menuitem], [role=menuitemradio], .mat-mdc-menu-item').filter(e => e.offsetParent).find(e => (e.innerText || '').trim().toLowerCase().startsWith(${JSON.stringify(name.toLowerCase())}))`;
        await this.clickUntil(picker, item, 'the mode menu');
        await this.clickUntil(item, `(${picker} || { getAttribute: () => '' }).getAttribute('aria-label').toLowerCase().includes(${JSON.stringify(name.toLowerCase())})`, `mode "${name}"`);
        return label();
    }

    async newChat() {
        await this.cdp.send('Page.navigate', { url: GEMINI_URL }, this.sid);
        await sleep(800);
        // The page first shows a static copy, then the live app replaces it: clicks on the copy
        // do nothing. The mode switcher and upload drawer exist only in the live app.
        await this.waitFor(`editor() && $q('bard-mode-switcher') && $q('toolbox-drawer')`, 45000, 'the message box');
        await sleep(500);
    }

    async click(x, y) {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            await this.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, this.sid);
        }
    }

    // Attach a local file the way a person does: "Upload and tools" -> "Files" -> pick the file.
    // Chrome's file picker is caught (it never shows on screen) and handed the path.
    async attachFile(filePath) {
        const name = path.basename(filePath);
        const uploadBtn = `$qa('button').find(b => /upload.*tools/i.test(b.getAttribute('aria-label') || '') && b.offsetParent)`;
        const filesBtn = `$q('images-files-uploader button')`;
        await this.cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, this.sid);
        try {
            let fc = null;
            for (let attempt = 0; attempt < 4 && !fc; attempt++) {
                if (!(await this.eval(`const b = ${uploadBtn}; return !!b && b.getAttribute('aria-expanded') === 'true';`))) {
                    await this.clickUntil(uploadBtn, `(${filesBtn} || {}).offsetParent`, 'the upload menu');
                }
                const box = await this.stillBox(filesBtn);
                if (!box) continue;
                const opened = this.cdp.waitEvent('Page.fileChooserOpened', null, 4000).catch(() => null);
                const t0 = Date.now();
                await this.click(box.x, box.y);
                fc = await opened;
                if (!fc) {
                    this.log(`Files click ${attempt + 1} at ${Math.round(box.x)},${Math.round(box.y)} (${Date.now() - t0} ms) did not open the picker; trying again`);
                    if (this.debugDir) {
                        const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png' }, this.sid);
                        fs.writeFileSync(path.join(this.debugDir, `files_miss_${attempt + 1}.png`), Buffer.from(shot.data, 'base64'));
                    }
                }
            }
            if (!fc) throw new Error('Gemini page: the Files button did not open the file picker');
            await this.cdp.send('DOM.setFileInputFiles', { files: [path.resolve(filePath)], backendNodeId: fc.backendNodeId }, this.sid);
        } finally {
            await this.cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }, this.sid).catch(() => {});
        }
        // The file's chip shows its name; the upload is done when the Send button can be used.
        await this.waitFor(`$qa('*').some(e => e.children.length < 3 && e.offsetParent && (e.textContent || '').includes(${JSON.stringify(name.replace(/\.[^.]+$/, ''))}))`, 20000, 'the attached file');
        await this.waitFor(`!$qa('[role=progressbar], mat-progress-spinner, mat-spinner').some(e => e.offsetParent)`, 180000, 'the finished upload');
    }

    async send(prompt) {
        await this.eval(`editor().focus(); return true;`);
        await this.cdp.send('Input.insertText', { text: prompt }, this.sid);
        await sleep(300);
        const n = await this.eval(`return responses().length;`);
        await this.waitFor(`sendBtn() && !sendBtn().disabled && sendBtn().getAttribute('aria-disabled') !== 'true'`, 120000, 'an enabled Send button');
        await this.eval(`sendBtn().click(); return true;`);
        return n;
    }

    // Wait for the reply after `before` answers: the Stop button is gone and the text stays the same.
    async readAnswer(before, timeoutMs = 10 * 60 * 1000) {
        const until = Date.now() + timeoutMs;
        await this.waitFor(`responses().length > ${before}`, 60000, 'an answer');
        let last = '';
        let stableSince = 0;
        while (Date.now() < until) {
            const s = await this.eval(`return { text: lastText(), busy: !!stopBtn() };`);
            if (s.text !== last) { last = s.text; stableSince = Date.now(); }
            else if (!s.busy && s.text && Date.now() - stableSince > 2500) return s.text;
            await sleep(500);
        }
        throw new Error('Gemini page: the answer did not finish in time');
    }

    async ask(prompt, { file = null, timeoutMs } = {}) {
        await this.newChat();
        if (file) await this.attachFile(file);
        const before = await this.send(prompt);
        return this.readAnswer(before, timeoutMs);
    }

    close() { if (this.cdp) this.cdp.close(); }
}

module.exports = { GeminiWebSession, CdpClient, GEMINI_URL };
