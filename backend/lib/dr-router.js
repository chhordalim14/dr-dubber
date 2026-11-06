// DR Router PRO - Multi-Account Pool Manager & Proxy Engine
// Supports Round-robin, Least-used, and Random strategies across multiple Gmail accounts.
// Provides local proxy listening on 127.0.0.1:8765 and integration with DR Dubber Pro.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { STORAGE_BASE } = require('./paths');
const { secureFetch } = require('./secure-fetch');

const DEFAULT_CONFIG_PATH = path.join(STORAGE_BASE, 'dr_router_accounts.json');
const LEGACY_CONFIG_PATH = path.join(STORAGE_BASE, 'dapool_accounts.json');
const DEFAULT_PORT = 8765;
// A key Google refuses for a reason that can pass (403: API not enabled, region, VPN) rests
// this long instead of being retired - same as INVALID_KEY_REST_MS in routes/gemini.js.
const KEY_REJECTED_REST_MS = 10 * 60 * 1000;
// "Daily quota used up" is rechecked after 15 min, then 1 h, before it is trusted until the
// reset (Google says it to keys far below the limit - see dailyCooldownUntil in gemini.js).
const DAILY_RECHECK_MS = [15 * 60 * 1000, 60 * 60 * 1000];
// A Google API key, not part of a longer token: the old form "AIza" + 35 characters, or the
// newer one "AQ." + a long code (keys bound to a service account; Settings accepts both).
const GEMINI_KEY_RE = /(?<![0-9A-Za-z_.-])(?:AIza[0-9A-Za-z_-]{35}|AQ[.][0-9A-Za-z_.-]{20,100})(?![0-9A-Za-z_.-])/;

class DRRouterManager {
    constructor(options = {}) {
        this.configPath = options.configPath || DEFAULT_CONFIG_PATH;
        this.port = options.port || DEFAULT_PORT;
        // Where the local proxy sends requests (a test points it at a fake Google).
        this.upstreamBase = options.upstreamBase || 'https://generativelanguage.googleapis.com';
        this.strategy = 'round-robin'; // 'round-robin' | 'least-used' | 'random'
        // Linked: DR Dubber's own transcribe / translate jobs draw keys from the pool.
        // Unlinked: they use only the keys in Settings; the proxy still serves outside tools.
        this.linked = true;
        // Fast mode: transcription sends every chunk at once, one per key (see gemini.js).
        this.fastMode = false;
        this.accounts = []; // Array<{ id, email, apiKey, status, served, inFlight, lastUsed, lastError, cooldownUntil, enabled, proxyId }>
        this.proxies = []; // Array<{ id, url, protocol, host, port, username, password, status, latencyMs, lastChecked, accountId, enabled }>
        this.proxyMode = 'dedicated'; // 'dedicated' (1:1 with account) | 'rotating' (pool rotation)
        this.proxyRotatingIndex = 0;
        this.proxyServer = null;
        this.proxyActive = false;
        this.proxyEnabled = true; // the user's on/off switch for the local proxy, kept across restarts
        this.proxyError = null;   // why it isn't listening (e.g. the port is taken)
        this.dailyStrikes = new Map(); // account id -> { count, at }: "daily quota" answers in a row
        this.roundRobinIndex = 0;
        this.clientLastSeen = null;
        this.lastRequestAt = null; // last time the dubber (or a proxy client) used a pool key
        // Live activity feed for the dashboard: every request start / answer / cooldown,
        // numbered so the UI can ask "what happened since #N" and animate each one.
        this.events = [];
        this.eventSeq = 0;
        this.saveTimer = null;

        this.load();
    }

    load() {
        try {
            // Auto-migrate from legacy config if needed
            let fileToRead = this.configPath;
            if (!fs.existsSync(fileToRead) && fs.existsSync(LEGACY_CONFIG_PATH)) {
                fileToRead = LEGACY_CONFIG_PATH;
            }

            if (fs.existsSync(fileToRead)) {
                const data = JSON.parse(fs.readFileSync(fileToRead, 'utf8'));
                if (data && Array.isArray(data.accounts)) {
                    this.accounts = data.accounts.map(acc => ({
                        id: acc.id || `acc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                        email: acc.email || 'account@gmail.com',
                        apiKey: acc.apiKey || '',
                        status: acc.status || 'ready',
                        served: parseInt(acc.served, 10) || 0,
                        inFlight: 0,
                        lastUsed: acc.lastUsed || null,
                        lastError: acc.lastError || null,
                        cooldownUntil: acc.cooldownUntil || 0,
                        enabled: acc.enabled !== false,
                        proxyId: acc.proxyId || null
                    }));
                }
                if (data && Array.isArray(data.proxies)) {
                    this.proxies = data.proxies.map(p => ({
                        id: p.id || `proxy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                        url: p.url || '',
                        protocol: p.protocol || 'http',
                        host: p.host || '',
                        port: parseInt(p.port, 10) || 8080,
                        username: p.username || '',
                        password: p.password || '',
                        status: p.status || 'untested',
                        latencyMs: p.latencyMs || null,
                        lastChecked: p.lastChecked || null,
                        accountId: p.accountId || null,
                        enabled: p.enabled !== false
                    }));
                }
                if (data && data.proxyMode) this.proxyMode = data.proxyMode;
                if (data && data.strategy) this.strategy = data.strategy;
                if (data && data.port) this.port = data.port;
                if (data && data.linked === false) this.linked = false;
                if (data && data.fastMode === true) this.fastMode = true;
                if (data && data.proxyEnabled === false) this.proxyEnabled = false;
            }
        } catch (e) {
            console.warn('[DR Router] Error loading config:', e.message);
            // Keep the unreadable file: the next save would otherwise replace every key with an empty pool.
            try {
                if (fs.existsSync(this.configPath)) {
                    const kept = `${this.configPath}.broken-${Date.now()}`;
                    fs.copyFileSync(this.configPath, kept);
                    console.warn(`[DR Router] Unreadable pool file kept as ${kept}`);
                }
            } catch (e2) {}
        }
    }

