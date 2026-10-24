// frontend/js/khmer-speech.js: Khmer subtitle text as the voice should say it. Examples are
// real lines from the app's Khmer subtitles.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const K = require('../frontend/js/khmer-speech.js');
const say = K.normalizeForSpeech;

describe('Khmer text for the voice', () => {
    test('numbers in words, Khmer units below a million', () => {
        const cases = { 0: 'សូន្យ', 10: 'ដប់', 15: 'ដប់ប្រាំ', 21: 'ម្ភៃមួយ', 33: 'សាមសិបបី', 99: 'កៅសិបប្រាំបួន', 100: 'មួយរយ', 105: 'មួយរយប្រាំ',
            2500: 'ពីរពាន់ប្រាំរយ', 12000: 'មួយម៉ឺនពីរពាន់', 350000: 'បីសែនប្រាំម៉ឺន', 1200000: 'មួយលានពីរសែន', 25000000: 'ម្ភៃប្រាំលាន', 3000000000: 'បីពាន់លាន' };
        for (const [n, w] of Object.entries(cases)) assert.equal(K.numberToWords(+n), w, n);
    });

    test('numbers in a line: Khmer or Arabic digits, separators, money, percent, codes', () => {
        assert.equal(say('សរុបប្រហែល១៨ម៉ឺន'), 'សរុបប្រហែលដប់ប្រាំបីម៉ឺន។');
        assert.equal(say('អាយុ ៣៣ ហើយ!'), 'អាយុ សាមសិបបី ហើយ!');
        assert.equal(say('តម្លៃ 2,500 ដុល្លារ និង 50% ទៀត'), 'តម្លៃ ពីរពាន់ប្រាំរយ ដុល្លារ និង ហាសិបភាគរយ ទៀត។');
        assert.equal(say('គាត់ចំណាយ $1,200,000'), 'គាត់ចំណាយ មួយលានពីរសែនដុល្លារ។');
        assert.equal(say('កាតលេខ 0927'), 'កាតលេខ សូន្យ ប្រាំបួន ពីរ ប្រាំពីរ។');
        assert.equal(say('ទី១ ទី១០៥'), 'ទីមួយ ទីមួយរយប្រាំ។');
        assert.equal(say('ប្រហែល 3.5 ម៉ោង'), 'ប្រហែល បីក្បៀសប្រាំ ម៉ោង។');
    });

    test('ៗ says the word before it twice', () => {
        assert.equal(say('មែនៗ ឈប់និយាយទៅ'), 'មែនមែន ឈប់និយាយទៅ។');
        assert.equal(say('ផ្សេង ៗ ទៀត'), 'ផ្សេងផ្សេង ទៀត។');
    });

    test('acronyms by their letter names; names are left as written', () => {
        assert.equal(say('កាត VIP ចាប់ពីឥឡូវ'), 'កាត វីអាយភី ចាប់ពីឥឡូវ។');
        assert.equal(say("តែ Wen Ting'an មកហើយ"), "តែ Wen Ting'an មកហើយ។");
    });

    test('a closing ? or ! is kept for the intonation; otherwise ។', () => {
        assert.equal(say('តើភូមិគ្រឹះរៀបចំពិធីជប់លៀងធំមែនទេ?'), 'តើភូមិគ្រឹះរៀបចំពិធីជប់លៀងធំមែនទេ?');
        assert.equal(say('ពិតមែនឬ?!'), 'ពិតមែនឬ?');
        assert.equal(say('ទៅ！！'), 'ទៅ!');
        assert.equal(say('ខ្ញុំទៅហើយ'), 'ខ្ញុំទៅហើយ។');
        assert.equal(say('ខ្ញុំទៅហើយ។'), 'ខ្ញុំទៅហើយ។');
    });

    test('ellipses and dashes are pauses; quotes, brackets and speaker tags are not read', () => {
        assert.equal(say('ប្រាំ... ប្រាំលាន?'), 'ប្រាំ, ប្រាំលាន?');
        assert.equal(say('ម៉ែ—!'), 'ម៉ែ!');
        assert.equal(say('“ទៅ!” គាត់ថា'), 'ទៅ! គាត់ថា។');
        assert.equal(say('[Female:female-default] ម៉ែ រឹតតឹងពេកហើយ'), 'ម៉ែ រឹតតឹងពេកហើយ។');
        assert.equal(say('ខ្ញុំ… មិនដឹងទេ…'), 'ខ្ញុំ, មិនដឹងទេ។');
    });

    test('a ហ after ំ is left as written: one syllable with a soft h ("lomh"), no vowel added', () => {
        // ហា said a long "haa", ហៈ / ះ an added "ha" - measured against Google's voice, 2026-10-24.
        assert.equal(say('តោះ ចូលទៅក្នុងលំហ!'), 'តោះ ចូលទៅក្នុងលំហ!');
        assert.equal(say('ទ្វារចំហ'), 'ទ្វារចំហ។');
        assert.equal(say('ចូលទៅក្នុងលំហអាកាស'), 'ចូលទៅក្នុងលំហអាកាស។');
        for (const w of ['លំហែកាយ', 'កំហឹង', 'កំហុស', 'ស្នេហា', 'លំហា']) assert.equal(say(w), w + '។', w);
    });

    test('ម្ចាស់ is said ម៉ាចាស់ (the voice\'s short ម made ព្រះអង្គម្ចាស់ sound like ព្រះអង្គចាស់)', () => {
        assert.equal(say('សូមអភ័យទោស ព្រះអង្គម្ចាស់'), 'សូមអភ័យទោស ព្រះអង្គម៉ាចាស់។');
        assert.equal(say('លោកម្ចាស់ ខ្ញុំម្ចាស់មកហើយ!'), 'លោកម៉ាចាស់ ខ្ញុំម៉ាចាស់មកហើយ!');
        assert.equal(say('ម្ចាស់គ្រូ'), 'ម៉ាចាស់គ្រូ។');
        assert.equal(say('ចាស់ហើយ'), 'ចាស់ហើយ។', 'plain ចាស់ is left alone');
    });

    test('other ម្ words that turn into another word without their ម are respelled too', () => {
        assert.equal(say('អ្នកម្នាង'), 'អ្នកម៉ានាង។');
        assert.equal(say('ម្ហូបឆ្ងាញ់'), 'ម៉ាហូបឆ្ងាញ់។');
        assert.equal(say('ម្ដងទៀត'), 'ម៉ាដងទៀត។');
        assert.equal(say('ម្តងទៀត'), 'ម៉ាដងទៀត។', 'the look-alike spelling with ត');
        assert.equal(say('ម្ដងៗ'), 'ម៉ាដងម៉ាដង។', 'after ៗ is expanded');
        assert.equal(say('ម្ខាងទៀត'), 'ម៉ាខាងទៀត។');
        assert.equal(say('នៅម្នាក់ឯង'), 'នៅម៉ានាក់ឯង។');
        // still understood without a full ម, and a short ម is how they are said: left alone
        for (const w of ['ម្ដាយ', 'ម្សិលមិញ', 'ម្ភៃ', 'នាង', 'ហូប', 'ពីរនាក់']) assert.equal(say(w), w + '។', w);
    });

    test('times, dates, scores, fractions and ranges as they are said', () => {
        assert.equal(say('ម៉ោង 10:30 យើងជួបគ្នា'), 'ម៉ោងដប់កន្លះ យើងជួបគ្នា។');
        assert.equal(say('ជួបគ្នា 7:15 ព្រឹក'), 'ជួបគ្នា ម៉ោងប្រាំពីរ ដប់ប្រាំនាទី ព្រឹក។');
        assert.equal(say('ម៉ោង ៩:០០'), 'ម៉ោងប្រាំបួន។');
        assert.equal(say('ថ្ងៃទី 15/5/2026'), 'ថ្ងៃទីដប់ប្រាំ ខែឧសភា ឆ្នាំពីរពាន់ម្ភៃប្រាំមួយ។');
        assert.equal(say('ពិន្ទុ 3:2'), 'ពិន្ទុ បី ទល់ ពីរ។');
        assert.equal(say('ពាក់កណ្តាល 1/2'), 'ពាក់កណ្តាល មួយភាគពីរ។');
        assert.equal(say('អាយុ 20-30 ឆ្នាំ'), 'អាយុ ម្ភៃ ទៅ សាមសិប ឆ្នាំ។');
    });

    test('units after a number, phone numbers digit by digit, English titles', () => {
        assert.equal(say('ឆ្ងាយ 5km'), 'ឆ្ងាយ ប្រាំគីឡូម៉ែត្រ។');
        assert.equal(say('ទម្ងន់ 20 kg'), 'ទម្ងន់ ម្ភៃគីឡូក្រាម។');
        assert.equal(say('បើក 80km/h'), 'បើក ប៉ែតសិបគីឡូម៉ែត្រក្នុងមួយម៉ោង។');
        assert.equal(say('លេខ 012 345 678'), 'លេខ សូន្យ មួយ ពីរ បី បួន ប្រាំ ប្រាំមួយ ប្រាំពីរ ប្រាំបី។');
        assert.equal(say('លេខ 012-345-678'), 'លេខ សូន្យ មួយ ពីរ បី បួន ប្រាំ ប្រាំមួយ ប្រាំពីរ ប្រាំបី។');
        assert.equal(say('Mr. Wang មកហើយ'), 'លោក Wang មកហើយ។');
        assert.equal(say('Mrs. Li ទៅណា'), 'លោកស្រី Li ទៅណា។');
    });

    test('other date forms, minus, times and other money', () => {
        assert.equal(say('ថ្ងៃទី 2026-10-19'), 'ថ្ងៃទីដប់ប្រាំបួន ខែតុលា ឆ្នាំពីរពាន់ម្ភៃប្រាំមួយ។');
        assert.equal(say('មកវិញ 05-10-2026'), 'មកវិញ ថ្ងៃទីប្រាំ ខែតុលា ឆ្នាំពីរពាន់ម្ភៃប្រាំមួយ។', 'not a phone number');
        assert.equal(say('ថ្ងៃ 19.10.2026'), 'ថ្ងៃ ថ្ងៃទីដប់ប្រាំបួន ខែតុលា ឆ្នាំពីរពាន់ម្ភៃប្រាំមួយ។');
        assert.equal(say('ត្រជាក់ -5°C'), 'ត្រជាក់ ដកប្រាំអង្សាសេ។');
        assert.equal(say('បន្ទប់ 3×4 ម៉ែត្រ'), 'បន្ទប់ បី គុណ បួន ម៉ែត្រ។');
        assert.equal(say('ថ្លៃ ¥500'), 'ថ្លៃ ប្រាំរយយ័ន។');
        assert.equal(say('ថ្លៃ 500元 និង €20'), 'ថ្លៃ ប្រាំរយយ័ន និង ម្ភៃអឺរ៉ូ។');
        assert.equal(say('ខ្ញុំមាន 100 USD និង 4000 KHR'), 'ខ្ញុំមាន មួយរយដុល្លារ និង បួនពាន់រៀល។');
        assert.equal(say('អាយុ 20-30 ឆ្នាំ'), 'អាយុ ម្ភៃ ទៅ សាមសិប ឆ្នាំ។', 'a range is not a minus');
    });

    test('Khmer marks and abbreviations read out; single capitals and ok spelled', () => {
        assert.equal(say('ផ្លែឈើ ចេក ក្រូច ។ល។'), 'ផ្លែឈើ ចេក ក្រូច ជាដើម។');
        assert.equal(say('គាត់និយាយថា៖ ទៅ!'), 'គាត់និយាយថា, ទៅ!');
        assert.equal(say('ឆ្នាំ ២៥៦៨ ព.ស.'), 'ឆ្នាំ ពីរពាន់ប្រាំរយហុកសិបប្រាំបី ពុទ្ធសករាជ។');
        assert.equal(say('ចម្ងាយ ១០ គ.ម.'), 'ចម្ងាយ ដប់ គីឡូម៉ែត្រ។');
        assert.equal(say('ទូរស័ព្ទ 5G'), 'ទូរស័ព្ទ ប្រាំជី។');
        assert.equal(say('ផែនការ A'), 'ផែនការ អេ។');
        assert.equal(say('ok ទៅ'), 'អូខេ ទៅ។');
        assert.equal(say("តែ Wen Ting'an និង Facebook"), "តែ Wen Ting'an និង Facebook។", 'words and names left as written');
    });

    test("the user's pronunciation list: longest written form first, a said form never respelled again", () => {
        K.setPronunciations([['ស៊ូ', 'ស៊ូវ'], ['ស៊ូហ៊ាង', 'ស៊ូ ហ៊ាង'], ['', 'x'], ['ទៅ', 'ទៅ']]);
        try {
            assert.equal(say('ស៊ូហ៊ាង និង ស៊ូ ទៅ'), 'ស៊ូ ហ៊ាង និង ស៊ូវ ទៅ។');
        } finally {
            K.setPronunciations([]);
        }
        assert.equal(say('ស៊ូ'), 'ស៊ូ។', 'an empty list leaves the line alone');
    });

    test('the Settings box: "written = said" per line (=> and → too), other lines ignored', () => {
        assert.deepEqual(K.parsePronunciations('លំហ = លំហា\na note\nស៊ូហ៊ាង => ស៊ូ ហ៊ាង\r\nក → ខ\n'),
            [['លំហ', 'លំហា'], ['ស៊ូហ៊ាង', 'ស៊ូ ហ៊ាង'], ['ក', 'ខ']]);
        assert.deepEqual(K.parsePronunciations(null), []);
    });

    test('text without Khmer is only tidied', () => {
        assert.equal(say('  Hello   world 2  '), 'Hello world 2');
        assert.equal(say(''), '');
        assert.equal(say(null), '');
    });
});
