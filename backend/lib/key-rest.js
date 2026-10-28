// Gemini keys that are resting: refused by Google, or over a limit (the whole key, or one of its
// models). The lists are kept on disk too, so closing the app doesn't forget them - after a
// restart every resting key was asked again just to be refused again. Keys are saved as a hash,
// never as text; a key's saved rest is read back the first time the app sees that key.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SAVE_DELAY_MS = 2000;

const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24);
// "key|model" -> key (keys have no "|").
const keyOf = (id) => String(id).split('|')[0];

// file: where the lists are kept (null: memory only). now: the clock (tests).
function createKeyRest({ file = null, now = Date.now } = {}) {
    let saved = {}; // hash -> { invalid?, limit?, models? } from the file, for keys not seen yet
    const seen = new Set();
    let timer = null;

    // A Map that reads a key's saved rest before answering, and saves after every change.
    class RestMap extends Map {
        get(id) { adopt(keyOf(id)); return super.get(id); }
        has(id) { adopt(keyOf(id)); return super.has(id); }
        set(id, v) { adopt(keyOf(id)); super.set(id, v); saveSoon(); return this; }
        delete(id) { adopt(keyOf(id)); const had = super.delete(id); if (had) saveSoon(); return had; }
    }
    const invalid = new RestMap();     // key -> { until, dead, message }
    const keyLimits = new RestMap();   // key -> { until, daily }
    const modelLimits = new RestMap(); // "key|model" -> { until, daily, msg }
    // Filling a list from the file: no adopt, no save.
    const put = (map, id, v) => { if (!Map.prototype.has.call(map, id)) Map.prototype.set.call(map, id, v); };

    const live = (e) => !!(e && e.until > now());

    function load() {
        if (!file) return;
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (data && typeof data.keys === 'object') saved = data.keys;
        } catch (e) { saved = {}; }
    }

    // The first time a key is seen: its saved rest goes into the lists (what this run already
    // knows about the key wins).
    function adopt(key) {
        if (!key || seen.has(key)) return;
        seen.add(key);
        const e = saved[hashKey(key)];
        if (!e) return;
        delete saved[hashKey(key)];
        if (live(e.invalid)) put(invalid, key, e.invalid);
        if (live(e.limit)) put(keyLimits, key, e.limit);
        for (const [model, c] of Object.entries(e.models || {})) if (live(c)) put(modelLimits, `${key}|${model}`, c);
    }

    // Only rests that last: a dead key, a daily limit. A per-minute limit is over by the time
    // the app opens again.
    function snapshot() {
        const out = {};
        for (const [h, e] of Object.entries(saved)) {
            const keep = {};
            if (live(e.invalid)) keep.invalid = e.invalid;
            if (live(e.limit)) keep.limit = e.limit;
            const models = Object.fromEntries(Object.entries(e.models || {}).filter(([, c]) => live(c)));
            if (Object.keys(models).length) keep.models = models;
            if (Object.keys(keep).length) out[h] = keep;
        }
        const entry = (key) => (out[hashKey(key)] = out[hashKey(key)] || {});
        for (const [key, e] of invalid) {
            if (live(e) && e.dead) entry(key).invalid = { until: e.until, dead: true, message: e.message || '' };
        }
        for (const [key, e] of keyLimits) {
            if (live(e) && e.daily) entry(key).limit = { until: e.until, daily: true };
        }
        for (const [id, c] of modelLimits) {
            if (!live(c) || !c.daily) continue;
            const e = entry(keyOf(id));
            (e.models = e.models || {})[id.slice(keyOf(id).length + 1)] = { until: c.until, daily: true, msg: String(c.msg || '').slice(0, 300) };
        }
        return out;
    }

    function save() {
        clearTimeout(timer);
        timer = null;
        if (!file) return;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // Written beside it and renamed over it: a power cut mid-write leaves the last good one.
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ keys: snapshot() }));
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
    return { invalid, keyLimits, modelLimits, save, snapshot };
}

module.exports = { createKeyRest, hashKey };
