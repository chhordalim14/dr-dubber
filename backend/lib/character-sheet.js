// Character sheet: one short reference per series - each name's Khmer spelling, each character's
// gender, who calls whom what (បង/អូន, លោក ...) and recurring terms. It is read from the whole
// episode once, before translating, and every batch gets it, so names and forms of address no
// longer change between batches (parallel batches never saw each other's lines) or between
// episodes.
//
// Episodes of one series usually sit in one folder, so the sheet is saved per folder of the source
// video: episode 2 starts from episode 1's names and only adds the new ones.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { KHMER_FORMS_OF_ADDRESS } = require('./khmer-prompts');

const MAX_CHARACTERS = 60;
const MAX_ADDRESS = 60;
const MAX_TERMS = 40;
// The sheet only needs the cast and how they talk, so a very long movie is cut to this much
// dialogue (about 25k tokens of Chinese) instead of sending all of it.
const MAX_DIALOGUE_CHARS = 40000;

const GENDERS = ['Male', 'Female', 'Unknown'];

const CHARACTER_SHEET_SCHEMA = {
    type: 'OBJECT',
    properties: {
        characters: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    name: { type: 'STRING' },
                    khmer: { type: 'STRING' },
                    gender: { type: 'STRING', enum: GENDERS },
                    role: { type: 'STRING' }
                },
                required: ['name', 'khmer', 'gender'],
                propertyOrdering: ['name', 'khmer', 'gender', 'role']
            }
        },
        address: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    speaker: { type: 'STRING' },
                    listener: { type: 'STRING' },
                    calls: { type: 'STRING' },
                    self: { type: 'STRING' }
                },
                required: ['speaker', 'listener', 'calls', 'self'],
                propertyOrdering: ['speaker', 'listener', 'calls', 'self']
            }
        },
        terms: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: { original: { type: 'STRING' }, khmer: { type: 'STRING' } },
                required: ['original', 'khmer'],
                propertyOrdering: ['original', 'khmer']
            }
        }
    },
    required: ['characters', 'address', 'terms'],
    propertyOrdering: ['characters', 'address', 'terms']
};

const emptySheet = () => ({ characters: [], address: [], terms: [] });
const str = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const KHMER_RE = /[ក-៿]/;

// A model's answer (or a saved file) as a clean sheet: trimmed strings, Khmer where Khmer is
// expected, no duplicates, within the caps.
function normalizeSheet(raw) {
    const sheet = emptySheet();
    if (!raw || typeof raw !== 'object') return sheet;
    const seenNames = new Set();
    for (const c of Array.isArray(raw.characters) ? raw.characters : []) {
        const name = str(c && c.name);
        const khmer = str(c && c.khmer);
        if (!name || !KHMER_RE.test(khmer) || seenNames.has(name)) continue;
        seenNames.add(name);
        const gender = GENDERS.includes(c.gender) ? c.gender : 'Unknown';
        const role = str(c.role).slice(0, 40);
        sheet.characters.push({ name, khmer, gender, ...(role ? { role } : {}) });
    }
    const seenPairs = new Set();
    for (const a of Array.isArray(raw.address) ? raw.address : []) {
        const speaker = str(a && a.speaker);
        const listener = str(a && a.listener);
        const calls = str(a && a.calls);
        const self = str(a && a.self);
        const pair = `${speaker}\u0000${listener}`;
        if (!speaker || !listener || speaker === listener || !KHMER_RE.test(calls + self) || seenPairs.has(pair)) continue;
        seenPairs.add(pair);
        sheet.address.push({ speaker, listener, calls, self });
    }
    const seenTerms = new Set();
    for (const t of Array.isArray(raw.terms) ? raw.terms : []) {
        const original = str(t && t.original);
        const khmer = str(t && t.khmer);
        if (!original || !KHMER_RE.test(khmer) || seenTerms.has(original) || seenNames.has(original)) continue;
        seenTerms.add(original);
        sheet.terms.push({ original, khmer });
    }
    sheet.characters = sheet.characters.slice(0, MAX_CHARACTERS);
    sheet.address = sheet.address.slice(0, MAX_ADDRESS);
    sheet.terms = sheet.terms.slice(0, MAX_TERMS);
    return sheet;
}

