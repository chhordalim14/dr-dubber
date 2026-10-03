// Regression tests for the Auto-Fit / audio-ownership timing logic and the
// multi-tab generation queue's "which subtitles still need audio" filter.
//
// NOTE on what this does and doesn't cover: the real implementations of
// isAudioOwnedByOwnText() and the Auto-Fit pass live inline inside
// frontend/js/studio-main.js, not as an exported, independently-importable
// function - they're defined inside the renderer's closures and talk to
// live DOM/project state. Pulling them out into a standalone module would
// be a logic-level refactor (not the pure relocation this pass stuck to),
// so for now this file is a *specification* test: it re-implements the
// documented algorithm from the original scratch/test_e2e_tts_and_autofit.js
// script and pins the behavior that script was written to confirm (fixing
// a bug where drifted/inverted audioStart/audioEnd intervals corrupted
// subtitle timing). If the inline implementation in studio-main.js and this
// spec ever diverge, that's a sign the two need to be reconciled - ideally
// by extracting the real function into an importable module and deleting
// the copy here.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

function isAudioOwnedByOwnText(sub) {
    const textStart = parseFloat(sub.textStart);
    const textEnd = parseFloat(sub.textEnd);
    const audioStart = parseFloat(sub.audioStart);
    const audioEnd = parseFloat(sub.audioEnd);
    if (isNaN(textStart) || isNaN(audioStart) || isNaN(audioEnd)) return false;
    if (audioStart >= audioEnd) return false; // Inverted or zero width is NEVER valid owned audio
    const overlapStart = Math.max(textStart, audioStart);
    const overlapEnd = Math.min(textEnd, audioEnd);
    return overlapEnd > overlapStart;
}

function sanitizeInvertedInterval(sub) {
    const aStart = parseFloat(sub.audioStart);
    const aEnd = parseFloat(sub.audioEnd);
    const tStart = parseFloat(sub.textStart || 0);
    const tEnd = parseFloat(sub.textEnd || tStart + 2);
    if (isNaN(aStart) || isNaN(aEnd) || aStart >= aEnd) {
        const dur = sub.baseAudioDuration && sub.baseAudioDuration > 0 ? (sub.baseAudioDuration / (sub.speed || 1.0)) : (tEnd - tStart);
        sub.audioStart = tStart.toFixed(2);
        sub.audioEnd = (tStart + Math.max(0.2, dur)).toFixed(2);
    }
    return sub;
}

describe('isAudioOwnedByOwnText', () => {
    test('rejects an inverted interval (audioStart >= audioEnd)', () => {
        const sub = { textStart: '270.00', textEnd: '273.00', audioStart: '274.00', audioEnd: '272.00' };
        assert.equal(isAudioOwnedByOwnText(sub), false);
    });

    test('accepts an interval that overlaps its own text window', () => {
        const sub = { textStart: '10.00', textEnd: '12.00', audioStart: '10.00', audioEnd: '13.50' };
        assert.equal(isAudioOwnedByOwnText(sub), true);
    });

    test('rejects non-numeric timings', () => {
        assert.equal(isAudioOwnedByOwnText({ textStart: 'x', textEnd: '12', audioStart: '10', audioEnd: '13' }), false);
    });
});

describe('sanitizeInvertedInterval (restoreProjectState repair pass)', () => {
    test('repairs an inverted audioStart/audioEnd back to a valid, owned interval', () => {
        const sub = sanitizeInvertedInterval({
            id: 'sub-3', textStart: '270.00', textEnd: '273.00',
            audioStart: '274.00', audioEnd: '272.00',
            baseAudioDuration: 2.8, speed: 1.0, audioStatus: 'ready'
        });
        assert.ok(parseFloat(sub.audioStart) < parseFloat(sub.audioEnd));
        assert.equal(sub.audioStart, '270.00');
        assert.equal(isAudioOwnedByOwnText(sub), true);
    });

    test('leaves an already-valid interval untouched', () => {
        const sub = sanitizeInvertedInterval({
            textStart: '10.00', textEnd: '12.00', audioStart: '10.50', audioEnd: '14.50',
            baseAudioDuration: 3.5, speed: 1.0, audioStatus: 'ready'
        });
        assert.equal(sub.audioStart, '10.50');
        assert.equal(sub.audioEnd, '14.50');
    });
});

describe('multi-tab generation queue targeting', () => {
    function pendingAudioFilter(s) {
        return s.audioStatus === 'idle' || s.audioStatus === 'error' || !s.file;
    }

    test('targets only tabs that have pending (idle/error/missing-file) subtitles', () => {
        const projects = [
            { id: 'tab-1', subtitles: [{ audioStatus: 'ready', file: 'a.mp3' }, { audioStatus: 'ready', file: 'b.mp3' }] },
            { id: 'tab-2', subtitles: [{ audioStatus: 'ready', file: 'c.mp3' }, { audioStatus: 'idle', file: null }, { audioStatus: 'error', file: null }] },
            { id: 'tab-3', subtitles: [{ audioStatus: 'idle', file: null }, { audioStatus: 'idle', file: null }] }
        ];

        const anyPending = projects.some(p => (p.subtitles || []).some(pendingAudioFilter));
        assert.equal(anyPending, true);

        const targeted = projects
            .map(p => ({ id: p.id, idsToGenerate: p.subtitles.filter(pendingAudioFilter) }))
            .filter(t => t.idsToGenerate.length > 0);

        assert.equal(targeted.length, 2);
        assert.equal(targeted[0].id, 'tab-2');
        assert.equal(targeted[0].idsToGenerate.length, 2);
        assert.equal(targeted[1].id, 'tab-3');
        assert.equal(targeted[1].idsToGenerate.length, 2);
    });

    test('a fully-ready project (no pending subtitles) is skipped, not re-queued', () => {
        const projects = [
            { id: 'tab-1', subtitles: [{ audioStatus: 'ready', file: 'a.mp3' }] },
            { id: 'tab-2', subtitles: [{ audioStatus: 'idle', file: null }] }
        ];
        const targeted = projects
            .map(p => ({ id: p.id, idsToGenerate: p.subtitles.filter(pendingAudioFilter) }))
            .filter(t => t.idsToGenerate.length > 0);
        assert.equal(targeted.length, 1);
        assert.equal(targeted[0].id, 'tab-2');
    });
});
