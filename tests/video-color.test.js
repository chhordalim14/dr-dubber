// The export's color grade (backend/lib/video-color.js) matches the editor's CSS preview: black
// stays black. Before, eq=brightness added to every pixel ("K-Drama Glow" exported black as grey).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildColorFilters } = require('../backend/lib/video-color');

const GLOW = { brightness: 110, contrast: 105, saturation: 112, sharpness: 0.5, hue: -4 };

describe('color grade filters', () => {
    test('neutral (and missing values) adds no filter', () => {
        assert.deepEqual(buildColorFilters({ brightness: 100, contrast: 100, saturation: 100, sharpness: 0, hue: 0 }), []);
        assert.deepEqual(buildColorFilters({}), []);
        assert.deepEqual(buildColorFilters(), []);
    });

    test('brightness and contrast scale like CSS (no eq=brightness); saturation, hue and sharpness as before', () => {
        const f = buildColorFilters(GLOW);
        assert.equal(f.length, 4);
        assert.match(f[0], /^lutyuv=y='clip\(125\.5\+\(16\+\(val-16\)\*1\.100-125\.5\)\*1\.050,16,235\)':u='clip\(128\+\(val-128\)\*1\.1550,16,240\)':v=/);
        assert.equal(f[1], 'eq=saturation=1.12');
        assert.equal(f[2], 'hue=h=-4.0');
        assert.equal(f[3], 'unsharp=5:5:0.10:5:5:0.0');
        assert.ok(!f.some((x) => /brightness=/.test(x)));
        assert.deepEqual(buildColorFilters({ saturation: 120 }), ['eq=saturation=1.20'], 'saturation alone: no lut');
    });

    test('the export uses it', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'render_service.js'), 'utf8');
        assert.match(src, /vFilters\.push\(\.\.\.buildColorFilters\(colorAdjustments \|\| videoColorAdj \|\| colorAdj \|\| \{\}\)\)/);
        assert.doesNotMatch(src, /eq=brightness/);
    });
});

const FF = path.join(__dirname, '..', 'backend', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
describe('color grade in FFmpeg', { skip: !fs.existsSync(FF) && 'no backend/bin/ffmpeg' }, () => {
    // Luma of a flat frame (limited range: black 16, white 235) after the grade.
    const lumaAfter = (color, ca) => {
        const W = 16, H = 16;
        const chain = ['format=yuv420p', ...buildColorFilters(ca)].join(',');
        const r = spawnSync(FF, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${W}x${H}:d=0.04`, '-vf', chain,
            '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 1 << 20 });
        assert.equal(r.status, 0, String(r.stderr));
        return r.stdout[0];
    };

    test('K-Drama Glow keeps black black and white white, and lifts the middle ~10%', () => {
        assert.equal(lumaAfter('black', GLOW), 16, 'black stays 16 (eq=brightness made it 31)');
        assert.equal(lumaAfter('white', GLOW), 235);
        const grey = lumaAfter('gray', {}), lifted = lumaAfter('gray', GLOW);
        assert.ok(lifted - grey >= 9 && lifted - grey <= 14, `grey ${grey} -> ${lifted}`);
    });

    test('a darker grade darkens without crushing black below video range', () => {
        assert.equal(lumaAfter('black', { brightness: 80 }), 16);
        assert.ok(lumaAfter('gray', { brightness: 80 }) < lumaAfter('gray', {}));
    });
});
