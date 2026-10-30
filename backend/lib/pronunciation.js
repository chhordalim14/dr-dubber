// Automatic pronunciation fixes for the Edge voices (Piseth / Sreymom).
//
// In the background, every saved transcript line is read by Edge and by Google Translate (the
// answer key), and a Khmer speech recogniser writes both down (python/pronunciation_checker.py,
// in the VoxCPM2 venv - it needs PyTorch). A word Edge says differently from Google, in more
// lines than it says it right, is a suspect. Then the line is voiced again with the word
// respelled (a space between its syllables, as សមមុខ -> សម មុខ fixed the extra syllable in
// សំម៉ាមុខ), and a spelling that clearly beats the written one goes on the automatic list
// (storage/pronunciation/state.json). khmer-speech.js applies the list before Edge reads a line;
// the user's own Settings list wins, and a fix the user removes is never added again.
//
// Only the spelling sent to Edge changes: the voices, the subtitles and the SRT stay as they are.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const VOICES = { Male: 'km-KH-PisethNeural', Female: 'km-KH-SreymomNeural' };
const LINES_AT_ONCE = 3;
const SETTLED_AFTER = 3;       // a word heard this many times is known
const MIN_BAD = 3;             // ...and a suspect once it went wrong in this many lines (more than right),
const MIN_BAD_NEVER_RIGHT = 2; // or in this many and never right. Measured: at 2 either way, 1 in 12 tries found a fix.
const EXAMPLES = 3;            // lines a fix is tried in, each with both voices
const MIN_GAIN = 2;            // a fix must be right in this many more clips than the word as written
const MIN_SHARE = 0.6;         // ...and in this share of them
const REF_MATCH = 0.75;        // Google's reading must match the text this well to be the key
const IDLE_STOP_MS = 2 * 60 * 1000; // the recogniser leaves the GPU when there is nothing to do

// ---- Comparing what the recogniser heard ----------------------------------------------------

const isConsonant = (c) => c >= 0x1780 && c <= 0x17A2;
const isIndependentVowel = (c) => c >= 0x17A3 && c <= 0x17B3;
const NIKAHIT = 0x17C6; // ំ, a final m: សំ and សម are said alike
const OBJECT_WORD = /ឲ្យ|ឱ្យ|អោយ/g; // one word, three spellings

// The consonant outline of a Khmer text (its syllables' consonants, ំ as ម) with each letter's
// place in the text. The recogniser spells vowels and signs loosely (ស៊ុំ / សុំ / សំ for the same
// sound); an extra or missing syllable or a wrong consonant still shows in the outline.
function outline(text) {
    const s = String(text || '').replace(OBJECT_WORD, (w) => `ឲ${'​'.repeat(w.length - 1)}`);
    let out = '';
    const at = [];
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (isConsonant(c) || isIndependentVowel(c)) out += s[i];
        else if (c === NIKAHIT) out += 'ម';
        else continue;
        at.push(i);
    }
    return { s: out, at };
}

// Edit operations turning a into b: [tag, i1, i2, j1, j2] with tag 'equal' or 'replace'
// ('replace' covers inserts and deletes: an empty range on one side).
function align(a, b) {
    const n = a.length;
    const m = b.length;
    const d = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = 0; i <= n; i++) d[i][0] = i;
    for (let j = 0; j <= m; j++) d[0][j] = j;
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
    }
    // Walk back from the end: each step uses a letter of a (da = 1), of b (db = 1), or both.
    const steps = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) steps.push(['equal', 1, 1]);
        else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) steps.push(['replace', 1, 1]);
        else if (i > 0 && d[i][j] === d[i - 1][j] + 1) steps.push(['replace', 1, 0]);
        else steps.push(['replace', 0, 1]);
        i -= steps[steps.length - 1][1];
        j -= steps[steps.length - 1][2];
    }
    const ops = [];
    let ai = 0;
    let bj = 0;
    for (let k = steps.length - 1; k >= 0; k--) {
        const [tag, da, db] = steps[k];
        const last = ops[ops.length - 1];
        if (last && last[0] === tag) { last[2] += da; last[4] += db; } else ops.push([tag, ai, ai + da, bj, bj + db]);
        ai += da;
        bj += db;
    }
    return ops;
}

const similarity = (a, b) => {
    if (!a.length && !b.length) return 1;
    const ops = align(a, b);
    let same = 0;
    for (const [tag, i1, i2] of ops) if (tag === 'equal') same += i2 - i1;
    return (2 * same) / (a.length + b.length);
};

