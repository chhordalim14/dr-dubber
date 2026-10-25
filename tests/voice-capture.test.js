// VoxCPM2 Capture Voice from Movie + Voice Groups: the backend's channel and EQ
// helpers, and which voices a tab's lines may use once it has a voice group.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { layoutHasCenter, eqFilters } = require('../backend/routes/voice-capture');

test('Dialogue only is offered for soundtracks with a centre channel', () => {
    for (const l of ['5.1', '5.1(side)', '7.1', '3.0', '6.1']) assert.equal(layoutHasCenter(l, 6), true, l);
    for (const l of ['stereo', 'mono', '2.1', 'quad', '6.0(front)']) assert.equal(layoutHasCenter(l, 2), false, l);
    assert.equal(layoutHasCenter('', 6), true, 'unlabelled 6-channel track is 5.1');
    assert.equal(layoutHasCenter('', 2), false);
});

test('Voice EQ becomes clamped ffmpeg filters; flat bands are dropped', () => {
    const f = eqFilters([
        { type: 'lowshelf', f: 120, g: 3, q: 0.7 },
        { type: 'peaking', f: 99999, g: 40, q: 1 },
        { type: 'highshelf', f: 8000, g: 0, q: 0.7 },
        { type: 'evil;rm', f: 'x', g: -2, q: 1 },
    ]);
    assert.deepEqual(f, [
        'lowshelf=f=120:g=3.00:t=q:w=0.700',
        'equalizer=f=20000:t=q:w=1.000:g=18.00',
        'equalizer=f=1000:t=q:w=1.000:g=-2.00',
    ]);
    assert.deepEqual(eqFilters(null), []);
});

test('the route is mounted and saves only into a full local folder', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
    assert.match(server, /app\.use\('\/api', require\('\.\/routes\/voice-capture'\)\(/);
    const route = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'voice-capture.js'), 'utf8');
    assert.match(route, /isNetworkPath\(want\) \|\| !full/);
});

function loadGroups(projects, activeProjectIndex) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'vox-groups.js'), 'utf8');
    const ctx = { projects, activeProjectIndex, crypto: require('node:crypto'), document: { readyState: 'loading', addEventListener() { }, dispatchEvent() { } }, window: {}, Event: class { } };
    vm.createContext(ctx);
    // `let` globals in the page are plain bindings, as studio-main.js declares them
    vm.runInContext(`${src}\nthis.api = { voxCmp2ScopedProfiles, voxGroupCreate, voxGroupsPrune, voxGroupOfProject };`, ctx);
    return ctx.api;
}

test('a tab with a voice group only offers that group; no group or an empty one offers all', () => {
    const profiles = [
        { id: 'a', gender: 'Male' },
        { id: 'b', gender: 'Female' },
        { id: 'c', gender: 'Female' },
    ];
    const data = { profiles, groups: [{ id: 'g1', name: 'Movie', profileIds: ['c', 'gone'] }, { id: 'g2', name: 'Empty', profileIds: [] }] };
    const projects = [{ voxGroupId: 'g1' }, { voxGroupId: null }, { voxGroupId: 'g2' }, { voxGroupId: 'deleted' }];
    const api = loadGroups(projects, 0);
    assert.deepEqual(api.voxCmp2ScopedProfiles(data).map((p) => p.id), ['c'], 'active tab');
    assert.deepEqual(api.voxCmp2ScopedProfiles(data, projects[1]).map((p) => p.id), ['a', 'b', 'c']);
    assert.deepEqual(api.voxCmp2ScopedProfiles(data, projects[2]).map((p) => p.id), ['a', 'b', 'c']);
    assert.deepEqual(api.voxCmp2ScopedProfiles(data, projects[3]).map((p) => p.id), ['a', 'b', 'c']);
    api.voxGroupsPrune(data);
    assert.deepEqual(data.groups[0].profileIds, ['c']);
    const g = api.voxGroupCreate(data, '  Squid Game  ');
    assert.equal(g.name, 'Squid Game');
    assert.notEqual(g.color, data.groups[0].color);
});

