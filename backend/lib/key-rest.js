// Gemini keys that are resting: refused by Google, or over a limit (the whole key, or one of its
// models). The lists are kept on disk too, so closing the app doesn't forget them - after a
// restart every resting key was asked again just to be refused again. Keys are saved as a hash,
// never as text; a key's saved rest is read back the first time the app sees that key.
//
// Also kept: when Google last answered each key (Settings tells "Not checked today" from
// "Ready"), and how many "daily quota" answers in a row a key+model gave (the 15 min / 1 h
// rechecks of routes/gemini.js - a restart no longer starts them over).
//
// The file can be shared: the installed app and the copy started from the repo use the same one,
// so one doesn't ask keys the other already found resting. Saving merges with what is on disk
// (the newer record wins), and what the other app wrote is read in every SYNC_MS. Every record
// carries the time it was set ("at"); clearing one leaves a "cleared" time for a while, so the
// other app's older copy doesn't bring it back.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAVE_DELAY_MS = 2000;
const SYNC_MS = 20 * 1000;
const STRIKE_KEEP_MS = 6 * 60 * 60 * 1000;     // routes/gemini.js forgets strikes 6 h apart
const ANSWER_KEEP_MS = 26 * 60 * 60 * 1000;    // "answered since the last daily reset" needs < 24 h
const CLEARED_KEEP_MS = 26 * 60 * 60 * 1000;   // longer than any saved rest lasts

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24);
// "key|model" -> key (keys have no "|").
const keyOf = (id) => String(id).split('|')[0];
const modelOf = (id) => String(id).slice(keyOf(id).length + 1);

