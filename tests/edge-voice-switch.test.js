// VoxCPM2 switched off: every line is voiced by Edge's Piseth (Male) or Sreymom (Female) again.
// While VoxCPM2 was on, a line's gender holds its voice id (8 letters, e.g. "a3f2dad0") - after
// Import SRT, Add Text, Clone Voices or a pick on the voice pill. Read as a role word an id said
// "Male", so women with a cloned voice were voiced by Piseth. Switched back on, a line keeps the
// voice of the speaker found saying it. The functions are lifted out of frontend/js/studio-main.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8').replace(/\r\n/g, '\n');

const from = source.indexOf('window.CHARACTER_PRESETS = {');
const fnAt = source.indexOf('window.edgeVoiceOf = function');
const to = source.indexOf('\n    };\n', fnAt) + '\n    };'.length;
assert.ok(from >= 0 && fnAt > from && to > fnAt, 'Edge voice code not found');
const window = {};
new Function('window', source.slice(from, to))(window);
const edgeVoiceOf = window.edgeVoiceOf;
const oldEdgeVoice = (sub) => window.resolveCharacterKey(sub.character || sub.gender); // before

const tagAt = source.indexOf('function voxVoiceTagOf(');
const tagEnd = source.indexOf('\n    }\n', tagAt) + '\n    }'.length;
const voxVoiceTagOf = new Function(`${source.slice(tagAt, tagEnd)}\nreturn voxVoiceTagOf;`)();

// Ids as crypto.randomUUID().substring(0, 8) makes them; "dad" read as Father, the rest as Male.
const profiles = [
    { id: 'a3f2dad0', label: '苏曼青', gender: 'Female' },
    { id: '7c41e9b2', label: 'Speaker 2', gender: 'Female' },
    { id: '0e5b8f13', label: '韩子昂', gender: 'Male' },
];

test('a woman with a cloned voice is Sreymom once VoxCPM2 is off', () => {
    const lines = {
        'Import SRT / Add Text with VoxCPM2 on': { gender: '7c41e9b2' },
        'picked on the voice pill with VoxCPM2 on': { gender: 'a3f2dad0', character: 'a3f2dad0' },
    };
    for (const [how, sub] of Object.entries(lines)) {
        assert.equal(oldEdgeVoice(sub), 'Male', `${how}: was Piseth`);
        assert.equal(edgeVoiceOf(sub, profiles), 'Female', how);
    }
    assert.equal(edgeVoiceOf({ gender: '0e5b8f13' }, profiles), 'Male');
});

test('a transcribed line keeps the voice Edge gave it before its speaker was cloned', () => {
    // Clone Voices puts the voice id in gender; Transcribe's tag stays in character.
    assert.equal(edgeVoiceOf({ character: 'Female', speaker: 'Female', gender: '0e5b8f13', voxSpeaker: '0e5b8f13' }, profiles), 'Female');
    assert.equal(edgeVoiceOf({ character: 'Male', gender: 'a3f2dad0' }, profiles), 'Male');
});

test('lines never touched by VoxCPM2 are voiced as before', () => {
    for (const sub of [
        { character: 'Male', gender: 'Male' },
        { character: 'Female', gender: 'Female' },
        { gender: 'Female' }, // Add Text
        { gender: 'Mother' }, // an old project's role
        { gender: 'Villain', character: 'Villain' },
        { gender: 'km-KH-SreymomNeural' },
        {},
    ]) {
        assert.equal(edgeVoiceOf(sub, profiles), oldEdgeVoice(sub), JSON.stringify(sub));
        assert.equal(edgeVoiceOf(sub, undefined), oldEdgeVoice(sub), JSON.stringify(sub));
    }
});

test('a voice that was deleted falls back as before', () => {
    assert.equal(edgeVoiceOf({ gender: 'ffffffff' }, profiles), 'Male');
    assert.equal(edgeVoiceOf({ gender: 'ffffffff', character: 'Female' }, profiles), 'Female');
});

test('VoxCPM2 on again: a line set back to Male/Female gets its speaker\'s voice back', () => {
    assert.equal(voxVoiceTagOf({ gender: 'Female', voxSpeaker: 'a3f2dad0' }, profiles), 'a3f2dad0');
    assert.equal(voxVoiceTagOf({ gender: 'Male', voxSpeaker: '0e5b8f13' }, profiles), '0e5b8f13');
});

test('VoxCPM2 on again: a hand-picked other gender, a deleted voice or a voice already set stays', () => {
    assert.equal(voxVoiceTagOf({ gender: 'Male', voxSpeaker: 'a3f2dad0' }, profiles), 'Male'); // picked Male on a woman's voice
    assert.equal(voxVoiceTagOf({ gender: 'Female', voxSpeaker: 'ffffffff' }, profiles), 'Female');
    assert.equal(voxVoiceTagOf({ gender: '7c41e9b2', voxSpeaker: 'a3f2dad0' }, profiles), '7c41e9b2');
    assert.equal(voxVoiceTagOf({ gender: 'Female' }, profiles), 'Female');
});

test('Edge and VoxCPM2 both read the line through these functions', () => {
    assert.match(source, /character: window\.edgeVoiceOf\(sub, voxCmp2Data\.profiles\)/, 'Generate (Edge)');
    assert.match(source, /const charKey = window\.edgeVoiceOf\(sub, voxData\.profiles\);/, 'Export SRT');
    assert.match(source, /const charKey = window\.edgeVoiceOf\(sub, voxCmp2Settings\.profiles\);/, 'voice pill (Edge)');
    assert.equal(source.match(/resolveSmartVoxCpmProfile\(voxVoiceTagOf\(sub, voxCmp2Data\.profiles\)/g).length, 2, 'Generate and the VoxCPM2 queue');
    assert.doesNotMatch(source, /resolveSmartVoxCpmProfile\(sub\.gender/);
});

test('the voice pill with VoxCPM2 off keeps a line\'s VoxCPM2 voice for later', () => {
    const at = source.indexOf('const charKey = window.edgeVoiceOf(sub, voxCmp2Settings.profiles);');
    const block = source.slice(at, source.indexOf('genderHidden.addEventListener', at));
    assert.match(block, /if \(!isVoxVoice\) subtitles\[liveSubIdx\]\.gender = charKey;/);
    assert.match(block, /subtitles\[liveSubIdx\]\.character = charKey;/);
});

test('Dub Whole Series starts the VoxCPM2 server only when VoxCPM2 is on', () => {
    const at = source.indexOf('const runGenerate = async () => {');
    const block = source.slice(at, source.indexOf('generateSelectedAudioAllProjects(', at));
    assert.match(block, /if \(voxCmp2Load\(\)\.enabled\) \{\s*await voxCmp2EnsureServer\(/);
    const fn = source.slice(source.indexOf('async function voxCmp2EnsureServer('), source.indexOf('return _voxPingReady;\n    }'));
    assert.match(fn, /if \(!data\.enabled \|\| /, 'does nothing with VoxCPM2 off');
});
