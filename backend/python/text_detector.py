"""Finds burned-in subtitles (lines of on-screen text) in a video and when they show.

Two passes, so a long video stays fast on a CPU:
  1. Row: read ~40 frames spread over the video and find the row where centered text
     lines keep appearing - where the subtitles sit (none: the video has no subtitles).
  2. Timeline: decode only that strip of the picture, every frame, and read it a few
     times a second: which line shows, how wide it is, what it says. Where the line
     changes between two reads, the frames in between tell on which frame exactly.
Text is detected and then read (RapidOCR, PP-OCR models on onnxruntime); a box only
counts when it reads as real text, so faces, hats and leaves don't.

usage: python text_detector.py <video> [--fps 4]
FFmpeg comes from DR_FFMPEG_PATH (ffprobe next to it), like the TTS script.
stdout: "PROGRESS <done> <total>" lines, then one JSON line:
  {"success": true, "width", "height", "duration",
   "row": {"y", "h", "textY", "textH"} | null,      the strip to blur / where the text itself sits
   "lines": [{"start", "end", "x", "w", "text"}],   each subtitle line as shown: exact frames
   "segments": [{"start", "end", "x", "y", "w", "h"}]}  what to blur: a little wider in time
  positions in % of the frame, times in seconds
"""
import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

ROW_SAMPLES_MAX = 40
ROW_SAMPLE_WIDTH = 720       # frames read whole in pass 1
STRIP_WIDTH = 540            # strip width in pass 2 (a subtitle line is still ~35 px tall)
MIN_TEXT_SCORE = 0.75        # how sure the reader must be that a box is text
CENTER_TOLERANCE = 22        # % from the middle a subtitle line may be centered
SAME_FRAME_DIFF = 1.5        # mean pixel change below which a strip frame is "the same"
END_EXTRA = 0.04             # s a line stays blurred past the first read without it (a frame's slack)
BRIDGE_GAP = 0.6             # s: a pause between two lines up to this long stays blurred
SAME_TEXT = 0.85             # two reads this alike are the same line (the reader misreads a letter now and then)
OTHER_TEXT = 0.4             # this unalike: another line. In between, the letters' pixels decide
SAME_GLYPHS = 0.45           # share of the letter pixels two reads of the same line have in common
REJOIN_GAP = 0.5             # s: a line lost for a read or two and back again is one line
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
                          '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation:format=duration',
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
    return w, h, float((info.get('format') or {}).get('duration') or 0), frame_rate(st)


def frame_rate(st):
    """The stream's frame rate as FFmpeg writes it ("30000/1001") and as a number; 25 when
    it is missing or not a believable video rate."""
    for key in ('avg_frame_rate', 'r_frame_rate'):
        num, _, den = str(st.get(key) or '').partition('/')
        try:
            rate = float(num) / float(den or 1)
        except (ValueError, ZeroDivisionError):
            continue
        if 5 <= rate <= 120:
            return st[key], rate
    return '25', 25.0


