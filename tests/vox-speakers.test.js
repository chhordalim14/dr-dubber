// Clone Voices from Video: the lines' audio sent to the speaker search, the reference clip
// picked for each speaker, the series a video belongs to, and the wiring from voicing to the
// VoxCPM2 server's /api/speakers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const { linesWav, refPieces } = require('../backend/routes/voice-capture');

test('linesWav: only the lines, back to back, as a 16 kHz mono wav with their new times', () => {
    const rate = 16000;
    const movie = Buffer.alloc(10 * rate * 2); // 10 s of raw s16le
    for (let i = 0; i < movie.length / 2; i++) movie.writeInt16LE(i % 30000, i * 2);
    const reads = [];
    const readPart = (a, b) => {
        reads.push([a, b]);
        return movie.subarray(a, b);
    };
    const { wav, sent } = linesWav(readPart, movie.length, [
        { id: 'a', start: 1, end: 2, gender: 'Male' },
        { id: 'b', start: 5, end: 5.5, gender: null },
        { id: 'c', start: 9.5, end: 12, gender: 'Female' }, // runs past the end: cut there
        { id: 'd', start: 20, end: 21 },                    // past the end: left out
    ]);
    assert.deepEqual(reads, [[32000, 64000], [160000, 176000], [304000, 320000]], 'reads only the lines');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(22), 1, 'mono');
    assert.equal(wav.readUInt32LE(24), rate);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.deepEqual(sent.map((s) => s.id), ['a', 'b', 'c']);
    assert.deepEqual(sent[0], { id: 'a', start: 0, end: 1, gender: 'Male' });
    assert.deepEqual([sent[1].start, sent[1].end], [1.3, 1.8], 'after a 0.3 s gap');
    assert.deepEqual([sent[2].start, sent[2].end], [2.1, 2.6]);
    // the first sample of line b sits where its new start says
    assert.equal(wav.readInt16LE(44 + Math.round(1.3 * rate) * 2), (5 * rate) % 30000);
});

// One character, one voice: the name Transcribe gave a line, and whether its times are the
// video's own subtitle's, reach the speaker search with it.
test('linesWav and the page carry each line\'s character name and exact timing to the speaker search', () => {
    const movie = Buffer.alloc(4 * 16000 * 2);
    const { sent } = linesWav((a, b) => movie.subarray(a, b), movie.length, [
        { id: 'a', start: 0, end: 1, gender: 'Female', name: '赵淑芬', exact: true },
        { id: 'b', start: 2, end: 3, gender: 'Male' },
    ]);
    assert.deepEqual(sent[0], { id: 'a', start: 0, end: 1, gender: 'Female', name: '赵淑芬', exact: true });
    assert.deepEqual(sent[1], { id: 'b', start: 1.3, end: 2.3, gender: 'Male' }, 'nothing added to a line without them');
    const page = read('frontend', 'js', 'vox-speakers.js');
    assert.match(page, /name: s\.characterName \|\| null, exact: !!s\.screenMatched/);
    assert.match(page, /label: s\.english \|\| s\.name \|\| `Speaker \$\{\+\+number\}`/);
    assert.match(read('frontend', 'js', 'studio-main.js'), /\.\.\.\(characterName && \{ characterName \}\)/);
    assert.match(read('backend', 'server.js'), /speaker: \{ type: 'STRING' \},/);
});

test('refPieces: the clearest lines in order until about 6 s, never more than 10 s or 4 lines', () => {
    const at = (start, end) => ({ start, end });
    let p = refPieces([at(10, 14), at(20, 23), at(30, 31)]);
    assert.equal(p.length, 2, 'stops once there is enough voice');
    assert.ok(Math.abs(p[0].start - 10.04) < 1e-9 && Math.abs(p[0].end - 13.96) < 1e-9, 'trimmed at both ends');
    p = refPieces([at(0, 30)]);
    assert.equal(p.length, 1);
    assert.ok(p[0].end - p[0].start <= 10 + 1e-9, 'one long line is cut to 10 s');
    p = refPieces([at(0, 1.2), at(2, 3.2), at(4, 5.2), at(6, 7.2), at(8, 9.2)]);
    assert.equal(p.length, 4, 'at most four lines joined');
    assert.deepEqual(refPieces([at(0, 0.5), at(1, 1.7)]), [], 'lines too short to hear a voice in');
});

