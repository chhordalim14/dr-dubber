// Burned-in subtitles found by backend/python/text_detector.py are blurred in the render only
// while they show. A segment is { start, end, x, y, w, h }: seconds, and % of the source frame.
//
// The blur goes on the source picture before anything else (flip, crop, scale, pan), so it
// stays on the text whatever the export settings. Segments with the same box share one box;
// boxes on the same rows share a strip, and each strip is ONE chain (buildTextBlurFilters):
// blurred once, put back through a soft-edged mask that shows each box only during its times
// (FFmpeg timeline `enable`, so it costs nothing in between).
//
// Every overlay copies the picture it draws on (30 boxes overlaid on the whole frame made the
// export about 4x slower), so a strip goes back with one overlay. The frame stays yuv420p (no
// alpha plane): FFmpeg would otherwise give the whole picture the alpha, slower to overlay.
const fs = require('fs');
const { execFile } = require('child_process');

const GRID = 0.02;         // box sides snap to 2% of the width, so lines of similar length share a chain
const BLUR_OF_HEIGHT = 0.17;    // blur radius as a share of the box height: text gone, scene still there
const FEATHER_OF_HEIGHT = 0.13; // soft edge as a share of the box height

const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
const even = (v) => Math.max(0, Math.floor(v / 2) * 2);

function cleanSegments(segments) {
    return (Array.isArray(segments) ? segments : [])
        .map((s) => ({ start: num(s && s.start), end: num(s && s.end), x: num(s && s.x), y: num(s && s.y), w: num(s && s.w), h: num(s && s.h) }))
        .filter((s) => [s.start, s.end, s.x, s.y, s.w, s.h].every(Number.isFinite) && s.end > s.start && s.w > 0 && s.h > 0);
}

// Overlapping or touching time ranges joined: [[a, b], ...] sorted.
function mergeRanges(ranges, gap = 0.05) {
    const sorted = ranges.map((r) => [...r]).sort((p, q) => p[0] - q[0]);
    const out = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1] + gap) last[1] = Math.max(last[1], r[1]);
        else out.push(r);
    }
    return out;
}

// Segments -> boxes in pixels of a width x height frame, each with its merged time ranges.
function groupBoxes(segments, width, height) {
    const grid = Math.max(2, even(width * GRID));
    const groups = new Map();
    for (const s of cleanSegments(segments)) {
        let x0 = Math.floor((width * Math.max(0, s.x)) / 100 / grid) * grid;
        let x1 = Math.ceil((width * Math.min(100, s.x + s.w)) / 100 / grid) * grid;
        let y0 = even((height * Math.max(0, s.y)) / 100);
        let y1 = Math.ceil((height * Math.min(100, s.y + s.h)) / 100 / 2) * 2;
        x1 = Math.min(even(width), x1);
        y1 = Math.min(even(height), y1);
        if (x1 - x0 < 8 || y1 - y0 < 8) continue;
        const key = `${x0}:${y0}:${x1 - x0}:${y1 - y0}`;
        if (!groups.has(key)) groups.set(key, { x: x0, y: y0, w: x1 - x0, h: y1 - y0, ranges: [] });
        groups.get(key).ranges.push([Math.max(0, s.start), s.end]);
    }
    return [...groups.values()].map((g) => ({ ...g, ranges: mergeRanges(g.ranges) }));
}

const enableExpr = (ranges) => ranges.map(([a, b]) => `between(t,${a.toFixed(2)},${b.toFixed(2)})`).join('+');

// Boxes whose rows overlap or nearly touch (2% of the height) share one strip: the smallest
// rectangle around them. All sides stay even, as the boxes' are.
function groupStrips(groups, height) {
    const gap = even(height * 0.02);
    const strips = [];
    for (const g of [...groups].sort((p, q) => p.y - q.y)) {
        const last = strips[strips.length - 1];
        if (last && g.y <= last.y1 + gap) {
            last.boxes.push(g);
            last.y1 = Math.max(last.y1, g.y + g.h);
        } else {
            strips.push({ y0: g.y, y1: g.y + g.h, boxes: [g] });
        }
    }
    return strips.map((s) => {
        const x = Math.min(...s.boxes.map((g) => g.x));
        const w = Math.max(...s.boxes.map((g) => g.x + g.w)) - x;
        return { x, y: s.y0, w, h: s.y1 - s.y0, boxes: s.boxes, ranges: mergeRanges(s.boxes.flatMap((g) => g.ranges)) };
    });
}

const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

