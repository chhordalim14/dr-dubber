// backend/lib/text-blur.js: the render's blur for burned-in subtitles, as filter-graph text and
// run through the app's real FFmpeg on a generated clip.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildTextBlurFilters, groupBoxes, mergeRanges, cleanSegments } = require('../backend/lib/text-blur');

const seg = (start, end, x, w, y = 66, h = 7) => ({ start, end, x, y, w, h });

describe('text blur filter graph', () => {
    test('nothing to blur: no filters', () => {
        assert.equal(buildTextBlurFilters([], { width: 1080, height: 1920 }), null);
        assert.equal(buildTextBlurFilters([{ start: 'a' }, { start: 2, end: 1, x: 1, y: 1, w: 1, h: 1 }], { width: 1080, height: 1920 }), null);
        assert.equal(buildTextBlurFilters([seg(1, 2, 30, 40)], { width: 0, height: 0 }), null);
    });

    test('bad entries are dropped, numbers given as text are read', () => {
        const clean = cleanSegments([seg(1, 2, 30, 40), null, { start: '3', end: '4', x: '10', y: '60', w: '20', h: '5' }, seg(5, 5, 1, 1)]);
        assert.equal(clean.length, 2);
        assert.equal(clean[1].start, 3);
    });

    test('touching and overlapping time ranges are joined', () => {
        assert.deepEqual(mergeRanges([[5, 6], [1, 2], [1.9, 3], [3.02, 4]]), [[1, 4], [5, 6]]);
    });

    test('lines of about the same length share one box; boxes are even and inside the frame', () => {
        const groups = groupBoxes([seg(1, 2, 30.1, 39.8), seg(3, 4, 30.5, 39.2), seg(5, 6, 10, 80), seg(7, 8, 95, 10)], 1080, 1920);
        assert.equal(groups.length, 3);
        for (const g of groups) {
            for (const v of [g.x, g.y, g.w, g.h]) assert.equal(v % 2, 0, JSON.stringify(g));
            assert.ok(g.x >= 0 && g.y >= 0 && g.x + g.w <= 1080 && g.y + g.h <= 1920, JSON.stringify(g));
        }
        const shared = groups.find((g) => g.ranges.length === 2);
        assert.ok(shared, 'the two ~40% lines share a box');
        assert.ok(shared.x <= 1080 * 0.301 && shared.x + shared.w >= 1080 * 0.699, 'the shared box covers both lines');
    });

    test('each box is blurred and overlaid only during its own times', () => {
        const tb = buildTextBlurFilters([seg(1, 2, 30, 40), seg(4.5, 6.25, 30, 40), seg(3, 4, 10, 80)], { width: 1080, height: 1920, inTag: 'v_in', outTag: 'v_out' });
        const graph = tb.parts.join(';');
        assert.equal(tb.boxes, 2);
        assert.equal(tb.segments, 3);
        assert.match(graph, /^\[v_in\]split=3\[tb_main\]\[tb_src0\]\[tb_src1\]/);
        assert.match(graph, /enable='between\(t,1\.00,2\.00\)\+between\(t,4\.50,6\.25\)'/);
        assert.match(graph, /enable='between\(t,3\.00,4\.00\)'/);
        assert.match(graph, /overlay=\d+:\d+:enable='[^']+'\[v_out\]$/, 'the last box writes the output tag');
        assert.equal((graph.match(/alphamerge/g) || []).length, 2, 'soft edges on every box');
    });

    test('the blur radius fits FFmpeg limits even for a tiny box', () => {
        const tb = buildTextBlurFilters([seg(1, 2, 50, 1, 50, 0.5)], { width: 1080, height: 1920 });
        const m = tb.parts.join(';').match(/boxblur=(\d+):2:(\d+):2/);
        const [, luma, chroma] = m.map(Number);
        const g = groupBoxes([seg(1, 2, 50, 1, 50, 0.5)], 1080, 1920)[0];
        assert.ok(luma <= Math.floor(Math.min(g.w, g.h) / 2) - 1 || luma === 1);
        assert.ok(chroma <= Math.floor(Math.min(g.w, g.h) / 4) - 1 || chroma === 1);
    });
});

// The real FFmpeg the app ships, on a generated clip: pixels change inside the box only while a
// segment is active, and nowhere else.
const FF = path.join(__dirname, '..', 'backend', 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const haveFF = fs.existsSync(FF);

describe('text blur in FFmpeg', { skip: !haveFF && 'no backend/bin/ffmpeg' }, () => {
    test('blurs the box during its times only, and leaves the rest of the picture alone', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textblur-'));
        try {
            const W = 320, H = 240;
            const tb = buildTextBlurFilters([seg(1, 2, 25, 50, 60, 15)], { width: W, height: H, inTag: '0:v', outTag: 'o' });
            const graphFile = path.join(dir, 'g.txt');
            fs.writeFileSync(graphFile, tb.parts.join(';'));
            const out = path.join(dir, 'o.mkv');
            const src = path.join(dir, 's.mkv');
            const run = (args) => spawnSync(FF, ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
            let r = run(['-f', 'lavfi', '-i', `testsrc2=d=3:s=${W}x${H}:r=10`, '-c:v', 'ffv1', src]);
            assert.equal(r.status, 0, r.stderr);
            r = run(['-i', src, '-/filter_complex', graphFile, '-map', '[o]', '-c:v', 'ffv1', out]);
            assert.equal(r.status, 0, r.stderr);
            const frame = (file, t) => spawnSync(FF, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 }).stdout;
            const diff = (a, b, x0, y0, x1, y1) => {
                let d = 0, n = 0;
                for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { d += Math.abs(a[y * W + x] - b[y * W + x]); n++; }
                return d / n;
            };
            const box = [Math.round(W * 0.32), Math.round(H * 0.63), Math.round(W * 0.68), Math.round(H * 0.72)]; // well inside the box
            const outside = [0, 0, W, Math.round(H * 0.5)];
            const during = [frame(src, 1.5), frame(out, 1.5)];
            const after = [frame(src, 2.5), frame(out, 2.5)];
            assert.ok(diff(...during, ...box) > 3, 'blurred while the segment shows');
            assert.equal(diff(...during, ...outside), 0, 'nothing else changes');
            assert.equal(diff(...after, ...box), 0, 'no blur after the segment');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