    save() {
        try {
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const data = {
                strategy: this.strategy,
                linked: this.linked,
                fastMode: this.fastMode,
                proxyEnabled: this.proxyEnabled,
                port: this.port,
                proxyMode: this.proxyMode,
                updatedAt: new Date().toISOString(),
                proxies: this.proxies.map(p => ({
                    id: p.id,
                    url: p.url,
                    protocol: p.protocol,
                    host: p.host,
                    port: p.port,
                    username: p.username,
                    password: p.password,
                    status: p.status,
                    latencyMs: p.latencyMs,
                    lastChecked: p.lastChecked,
                    accountId: p.accountId,
                    enabled: p.enabled
                })),
                accounts: this.accounts.map(a => ({
                    id: a.id,
                    email: a.email,
                    apiKey: a.apiKey,
                    status: a.status,
                    served: a.served,
                    lastUsed: a.lastUsed,
                    lastError: a.lastError,
                    cooldownUntil: a.cooldownUntil,
                    enabled: a.enabled,
                    proxyId: a.proxyId || null
                }))
            };
            // Written beside it and renamed over it: a crash mid-write leaves the last good file.
            const tmp = `${this.configPath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tmp, this.configPath);
        } catch (e) {
            console.warn('[DR Router] Error saving config:', e.message);
        }
    }

    // Coalesce the many per-request writes (served counters) into one write a second.
    scheduleSave() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.save();
        }, 1000);
        if (this.saveTimer.unref) this.saveTimer.unref();
    }

    pushEvent(id, type) {
        this.eventSeq += 1;
        this.events.push({ seq: this.eventSeq, t: Date.now(), id, type });
        if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    }

    getEvents(since = 0) {
        const n = Number(since) || 0;
        return { seq: this.eventSeq, events: this.events.filter(e => e.seq > n) };
    }

    getMaskedAccounts() {
        const now = Date.now();
        return this.accounts.map(a => {
            const isCooling = a.cooldownUntil > now;
            let status = a.status;
            if (isCooling) status = 'cooling';
            else if (status === 'cooling') status = 'ready';

            const emailParts = (a.email || '').split('@');
            let maskedEmail = a.email;
            if (emailParts.length === 2) {
                const name = emailParts[0];
                const prefix = name.slice(0, 3);
                maskedEmail = `${prefix}***@***`;
            }

            const rawKey = a.apiKey || '';
            const maskedKey = rawKey.length > 8
                ? `${rawKey.slice(0, 6)}...${rawKey.slice(-4)}`
                : '••••••••';

            const boundProxy = this.proxies.find(p => p.id === a.proxyId || p.accountId === a.id);

            return {
                id: a.id,
                email: a.email,
                maskedEmail,
                maskedKey,
                hasKey: !!rawKey,
                status,
                served: a.served,
                inFlight: a.inFlight || 0,
                lastUsed: a.lastUsed,
                lastError: a.lastError,
                cooldownRemainingMs: Math.max(0, (a.cooldownUntil || 0) - now),
                enabled: a.enabled !== false,
                proxyId: a.proxyId || (boundProxy ? boundProxy.id : null),
                proxyHost: boundProxy ? `${boundProxy.protocol}://${boundProxy.host}:${boundProxy.port}` : null,
                proxyStatus: boundProxy ? boundProxy.status : null
            };
        });
    }

    addAccount({ email, apiKey }, { save = true } = {}) {
        if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
            throw new Error('API key is required.');
        }
        const cleanKey = apiKey.trim();
        const givenEmail = (email && typeof email === 'string' && email.trim()) || '';
        const cleanEmail = givenEmail || `account_${this.accounts.length + 1}@gmail.com`;

        // Check if duplicate key already exists
        const existing = this.accounts.find(a => a.apiKey === cleanKey);
        if (existing) {
            // Pasted again without an email: keep its name rather than renaming it account_N.
            if (givenEmail) existing.email = givenEmail;
            existing.status = 'ready';
            existing.enabled = true;
            if (save) this.save();
            return existing;
        }

        const newAccount = {
            id: `acc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            email: cleanEmail,
            apiKey: cleanKey,
            status: 'ready',
            served: 0,
            inFlight: 0,
            lastUsed: null,
            lastError: null,
            cooldownUntil: 0,
            enabled: true
        };

        this.accounts.push(newAccount);
        if (save) this.save();
        return newAccount;
    }

    // Bulk Paste: one account per line. The key is found anywhere in the line (alone, or with an
    // email before it - comma, colon, space or tab); a line without a whole Gemini key (a header
    // row, a key cut short) is skipped and reported back, so nothing junk joins the pool.
    bulkAddFromText(rawText) {
        const result = { added: 0, alreadyInPool: 0, repeated: 0, skipped: [] };
        const seen = new Set();
        String(rawText || '').split(/\r?\n/).forEach((raw, idx) => {
            const line = raw.trim();
            if (!line) return;
            const keyMatch = line.match(GEMINI_KEY_RE);
            if (!keyMatch) {
                result.skipped.push({ line: idx + 1, text: line.length > 60 ? `${line.slice(0, 57)}...` : line });
                return;
            }
            const apiKey = keyMatch[0];
            if (seen.has(apiKey)) {
                result.repeated++;
                return;
            }
            seen.add(apiKey);
            const emailMatch = line.replace(apiKey, ' ').match(/[^\s,;:<>"']+@[^\s,;:<>"']+\.[A-Za-z]{2,}/);
            if (this.findByKey(apiKey)) result.alreadyInPool++;
            else result.added++;
            this.addAccount({ email: emailMatch ? emailMatch[0] : '', apiKey }, { save: false });
        });
        if (seen.size) this.save();
        return result;
    }

    addAccounts(list = []) {
        const added = [];
        for (const item of list) {
            try {
                if (item && item.apiKey) {
                    added.push(this.addAccount(item));
                }
            } catch (e) {}
        }
        return added;
    }

    deleteAccount(id) {
        const idx = this.accounts.findIndex(a => a.id === id);
        if (idx !== -1) {
            this.accounts.splice(idx, 1);
            this.save();
            return true;
        }
        return false;
    }

    // "Remove invalid": the accounts whose key Google refused for good. Returns how many went.
    deleteInvalidAccounts() {
        const before = this.accounts.length;
        this.accounts = this.accounts.filter(a => a.status !== 'invalid');
        const deleted = before - this.accounts.length;
        if (deleted) {
            for (const p of this.proxies) if (p.accountId && !this.accounts.some(a => a.id === p.accountId)) p.accountId = null;
            this.save();
        }
        return deleted;
    }

    toggleAccount(id, enabled) {
        const acc = this.accounts.find(a => a.id === id);
        if (acc) {
            acc.enabled = enabled !== false;
            this.save();
            return true;
        }
        return false;
    }

    setLinked(linked) {
        this.linked = linked !== false;
        this.save();
        return this.linked;
    }

    setFastMode(on) {
        this.fastMode = on === true;
        this.save();
        return this.fastMode;
    }

    // Ready pool keys for the app's batch (Dub Whole Series / Batch Transcribe), which gives each
    // key a tab of its own. Polled every few seconds, so unlike orderedReadyKeys() it doesn't
    // move the round-robin start: the list stays stable while a batch hands out keys.
    batchKeys() {
        if (!this.linked) return [];
        const ready = this.getReadyAccounts();
        let list = ready;
        if (this.strategy === 'least-used') {
            list = [...ready].sort((a, b) => (a.served || 0) - (b.served || 0));
        } else if (this.strategy === 'random') {
            list = [...ready];
            for (let i = list.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [list[i], list[j]] = [list[j], list[i]];
            }
        }
        return list.map(a => a.apiKey);
    }

    // Keys for DR Dubber's own jobs: none while the app is unlinked from the pool.
    keysForDubber() {
        return this.linked ? this.orderedReadyKeys() : [];
    }

    setStrategy(strategy) {
        if (['round-robin', 'least-used', 'random'].includes(strategy)) {
            this.strategy = strategy;
            this.save();
            return true;
        }
        return false;
    }

    getReadyAccounts() {
        const now = Date.now();
        return this.accounts.filter(a =>
            a.enabled !== false &&
            a.status !== 'invalid' &&
            !(a.cooldownUntil && a.cooldownUntil > now) &&
            !!a.apiKey
        );
    }

    // exclude: account ids already tried for this request. readyOnly: no resting account as a
    // last resort (the local proxy answers "all resting" instead of spending one more 429).
    pickAccount({ exclude = null, readyOnly = false } = {}) {
        const ready = this.getReadyAccounts().filter(a => !exclude || !exclude.has(a.id));
        if (!ready.length) {
            if (readyOnly) return null;
            // Check if there are cooling accounts and pick the one cooling earliest
            const cooling = this.accounts.filter(a => a.enabled !== false && a.status !== 'invalid' && !!a.apiKey);
            if (cooling.length) {
                cooling.sort((a, b) => (a.cooldownUntil || 0) - (b.cooldownUntil || 0));
                return cooling[0];
            }
            return null;
        }

        if (this.strategy === 'least-used') {
            ready.sort((a, b) => (a.served || 0) - (b.served || 0) || (a.inFlight || 0) - (b.inFlight || 0));
            return ready[0];
        }

        if (this.strategy === 'random') {
            const idx = Math.floor(Math.random() * ready.length);
            return ready[idx];
        }

        // Default: round-robin
        const selected = ready[this.roundRobinIndex % ready.length];
        this.roundRobinIndex = (this.roundRobinIndex + 1) % ready.length;
        return selected;
    }

    getNextAccount() {
        return this.pickAccount();
    }

    // The ready keys in the order the chosen strategy wants them tried. The dubbing pipeline
    // takes its key list from here, so Round robin / Least used / Random apply to it too.
    orderedReadyKeys() {
        const ready = this.getReadyAccounts();
        if (!ready.length) return [];
        let ordered;
        if (this.strategy === 'least-used') {
            ordered = [...ready].sort((a, b) => (a.inFlight || 0) - (b.inFlight || 0) || (a.served || 0) - (b.served || 0));
        } else if (this.strategy === 'random') {
            ordered = [...ready];
            for (let i = ordered.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
            }
        } else {
            const start = this.roundRobinIndex % ready.length;
            this.roundRobinIndex = (start + 1) % ready.length;
            ordered = [...ready.slice(start), ...ready.slice(0, start)];
        }
        return ordered.map(a => a.apiKey);
    }

    findByKey(apiKey) {
        return apiKey ? this.accounts.find(a => a.apiKey === apiKey) : null;
    }

    trackInFlight(id, delta) {
        const acc = this.accounts.find(a => a.id === id);
        if (acc) {
            acc.inFlight = Math.max(0, (acc.inFlight || 0) + delta);
            if (delta > 0) {
                this.lastRequestAt = Date.now();
                this.pushEvent(id, 'start');
            }
        }
    }

    markSuccess(id) {
        const acc = this.accounts.find(a => a.id === id);
        if (acc) {
            acc.served = (acc.served || 0) + 1;
            acc.lastUsed = new Date().toISOString();
            acc.status = 'ready';
            acc.lastError = null;
            this.pushEvent(id, 'ok');
            this.scheduleSave();
        }
    }

    markRateLimited(id, retryAfterMs = 60000, message = 'Rate limited (429)') {
        const acc = this.accounts.find(a => a.id === id);
        if (acc) {
            acc.status = 'cooling';
            acc.cooldownUntil = Date.now() + Math.max(5000, retryAfterMs);
            acc.lastError = message;
            this.pushEvent(id, 'cool');
            this.scheduleSave();
        }
    }

    // Rest an account after Google's 429, for as long as the answer asks: its retry time, or
    // the daily-quota rule (DAILY_RECHECK_MS, then until the reset). Returns the rest in ms.
    restFromQuota(id, bodyText, now = Date.now()) {
        const { daily, retryMs } = readQuotaError(bodyText);
        let restMs;
        if (daily && retryMs != null && retryMs > 10 * 60 * 1000) {
            restMs = retryMs + 60 * 1000;
        } else if (daily) {
            const prev = this.dailyStrikes.get(id);
            const count = prev && now - prev.at < 6 * 60 * 60 * 1000 ? prev.count + 1 : 1;
            this.dailyStrikes.set(id, { count, at: now });
            const untilReset = msUntilPacificMidnight(now) + 60 * 1000;
            restMs = count <= DAILY_RECHECK_MS.length ? Math.min(untilReset, DAILY_RECHECK_MS[count - 1]) : untilReset;
        } else {
            restMs = Math.min(2 * 60 * 1000, Math.max(5000, retryMs != null ? retryMs : 60000)) + 500;
        }
        this.markRateLimited(id, restMs, daily ? 'Daily quota used up (429)' : 'Rate limited (429)');
        return restMs;
    }

    // Google refused the key for a reason that can pass (403): it rests, it isn't retired.
    markRejected(id, message = 'Key refused', restMs = KEY_REJECTED_REST_MS) {
        const acc = this.accounts.find(a => a.id === id);
        if (acc) {
            acc.status = 'cooling';
            acc.cooldownUntil = Date.now() + restMs;
            acc.lastError = message;
            this.pushEvent(id, 'cool');
            this.scheduleSave();
        }
    }

    markInvalid(id, message = 'Invalid API key') {
        const acc = this.accounts.find(a => a.id === id);
        if (acc) {
            acc.status = 'invalid';
            acc.lastError = message;
            this.pushEvent(id, 'invalid');
            this.scheduleSave();
        }
    }

    touchClient() {
        this.clientLastSeen = Date.now();
    }

    getStats() {
        const now = Date.now();
        const accounts = this.accounts;
        const total = accounts.length;
        let ready = 0;
        let cooling = 0;
        let invalid = 0;
        let inFlight = 0;
        let served = 0;

        for (const a of accounts) {
            if (a.enabled === false) continue;
            served += (a.served || 0);
            inFlight += (a.inFlight || 0);
            if (a.status === 'invalid') invalid++;
            else if (a.cooldownUntil && a.cooldownUntil > now) cooling++;
            else ready++;
        }

        const proxiesTotal = this.proxies.length;
        const proxiesOnline = this.proxies.filter(p => p.status === 'online').length;

        return {
            total,
            ready,
            cooling,
            invalid,
            inFlight,
            served,
            strategy: this.strategy,
            port: this.port,
            proxyActive: this.proxyActive,
            proxyEnabled: this.proxyEnabled,
            proxyError: this.proxyError,
            linked: this.linked,
            fastMode: this.fastMode,
            proxiesTotal,
            proxiesOnline,
            proxyMode: this.proxyMode,
            clientLastSeen: this.clientLastSeen,
            lastRequestAt: this.lastRequestAt
        };
    }

    // Check a key by asking Google for its model list: free (no quota used) and it answers
    // any key, where a generate call to one fixed model 404s for keys that never used it.
    async testAccount(id) {
        const acc = this.accounts.find(a => a.id === id);
        if (!acc || !acc.apiKey) throw new Error('Account or API key not found');

        try {
            const proxyUrl = this.getProxyForAccount(acc.id);
            const fetchOpts = {
                method: 'GET',
                // Key in a header, not the URL: URLs end up in proxy logs and error messages.
                headers: { 'x-goog-api-key': acc.apiKey }
            };
            if (proxyUrl) fetchOpts.proxy = proxyUrl;

            const res = await secureFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', fetchOpts);

            if (res.ok) {
                acc.status = 'ready';
                acc.lastError = null;
                acc.cooldownUntil = 0;
                this.dailyStrikes.delete(acc.id);
                this.save();
                return { success: true, status: 'ready', message: 'Account is ready & working.' };
            }

            const body = await res.text();
            let parsed = {};
            try { parsed = JSON.parse(body); } catch (e) {}

            const errMsg = (parsed.error && parsed.error.message) || `HTTP ${res.status}`;
            if (res.status === 429) {
                this.restFromQuota(acc.id, body);
                return { success: false, status: 'cooling', message: errMsg };
            }

            if (isDeadKeyRejection(res.status, body)) {
                acc.status = 'invalid';
                acc.lastError = errMsg;
                this.save();
                return { success: false, status: 'invalid', message: errMsg };
            }

            if (isKeyRejection(res.status, body)) {
                this.markRejected(acc.id, errMsg);
                return { success: false, status: 'cooling', message: errMsg };
            }

            return { success: false, status: acc.status, message: errMsg };
        } catch (err) {
            return { success: false, status: acc.status, message: err.message };
        }
    }

    // Proxy Management Methods
    getMaskedProxies() {
        return this.proxies.map(p => {
            const boundAccount = this.accounts.find(a => a.proxyId === p.id || a.id === p.accountId);
            return {
                id: p.id,
                url: maskProxyUrl(p.url),
                protocol: p.protocol,
                host: p.host,
                port: p.port,
                username: p.username || '',
                hasAuth: !!(p.username || p.password),
                status: p.status,
                latencyMs: p.latencyMs,
                lastChecked: p.lastChecked,
                accountId: boundAccount ? boundAccount.id : null,
                accountEmail: boundAccount ? boundAccount.email : null,
                enabled: p.enabled !== false
            };
        });
    }

    addProxy(proxyInput) {
        let parsed = null;
        if (typeof proxyInput === 'string') {
            parsed = parseProxyString(proxyInput);
        } else if (proxyInput && typeof proxyInput === 'object') {
            if (proxyInput.url) {
                parsed = parseProxyString(proxyInput.url);
            } else if (proxyInput.host) {
                const proto = (proxyInput.protocol || 'http').toLowerCase();
                const host = String(proxyInput.host).trim();
                const port = parseInt(proxyInput.port, 10) || 8080;
                const username = proxyInput.username ? String(proxyInput.username).trim() : '';
                const password = proxyInput.password ? String(proxyInput.password).trim() : '';
                const authPart = (username || password) ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
                parsed = {
                    protocol: proto,
                    host,
                    port,
                    username,
                    password,
                    url: `${proto}://${authPart}${host}:${port}`
                };
            }
        }

        if (!parsed || !parsed.host) {
            throw new Error('Invalid proxy format. Expected host:port, ip:port:user:pass, or protocol://user:pass@host:port');
        }

        // Check duplicate
        const existing = this.proxies.find(p => p.host === parsed.host && p.port === parsed.port && p.protocol === parsed.protocol);
        if (existing) {
            if (parsed.username) existing.username = parsed.username;
            if (parsed.password) existing.password = parsed.password;
            existing.url = parsed.url;
            existing.enabled = true;
            this.save();
            return existing;
        }

        const newProxy = {
            id: `proxy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            url: parsed.url,
            protocol: parsed.protocol,
            host: parsed.host,
            port: parsed.port,
            username: parsed.username,
            password: parsed.password,
            status: 'untested',
            latencyMs: null,
            lastChecked: null,
            accountId: null,
            enabled: true
        };

        this.proxies.push(newProxy);
        this.save();
        return newProxy;
    }

    bulkAddProxies(rawText) {
        if (!rawText) return { added: [], count: 0 };
        const lines = (Array.isArray(rawText) ? rawText : String(rawText).split('\n'))
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));

        const added = [];
        for (const line of lines) {
            try {
                const p = this.addProxy(line);
                if (p) added.push(p);
            } catch (e) {}
        }
        return { added, count: added.length };
    }

    deleteProxy(id) {
        const idx = this.proxies.findIndex(p => p.id === id);
        if (idx !== -1) {
            this.proxies.splice(idx, 1);
            for (const a of this.accounts) {
                if (a.proxyId === id) a.proxyId = null;
            }
            this.save();
            return true;
        }
        return false;
    }

    toggleProxy(id, enabled) {
        const p = this.proxies.find(x => x.id === id);
        if (p) {
            p.enabled = enabled !== false;
            this.save();
            return true;
        }
        return false;
    }

    setProxyMode(mode) {
        if (mode === 'dedicated' || mode === 'rotating') {
            this.proxyMode = mode;
            this.save();
            return true;
        }
        return false;
    }

    bindProxyToAccount(accountId, proxyId) {
        const acc = this.accounts.find(a => a.id === accountId);
        if (!acc) return false;

        // If proxyId is null or empty, unbind
        if (!proxyId) {
            const oldProxy = this.proxies.find(p => p.accountId === accountId || p.id === acc.proxyId);
            if (oldProxy) oldProxy.accountId = null;
            acc.proxyId = null;
            this.save();
            return true;
        }

        const proxy = this.proxies.find(p => p.id === proxyId);
        if (!proxy) return false;

        // Unbind any other account currently bound to this proxy in dedicated mode
        for (const a of this.accounts) {
            if (a.proxyId === proxyId && a.id !== accountId) {
                a.proxyId = null;
            }
        }

        // Unbind any old proxy this account had
        for (const p of this.proxies) {
            if (p.accountId === accountId && p.id !== proxyId) {
                p.accountId = null;
            }
        }

        acc.proxyId = proxyId;
        proxy.accountId = accountId;
        this.save();
        return true;
    }

    autoAssignProxies() {
        const availableProxies = this.proxies.filter(p => p.enabled !== false);
        for (const a of this.accounts) a.proxyId = null;
        for (const p of this.proxies) p.accountId = null;

        let assignedCount = 0;
        const pairs = [];
        for (let i = 0; i < this.accounts.length; i++) {
            const acc = this.accounts[i];
            if (i < availableProxies.length) {
                const proxy = availableProxies[i];
                acc.proxyId = proxy.id;
                proxy.accountId = acc.id;
                assignedCount++;
                pairs.push({ accountId: acc.id, proxyId: proxy.id });
            }
        }
        this.save();
        return { assignedCount, pairs };
    }

    getProxyForAccount(accountId) {
        if (this.proxyMode === 'rotating') {
            const available = this.proxies.filter(p => p.enabled !== false && p.status !== 'offline');
            const pool = available.length ? available : this.proxies.filter(p => p.enabled !== false);
            if (!pool.length) return null;
            const selected = pool[this.proxyRotatingIndex % pool.length];
            this.proxyRotatingIndex++;
            return selected.url;
        }

        // Dedicated 1:1 mode
        if (!accountId) return null;
        const acc = this.accounts.find(a => a.id === accountId);
        if (!acc || !acc.proxyId) return null;
        const proxy = this.proxies.find(p => p.id === acc.proxyId);
        if (!proxy || proxy.enabled === false) return null;
        return proxy.url;
    }

    getProxyForApiKey(apiKey) {
        if (!apiKey) return null;
        const acc = this.findByKey(apiKey);
        if (acc) {
            return this.getProxyForAccount(acc.id);
        }
        if (this.proxyMode === 'rotating') {
            return this.getProxyForAccount(null);
        }
        return null;
    }

    async testProxy(id) {
        const p = this.proxies.find(x => x.id === id);
        if (!p) throw new Error('Proxy not found');

        p.status = 'checking';
        const start = Date.now();
        try {
            const testUrl = 'https://www.google.com/generate_204';
            const res = await secureFetch(testUrl, {
                method: 'GET',
                proxy: p.url
            });
            const duration = Date.now() - start;
            if (res.status >= 200 && res.status < 400) {
                p.status = 'online';
                p.latencyMs = duration;
                p.lastChecked = new Date().toISOString();
                this.save();
                return { success: true, status: 'online', latencyMs: duration };
            } else {
                p.status = 'offline';
                p.latencyMs = null;
                p.lastChecked = new Date().toISOString();
                this.save();
                return { success: false, status: 'offline', error: `HTTP ${res.status}` };
            }
        } catch (err) {
            p.status = 'offline';
            p.latencyMs = null;
            p.lastChecked = new Date().toISOString();
            this.save();
            return { success: false, status: 'offline', error: err.message };
        }
    }

    async testAllProxies() {
        const results = [];
        const BATCH = 4;
        for (let i = 0; i < this.proxies.length; i += BATCH) {
            const slice = this.proxies.slice(i, i + BATCH);
            const batchResults = await Promise.all(slice.map(p => this.testProxy(p.id)));
            batchResults.forEach((r, idx) => {
                results.push({ id: slice[idx].id, host: slice[idx].host, ...r });
            });
        }
        return results;
    }

    async verifyAll() {
        const results = [];
        const BATCH = 4;
        for (let i = 0; i < this.accounts.length; i += BATCH) {
            const slice = this.accounts.slice(i, i + BATCH);
            const batchResults = await Promise.all(slice.map(a => this.testAccount(a.id)));
            batchResults.forEach((r, idx) => {
                results.push({ id: slice[idx].id, email: slice[idx].email, ...r });
            });
        }
        return results;
    }

    // The user's on/off switch for the local proxy: kept, so a restart honours it.
    setProxyEnabled(on) {
        this.proxyEnabled = on !== false;
        this.save();
        if (this.proxyEnabled) this.startProxy();
        else this.stopProxy();
        return this.proxyEnabled;
    }

    // Launch local proxy server on 127.0.0.1:8765
    startProxy() {
        if (this.proxyServer) return;
        this.proxyError = null;

        const server = http.createServer((req, res) => {
            this.handleProxyRequest(req, res).catch((err) => {
                console.warn('[DR Router] Proxy request failed:', err.message);
                if (!res.headersSent) sendJsonError(res, 500, err.message, 'PROXY_ERROR');
                else res.destroy();
            });
        });

        server.on('error', (err) => {
            // Usually the port is taken: the installed app and the repo copy running at once.
            this.proxyError = err.code === 'EADDRINUSE'
                ? `Port ${this.port} is already in use (is another copy of DR Dubber open?)`
                : err.message;
            console.warn('[DR Router] Proxy server error:', err.message);
            this.proxyActive = false;
            if (this.proxyServer === server) this.proxyServer = null;
            try { server.close(); } catch (e) {}
        });

        server.listen(this.port, '127.0.0.1', () => {
            this.proxyActive = true;
            this.proxyError = null;
            console.log(`[DR Router PRO] Multi-Account Proxy listening on http://127.0.0.1:${this.port}`);
        });
        this.proxyServer = server;
    }

    async handleProxyRequest(req, res) {
        // No CORS headers: only local tools may use the pool. A web page open in the
        // browser must not be able to spend these keys by calling 127.0.0.1:8765.
        if (req.headers.origin && !isLocalOrigin(req.headers.origin)) {
            sendJsonError(res, 403, 'DR Router: requests from web pages are not allowed.', 'FORBIDDEN_ORIGIN');
            return;
        }
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        this.touchClient();

        // Status endpoint
        if (req.url === '/' || req.url === '/status' || req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                name: 'DR Router PRO Proxy',
                version: '1.0.0',
                status: 'online',
                ...this.getStats()
            }));
            return;
        }

        const bodyBuf = await readRequestBody(req);
        // Keep the caller's query (e.g. alt=sse for streaming); the pool's key goes in a header,
        // not the URL, so it stays out of proxy logs and error messages.
        const incoming = new URL(req.url, 'http://127.0.0.1');
        incoming.searchParams.delete('key');
        const upstreamUrl = `${this.upstreamBase}${incoming.pathname}${incoming.search}`;

        // The tool hung up: stop the request to Google too.
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableFinished) abort.abort(); });

        // An account that is rate-limited or refused hands the same request to the next ready
        // one - the caller only sees an error once every account has had its turn.
        const tried = new Set();
        let last = null;
        for (let account = this.pickAccount({ exclude: tried, readyOnly: true }); account; account = this.pickAccount({ exclude: tried, readyOnly: true })) {
            tried.add(account.id);
            const proxyUrl = this.getProxyForAccount(account.id);
            const fetchOpts = {
                method: req.method,
                headers: {
                    'Content-Type': req.headers['content-type'] || 'application/json',
                    'x-goog-api-key': account.apiKey
                },
                body: bodyBuf.length ? bodyBuf : undefined,
                signal: abort.signal
            };
            if (proxyUrl) fetchOpts.proxy = proxyUrl;

            this.trackInFlight(account.id, 1);
            let upstreamRes;
            try {
                upstreamRes = await secureFetch(upstreamUrl, fetchOpts);
            } catch (fetchErr) {
                this.trackInFlight(account.id, -1);
                if (abort.signal.aborted) return;
                last = {
                    status: 502,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: { message: fetchErr.message, code: 'PROXY_UPSTREAM_ERROR' } }),
                    accountId: account.id
                };
                // Through its own proxy, the next account may still get through; direct, the
                // network itself is down and every account would fail the same way.
                if (proxyUrl) continue;
                break;
            }

            if (upstreamRes.ok) {
                // Passed on as it arrives, so streaming answers (alt=sse) reach the tool live.
                res.writeHead(upstreamRes.status, {
                    'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
                    'X-DR-Router-Account': account.id
                });
                try {
                    if (upstreamRes.body) {
                        for await (const chunk of upstreamRes.body) res.write(chunk);
                    }
                    res.end();
                    this.markSuccess(account.id);
                } catch (streamErr) {
                    res.destroy();
                } finally {
                    this.trackInFlight(account.id, -1);
                }
                return;
            }

            const text = await upstreamRes.text().catch(() => '');
            this.trackInFlight(account.id, -1);
            last = {
                status: upstreamRes.status,
                contentType: upstreamRes.headers.get('content-type') || 'application/json',
                body: text,
                accountId: account.id
            };

            if (upstreamRes.status === 429) {
                this.restFromQuota(account.id, text);
                continue;
            }
            if (isDeadKeyRejection(upstreamRes.status, text)) {
                this.markInvalid(account.id, `HTTP ${upstreamRes.status}`);
                continue;
            }
            if (isKeyRejection(upstreamRes.status, text)) {
                this.markRejected(account.id, `HTTP ${upstreamRes.status}`);
                continue;
            }
            break; // the request itself is wrong (400, 404, ...): another key won't help
        }

        if (last) {
            res.writeHead(last.status, { 'Content-Type': last.contentType, 'X-DR-Router-Account': last.accountId });
            res.end(last.body);
            return;
        }

        // No account was ready to try at all.
        const resting = this.accounts.filter(a => a.enabled !== false && a.status !== 'invalid' && !!a.apiKey);
        if (resting.length) {
            const waitMs = Math.max(1000, Math.min(...resting.map(a => (a.cooldownUntil || 0) - Date.now())));
            res.setHeader('Retry-After', String(Math.ceil(waitMs / 1000)));
            sendJsonError(res, 429, `DR Router: every pool account is resting - the next one is free in ${Math.ceil(waitMs / 1000)} s.`, 'ALL_ACCOUNTS_RESTING');
            return;
        }
        sendJsonError(res, 503, 'DR Router: No active or ready accounts available in the pool. Add accounts in DR Router PRO.', 'NO_ACCOUNTS');
    }

    stopProxy() {
        if (this.proxyServer) {
            try { this.proxyServer.close(); } catch (e) {}
            this.proxyServer = null;
        }
        this.proxyActive = false;
        this.proxyError = null;
    }
}

