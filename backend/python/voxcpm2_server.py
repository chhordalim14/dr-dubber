"""DR Dubber Pro - local VoxCPM2 server.

Installed by Settings -> VoxCPM2 AI -> Install VoxCPM2 as <install dir>/app.py and
started by "Start Server" (python app.py --port 8808). Speaks the small API the app
uses (backend/server.js /api/generate-voxcmp2 and the page's direct call):

  GET  /              200 {"status": "ready"} once the model is loaded,
                      503 {"status": "loading"} while it loads, 500 if it failed
  POST /api/generate  {"text", "instruction", "emotion", "seed",
                       "reference_audio_base64", "reference_audio", "cfg_value"}
                      -> {"success": true, "audio_base64": <wav>, "duration": s,
                          "sample_rate": hz}

Only listens on 127.0.0.1. Writes only a temp file for the reference clip and
each voice's anchor line (voice_anchors/ beside this file); the app saves the
returned audio itself.
"""

import argparse
import base64
import hashlib
import inspect
import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = os.environ.get("VOXCPM_MODEL", "openbmb/VoxCPM2")
DEFAULT_STEPS = int(os.environ.get("VOXCPM_STEPS", "10"))
MAX_BODY = 64 * 1024 * 1024  # a reference clip is a few hundred KB

state = {"status": "loading", "error": None, "device": None, "model": None, "sr": 48000}
gen_lock = threading.Lock()  # one generation at a time: the model is not re-entrant
use_lock = threading.Lock()  # held for a whole line, so the model is never released mid-line
load_lock = threading.Lock()

# The emotion Transcribe hears on each line (server.js TRANSCRIBE_EMOTIONS), as the style
# guidance VoxCPM2 takes in brackets before the text. Neutral is spelled out too: a
# reference clip cut from a shouting scene otherwise makes every line sound angry.
# Feeling and delivery only: words about the voice itself ("low", "bright", "soft voice")
# changed who was speaking, not how.
EMOTION_STYLES = {
    "neutral": "calm, natural conversational tone",
    "sad": "sad and sorrowful, holding back tears",
    "angry": "angry and forceful",
    "whisper": "whispering",
    "excited": "excited and lively",
    "royal": "dignified and commanding",
    "romantic": "tender and affectionate",
    "fear": "frightened and nervous",
}
KHMER = re.compile("[ក-៿]")

# VoxCPM2 picks its own pace and it swings widely: the same Khmer line came out in 0.93 s
# and in 1.76 s. A line spoken far off a natural pace is drawn again with another seed,
# and the take nearest a natural pace is kept. Pace is counted in Khmer letters that start
# a cluster (not those under a coeng) per second of speech; VoxCPM2's median is about 7.
PACE_UNITS = re.compile("(?<!្)[ក-អ]|[ឣ-ឳ]")
PACE_TARGET = 7.0
PACE_BAND = (4.8, 9.6)
PACE_MIN_UNITS = 7  # short exclamations are slow by nature and too short to measure
PACE_TRIES = max(1, int(os.environ.get("VOXCPM_PACE_TRIES", "3")))

# Every line leaves as a dub line: no dead air or clicks at its ends, and all at one level
# (raw takes ranged from -23 to -38 dB, so lines jumped in volume like pasted clips).
LINE_LEVEL_DB = -24.0  # mean loudness of the speech
LINE_PAD = (0.08, 0.15)  # seconds of room kept before / after the speech
LINE_FADE = (0.01, 0.04)

# VoxCPM2 clones from seconds of voice; a minute-long clip with music under it gives a
# voice that wanders. A longer clip is cut to its clearest stretch of this length.
REF_MAX_SECONDS = 12.0
ref_cache = {}  # sha1 of the clip -> wav bytes of its clearest stretch

