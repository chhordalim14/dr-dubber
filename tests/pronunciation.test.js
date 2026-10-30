// backend/lib/pronunciation.js: finding words Edge says unlike Google's voice, and the respelling
// that fixes them. The recogniser outputs are real ones (pronunciation_checker.py, 2026-10-30).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../backend/lib/pronunciation.js');
const K = require('../frontend/js/khmer-speech.js');

describe('comparing what the recogniser heard', () => {
    test('the outline keeps consonants (ំ as ម), and the three spellings of ឲ្យ are one', () => {
        assert.equal(P.outline('សុំ មុខ').s, P.outline('ស៊ុំ មុខ').s);
        assert.equal(P.outline('សំមុខ').s, 'សមមខ');
        assert.equal(P.outline('ប្រើ អោយ').s, P.outline('ប្រើឱ្យ').s);
        assert.equal(P.outline('ប្រើ អោយ').s, P.outline('ប្រើឲ្យ').s);
    });

    test('align gives the edits between two strings', () => {
        assert.deepEqual(P.align('abcd', 'axcdd'), [['equal', 0, 1, 0, 1], ['replace', 1, 2, 1, 2], ['equal', 2, 3, 2, 3], ['replace', 3, 3, 3, 4], ['equal', 3, 4, 4, 5]]);
        assert.deepEqual(P.align('', 'ab'), [['replace', 0, 0, 0, 2]]);
        assert.equal(P.similarity('abc', 'abc'), 1);
    });

    test('Edge\'s extra syllable in សមមុខ is found, in that word only', () => {
        const text = 'សមមុខហើយ នរណាប្រើឲ្យខ្ញុំខឹង?';
        const judged = P.judgeLine(text, 'សំរមុខ ហើយ នរណា ប្រើ អោយ ខ្ញុំ ខឹង', 'សុំ មុខ ហើយ នរណា ប្រើ ឱ្យ ខ្ញុំ ខឹង');
        assert.deepEqual(judged.bad, ['សមមុខ']);
        assert.deepEqual(judged.ok, ['ហើយ', 'នរណា', 'ប្រើឲ្យ', 'ខ្ញុំ', 'ខឹង']);
    });

    test('respelled សម មុខ is heard right (the vowel spelling ស៊ុំ / សុំ does not count)', () => {
        const judged = P.judgeLine('សម មុខហើយ នរណាប្រើឲ្យខ្ញុំខឹង?', 'ស៊ុំ មុខ ហើយ នរណា ប្រើ អោយ ខ្ញុំ ខឹង', 'សុំ មុខ ហើយ នរណា ប្រើ ឱ្យ ខ្ញុំ ខឹង');
        assert.deepEqual(judged.bad, []);
    });

    test('where Google strays from the text and Edge does not, Edge is not blamed', () => {
        const text = 'មិនបាច់ទេ ចេញទៅ។';
        assert.deepEqual(P.judgeLine(text, 'មិន បាច់ ទេ ចេញ ទៅ', 'មិន បាត់ ទេ ចេញ ទៅ').bad, []);
    });

    test('no key when Google\'s reading is far from the text', () => {
        assert.equal(P.judgeLine('មិនបាច់ទេ ចេញទៅ។', 'មិន បាច់ ទេ ចេញ ទៅ', 'ខ្ញុំ ស្រឡាញ់'), null);
    });

    test('respellings put a space where a syllable starts, never before a final consonant', () => {
        assert.deepEqual(P.respellings('សមមុខ'), ['សម មុខ']);
        assert.deepEqual(P.respellings('ពិសេសមុខ'), ['ពិ សេសមុខ', 'ពិសេស មុខ', 'ពិ សេស មុខ'], 'not before the ស that ends សេស');
        assert.deepEqual(P.respellings('ធ្វើឲ្យ'), ['ធ្វើ ឲ្យ']);
        assert.deepEqual(P.respellings('ខឹង'), []);
    });
});

