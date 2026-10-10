// Khmer dubbing prompt text shared by the transcribe, translate, refactor and condense
// endpoints in server.js, kept here so tests can check the rules don't contradict each other.

// Spoken Khmer pace a dub line is sized to. Edge km-KH voices actually speak about 5-6
// syllables per second, so 4.5 leaves room for a natural pace without speeding the voice up.
const KHMER_SYLLABLES_PER_SEC = 4.5;

// "00:01:02,500" / "01:02.5" / "62.5" / 62.5 -> seconds (NaN when unreadable).
function toSeconds(val) {
    if (val === undefined || val === null || val === '') return NaN;
    if (typeof val === 'number') return val;
    const str = String(val).trim().replace(',', '.');
    if (!str.includes(':')) return parseFloat(str);
    return str.split(':').reduce((acc, p) => acc * 60 + (parseFloat(p) || 0), 0);
}

// Syllable budget for a line that lasts `seconds`; null when the duration is unknown.
function khmerMaxSyllables(seconds) {
    const s = Number(seconds);
    if (!(s > 0)) return null;
    return Math.max(2, Math.round(s * KHMER_SYLLABLES_PER_SEC));
}

// How long a subtitle line lasts, from whichever timing fields the caller sent:
// a fitted slot, the editor's textStart/textEnd, or plain start/end.
function lineSeconds(sub) {
    if (!sub) return null;
    const slot = parseFloat(sub.slotDuration);
    if (slot > 0) return slot;
    for (const [a, b] of [['textStart', 'textEnd'], ['start', 'end']]) {
        const d = toSeconds(sub[b]) - toSeconds(sub[a]);
        if (d > 0) return d;
    }
    return null;
}

// The pronoun carries the relationship in Khmer: a random pick between ឯង and បង makes a
// love scene sound like a quarrel, so the choice is spelled out by relationship.
const KHMER_FORMS_OF_ADDRESS = `2. FORMS OF ADDRESS (របៀបហៅគ្នា) - choose by the relationship, never at random:
   - Lovers / husband & wife (គូស្នេហ៍ ប្ដីប្រពន្ធ): he calls himself "បង" and her "អូន"; she calls herself "អូន" and him "បង".
   - Younger to older (ប្អូនទៅបង): calls them "បង", self "ខ្ញុំ" (or "ប្អូន"). Older to younger: "ប្អូន", self "បង".
   - To a boss, elder, stranger or superior (ថ្នាក់លើ អ្នកចាស់ទុំ អ្នកមិនស្គាល់): "លោក" (man), "លោកស្រី" / "អ្នកនាង" (woman); self "ខ្ញុំ" (polite: "ខ្ញុំបាទ" / "នាងខ្ញុំ").
   - Servant to master (អ្នកបម្រើទៅម្ចាស់): "លោកម្ចាស់" / "លោកប្រុស" / "អ្នកនាង".
   - Parents & children: "ម៉ាក់" / "ប៉ា" (modern) or "ម្ដាយ" / "ឪពុក", and "កូន". Grandparents "យាយ" / "តា", and "ចៅ".
   - Royal forms ("ព្រះអង្គ", "ទូលបង្គំ", "ក្រាបទូល") ONLY in a historical / palace register (or for gods and a heavenly court in fantasy).
   - "ឯង" / "អញ" / "ហ្អែង" ONLY for anger, fights, villains or very close same-age friends - never between lovers in a normal scene.
   - Keep each pair's choice for the whole scene unless their relationship changes.`;

