#!/usr/bin/env python3
"""
DR Dubber — High-Performance Local Whisper Transcription Engine
Transcribes audio/video files to SRT format with faster-whisper (CTranslate2) or openai-whisper.
"""

import sys
import os
import argparse
import time
import gc

def format_timestamp(seconds: float) -> str:
    """Format seconds into standard SRT timestamp: HH:MM:SS,mmm"""
    if seconds < 0:
        seconds = 0
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis >= 1000:
        millis = 999
    return f"{hrs:02d}:{mins:02d}:{secs:02d},{millis:03d}"

def detect_best_device(requested_device: str):
    """Resolve optimal hardware device and compute type."""
    if requested_device and requested_device.lower() != "auto":
        dev = requested_device.lower()
        compute = "float16" if dev == "cuda" else "int8"
        return dev, compute

    try:
        import ctranslate2
        supported = ctranslate2.get_supported_compute_types("cuda")
        if "float16" in supported:
            return "cuda", "float16"
        elif "int8_float16" in supported:
            return "cuda", "int8_float16"
    except Exception:
        pass

    return "cpu", "int8"

def transcribe_faster_whisper(audio_path, output_srt, model_size="medium", device="auto", language=None, beam_size=1):
    """Transcribe using faster-whisper (CTranslate2 engine) with optimized multi-threading & greedy decoding."""
    from faster_whisper import WhisperModel

    resolved_device, compute_type = detect_best_device(device)
    cpu_cores = os.cpu_count() or 4
    cpu_threads = min(8, cpu_cores) if resolved_device == "cpu" else 0
    num_workers = 2 if cpu_cores >= 4 else 1

    print(f"[Whisper ⚡] Initializing faster-whisper model '{model_size}' on '{resolved_device}' ({compute_type}, threads={cpu_threads or 'auto'}, workers={num_workers}, beam_size={beam_size})...", flush=True)

    t_start_load = time.time()
    model = WhisperModel(
        model_size,
        device=resolved_device,
        compute_type=compute_type,
        cpu_threads=cpu_threads,
        num_workers=num_workers
    )
    print(f"[Whisper ⚡] Model ready in {time.time() - t_start_load:.2f}s", flush=True)

    print(f"[Whisper 🎙️] Processing audio: {os.path.basename(audio_path)}", flush=True)
    t_start_transcribe = time.time()

    transcribe_kwargs = {
        "beam_size": max(1, int(beam_size)),
        "vad_filter": True,
        "vad_parameters": dict(min_silence_duration_ms=400)
    }
    if language and language.lower() != "auto":
        transcribe_kwargs["language"] = language

    segments, info = model.transcribe(audio_path, **transcribe_kwargs)

    prob_pct = f"{info.language_probability * 100:.0f}%" if hasattr(info, "language_probability") else "N/A"
    print(f"[Whisper 🌐] Language: {info.language.upper()} ({prob_pct}) | Duration: {info.duration:.1f}s", flush=True)

    cues = []
    os.makedirs(os.path.dirname(os.path.abspath(output_srt)), exist_ok=True)
    with open(output_srt, "w", encoding="utf-8") as f:
        for idx, seg in enumerate(segments, 1):
            start_str = format_timestamp(seg.start)
            end_str = format_timestamp(seg.end)
            text = seg.text.strip()
            cue_str = f"{idx}\n{start_str} --> {end_str}\n{text}\n\n"
            cues.append(cue_str)
            f.write(cue_str)
            f.flush()
            print(f"[{start_str} ➔ {end_str}] {text}")

    elapsed = time.time() - t_start_transcribe
    print(f"[Whisper ✨] Complete! Generated {len(cues)} subtitle cues in {elapsed:.2f}s", flush=True)
    print(f"[Whisper 📁] Saved SRT: {output_srt}", flush=True)

    del model
    gc.collect()
    return True

def transcribe_openai_whisper(audio_path, output_srt, model_size="medium", device="auto", language=None):
    """Fallback transcription using openai-whisper."""
    import whisper

    resolved_device = "cuda" if device == "cuda" else ("cpu" if device == "cpu" else ("cuda" if detect_best_device("auto")[0] == "cuda" else "cpu"))
    print(f"[Whisper ⚡] Fallback: Loading OpenAI Whisper model '{model_size}' on '{resolved_device}'...", flush=True)
    model = whisper.load_model(model_size, device=resolved_device)

    transcribe_options = {
        "fp16": (resolved_device == "cuda")
    }
    if language and language.lower() != "auto":
        transcribe_options["language"] = language

    print(f"[Whisper 🎙️] Processing audio: {os.path.basename(audio_path)}", flush=True)
    t_start = time.time()
    result = model.transcribe(audio_path, **transcribe_options)

    cues = []
    os.makedirs(os.path.dirname(os.path.abspath(output_srt)), exist_ok=True)
    with open(output_srt, "w", encoding="utf-8") as f:
        for idx, seg in enumerate(result.get("segments", []), 1):
            start_str = format_timestamp(seg["start"])
            end_str = format_timestamp(seg["end"])
            text = seg["text"].strip()
            cue_str = f"{idx}\n{start_str} --> {end_str}\n{text}\n\n"
            cues.append(cue_str)
            f.write(cue_str)
            f.flush()
            print(f"[{start_str} ➔ {end_str}] {text}")

    elapsed = time.time() - t_start
    print(f"[Whisper ✨] Complete! Generated {len(cues)} subtitle cues in {elapsed:.2f}s", flush=True)
    print(f"[Whisper 📁] Saved SRT: {output_srt}", flush=True)

    del model
    gc.collect()
    return True

def main():
    parser = argparse.ArgumentParser(
        description="DR Dubber — High-Performance Local Whisper Transcription",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument("--audio", "--input", "-i", dest="audio", required=True, help="Input audio or video file path")
    parser.add_argument("--output_srt", "--output", "-o", dest="output_srt", default=None, help="Output .srt file path")
    parser.add_argument("--model", "-m", default="medium", help="Whisper model size (tiny, base, small, medium, large-v3)")
    parser.add_argument("--device", "-d", default="auto", help="Hardware device: auto, cpu, cuda")
    parser.add_argument("--language", "-l", default="auto", help="Language code (e.g. en, zh, ja, or auto)")
    parser.add_argument("--beam_size", "-b", type=int, default=1, help="Beam size (1 for 3x fastest greedy decoding, 5 for standard beam)")

    args = parser.parse_args()

    if not os.path.exists(args.audio):
        print(f"[Whisper Error] Audio file not found: {args.audio}", file=sys.stderr, flush=True)
        sys.exit(1)

    output_srt = args.output_srt
    if not output_srt:
        base_name = os.path.splitext(args.audio)[0]
        output_srt = f"{base_name}.srt"

    # Attempt faster-whisper first, then fallback to openai-whisper
    try:
        transcribe_faster_whisper(args.audio, output_srt, args.model, args.device, args.language, args.beam_size)
    except ImportError:
        print("[Whisper] 'faster-whisper' not found in environment, trying 'whisper' fallback...", flush=True)
        try:
            transcribe_openai_whisper(args.audio, output_srt, args.model, args.device, args.language)
        except ImportError:
            print("[Whisper Error] Speech recognition packages missing in current Python environment.", file=sys.stderr, flush=True)
            print("Run './setup.sh' (macOS/Linux) or 'setup.bat' (Windows) to install dependencies.", file=sys.stderr, flush=True)
            sys.exit(1)
    except Exception as e:
        print(f"[Whisper Error] Transcription failed: {e}", file=sys.stderr, flush=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