function sendJsonError(res, status, message, code) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message, code } }));
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// Any refusal of the key (401 / 403 / 400 "API key not valid"). A 403 can pass (API not
// enabled, region, VPN), so the pool rests that key; isDeadKeyRejection says when it's gone.
function isKeyRejection(status, bodyText) {
    if (status === 401 || status === 403) return true;
    return isDeadKeyRejection(status, bodyText);
}

// A 400 is usually a bad request body, not a bad key - only retire the key when Google says so.
function isDeadKeyRejection(status, bodyText) {
    if (status === 401) return true;
    if (status !== 400) return false;
    return /API_KEY_INVALID|API key not valid|API key expired/i.test(String(bodyText || ''));
}

// Google's 429 body says which limit was hit and how long to wait (same reading as
// parseGeminiQuotaError in routes/gemini.js):
//   details: [{ '@type': '...QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
//             { '@type': '...RetryInfo', retryDelay: '55s' }]
function readQuotaError(bodyText) {
    let data = null;
    try { data = JSON.parse(bodyText); } catch (e) {}
    const errMsg = String((data && data.error && data.error.message) || bodyText || '');
    const details = Array.isArray(data && data.error && data.error.details) ? data.error.details : [];
    let retryMs = null;
    let daily = /per\s*-?day|daily quota|requests per day/i.test(errMsg);
    for (const d of details) {
        for (const v of (Array.isArray(d && d.violations) ? d.violations : [])) {
            if (v && /PerDay/i.test(String(v.quotaId || ''))) daily = true;
        }
        if (d && typeof d.retryDelay === 'string' && isFinite(parseFloat(d.retryDelay))) retryMs = Math.ceil(parseFloat(d.retryDelay) * 1000);
    }
    if (retryMs === null) {
        // "Please retry in 33.2s" or, for a daily limit, "Please retry in 20h3m39.5s".
        const m = /retry in\s*(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i.exec(errMsg);
        if (m && (m[1] || m[2] || m[3])) retryMs = Math.ceil(((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (parseFloat(m[3]) || 0)) * 1000);
    }
    return { daily, retryMs };
}

// Google's daily quotas reset at midnight Pacific time.
function msUntilPacificMidnight(now = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' })
        .formatToParts(new Date(now));
    const get = (t) => +((parts.find(p => p.type === t) || {}).value || 0);
    const sinceMidnightMs = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000;
    return Math.max(60 * 1000, 24 * 3600 * 1000 - sinceMidnightMs);
}

// The proxy address as the dashboard may show it: the password left out.
function maskProxyUrl(url) {
    return String(url || '').replace(/\/\/([^:@/]*):[^@/]*@/, '//$1:••••@');
}

function isLocalOrigin(origin) {
    return /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$|file:\/\/|app:\/\/)/i.test(String(origin));
}

function parseProxyString(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim();
    if (!s || s.startsWith('#')) return null;

    let protocol = 'http';
    let username = '';
    let password = '';
    let host = '';
    let port = 8080;

    const protoMatch = s.match(/^([a-zA-Z0-9]+):\/\//);
    if (protoMatch) {
        protocol = protoMatch[1].toLowerCase();
        s = s.slice(protoMatch[0].length);
    }

    if (s.includes('@')) {
        const at = s.lastIndexOf('@');
        const userPass = s.slice(0, at);
        const hostPort = s.slice(at + 1);
        if (userPass.includes(':')) {
            const up = userPass.split(':');
            username = decodeURIComponent(up[0]);
            password = decodeURIComponent(up.slice(1).join(':'));
        } else {
            username = decodeURIComponent(userPass);
        }
        s = hostPort;
    }

    const parts = s.split(':');
    if (parts.length === 4) {
        host = parts[0].trim();
        port = parseInt(parts[1], 10) || 8080;
        username = parts[2].trim();
        password = parts[3].trim();
    } else if (parts.length === 2) {
        host = parts[0].trim();
        port = parseInt(parts[1], 10) || 8080;
    } else if (parts.length === 1 && parts[0]) {
        host = parts[0].trim();
    } else {
        return null;
    }

    if (!host) return null;

    const authPart = (username || password) 
        ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` 
        : '';
    const url = `${protocol}://${authPart}${host}:${port}`;

    return {
        protocol,
        host,
        port,
        username,
        password,
        url
    };
}

let instance = null;
function getDRRouterManager(options) {
    if (!instance) {
        instance = new DRRouterManager(options);
    }
    return instance;
}

module.exports = {
    DRRouterManager,
    getDRRouterManager,
    parseProxyString,
    isKeyRejection,
    isDeadKeyRejection,
    readQuotaError,
    maskProxyUrl,
    isLocalOrigin,
    // Backward compatibility aliases
    DaPoolManager: DRRouterManager,
    getDaPoolManager: getDRRouterManager
};