// Earlier episodes win: a spelling or a form of address already used stays the same. The new
// episode only adds what was not there yet.
function mergeSheets(known, fresh) {
    const a = normalizeSheet(known);
    const b = normalizeSheet(fresh);
    const names = new Set(a.characters.map(c => c.name));
    const pairs = new Set(a.address.map(x => `${x.speaker}\u0000${x.listener}`));
    const terms = new Set(a.terms.map(t => t.original));
    return normalizeSheet({
        characters: [...a.characters, ...b.characters.filter(c => !names.has(c.name))],
        address: [...a.address, ...b.address.filter(x => !pairs.has(`${x.speaker}\u0000${x.listener}`))],
        terms: [...a.terms, ...b.terms.filter(t => !terms.has(t.original))]
    });
}

const sheetSize = (s) => (s ? s.characters.length + s.address.length + s.terms.length : 0);

// The Character Glossary is the user's word (Dub Whole Series' "Make names consistent" saves to it
// after every part), so a name it has is spelled its way in the sheet too - the sheet may still
// hold the spelling an episode used before the names were unified.
// glossary: { original: khmer } or [{ original, khmer }] / [{ from, to }].
function applyGlossaryToSheet(sheet, glossary) {
    const s = normalizeSheet(sheet);
    const fixed = new Map();
    const entries = Array.isArray(glossary) ? glossary.map(g => [g && (g.original ?? g.from), g && (g.khmer ?? g.to)])
        : glossary && typeof glossary === 'object' ? Object.entries(glossary) : [];
    for (const [original, khmer] of entries) {
        if (str(original) && KHMER_RE.test(str(khmer))) fixed.set(str(original), str(khmer));
    }
    if (!fixed.size) return s;
    s.characters = s.characters.map(c => (fixed.has(c.name) ? { ...c, khmer: fixed.get(c.name) } : c));
    s.terms = s.terms.map(t => (fixed.has(t.original) ? { ...t, khmer: fixed.get(t.original) } : t));
    return s;
}

// The sheet as the few compact lines every translate batch gets.
// A surname with a title (韩总, 王董) while someone else of that surname is listed: it can be
// any of them, so Transcribe used it as a speaker name for a father in one episode and his son in
// the next (one voice for both). Sheets saved before the builder was told so still have them.
const TITLES = /^(.)(总|董|董事长|总裁|经理|队|局|老板|少|爷)$/;
function isSharedTitle(name, characters) {
    const m = TITLES.exec(String(name || ''));
    return !!m && characters.some((c) => c.name !== name && c.name.startsWith(m[1]) && !TITLES.test(c.name));
}

function formatSheetForPrompt(sheet) {
    const s = normalizeSheet(sheet);
    if (!sheetSize(s)) return '';
    const out = ['\n\nCHARACTER SHEET (the same for the whole series - write these names exactly so, and keep these forms of address in every line unless the relationship visibly changes):'];
    if (s.characters.length) {
        out.push('Names:');
        for (const c of s.characters) {
            if (isSharedTitle(c.name, s.characters)) continue;
            out.push(`- ${c.name} = ${c.khmer} (${c.gender}${c.role ? `, ${c.role}` : ''})`);
        }
    }
    if (s.address.length) {
        out.push('Forms of address (speaker -> listener: calls them / calls self):');
        for (const x of s.address) {
            if (isSharedTitle(x.speaker, s.characters) || isSharedTitle(x.listener, s.characters)) continue;
            out.push(`- ${x.speaker} -> ${x.listener}: ${x.calls} / ${x.self}`);
        }
    }
    if (s.terms.length) {
        out.push('Terms:');
        for (const t of s.terms) out.push(`- ${t.original} = ${t.khmer}`);
    }
    return out.join('\n');
}

