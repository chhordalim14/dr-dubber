// Fix Rushed Lines (replaces the old Fix Fast Audio window): the amber "N rushed" chip sits
// beside Auto-Fit and only shows while a line is rushed; the dialog is review → busy → results.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'frontend', 'js', 'studio-main.js'), 'utf8').replace(/\r\n/g, '\n');

test('the chip sits right after Auto-Fit and the old window is gone', () => {
    const autoFit = html.indexOf('id="btn-auto-fit"');
    const chip = html.indexOf('id="btn-fix-fast-audio"');
    const syncEnd = html.indexOf('id="btn-match-audio-end"');
    assert.ok(autoFit > 0 && chip > autoFit && chip < syncEnd, 'between Auto-Fit and Sync End');
    assert.match(html.slice(chip, chip + 200), /class="hidden rushed-chip/);
    assert.ok(!html.includes('id="modal-fix-fast-audio"'));
    assert.ok(!html.includes('id="badge-fast-subs-count"'));
    for (const id of ['modal-fix-rushed', 'rushed-phase-review', 'rushed-phase-busy', 'rushed-phase-results', 'rushed-primary', 'rushed-cancel', 'rushed-close']) {
        assert.ok(html.includes(`id="${id}"`), id);
    }
    assert.match(html, /href="css\/fix-rushed\.css"/);
});

test('the chip shows "N rushed" only while lines are rushed', () => {
    const start = main.indexOf('    function updateFastAudioBadge() {');
    const end = main.indexOf('    window.updateFastAudioBadge = updateFastAudioBadge;');
    const classes = new Set(['hidden']);
    const btn = { dataset: {}, title: '', classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
    const label = { textContent: '' };
    let fast = [];
    const ctx = {
        document: { getElementById: (id) => (id === 'btn-fix-fast-audio' ? btn : id === 'text-fix-fast-audio' ? label : null) },
        projects: [{}], activeProjectIndex: 0, fastRevoiceBusy: false,
        getFastSubtitles: () => fast,
    };
    vm.createContext(ctx);
    vm.runInContext(`${main.slice(start, end)}\nthis.update = updateFastAudioBadge;`, ctx);
    ctx.update();
    assert.ok(classes.has('hidden'), 'no rushed line: hidden');
    fast = [{}, {}, {}];
    ctx.update();
    assert.equal(label.textContent, '3 rushed');
    assert.ok(!classes.has('hidden') && classes.has('inline-flex'));
    fast = [];
    ctx.update();
    assert.ok(classes.has('hidden'));
});

test('one Rewrite / Apply button drives the phases; the engine is unchanged', () => {
    assert.match(main, /if \(rushed\.phase === "review"\) condenseAllFastSubtitles\(\);\n\s+else if \(rushed\.phase === "results"\) applyAndRevoiceAllFastSubtitles\(\);/);
    // Dub Whole Series still uses the same fit (no dialog)
    assert.match(main, /async function fitFastLinesAllTabs\(/);
    assert.match(main, /function extendAllRushedIntoFreeTime\(\)/);
});
