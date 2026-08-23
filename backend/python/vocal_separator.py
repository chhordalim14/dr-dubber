#!/usr/bin/env python3
"""
Audio Vocal & Background Music (BGM) Separator
High-Performance Single-Pass FFmpeg & Spleeter Stem Isolation.
"""

import sys
import os
import os.path
import subprocess
import argparse
import json
import time

# Previously hardcoded to a different machine/project's absolute path
# ("DAI-Dubber-PRO", not this repo's "ai-dubber-pro"), so os.path.exists()
# was always False on a real install and the "high-fidelity Spleeter" path
# silently never ran -- every user got the crude ffmpeg fallback below with
# no indication the real separator never executed. Now configurable via env
# vars, with a couple of relative fallback locations, so a real install can
# actually be picked up.
SPLEETER_PYTHON = os.environ.get("SPLEETER_PYTHON") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "spleeter-env",
    "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python"
)
PRETRAINED_MODELS = os.environ.get("SPLEETER_MODELS_PATH") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "pretrained_models"
)

def separate_spleeter(input_audio, output_dir):
    try:
        output_dir = os.path.abspath(output_dir)
        os.makedirs(output_dir, exist_ok=True)
        if os.path.exists(SPLEETER_PYTHON):
            # No "-d" duration cap: the previous hardcoded "-d 600" silently
            # truncated any separation to the first 10 minutes with no error
            # surfaced, which would have resurfaced the moment the path above
            # was fixed. A full-length dubbing project needs the whole track.
            cmd = [
                SPLEETER_PYTHON, "-m", "spleeter", "separate",
                "-p", "spleeter:2stems",
                "-o", output_dir,
                input_audio
            ]
            env = os.environ.copy()
            env["MODEL_PATH"] = PRETRAINED_MODELS

            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            base_name = os.path.splitext(os.path.basename(input_audio))[0]
            stem_dir = os.path.join(output_dir, base_name)
            vocal_path = os.path.join(stem_dir, "vocals.wav")
            accompaniment_path = os.path.join(stem_dir, "accompaniment.wav")

            if os.path.exists(accompaniment_path):
                return {
                    "success": True,
                    "method": "spleeter",
                    "vocal": os.path.abspath(vocal_path),
                    "bgm": os.path.abspath(accompaniment_path)
                }
            elif res.returncode != 0:
                sys.stderr.write(f"[Spleeter] exit code {res.returncode}: {res.stderr}\n")

        # Fallback to high-speed single-pass FFmpeg separation
        return separate_ffmpeg(input_audio, output_dir)
    except Exception as e:
        return separate_ffmpeg(input_audio, output_dir)

def separate_ffmpeg(input_audio, output_dir):
    """
    High-Speed Single-Pass FFmpeg separation (splits stereo field and applies vocal/BGM isolation in 1 pass).
    2x faster than sequential passes.
    """
    try:
        output_dir = os.path.abspath(output_dir)
        os.makedirs(output_dir, exist_ok=True)
        base_name = os.path.splitext(os.path.basename(input_audio))[0]
        # A per-job suffix (pid + timestamp) avoids two concurrent
        # /api/remove-vocals calls on same-named uploads (or a rerun while a
        # prior job is still processing) overwriting/cross-contaminating each
        # other's output files in this shared SEPARATED_DIR.
        job_suffix = f"{os.getpid()}_{int(time.time() * 1000)}"
        bgm_path = os.path.join(output_dir, f"{base_name}_{job_suffix}_bgm.wav")
        vocal_path = os.path.join(output_dir, f"{base_name}_{job_suffix}_vocals.wav")

        threads = str(min(8, os.cpu_count() or 4))
        filter_graph = (
            "[0:a]asplit=2[a_bgm_in][a_voc_in];"
            "[a_bgm_in]stereotools=mutec=1[bgm];"
            "[a_voc_in]stereotools=mutel=1:muter=1,highpass=f=200,lowpass=f=3500[vocal]"
        )

        cmd = [
            "ffmpeg", "-y", "-threads", threads, "-i", input_audio,
            "-filter_complex", filter_graph,
            "-map", "[bgm]", "-vn", bgm_path,
            "-map", "[vocal]", "-vn", vocal_path
        ]

        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if res.returncode != 0:
            # check=True previously discarded ffmpeg's actual stderr (the
            # useful diagnostic) and surfaced only "returned non-zero exit
            # status N" to the caller.
            tail = "\n".join(res.stderr.strip().splitlines()[-5:])
            return {"success": False, "error": f"ffmpeg exited with code {res.returncode}: {tail}"}

        return {
            "success": True,
            "method": "ffmpeg_single_pass",
            "vocal": os.path.abspath(vocal_path),
            "bgm": os.path.abspath(bgm_path)
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="Stem & Vocal Separator")
    parser.add_argument("--input", required=True, help="Input audio or video file")
    parser.add_argument("--output", required=True, help="Output directory")

    args = parser.parse_args()
    result = separate_spleeter(args.input, args.output)
    print(json.dumps(result))

if __name__ == "__main__":
    main()