// lines: [{ text, gender?, khmer? }] - the original dialogue, and the Khmer already used for it
// when there is some (after a Direct transcription).
function buildCharacterSheetPrompt({ lines, known, glossaryHint = '' }) {
    let budget = MAX_DIALOGUE_CHARS;
    const dialogue = [];
    for (const l of lines || []) {
        const text = str(l && l.text);
        if (!text) continue;
        const row = `${l.gender ? `[${l.gender}] ` : ''}${text}${l.khmer ? ` => ${str(l.khmer)}` : ''}`;
        if ((budget -= row.length + 1) < 0) break;
        dialogue.push(row);
    }
    const knownText = formatSheetForPrompt(known);
    return `You prepare the character sheet for dubbing a drama into Khmer, so that every translator working on it writes the same names and uses the same forms of address.

Read the dialogue below. Each line is the original-language dialogue; [Male]/[Female] is the speaker's gender heard in the audio, and "=> ..." is the Khmer already used for that line, when there is one.

Return a JSON object with:
- "characters": every named character who speaks or is talked about (at most ${MAX_CHARACTERS}): "name" exactly as written in the original dialogue (the shortest form, e.g. 林峰 not 林峰哥哥), "khmer" the Khmer spelling to use (a natural Khmer transliteration; when the Khmer lines already spell the name, copy that spelling exactly), "gender" Male / Female / Unknown, "role" 1-4 English words (e.g. "emperor", "heroine's maid").
- "address": for characters who talk to each other (at most ${MAX_ADDRESS} pairs): "speaker" and "listener" (names as in "characters"), "calls" the Khmer word the speaker uses for the listener, "self" the Khmer word the speaker uses for themself. Choose them by the relationship:
${KHMER_FORMS_OF_ADDRESS}
- "terms": recurring named places, sects, clans, companies, titles, techniques or items (at most ${MAX_TERMS}): "original" exactly as written, "khmer" the Khmer to use.

Only include what the dialogue supports. Do not list generic words (师父, 老板, boss) as names. A surname with a title (韩总, 王董, 李队) is not a character of its own when it can be someone already listed (韩总 is 韩峥 at work, his brother, or their father): list the person; one known only by the title (陈总) is listed by it. A family member who speaks but is never named is listed by role (韩父, 韩母).${knownText ? `\n\nALREADY DECIDED in earlier episodes - keep these exactly as they are and list only what is new:${knownText}` : ''}${glossaryHint}

DIALOGUE:
${dialogue.join('\n')}`;
}

// ── Saved per series (the folder of the source video) ──
// Dub Whole Series splits each joined part into "<series>/DR Dubber Joined/DR Dubber Split/", but
// opens a short part as the joined file itself - both belong to the joined folder's sheet.
const SPLIT_FOLDER = 'DR Dubber Split';
function sheetFile(dir, sourceFilePath) {
    if (!dir || !sourceFilePath || typeof sourceFilePath !== 'string') return null;
    let folder = path.resolve(path.dirname(sourceFilePath));
    if (path.basename(folder).toLowerCase() === SPLIT_FOLDER.toLowerCase()) folder = path.dirname(folder);
    const id = crypto.createHash('sha1').update(process.platform === 'win32' ? folder.toLowerCase() : folder).digest('hex');
    return path.join(dir, `${id}.json`);
}

function loadSeriesSheet(dir, sourceFilePath) {
    const file = sheetFile(dir, sourceFilePath);
    if (!file) return null;
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        const sheet = normalizeSheet(saved && saved.sheet);
        return sheetSize(sheet) ? sheet : null;
    } catch (e) {
        return null; // none yet, or a half-written file
    }
}

function saveSeriesSheet(dir, sourceFilePath, sheet) {
    const file = sheetFile(dir, sourceFilePath);
    const clean = normalizeSheet(sheet);
    if (!file || !sheetSize(clean)) return false;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ folder: path.dirname(path.resolve(sourceFilePath)), savedAt: Date.now(), sheet: clean }), 'utf8');
    fs.renameSync(tmp, file); // never leaves a half-written sheet behind
    return true;
}

// ── Speakers already given a voice in the series ──
// Transcribe names each line's speaker; one not on the sheet gets a role (父亲, 陈总, 助理) that the
// next episode named again differently (父亲 in E46, 韩父 in E47: two voices for one father).
// The names an episode used are kept beside the sheet and shown to the next one, to reuse.
const MAX_SPEAKERS = 40;
const speakersFile = (dir, sourceFilePath) => {
    const file = sheetFile(dir, sourceFilePath);
    return file && file.replace(/\.json$/, '.speakers.json');
};

