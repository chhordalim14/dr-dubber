#!/usr/bin/env python3
"""
Audio Vocal & Background Music (BGM) Separator
Demucs & Spleeter (ML-based) stem isolation.
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

# Spleeter runs in its own venv (backend/spleeter-env) for the same reason as
# Demucs above -- it pulls in its own TensorFlow pin. A user can instead point
# --spleeter-folder at their own portable Spleeter install, same convention as
# --demucs-folder.
SPLEETER_PYTHON_DEFAULT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "spleeter-env",
    "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python"
)

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
    genuine isolated vocal stem and a clean instrumental/BGM stem.
    """
    demucs_python = find_python_in_folder(demucs_folder) or os.environ.get("DEMUCS_PYTHON") or (DEMUCS_PYTHON_DEFAULT if os.path.exists(DEMUCS_PYTHON_DEFAULT) else None) or (sys.executable if os.path.exists(sys.executable) else None)
    if not demucs_python or not os.path.exists(demucs_python):
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

def separate_spleeter(input_audio, output_dir, spleeter_folder=None):
    """
    ML-based separation via Spleeter's 2stems (vocals/accompaniment) model.
    """
    spleeter_python = find_python_in_folder(spleeter_folder) or os.environ.get("SPLEETER_PYTHON") or (SPLEETER_PYTHON_DEFAULT if os.path.exists(SPLEETER_PYTHON_DEFAULT) else None) or (sys.executable if os.path.exists(sys.executable) else None)
    if not spleeter_python or not os.path.exists(spleeter_python):
        return None
    try:
        output_dir = os.path.abspath(output_dir)
        # Job-specific output root avoids two concurrent separations of a
        # same-named input colliding on spleeter's fixed "<out>/<track_name>/"
        # output layout.
        job_suffix = f"{os.getpid()}_{int(time.time() * 1000)}"
        job_dir = os.path.join(output_dir, f"spleeter_{job_suffix}")
        os.makedirs(job_dir, exist_ok=True)

        cmd = [
            spleeter_python, "-m", "spleeter", "separate",
            "-p", "spleeter:2stems",
            "-o", job_dir,
            input_audio,
        ]

        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")

        base_name = os.path.splitext(os.path.basename(input_audio))[0]
        stem_dir = os.path.join(job_dir, base_name)
        vocal_path = os.path.join(stem_dir, "vocals.wav")
        bgm_path = os.path.join(stem_dir, "accompaniment.wav")

        if os.path.exists(bgm_path) and os.path.exists(vocal_path):
            return {
                "success": True,
                "method": "spleeter",
                "vocal": os.path.abspath(vocal_path),
                "bgm": os.path.abspath(bgm_path)
            }
        if res.returncode != 0:
            sys.stderr.write(f"[Spleeter] exit code {res.returncode}: {res.stderr}\n")
        return None
    except Exception as e:
        sys.stderr.write(f"[Spleeter] exception: {e}\n")
        return None

def separate(input_audio, output_dir, engine="demucs", demucs_folder=None, segment=None, device=None, spleeter_folder=None):
    if engine == "spleeter":
        result = separate_spleeter(input_audio, output_dir, spleeter_folder)
        if result:
            return result
        sys.stderr.write("[Spleeter] unavailable or failed, attempting Demucs separation\n")
        demucs_res = separate_demucs(input_audio, output_dir, demucs_folder, segment, device)
        if demucs_res:
            return demucs_res
        return {"success": False, "error": "Spleeter stem isolation failed and Demucs fallback was unavailable."}

    if engine in ("demucs", "auto"):
        result = separate_demucs(input_audio, output_dir, demucs_folder, segment, device)
        if result:
            return result
        sys.stderr.write("[Demucs] unavailable or failed, attempting Spleeter separation\n")
        spleeter_res = separate_spleeter(input_audio, output_dir, spleeter_folder)
        if spleeter_res:
            return spleeter_res
        return {"success": False, "error": "Demucs stem isolation failed and Spleeter fallback was unavailable."}

    # For any legacy or unspecified engine, try spleeter then demucs
    spleeter_res = separate_spleeter(input_audio, output_dir, spleeter_folder)
    if spleeter_res:
        return spleeter_res
    demucs_res = separate_demucs(input_audio, output_dir, demucs_folder, segment, device)
    if demucs_res:
        return demucs_res
    return {"success": False, "error": f"Stem separation failed for engine '{engine}'."}

def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        parser = argparse.ArgumentParser(description="Stem & Vocal Separator")
        parser.add_argument("--input", required=True, help="Input audio or video file")
        parser.add_argument("--output", required=True, help="Output directory")
        parser.add_argument("--engine", default="demucs", help="Separation engine (demucs or spleeter)")
        parser.add_argument("--demucs-folder", default=None, help="Optional portable Demucs install to use instead of the bundled one")
        parser.add_argument("--segment", default=None, help="Demucs chunk size (lower = less RAM)")
        parser.add_argument("--device", default=None, help="Demucs device override; omit to let demucs auto-detect")
        parser.add_argument("--spleeter-folder", default=None, help="Optional portable Spleeter install to use instead of the bundled one")

        args = parser.parse_args()
        result = separate(args.input, args.output, engine=args.engine, demucs_folder=args.demucs_folder, segment=args.segment, device=args.device, spleeter_folder=args.spleeter_folder)
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))

if __name__ == "__main__":
    main()