test('generation keeps a line\'s own voice but voices plain Male/Female lines from the group', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = main.indexOf('    function resolveSmartVoxCpmProfile(');
    const end = main.indexOf('\n    }\n', start) + 6;
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(`${main.slice(start, end)}\nthis.resolve = resolveSmartVoxCpmProfile;`, ctx);
    const all = [{ id: 'x1', label: 'Dara', gender: 'Male' }, { id: 'y1', label: 'Srey', gender: 'Female' }, { id: 'x2', label: 'Vibol', gender: 'Male' }];
    const pool = [all[2]];
    assert.equal(ctx.resolve('y1', all, pool).id, 'y1', 'an exact profile id wins even outside the group');
    assert.equal(ctx.resolve('Male', all, pool).id, 'x2', 'Male comes from the group');
    assert.equal(ctx.resolve('Female', all, [all[0], all[1]]).id, 'y1', 'by the profile gender, not its name');
    assert.equal(ctx.resolve('Female', all).id, 'y1', 'no group: all profiles');
    // every generation path passes the tab's group
    assert.equal((main.match(/resolveSmartVoxCpmProfile\(voxVoiceTagOf\(sub, voxCmp2Data\.profiles\), voxCmp2Data\.profiles, voxCmp2ScopedProfiles\(voxCmp2Data, (targetProject|proj)\)\)/g) || []).length, 2);
});

test('the voice-capture page script loads after studio-main, the groups script before it', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
    const at = (s) => html.indexOf(`<script src="js/${s}"></script>`);
    assert.ok(at('vox-groups.js') > 0 && at('vox-groups.js') < at('studio-main.js'));
    assert.ok(at('voice-capture.js') > at('studio-main.js'));
    assert.ok(at('vox-gallery.js') > at('studio-main.js'));
    assert.match(html, /id="btn-voice-capture"/);
    assert.match(html, /id="modal-vox-groups"/);
});

test('every VoxCPM2 line is sent with its emotion, its room and where the actor said it', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8');
    // Generate All / Dub Whole Series once sent no emotion: every line came out Neutral.
    const calls = page.split('await executeVoxCpm2Synthesis({').slice(1).map((c) => c.slice(0, c.indexOf('});')));
    assert.ok(calls.length >= 2, 'both generate paths call it');
    for (const c of calls) {
        assert.match(c, /emotion: sub\.emotion/);
        assert.match(c, /fitSeconds: voiceSlot\(sub\)/);
        assert.match(c, /line: voxLineSource\(/);
    }
    // Generate All / Dub Whole Series find the speakers before voicing a tab, like Generate does.
    const queue = page.slice(page.indexOf('async function voxCmp2RunQueueLoop()'));
    assert.ok(queue.indexOf('voxSpeakers.ensure(proj)') > 0 && queue.indexOf('voxSpeakers.ensure(proj)') < queue.indexOf('for (const sub of pendingSubs)'));
    // The original actor's audio only for a voice cloned from this video.
    assert.match(page, /if \(line && profile\?\.autoClip && profile\?\.audioPath\)/);
    const server = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
    assert.match(server, /require\('\.\/routes\/voice-capture'\)\(\{[^}]*findVocalStem/);
    for (const f of ['fit_seconds', 'feeling_audio_base64', 'feeling_from', 'line_level_db']) assert.match(server, new RegExp(`${f}:`), f);
});

test('a line\'s loudness is measured on its speech, not its pauses; wav data is found past other chunks', () => {
    const { speechLevelDb, framePowers, wavData } = require('../backend/routes/voice-capture');
    const rate = 8000;
    const tone = (amp, sec) => {
        const b = Buffer.alloc(Math.round(rate * sec) * 2);
        for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin(i / 3)), i * 2);
        return b;
    };
    const level = (...parts) => {
        const fp = framePowers(rate);
        for (const p of parts) for (let i = 0; i < p.length; i += 333) fp.push(p.subarray(i, i + 333)); // odd pieces
        return speechLevelDb(fp.frames);
    };
    const loud = level(tone(0.5, 1));
    assert.ok(Math.abs(loud - level(tone(0.5, 1), Buffer.alloc(rate * 4))) < 0.01, 'silence between lines does not count');
    assert.ok(Math.abs(level(tone(0.05, 1)) - loud + 20) < 0.1, 'a tenth of the amplitude is 20 dB under');
    assert.equal(level(Buffer.alloc(rate * 2)), null, 'no speech, no level');
    const head = Buffer.alloc(12); head.write('RIFF', 0); head.write('WAVE', 8);
    const chunk = (id, data) => { const h = Buffer.alloc(8); h.write(id, 0); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data]); };
    const data = tone(0.3, 0.1);
    assert.deepEqual(wavData(Buffer.concat([head, chunk('fmt ', Buffer.alloc(16)), chunk('LIST', Buffer.alloc(5)), Buffer.alloc(1), chunk('data', data)])), data);
});