function loadSeriesSpeakers(dir, sourceFilePath) {
    try {
        const list = JSON.parse(fs.readFileSync(speakersFile(dir, sourceFilePath), 'utf8'));
        return Array.isArray(list) ? list.filter(s => s && str(s.name)) : [];
    } catch (e) {
        return [];
    }
}

// The folder of a series' cast pictures (a frame of each named speaker while speaking).
const castDir = (dir, sourceFilePath) => {
    const file = sheetFile(dir, sourceFilePath);
    return file && file.replace(/\.json$/, '.cast');
};

function saveSeriesSpeakers(dir, sourceFilePath, list) {
    const file = speakersFile(dir, sourceFilePath);
    if (!file) return;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-MAX_SPEAKERS)), 'utf8');
    fs.renameSync(tmp, file);
}

// cues: Transcribe's lines ({ speaker, gender }). Every name it used is kept (once), "?" and
// shared titles left out; a name's cast pictures are added by the caller (frames). Returns the
// list as saved.
function addSeriesSpeakers(dir, sourceFilePath, cues, sheet) {
    if (!speakersFile(dir, sourceFilePath)) return [];
    const s = normalizeSheet(sheet);
    const list = loadSeriesSpeakers(dir, sourceFilePath);
    const have = new Set(list.map(x => x.name));
    const votes = new Map();
    for (const c of cues || []) {
        const name = str(c && c.speaker).slice(0, 60);
        if (!name || /^[?？]+$/.test(name) || have.has(name) || isSharedTitle(name, s.characters)) continue;
        const v = votes.get(name) || { Male: 0, Female: 0 };
        if (c.gender === 'Male' || c.gender === 'Female') v[c.gender]++;
        votes.set(name, v);
    }
    if (!votes.size) return list;
    for (const [name, v] of votes) list.push({ name, gender: v.Male === v.Female ? 'Unknown' : v.Male > v.Female ? 'Male' : 'Female' });
    saveSeriesSpeakers(dir, sourceFilePath, list);
    return list.slice(-MAX_SPEAKERS);
}

// The names not on the sheet (the sheet lists its own): roles an earlier episode gave (父亲, 助理).
function formatSpeakersForPrompt(list, sheet) {
    const onSheet = new Set(normalizeSheet(sheet).characters.map(c => c.name));
    const rest = (Array.isArray(list) ? list : []).filter(x => !onSheet.has(x.name));
    if (!rest.length) return '';
    return `\n\nSPEAKERS ALREADY VOICED IN EARLIER EPISODES (not on the sheet): when one of these people speaks, write exactly this name as "speaker" again:\n${rest.map(x => `- ${x.name} (${x.gender})`).join('\n')}`;
}

// Episodes of one series translated at the same time take turns on the sheet, so episode 2 starts
// from what episode 1 decided instead of both inventing their own spellings.
const seriesLocks = new Map(); // sheet file -> promise of the last holder
async function withSeriesLock(dir, sourceFilePath, fn) {
    const file = sheetFile(dir, sourceFilePath);
    if (!file) return fn();
    const prev = seriesLocks.get(file) || Promise.resolve();
    let release;
    const mine = new Promise(r => { release = r; });
    const chained = prev.then(() => mine);
    seriesLocks.set(file, chained);
    await prev;
    try {
        return await fn();
    } finally {
        release();
        if (seriesLocks.get(file) === chained) seriesLocks.delete(file);
    }
}

module.exports = {
    CHARACTER_SHEET_SCHEMA,
    normalizeSheet,
    mergeSheets,
    sheetSize,
    applyGlossaryToSheet,
    formatSheetForPrompt,
    buildCharacterSheetPrompt,
    loadSeriesSheet,
    saveSeriesSheet,
    loadSeriesSpeakers,
    saveSeriesSpeakers,
    addSeriesSpeakers,
    formatSpeakersForPrompt,
    castDir,
    withSeriesLock
};