def read_frame(video, t, width, height):
    """One frame at t seconds, scaled to width x height, as BGR (fast seek). The height is given,
    not -2: FFmpeg rounds 16:9 at 720 wide to 406 where the caller expects 404."""
    out = subprocess.run([ffmpeg_path(), '-v', 'error', '-ss', f'{t:.3f}', '-i', video, '-frames:v', '1',
                          '-vf', f'scale={width}:{height}', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
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
    """Of the candidate boxes, the ones whose content reads as text, as [(rect, text)] (the
    costly part, so only boxes that could be a subtitle are read)."""
    if not cands:
        return []
    crops = engine.get_crop_img_list(img, [b for b, _ in cands])
    res, _ = engine.text_rec(crops)
    return [(r, text) for (_, r), (text, score) in zip(cands, res) if is_text(text, float(score))]


def norm_text(text):
    """Only what tells two lines apart: letters and digits, no punctuation or spaces."""
    return ''.join(ch for ch in text if ch.isalnum()).lower()


def text_alike(a, b):
    a, b = norm_text(a), norm_text(b)
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def glyph_mask(gray):
    """Pixels of subtitle letters: bright, with the dark outline right next to them."""
    return (gray >= 170) & (cv2.erode(gray, np.ones((5, 5), np.uint8)) <= 90)


def same_line(a, b, gray_a, gray_b):
    """Do two reads (a, b: {'x0','x1','text'}) show the same subtitle line? The text decides
    when it is clear; when the reads are only partly alike (a misread letter in a short line,
    or two lines that share words), the letters' pixels decide: a line that stays put keeps
    its pixels, a new one doesn't."""
    alike = text_alike(a['text'], b['text'])
    if alike >= SAME_TEXT:
        return True
    if alike < OTHER_TEXT:
        return False
    x0, x1 = int(min(a['x0'], b['x0'])), int(max(a['x1'], b['x1'])) + 1
    ma, mb = glyph_mask(gray_a[:, x0:x1]), glyph_mask(gray_b[:, x0:x1])
    union = int((ma | mb).sum())
    return union > 0 and (ma & mb).sum() / union >= SAME_GLYPHS


def change_frame(before, after, frames, x0, x1):
    """The time of the first frame showing what `after` shows, of the frames between two
    reads: the split where the frames before it look most like `before` and the ones from
    it on most like `after`. frames: [(t, thumb)]; thumbs are half-size grey strips."""
    if not frames:
        return after['t']
    x0, x1 = max(0, int(x0) // 2 - 2), int(x1) // 2 + 3
    a, b = before['thumb'][:, x0:x1], after['thumb'][:, x0:x1]
    to_a = [float(np.abs(f[:, x0:x1] - a).mean()) for _, f in frames]
    to_b = [float(np.abs(f[:, x0:x1] - b).mean()) for _, f in frames]
    best, best_cost = len(frames), sum(to_a)
    cost = best_cost
    for s in range(len(frames) - 1, -1, -1):  # frames[s:] go with `after`
        cost += to_b[s] - to_a[s]
        if cost < best_cost:
            best, best_cost = s, cost
    return frames[best][0] if best < len(frames) else after['t']


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


def tidy_lines(found):
    """found: lines in time order, {'start','end','safe_start','safe_end','x0','x1','texts'}.
    A line the reader lost for a read or two (it came back reading alike) is joined back
    into one; each line's text is the reading seen most often."""
    out = []
    for ln in found:
        prev = out[-1] if out else None
        if (prev and 0 < ln['start'] - prev['end'] <= REJOIN_GAP
                and text_alike(Counter(prev['texts']).most_common(1)[0][0], Counter(ln['texts']).most_common(1)[0][0]) >= 0.6):
            prev.update(end=ln['end'], safe_end=ln['safe_end'], x0=min(prev['x0'], ln['x0']), x1=max(prev['x1'], ln['x1']))
            prev['texts'] += ln['texts']
            continue
        out.append(ln)
    for ln in out:
        ln['text'] = Counter(ln['texts']).most_common(1)[0][0]
    return out


def blur_segments(lines, duration, pad_x):
    """What the render blurs: each line from the last read without it to the first read
    without it again (sure to hold every frame of the text, even if a change was put a
    frame off), a little wider than the text. -> [{'start','end','x0','x1'}]"""
    out = []
    for ln in lines:
        end = ln['safe_end'] + END_EXTRA
        out.append({
            'start': max(0.0, ln['safe_start']),
            'end': min(duration, end) if duration else end,
            'x0': max(0.0, ln['x0'] - pad_x),
            'x1': min(100.0, ln['x1'] + pad_x),
        })
    # A short pause between two lines stays blurred: the blur switching off and on again
    # for a moment shows more than an empty strip blurred a little longer.
    for a, b in zip(out, out[1:]):
        if 0 < b['start'] - a['end'] <= BRIDGE_GAP:
            a['end'] = b['start']
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('video')
    ap.add_argument('--fps', type=float, default=4.0)
    args = ap.parse_args()
    video, fps = args.video, max(1.0, min(10.0, args.fps))
    t_start = time.time()

    width, height, duration, (rate_str, rate) = probe(video)
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
        for k, raw in enumerate(pool.map(lambda t: read_frame(video, t, sw, sh), times)):
            done += 1
            if k % 4 == 0:
                progress(done, total)
            if len(raw) != sw * sh * 3:
                continue
            img = np.frombuffer(raw, np.uint8).reshape(sh, sw, 3)
            cands = [c for c in detect(engine, img) if abs((c[1][0] + c[1][2]) / 2 / sw * 100 - 50) <= CENTER_TOLERANCE]
            for (x0, y0, x1, y1), _ in read(engine, img, cands):
                found.append((x0 / sw * 100, y0 / sh * 100, x1 / sw * 100, y1 / sh * 100))
    row = find_row(found, n_row)
    if not row:
        progress(total, total)
        emit({'success': True, 'width': width, 'height': height, 'duration': duration, 'row': None,
              'lines': [], 'segments': [], 'seconds': round(time.time() - t_start, 1)})
        return 0
    ry0, ry1, line_h = row

    # Pass 2: only the strip around that row. Every frame is decoded (at the stream's own
    # rate, so frame k shows at k / rate), and read `fps` times a second.
    strip_y0 = max(0.0, ry0 - line_h * 0.8)
    strip_y1 = min(100.0, ry1 + line_h * 0.8)
    crop_y = int(height * strip_y0 / 100) // 2 * 2
    crop_h = max(8, int(height * (strip_y1 - strip_y0) / 100) // 2 * 2)
    out_h = max(8, int(round(crop_h * STRIP_WIDTH / width / 2)) * 2)
    frame_bytes = STRIP_WIDTH * out_h * 3
    proc = subprocess.Popen([ffmpeg_path(), '-v', 'error', '-i', video, '-an', '-sn',
                             '-vf', f'fps={rate_str}:round=up,crop={width}:{crop_h}:0:{crop_y},scale={STRIP_WIDTH}:{out_h}',
                             '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, **no_window())
    line_px = line_h / 100 * height * STRIP_WIDTH / width
    found = []          # finished lines (see tidy_lines)
    cur = None          # the line on screen at the last read
    prev = None         # the last read: {'t', 'gray', 'thumb', 'small', 'line'}
    between = []        # (t, thumb) of the frames since the last read
    next_read = 0.0
    k = 0
    while True:
        raw = proc.stdout.read(frame_bytes)
        if len(raw) < frame_bytes:
            break
        t = k / rate
        k += 1
        img = np.frombuffer(raw, np.uint8).reshape(out_h, STRIP_WIDTH, 3)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        thumb = gray[::2, ::2].astype(np.int16)
        if t + 1e-6 < next_read:
            between.append((t, thumb))
            continue
        while next_read <= t + 1e-6:
            next_read += 1.0 / fps

        small = img[::4, ::4, 1].astype(np.int16)
        if prev is not None and float(np.abs(small - prev['small']).mean()) < SAME_FRAME_DIFF:
            line = prev['line']  # nothing moved in the strip: same answer as the read before
        else:
            # Boxes the size of a subtitle line, near the middle.
            cands = [c for c in detect(engine, img)
                     if 0.5 * line_px <= (c[1][3] - c[1][1]) <= 2.2 * line_px
                     and abs((c[1][0] + c[1][2]) / 2 / STRIP_WIDTH * 100 - 50) <= CENTER_TOLERANCE + 15]
            texts = read(engine, img, cands)
            line = None
            if texts:
                # Reading order: top row first (a two-row subtitle), then left to right.
                texts.sort(key=lambda r: (round(r[0][1] / max(1.0, line_px)), r[0][0]))
                line = {'x0': min(r[0][0] for r in texts), 'x1': max(r[0][2] for r in texts),
                        'text': ''.join(r[1] for r in texts)}

        before = prev['line'] if prev else None
        if before and line and (line is before or same_line(before, line, prev['gray'], gray)):
            cur['x0'], cur['x1'] = min(cur['x0'], line['x0']), max(cur['x1'], line['x1'])
            cur['texts'].append(line['text'])
        elif before or line:
            spans = [s for s in (before, line) if s]
            at = change_frame(prev, {'t': t, 'thumb': thumb}, between,
                              min(s['x0'] for s in spans), max(s['x1'] for s in spans)) if prev else t
            if cur:
                cur.update(end=at, safe_end=t)
                found.append(cur)
                cur = None
            if line:
                cur = {'start': at, 'safe_start': prev['t'] if prev else 0.0, 'x0': line['x0'], 'x1': line['x1'],
                       'texts': [line['text']]}
        prev = {'t': t, 'gray': gray, 'thumb': thumb, 'small': small, 'line': line}
        between = []
        done += 1
        if done % 20 == 0:
            progress(min(done, total), total)
    proc.wait()
    if cur:
        cur.update(end=k / rate, safe_end=k / rate)
        found.append(cur)

    to_pct = 100.0 / STRIP_WIDTH
    lines = tidy_lines(found)
    for ln in lines:
        ln['x0'], ln['x1'] = ln['x0'] * to_pct, ln['x1'] * to_pct
    pad_x = max(1.2, line_h * height / width * 0.35)  # a little more than the text, in % of width
    segs = blur_segments(lines, duration, pad_x)
    y = max(0.0, ry0 - line_h * 0.3)
    h = min(100.0, ry1 + line_h * 0.3) - y
    progress(total, total)
    emit({
        'success': True, 'width': width, 'height': height, 'duration': round(duration, 3),
        'row': {'y': round(y, 2), 'h': round(h, 2), 'textY': round(ry0, 2), 'textH': round(ry1 - ry0, 2)},
        'lines': [{'start': round(ln['start'], 3), 'end': round(ln['end'], 3), 'x': round(ln['x0'], 2),
                   'w': round(ln['x1'] - ln['x0'], 2), 'text': ln['text']} for ln in lines],
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
