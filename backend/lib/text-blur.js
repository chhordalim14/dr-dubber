// Burned-in subtitles found by backend/python/text_detector.py are blurred in the render only
// while they show. A segment is { start, end, x, y, w, h }: seconds, and % of the source frame.
//
// The blur goes on the source picture before anything else (flip, crop, scale, pan), so it
// stays on the text whatever the export settings. Segments with the same box share one chain:
// crop the box, blur it, feather its edges (a hard-edged blurred box shows), and overlay it
// back only during that box's times (FFmpeg timeline `enable`, so it costs nothing in between).
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

// Filter-graph parts that blur the segments on [inTag] and output [outTag], or null (nothing
// to blur). width/height: the frame size [inTag] has (after FFmpeg's auto-rotation).
function buildTextBlurFilters(segments, { width, height, inTag = '0:v', outTag = 'v_textblur' }) {
    if (!(width > 0 && height > 0)) return null;
    const groups = groupBoxes(segments, width, height);
    if (!groups.length) return null;
    const parts = [];
    parts.push(`[${inTag}]split=${groups.length + 1}[tb_main]${groups.map((g, i) => `[tb_src${i}]`).join('')}`);
    let cur = 'tb_main';
    groups.forEach((g, i) => {
        const minSide = Math.min(g.w, g.h);
        const luma = Math.max(1, Math.min(Math.round(g.h * BLUR_OF_HEIGHT), Math.floor(minSide / 2) - 1));
        const chroma = Math.max(1, Math.min(Math.round(luma / 2), Math.floor(minSide / 4) - 1));
        const feather = Math.max(2, Math.min(Math.round(g.h * FEATHER_OF_HEIGHT), Math.floor(minSide / 2) - 1));
        const enable = enableExpr(g.ranges);
        const next = i === groups.length - 1 ? outTag : `tb_out${i}`;
        // One frame of mask is enough: the merge keeps using the last mask frame.
        parts.push(`nullsrc=s=${g.w}x${g.h}:r=1:d=1,format=gray,geq=lum='255*min(1\\,min(X\\,W-1-X)/${feather})*min(1\\,min(Y\\,H-1-Y)/${feather})'[tb_mask${i}]`);
        parts.push(`[tb_src${i}]crop=${g.w}:${g.h}:${g.x}:${g.y},boxblur=${luma}:2:${chroma}:2:enable='${enable}',format=yuva420p[tb_blur${i}]`);
        parts.push(`[tb_blur${i}][tb_mask${i}]alphamerge[tb_soft${i}]`);
        parts.push(`[${cur}][tb_soft${i}]overlay=${g.x}:${g.y}:enable='${enable}'[${next}]`);
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

module.exports = { buildTextBlurFilters, groupBoxes, mergeRanges, cleanSegments, probeDisplaySize };