// A place in b, as the matching place in a.
function toA(ops, j) {
    for (const [tag, i1, i2, j1, j2] of ops) {
        if (j < j1 || j >= j2) continue;
        if (tag === 'equal') return i1 + (j - j1);
        return i1 + Math.floor(((j - j1) * (i2 - i1)) / (j2 - j1));
    }
    return ops.length ? ops[ops.length - 1][2] : 0; // the end
}
// A [start, end) range of b as a range of a, at least one letter long.
function rangeToA(ops, [s, e], lenA) {
    const a = Math.min(toA(ops, s), Math.max(0, lenA - 1));
    const b = e > s ? toA(ops, e - 1) + 1 : a + 1;
    return [a, Math.min(lenA, Math.max(a + 1, b))];
}

// Where in the text Edge said something other than Google: [start, end) ranges of the text.
// Only where Edge also differs from the text itself (a place where Google strays is not Edge's
// mistake). null when Google's own reading is too far from the text to be the key.
function edgeMistakes(text, edgeHeard, googleHeard) {
    const T = outline(text);
    const G = outline(googleHeard);
    const E = outline(edgeHeard);
    if (!T.s.length || similarity(T.s, G.s) < REF_MATCH) return null;
    const widen = ([a, b], len) => (a === b ? [Math.max(0, a - 1), Math.min(len, a + 1)] : [a, b]);
    const differ = (ops, side) => ops.filter((o) => o[0] !== 'equal').map((o) => (side === 'a' ? [o[1], o[2]] : [o[3], o[4]]));
    const tg = align(T.s, G.s);
    const fromGoogle = differ(align(G.s, E.s), 'a')
        .map((r) => widen(r, G.s.length))
        .map((r) => rangeToA(tg, r, T.s.length));
    const fromText = differ(align(T.s, E.s), 'a').map((r) => widen(r, T.s.length));
    const overlaps = ([a, b], [c, d]) => a < d && c < b;
    return fromGoogle
        .filter((r) => fromText.some((t) => overlaps(r, t)))
        .map(([a, b]) => [T.at[Math.min(a, T.at.length - 1)], T.at[Math.min(b, T.at.length) - 1] + 1])
        .filter(([a, b]) => b > a);
}

let segmenter = null;
function words(text) {
    if (!segmenter) segmenter = new Intl.Segmenter('km', { granularity: 'word' });
    const out = [];
    for (const seg of segmenter.segment(String(text || ''))) {
        if (seg.isWordLike && /[ក-៓]/.test(seg.segment)) out.push({ word: seg.segment, start: seg.index, end: seg.index + seg.segment.length });
    }
    return out;
}

// One checked line: its words Edge said wrong and the ones it said right. null: no key.
// Wrong words written together count as one (ពិសេស|មុខ -> ពិសេសមុខ): Edge often trips where two
// words run into each other, and respelling either one alone would change it everywhere.
function judgeLine(text, edgeHeard, googleHeard) {
    const ranges = edgeMistakes(text, edgeHeard, googleHeard);
    if (!ranges) return null;
    const bad = [];
    const ok = [];
    let joinable = null; // the last wrong word, if nothing came after it yet
    for (const w of words(text)) {
        if (!ranges.some(([a, b]) => a < w.end && w.start < b)) { ok.push(w.word); joinable = null; continue; }
        if (joinable && joinable.end === w.start) bad[bad.length - 1] += w.word;
        else bad.push(w.word);
        joinable = w;
    }
    return { bad, ok };
}

// Respellings to try: a space at one syllable boundary (សម មុខ), or between every syllable.
function respellings(word) {
    // A consonant starts a syllable when its own vowel sign follows it (the មុ of សមមុខ); one
    // after a vowel and before another consonant ends one (the last ស of ពិសេស). Before a
    // subscript it starts one only after a whole syllable (ព្រះ|អង្គ|ម្ចាស់), not after a bare
    // consonant, where it is that syllable's end (the ង of អង្គ, the ម of សម្ដែង).
    const cuts = [];
    const isSign = (c) => c >= 0x17B6 && c <= 0x17D1;
    for (let i = 1; i < word.length - 1; i++) {
        const c = word.charCodeAt(i);
        const prev = word.charCodeAt(i - 1);
        const next = word.charCodeAt(i + 1);
        if (prev === 0x17D2) continue; // a subscript, inside a cluster
        const afterSyllable = isSign(prev) || (i >= 2 && word.charCodeAt(i - 2) === 0x17D2);
        if (isIndependentVowel(c) || (isConsonant(c) && ((next >= 0x17B6 && next <= 0x17C5) || (next === 0x17D2 && afterSyllable)))) cuts.push(i);
    }
    const out = cuts.map((i) => `${word.slice(0, i)} ${word.slice(i)}`);
    if (cuts.length > 1) out.push(cuts.reduceRight((w, i) => `${w.slice(0, i)} ${w.slice(i)}`, word));
    return out.slice(0, 4);
}

// ---- The background job ---------------------------------------------------------------------

