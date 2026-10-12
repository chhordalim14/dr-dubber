// Small text rules shared by server.js and its tests.

// Another script leaked into a Khmer line (e.g. "នាងចង់បាន صحن ធំជាងនេះ": Gemini slipped an
// Arabic word in), or Chinese was left untranslated. Latin is allowed (names, "OK").
// Hebrew/Arabic/Syriac, Cyrillic, Indic, Thai, Lao, Myanmar, kana, CJK, Hangul.
const FOREIGN_SCRIPT_CLASS = '\\u0590-\\u08FF\\u0400-\\u04FF\\u0900-\\u0DFF\\u0E00-\\u0EFF\\u1000-\\u109F\\u3040-\\u30FF\\u3400-\\u9FFF\\uF900-\\uFAFF\\uAC00-\\uD7AF';
const FOREIGN_SCRIPT_RE = new RegExp(`[${FOREIGN_SCRIPT_CLASS}]`);
const FOREIGN_SCRIPT_RUN_RE = new RegExp(`[${FOREIGN_SCRIPT_CLASS}]+`, 'g');
const KHMER_CHAR_RE = /[ក-៿]/;

// Latin that is not a name or "OK" (both plain ASCII, kept): a word with accented letters (a
// Vietnamese "chê" for 嫌, or French), or lowercase Latin glued onto Khmer - a leaked chat
// role such as "ម៉ែuser" where 丈母娘 should have been translated.
const LATIN_LETTERS = 'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF';
const ACCENTED_LATIN = '\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF';
const LEAKED_LATIN_SRC = `[${LATIN_LETTERS}]*[${ACCENTED_LATIN}][${LATIN_LETTERS}]*|(?<=[\\u1780-\\u17FF])[a-z]{2,}|[a-z]{2,}(?=[\\u1780-\\u17FF])`;
const LEAKED_LATIN_RE = new RegExp(LEAKED_LATIN_SRC);
const LEAKED_LATIN_RUN_RE = new RegExp(LEAKED_LATIN_SRC, 'g');

// A Khmer line that carries another language's word (re-translated, else stripped).
function hasForeignText(text) {
    const t = String(text || '');
    return FOREIGN_SCRIPT_RE.test(t) || LEAKED_LATIN_RE.test(t);
}

// Drops the foreign words from a Khmer line (the rest of the line stays).
function stripForeignScript(text) {
    return String(text || '').replace(FOREIGN_SCRIPT_RUN_RE, ' ').replace(LEAKED_LATIN_RUN_RE, ' ').replace(/\s{2,}/g, ' ').trim();
}

// Collapse a repeated identical part suffix (name_part1_part1 -> name_part1). Different numbers
// are kept: "series_part01_part06" is piece 6 of part 1, and must not overwrite piece 1.
function collapseRepeatedPartSuffix(name) {
    return String(name).replace(/([_.\- ](?:part|pt|chunk)\s*0*(\d+))(?:[_.\- ](?:part|pt|chunk)\s*0*\2)+$/i, '$1');
}

// tts_generator.py arguments. `--flag=value` form: argparse rejects a separate value that
// starts with '-' (a rate of "-10%", or a line of dialogue like "- Hello").
function buildTtsArgv({ script, text, voice, rate, pitch, volume, output }) {
    return [script, `--text=${text}`, `--voice=${voice}`, `--rate=${rate}`, `--pitch=${pitch}`, `--volume=${volume}`, `--output=${output}`];
}

module.exports = { FOREIGN_SCRIPT_RE, FOREIGN_SCRIPT_RUN_RE, KHMER_CHAR_RE, hasForeignText, stripForeignScript, collapseRepeatedPartSuffix, buildTtsArgv };