const KHMER_DUBBING_RULES = `💎 NATURAL & READABLE KHMER DUBBING RULES (ខ្លឹម ងាយអាន ឥតទាក់ ដូចរឿងភាគទូរទស្សន៍):

1. LENGTH MATCHES THE ORIGINAL LINE (វែងខ្លីស្របនឹងសំដីដើម):
   - The Khmer line must take about as long to say as the original: about ${Math.floor(KHMER_SYLLABLES_PER_SEC)} to ${Math.ceil(KHMER_SYLLABLES_PER_SEC)} Khmer syllables per second of the line's duration (start to end).
   - A short line stays short. A long line keeps its full meaning in natural spoken Khmer. Never summarize content away, and never pad.
   - Say it the way people talk: no textbook sentences or multi-clause explanations.

${KHMER_FORMS_OF_ADDRESS}

3. ABSOLUTE BAN ON ROBOTIC & FORMAL TEXTBOOK WORDS (ហាមដាច់ខាតពាក្យអូសបន្លាយបែបសៀវភៅ):
   - 🚫 BAN "តើ..." at the beginning of questions (e.g. ❌ "តើបងធ្វើអ្វី?" -> ✅ "បងធ្វើអីហ្នឹង?").
   - 🚫 BAN unnecessary past tense "បាន..." (e.g. ❌ "ខ្ញុំបានដឹងហើយ" -> ✅ "ខ្ញុំដឹងហើយ").
   - 🚫 BAN continuous "កំពុងតែ..." (e.g. ❌ "កំពុងតែទៅ..." -> ✅ "កំពុងទៅ...").
   - 🚫 BAN possessive "របស់អ្នក / របស់ខ្ញុំ" (e.g. ❌ "ដៃរបស់អ្នក" -> ✅ "ដៃបង" / "ដៃអូន", per FORMS OF ADDRESS).
   - 🚫 BAN polite filler "សូមមេត្តា / សូម..." unless addressing kings or royal superiors.
   - 🚫 BAN word-for-word translation ("ចំពោះរឿងនេះ", "គឺជារឿងដែល", "ដើម្បីធ្វើការ", "មានការ...").

4. GOLDEN DUBBING REPLACEMENTS (គំរូពាក្យសន្ទនាភាពយន្ត):
   - ❌ "តើអ្នកកំពុងតែធ្វើអ្វីនៅទីនេះ?" -> ✅ "បងធ្វើអីនៅនេះ?" / angry: "ឯងធ្វើអីនៅនេះ?!"
   - ❌ "តើមានរឿងអ្វីបានកើតឡើងចំពោះអ្នក?" -> ✅ "មានរឿងអីកើតឡើង?"
   - ❌ "តើនេះជាការពិតមែនទេ?" -> ✅ "ពិតមែនហ្អេស?!" / "មែនអត់?"
   - ❌ "ខ្ញុំសូមអភ័យទោសដែលបានមកយឺត" -> ✅ "សុំទោស ខ្ញុំមកយឺត" / to a lover: "សុំទោស បងមកយឺត"
   - ❌ "កុំមានការព្រួយបារម្ភចំពោះខ្ញុំអី" -> ✅ "កុំបារម្ភពីខ្ញុំអី"
   - ❌ "តើអ្នកអាចប្រាប់ការពិតដល់ខ្ញុំបានទេ?" -> ✅ "ប្រាប់ការពិតមកបានទេ?"
   - ❌ "ខ្ញុំមិនអាចយល់ស្របនឹងរឿងនេះបានឡើយ" -> ✅ "រឿងនេះ ខ្ញុំមិនព្រមទេ!"
   - ❌ "សូមជួយសង្គ្រោះជីវិតខ្ញុំផង" -> ✅ "ជួយខ្ញុំផង!"
   - ❌ "តើឯងចង់ស្លាប់មែនទេ?" -> ✅ "ចង់ងាប់មែនទេ?!"
   - ❌ "ខ្ញុំនឹងមិនលើកលែងទោសឲ្យអ្នកឡើយ" -> ✅ "ខ្ញុំមិនលើកលែងឲ្យទេ!"
   - ❌ "តើអ្នកចង់មានន័យថាយ៉ាងដូចម្ដេច?" -> ✅ "ចង់មានន័យថាម៉េច?"
   - ❌ "កុំមកប៉ះពាល់រូបរាងកាយរបស់ខ្ញុំ" -> ✅ "កុំប៉ះខ្លួនខ្ញុំ!"
   - ❌ "តើពួកយើងគួរតែធ្វើបែបណាទៅ?" -> ✅ "យើងគួរធ្វើម៉េចទៅ?"
   - ❌ "សូមបិទមាត់របស់អ្នកភ្លាមទៅ" -> ✅ "បិទមាត់ទៅ!"
   - ❌ "ខ្ញុំមិនដែលគិតថាអ្នកជាមនុស្សបែបនេះសោះ" -> ✅ angry: "ស្មានមិនដល់ថាឯងជាមនុស្សចឹងសោះ!"
   - ❌ "តើអ្នកទៅណា?" -> ✅ "បងទៅណា?"
   - ❌ "ខ្ញុំស្រឡាញ់អ្នកខ្លាំងណាស់" -> ✅ "បងស្រឡាញ់អូនខ្លាំងណាស់" / "អូនស្រឡាញ់បងខ្លាំងណាស់"
   - ❌ "ហេតុអ្វីបានជាអ្នកធ្វើបែបនេះ?" -> ✅ "ហេតុអីធ្វើចឹង?"
   - ❌ "តើអ្នកសុខសប្បាយជាទេ?" -> ✅ "សុខសប្បាយទេ?" / "មិនអីទេហី?"
   - ❌ "ឆាប់ចេញពីទីនេះភ្លាម" -> ✅ "ចេញពីនេះភ្លាម!"

5. FLUID CONVERSATIONAL PARTICLES (ពាក្យបន្ថែមបែបសន្ទនាធម្មជាតិ):
   - Localize Asian particles (的, 了, 吧, 呢, 啊, 嘛) into natural colloquial Khmer ("ហ្នឹង", "ហើយ", "ចុះ", "មែនទេ", "ណា", "ហ្ហ៎ា", "អត់", "ហី", "ទៅ", "មក").

6. SUBTITLE LEGIBILITY & SPACING (អានស្រួល មើលច្បាស់):
   - Insert a clean standard space between grammatical clauses (e.g. "សុំទោស ខ្ញុំមកយឺត").
   - DO NOT insert zero-width characters (ZWSP). Ensure clean standard UTF-8 Khmer text.
   - Keep punctuation clean, minimal, and expressive (!, ?, ..., ?!).`;

