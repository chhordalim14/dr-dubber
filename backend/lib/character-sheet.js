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
const MAX_ALIASES = 8;
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
                    role: { type: 'STRING' },
                    aliases: { type: 'ARRAY', items: { type: 'STRING' } }
                },
                required: ['name', 'khmer', 'gender'],
                propertyOrdering: ['name', 'khmer', 'gender', 'role', 'aliases']
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
        const aliases = [...new Set((Array.isArray(c.aliases) ? c.aliases : []).map(a => str(a).slice(0, 60)))]
            .filter(a => a && a !== name && !/^[?？]+$/.test(a)).slice(0, MAX_ALIASES);
        sheet.characters.push({ name, khmer, gender, ...(role ? { role } : {}), ...(aliases.length ? { aliases } : {}) });
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
// episode only adds what was not there yet, and other spellings of someone already listed.
function mergeSheets(known, fresh) {
    const a = normalizeSheet(known);
    const b = normalizeSheet(fresh);
    const freshAliases = new Map(b.characters.map(c => [c.name, c.aliases || []]));
    const names = new Set(a.characters.map(c => c.name));
    const pairs = new Set(a.address.map(x => `${x.speaker}\u0000${x.listener}`));
    const terms = new Set(a.terms.map(t => t.original));
    return foldSheet({
        characters: [
            ...a.characters.map(c => ({ ...c, aliases: [...(c.aliases || []), ...(freshAliases.get(c.name) || [])] })),
            ...b.characters.filter(c => !names.has(c.name))
        ],
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

// ── One person, several spellings ──
// Gemini wrote one character differently from part to part: a same-sounding character (陆宴辞 /
// 陆晏辞, 简微 / 简薇), the given name alone (晏辞), a made-up surname (苏心柔 for 心柔). Each spelling
// became a character of its own on the sheet, a cast entry of its own and a new voice in the next
// episode. A spelling the sheet lists as a character's alias (Gemini's), or a sheet name with one
// surname character in front, is that person; never across genders, never a shared title.
const HAN_RE = /^[㐀-鿿]+$/;
const isUnnamed = (n) => !n || /^[?？]+$/.test(n);
// 陆晏辞 = 晏辞 when 晏辞 is on the sheet. 老太太 is not 太太, 小婉 not 婉 (老/小/大/阿 are not surnames).
function withSurname(long, short) {
    return short.length >= 2 && long.length === short.length + 1 && long.endsWith(short)
        && HAN_RE.test(long) && !/^[老小大阿]/.test(long);
}

// sheet + the series' speakers list -> name => the name of its person (the one listed first: the
// sheet's before the speakers list's). A name nobody lists comes back as it is.
function seriesNameOf(sheet, speakers) {
    const s = normalizeSheet(sheet);
    const parent = new Map();
    const sex = new Map(); // root -> 'Male' / 'Female'
    const root = (n) => {
        while (parent.get(n) !== n) n = parent.get(n);
        return n;
    };
    const add = (name, gender) => {
        const n = str(name).slice(0, 60);
        if (isUnnamed(n) || isSharedTitle(n, s.characters)) return null;
        if (!parent.has(n)) parent.set(n, n);
        const r = root(n);
        if ((gender === 'Male' || gender === 'Female') && !sex.has(r)) sex.set(r, gender);
        return n;
    };
    const join = (a, b) => {
        if (!a || !b) return;
        const [ra, rb] = [root(a), root(b)];
        if (ra === rb || (sex.has(ra) && sex.has(rb) && sex.get(ra) !== sex.get(rb))) return;
        parent.set(rb, ra); // ra was added first: its name stays
        if (!sex.has(ra) && sex.has(rb)) sex.set(ra, sex.get(rb));
    };
    for (const c of s.characters) add(c.name, c.gender);
    for (const x of Array.isArray(speakers) ? speakers : []) add(x && x.name, x && x.gender);
    for (const c of s.characters) for (const a of c.aliases || []) join(c.name, add(a, c.gender));
    // The sheet's names and their spellings, each with a surname in front.
    const sheetNames = s.characters.flatMap(c => [c.name, ...(c.aliases || [])]).filter(n => parent.has(n));
    const all = [...parent.keys()];
    for (const short of sheetNames) for (const n of all) if (withSurname(n, short)) join(short, n);
    return (name) => {
        const n = str(name).slice(0, 60);
        if (parent.has(n)) return root(n);
        const short = sheetNames.find(x => withSurname(n, x)); // 陆晏辞, met for the first time
        return short ? root(short) : n;
    };
}

// The sheet with one entry per person: the other spellings become its aliases, forms of address
// between them use its name.
function foldSheet(sheet) {
    const s = normalizeSheet(sheet);
    const nameOf = seriesNameOf(s, []);
    const byName = new Map();
    for (const c of s.characters) {
        const main = byName.get(nameOf(c.name));
        if (!main) {
            byName.set(c.name, { ...c, aliases: [...(c.aliases || [])] });
            continue;
        }
        main.aliases.push(c.name, ...(c.aliases || []));
        if (!main.role && c.role) main.role = c.role;
    }
    return normalizeSheet({
        characters: [...byName.values()],
        address: s.address.map(x => ({ ...x, speaker: nameOf(x.speaker), listener: nameOf(x.listener) })),
        terms: s.terms
    });
}

// The series' speakers list with one entry per person: lines counted together, pictures kept.
function foldSpeakers(list, sheet) {
    const nameOf = seriesNameOf(sheet, list);
    const byName = new Map();
    for (const x of Array.isArray(list) ? list : []) {
        const name = nameOf(x && x.name);
        if (isUnnamed(name)) continue;
        const main = byName.get(name);
        if (!main) {
            byName.set(name, { ...x, name, frames: [...(x.frames || [])] });
            continue;
        }
        main.frames = [...new Set([...main.frames, ...(x.frames || [])])];
        if (x.lines) main.lines = (main.lines || 0) + x.lines;
        if (main.gender === 'Unknown' && x.gender) main.gender = x.gender;
    }
    return [...byName.values()];
}

function formatSheetForPrompt(sheet) {
    const s = foldSheet(sheet);
    if (!sheetSize(s)) return '';
    const out = ['\n\nCHARACTER SHEET (the same for the whole series - write these names exactly so, and keep these forms of address in every line unless the relationship visibly changes; a person "also written" another way is still written with the name before "="):'];
    if (s.characters.length) {
        out.push('Names:');
        for (const c of s.characters) {
            if (isSharedTitle(c.name, s.characters)) continue;
            const aliases = (c.aliases || []).filter(a => !isSharedTitle(a, s.characters));
            out.push(`- ${c.name} = ${c.khmer} (${c.gender}${c.role ? `, ${c.role}` : ''}${aliases.length ? `; also written ${aliases.join(', ')}` : ''})`);
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
- "characters": every named character who speaks or is talked about (at most ${MAX_CHARACTERS}): "name" exactly as written in the original dialogue (the shortest form, e.g. 林峰 not 林峰哥哥), "khmer" the Khmer spelling to use (a natural Khmer transliteration; when the Khmer lines already spell the name, copy that spelling exactly), "gender" Male / Female / Unknown, "role" 1-4 English words (e.g. "emperor", "heroine's maid"), "aliases" the other ways the dialogue writes THE SAME person (a same-sounding character such as 陆宴辞 for 陆晏辞, the given name alone, a title only they hold; usually none). One person is ONE entry: never list another spelling of someone as a character of their own.
- "address": for characters who talk to each other (at most ${MAX_ADDRESS} pairs): "speaker" and "listener" (names as in "characters"), "calls" the Khmer word the speaker uses for the listener, "self" the Khmer word the speaker uses for themself. Choose them by the relationship:
${KHMER_FORMS_OF_ADDRESS}
- "terms": recurring named places, sects, clans, companies, titles, techniques or items (at most ${MAX_TERMS}): "original" exactly as written, "khmer" the Khmer to use.

Only include what the dialogue supports. Do not list generic words (师父, 老板, boss) as names. A surname with a title (韩总, 王董, 李队) is not a character of its own when it can be someone already listed (韩总 is 韩峥 at work, his brother, or their father): list the person; one known only by the title (陈总) is listed by it. A family member who speaks but is never named is listed by role (韩父, 韩母).${knownText ? `\n\nALREADY DECIDED in earlier episodes - keep these exactly as they are and list only what is new. A new spelling of someone already decided is not new: return that person (their name as decided) with the spelling in "aliases". If two names decided below are one person, return the first with the other in its "aliases".${knownText}` : ''}${glossaryHint}

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

// Over the cap, those who said least are let go (not the first ones: they are the main cast).
const keptSpeakers = (list) => (list.length <= MAX_SPEAKERS ? list
    : list.filter(x => [...list].sort((a, b) => (b.lines || 0) - (a.lines || 0)).slice(0, MAX_SPEAKERS).includes(x)));

function saveSeriesSpeakers(dir, sourceFilePath, list) {
    const file = speakersFile(dir, sourceFilePath);
    if (!file) return;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(keptSpeakers(list)), 'utf8');
    fs.renameSync(tmp, file);
}

// cues: Transcribe's lines ({ speaker, gender }). Every person it named is kept (once, by the
// name of their person: seriesNameOf), "?" and shared titles left out, with the lines they said
// in all episodes (lines: the cast pictures Gemini sees go to those who talk most); a name's
// cast pictures are added by the caller (frames). Returns the list as saved.
function addSeriesSpeakers(dir, sourceFilePath, cues, sheet) {
    if (!speakersFile(dir, sourceFilePath)) return [];
    const s = normalizeSheet(sheet);
    const list = foldSpeakers(loadSeriesSpeakers(dir, sourceFilePath), s);
    const nameOf = seriesNameOf(s, list);
    const have = new Map(list.map(x => [x.name, x]));
    const votes = new Map();
    for (const c of cues || []) {
        const name = nameOf(str(c && c.speaker).slice(0, 60));
        if (isUnnamed(name) || isSharedTitle(name, s.characters)) continue;
        const v = votes.get(name) || { Male: 0, Female: 0, lines: 0 };
        if (c.gender === 'Male' || c.gender === 'Female') v[c.gender]++;
        v.lines++;
        votes.set(name, v);
    }
    if (!votes.size) return list;
    for (const [name, v] of votes) {
        const known = have.get(name);
        if (known) known.lines = (known.lines || 0) + v.lines;
        else list.push({ name, gender: v.Male === v.Female ? 'Unknown' : v.Male > v.Female ? 'Male' : 'Female', lines: v.lines });
    }
    saveSeriesSpeakers(dir, sourceFilePath, list);
    return keptSpeakers(list);
}

// The names not on the sheet (the sheet lists its own): roles an earlier episode gave (父亲, 助理).
function formatSpeakersForPrompt(list, sheet) {
    const s = normalizeSheet(sheet);
    const nameOf = seriesNameOf(s, list);
    const onSheet = new Set(s.characters.map(c => nameOf(c.name)));
    const rest = foldSpeakers(list, s).filter(x => !onSheet.has(x.name));
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
    seriesNameOf,
    foldSheet,
    foldSpeakers,
    addSeriesSpeakers,
    formatSpeakersForPrompt,
    castDir,
    withSeriesLock
};
