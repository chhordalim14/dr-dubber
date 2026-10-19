"""DR Dubber Pro - local VoxCPM2 server.

Installed by Settings -> VoxCPM2 AI -> Install VoxCPM2 as <install dir>/app.py and
started by "Start Server" (python app.py --port 8808). Speaks the small API the app
uses (backend/server.js /api/generate-voxcmp2 and the page's direct call):

  GET  /              200 {"status": "ready"} once the model is loaded,
                      503 {"status": "loading"} while it loads, 500 if it failed
  POST /api/generate  {"text", "instruction", "emotion", "seed",
                       "reference_audio_base64", "reference_audio", "cfg_value",
                       "fit_seconds" (the line's room), "feeling_audio_base64" (how the
                       line is said: the actor's own line or feeling clip), "feeling_from"}
                      -> {"success": true, "audio_base64": <wav>, "duration": s,
                          "sample_rate": hz}
  POST /api/speakers  {"audio_path" | "audio_base64": 16 kHz mono wav of the lines,
                       "lines": [{"id", "start", "end", "gender"}],
                       "known": [{"id", "gender", "embedding"}]}
                      -> {"success": true, "speakers": [...]} (voxcpm2_speakers.py: who
                         speaks each line, for Clone Voices from Video; works while the
                         model is still loading)

Only listens on 127.0.0.1. Writes only temp files for the reference clip (and its
cleaned copy) and each voice's anchor line (voice_anchors/ beside this file); the
app saves the returned audio itself. The first noisy clip downloads the clip
cleaner (ZipEnhancer, about 19 MB) into the model cache.
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
MAX_SPEAKERS_BODY = 512 * 1024 * 1024  # a long movie's lines, sent by a remote app as base64

state = {"status": "loading", "error": None, "device": None, "model": None, "sr": 48000}
gen_lock = threading.Lock()  # one generation at a time: the model is not re-entrant
speakers_lock = threading.Lock()  # one speaker search at a time (CPU; beside generation)
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
# The page sends the line's room (fit_seconds: its slot, or up to the next line). A take longer
# than that is played faster to fit (studio-main.js refitFastSubSpeed), and from 1.15x on it
# sounds rushed. So a take that fits its room is kept over one that does not: with the pace
# swinging this much between seeds, another draw often fits where the first did not.
FIT_SLACK = 1.12  # played up to this much faster still sounds natural

# Every line leaves as a dub line: no dead air or clicks at its ends, and all at one level
# (raw takes ranged from -23 to -38 dB, so lines jumped in volume like pasted clips).
LINE_LEVEL_DB = -24.0  # mean loudness of the speech
# ...as loud as the actor said it, though: a whisper under, a shout over (line_level_db: the
# line's speech against the film's dialogue as a whole). Part of it, within limits, as a
# dialogue mixer rides it: whispers still heard, shouts not blasting.
LINE_LEVEL_FOLLOW = 0.6
LINE_LEVEL_RANGE = (-9.0, 6.0)
LINE_PAD = (0.08, 0.15)  # seconds of room kept before / after the speech
LINE_FADE = (0.01, 0.04)

# A dub line should sound like a voice actor in a booth: rumble cut, and the loudest syllables
# pressed gently towards the rest so the line sits evenly over the film's music.
HIGHPASS_HZ = 60.0
COMP_RATIO = 2.5
COMP_KNEE_DB = 8.0  # only what rises this far above the line's typical level is pressed down
COMP_MAX_CUT_DB = 6.0
COMP_ATTACK, COMP_RELEASE = 0.008, 0.15

# VoxCPM2 clones from seconds of voice; a minute-long clip with music under it gives a
# voice that wanders. A longer clip is cut to its clearest stretch of this length.
REF_MAX_SECONDS = 12.0
# A clip cut from a film carries its music and room into every line spoken from it. Measured
# on a clip with music 14 dB under the voice: cleaned first (ZipEnhancer, VoxCPM2's own
# denoiser), the lines came out with 16 dB less noise under them. A clean clip is left as it
# is: cleaned, the lines of a studio-clean clip held the voice less well.
REF_NOISY_DB = -45.0  # the quiet between words within this far of the speech: noisy
DENOISER_ID = "iic/speech_zipenhancer_ans_multiloss_16k_base"
denoiser = {"model": None, "failed": False}
denoiser_lock = threading.Lock()
ref_cache = {}  # sha1 of the clip -> wav bytes of the clip made ready to clone from, or None
REF_PREP = "clean1"  # changes when the way a clip is made ready changes (anchors follow it)
# A voice's clip made ready is kept on disk: one cleaning per clip, not per session (the cleaner
# runs on the CPU, see get_denoiser).
CLEAN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "clean_clips")

# Cloned from the clip alone, each line drew the voice afresh and one profile could sound
# like two people. So each voice (and style) first says one fixed Khmer line, its anchor,
# and every line it speaks continues from that anchor (VoxCPM2's "ultimate cloning", which
# needs the prompt's exact words: here they are known). Kept on disk, so a voice sounds the
# same next session too. A statement, a question and a reply: over one short sentence, every
# line of a voice came out closer to the others (CAM++ likeness between lines 0.68-0.78 ->
# 0.73-0.81 on three voices).
ANCHOR_TEXT = ("ខ្ញុំនៅទីនេះហើយ ហើយខ្ញុំកំពុងស្ដាប់អ្នកនិយាយ។ តើមានរឿងអ្វីកើតឡើង? "
               "ប្រាប់ខ្ញុំមកចុះ យើងនឹងរកផ្លូវដោះស្រាយជាមួយគ្នា។")
ANCHOR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voice_anchors")

# How a line is said comes from a second clip the page sends (feeling_audio_base64): the actor
# saying this very line in the film, or their clip of this feeling. It is the line's reference on
# its own, while the voice's seed and anchor stay those of its own clip: the anchor holds the voice
# (one voice in every feeling), the reference brings the delivery. Measured on 96 lines of a
# C-drama, each spoken with its real Khmer translation (median pitch of each dub line against the
# actor's, across lines; 90% interval): the voice's clip with the written emotion did not follow
# the actor (r 0.00, -0.13..+0.23); the line's own clip, cleaned, did (0.19, +0.10..+0.39), with
# the voice as close to the actor's and the Khmer as clear. Joined after the voice's clip, or
# with no anchor, the line's clip did not help.
FEELING_MIN_SECONDS = 0.6  # less is too little to hear how it was said
FEELING_MAX_SECONDS = 10.0
FEELING_SOURCES = {"line": "film (vocals)", "line-center": "film (dialogue channel)", "emotion": "actor's clip of this feeling"}
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


def voice_over(wav, sr):
    """Cut the rumble under the voice and press its loudest syllables gently down."""
    import numpy as np
    from scipy.signal import butter, sosfilt

    wav = sosfilt(butter(2, HIGHPASS_HZ, "highpass", fs=sr, output="sos"), wav).astype(np.float32)
    hop, db = frame_db(wav, sr, 0.005)
    if len(db) < 4:
        return wav
    thr = np.median(db[db > db.max() - 35]) + COMP_KNEE_DB
    want = -np.minimum(COMP_MAX_CUT_DB, np.maximum(0.0, db - thr) * (1 - 1 / COMP_RATIO))
    attack, release = (np.exp(-hop / (s * sr)) for s in (COMP_ATTACK, COMP_RELEASE))
    cut = np.empty(len(want))
    cur = 0.0
    for i, w in enumerate(want):  # quick to press down, slow to let go
        k = attack if w < cur else release
        cur = k * cur + (1 - k) * w
        cut[i] = cur
    gain = np.interp(np.arange(len(wav)), (np.arange(len(cut)) + 0.5) * hop, 10 ** (cut / 20))
    return (wav * gain).astype(np.float32)


def line_level(payload):
    """The level (dB) this line is brought to: LINE_LEVEL_DB, moved with how loud it was said."""
    try:
        said = float(payload.get("line_level_db"))
    except (TypeError, ValueError):
        return LINE_LEVEL_DB
    if not -40.0 < said < 40.0:
        return LINE_LEVEL_DB
    return LINE_LEVEL_DB + max(LINE_LEVEL_RANGE[0], min(LINE_LEVEL_RANGE[1], said * LINE_LEVEL_FOLLOW))


def finish_line(wav, sr, level_db=LINE_LEVEL_DB):
    """Trim the silence around the speech, fade its ends and bring it to level_db."""
    import numpy as np

    wav = voice_over(wav, sr)
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
        wav = wav * 10 ** (max(-16.0, min(20.0, level_db - level)) / 20)
    peak = float(np.abs(wav).max()) if len(wav) else 0.0
    if peak > 0.95:
        wav = wav * (0.95 / peak)
    return wav.astype(np.float32)


def noise_db(wav, sr):
    """How loud the quiet between words is, against the speech (dB; lower is cleaner)."""
    import numpy as np

    _, db = frame_db(wav, sr)
    loud = np.nonzero(db > db.max() - 35)[0]
    if len(loud) < 5:
        return -120.0
    speech = db[loud[0]:loud[-1] + 1]
    return float(np.percentile(speech, 5) - np.percentile(speech, 90))


def get_denoiser():
    """VoxCPM2's ZipEnhancer, loaded the first time a noisy clip comes in (None if it can't be).

    On the CPU: run on the GPU beside VoxCPM2, a 6 GB laptop card overflowed and every line
    after the first cleaning spoke 6x slower (2.2 s a step instead of 2.6 steps a second), freed
    or not. On the CPU a clip takes about 2 s per second of it, once: cleaned clips are kept.
    """
    with denoiser_lock:
        if denoiser["model"] is None and not denoiser["failed"]:
            try:
                from modelscope.pipelines import pipeline
                from modelscope.utils.constant import Tasks
                from voxcpm.zipenhancer import ZipEnhancer

                t0 = time.time()
                # ZipEnhancer() builds its pipeline on the default device (the GPU); same object, on the CPU.
                enhancer = ZipEnhancer.__new__(ZipEnhancer)
                enhancer.model_path = DENOISER_ID
                enhancer._pipeline = pipeline(Tasks.acoustic_noise_suppression, model=DENOISER_ID, device="cpu")
                denoiser["model"] = enhancer
                log(f"Loaded the clip cleaner in {time.time() - t0:.0f}s")
            except Exception:  # noqa: BLE001 - offline on first use, or an install without modelscope
                denoiser["failed"] = True
                log("Could not load the clip cleaner; noisy clips are used as they are:\n" + traceback.format_exc())
        return denoiser["model"]


def clean_clip(wav, sr):
    """The clip with its music and room noise taken out (16 kHz wav bytes), else None."""
    import soundfile as sf

    enhancer = get_denoiser()
    if enhancer is None:
        return None
    fd, src = tempfile.mkstemp(prefix="drd_noisy_", suffix=".wav")
    os.close(fd)
    out = src[:-4] + "_clean.wav"
    try:
        sf.write(src, wav, sr, subtype="PCM_16")
        enhancer.enhance(src, output_path=out)
        with open(out, "rb") as f:
            return f.read()
    except Exception:  # noqa: BLE001 - the clip is still usable as it is
        log("Could not clean the reference clip; using it as it is:\n" + traceback.format_exc())
        return None
    finally:
        for p in (src, out):
            try:
                os.remove(p)
            except OSError:
                pass


def prepared_reference(ref_bytes, keep=True):
    """The clip made ready to clone from (wav bytes), or None to use it as it came.

    A clip longer than REF_MAX_SECONDS is cut to its clearest stretch, and a noisy one cleaned.
    keep=False for a clip used once (a line's own delivery): not kept in memory or on disk.
    """
    key = hashlib.sha1(ref_bytes).hexdigest()
    disk = os.path.join(CLEAN_DIR, hashlib.sha1(ref_bytes + REF_PREP.encode()).hexdigest()[:20])
    if keep:
        if key in ref_cache:
            return ref_cache[key]
        if os.path.exists(disk + ".wav"):
            with open(disk + ".wav", "rb") as f:
                ref_cache[key] = f.read()
            return ref_cache[key]
        if os.path.exists(disk + ".same"):
            ref_cache[key] = None
            return None
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
        log(f"Reference clip is {len(wav) / sr:.0f}s: cloning from its clearest {REF_MAX_SECONDS:.0f}s "
            f"(from {start / sr:.1f}s)")
        wav = part
        buf = io.BytesIO()
        sf.write(buf, part, sr, format="WAV", subtype="PCM_16")
        cut = buf.getvalue()
    noise = noise_db(wav, sr)
    settled = True  # False while a noisy clip could not be cleaned: try again another time
    if noise > REF_NOISY_DB:
        t0 = time.time()
        clean = clean_clip(wav, sr)
        if clean:
            log(f"Reference clip has noise {-noise:.0f} dB under the voice: cleaned it ({time.time() - t0:.1f}s)")
            cut = clean
        else:
            settled = False
    if not keep:
        return cut
    ref_cache[key] = cut
    if settled:
        try:
            os.makedirs(CLEAN_DIR, exist_ok=True)
            tmp = f"{disk}.{os.getpid()}.tmp"
            with open(tmp, "wb") as f:
                f.write(cut or b"")
            os.replace(tmp, disk + (".wav" if cut else ".same"))
        except OSError:
            pass
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


def fit_miss(wav, sr, fit):
    """How much faster than natural a take must play to fit its room (0 when it fits)."""
    import math

    if not fit:
        return 0.0
    # The line as it leaves finish_line: its speech plus the room kept around it.
    length = speech_seconds(wav, sr) + sum(LINE_PAD)
    return max(0.0, math.log(length / (fit * FIT_SLACK)))


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
        with denoiser_lock:
            denoiser["model"] = None
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


def best_take(model, kwargs, seed, spoken, sr, fit=None):
    """Speak once, and again with other seeds while the pace is off or the take overruns its
    room (fit, seconds); the most natural take that fits."""
    import numpy as np

    best = None  # (miss, wav)
    for take in range(PACE_TRIES):
        with gen_lock:
            seed_everything(seed + take * 7919)
            wav = np.asarray(model.generate(**kwargs), dtype=np.float32).reshape(-1)
        pace = speech_pace(spoken, wav, sr)
        over = fit_miss(wav, sr, fit)
        miss = pace_miss(pace) + over
        if best is None or miss < best[0]:
            best = (miss, wav)
        if miss == 0.0:
            break
        why = (f"needs {np.exp(over) * FIT_SLACK:.2f}x to fit its {fit:.1f}s" if over
               else f"{pace:.1f} letters/s, outside a natural {PACE_BAND[0]}-{PACE_BAND[1]}")
        log(f"Take {take + 1}: {why}{'; trying again' if take + 1 < PACE_TRIES else '; keeping the closest'}")
    return best[1]


def voice_anchor(model, base, ref_bytes, style, seed, sr):
    """The anchor wav for this voice and style, made from the reference clip the first time."""
    import soundfile as sf

    # Its words, how the clip is made ready and the guidance shape the anchor too: a change to any
    # of them makes it anew.
    tag = f"|{style}|{REF_PREP}|{base.get('cfg_value')}|{ANCHOR_TEXT}".encode("utf-8")
    key = hashlib.sha1(ref_bytes + tag).hexdigest()[:20]
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


def feeling_clip(voice_wav, feeling_bytes):
    """The clip of how this line is said, brought to the voice clip's level (wav bytes), or None
    when it is too short or unreadable. How loud the film's mix had the line says nothing about
    how it was said; the effort is in the voice itself.
    """
    import numpy as np
    import soundfile as sf

    def read(b):
        try:
            w, r = sf.read(io.BytesIO(b), dtype="float32", always_2d=True)
        except Exception:  # noqa: BLE001 - an mp3 older libsndfile builds cannot read
            import librosa

            w, r = librosa.load(io.BytesIO(b), sr=None, mono=False)
            w = np.atleast_2d(w).T
        return w.mean(axis=1), r

    try:
        feel, sr = read(feeling_bytes)
    except Exception:  # noqa: BLE001
        log("Could not read the line's own clip; speaking from the voice clip alone.")
        return None
    if speech_seconds(feel, sr) < FEELING_MIN_SECONDS:
        return None
    feel = feel[: int(FEELING_MAX_SECONDS * sr)]
    voice, vsr = read(voice_wav)

    def level(w, r):
        _, db = frame_db(w, r)
        speech = db[db > db.max() - 35]
        return 20 * np.log10(np.mean(10 ** (speech / 20))) if len(speech) else -120.0

    feel = feel * 10 ** (max(-20.0, min(20.0, level(voice, vsr) - level(feel, sr))) / 20)
    peak = float(np.abs(feel).max()) if len(feel) else 0.0
    if peak > 0.98:
        feel = feel * (0.98 / peak)
    buf = io.BytesIO()
    sf.write(buf, feel.astype(np.float32), sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


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
            clip = prepared_reference(ref_bytes)
        except Exception:  # noqa: BLE001 - an unreadable clip still goes to VoxCPM2 whole
            log("Could not read the reference clip to prepare it; using it whole:\n" + traceback.format_exc())
            clip = None
        fd, tmp = tempfile.mkstemp(prefix="drd_ref_", suffix=".wav" if clip else ext)
        with os.fdopen(fd, "wb") as f:
            f.write(clip or ref_bytes)
        ref_path = tmp

    # How this line is said: the line's own clip (see FEELING_MIN_SECONDS).
    feeling_path = None
    feeling_from = str(payload.get("feeling_from") or "")
    fb64 = payload.get("feeling_audio_base64")
    if ref_path and fb64:
        try:
            feel_bytes = base64.b64decode(fb64)
            # Cleaned like a voice clip: what is left under separated vocals blurred the actor's
            # pitch (on 96 lines the dub followed it at r 0.19 cleaned, 0.12 not; its range 0.46
            # against -0.04), though not the Khmer. A line's own clip is used once: not kept.
            own_line = feeling_from in ("line", "line-center")
            felt = feeling_clip(open(ref_path, "rb").read(),
                                prepared_reference(feel_bytes, keep=not own_line) or feel_bytes)
        except Exception:  # noqa: BLE001 - the line is still spoken from the voice's clip alone
            log("Could not use the line's own clip:\n" + traceback.format_exc())
            felt = None
        if felt:
            fd, feeling_path = tempfile.mkstemp(prefix="drd_feel_", suffix=".wav")
            with os.fdopen(fd, "wb") as f:
                f.write(felt)

    spoken = text
    # With the line's own delivery to copy, the voice speaks from its calm anchor and the
    # feeling comes from that clip; a written emotion would pull against what the actor did.
    emotion = "neutral" if feeling_path else payload.get("emotion")
    style = style_instruction(emotion, payload.get("instruction"), text, bool(ref_path))
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
        if feeling_path and "reference_wav_path" in base:
            base = {**base, "reference_wav_path": feeling_path}
        if anchor:
            # Continue from the anchor: it already carries the voice and the style.
            kwargs = {**base, "text": spoken, "prompt_wav_path": anchor, "prompt_text": ANCHOR_TEXT}
        else:
            # VoxCPM2 takes a voice / style description in brackets before the text.
            kwargs = {**base, "text": f"({style}){spoken}" if style else spoken}
        try:
            fit = float(payload.get("fit_seconds") or 0) or None
        except (TypeError, ValueError):
            fit = None
        if fit is not None and not 0.3 <= fit <= 60:
            fit = None
        wav = finish_line(best_take(model, kwargs, seed, spoken, sr, fit), sr, line_level(payload))
        buf = io.BytesIO()
        sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
        dur = len(wav) / float(sr)
        log(f"Spoke {len(spoken)} chars -> {dur:.1f}s audio in {time.time() - t0:.1f}s"
            f"{' (cloned)' if ref_path else ''}{' from its anchor' if anchor else ''}{f' [{style}]' if style else ''}"
            f"{f' as said in the {FEELING_SOURCES.get(feeling_from, feeling_from)}' if feeling_path else ''}")
        return {"success": True, "audio_base64": base64.b64encode(buf.getvalue()).decode("ascii"),
                "duration": dur, "sample_rate": sr}
    finally:
        for p in (tmp, feeling_path):
            if p:
                try:
                    os.remove(p)
                except OSError:
                    pass


def find_speakers(payload):
    """Who speaks each line (voxcpm2_speakers.py), from the lines' audio the app sends."""
    import numpy as np
    import soundfile as sf

    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:  # copied beside this file; python -I leaves this folder off the path
        sys.path.insert(0, here)
    import voxcpm2_speakers

    src = payload.get("audio_path")
    if src:
        src = str(src)
        if not src.lower().endswith(".wav") or not os.path.isfile(src):
            raise ValueError("The lines' audio file was not found.")
    elif payload.get("audio_base64"):
        src = io.BytesIO(base64.b64decode(payload["audio_base64"]))
    else:
        raise ValueError("No audio was sent.")
    wav, sr = sf.read(src, dtype="float32", always_2d=True)
    wav = wav.mean(axis=1)
    if sr != voxcpm2_speakers.SR:
        import librosa

        wav = librosa.resample(wav, orig_sr=sr, target_sr=voxcpm2_speakers.SR).astype(np.float32)
    lines = payload.get("lines") or []
    if not isinstance(lines, list):
        raise ValueError("lines must be a list.")
    known = payload.get("known") or []
    with speakers_lock:
        return voxcpm2_speakers.find_speakers(wav, lines, known=known if isinstance(known, list) else [], log=log)


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
        if route == "/api/speakers":
            # Its own small model on the CPU: no need to wait for VoxCPM2 to load.
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0 or n > MAX_SPEAKERS_BODY:
                    return self._json(413, {"success": False, "error": "Request too large."})
                payload = json.loads(self.rfile.read(n).decode("utf-8"))
                return self._json(200, {"success": True, **find_speakers(payload)})
            except Exception as e:  # noqa: BLE001
                log("Finding the speakers failed:\n" + traceback.format_exc())
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
