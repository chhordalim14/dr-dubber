"""Finds burned-in subtitles (lines of on-screen text) in a video and when they show.

Two passes, so a long video stays fast on a CPU:
  1. Row: read ~40 frames spread over the video and find the row where centered text
     lines keep appearing - where the subtitles sit (none: the video has no subtitles).
  2. Timeline: decode only that strip of the picture, a few frames per second, and note
     in which frames a text line shows there and how wide it is.
Text is detected and then read (RapidOCR, PP-OCR models on onnxruntime); a box only
counts when it reads as real text, so faces, hats and leaves don't.

usage: python text_detector.py <video> [--fps 4]
FFmpeg comes from DR_FFMPEG_PATH (ffprobe next to it), like the TTS script.
stdout: "PROGRESS <done> <total>" lines, then one JSON line:
  {"success": true, "width", "height", "duration", "row": {"y", "h"} | null,
   "segments": [{"start", "end", "x", "y", "w", "h"}]}   positions in % of the frame
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

ROW_SAMPLES_MAX = 40
ROW_SAMPLE_WIDTH = 720       # frames read whole in pass 1
STRIP_WIDTH = 540            # strip width in pass 2 (a subtitle line is still ~35 px tall)
MIN_TEXT_SCORE = 0.75        # how sure the reader must be that a box is text
CENTER_TOLERANCE = 22        # % from the middle a subtitle line may be centered
SAME_FRAME_DIFF = 1.5        # mean pixel change below which a strip frame is "the same"
SAME_LINE_TOLERANCE = 2.5    # % of width a line's ends may move and still be the line already read
CJK_RE = re.compile(r'[㐀-䶿一-鿿豈-﫿]')
ALNUM_RE = re.compile(r'[A-Za-z0-9]')


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def progress(done, total):
    sys.stdout.write(f'PROGRESS {done} {total}\n')
    sys.stdout.flush()


def ffmpeg_path():
    return os.environ.get('DR_FFMPEG_PATH') or 'ffmpeg'


def ffprobe_path():
    ff = ffmpeg_path()
    d, name = os.path.split(ff)
    probe = os.path.join(d, name.replace('ffmpeg', 'ffprobe')) if d else 'ffprobe'
    return probe if (not d or os.path.exists(probe)) else 'ffprobe'


def no_window():
    return {'creationflags': 0x08000000} if os.name == 'nt' else {}  # CREATE_NO_WINDOW


def probe(video):
    out = subprocess.run([ffprobe_path(), '-v', 'error', '-select_streams', 'v:0',
                          '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
                          '-of', 'json', video], capture_output=True, text=True, **no_window())
    info = json.loads(out.stdout or '{}')
    st = (info.get('streams') or [{}])[0]
    w, h = int(st.get('width') or 0), int(st.get('height') or 0)
    rot = 0
    for sd in st.get('side_data_list') or []:
        if 'rotation' in sd:
            rot = int(sd['rotation'])
    if abs(rot) % 180 == 90:
        w, h = h, w  # ffmpeg auto-rotates the frames it hands out
    return w, h, float((info.get('format') or {}).get('duration') or 0)


def read_frame(video, t, width):
    """One frame at t seconds, scaled to `width`, as BGR (fast seek)."""
    out = subprocess.run([ffmpeg_path(), '-v', 'error', '-ss', f'{t:.3f}', '-i', video, '-frames:v', '1',
                          '-vf', f'scale={width}:-2', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                         capture_output=True, **no_window())
    return out.stdout


def make_engine():
    from rapidocr_onnxruntime import RapidOCR
    # 'max': never blow a small picture up (the default scales the short side up to 736 px,
    # which turns a thin strip into a huge one). Its detector and reader are used directly.
    return RapidOCR(det_limit_type='max', det_limit_side_len=960)


def is_text(text, score):
    if score < MIN_TEXT_SCORE or not text:
        return False
    return bool(CJK_RE.search(text)) or len(ALNUM_RE.findall(text)) >= 2


def rect(box):
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    return min(xs), min(ys), max(xs), max(ys)


def detect(engine, img):
    """Boxes that may hold text (detection only - cheap, but also hits leaves and fabric):
    [(points, (x0, y0, x1, y1))] in pixels."""
    boxes, _ = engine.text_det(img)
    if boxes is None or len(boxes) == 0:
        return []
    return [(b, rect(b)) for b in boxes]


def read(engine, img, cands):
    """Of the candidate boxes, the rects whose content reads as text (the costly part, so
    only boxes that could be a subtitle are read)."""
    if not cands:
        return []
    crops = engine.get_crop_img_list(img, [b for b, _ in cands])
    res, _ = engine.text_rec(crops)
    return [r for (_, r), (text, score) in zip(cands, res) if is_text(text, float(score))]


def find_row(boxes, samples):
    """The row centered text lines keep appearing in, as (y0, y1) in %, or None.
    boxes: [(x0, y0, x1, y1)] in % from every sampled frame."""
    centered = [b for b in boxes if abs((b[0] + b[2]) / 2 - 50) <= CENTER_TOLERANCE]
    if not centered:
        return None
    hgt = lambda b: b[3] - b[1]
    cy_of = lambda b: (b[1] + b[3]) / 2

    def same_line(o, b):
        # Same row: about as tall as b (a big title card or a one-off sign is not a subtitle
        # line), and centered on the same height.
        return 0.6 * hgt(b) <= hgt(o) <= 1.6 * hgt(b) and abs(cy_of(o) - cy_of(b)) <= 0.6 * hgt(b)

    best, best_n = None, 0
    for b in centered:
        n = sum(1 for o in centered if same_line(o, b))
        if n > best_n or (n == best_n and best is not None and cy_of(b) > cy_of(best)):
            best, best_n = b, n
    # Subtitles come back again and again; a sign or a title shows once or twice.
    if best_n < max(2, round(samples * 0.06)):
        return None
    row = [o for o in centered if same_line(o, best)]
    y0, y1 = min(o[1] for o in row), max(o[3] for o in row)
    hh = float(np.median([hgt(o) for o in row]))
    # A second subtitle line right above or below the first (two-line subtitles).
    near = [o for o in centered if o not in row and 0.6 * hh <= hgt(o) <= 1.6 * hh
            and (y0 - 1.5 * hh) <= cy_of(o) <= (y1 + 1.5 * hh)]
    if len(near) >= 2:
        y0, y1 = min([y0] + [o[1] for o in near]), max([y1] + [o[3] for o in near])
    return y0, y1, hh


def build_segments(lines, fps, duration, pad_x):
    """lines: per frame (t, (x0, x1) | None) -> [{'start','end','x0','x1'}].
    A subtitle that changes to a line of another width starts a new segment; times are
    widened by one frame each side (a line may show up just after the frame before)."""
    segs = []
    cur = None
    step = 1.0 / fps
    for t, line in lines:
        if line is None:
            cur = None
            continue
        x0, x1 = line
        if cur and cur['last'] >= t - step * 1.5 and abs(cur['x0'] - x0) <= 3 and abs(cur['x1'] - x1) <= 3:
            cur['last'] = t
            cur['x0'], cur['x1'] = min(cur['x0'], x0), max(cur['x1'], x1)
        else:
            cur = {'first': t, 'last': t, 'x0': x0, 'x1': x1}
            segs.append(cur)
    out = []
    for s in segs:
        out.append({
            'start': max(0.0, s['first'] - step),
            'end': min(duration, s['last'] + step) if duration else s['last'] + step,
            'x0': max(0.0, s['x0'] - pad_x),
            'x1': min(100.0, s['x1'] + pad_x),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--fps', type=float, default=4.0)
    args = ap.parse_args()
    video, fps = args.video, max(1.0, min(10.0, args.fps))
    t_start = time.time()

    width, height, duration = probe(video)
    if not width or not height or not duration:
        emit({'success': False, 'error': 'Could not read the video (size or length unknown).'})
        return 1

    engine = make_engine()
    n_row = int(max(12, min(ROW_SAMPLES_MAX, duration / 4)))
    strip_frames = int(duration * fps)
    total = n_row + strip_frames
    done = 0

    # Pass 1: where the subtitles sit. Frames are grabbed a few at a time (each is its own
    # quick seek), and only centered boxes are read.
    sw = ROW_SAMPLE_WIDTH
    sh = int(round(height * sw / width / 2)) * 2
    times = [duration * (0.02 + 0.96 * (k + 0.5) / n_row) for k in range(n_row)]
    found = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for k, raw in enumerate(pool.map(lambda t: read_frame(video, t, sw), times)):
            done += 1
            if k % 4 == 0:
                progress(done, total)
            if len(raw) != sw * sh * 3:
                continue
            img = np.frombuffer(raw, np.uint8).reshape(sh, sw, 3)
            cands = [c for c in detect(engine, img) if abs((c[1][0] + c[1][2]) / 2 / sw * 100 - 50) <= CENTER_TOLERANCE]
            for x0, y0, x1, y1 in read(engine, img, cands):
                found.append((x0 / sw * 100, y0 / sh * 100, x1 / sw * 100, y1 / sh * 100))
    row = find_row(found, n_row)
    if not row:
        progress(total, total)
        emit({'success': True, 'width': width, 'height': height, 'duration': duration, 'row': None,
              'segments': [], 'seconds': round(time.time() - t_start, 1)})
        return 0
    ry0, ry1, line_h = row

    # Pass 2: only the strip around that row, `fps` frames a second.
    strip_y0 = max(0.0, ry0 - line_h * 0.8)
    strip_y1 = min(100.0, ry1 + line_h * 0.8)
    crop_y = int(height * strip_y0 / 100) // 2 * 2
    crop_h = max(8, int(height * (strip_y1 - strip_y0) / 100) // 2 * 2)
    out_h = max(8, int(round(crop_h * STRIP_WIDTH / width / 2)) * 2)
    frame_bytes = STRIP_WIDTH * out_h * 3
    proc = subprocess.Popen([ffmpeg_path(), '-v', 'error', '-i', video, '-an', '-sn',
                             '-vf', f'fps={fps},crop={width}:{crop_h}:0:{crop_y},scale={STRIP_WIDTH}:{out_h}',
                             '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **no_window())
    lines = []
    prev_small, prev_line = None, None
    line_px = line_h / 100 * height * STRIP_WIDTH / width
    same_px = STRIP_WIDTH * SAME_LINE_TOLERANCE / 100
    i = 0
    while True:
        raw = proc.stdout.read(frame_bytes)
        if len(raw) < frame_bytes:
            break
        img = np.frombuffer(raw, np.uint8).reshape(out_h, STRIP_WIDTH, 3)
        small = img[::4, ::4, 1].astype(np.int16)
        if prev_small is not None and float(np.abs(small - prev_small).mean()) < SAME_FRAME_DIFF:
            line = prev_line  # nothing moved in the strip: same answer as the frame before
        else:
            # Boxes the size of a subtitle line, near the middle.
            cands = [c for c in detect(engine, img)
                     if 0.5 * line_px <= (c[1][3] - c[1][1]) <= 2.2 * line_px
                     and abs((c[1][0] + c[1][2]) / 2 / STRIP_WIDTH * 100 - 50) <= CENTER_TOLERANCE + 15]
            line = None
            if cands:
                x0, x1 = min(c[1][0] for c in cands), max(c[1][2] for c in cands)
                if prev_line and abs(x0 - prev_line[0]) <= same_px and abs(x1 - prev_line[1]) <= same_px:
                    line = (x0, x1)  # the line read in the frame before, still there: no need to read it again
                else:
                    texts = read(engine, img, cands)
                    if texts:
                        line = (min(r[0] for r in texts), max(r[2] for r in texts))
        prev_small, prev_line = small, line
        lines.append((i / fps, None if line is None else (line[0] / STRIP_WIDTH * 100, line[1] / STRIP_WIDTH * 100)))
        i += 1
        done += 1
        if i % 20 == 0:
            progress(min(done, total), total)
    proc.wait()

    pad_x = max(1.2, line_h * height / width * 0.35)  # a little more than the text, in % of width
    segs = build_segments(lines, fps, duration, pad_x)
    y = max(0.0, ry0 - line_h * 0.3)
    h = min(100.0, ry1 + line_h * 0.3) - y
    progress(total, total)
    emit({
        'success': True, 'width': width, 'height': height, 'duration': round(duration, 3),
        'row': {'y': round(y, 2), 'h': round(h, 2)},
        'segments': [{'start': round(s['start'], 2), 'end': round(s['end'], 2), 'x': round(s['x0'], 2),
                      'y': round(y, 2), 'w': round(s['x1'] - s['x0'], 2), 'h': round(h, 2)} for s in segs],
        'seconds': round(time.time() - t_start, 1),
    })
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:  # report, don't leave the caller with a traceback to parse
        emit({'success': False, 'error': f'{type(e).__name__}: {e}'})
        sys.exit(1)