# Cloned from the clip alone, each line drew the voice afresh and one profile could sound
# like two people. So each voice (and style) first says one fixed Khmer line, its anchor,
# and every line it speaks continues from that anchor (VoxCPM2's "ultimate cloning", which
# needs the prompt's exact words: here they are known). Kept on disk, so a voice sounds the
# same next session too.
ANCHOR_TEXT = "ខ្ញុំនៅទីនេះហើយ ហើយខ្ញុំកំពុងស្ដាប់អ្នកនិយាយ។"
ANCHOR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice_anchors")
anchor_lock = threading.Lock()
takes = {}  # (seed, text) -> times asked, so asking again gives a new take
takes_lock = threading.Lock()


def style_instruction(emotion, instruction, text, cloned):
    """The bracketed guidance for one line: its emotion, then the voice's own note.

    Khmer text without a reference clip gets none (the page leaves out the voice's
    note then too): an English description with no voice to hold on to drifts the
    speech away from Khmer.
    """
    if not cloned and KHMER.search(text):
        return ""
    parts = [EMOTION_STYLES.get(str(emotion or "").strip().lower(), ""),
             str(instruction or "").strip().strip("()").strip()]
    return ", ".join(p for p in parts if p)


def voice_seed(payload, ref_bytes):
    """One seed per voice, so every line of it starts from the same random draw.

    Unseeded, each line drew fresh noise and the cloned voice wandered from line to line.
    """
    try:
        return int(payload["seed"]) & 0x7FFFFFFF
    except (KeyError, TypeError, ValueError):
        pass
    key = ref_bytes or str(payload.get("instruction") or "").encode("utf-8")
    return int.from_bytes(hashlib.sha1(key).digest()[:4], "big") & 0x7FFFFFFF


def speech_seconds(wav, sr):
    """Length of the speech with the silence before and after it cut off."""
    import numpy as np

    hop, db = frame_db(wav, sr)
    loud = np.nonzero(db > db.max() - 35)[0]
    return (loud[-1] - loud[0] + 1) * hop / float(sr) if len(loud) else len(wav) / float(sr)


