// Request authentication and path validation for the local backend.
//
// The backend runs on http://localhost:3001 and can read, write and launch
// files on the user's machine, so it must only ever answer the app's own
// window. Three layers enforce that:
//   1. server.js listens on 127.0.0.1 only (never on the LAN).
//   2. hostAndOriginGuard: the Host header must be localhost/127.0.0.1 on our
//      port (stops DNS rebinding) and any Origin / Sec-Fetch-Site must be our
//      own (stops cross-site form posts from web pages).
//   3. tokenAuth: every request must carry a random per-launch token. main.js
//      generates it and sets it as an HttpOnly, SameSite=Strict cookie in the
//      Electron session before loading the page, so <video>/<audio> requests,
//      workers and fetch() all send it automatically and nothing else has it.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_COOKIE = 'drd_token';
let apiToken = null;

// main.js calls this before requiring server.js. Standalone runs
// (`node backend/server.js`) get a random token and a login URL in the log.
function setApiToken(token) {
    if (typeof token !== 'string' || token.length < 32) throw new Error('API token too short');
    apiToken = token;
}

function getApiToken() {
    if (!apiToken) apiToken = crypto.randomBytes(32).toString('hex');
    return apiToken;
}

function tokensEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function readCookie(req, name) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return null;
}

function allowedHosts(port) {
    return new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
}

function hostAndOriginGuard(port) {
    const hosts = allowedHosts(port);
    const origins = new Set([...hosts].map(h => `http://${h}`));
    return (req, res, next) => {
        const host = String(req.headers.host || '').toLowerCase();
        if (!hosts.has(host)) return res.status(403).send('Forbidden host');
        const origin = req.headers.origin;
        if (origin !== undefined && !origins.has(String(origin).toLowerCase())) {
            return res.status(403).send('Forbidden origin');
        }
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') {
            return res.status(403).send('Forbidden cross-site request');
        }
        next();
    };
}

function tokenAuth() {
    return (req, res, next) => {
        const token = getApiToken();
        if (tokensEqual(readCookie(req, TOKEN_COOKIE), token) || tokensEqual(req.headers['x-drd-token'], token)) {
            return next();
        }
        // Standalone browser mode: the server log prints /?t=<token>; exchange it
        // for the cookie once, then redirect so the token leaves the address bar.
        if (req.method === 'GET' && req.path === '/' && tokensEqual(req.query.t, token)) {
            res.setHeader('Set-Cookie', `${TOKEN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`);
            return res.redirect(302, '/');
        }
        res.status(401).send('Unauthorized. Open DR Dubber Pro from the app (or the link printed in the server log).');
    };
}

// ── Content-Security-Policy ────────────────────────────────────────────────
// index.html still has static inline handlers (onclick="..."). Instead of
// 'unsafe-inline' (which would also allow injected <img onerror=...>), each
// static handler is allowed by its exact hash, computed from index.html at
// startup so the list never drifts from the markup.
function decodeHtmlAttr(value) {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function inlineHandlerHashes(html) {
    const hashes = new Set();
    const re = /\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const code = decodeHtmlAttr(m[1] !== undefined ? m[1] : m[2]);
        hashes.add(`'sha256-${crypto.createHash('sha256').update(code, 'utf8').digest('base64')}'`);
    }
    return [...hashes];
}

function buildCsp(indexHtmlPath) {
    let hashes = [];
    try { hashes = inlineHandlerHashes(fs.readFileSync(indexHtmlPath, 'utf8')); } catch (e) {}
    const scriptSrc = ["'self'"];
    if (hashes.length) scriptSrc.push("'unsafe-hashes'", ...hashes);
    return [
        "default-src 'self'",
        `script-src ${scriptSrc.join(' ')}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        // The page talks to the user's own VoxCPM2 server (any URL they set) and
        // the GitHub update feed, so connections stay open to http(s).
        "connect-src 'self' data: blob: http: https: ws: wss:",
        "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://drive.google.com",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; ');
}

function securityHeaders(indexHtmlPath) {
    const csp = buildCsp(indexHtmlPath);
    return (req, res, next) => {
        res.setHeader('Content-Security-Policy', csp);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        next();
    };
}

// ── Path validation ────────────────────────────────────────────────────────
// \\server\share and //server/share make Windows authenticate to that server
// (leaking the user's NTLM hash) and can run code from it, so network paths
// are never accepted from requests.
function isNetworkPath(p) {
    if (typeof p !== 'string') return false;
    const s = p.trim();
    if (/^[\\/]{2}/.test(s)) return true; // \\host\share, //host/share, \\?\ and \\.\ device paths
    if (/^file:/i.test(s)) {
        const rest = s.slice(5).replace(/^\/\/localhost(?=\/)/i, '//');
        if (rest.startsWith('///')) return /^\/\/\/[\\/]/.test(rest); // file:////host/share
        return rest.startsWith('//'); // file://host/share
    }
    return false;
}

const AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']);
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.ts', '.mts', '.m2ts', '.flv', '.wmv', '.m4v', '.3gp', '.mpg', '.mpeg']);
const SUBTITLE_EXTS = new Set(['.srt', '.vtt', '.ass', '.ssa', '.txt']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const FONT_EXTS = new Set(['.ttf', '.otf', '.woff', '.woff2']);
const SERVABLE_EXTS = new Set([...AUDIO_EXTS, ...VIDEO_EXTS, ...SUBTITLE_EXTS, ...IMAGE_EXTS, ...FONT_EXTS]);

function hasExt(p, set) {
    return typeof p === 'string' && set.has(path.extname(p).toLowerCase());
}

const isServableMedia = p => hasExt(p, SERVABLE_EXTS) && !isNetworkPath(p);
const isAudioFile = p => hasExt(p, AUDIO_EXTS) && !isNetworkPath(p);

// Output names come from the page; keep them a single file name with an
// expected extension so they can't climb out of the export folder.
function safeOutputFileName(name, allowedExts, fallback) {
    let base = path.basename(String(name || '')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
    if (!base || base === '.' || base === '..') base = fallback;
    const ext = path.extname(base).toLowerCase();
    if (!allowedExts.includes(ext)) base = `${base.slice(0, base.length - ext.length) || 'output'}${allowedExts[0]}`;
    return base;
}

module.exports = {
    TOKEN_COOKIE,
    setApiToken,
    getApiToken,
    tokensEqual,
    readCookie,
    hostAndOriginGuard,
    tokenAuth,
    inlineHandlerHashes,
    buildCsp,
    securityHeaders,
    isNetworkPath,
    isServableMedia,
    isAudioFile,
    safeOutputFileName,
    AUDIO_EXTS,
    VIDEO_EXTS
};