describe('the background checker', () => {
    // A fake Edge that says the word ពិសេសមុខ (made up for the test) with an extra syllable
    // unless it is written with a space after its second syllable. Google always reads the text.
    const fakeHear = (text) => ({
        success: true,
        edgeHeard: text.replace(/ពិ\s?សេស\s?មុខ/g, (m) => (m === 'ពិសេស មុខ' ? m : 'ពិសេសរមុខ')),
        googleHeard: text,
    });
    function setUp(lines) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pron-'));
        fs.mkdirSync(path.join(dir, 'batch_results'));
        fs.writeFileSync(path.join(dir, 'batch_results', 'a.json'), JSON.stringify({ data: lines.map((text) => ({ text, gender: 'Male' })) }));
        return dir;
    }
    const make = (dir, hearFn = fakeHear) => P.createPronunciationChecker({
        storageDir: dir, batchDir: path.join(dir, 'batch_results'), scriptPath: '', ffmpegPath: () => '', khmerSpeech: K, hearFn,
    });

    test('a word said wrong in several lines gets the respelling that fixes it', async () => {
        const dir = setUp(['ពិសេសមុខហើយ', 'គាត់ពិសេសមុខណាស់', 'ពិសេសមុខទៀតហើយ', 'ខ្ញុំទៅផ្ទះ', 'គាត់ទៅផ្ទះហើយ']);
        const checker = make(dir);
        await checker.run();
        const st = checker.status();
        assert.deepEqual(st.fixes.map((f) => [f.written, f.said]), [['ពិសេសមុខ', 'ពិសេស មុខ']]);
        // tried in the 2 or 3 lines it had gone wrong in by then, each with both voices
        assert.match(st.fixes[0].before, /^0\/[46]$/);
        assert.equal(st.fixes[0].score, st.fixes[0].before.replace('0/', '') + '/' + st.fixes[0].before.replace('0/', ''));
        assert.equal(st.linesChecked, 5);
    });

    test('a word heard wrong once (recogniser noise) is not changed', async () => {
        let first = true;
        const dir = setUp(['ខ្ញុំទៅផ្ទះ', 'គាត់ទៅផ្ទះហើយ', 'ទៅផ្ទះវិញ']);
        const checker = make(dir, (text) => {
            const r = { success: true, edgeHeard: text, googleHeard: text };
            if (first && text.includes('ផ្ទះ')) { first = false; r.edgeHeard = text.replace('ផ្ទះ', 'ផ្ទាំង'); }
            return r;
        });
        await checker.run();
        assert.deepEqual(checker.status().fixes, []);
    });

    test('a fix the user removes stays removed, and the list survives a restart', async () => {
        const dir = setUp(['ពិសេសមុខហើយ', 'គាត់ពិសេសមុខណាស់', 'ពិសេសមុខទៀតហើយ']);
        const checker = make(dir);
        await checker.run();
        assert.equal(checker.status().fixes.length, 1);
        assert.equal(checker.reject('ពិសេសមុខ'), true);
        fs.writeFileSync(path.join(dir, 'batch_results', 'b.json'), JSON.stringify({ data: [{ text: 'ពិសេសមុខម្ដងទៀត', gender: 'Female' }] }));
        const again = make(dir);
        await again.run();
        assert.deepEqual(again.status().fixes, []);
    });

    test('switched off, it checks nothing', async () => {
        const dir = setUp(['ពិសេសមុខហើយ']);
        const checker = make(dir);
        checker.setEnabled(false);
        await checker.run();
        assert.equal(checker.status().linesChecked, 0);
    });
});

describe('the automatic list in khmer-speech.js', () => {
    test('applied to whole words, the user\'s own list wins, and VoxCPM2 can leave it out', () => {
        K.setAutoPronunciations([{ written: 'ពិសេសមុខ', said: 'ពិសេស មុខ' }]);
        try {
            assert.equal(K.normalizeForSpeech('ពិសេសមុខហើយ'), 'ពិសេស មុខហើយ។');
            assert.equal(K.normalizeForSpeech('ពិសេសមុខហើយ', { auto: false }), 'ពិសេសមុខហើយ។');
            K.setPronunciations([['ពិសេសមុខ', 'ពិសេសមុខ']]); // the user's line says keep it: from === to is dropped...
            K.setPronunciations([['ពិសេសមុខ', 'ពិ សេសមុខ']]); // ...a real choice of theirs wins
            assert.equal(K.normalizeForSpeech('ពិសេសមុខហើយ'), 'ពិ សេសមុខហើយ។');
        } finally {
            K.setAutoPronunciations([]);
            K.setPronunciations([]);
        }
    });
});
