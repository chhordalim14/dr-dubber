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

    test('a ហ after ំ with no vowel of its own is said (Edge-TTS drops it as written)', () => {
        assert.equal(say('តោះ ចូលទៅក្នុងលំហ!'), 'តោះ ចូលទៅក្នុងលំហា!');
        assert.equal(say('ទ្វារចំហ'), 'ទ្វារចំហា។');
        assert.equal(say('ចូលទៅក្នុងលំហអាកាស'), 'ចូលទៅក្នុងលំហាអាកាស។', 'inside a compound too');
        // ហ with its own vowel is read already: left alone.
        for (const w of ['លំហែកាយ', 'កំហឹង', 'កំហុស', 'ស្នេហា', 'លំហា']) assert.equal(say(w), w + '។', w);
    });

    test('text without Khmer is only tidied', () => {
        assert.equal(say('  Hello   world 2  '), 'Hello world 2');
        assert.equal(say(''), '');
        assert.equal(say(null), '');
    });
});