function getKhmerDramaRegisterGuidance(genreRegister) {
    if (genreRegister === 'historical' || genreRegister === 'imperial' || genreRegister === 'wuxia') {
        return `
REGISTER - Historical, Imperial Palace & Wuxia (រឿងបុរាណ/រាជវាំង/ក្បាច់គុន/ទេវតា):
   - Use authentic Cambodian classical royal court language, martial arts terms, and dramatic tone:
     * Sovereign & Royal Court: "ព្រះអង្គ", "ព្រះមហាក្សត្រ", "ព្រះរាជបញ្ជា", "ក្រាបទូល", "សូមទ្រង់ព្រះមេត្តា".
     * Self-referral: "ទូលបង្គំ" (men to royalty), "ខ្ញុំម្ចាស់" (women to royalty), "យើង" (Emperor/King/Master).
     * Family & Consorts: "ម្ចាស់បង", "ម្ចាស់អូន", "ព្រះមាតា", "ព្រះបិតា", "រាជបុត្រ", "ព្រះនាង", "អ្នកម្នាង".
     * Martial Arts / Sects / Masters: "លោកម្ចាស់", "លោកគ្រូ", "សិស្សច្បង", "សិស្សប្អូន", "លោកមេបក្ស", "និកាយ", "វិជ្ជាគុណ".
     * Dramatic conflict (enemies only): "អាមនុស្សថោកទាប!", "កុំសង្ឃឹមថារួចខ្លួន!", "ឯងចង់ងាប់មែនទេ?!", "ទទួលបញ្ជា!".`;
    } else if (genreRegister === 'action') {
        return `
REGISTER - Action, Military & Crime (រឿងសកម្មភាព/កងទ័ព/ឧក្រិដ្ឋកម្ម):
   - Use punchy, high-adrenaline tactical dialogue:
     * Urgent commands: "ប្រយ័ត្ន!", "បាញ់!", "ដកថយ!", "កុំកម្រើក!", "ទៅលឿន!", "រត់!", "តាមចាប់វា!", "លើកដៃឡើង!".`;
    } else if (genreRegister === 'comedy') {
        return `
REGISTER - Comedy & Lively (រឿងកំប្លែង/កំប្លុកកំប្លែង):
   - Use humorous, lively, and entertaining spoken Cambodian colloquialisms:
     * Natural reactions: "អីយ៉ា!", "ងាប់ហើយ!", "កុំចេះដឹង!", "ពិតមែនហ្អេស?!", "កំប្លែងមែន!".`;
    } else if (genreRegister === 'horror') {
        return `
REGISTER - Horror, Ghost & Supernatural (រឿងខ្មោច/រន្ធត់/អបិយជំនឿ):
   - Use short, tense, breathless lines; let fear build with "..." pauses instead of long sentences:
     * Fear & panic: "នរណាហ្នឹង?!", "ឮអត់?", "កុំងាកក្រោយ!", "វាមកហើយ!", "ជួយផង!", "កុំទុកខ្ញុំចោល!", "រត់!".
     * Supernatural words: "ខ្មោច", "វិញ្ញាណ", "ព្រលឹង", "បិសាច", "អាបធ្មប់", "ខ្មោចលង", "ខ្មោចចូល", "គ្រូខ្មែរ", "ទឹកមន្ត".
     * A ghost or possessed voice is slow and cold: "រត់មិនរួចទេ...", "ខ្ញុំរង់ចាំយូរហើយ...".
     * "有鬼啊！" -> "មានខ្មោច!", "救命！" -> "ជួយផង!", "别回头！" -> "កុំងាកក្រោយ!", "谁在那里？" -> "នរណានៅហ្នឹង?".
   - Scared or hiding lines take the emotion "Fear" or "Whisper".`;
    } else if (genreRegister === 'mystery') {
        return `
REGISTER - Mystery, Thriller & Detective (រឿងស៊ើបអង្កេត/អាថ៌កំបាំង/ឃាតកម្ម):
   - Use sharp, clipped, suspicious dialogue, and keep every clue, name, time and place exact:
     * Investigation words: "ប៉ូលិស", "អ្នកស៊ើបអង្កេត", "ជនសង្ស័យ", "ភស្តុតាង", "ឃាតករ", "សាកសព", "កន្លែងកើតហេតុ", "ចាប់ខ្លួន".
     * Address: "警官" -> "លោកប៉ូលិស", "队长" -> "ប្រធានក្រុម", "法医" -> "គ្រូពេទ្យកោសល្យវិច្ច័យ".
     * Interrogation: "និយាយការពិតមក!", "យប់ម៉ិញនៅឯណា?", "ភស្តុតាងនៅនេះ នៅប្រកែកទៀត?", "នរណាជាអ្នកសម្លាប់?".`;
    } else if (genreRegister === 'fantasy') {
        return `
REGISTER - Fantasy, Xianxia & Immortals (រឿងទេវកថា/អមតៈ/បិសាច):
   - Use grand, mythic but still speakable Khmer:
     * Heaven & cultivation: "ឋានសួគ៌", "ទេវតា", "ទេពធីតា", "អមតៈ", "ព្រះអាទិទេព", "ថាមពលវិញ្ញាណ", "ហាត់វិជ្ជា", "ធ្វើសមាធិ".
     * Masters & disciples: "ម្ចាស់គ្រូ", "លោកគ្រូ", "សិស្សច្បង", "សិស្សប្អូន", "និកាយ".
     * Demons & monsters: "បិសាច", "អារក្ស", "យក្ស", "ស្ដេចបិសាច", "ពិភពបិសាច".
     * The Heavenly Emperor and gods take the royal forms ("ព្រះអង្គ", "ទូលបង្គំ", "ក្រាបទូល"), as in a palace.
     * Battle: "ការពារខ្លួន!", "កុំសង្ឃឹមថារួចខ្លួន!", "ប្រយ័ត្នវិជ្ជាវា!".`;
    } else if (genreRegister === 'family') {
        return `
REGISTER - Family Drama & Tear-jerker (រឿងគ្រួសារ/សោកនាដកម្ម):
   - Use warm, everyday, heartfelt Khmer; the feeling matters more than big words:
     * Family address: "ម៉ាក់" / "ប៉ា" or "ម្ដាយ" / "ឪពុក", "កូន", "យាយ" / "តា", "ចៅ", "បងប្រុស" / "បងស្រី", "ប្អូន", in-laws "ម្ដាយក្មេក" / "ឪពុកក្មេក", "កូនប្រសា".
     * Tender & sad lines: "កុំយំអី ម៉ាក់នៅនេះ", "ម៉ាក់សុំទោសកូន", "កូននឹកម៉ាក់ណាស់", "ប៉ាមិនដែលបន្ទោសកូនទេ".
     * Quarrels stay inside family words: "ម៉ាក់មិនដែលយល់ពីកូនសោះ!", "កូនធ្វើចឹងបានយ៉ាងម៉េច?!".`;
    } else if (genreRegister === 'youth') {
        return `
REGISTER - Youth, School & Campus (រឿងសិស្សសាលា/យុវវ័យ):
   - Use young, casual, playful Khmer:
     * Classmates of the same age may use "ឯង" / "គ្នា" / "យើង" playfully; a dating couple switches to "បង" / "អូន".
     * Teachers: "លោកគ្រូ" / "អ្នកគ្រូ" with self "ខ្ញុំ"; an older student ("学长" / "学姐") is "បង".
     * Lively lines: "ទៅលេងណា!", "ប្រឡងហើយ ងាប់ហើយ!", "ចូលចិត្តគេមែនទេ?", "ហ៊ានអត់?", "អត់អីទេណា!".`;
    }
    return `
REGISTER - Modern Romance, CEO & Urban (រឿងសម័យ/ស្នេហា/ប្រធានក្រុមហ៊ុន):
   - Use natural, fluid, modern conversational Khmer, with pronouns chosen by FORMS OF ADDRESS:
     * Lovers "បង" / "អូន"; boss "លោកប្រធាន" / "អ្នកនាង" with self "ខ្ញុំ"; parents "ម៉ាក់" / "ប៉ា".
     * Real conversational dialogue:
       - "你在干什么？" -> to a lover or older person "បងធ្វើអីហ្នឹង?" / to a younger one "ប្អូនធ្វើអីហ្នឹង?"
       - "你没事吧？" -> "អូនមិនអីទេ?" / to a boss "លោកប្រធានមិនអីទេ?"
       - "别管我！" -> "កុំរវល់នឹងខ្ញុំ!"
       - "对不起，我来晚了" -> to a lover "សុំទោស បងមកយឺត"
       - "我喜欢你" -> "បងស្រឡាញ់អូន" / "អូនស្រឡាញ់បង"
       - "怎么办？" -> "ធ្វើម៉េចទៅ?"`;
}

