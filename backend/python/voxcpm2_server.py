"""DR Dubber Pro - local VoxCPM2 server.

Installed by Settings -> VoxCPM2 AI -> Install VoxCPM2 as <install dir>/app.py and
started by "Start Server" (python app.py --port 8808). Speaks the small API the app
uses (backend/server.js /api/generate-voxcmp2 and the page's direct call):

  GET  /              200 {"status": "ready"} once the model is loaded,
                      503 {"status": "loading"} while it loads, 500 if it failed
  POST /api/generate  {"text", "instruction", "reference_audio_base64",
                       "reference_audio", "cfg_value"}
                      -> {"success": true, "audio_base64": <wav>, "duration": s,
                          "sample_rate": hz}

Only listens on 127.0.0.1. Never writes anywhere but a temp file for the
reference clip; the app saves the returned audio itself.
"""

import argparse
import base64
import inspect
import io
import json
import os
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


def synthesize(payload):
    model = state["model"]
    text = str(payload.get("text") or "").strip()
    if not text:
        raise ValueError("No text to speak.")
    instruction = str(payload.get("instruction") or "").strip()
    if instruction:
        # VoxCPM2 takes a voice / style description in brackets before the text.
        text = f"({instruction.strip('()')}){text}"

    ref_path = None
    tmp = None
    b64 = payload.get("reference_audio_base64")
    if b64:
        ext = os.path.splitext(str(payload.get("reference_audio") or ""))[1].lower()
        if ext not in (".wav", ".mp3", ".flac", ".ogg", ".m4a"):
            ext = ".wav"
        fd, tmp = tempfile.mkstemp(prefix="drd_ref_", suffix=ext)
        with os.fdopen(fd, "wb") as f:
            f.write(base64.b64decode(b64))
        ref_path = tmp

    try:
        try:
            cfg = float(payload.get("cfg_value") or 2.0)
        except (TypeError, ValueError):
            cfg = 2.0
        # generate(*args, **kwargs) forwards to _generate, which names the real options.
        params = inspect.signature(getattr(model, "_generate", model.generate)).parameters
        kwargs = {"text": text}
        if "cfg_value" in params:
            kwargs["cfg_value"] = max(0.5, min(5.0, cfg))
        if "inference_timesteps" in params:
            kwargs["inference_timesteps"] = DEFAULT_STEPS
        if ref_path:
            if "reference_wav_path" in params:
                kwargs["reference_wav_path"] = ref_path
            elif "prompt_wav_path" in params:
                kwargs["prompt_wav_path"] = ref_path
        t0 = time.time()
        with gen_lock:
            wav = model.generate(**kwargs)
        import numpy as np
        import soundfile as sf

        wav = np.asarray(wav, dtype=np.float32).reshape(-1)
        sr = state["sr"]
        buf = io.BytesIO()
        sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
        dur = len(wav) / float(sr)
        log(f"Spoke {len(text)} chars -> {dur:.1f}s audio in {time.time() - t0:.1f}s"
            f"{' (cloned)' if ref_path else ''}")
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
            code = {"ready": 200, "loading": 503}.get(state["status"], 500)
            return self._json(code, {"status": state["status"], "device": state["device"],
                                     "model": MODEL_ID, "error": state["error"]})
        self._json(404, {"success": False, "error": "Not found"})

    def do_POST(self):
        if self.path.split("?")[0] not in ("/api/generate", "/generate"):
            return self._json(404, {"success": False, "error": "Not found"})
        if state["status"] != "ready":
            msg = state["error"] if state["status"] == "error" else "The VoxCPM2 model is still loading. Try again in a moment."
            return self._json(503, {"success": False, "error": msg})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self._json(413, {"success": False, "error": "Request too large."})
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
            self._json(200, synthesize(payload))
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