// Filter-graph parts that blur the segments on [inTag] and output [outTag], or null (nothing
// to blur). width/height: the frame size [inTag] has (after FFmpeg's auto-rotation).
//
// One chain per strip (row of boxes), not one per box: the strip is cut out and blurred once
// (while any of its boxes shows); a mask made from the strip's own frames (so it keeps the
// video's timing) gets a white rectangle per box, switched on only during that box's times,
// then its edges are softened; the blurred strip goes back through that mask with one overlay.
// Per box only a drawbox is left, which costs next to nothing while it is off. Measured
// 2026-11-08 on a 7:36 tab with 51 boxes in one row (NVENC 6500k, NVIDIA decoding): 125 s ->
// 77 s for the blur alone, 170 s -> 116 s with the export's colour and sharpen chain; the old and
// new outputs differ by 54 dB on average (49 dB worst frame) - the same picture to the eye.
function buildTextBlurFilters(segments, { width, height, inTag = '0:v', outTag = 'v_textblur' }) {
    if (!(width > 0 && height > 0)) return null;
    const groups = groupBoxes(segments, width, height);
    if (!groups.length) return null;
    const strips = groupStrips(groups, height);
    const parts = [];
    parts.push(`[${inTag}]format=yuv420p,split=${strips.length + 1}[tb_main]${strips.map((s, k) => `[tb_full${k}]`).join('')}`);
    let cur = 'tb_main';
    strips.forEach((s, k) => {
        // One blur strength per strip, from its typical box height (subtitle lines in a row
        // share a font size); FFmpeg needs the radius under half the strip's shorter side.
        const h = median(s.boxes.map((g) => g.h));
        const side = Math.min(s.w, s.h);
        const luma = Math.max(1, Math.min(Math.round(h * BLUR_OF_HEIGHT), Math.floor(side / 2) - 1));
        const chroma = Math.max(1, Math.min(Math.round(luma / 2), Math.floor(side / 4) - 1));
        const feather = Math.max(2, Math.min(Math.round(h * FEATHER_OF_HEIGHT), Math.floor(side / 2) - 1));
        const r = Math.max(1, Math.round(feather / 2));
        const on = enableExpr(s.ranges);
        parts.push(`[tb_full${k}]crop=${s.w}:${s.h}:${s.x}:${s.y},split=2[tb_src${k}][tb_mbase${k}]`);
        parts.push(`[tb_src${k}]boxblur=${luma}:2:${chroma}:2:enable='${on}',format=yuva420p[tb_blur${k}]`);
        // Each box's rectangle is drawn r inside its edges and the mask blurred by r: clear at
        // the box edge, full about `feather` inside, as the old per-box mask. drawbox on gray
        // draws 235 (TV range): x1.09 makes it 255 - at 92% the text's dark outline showed.
        const boxes = s.boxes.map((g) => `drawbox=x=${g.x - s.x + r}:y=${g.y - s.y + r}:w=${Math.max(2, g.w - 2 * r)}:h=${Math.max(2, g.h - 2 * r)}:color=white:t=fill:enable='${enableExpr(g.ranges)}'`).join(',');
        parts.push(`[tb_mbase${k}]format=gray,lut=c0=0,${boxes},lut=c0=val*1.09,boxblur=${r}:1:enable='${on}'[tb_mask${k}]`);
        parts.push(`[tb_blur${k}][tb_mask${k}]alphamerge[tb_soft${k}]`);
        const next = k === strips.length - 1 ? outTag : `tb_out${k}`;
        parts.push(`[${cur}][tb_soft${k}]overlay=${s.x}:${s.y}:enable='${on}'[${next}]`);
        cur = next;
    });
    return { parts, outTag, boxes: groups.length, segments: groups.reduce((n, g) => n + g.ranges.length, 0) };
}

// The frame size FFmpeg hands to filters: the stream size, swapped for a 90/270 degree
// rotation (FFmpeg auto-rotates). Cached per file and modification time.
const sizeCache = new Map();
function probeDisplaySize(videoPath, ffprobePath) {
    let key = videoPath;
    try { key = `${videoPath}:${fs.statSync(videoPath).mtimeMs}`; } catch (e) { }
    if (sizeCache.has(key)) return Promise.resolve(sizeCache.get(key));
    return new Promise((resolve) => {
        execFile(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:stream_side_data=rotation', '-of', 'json', videoPath],
            { timeout: 15000, windowsHide: true }, (err, stdout) => {
                if (err) return resolve(null);
                try {
                    const st = (JSON.parse(stdout).streams || [])[0] || {};
                    let w = parseInt(st.width, 10), h = parseInt(st.height, 10);
                    const rot = (st.side_data_list || []).map((d) => parseInt(d.rotation, 10)).find((r) => Number.isFinite(r)) || 0;
                    if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
                    const size = w > 0 && h > 0 ? { width: w, height: h } : null;
                    sizeCache.set(key, size);
                    resolve(size);
                } catch (e) { resolve(null); }
            });
    });
}

module.exports = { buildTextBlurFilters, groupBoxes, groupStrips, mergeRanges, cleanSegments, probeDisplaySize };
