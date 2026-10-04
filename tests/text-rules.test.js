// Text rules from backend/lib/text-rules.js. Each case is a bug that reached a real series.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { FOREIGN_SCRIPT_RE, KHMER_CHAR_RE, stripForeignScript, collapseRepeatedPartSuffix, buildTtsArgv } = require('../backend/lib/text-rules');

describe('foreign script in Khmer lines', () => {
    test('flags an Arabic word Gemini slipped into a Khmer line, and strips only that word', () => {
        const line = 'នាងតូចមិនព្រមទេ នាងចង់បាន صحن ធំជាងនេះ';
        assert.ok(FOREIGN_SCRIPT_RE.test(line));
        assert.equal(stripForeignScript(line), 'នាងតូចមិនព្រមទេ នាងចង់បាន ធំជាងនេះ');
    });
    test('flags Chinese left untranslated', () => {
        assert.ok(FOREIGN_SCRIPT_RE.test('យ៉ាងម៉េចដែរ? 你好'));
        assert.equal(stripForeignScript('យ៉ាងម៉េចដែរ? 你好'), 'យ៉ាងម៉េចដែរ?');
    });
    test('leaves normal Khmer, Khmer digits and Latin (names, "OK") alone', () => {
        for (const ok of ['លីនកុងសឺ ពួកយើងសម្រេចតាមហ្នឹងចុះ។', 'OK! ទៅចុះ។', 'ឆ្នាំ១៩៩២', 'CEO លី']) {
            assert.equal(FOREIGN_SCRIPT_RE.test(ok), false, ok);
            assert.ok(KHMER_CHAR_RE.test(ok));
        }
    });
});

describe('saved SRT names', () => {
    test('keeps different piece numbers - part01_part06 must not overwrite part01_part01', () => {
        assert.equal(collapseRepeatedPartSuffix('S_part01_part06'), 'S_part01_part06');
        assert.notEqual(collapseRepeatedPartSuffix('S_part01_part06'), collapseRepeatedPartSuffix('S_part01_part01'));
    });
    test('still collapses a repeated identical suffix', () => {
        assert.equal(collapseRepeatedPartSuffix('name_part1_part1'), 'name_part1');
        assert.equal(collapseRepeatedPartSuffix('name_part01_part1'), 'name_part01');
        assert.equal(collapseRepeatedPartSuffix('EP01'), 'EP01');
    });
});

describe('tts_generator.py arguments', () => {
    test('values starting with "-" stay attached to their flag (argparse would reject them otherwise)', () => {
        const argv = buildTtsArgv({ script: 'tts.py', text: '- ទៅណា?', voice: 'km-KH-PisethNeural', rate: '-10%', pitch: '-5Hz', volume: '+0%', output: 'o.mp3' });
        assert.deepEqual(argv, ['tts.py', '--text=- ទៅណា?', '--voice=km-KH-PisethNeural', '--rate=-10%', '--pitch=-5Hz', '--volume=+0%', '--output=o.mp3']);
        // No argument may be a bare value that begins with "-".
        assert.ok(argv.slice(1).every((a) => a.startsWith('--') && a.includes('=')));
    });
});