// file: where the lists are kept (null: memory only). legacyFiles: older files read in too (the
// per-app file before it was shared). now: the clock (tests).
function createKeyRest({ file = null, legacyFiles = [], now = Date.now } = {}) {
    let saved = {}; // hash -> entry from the file, for keys not seen yet
    const seen = new Set();
    const hashToKey = new Map();
    const cleared = {}; // hash -> { invalid?, limit?, models?: { model: at } } cleared in this run
    let timer = null;

    // A Map that reads a key's saved rest before answering, and saves after every change.
    class RestMap extends Map {
        constructor(field) { super(); this.field = field; }
        get(id) { adopt(keyOf(id)); return super.get(id); }
        has(id) { adopt(keyOf(id)); return super.has(id); }
        set(id, v) {
            adopt(keyOf(id));
            super.set(id, v && typeof v === 'object' && v.at == null ? { ...v, at: now() } : v);
            saveSoon();
            return this;
        }
        delete(id) {
            adopt(keyOf(id));
            const had = super.delete(id);
            if (had && this.field) markCleared(this.field, id);
            if (had) saveSoon();
            return had;
        }
    }
    const invalid = new RestMap('invalid');     // key -> { until, dead, message, at }
    const keyLimits = new RestMap('limit');     // key -> { until, daily, at }
    const modelLimits = new RestMap('models');  // "key|model" -> { until, daily, msg, at }
    const dailyStrikes = new RestMap(null);     // "key|model" -> { count, at }
    const answered = new RestMap(null);         // key -> at: Google last answered this key
    // Filling a list from the file: no adopt, no save.
    const put = (map, id, v) => Map.prototype.set.call(map, id, v);

    const live = (e) => !!(e && e.until > now());
    const recent = (at, keep) => typeof at === 'number' && at > now() - keep;

    function markCleared(field, id) {
        const c = (cleared[hashKey(keyOf(id))] = cleared[hashKey(keyOf(id))] || {});
        if (field === 'models') (c.models = c.models || {})[modelOf(id)] = now();
        else c[field] = now();
    }

    // The newer of two records (by when it was set; an old file has no "at": by its end).
    const newer = (a, b) => (!a ? b : !b ? a : ((a.at || 0) !== (b.at || 0) ? ((a.at || 0) > (b.at || 0) ? a : b) : (a.until || 0) >= (b.until || 0) ? a : b));

    // Two entries of one key merged, then trimmed to what is worth keeping.
    function mergeEntries(a = {}, b = {}) {
        const c = {
            invalid: Math.max(a.cleared?.invalid || 0, b.cleared?.invalid || 0) || undefined,
            limit: Math.max(a.cleared?.limit || 0, b.cleared?.limit || 0) || undefined,
            models: {},
        };
        for (const m of new Set([...Object.keys(a.cleared?.models || {}), ...Object.keys(b.cleared?.models || {})])) {
            c.models[m] = Math.max(a.cleared?.models?.[m] || 0, b.cleared?.models?.[m] || 0);
        }
        const keepRec = (rec, clearedAt) => (rec && live(rec) && !(clearedAt && clearedAt >= (rec.at || 0)) ? rec : undefined);
        const out = {};
        const inv = keepRec(newer(a.invalid, b.invalid), c.invalid);
        if (inv && inv.dead) out.invalid = inv;
        const lim = keepRec(newer(a.limit, b.limit), c.limit);
        if (lim && lim.daily) out.limit = lim;
        const models = {};
        for (const m of new Set([...Object.keys(a.models || {}), ...Object.keys(b.models || {})])) {
            const rec = keepRec(newer(a.models?.[m], b.models?.[m]), c.models[m]);
            if (rec && rec.daily) models[m] = rec;
        }
        if (Object.keys(models).length) out.models = models;
        const strikes = {};
        for (const m of new Set([...Object.keys(a.strikes || {}), ...Object.keys(b.strikes || {})])) {
            const s = [a.strikes?.[m], b.strikes?.[m]].filter(Boolean).sort((x, y) => (y.at || 0) - (x.at || 0))[0];
            if (s && recent(s.at, STRIKE_KEEP_MS)) strikes[m] = s;
        }
        if (Object.keys(strikes).length) out.strikes = strikes;
        const answeredAt = Math.max(a.answeredAt || 0, b.answeredAt || 0);
        if (recent(answeredAt, ANSWER_KEEP_MS)) out.answeredAt = answeredAt;
        const keptCleared = {};
        if (recent(c.invalid, CLEARED_KEEP_MS)) keptCleared.invalid = c.invalid;
        if (recent(c.limit, CLEARED_KEEP_MS)) keptCleared.limit = c.limit;
        const cm = Object.fromEntries(Object.entries(c.models).filter(([, at]) => recent(at, CLEARED_KEEP_MS)));
        if (Object.keys(cm).length) keptCleared.models = cm;
        if (Object.keys(keptCleared).length) out.cleared = keptCleared;
        return out;
    }

    function readFile(f) {
        try {
            const data = JSON.parse(fs.readFileSync(f, 'utf8'));
            return data && typeof data.keys === 'object' && data.keys ? data.keys : {};
        } catch (e) {
            return {};
        }
    }

    function load() {
        if (!file) return;
        for (const f of [...legacyFiles, file]) {
            for (const [h, e] of Object.entries(readFile(f))) saved[h] = mergeEntries(saved[h], e);
        }
    }

    // This run's own knowledge of one key, in the file's form.
    function entryOf(key) {
        const e = {};
        const inv = Map.prototype.get.call(invalid, key);
        if (inv) e.invalid = { until: inv.until, dead: !!inv.dead, message: inv.message || '', at: inv.at };
        const lim = Map.prototype.get.call(keyLimits, key);
        if (lim) e.limit = { until: lim.until, daily: !!lim.daily, at: lim.at };
        for (const [id, c] of modelLimits) {
            if (keyOf(id) === key) (e.models = e.models || {})[modelOf(id)] = { until: c.until, daily: !!c.daily, msg: String(c.msg || '').slice(0, 300), at: c.at };
        }
        for (const [id, s] of dailyStrikes) {
            if (keyOf(id) === key) (e.strikes = e.strikes || {})[modelOf(id)] = { count: s.count, at: s.at };
        }
        const at = Map.prototype.get.call(answered, key);
        if (at) e.answeredAt = at;
        if (cleared[hashKey(key)]) e.cleared = cleared[hashKey(key)];
        return e;
    }

    // Puts one key's entry into the lists: records newer than what this run has replace them,
    // a clearing newer than a record removes it.
    function apply(key, e) {
        const take = (map, id, rec, clearedAt) => {
            const cur = Map.prototype.get.call(map, id);
            if (cur && clearedAt && clearedAt >= (cur.at || 0)) Map.prototype.delete.call(map, id);
            if (!rec || !live(rec) || (clearedAt && clearedAt >= (rec.at || 0))) return;
            const left = Map.prototype.get.call(map, id);
            if (!left || (rec.at || 0) > (left.at || 0)) put(map, id, rec);
        };
        take(invalid, key, e.invalid, e.cleared?.invalid);
        take(keyLimits, key, e.limit, e.cleared?.limit);
        const models = new Set([...Object.keys(e.models || {}), ...Object.keys(e.cleared?.models || {})]);
        for (const m of models) take(modelLimits, `${key}|${m}`, e.models?.[m], e.cleared?.models?.[m]);
        for (const [m, s] of Object.entries(e.strikes || {})) {
            const cur = Map.prototype.get.call(dailyStrikes, `${key}|${m}`);
            if (!cur || (s.at || 0) > (cur.at || 0)) put(dailyStrikes, `${key}|${m}`, s);
        }
        if (e.answeredAt && e.answeredAt > (Map.prototype.get.call(answered, key) || 0)) put(answered, key, e.answeredAt);
    }

    // The first time a key is seen: its saved rest goes into the lists (what this run already
    // knows about the key wins).
    function adopt(key) {
        if (!key || seen.has(key)) return;
        seen.add(key);
        const h = hashKey(key);
        hashToKey.set(h, key);
        const e = saved[h];
        if (!e) return;
        delete saved[h];
        apply(key, e);
    }

    // The file's form of everything known: this run's keys, plus saved entries of keys not seen.
    function snapshot() {
        const out = {};
        for (const [h, e] of Object.entries(saved)) {
            const m = mergeEntries(e, {});
            if (Object.keys(m).length) out[h] = m;
        }
        for (const key of seen) {
            const m = mergeEntries(entryOf(key), {});
            if (Object.keys(m).length) out[hashKey(key)] = m;
        }
        return out;
    }

    // What the other app wrote since: newer records into the lists (and into the saved entries
    // of keys this run hasn't seen yet).
    function sync() {
        if (!file) return;
        for (const [h, e] of Object.entries(readFile(file))) {
            const key = hashToKey.get(h);
            if (key) apply(key, e);
            else saved[h] = mergeEntries(saved[h], e);
        }
    }

    function save() {
        clearTimeout(timer);
        timer = null;
        if (!file) return;
        try {
            const disk = readFile(file);
            const mine = snapshot();
            const merged = {};
            for (const h of new Set([...Object.keys(disk), ...Object.keys(mine)])) {
                const m = mergeEntries(disk[h], mine[h]);
                if (Object.keys(m).length) merged[h] = m;
            }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // Written beside it and renamed over it: a power cut mid-write leaves the last good one.
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ keys: merged }));
            fs.renameSync(tmp, file);
        } catch (e) {
            console.warn('[Gemini] Could not save which keys are resting:', e.message);
        }
    }

    function saveSoon() {
        if (!file || timer) return;
        timer = setTimeout(save, SAVE_DELAY_MS);
        if (timer.unref) timer.unref();
    }

    load();
    if (file) {
        const t = setInterval(sync, SYNC_MS);
        if (t.unref) t.unref();
    }
    return { invalid, keyLimits, modelLimits, dailyStrikes, answered, save, snapshot, sync };
}

module.exports = { createKeyRest, hashKey };
