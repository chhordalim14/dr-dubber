#!/usr/bin/env python3
"""
Takes the music out of a BGM stem and keeps the sound effects (footsteps,
hits, doors, rain, crowds), for dubs whose music may be copyrighted. With
--keep music it does the opposite: keeps only the music and drops the effects.

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

# Set before torch loads: a step Apple's GPU (MPS) can't do runs on the CPU instead of failing.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

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


def pick_device(torch):
    """NVIDIA's GPU, else Apple's (an M4: 7.9x real time against 5.9x on 5 CPU threads, the
    same effects stem: 117 dB apart), else the CPU."""
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def free_gpu_memory(torch, device):
    try:
        if device == "cuda":
            torch.cuda.empty_cache()
        elif device == "mps":
            torch.mps.empty_cache()
    except Exception:
        pass


# What Settings > Remove music can keep: the model's stem of that name.
KEEP_STEMS = ("sfx", "music")


def separate_stem(model, x, device, output_path, stem_idx):
    """
    Writes one stem of x (a [1, 2, n] tensor) to output_path. It is apply_model's
    own split loop (the same segments, weights and sums, so the same samples) but keeps
    only that stem, and writes each stretch once no later segment reaches it:
    apply_model built all three stems for the whole tab first, three more copies of it
    (636 MB for 10 minutes, 2 GB for a joined episode).
    """
    import wave

    import torch
    from demucs.apply import TensorChunk, apply_model
    import onnx_separator

    dev = torch.device(device)
    model.to(dev)
    length = x.shape[-1]
    seg = int(model.samplerate * float(model.segment))
    stride = int((1 - OVERLAP) * seg)
    offsets = range(0, length, stride)
    weight = torch.cat([torch.arange(1, seg // 2 + 1, device=dev),
                        torch.arange(seg - seg // 2, 0, -1, device=dev)])
    weight = (weight / weight.max()) ** 1.0  # apply_model's transition_power
    # The kept stem and the weights summed into it, from sample `base` on.
    acc = torch.zeros(1, x.shape[1], seg)
    acc_w = torch.zeros(seg)
    base = 0
    with wave.open(output_path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(onnx_separator.SAMPLE_RATE)
        for k, offset in enumerate(offsets):
            with torch.no_grad():
                # No shifts: CDX23's script uses one random shift, which only makes two
                # runs of a tab differ (by -14 dB) without averaging anything.
                out = apply_model(model, TensorChunk(x, offset, seg), shifts=0, split=False,
                                  overlap=OVERLAP, device=dev)
            if dev.type != "cpu" and not torch.isfinite(out).all():
                raise FloatingPointError("the GPU gave back invalid numbers")
            n = out.shape[-1]
            acc[..., offset - base:offset - base + n] += (weight[:n] * out[:, stem_idx]).to("cpu")
            acc_w[offset - base:offset - base + n] += weight[:n].to("cpu")
            del out
            # Nothing after this segment reaches back before the next one's start.
            done = min(offset + stride, length) if k + 1 < len(offsets) else length
            m = done - base
            w.writeframes(onnx_separator.to_pcm16((acc[0, :, :m] / acc_w[:m]).numpy()))
            acc[..., :seg - m] = acc[..., m:].clone()
            acc[..., seg - m:] = 0
            acc_w[:seg - m] = acc_w[m:].clone()
            acc_w[seg - m:] = 0
            base = done
            sys.stderr.write(f"[music] {k + 1}/{len(offsets)}\n")
            sys.stderr.flush()


def remove_music(input_path, output_path, model_dir, ffmpeg="ffmpeg", device=None, threads=None, keep="sfx"):
    if keep not in KEEP_STEMS:
        raise ValueError(f"unknown stem to keep: {keep}")
    import torch
    from demucs.states import load_model
    import onnx_separator  # read_audio: numpy + ffmpeg only

    if threads:
        torch.set_num_threads(int(threads))
    if device != "cpu":
        device = pick_device(torch)
    model = load_model(ensure_model(model_dir))
    model.eval()
    if model.samplerate != onnx_separator.SAMPLE_RATE:
        raise RuntimeError(f"the music model expects {model.samplerate} Hz audio")

    x = torch.from_numpy(onnx_separator.read_audio(input_path, ffmpeg)[None])
    stem_idx = model.sources.index(keep)
    try:
        separate_stem(model, x, device, output_path, stem_idx)
    except Exception as e:
        # The CPU gives the same result. CUDA: a 6 GB laptop GPU can be full (VoxCPM2 still
        # loaded). Apple's GPU (MPS): any failure, as torch's support for it is the newest.
        if not (device == "mps" or isinstance(e, FloatingPointError)
                or (device == "cuda" and isinstance(e, RuntimeError) and "out of memory" in str(e).lower())):
            raise
        sys.stderr.write(f"[Remove music] the GPU ({device}) failed ({e}): running on the CPU\n")
        sys.stderr.flush()
        free_gpu_memory(torch, device)
        device = "cpu"
        separate_stem(model, x, device, output_path, stem_idx)
    return device


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="Remove the music from a BGM stem, keep the sound effects (or keep only the music)")
    parser.add_argument("--input", required=True)
    parser.add_argument("--keep", default="sfx", choices=KEEP_STEMS, help="sfx: the sound effects (default); music: only the music")
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--device", default=None, help="cpu to stay off the GPU")
    parser.add_argument("--threads", default=None, type=int)
    args = parser.parse_args()
    try:
        device = remove_music(args.input, args.output, args.model_dir, args.ffmpeg, args.device, args.threads, args.keep)
        print(json.dumps({"success": True, "bgm": os.path.abspath(args.output), "device": device, "keep": args.keep}))
    except MemoryError:
        print(json.dumps({"success": False, "error": "not enough free memory for this audio"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))


if __name__ == "__main__":
    main()
