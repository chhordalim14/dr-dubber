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

function secureFetch(url, options) {
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
