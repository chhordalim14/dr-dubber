#!/usr/bin/env python3
"""
Audio Vocal & Background Music (BGM) Separator
Demucs (ML-based) stem isolation, falling back to single-pass FFmpeg separation.
"""

import sys
import os
import os.path
import subprocess
import argparse
import json
import time

def ensure_ffmpeg_in_path():
    if os.name != "nt":
        return
    extra_paths = []
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        extra_paths.append(os.path.join(local_app_data, "Microsoft", "WinGet", "Links"))
        extra_paths.append(os.path.join(local_app_data, "Programs"))
        winget_pkgs = os.path.join(local_app_data, "Microsoft", "WinGet", "Packages")
        if os.path.isdir(winget_pkgs):
            try:
                for entry in os.listdir(winget_pkgs):
                    if "ffmpeg" in entry.lower():
                        base = os.path.join(winget_pkgs, entry)
                        extra_paths.append(base)
                        for sub in os.listdir(base):
                            sub_path = os.path.join(base, sub)
                            if os.path.isdir(sub_path):
                                extra_paths.append(os.path.join(sub_path, "bin"))
                                extra_paths.append(sub_path)
            except Exception:
                pass
    prog_files = os.environ.get("ProgramFiles", "C:\\Program Files")
    prog_files_x86 = os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")
    extra_paths.extend([
        "C:\\ffmpeg\\bin", "C:\\ffmpeg",
        os.path.join(prog_files, "ffmpeg", "bin"), os.path.join(prog_files, "ffmpeg"),
        os.path.join(prog_files_x86, "ffmpeg", "bin"),
        "C:\\tools\\ffmpeg\\bin",
        "C:\\ProgramData\\chocolatey\\bin"
    ])
    user_profile = os.environ.get("USERPROFILE", "")
    if user_profile:
        extra_paths.append(os.path.join(user_profile, "scoop", "shims"))

    current_path = os.environ.get("PATH", "")
    current_set = {os.path.abspath(p).lower() for p in current_path.split(os.pathsep) if p}
    to_add = [p for p in extra_paths if os.path.isdir(p) and os.path.abspath(p).lower() not in current_set]
    if to_add:
        os.environ["PATH"] = os.pathsep.join(to_add + [current_path])

ensure_ffmpeg_in_path()

# Demucs runs in its own venv (backend/demucs-env) rather than the main
# backend env because it pulls in a specific torch/torchaudio pin that would
# otherwise fight with the rest of the app's Python dependencies. A user can
# instead point --demucs-folder at their own portable Demucs install (the
# "Demucs Folder Path" setting in the UI); that folder's own python is used
# in preference to the bundled venv when present.
DEMUCS_PYTHON_DEFAULT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "demucs-env",
    "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python"
)
DEMUCS_MODEL = os.environ.get("DEMUCS_MODEL") or "htdemucs"

def find_python_in_folder(folder):
    if not folder:
        return None
    candidates = [
        os.path.join(folder, "python-embed", "python.exe"),
        os.path.join(folder, "python-embed", "python"),
        os.path.join(folder, "Scripts", "python.exe"),
        os.path.join(folder, "bin", "python"),
        os.path.join(folder, "python.exe"),
        os.path.join(folder, "python"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None

def separate_demucs(input_audio, output_dir, demucs_folder=None, segment=None, device=None):
    """
    High-fidelity ML-based separation via Demucs (htdemucs model). Produces a
    genuine isolated vocal stem and a clean instrumental/BGM stem, unlike the
    ffmpeg fallback's crude center-channel-cancellation trick below, which
    only cancels dead-center-panned content and leaves the BGM thin, hollow,
    and missing anything (bass, kick, off-center vocal harmonies) that trick
    can't touch.
    """
    demucs_python = find_python_in_folder(demucs_folder) or os.environ.get("DEMUCS_PYTHON") or DEMUCS_PYTHON_DEFAULT
    if not os.path.exists(demucs_python):
        return None
    try:
        output_dir = os.path.abspath(output_dir)
        # Job-specific output root avoids two concurrent separations of a
        # same-named input colliding on demucs's fixed
        # "<out>/<model>/<track_name>/" output layout.
        job_suffix = f"{os.getpid()}_{int(time.time() * 1000)}"
        job_dir = os.path.join(output_dir, f"demucs_{job_suffix}")
        os.makedirs(job_dir, exist_ok=True)

        cmd = [
            demucs_python, "-m", "demucs",
            "--two-stems=vocals",
            "-n", DEMUCS_MODEL,
            "-o", job_dir,
        ]
        # Only force a device when the caller explicitly wants CPU (Safe Mode).
        # Otherwise let demucs auto-detect (its own default: cuda if available,
        # else cpu) -- forcing "cuda" here would hard-fail on a torch build/
        # machine without working CUDA instead of gracefully using the CPU.
        if device == "cpu":
            cmd += ["-d", "cpu"]
        if segment:
            cmd += ["--segment", str(segment)]
        cmd.append(input_audio)

        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")

        base_name = os.path.splitext(os.path.basename(input_audio))[0]
        stem_dir = os.path.join(job_dir, DEMUCS_MODEL, base_name)
        vocal_path = os.path.join(stem_dir, "vocals.wav")
        bgm_path = os.path.join(stem_dir, "no_vocals.wav")

        if os.path.exists(bgm_path) and os.path.exists(vocal_path):
            return {
                "success": True,
                "method": "demucs",
                "vocal": os.path.abspath(vocal_path),
                "bgm": os.path.abspath(bgm_path)
            }
        if res.returncode != 0:
            sys.stderr.write(f"[Demucs] exit code {res.returncode}: {res.stderr}\n")
        return None
    except Exception as e:
        sys.stderr.write(f"[Demucs] exception: {e}\n")
        return None

def separate(input_audio, output_dir, engine="ffmpeg", demucs_folder=None, segment=None, device=None):
    if engine == "demucs":
        result = separate_demucs(input_audio, output_dir, demucs_folder, segment, device)
        if result:
            return result
        sys.stderr.write("[Demucs] unavailable or failed, falling back to ffmpeg separation\n")
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
            "[0:a]aformat=channel_layouts=stereo,asplit=2[a_bgm_in][a_voc_in];"
            "[a_bgm_in]stereotools=mode=lr>l-r[bgm];"
            "[a_voc_in]stereotools=mode=lr>l+r,highpass=f=200,lowpass=f=3500[vocal]"
        )

        cmd = [
            "ffmpeg", "-y", "-threads", threads, "-i", input_audio,
            "-filter_complex", filter_graph,
            "-map", "[bgm]", "-vn", bgm_path,
            "-map", "[vocal]", "-vn", vocal_path
        ]

        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
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
    parser.add_argument("--engine", default="ffmpeg", choices=["ffmpeg", "demucs"], help="Separation engine")
    parser.add_argument("--demucs-folder", default=None, help="Optional portable Demucs install to use instead of the bundled one")
    parser.add_argument("--segment", default=None, help="Demucs chunk size (lower = less RAM)")
    parser.add_argument("--device", default=None, help="Demucs device override; omit to let demucs auto-detect")

    args = parser.parse_args()
    result = separate(args.input, args.output, engine=args.engine, demucs_folder=args.demucs_folder, segment=args.segment, device=args.device)
    print(json.dumps(result))

if __name__ == "__main__":
    main()
