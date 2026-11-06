// Outgoing HTTP(S) for the backend (Gemini, VoxCPM2 servers/tunnels).
//
// server.js used to start with `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'`,
// which switched off certificate checking for every request the process made -
// including Gemini calls that carry the user's API key. That was most likely a
// workaround for an office network whose proxy re-signs HTTPS traffic with its
// own root certificate, which Node's bundled CA list doesn't know about.
//
// The proper fix for that situation is to trust the operating system's
// certificate store, which is where IT installs the proxy's root certificate.
// When the backend runs inside Electron (the normal case - main.js requires
// server.js after app.whenReady), Electron's net.fetch goes through Chromium's
// network stack, which uses the OS certificate store and the system proxy
// settings, exactly like the user's browser. So we use that when available and
// keep full certificate validation on.
//
// When the backend runs standalone (`npm run server`), plain Node fetch is used.
// Behind a re-signing proxy, point NODE_EXTRA_CA_CERTS at the proxy's root
// certificate (PEM) instead of disabling validation.
//
// Last-resort escape hatch (e.g. a self-hosted VoxCPM2 server with a
// self-signed certificate): set DR_DUBBER_ALLOW_INSECURE_TLS=1. This restores
// the old behaviour and logs a warning; it is never on by default.

const ALLOW_INSECURE_TLS = process.env.DR_DUBBER_ALLOW_INSECURE_TLS === '1';

if (ALLOW_INSECURE_TLS) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.warn('[secure-fetch] DR_DUBBER_ALLOW_INSECURE_TLS=1: TLS certificate validation is DISABLED for all outgoing requests.');
}

// require('electron') returns the API object inside Electron's main process, but
// just a path string under plain Node or ELECTRON_RUN_AS_NODE.
let electronNet = null;
try {
    const electron = require('electron');
    if (electron && typeof electron === 'object' && electron.net && typeof electron.net.fetch === 'function') {
        electronNet = electron.net;
    }
} catch (e) { /* not running inside Electron */ }

// DR Router's per-account proxies (options.proxy). undici is a dependency of its own: the
// copy inside electron/electron-builder is dev-only and not in the installed app. Its own
// fetch is used with its ProxyAgent - a ProxyAgent from one undici given to another's fetch
// (Node's built-in one) breaks when their versions drift apart.
let undici = null;
try {
    undici = require('undici');
} catch (e) {}

// One agent per proxy address, so its connections are reused instead of a new pool per request.
const proxyAgents = new Map();
function proxyAgentFor(proxyUrl) {
    let agent = proxyAgents.get(proxyUrl);
    if (!agent) {
        agent = new undici.ProxyAgent(proxyUrl);
        proxyAgents.set(proxyUrl, agent);
    }
    return agent;
}

function secureFetch(url, options = {}) {
    if (options && options.proxy) {
        // A request meant for a proxy never goes out direct: that would hide a dead proxy
        // (its test said "online") and send the account's traffic from the user's own address.
        const { proxy, ...rest } = options;
        if (!undici) return Promise.reject(new Error('Proxy support is missing (undici not installed) - request not sent.'));
        let dispatcher;
        try {
            dispatcher = proxyAgentFor(proxy);
        } catch (err) {
            return Promise.reject(new Error(`Proxy ${String(proxy).replace(/\/\/[^@/]*@/, '//')} can't be used: ${err.message}`));
        }
        return undici.fetch(url, { ...rest, dispatcher });
    }
    if (electronNet && !ALLOW_INSECURE_TLS) {
        return electronNet.fetch(url, options);
    }
    return fetch(url, options);
}

function fetchBackend() {
    if (electronNet && !ALLOW_INSECURE_TLS) return 'electron-net';
    return ALLOW_INSECURE_TLS ? 'node-fetch (INSECURE TLS)' : 'node-fetch';
}

module.exports = { secureFetch, fetchBackend };