test('planClips: a calm main clip, and a clip of each feeling the actor speaks enough of', () => {
    const { planClips } = require('../backend/routes/voice-capture');
    const at = (start, len, emotion) => ({ start, end: start + len, emotion });
    const lines = [
        at(0, 2.5, 'Angry'), at(10, 2, 'Neutral'), at(20, 2, 'Neutral'), at(30, 1.5, 'Angry'),
        at(40, 1.2, 'Sad'), at(50, 3, 'Whisper'), at(60, 0.6, 'Fear'),
    ];
    const plans = planClips(lines, null);
    const main = plans.find((p) => p.emotion === null);
    assert.equal(main.calm, true, 'cut from the calm lines only');
    assert.deepEqual(main.pieces.map((p) => Math.round(p.start)), [10, 20]);
    assert.deepEqual(plans.filter((p) => p.emotion).map((p) => p.emotion), ['Angry', 'Whisper'], 'Sad (1.1 s) and Fear (too short) get none');
    assert.deepEqual(plans.find((p) => p.emotion === 'Angry').pieces.map((p) => Math.round(p.start)), [0, 30]);

    // hardly a calm word: the main clip is their clearest lines, whatever the feeling
    const loud = planClips([at(0, 3, 'Angry'), at(5, 3, 'Angry'), at(9, 1, 'Neutral')], null);
    assert.equal(loud.find((p) => p.emotion === null).calm, false);
    assert.ok(loud.some((p) => p.emotion === 'Angry'));

    // a voice from an earlier episode: only what it lacks
    assert.deepEqual(planClips(lines, new Set(['Neutral', 'Angry'])).map((p) => p.emotion), ['Whisper']);
    const noCalm = planClips(lines, new Set(['Angry']));
    assert.deepEqual(noCalm.map((p) => [p.emotion, p.calm]), [[null, true], ['Whisper', false]], 'gets the calm clip it had none of');
    assert.deepEqual(planClips([at(0, 3, 'Angry')], new Set()).map((p) => p.emotion), ['Angry'], 'never a non-calm main clip for a known voice');
});

// 员工 (E47) was cloned from 1.3 s of one excited line and sounded least like her actor: a voice
// whose clip was found here, is not calm and is short gets a longer one from a later episode.
test('planClips: a short clip that is not calm is replaced by a longer one', () => {
    const { planClips } = require('../backend/routes/voice-capture');
    const at = (start, len, emotion) => ({ start, end: start + len, emotion });
    const loud = [at(0, 2.5, 'Excited'), at(5, 2, 'Excited')]; // 4.4 s, no calm
    const main = (p) => p.find((x) => x.emotion === null);
    assert.equal(main(planClips(loud, new Set(), { seconds: 1.3, own: true })).calm, false, '1.3 s -> 4.4 s');
    assert.equal(main(planClips(loud, new Set(), { seconds: 3.8, own: true })), undefined, 'not 1 s longer');
    assert.equal(main(planClips(loud, new Set(), { seconds: 4.6, own: true })), undefined, 'long enough already');
    assert.equal(main(planClips(loud, new Set(), { seconds: 1.3, own: false })), undefined, 'a clip picked by hand stays');
    assert.equal(main(planClips(loud, new Set(['Neutral']), { seconds: 1.3, own: true })), undefined, 'a calm clip stays');
    const calm = [...loud, at(10, 2, 'Neutral'), at(20, 2, 'Neutral')];
    assert.equal(main(planClips(calm, new Set(), { seconds: 4.6, own: true })).calm, true, 'calm still wins, whatever the length');
});

