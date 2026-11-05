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

class DRRouterManager {
    constructor(options = {}) {
        this.configPath = options.configPath || DEFAULT_CONFIG_PATH;
        this.port = options.port || DEFAULT_PORT;
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
            }
        } catch (e) {
            console.warn('[DR Router] Error loading config:', e.message);
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
            fs.writeFileSync(this.configPath, JSON.stringify(data, null, 2), 'utf8');
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

    addAccount({ email, apiKey }) {
        if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
            throw new Error('API key is required.');
        }
        const cleanKey = apiKey.trim();
        const cleanEmail = (email && typeof email === 'string' && email.trim()) || `account_${this.accounts.length + 1}@gmail.com`;

        // Check if duplicate key already exists
        const existing = this.accounts.find(a => a.apiKey === cleanKey);
        if (existing) {
            existing.email = cleanEmail;
            existing.status = 'ready';
            existing.enabled = true;
            this.save();
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
        this.save();
        return newAccount;
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

    pickAccount() {
        const ready = this.getReadyAccounts();
        if (!ready.length) {
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

    markRateLimited(id, retryAfterMs = 60000) {
        const acc = this.accounts.find(a => a.id === id);
        if (acc) {
            acc.status = 'cooling';
            acc.cooldownUntil = Date.now() + Math.max(5000, retryAfterMs);
            acc.lastError = 'Rate limited (429)';
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
            linked: this.linked,
            fastMode: this.fastMode,
            proxiesTotal,
            proxiesOnline,
            proxyMode: this.proxyMode,
            clientLastSeen: this.clientLastSeen,
            lastRequestAt: this.lastRequestAt
        };
    }

    // Ping single account using Gemini API test
    async testAccount(id) {
        const acc = this.accounts.find(a => a.id === id);
        if (!acc || !acc.apiKey) throw new Error('Account or API key not found');

        const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(acc.apiKey)}`;
        const payload = {
            contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 2 }
        };

        try {
            const proxyUrl = this.getProxyForAccount(acc.id);
            const fetchOpts = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            };
            if (proxyUrl) fetchOpts.proxy = proxyUrl;

            const res = await secureFetch(testUrl, fetchOpts);

            if (res.ok) {
                acc.status = 'ready';
                acc.lastError = null;
                acc.cooldownUntil = 0;
                this.save();
                return { success: true, status: 'ready', message: 'Account is ready & working.' };
            }

            const body = await res.text();
            let parsed = {};
            try { parsed = JSON.parse(body); } catch (e) {}

            const errMsg = (parsed.error && parsed.error.message) || `HTTP ${res.status}`;
            if (res.status === 429) {
                acc.status = 'cooling';
                acc.cooldownUntil = Date.now() + 60000;
                acc.lastError = errMsg;
                this.save();
                return { success: false, status: 'cooling', message: errMsg };
            }

            if (isKeyRejection(res.status, body)) {
                acc.status = 'invalid';
                acc.lastError = errMsg;
                this.save();
                return { success: false, status: 'invalid', message: errMsg };
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
                url: p.url,
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

    // Launch local proxy server on 127.0.0.1:8765
    startProxy() {
        if (this.proxyServer) return;

        this.proxyServer = http.createServer(async (req, res) => {
            // No CORS headers: only local tools may use the pool. A web page open in the
            // browser must not be able to spend these keys by calling 127.0.0.1:8765.
            if (req.headers.origin && !isLocalOrigin(req.headers.origin)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'DR Router: requests from web pages are not allowed.', code: 'FORBIDDEN_ORIGIN' } }));
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

            // Pick an account from the pool
            const account = this.pickAccount();
            if (!account || !account.apiKey) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'DR Router: No active or ready accounts available in the pool. Add accounts in DR Router PRO.',
                        code: 'NO_ACCOUNTS'
                    }
                }));
                return;
            }

            // Read incoming body
            const chunks = [];
            req.on('data', c => chunks.push(c));
            req.on('end', async () => {
                const bodyBuf = Buffer.concat(chunks);
                // Keep the caller's query (e.g. alt=sse for streaming) but swap in the pool's key.
                const incoming = new URL(req.url, 'http://127.0.0.1');
                incoming.searchParams.delete('key');
                incoming.searchParams.set('key', account.apiKey);
                const upstreamUrl = `https://generativelanguage.googleapis.com${incoming.pathname}${incoming.search}`;

                this.trackInFlight(account.id, 1);

                try {
                    const proxyUrl = this.getProxyForAccount(account.id);
                    const fetchOpts = {
                        method: req.method,
                        headers: {
                            'Content-Type': req.headers['content-type'] || 'application/json'
                        },
                        body: bodyBuf.length ? bodyBuf : undefined
                    };
                    if (proxyUrl) fetchOpts.proxy = proxyUrl;
                    const upstreamRes = await secureFetch(upstreamUrl, fetchOpts);

                    const resBody = typeof upstreamRes.buffer === 'function'
                        ? await upstreamRes.buffer()
                        : Buffer.from(await upstreamRes.arrayBuffer());
                    this.trackInFlight(account.id, -1);

                    if (upstreamRes.ok) {
                        this.markSuccess(account.id);
                    } else if (upstreamRes.status === 429) {
                        this.markRateLimited(account.id);
                    } else if (isKeyRejection(upstreamRes.status, resBody.toString('utf8'))) {
                        this.markInvalid(account.id, `HTTP ${upstreamRes.status}`);
                    }

                    res.writeHead(upstreamRes.status, {
                        'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
                        'X-DR-Router-Account': account.id
                    });
                    res.end(resBody);
                } catch (fetchErr) {
                    this.trackInFlight(account.id, -1);
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: fetchErr.message, code: 'PROXY_UPSTREAM_ERROR' } }));
                }
            });
        });

        this.proxyServer.on('error', (err) => {
            console.warn('[DR Router] Proxy server error:', err.message);
            this.proxyActive = false;
        });

        this.proxyServer.listen(this.port, '127.0.0.1', () => {
            this.proxyActive = true;
            console.log(`[DR Router PRO] Multi-Account Proxy listening on http://127.0.0.1:${this.port}`);
        });
    }

    stopProxy() {
        if (this.proxyServer) {
            try { this.proxyServer.close(); } catch (e) {}
            this.proxyServer = null;
            this.proxyActive = false;
        }
    }
}

// A 400 is usually a bad request body, not a bad key - only retire the key when Google says so.
function isKeyRejection(status, bodyText) {
    if (status === 401 || status === 403) return true;
    if (status !== 400) return false;
    return /API_KEY_INVALID|API key not valid|API key expired/i.test(String(bodyText || ''));
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
        const atParts = s.split('@');
        const userPass = atParts[0];
        const hostPort = atParts[1];
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
    isLocalOrigin,
    // Backward compatibility aliases
    DaPoolManager: DRRouterManager,
    getDaPoolManager: getDRRouterManager
};
