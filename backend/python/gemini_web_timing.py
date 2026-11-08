"""Per-character timeline of Chinese speech, for the Gemini Web Router.

The Gemini website writes good lines but guesses their times (seconds off). This worker hears
the same clip on the PC and returns when each Chinese character is spoken; DR Dubber then gives
every Gemini line the time of its own characters (backend/lib/gemini-web-timing.js).

Runs in the VoxCPM2 venv (funasr). Models load once; then one JSON request per stdin line:
  {"id": 1, "wav": "C:/.../clip.wav"}   (16 kHz mono)
  -> {"id": 1, "ok": true, "timeline": [["妈", 1.49, 1.69], ...], "ms": 23000}

fsmn-vad (pieces up to 15 s) -> paraformer-zh (words) -> fa-zh (time of each character).
Measured 2026-11-07: 23 s per 3-min clip on CPU; Gemini lines retimed this way start a median
0.23 s from the API's times (Gemini web alone: 3.7 s).
"""
import json
import os
import re
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
FA_DIR = sys.argv[1] if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]) else None
DEVICE = os.environ.get("GW_TIMING_DEVICE", "cpu")


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


try:
    import soundfile as sf
    from funasr import AutoModel
    t0 = time.time()
    vad = AutoModel(model="funasr/fsmn-vad", hub="hf", device=DEVICE, disable_update=True, max_single_segment_time=15000)
    asr = AutoModel(model="funasr/paraformer-zh", hub="hf", device=DEVICE, disable_update=True)
    fa = AutoModel(model=FA_DIR, device=DEVICE, disable_update=True) if FA_DIR else \
        AutoModel(model="funasr/fa-zh", hub="hf", device=DEVICE, disable_update=True)
    out({"ready": True, "loadMs": int((time.time() - t0) * 1000)})
except Exception as e:  # noqa: BLE001
    out({"ready": False, "error": f"{type(e).__name__}: {e}"})
    sys.exit(1)

CHAR_RE = re.compile(r"[\u4e00-\u9fff]|[A-Za-z0-9']+")


def timeline_of(wav):
    audio, sr = sf.read(wav, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    segs = vad.generate(input=wav)[0]["value"]
    tl = []
    for s_ms, e_ms in segs:
        clip = audio[int(s_ms * sr / 1000): int(e_ms * sr / 1000)]
        if len(clip) < sr * 0.2:
            continue
        raw = asr.generate(input=clip)[0]["text"].replace(" ", "")
        chars = CHAR_RE.findall(raw)
        if not chars:
            continue
        stamps = fa.generate(input=(clip, " ".join(chars)), data_type=("sound", "text"))[0].get("timestamp", [])
        off = s_ms / 1000
        tl += [[c, round(off + st[0] / 1000, 3), round(off + st[1] / 1000, 3)] for c, st in zip(chars, stamps)]
    return tl


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = {}
    try:
        req = json.loads(line)
        t = time.time()
        tl = timeline_of(req["wav"])
        out({"id": req.get("id"), "ok": True, "timeline": tl, "ms": int((time.time() - t) * 1000)})
    except Exception as e:  # noqa: BLE001
        out({"id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}"})