test('wavSeconds reads a clip\'s length from its header', () => {
    const { wavSeconds } = require('../backend/routes/voice-capture');
    const os = require('node:os');
    const rate = 44100;
    const data = Buffer.alloc(rate * 2 * 1.5); // 1.5 s, mono 16-bit
    const head = Buffer.alloc(44);
    head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8);
    head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
    head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
    head.write('data', 36); head.writeUInt32LE(data.length, 40);
    const file = path.join(os.tmpdir(), `drd-clip-${process.pid}.wav`);
    fs.writeFileSync(file, Buffer.concat([head, data]));
    try {
        assert.ok(Math.abs(wavSeconds(file) - 1.5) < 1e-9);
    } finally {
        fs.unlinkSync(file);
    }
    assert.equal(wavSeconds(null), null);
    assert.equal(wavSeconds(__filename), null, 'not a wav');
});

test('the page sends its clip, takes a longer one and marks a voice with a weak clip', () => {
    const src = read('frontend', 'js', 'vox-speakers.js');
    assert.match(src, /\.\.\.\(ownClip\(p\) && \{ own: true, clip: p\.audioPath, clipSeconds: p\.clipSeconds \|\| null \}\)/);
    assert.match(src, /if \(s\.filePath && !known\.calmClip && ownClip\(known\)\) \{\n\s+Object\.assign\(known, \{ audioPath: s\.filePath, audioName: s\.fileName, autoClip: s\.filePath, calmClip: !!s\.calm, clipSeconds: s\.clipSeconds \}\);/);
    assert.match(src, /ownClip\(p\) && !p\.calmClip \? `<span class="vsp-weak" title="\$\{WEAK_CLIP\}">/);
    const route = read('backend', 'routes', 'voice-capture.js');
    assert.match(route, /planClips\(refLines, have, sp\.known \? mainOf\.get\(sp\.known\) : null\)/);
});

test('a line takes its feeling from the actor saying it, else their clip of that feeling; the voice stays the voice\'s own clip', () => {
    const main = read('frontend', 'js', 'studio-main.js');
    const fn = main.slice(main.indexOf('async function executeVoxCpm2Synthesis('));
    const head = fn.slice(0, fn.indexOf('let refBase64'));
    // One voice in every feeling: the feeling clip goes beside the voice's clip, never in its place.
    assert.doesNotMatch(head, /profile = \{ \.\.\.profile, audioPath/);
    const own = head.indexOf('/api/voice-capture/line');
    const clip = head.indexOf('feeling = feelingKey && profile.emotionClips[feelingKey]');
    assert.ok(own > 0 && clip > own, 'the line\'s own delivery first, the feeling clip after');
    assert.match(head.slice(clip), /if \(!feelingBase64 && feeling\?\.path/);
    assert.doesNotMatch(head, /checkPathExists\?*\.?\(/, 'app:checkPathExists makes a folder of a missing path');
    assert.match(fn, /refBase64 = rRes\.base64 \|\| rRes\.data/, 'app:readFileAsBase64 answers base64');
    assert.match(fn, /feeling_audio_base64: feelingBase64/);
    const page = read('frontend', 'js', 'vox-speakers.js');
    assert.match(page, /emotion: s\.emotion \|\| "Neutral"/, 'each line\'s feeling goes to the backend');
    assert.match(page, /emotions: clipsHave\(p\)/, 'with what each earlier voice already has');
});

function loadSpeakersModule() {
    const window = {};
    const document = { addEventListener() {}, getElementById: () => null };
    vm.runInNewContext(read('frontend', 'js', 'vox-speakers.js'), { window, document, localStorage: { getItem: () => null, setItem() {} }, console });
    return window.voxSpeakers;
}

test('a series is the video\'s folder, past the folders Dub Whole Series makes', () => {
    const mod = loadSpeakersModule();
    const seriesOf = (p) => ({ ...mod.seriesOf(p) }); // an object of this realm, for deepEqual
    const ep = seriesOf('C:\\Dramas\\My Series\\E03.mp4');
    assert.deepEqual(ep, { key: 'c:/dramas/my series', name: 'My Series' });
    assert.deepEqual(seriesOf('C:\\Dramas\\My Series\\E17.mkv'), ep, 'every episode of the folder');
    assert.deepEqual(seriesOf('C:/Dramas/My Series/DR Dubber Joined/DR Dubber Split/My Series_part01_a.mp4'), ep);
    assert.deepEqual(seriesOf('/Users/me/Dramas/My Series/DR Dubber Joined/My Series_part02.mp4').name, 'My Series');
    // a movie lying loose in Downloads is a series of its own
    const a = seriesOf('C:\\Users\\me\\Downloads\\Movie A.mp4');
    const b = seriesOf('C:\\Users\\me\\Downloads\\Movie B.mp4');
    assert.equal(a.name, 'Movie A');
    assert.notEqual(a.key, b.key);
    assert.equal(seriesOf('D:\\Movie C.mp4').name, 'Movie C');
});

test('voicing a tab finds its speakers first, and the server speaks /api/speakers', () => {
    const main = read('frontend', 'js', 'studio-main.js');
    const gen = main.slice(main.indexOf('async function generateStandardAudioForProject('));
    const hook = gen.indexOf('window.voxSpeakers.ensure(targetProject)');
    assert.ok(hook > 0, 'generateStandardAudioForProject asks for the speakers');
    assert.ok(hook < gen.indexOf('const processSingleAudio'), '...before any line is voiced');
    assert.match(gen.slice(0, hook + 200), /voxCmp2Data\.cloneFromVideo/);
    assert.match(gen.slice(hook, hook + 200), /voxCmp2Data = voxCmp2Load\(\)/, 'reloads the new profiles');

    const html = read('frontend', 'index.html');
    assert.ok(html.indexOf('<script src="js/vox-speakers.js">') > html.indexOf('<script src="js/studio-main.js">'), 'loaded after studio-main.js');
    for (const id of ['btn-vox-speakers', 'voxcmp2-clone-toggle', 'voxcmp2-clone-knob']) assert.ok(html.includes(`id="${id}"`), id);

    const page = read('frontend', 'js', 'vox-speakers.js');
    assert.match(page, /\/api\/voice-capture\/speakers/);
    const route = read('backend', 'routes', 'voice-capture.js');
    assert.match(route, /router\.post\('\/voice-capture\/speakers'/);
    assert.match(route, /\$\{base\}\/api\/speakers/);

    const py = read('backend', 'python', 'voxcpm2_server.py');
    assert.match(py, /route == "\/api\/speakers"/);
    assert.ok(py.indexOf('route == "/api/speakers"') < py.indexOf('Loading the model back after another GPU job'), 'answers while the model loads');
    assert.match(py, /import voxcpm2_speakers/);
    assert.match(read('backend', 'python', 'voxcpm2_speakers.py'), /def find_speakers\(wav, lines, known=None/);
});

test('lines landing in a tab start the search on their own; a translation keeps their speakers', () => {
    const main = read('frontend', 'js', 'studio-main.js');
    const fn = main.slice(main.indexOf('function autoAssignVoxProfiles('), main.indexOf('// --- EXPORT SRT ---'));
    assert.match(fn, /window\.voxSpeakers\?\.soon\(proj \|\| projects\[activeProjectIndex\]\)/);
    assert.ok(fn.indexOf('sub.gender = sub.voxSpeaker') < fn.indexOf('sub.gender = firstMale.id'), 'a found speaker before the first Male voice');
    const page = read('frontend', 'js', 'vox-speakers.js');
    assert.match(page, /function soon\(proj\)/);
    assert.match(page, /if \(busy\(proj\)\) return soon\(proj\)/, 'waits until the tab is done transcribing');
    assert.match(page, /if \(!\(await serverUp\(load\(\)\.serverUrl\)\)\) return;/, 'quiet when the server is not running');
});

test('voxcpm2_speakers.py ships beside app.py: on install and on every Start Server', () => {
    assert.match(read('backend', 'lib', 'voxcpm-installer.js'), /copyFileSync\(path\.join\(scriptsDir, 'voxcpm2_speakers\.py'\), path\.join\(dir, 'voxcpm2_speakers\.py'\)\)/);
    assert.match(read('main.js'), /\['voxcpm2_speakers\.py', path\.join\(scriptDir, 'voxcpm2_speakers\.py'\)\]/);
});
