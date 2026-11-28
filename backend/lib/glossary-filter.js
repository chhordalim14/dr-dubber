// The Character Glossary is one list for every drama the user has dubbed ("Make names consistent"
// adds each part's names to it), so it grew to thousands of names, and every request sent all of
// them as "STRICTLY USE". A name from another drama taught Gemini the wrong spelling (苏苏 =
// ស៊ូស៊ូ became the hero 沈奕 = ស៊ូស៊ូ), and everyday words saved as names (小心 = សៀវស៊ីង,
// 见 = ចៀនលីង, 晚 = វ៉ាន់វ៉ាន់) were forced into lines where they are just words.
//
// So a request gets only the glossary names it can use: the ones its own original-language text
// contains, or - when there is no text yet (Transcribe hears audio) - the ones on this drama's
// character sheet. Single characters and everyday words are never sent.

const HAN = /[㐀-鿿]/;
const HAN_ONLY = /^[㐀-鿿]+$/;

// Everyday words and kinship / polite terms: how to say them depends on who is talking to whom
// (the forms-of-address rules), so a fixed glossary spelling only gets in the way.
const EVERYDAY_WORDS = new Set([
    '小心', '先生', '小姐', '夫人', '太太', '女士', '老板', '老公', '老婆', '师父', '师傅', '老师',
    '爸', '妈', '爸爸', '妈妈', '爹', '娘', '爷爷', '奶奶', '外公', '外婆', '叔', '叔叔', '婶', '婶婶',
    '哥', '姐', '弟', '妹', '哥哥', '姐姐', '弟弟', '妹妹', '大哥', '二哥', '三哥', '大姐', '二姐',
    '三姐', '大妹', '小妹', '小弟', '姑娘', '少爷', '公子', '儿子', '女儿', '孩子', '宝贝'
]);

// Request fields that never hold dialogue (keys, ids, paths, audio).
const NOT_TEXT = new Set([
    'glossary', 'apiKey', 'apiKeys', 'lastResortKeys', 'model', 'requestId', 'audioBase64', 'audioPath',
    'videoPath', 'sourceFilePath', 'videoName', 'mimeType'
]);
const MAX_TEXT_CHARS = 4 * 1024 * 1024;

const str = (v) => String(v == null ? '' : v).trim();

// { original: khmer } or [{ original, khmer }] / [{ from, to }] -> [[original, khmer]]
function glossaryPairs(glossary) {
    if (!glossary || typeof glossary !== 'object') return [];
    const raw = Array.isArray(glossary)
        ? glossary.map(g => [g && (g.original ?? g.from), g && (g.khmer ?? g.to)])
        : Object.entries(glossary);
    return raw.map(([o, k]) => [str(o), str(k)]).filter(([o, k]) => o && k);
}

// A glossary key worth sending: not one Chinese character (a surname, or 见 / 晚 / 市 that are
// parts of other words) and not an everyday word.
function isUsableGlossaryKey(original) {
    const o = str(original);
    if (!o) return false;
    if (HAN_ONLY.test(o) && [...o].length < 2) return false;
    return !EVERYDAY_WORDS.has(o);
}

// The original-language text a request carries (lines, SRT text, tabs ...), from any field
// that isn't a key, a path or audio.
function collectSourceText(body) {
    const out = [];
    let size = 0;
    const walk = (v, key, depth) => {
        if (size > MAX_TEXT_CHARS || depth > 8 || NOT_TEXT.has(key)) return;
        if (typeof v === 'string') {
            if (HAN.test(v)) { out.push(v); size += v.length; }
        } else if (Array.isArray(v)) {
            for (const x of v) walk(x, key, depth + 1);
        } else if (v && typeof v === 'object') {
            for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
        }
    };
    walk(body, '', 0);
    return out.join('\n');
}

// Every name and term on a character sheet (with the other ways it is written).
function sheetOriginals(sheet) {
    const names = new Set();
    if (!sheet) return names;
    for (const c of sheet.characters || []) {
        names.add(str(c.name));
        for (const a of c.aliases || []) names.add(str(a));
    }
    for (const t of sheet.terms || []) names.add(str(t.original));
    names.delete('');
    return names;
}

// The glossary this request may use, as { original: khmer } - or null when none of it applies:
// the names its text contains, and this drama's names (so a name renamed in the glossary is
// renamed on the sheet too).
// text: the request's original-language text ('' when there is none yet).
// sheet: this drama's character sheet (or null).
function relevantGlossary(glossary, { text = '', sheet = null } = {}) {
    const onSheet = sheetOriginals(sheet);
    const out = {};
    for (const [original, khmer] of glossaryPairs(glossary)) {
        if (!isUsableGlossaryKey(original)) continue;
        if ((text && text.includes(original)) || onSheet.has(original)) out[original] = khmer;
    }
    return Object.keys(out).length ? out : null;
}

module.exports = { EVERYDAY_WORDS, glossaryPairs, isUsableGlossaryKey, collectSourceText, relevantGlossary };