function createPronunciationChecker({ storageDir, batchDir, scriptPath, ffmpegPath, khmerSpeech, voxDir = path.join(os.homedir(), 'DR Dubber VoxCPM2'), onSpawn = () => { }, log = () => { }, hearFn = null }) {
    const stateFile = path.join(storageDir, 'pronunciation', 'state.json');
    const python = path.join(voxDir, 'venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
    const modelDir = path.join(voxDir, 'models', 'whisper-small-khmer');
    let state = load();
    let worker = null;
    let running = false;
    let again = false;
    let idleTimer = null;
    let status = { busy: false, device: null, error: null };

    function load() {
        let s = {};
        try { s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { }
        return { enabled: s.enabled !== false, words: s.words || {}, lines: s.lines || {}, files: s.files || {}, fixes: s.fixes || {}, rejected: s.rejected || {}, tried: s.tried || {} };
    }
    let dirty = 0;
    function save(force) {
        if (!force && ++dirty < 20) return;
        dirty = 0;
        try {
            fs.mkdirSync(path.dirname(stateFile), { recursive: true });
            const tmp = `${stateFile}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
            fs.renameSync(tmp, stateFile);
        } catch (e) { log(`[Pronunciation] Could not save: ${e.message}`); }
    }

    const available = () => !!hearFn || fs.existsSync(python) && fs.existsSync(path.join(modelDir, 'model.safetensors')) && fs.existsSync(scriptPath);

    // ---- the Python worker
    function startWorker() {
        return new Promise((resolve, reject) => {
            const child = spawn(python, ['-I', scriptPath, '--model', modelDir, '--ffmpeg', ffmpegPath(), '--concurrency', String(LINES_AT_ONCE)],
                { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
            onSpawn(child);
            const pending = new Map();
            let nextId = 1;
            let buf = '';
            const dec = new StringDecoder('utf8');
            let errTail = '';
            let ready = false;
            const w = {
                child,
                hear(text, voice) {
                    return new Promise((res) => {
                        const id = nextId++;
                        pending.set(id, res);
                        child.stdin.write(JSON.stringify({ id, text, voice }) + '\n');
                    });
                },
            };
            child.stdout.on('data', (d) => {
                buf += dec.write(d);
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    let msg;
                    try { msg = JSON.parse(line); } catch (e) { continue; }
                    if (msg.ready) { ready = true; status.device = msg.device; resolve(w); continue; }
                    const res = pending.get(msg.id);
                    if (res) { pending.delete(msg.id); res(msg); }
                }
            });
            child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-600); });
            child.stdin.on('error', () => { });
            const end = (why) => {
                if (worker === w) worker = null;
                for (const res of pending.values()) res({ success: false, error: `checker stopped (${why})` });
                pending.clear();
                if (!ready) reject(new Error(`The pronunciation checker did not start (${why}). ${errTail.trim().split('\n').pop() || ''}`));
            };
            child.on('error', (e) => end(e.message));
            child.on('close', (code) => end(`exit ${code}`));
        });
    }
    async function hear(text, voice) {
        if (hearFn) return hearFn(text, voice); // tests
        if (!worker) worker = await startWorker();
        return worker.hear(text, voice);
    }
    function stopWorker() {
        if (worker) { try { worker.child.stdin.end(); } catch (e) { } worker = null; }
    }

    // ---- what to check
    const lineKey = (text, voice) => crypto.createHash('sha1').update(`${voice}|${text}`).digest('hex').slice(0, 16);
    const known = (w) => state.fixes[w] || state.rejected[w] || state.tried[w] || (state.words[w] && state.words[w].ok + state.words[w].bad >= SETTLED_AFTER);
    const voiceOf = (gender) => (/female|woman|girl|mother|wife|sister|grandma|aunt/i.test(String(gender || '')) ? VOICES.Female : VOICES.Male);

    // Lines from the saved transcripts, newest first, that still hold a word not known yet.
    function* linesToCheck() {
        let names = [];
        try { names = fs.readdirSync(batchDir).filter((n) => n.endsWith('.json')); } catch (e) { return; }
        const files = names.map((n) => { try { return { n, m: fs.statSync(path.join(batchDir, n)).mtimeMs }; } catch (e) { return null; } })
            .filter(Boolean).sort((a, b) => b.m - a.m);
        for (const { n, m } of files) {
            if (state.files[n] === m) continue;
            let data = [];
            try { data = JSON.parse(fs.readFileSync(path.join(batchDir, n), 'utf8')).data || []; } catch (e) { continue; }
            for (const line of data) {
                const text = khmerSpeech.normalizeForSpeech(line && line.text);
                if (!/[ក-៿]/.test(text)) continue;
                const voice = voiceOf(line.gender);
                const key = lineKey(text, voice);
                if (state.lines[key]) continue;
                if (!words(text).some((w) => !known(w.word))) { state.lines[key] = 1; continue; }
                yield { text, voice, key };
            }
            state.files[n] = m;
        }
    }

    function count(text, voice, judged) {
        for (const w of judged.ok) { const s = state.words[w] || (state.words[w] = { ok: 0, bad: 0, ex: [] }); s.ok++; }
        for (const w of judged.bad) {
            const s = state.words[w] || (state.words[w] = { ok: 0, bad: 0, ex: [] });
            s.bad++;
            if (s.ex.length < EXAMPLES && !s.ex.some((e) => e.text === text)) s.ex.push({ text, voice });
        }
    }
    const suspects = () => Object.keys(state.words).filter((w) => {
        const s = state.words[w];
        return (s.bad >= MIN_BAD ? s.bad >= s.ok : s.bad >= MIN_BAD_NEVER_RIGHT && s.ok === 0) && !state.fixes[w] && !state.rejected[w] && !state.tried[w];
    });

    // How many of the clips say the word right when it is written as `spelling`.
    async function score(word, spelling, examples) {
        let right = 0;
        let heard = 0;
        await Promise.all(examples.flatMap((ex) => Object.values(VOICES).map(async (voice) => {
            const text = ex.text.split(word).join(spelling);
            const r = await hear(text, voice);
            if (!r.success) return;
            const ranges = edgeMistakes(text, r.edgeHeard, r.googleHeard);
            if (!ranges) return;
            heard++;
            const at = text.indexOf(spelling);
            if (!ranges.some(([a, b]) => a < at + spelling.length && at < b)) right++;
        })));
        return { right, heard };
    }
    async function tryFix(word) {
        const examples = state.words[word].ex.slice(0, EXAMPLES);
        state.tried[word] = Date.now();
        const base = await score(word, word, examples);
        let best = null;
        for (const spelling of respellings(word)) {
            const s = await score(word, spelling, examples);
            if (!best || s.right > best.right) best = { spelling, ...s };
        }
        if (best && best.right >= base.right + MIN_GAIN && best.right >= Math.ceil(MIN_SHARE * best.heard)) {
            state.fixes[word] = { said: best.spelling, score: `${best.right}/${best.heard}`, before: `${base.right}/${base.heard}`, at: Date.now() };
            log(`[Pronunciation] ${word} -> ${best.spelling} (right in ${best.right}/${best.heard} clips, as written ${base.right}/${base.heard})`);
        }
        save(true);
    }

    async function run() {
        if (running) { again = true; return; }
        if (!state.enabled || !available()) return;
        running = true;
        clearTimeout(idleTimer);
        status.busy = true;
        status.error = null;
        try {
            do {
                again = false;
                const queue = linesToCheck();
                let failures = 0;
                const next = () => queue.next();
                const lane = async () => {
                    for (let it = next(); !it.done && state.enabled; it = next()) {
                        const { text, voice, key } = it.value;
                        const r = await hear(text, voice);
                        if (!r.success) {
                            if (++failures >= 10) throw new Error(r.error || 'Edge, Google or the recogniser keeps failing');
                            continue;
                        }
                        failures = 0;
                        state.lines[key] = 1;
                        const judged = judgeLine(text, r.edgeHeard, r.googleHeard);
                        if (judged) count(text, voice, judged);
                        save();
                        for (const w of suspects()) await tryFix(w);
                    }
                };
                await Promise.all(Array.from({ length: LINES_AT_ONCE }, lane));
                save(true);
            } while (again && state.enabled);
        } catch (e) {
            status.error = e.message;
            log(`[Pronunciation] Paused: ${e.message}`);
            save(true);
        } finally {
            running = false;
            status.busy = false;
            idleTimer = setTimeout(stopWorker, IDLE_STOP_MS);
            idleTimer.unref();
        }
    }

    return {
        run,
        kick: () => { run().catch(() => { }); },
        status: () => ({
            enabled: state.enabled,
            available: available(),
            busy: status.busy,
            device: status.device,
            error: status.error,
            linesChecked: Object.keys(state.lines).length,
            wordsKnown: Object.keys(state.words).length,
            fixes: Object.entries(state.fixes).map(([written, f]) => ({ written, ...f })),
        }),
        setEnabled(on) {
            state.enabled = !!on;
            save(true);
            if (state.enabled) this.kick(); else stopWorker();
        },
        // The user took a fix off the list: never added again.
        reject(written) {
            if (!state.fixes[written]) return false;
            delete state.fixes[written];
            state.rejected[written] = Date.now();
            save(true);
            return true;
        },
        stop: stopWorker,
    };
}

module.exports = { createPronunciationChecker, outline, align, similarity, edgeMistakes, judgeLine, words, respellings };
