#!/usr/bin/env python3
"""
Takes the music out of a BGM stem and keeps the sound effects (footsteps,
hits, doors, rain, crowds), for dubs whose music may be copyrighted.

Uses ZFTurbo's MVSEP-CDX23 model (MIT licence): a Demucs 4 network trained on
the Divide-and-Remaster film dataset that splits a soundtrack into music,
sound effects and speech (github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing).
It needs torch + demucs, so vocal_separator.py runs this script in the Demucs
Python, not the app's own.

It is fed the BGM the vocal separator already made, not the original mix:
the voice is then already gone (on a drama tab the speech stem came out at
-50 dB) and only the sound effects are written. On that tab, stretches with
only music dropped to about -50 dB in the effects stem and hits stayed in it.
CPU speed was ~0.5x real time (90 s of audio in 41 s on 8 threads).

Prints "[music] done/total" to stderr as it goes and one JSON line at the end.
"""

import argparse
import hashlib
import json
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

MODEL_NAME = "97d170e1-dbb4db15.th"
MODEL_URL = "https://github.com/ZFTurbo/MVSEP-CDX23-Cinematic-Sound-Demixing/releases/download/v.1.0.0/" + MODEL_NAME
# Demucs checkpoints are named after the start of their sha256.
MODEL_SHA256_PREFIX = "dbb4db15"
# Share of each segment the next one also covers. 0.25 is Demucs' own default;
# CDX23's script uses 0.8, which is 3.75x the work.
OVERLAP = 0.25


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def ensure_model(model_dir):
    """The checkpoint in model_dir, downloaded (54 MB) the first time."""
    import torch
    path = os.path.join(model_dir, MODEL_NAME)
    if os.path.isfile(path):
        return path
    os.makedirs(model_dir, exist_ok=True)
    part = f"{path}.{os.getpid()}.part"
    try:
        torch.hub.download_url_to_file(MODEL_URL, part, progress=False)
        if not sha256_of(part).startswith(MODEL_SHA256_PREFIX):
            raise RuntimeError("the downloaded music model is damaged (checksum does not match)")
        os.replace(part, path)
    finally:
        if os.path.exists(part):
            os.remove(part)
    return path


def remove_music(input_path, output_path, model_dir, ffmpeg="ffmpeg", device=None, threads=None):
    import numpy as np
    import torch
    from demucs.apply import apply_model
    from demucs.states import load_model
    import onnx_separator  # read_audio / write_wav: numpy + ffmpeg only

    if threads:
        torch.set_num_threads(int(threads))
    if device != "cpu":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    model = load_model(ensure_model(model_dir))
    model.eval()
    if model.samplerate != onnx_separator.SAMPLE_RATE:
        raise RuntimeError(f"the music model expects {model.samplerate} Hz audio")

    mix = onnx_separator.read_audio(input_path, ffmpeg)
    x = torch.from_numpy(mix[None])
    stride = int((1 - OVERLAP) * model.samplerate * float(model.segment))
    total = max(1, -(-x.shape[-1] // stride))
    done = [0]

    def progress(info):
        if info.get("state") == "end":
            done[0] += 1
            sys.stderr.write(f"[music] {min(done[0], total)}/{total}\n")
            sys.stderr.flush()

    def run(dev):
        done[0] = 0
        model.to(dev)
        with torch.no_grad():
            # No shifts: CDX23's script uses one random shift, which only makes two runs
            # of a tab differ (by -14 dB) without averaging anything.
            return apply_model(model, x, shifts=0, overlap=OVERLAP, device=dev, callback=progress)[0]

    try:
        out = run(device)
    except RuntimeError as e:
        # A 6 GB laptop GPU can be full (VoxCPM2 still loaded): the CPU gives the same result.
        if device == "cpu" or "out of memory" not in str(e).lower():
            raise
        torch.cuda.empty_cache()
        device = "cpu"
        out = run(device)
    sfx = out[model.sources.index("sfx")].numpy()
    onnx_separator.write_wav(output_path, np.ascontiguousarray(sfx))
    return device


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="Remove the music from a BGM stem, keep the sound effects")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--device", default=None, help="cpu to stay off the GPU")
    parser.add_argument("--threads", default=None, type=int)
    args = parser.parse_args()
    try:
        device = remove_music(args.input, args.output, args.model_dir, args.ffmpeg, args.device, args.threads)
        print(json.dumps({"success": True, "bgm": os.path.abspath(args.output), "device": device}))
    except MemoryError:
        print(json.dumps({"success": False, "error": "not enough free memory for this audio"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == "__main__":
    main()
