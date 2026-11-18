// Why a request from the app's window to its own server failed. The page only ever sees
// "Failed to fetch"; Chromium knows the reason (net::ERR_NETWORK_CHANGED, ..._CONNECTION_REFUSED,
// ..._EMPTY_RESPONSE). 2026-11-18: 64 and then 43 voice lines failed in the same millisecond
// with the server fine, and nothing said why. main.js feeds session.webRequest.onErrorOccurred
// here; a burst is written as one line once it has been quiet for windowMs.
//
// Left out, as nothing failed: net::ERR_ABORTED (Stop, a closed preview, a replaced request) and
// net::ERR_CACHE_MISS (a cache-only lookup, e.g. the fonts index.html and style.css both declare,
// three of them at every start; the fonts load).
const NOT_FAILURES = new Set(['net::ERR_ABORTED', 'net::ERR_CACHE_MISS']);

function createRequestErrorLog({ log = console.warn, windowMs = 2000, setTimer = setTimeout } = {}) {
    let burst = null; // { errors: Map(code -> count), routes: Map(route -> count), total, timer }

    function flush() {
        if (!burst) return;
        const b = burst;
        burst = null;
        const list = (m) => [...m.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).join(', ');
        log(`[Network] ${b.total} request(s) from the window to the app's server failed: ${list(b.errors)} (${list(b.routes)})`);
    }

    function onError(details) {
        const error = String((details && details.error) || 'unknown error');
        if (NOT_FAILURES.has(error)) return;
        let route = '?';
        try {
            route = `${details.method || 'GET'} ${new URL(details.url).pathname}`;
        } catch (e) { }
        if (!burst) burst = { errors: new Map(), routes: new Map(), total: 0, timer: null };
        burst.total++;
        burst.errors.set(error, (burst.errors.get(error) || 0) + 1);
        burst.routes.set(route, (burst.routes.get(route) || 0) + 1);
        if (burst.timer) clearTimeout(burst.timer);
        burst.timer = setTimer(flush, windowMs);
    }

    return { onError, flush };
}

module.exports = { createRequestErrorLog };