// A line's voice tag ("[Male] ...", "[Heroine] ...", "[Female:profile] ...") and the gender it
// stands for. The tag comes from the audio (Transcribe) or from the user, so it is the speaker's
// real gender: a text-only translation must keep it instead of guessing again.
const VOICE_TAG_RE = /^\[(Male|Female|Hero|Heroine|Father|Mother|Villain|Queen|Elder|Child)(?::[^\]]+)?\]\s*/i;
const FEMALE_ROLES = new Set(['female', 'heroine', 'mother', 'queen', 'child']);

// Mirrors the frontend parseSrtText() block rules so indexes line up 1:1. Each block keeps
// its timing, so the prompt can size every Khmer line to the time it has on screen.
function parseSrtBlocksForTranslate(content) {
    return String(content || '').trim().replace(/\r\n/g, '\n').split(/\n\s*\n/)
        .map(block => {
            const lines = block.split('\n');
            const times = lines.length >= 3 ? lines[1].split(' --> ') : [];
            if (times.length !== 2) return null;
            const start = toSeconds(times[0]);
            const end = toSeconds(times[1]);
            const seconds = end > start ? Number((end - start).toFixed(2)) : null;
            const raw = lines.slice(2).join('\n');
            const tag = raw.match(VOICE_TAG_RE);
            return {
                text: raw.replace(VOICE_TAG_RE, '').trim(),
                gender: tag ? (FEMALE_ROLES.has(tag[1].toLowerCase()) ? 'Female' : 'Male') : null,
                start: Number.isFinite(start) ? start : null,
                end: Number.isFinite(end) ? end : null,
                seconds,
                maxSyllables: khmerMaxSyllables(seconds)
            };
        })
        .filter(Boolean);
}

