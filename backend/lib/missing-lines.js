// Every subtitle the video shows gets a voice. Gemini, hearing a tab, misses about 2% of the
// lines its burned-in subtitles show (measured over 21 tabs: short calls - 啊, 嗯, a name called -
// and short lines - 她有律师函); with the actor's voice taken out of the export, those were
// silent. Match Subtitles to Video finds them (centred in the subtitle row, no line of the
// transcription over them; ScreenSync.uncoveredLines leaves out the chat bubbles and signs) with
// what they say; here Gemini translates each with the lines around it and says who speaks. It
// does not decide whether to voice one: asked that, it skipped a line a man says on screen
// ("Carson下午的时间") on one try and voiced it on the next.

const EMOTIONS = ['Neutral', 'Angry', 'Sad', 'Whisper', 'Excited', 'Royal', 'Romantic', 'Fear'];

const MISSING_RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            id: { type: 'STRING' },
            text: { type: 'STRING' },
            gender: { type: 'STRING', enum: ['Male', 'Female'] },
            emotion: { type: 'STRING', enum: EMOTIONS }
        },
        required: ['id', 'text', 'gender']
    }
};

// items: [{ id, onScreen, seconds, before: [{ onScreen, line, gender }], after: [...] }]
function buildMissingLinesPrompt({ items, targetLanguage = 'Khmer', registerGuidance = '', glossaryHint = '' }) {
    const lines = items.map((it) => ({
        id: String(it.id),
        onScreen: String(it.onScreen || ''),
        seconds: Number((Number(it.seconds) || 0).toFixed(2)),
        before: (it.before || []).map((b) => ({ onScreen: b.onScreen || '', dubbed: b.line || '', gender: b.gender || '' })),
        after: (it.after || []).map((b) => ({ onScreen: b.onScreen || '', dubbed: b.line || '', gender: b.gender || '' })),
    }));
    return `You are dubbing a drama into ${targetLanguage}. Each item below is a subtitle the video shows ("onScreen", in the original language, for "seconds") for something a character says or calls out, that has no dubbed line yet: a line (also with a name in Latin letters), a name being called (also again and again: "花花花花" is someone calling 花花), or a short "啊" / "嗯" / "哼" / laugh. "before" and "after" are the lines around it, already dubbed, with who said them.

YOUR TASK, for every item (each one is spoken - give every one a line):
1. "text": what the character says, in natural spoken ${targetLanguage}, short enough to say in "seconds" (a call or a sound stays one short word: អូ, អឺ, ហឹម, ហាហា...). Keep names and forms of address as the lines around it use them.
2. "gender": "Male" or "Female" - who says it, worked out from the lines around it (who is talking to whom).
3. "emotion": one of ${EMOTIONS.join(', ')}.
Write "text" in ${targetLanguage} only.${registerGuidance}${glossaryHint}

ITEMS:
${JSON.stringify(lines)}

OUTPUT FORMAT:
Return ONLY a JSON array, one object per item: [{ "id": "<same id>", "text": "...", "gender": "Male|Female", "emotion": "..." }]`;
}

// One answer, or null when it has no usable text or gender.
function checkMissingLine(answer, { isKhmer = true } = {}) {
    if (!answer) return null;
    const text = typeof answer.text === 'string' ? answer.text.trim() : '';
    if (!text || (isKhmer && !/[ក-៿]/.test(text))) return null;
    const gender = answer.gender === 'Female' ? 'Female' : answer.gender === 'Male' ? 'Male' : null;
    if (!gender) return null;
    return { id: String(answer.id), text, gender, emotion: EMOTIONS.includes(answer.emotion) ? answer.emotion : 'Neutral' };
}

module.exports = { MISSING_RESPONSE_SCHEMA, buildMissingLinesPrompt, checkMissingLine };
