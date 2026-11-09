// A dubbed line that covers several subtitles with a pause between them is said in one go by the
// voice, from the line's start - and is then silent while the actor goes on after the pause.
// Measured 2026-11-09 on a whole series export (18 pieces, 2:05:20): 74 subtitles silent that
// way, e.g. "什么东西? (pause) 石头? (pause) 活的?" over 9 s, the Khmer said in its first 2.5 s.
// Such a line is cut where the subtitles have a gap (a real pause - most subtitle changes are
// back to back, and cutting at those made the sync worse, see 2026-10-24): Gemini splits the
// line's Khmer into the parts, keeping its words, and each part is voiced at its own subtitle.

const SPLIT_RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            id: { type: 'STRING' },
            parts: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['id', 'parts']
    }
};

// items: [{ id, line (the dubbed text), original (what the line says in the original language),
// parts: [what each part's subtitles say, in order] }]
function buildSplitLinesPrompt({ items, targetLanguage = 'Khmer' }) {
    const list = items.map((it) => ({
        id: String(it.id),
        dubbed: String(it.line || ''),
        original: String(it.original || ''),
        parts: (it.parts || []).map((p) => String(p || '')),
    }));
    return `You are dubbing a drama into ${targetLanguage}. Each item is one dubbed line ("dubbed") for something a character says in several parts with pauses between them; "parts" are the subtitles of each part, in the original language, in order.

YOUR TASK, for every item: split "dubbed" into exactly as many parts as "parts", in the same order, so each part says what its subtitle says. Use the words of "dubbed": do not translate again, do not add or leave out anything. Only where a part cannot stand alone may you move or repeat a word. Every part must have text, in ${targetLanguage} only.

ITEMS:
${JSON.stringify(list)}

OUTPUT FORMAT:
Return ONLY a JSON array, one object per item: [{ "id": "<same id>", "parts": ["...", "..."] }]`;
}

// The parts, or null: the wrong number, an empty part, or a split that rewrote the line (its
// parts together much shorter or longer than the line).
function checkSplitLine(answer, item, { isKhmer = true } = {}) {
    if (!answer || !item || !Array.isArray(answer.parts)) return null;
    const parts = answer.parts.map((p) => (typeof p === 'string' ? p.trim() : ''));
    if (parts.length !== (item.parts || []).length || parts.length < 2) return null;
    if (parts.some((p) => !p || (isKhmer && !/[ក-៿]/.test(p)))) return null;
    const letters = (t) => String(t || '').replace(/[\s.,!?។៕៖?!،、，。]/g, '').length;
    const was = letters(item.line), now = parts.reduce((n, p) => n + letters(p), 0);
    if (!was || now < 0.8 * was || now > 1.25 * was) return null;
    return parts;
}

module.exports = { SPLIT_RESPONSE_SCHEMA, buildSplitLinesPrompt, checkSplitLine };