def frame_db(wav, sr, step=0.02):
    import numpy as np

    hop = max(1, int(sr * step))
    n = len(wav) // hop
    if n == 0:
        return hop, np.full(1, -120.0)
    rms = np.sqrt(np.mean(wav[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12)
    return hop, 20 * np.log10(rms)


def finish_line(wav, sr):
    """Trim the silence around the speech, fade its ends and bring it to the line level."""
    import numpy as np

    hop, db = frame_db(wav, sr)
    loud = np.nonzero(db > db.max() - 40)[0]
    if len(loud):
        a = max(0, loud[0] * hop - int(LINE_PAD[0] * sr))
        b = min(len(wav), (loud[-1] + 1) * hop + int(LINE_PAD[1] * sr))
        wav = wav[a:b].copy()
    fade_in, fade_out = (min(int(s * sr), len(wav) // 2) for s in LINE_FADE)
    if fade_in:
        wav[:fade_in] *= np.linspace(0, 1, fade_in, dtype=np.float32)
    if fade_out:
        wav[-fade_out:] *= np.linspace(1, 0, fade_out, dtype=np.float32)
    _, db = frame_db(wav, sr)
    speech = db[db > db.max() - 35]
    if len(speech):
        level = 20 * np.log10(np.mean(10 ** (speech / 20)))
        wav = wav * 10 ** (max(-10.0, min(14.0, LINE_LEVEL_DB - level)) / 20)
    peak = float(np.abs(wav).max()) if len(wav) else 0.0
    if peak > 0.95:
        wav = wav * (0.95 / peak)
    return wav.astype(np.float32)


def clearest_reference(ref_bytes):
    """A clip longer than REF_MAX_SECONDS cut to its clearest stretch (wav bytes), else None."""
    key = hashlib.sha1(ref_bytes).hexdigest()
    if key in ref_cache:
        return ref_cache[key]
    import numpy as np
    import soundfile as sf

    try:
        wav, sr = sf.read(io.BytesIO(ref_bytes), dtype="float32", always_2d=True)
    except Exception:  # noqa: BLE001 - an mp3 older libsndfile builds cannot read
        import librosa

        wav, sr = librosa.load(io.BytesIO(ref_bytes), sr=None, mono=False)
        wav = np.atleast_2d(wav).T
    wav = wav.mean(axis=1)
    cut = None
    if len(wav) > REF_MAX_SECONDS * sr:
        hop, db = frame_db(wav, sr, 0.05)
        floor = np.percentile(db, 10)
        # Speech stands well above the quiet between words; music under it lifts that floor.
        clear = (db > floor + 15) & (db > db.max() - 30)
        win = int(REF_MAX_SECONDS * sr / hop)
        sums = np.convolve(clear.astype(np.float32), np.ones(win, dtype=np.float32), "valid")
        start = int(np.argmax(sums)) * hop
        part = wav[start:start + int(REF_MAX_SECONDS * sr)].copy()
        n = int(0.02 * sr)
        part[:n] *= np.linspace(0, 1, n, dtype=np.float32)
        part[-n:] *= np.linspace(1, 0, n, dtype=np.float32)
        buf = io.BytesIO()
        sf.write(buf, part, sr, format="WAV", subtype="PCM_16")
        cut = buf.getvalue()
        log(f"Reference clip is {len(wav) / sr:.0f}s: cloning from its clearest {REF_MAX_SECONDS:.0f}s "
            f"(from {start / sr:.1f}s)")
    ref_cache[key] = cut
    return cut


def speech_pace(text, wav, sr):
    """Letters per second for a Khmer line long enough to judge, else None."""
    units = len(PACE_UNITS.findall(text))
    if units < PACE_MIN_UNITS:
        return None
    return units / max(0.05, speech_seconds(wav, sr))


def pace_miss(pace):
    """How far a take is from a natural pace (0 inside the band)."""
    import math

    if pace is None or PACE_BAND[0] <= pace <= PACE_BAND[1]:
        return 0.0
    return abs(math.log(pace / PACE_TARGET))


def seed_everything(seed):
    import random

    import numpy as np
    import torch

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def log(msg):
    print(f"[VoxCPM2 {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def physical_cores():
    override = os.environ.get("VOXCPM_THREADS")
    if override and override.isdigit():
        return max(1, int(override))
    try:
        import psutil

        n = psutil.cpu_count(logical=False)
        if n:
            return n
    except Exception:  # noqa: BLE001 - psutil missing in an older install
        pass
    logical = os.cpu_count() or 1
    return max(1, logical // 2) if logical >= 4 else logical


def load_model():
    try:
        import torch
        from voxcpm import VoxCPM

        cuda = torch.cuda.is_available()
        state["device"] = "cuda" if cuda else "cpu"
        if not cuda:
            # One thread per physical core: hyper-threads only add contention here
            # (measured on an i5-12400: 6 threads ~20% faster than 12).
            torch.set_num_threads(physical_cores())
        log(f"Loading {MODEL_ID} on {state['device'].upper()}"
            f"{'' if cuda else f' with {torch.get_num_threads()} threads (no NVIDIA GPU: about 30 s per second of speech)'} ...")
        t0 = time.time()
        kwargs = {}
        params = inspect.signature(VoxCPM.from_pretrained).parameters
        if "load_denoiser" in params:
            kwargs["load_denoiser"] = False
        if "device" in params:
            kwargs["device"] = state["device"]
        if not cuda and "optimize" in params:
            kwargs["optimize"] = False  # torch.compile needs a compiler toolchain on CPU
        model = VoxCPM.from_pretrained(MODEL_ID, **kwargs)
        try:
            state["sr"] = int(model.tts_model.sample_rate)
        except Exception:
            pass
        state["model"] = model
        state["status"] = "ready"
        log(f"Model ready in {time.time() - t0:.0f}s (sample rate {state['sr']} Hz). Server is ready.")
    except Exception as e:  # noqa: BLE001 - shown to the user in the app's server log
        state["status"] = "error"
        state["error"] = f"{type(e).__name__}: {e}"
        log("Model failed to load:\n" + traceback.format_exc())


def release_model():
    """Unload the model so another GPU job (BGM isolation) gets the card.

    The two together overfill a 6 GB laptop GPU and Windows then pages video memory:
    a 98 s episode's MDX-Net isolation (8 s alone) ran for over 8 minutes, and lines
    took 6x longer. The next line loads the model again (about 40 s).
    """
    with use_lock:
        if state["model"] is None:
            return False
        state["model"] = None
        state["status"] = "sleeping"
        import gc

        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    log("Released the GPU for another job; the model loads again with the next line.")
    return True


def wake_model():
    with load_lock:
        if state["status"] == "sleeping":
            state["status"] = "loading"
            load_model()


def best_take(model, kwargs, seed, spoken, sr):
    """Speak once, and again with other seeds while the pace is off; the most natural take."""
    import numpy as np

    best = None  # (miss, wav)
    for take in range(PACE_TRIES):
        with gen_lock:
            seed_everything(seed + take * 7919)
            wav = np.asarray(model.generate(**kwargs), dtype=np.float32).reshape(-1)
        pace = speech_pace(spoken, wav, sr)
        miss = pace_miss(pace)
        if best is None or miss < best[0]:
            best = (miss, wav)
        if miss == 0.0:
            break
        log(f"Take {take + 1}: {pace:.1f} letters/s, outside a natural "
            f"{PACE_BAND[0]}-{PACE_BAND[1]}{'; trying again' if take + 1 < PACE_TRIES else '; keeping the closest'}")
    return best[1]


def voice_anchor(model, base, ref_bytes, style, seed, sr):
    """The anchor wav for this voice and style, made from the reference clip the first time."""
    import soundfile as sf

    key = hashlib.sha1(ref_bytes + b"|" + style.encode("utf-8")).hexdigest()[:20]
    path = os.path.join(ANCHOR_DIR, f"{key}.wav")
    with anchor_lock:
        if os.path.exists(path):
            return path
        t0 = time.time()
        text = f"({style}){ANCHOR_TEXT}" if style else ANCHOR_TEXT
        wav = finish_line(best_take(model, {**base, "text": text}, seed, ANCHOR_TEXT, sr), sr)
        os.makedirs(ANCHOR_DIR, exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp.wav"
        sf.write(tmp, wav, sr, subtype="PCM_16")
        os.replace(tmp, path)
        log(f"Made this voice's anchor{f' for [{style}]' if style else ''} in {time.time() - t0:.1f}s")
        return path


def synthesize(payload):
    model = state["model"]
    text = str(payload.get("text") or "").strip()
    if not text:
        raise ValueError("No text to speak.")
    ref_path = None
    tmp = None
    ref_bytes = b""
    b64 = payload.get("reference_audio_base64")
    if b64:
        ref_bytes = base64.b64decode(b64)
        ext = os.path.splitext(str(payload.get("reference_audio") or ""))[1].lower()
        if ext not in (".wav", ".mp3", ".flac", ".ogg", ".m4a"):
            ext = ".wav"
        try:
            clip = clearest_reference(ref_bytes)
        except Exception:  # noqa: BLE001 - an unreadable clip still goes to VoxCPM2 whole
            log("Could not read the reference clip to shorten it; using it whole:\n" + traceback.format_exc())
            clip = None
        fd, tmp = tempfile.mkstemp(prefix="drd_ref_", suffix=".wav" if clip else ext)
        with os.fdopen(fd, "wb") as f:
            f.write(clip or ref_bytes)
        ref_path = tmp

    spoken = text
    style = style_instruction(payload.get("emotion"), payload.get("instruction"), text, bool(ref_path))
    voice = voice_seed(payload, ref_bytes)
    # The first take of a line is the voice's own seed; asking for the line again (Regenerate)
    # moves on to a new take instead of handing back the same audio.
    with takes_lock:
        asked = takes.get((voice, style, text), 0)
        takes[(voice, style, text)] = asked + 1
    seed = voice + asked * 104729

    try:
        try:
            cfg = float(payload.get("cfg_value") or 2.0)
        except (TypeError, ValueError):
            cfg = 2.0
        # generate(*args, **kwargs) forwards to _generate, which names the real options.
        params = inspect.signature(getattr(model, "_generate", model.generate)).parameters
        base = {}
        if "cfg_value" in params:
            base["cfg_value"] = max(0.5, min(5.0, cfg))
        if "inference_timesteps" in params:
            base["inference_timesteps"] = DEFAULT_STEPS
        if ref_path:
            if "reference_wav_path" in params:
                base["reference_wav_path"] = ref_path
            elif "prompt_wav_path" in params:
                base["prompt_wav_path"] = ref_path
        import soundfile as sf

        sr = state["sr"]
        t0 = time.time()
        anchor = None
        if (ref_path and "reference_wav_path" in base and "prompt_text" in params
                and payload.get("anchor", True) is not False):
            anchor = voice_anchor(model, base, ref_bytes, style, voice, sr)
        if anchor:
            # Continue from the anchor: it already carries the voice and the style.
            kwargs = {**base, "text": spoken, "prompt_wav_path": anchor, "prompt_text": ANCHOR_TEXT}
        else:
            # VoxCPM2 takes a voice / style description in brackets before the text.
            kwargs = {**base, "text": f"({style}){spoken}" if style else spoken}
        wav = finish_line(best_take(model, kwargs, seed, spoken, sr), sr)
        buf = io.BytesIO()
        sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
        dur = len(wav) / float(sr)
        log(f"Spoke {len(spoken)} chars -> {dur:.1f}s audio in {time.time() - t0:.1f}s"
            f"{' (cloned)' if ref_path else ''}{' from its anchor' if anchor else ''}{f' [{style}]' if style else ''}")
        return {"success": True, "audio_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
                "duration": dur, "sample_rate": sr}
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


class Handler(BaseHTTPRequestHandler):
    server_version = "DRDubberVoxCPM2/1.0"

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # The app's page calls this server directly too (http://localhost:3001 origin).
        self.send_header("Access-Control-Allow-Origin", "http://localhost:3001")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quiet: generate() logs what matters
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "http://localhost:3001")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] in ("/", "/health", "/api/health"):
            # Released for another GPU job still counts as ready: the next line loads it.
            sleeping = state["status"] == "sleeping"
            code = {"ready": 200, "sleeping": 200, "loading": 503}.get(state["status"], 500)
            return self._json(code, {"status": "ready" if sleeping else state["status"], "sleeping": sleeping,
                                     "device": state["device"], "model": MODEL_ID, "error": state["error"]})
        self._json(404, {"success": False, "error": "Not found"})

    def do_POST(self):
        route = self.path.split("?")[0]
        if route == "/api/release":
            try:
                released = release_model() if state["device"] == "cuda" else False
                return self._json(200, {"success": True, "released": released, "device": state["device"]})
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"success": False, "error": f"{type(e).__name__}: {e}"})
        if route not in ("/api/generate", "/generate"):
            return self._json(404, {"success": False, "error": "Not found"})
        if state["status"] == "sleeping":
            log("Loading the model back after another GPU job ...")
            wake_model()
        if state["status"] != "ready":
            msg = state["error"] if state["status"] == "error" else "The VoxCPM2 model is still loading. Try again in a moment."
            return self._json(503, {"success": False, "error": msg})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self._json(413, {"success": False, "error": "Request too large."})
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
            with use_lock:
                if state["model"] is None:  # released between the check above and now
                    wake_model()
                if state["model"] is None:
                    return self._json(503, {"success": False, "error": state["error"] or "The VoxCPM2 model is not loaded."})
                result = synthesize(payload)
            self._json(200, result)
        except Exception as e:  # noqa: BLE001
            log("Generation failed:\n" + traceback.format_exc())
            self._json(500, {"success": False, "error": f"{type(e).__name__}: {e}"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8808)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    threading.Thread(target=load_model, daemon=True).start()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"Listening on http://{args.host}:{args.port} (model loading in the background)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