// The item the model sees for one SRT line: timing and the speaker's gender only when known.
function translatePromptLine(i, line) {
    const item = line.seconds
        ? { i, text: line.text, seconds: line.seconds, maxSyllables: line.maxSyllables }
        : { i, text: line.text };
    if (line.gender) item.gender = line.gender;
    return item;
}

function buildTranslatePrompt({ lines, glossaryHint, genreGuidance, previousLines }) {
    const contextHint = previousLines && previousLines.length
        ? `\n\nPREVIOUS DIALOGUE (context only, for consistent names and pronouns; do NOT translate or output these):\n${previousLines.map(l => `- [${l.gender || '?'}] ${l.source} => ${l.text}`).join('\n')}`
        : '';
    return `You are an elite master film/TV dialogue adapter and dubbing director specializing in Asian and Chinese drama (C-Drama: 古装/宫斗/仙侠/武侠/现代甜宠/总裁/动作/悬疑/恐怖/家庭/校园) localization into cinematic, natural and highly readable Khmer.

TASK:
Translate each dialogue line into NATURAL, SPEAKABLE Khmer dialogue for voice dubbing, sized to the time the line has on screen.

${KHMER_DUBBING_RULES}
${glossaryHint}${contextHint}

LINE MATCHING & EMOTION RULES:
1. Exact 1-to-1 Line Match:
   - Output exactly one item for every input line, using the same "i" number. Never merge, split, skip, or reorder lines.
   - Use the neighbouring lines as context, but translate each line on its own.
   - "seconds" is how long the line lasts and "maxSyllables" its Khmer syllable budget: stay within it, but don't pad a short line up to it. A line without them matches the original's length.

2. Speaker Gender & Emotional Acting Detection:
   - Assign "gender": "Male" or "Female" - the gender of the character speaking the line, from context, pronouns and relationships.
   - A line that already has a "gender" was heard from the audio: output that same gender, and choose pronouns for a speaker of that gender (a man calls himself "បង" to his lover, a woman "អូន").
   - Assign the dramatic emotion: "Neutral", "Angry", "Sad", "Whisper", "Excited", "Royal", "Romantic", "Fear".${genreGuidance}

3. Output Format:
   - Return ONLY a valid JSON array of objects:
[
  {
    "i": 0,
    "text": "Natural Khmer translation",
    "gender": "Male",
    "emotion": "Neutral"
  }
]

LINES TO TRANSLATE:
${JSON.stringify(lines)}`;
}

module.exports = {
    KHMER_SYLLABLES_PER_SEC,
    KHMER_FORMS_OF_ADDRESS,
    KHMER_DUBBING_RULES,
    toSeconds,
    khmerMaxSyllables,
    lineSeconds,
    getKhmerDramaRegisterGuidance,
    parseSrtBlocksForTranslate,
    translatePromptLine,
    buildTranslatePrompt
};
