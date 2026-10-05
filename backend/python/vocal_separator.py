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
import re
import time

def ensure_ffmpeg_in_path():
    if os.name != "nt":
        return
    extra_paths = []
    py_dir = os.path.dirname(os.path.abspath(__file__))
    bundled_bin = os.path.abspath(os.path.join(py_dir, "..", "bin"))
    if "app.asar" in bundled_bin.lower() and "app.asar.unpacked" not in bundled_bin.lower():
        bundled_bin = bundled_bin.replace("app.asar", "app.asar.unpacked")
    if os.path.isdir(bundled_bin):
        extra_paths.append(bundled_bin)

    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        extra_paths.append(os.path.join(local_app_data, "Programs", "DR Dubber Pro", "resources", "app.asar.unpacked", "backend", "bin"))
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
    # Folders above are the app's own and go first on PATH. The guesses below
    # include drive-root folders any Windows user can create (C:\\ffmpeg), so
    # they go last and can never shadow python or a system tool.
    bundled_count = len(extra_paths)
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
    def usable(p):
        return (os.path.isdir(p)
                and ("app.asar" not in p.lower() or "app.asar.unpacked" in p.lower())
                and os.path.abspath(p).lower() not in current_set)
    prepend = [p for p in extra_paths[:bundled_count] if usable(p)]
    append = [p for p in extra_paths[bundled_count:] if usable(p)]
    if prepend or append:
        os.environ["PATH"] = os.pathsep.join(prepend + ([current_path] if current_path else []) + append)

ensure_ffmpeg_in_path()

# Demucs runs in its own venv (backend/demucs-env) rather than the main
# backend env because it pulls in a specific torch/torchaudio pin that would
# otherwise fight with the rest of the app's Python dependencies. A user can
# instead point --demucs-folder at their own portable Demucs install (the
# "Demucs Folder Path" setting in the UI); that folder's own python is used
# in preference to the bundled venv when present.
def is_working_python(py_path):
    if not py_path or not os.path.isfile(py_path):
        return False
    try:
        res = subprocess.run(
            [py_path, "-c", "import sys; sys.exit(0)"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3
        )
        return res.returncode == 0
    except Exception:
        return False

def is_working_module_python(py_path, module_name):
    if not py_path or not os.path.isfile(py_path):
        return False
    try:
        res = subprocess.run(
            [py_path, "-c", f"import sys, {module_name}; sys.exit(0)"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5
        )
        return res.returncode == 0
    except Exception:
        return False

def is_spleeter_python(py_path):
    return is_working_module_python(py_path, "spleeter")

def is_demucs_python(py_path):
    return is_working_module_python(py_path, "demucs")

def get_ffmpeg_executable():
    import shutil
    bin_path = shutil.which("ffmpeg")
    if bin_path and os.path.isfile(bin_path):
        return bin_path
    py_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(py_dir, "..", "bin", "ffmpeg.exe" if os.name == "nt" else "ffmpeg"),
        os.path.join(py_dir, "..", "..", "backend", "bin", "ffmpeg.exe" if os.name == "nt" else "ffmpeg"),
    ]
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        candidates.append(os.path.join(local_app_data, "Programs", "DR Dubber Pro", "resources", "app.asar.unpacked", "backend", "bin", "ffmpeg.exe"))
        candidates.append(os.path.join(local_app_data, "Microsoft", "WinGet", "Links", "ffmpeg.exe"))
    for c in candidates:
        if os.path.isfile(c):
            return os.path.abspath(c)
    return "ffmpeg"

def get_media_duration(file_path):
    try:
        ffmpeg_bin = get_ffmpeg_executable()
        ffprobe_bin = "ffprobe"
        if ffmpeg_bin and "ffmpeg.exe" in ffmpeg_bin.lower():
            probe_cand = ffmpeg_bin.lower().replace("ffmpeg.exe", "ffprobe.exe")
            if os.path.isfile(probe_cand):
                ffprobe_bin = probe_cand
        res = subprocess.run(
            [ffprobe_bin, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5
        )
        if res.returncode == 0 and res.stdout.strip():
            return float(res.stdout.strip())
    except Exception:
        pass
    return None

def get_demucs_python_default():
    py_dir = os.path.dirname(os.path.abspath(__file__))
    if "app.asar" in py_dir and "app.asar.unpacked" not in py_dir:
        py_dir = py_dir.replace("app.asar", "app.asar.unpacked")
    candidates = [
        os.path.join(py_dir, "..", "demucs-env", "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python"),
        os.path.join(py_dir, "..", "..", "backend", "demucs-env", "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python"),
    ]
    if os.name == "nt":
        prog_files = os.environ.get("ProgramFiles", "C:\\Program Files")
        for ver in ["Python310", "Python311", "Python39", "Python312"]:
            candidates.append(os.path.join(prog_files, ver, "python.exe"))
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        if local_app_data:
            for ver in ["Python310", "Python311", "Python39", "Python312"]:
                candidates.append(os.path.join(local_app_data, "Programs", "Python", ver, "python.exe"))
    for c in candidates:
        if is_demucs_python(c):
            return os.path.abspath(c)
    if is_demucs_python(sys.executable):
        return os.path.abspath(sys.executable)
    return None

DEMUCS_PYTHON_DEFAULT = get_demucs_python_default()
DEMUCS_MODEL = os.environ.get("DEMUCS_MODEL") or "htdemucs"

# Why each engine failed, in plain words. The server shows these to the user
# (e.g. "Tab 3: Demucs could not run (...)") instead of quietly handing back a
# phase-cancel result with almost no music in it.
ENGINE_ERRORS = {}

def error_tail(text, limit=300):
    """Last meaningful lines of a tool's stderr (progress bars dropped)."""
    if not text:
        return ""
    lines = [l.strip() for l in re.split(r"[\r\n]+", text) if l.strip()]
    lines = [l for l in lines if "%|" not in l and not l.lower().startswith("warning")]
    tail = " | ".join(lines[-2:])
    if len(tail) > limit and lines:
        tail = lines[-1]  # the last line usually holds the actual error
    return tail if len(tail) <= limit else "..." + tail[-limit:]

def note_error(engine, message):
    ENGINE_ERRORS[engine] = message or "unknown error"
    sys.stderr.write(f"[{engine}] {ENGINE_ERRORS[engine]}\n")

def get_spleeter_python_default():
    py_dir = os.path.dirname(os.path.abspath(__file__))
    if "app.asar" in py_dir and "app.asar.unpacked" not in py_dir:
        py_dir = py_dir.replace("app.asar", "app.asar.unpacked")
    candidates = [
        # Dedicated Spleeter virtual environments first
        os.path.join(py_dir, "..", "spleeter-env", "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python"),
        os.path.join(py_dir, "..", "..", "backend", "spleeter-env", "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python"),
        os.path.join(py_dir, "..", "..", "spleeter-env", "Scripts" if os.name == "nt" else "bin", "python.exe" if os.name == "nt" else "python"),
    ]
    if os.name == "nt":
        prog_files = os.environ.get("ProgramFiles", "C:\\Program Files")
        prog_files_x86 = os.environ.get("ProgramFiles(x86)", "C:\\Program Files (x86)")
        for pf in [prog_files, prog_files_x86]:
            for ver in ["Python310", "Python39", "Python311", "Python38", "Python312"]:
                candidates.append(os.path.join(pf, ver, "python.exe"))
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        if local_app_data:
            for ver in ["Python310", "Python39", "Python311", "Python38", "Python312"]:
                candidates.append(os.path.join(local_app_data, "Programs", "Python", ver, "python.exe"))
            candidates.append(os.path.join(
                local_app_data, "Programs", "DR Dubber Pro", "resources", "app.asar.unpacked", "backend", "spleeter-env",
                "Scripts", "python.exe"
            ))
            candidates.append(os.path.join(
                local_app_data, "Programs", "DR Dubber Pro", "resources", "app.asar.unpacked", "backend", "python_env",
                "python.exe"
            ))

    # General python_env candidates last
    candidates.extend([
        os.path.join(py_dir, "..", "python_env", "python.exe" if os.name == "nt" else "python"),
        os.path.join(py_dir, "..", "..", "backend", "python_env", "python.exe" if os.name == "nt" else "python"),
    ])

    for c in candidates:
        if is_spleeter_python(c):
            return os.path.abspath(c)

    if is_spleeter_python(sys.executable):
        return os.path.abspath(sys.executable)

    for cmd in (["py", "-3.10"], ["py", "-3"], ["python"], ["python3"]):
        try:
            res = subprocess.run(
                cmd + ["-c", "import sys, spleeter; print(sys.executable)"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=5
            )
            if res.returncode == 0 and res.stdout.strip():
                py_found = res.stdout.strip().splitlines()[-1]
                if is_spleeter_python(py_found):
                    return os.path.abspath(py_found)
        except Exception:
            pass

    return None

SPLEETER_PYTHON_DEFAULT = get_spleeter_python_default()

def find_python_in_folder(folder, module_name=None):
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
        if module_name:
            if is_working_module_python(c, module_name):
                return c
        elif is_working_python(c):
            return c
    return None

def separate_demucs(input_audio, output_dir, demucs_folder=None, segment=None, device=None, threads=None):
    """
    High-fidelity ML-based separation via Demucs (htdemucs model). Produces a
    genuine isolated vocal stem and a clean instrumental/BGM stem.
    """
    demucs_python = (
        find_python_in_folder(demucs_folder, "demucs")
        or (os.environ.get("DEMUCS_PYTHON") if is_demucs_python(os.environ.get("DEMUCS_PYTHON")) else None)
        or (DEMUCS_PYTHON_DEFAULT if is_working_python(DEMUCS_PYTHON_DEFAULT) else None)
        or (sys.executable if is_demucs_python(sys.executable) else None)
    )
    if not demucs_python:
        note_error("Demucs", "no Python with Demucs installed was found (backend/demucs-env is missing or broken)")
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

        # torch otherwise starts one thread per core in every process, so two
        # tabs separating at once would each grab all 16 and slow each other
        # down. The server passes this process's share of the CPU.
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        if threads:
            for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
                env[var] = str(threads)

        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env=env)

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
        note_error("Demucs", error_tail(res.stderr) or f"exit code {res.returncode}, no stems written")
        return None
    except Exception as e:
        note_error("Demucs", str(e))
        return None

def separate_spleeter(input_audio, output_dir, spleeter_folder=None, spleeter_python_override=None):
    """
    ML-based separation via Spleeter's 2stems (vocals/accompaniment) model.
    """
    spleeter_python = (
        (spleeter_python_override if is_spleeter_python(spleeter_python_override) else None)
        or find_python_in_folder(spleeter_folder, "spleeter")
        or (os.environ.get("SPLEETER_PYTHON") if is_spleeter_python(os.environ.get("SPLEETER_PYTHON")) else None)
        or get_spleeter_python_default()
        or (sys.executable if is_spleeter_python(sys.executable) else None)
    )
    if not spleeter_python:
        note_error("Spleeter", "no Python with Spleeter installed was found (backend/spleeter-env is missing or broken)")
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
        ]
        media_dur = get_media_duration(input_audio)
        if media_dur and media_dur > 600.0:
            cmd.extend(["-d", str(int(media_dur) + 10)])
        cmd.append(input_audio)

        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        env["TF_CPP_MIN_LOG_LEVEL"] = "2"

        py_dir = os.path.dirname(os.path.abspath(__file__))
        if "app.asar" in py_dir and "app.asar.unpacked" not in py_dir:
            py_dir = py_dir.replace("app.asar", "app.asar.unpacked")
        candidates_model = [
            os.path.abspath(os.path.join(py_dir, "..", "pretrained_models")),
            os.path.abspath(os.path.join(py_dir, "..", "..", "pretrained_models")),
            os.path.abspath(os.path.join(py_dir, "pretrained_models")),
        ]
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        if local_app_data:
            candidates_model.append(
                os.path.join(local_app_data, "Programs", "DR Dubber Pro", "resources", "app.asar.unpacked", "backend", "pretrained_models")
            )
        for cand in candidates_model:
            if os.path.isdir(os.path.join(cand, "2stems")):
                env["MODEL_PATH"] = cand
                break

        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env=env)

        base_name = os.path.splitext(os.path.basename(input_audio))[0]
        stem_dir = os.path.join(job_dir, base_name)
        vocal_path = os.path.join(stem_dir, "vocals.wav")
        bgm_path = os.path.join(stem_dir, "accompaniment.wav")

        if not (os.path.exists(bgm_path) and os.path.exists(vocal_path)):
            for root, dirs, files in os.walk(job_dir):
                if "accompaniment.wav" in files and "vocals.wav" in files:
                    vocal_path = os.path.join(root, "vocals.wav")
                    bgm_path = os.path.join(root, "accompaniment.wav")
                    break

        if os.path.exists(bgm_path) and os.path.exists(vocal_path):
            return {
                "success": True,
                "method": "spleeter",
                "vocal": os.path.abspath(vocal_path),
                "bgm": os.path.abspath(bgm_path)
            }
        note_error("Spleeter", error_tail(res.stderr) or f"exit code {res.returncode}, no stems written")
        return None
    except Exception as e:
        note_error("Spleeter", str(e))
        return None

def separate_ffmpeg(input_audio, output_dir):
    """
    Zero-dependency stem separation using FFmpeg stereo phase cancellation.
    Extracts out-of-phase audio as background music (accompaniment/BGM) and
    center/in-phase audio as vocal stem.
    """
    try:
        output_dir = os.path.abspath(output_dir)
        job_suffix = f"{os.getpid()}_{int(time.time() * 1000)}"
        job_dir = os.path.join(output_dir, f"ffmpeg_{job_suffix}")
        os.makedirs(job_dir, exist_ok=True)

        vocal_path = os.path.join(job_dir, "vocals.wav")
        bgm_path = os.path.join(job_dir, "accompaniment.wav")

        filter_graph = (
            "[0:a]aformat=channel_layouts=stereo,asplit=2[a_bgm_in][a_voc_in];"
            "[a_bgm_in]stereotools=mode=lr>l-r,volume=2.5[bgm];"
            "[a_voc_in]stereotools=mode=lr>l+r,highpass=f=200,lowpass=f=3500,volume=1.5[vocal]"
        )

        ffmpeg_bin = get_ffmpeg_executable()
        cmd = [
            ffmpeg_bin, "-y", "-i", input_audio,
            "-filter_complex", filter_graph,
            "-map", "[bgm]", bgm_path,
            "-map", "[vocal]", vocal_path
        ]

        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")

        if os.path.exists(bgm_path) and os.path.exists(vocal_path):
            return {
                "success": True,
                "method": "ffmpeg",
                "vocal": os.path.abspath(vocal_path),
                "bgm": os.path.abspath(bgm_path)
            }
        if res.returncode != 0:
            sys.stderr.write(f"[FFmpeg] exit code {res.returncode}: {res.stderr}\n")
        return None
    except Exception as e:
        sys.stderr.write(f"[FFmpeg] exception: {e}\n")
        return None

def ml_failure(engines):
    reasons = "; ".join(f"{name} could not run ({ENGINE_ERRORS.get(name, 'unknown error')})" for name in engines)
    return {"success": False, "error": reasons}

def separate(input_audio, output_dir, engine="spleeter", demucs_folder=None, segment=None, device=None, spleeter_folder=None, spleeter_python=None, threads=None):
    """
    Runs the chosen engine and, if it fails, the other ML engine. There is no
    phase-cancel fallback in here any more: when both ML engines fail the error
    says why, and the server decides what to do (and tells the user).
    """
    if engine == "ffmpeg":
        res = separate_ffmpeg(input_audio, output_dir)
        if res:
            return res
        return {"success": False, "error": "FFmpeg audio separation failed."}

    run_demucs = lambda: separate_demucs(input_audio, output_dir, demucs_folder, segment, device, threads)
    run_spleeter = lambda: separate_spleeter(input_audio, output_dir, spleeter_folder=spleeter_folder, spleeter_python_override=spleeter_python)
    if engine in ("demucs", "auto"):
        order = [("Demucs", run_demucs), ("Spleeter", run_spleeter)]
    else:  # "spleeter" or anything unknown: the fast default first
        order = [("Spleeter", run_spleeter), ("Demucs", run_demucs)]

    first_name = order[0][0]
    for name, run in order:
        result = run()
        if result:
            if name != first_name:
                # Still real ML stems, but not the engine the user picked - say so.
                result["fallbackReason"] = f"{first_name} could not run ({ENGINE_ERRORS.get(first_name, 'unknown error')}); used {name} instead"
            return result
    return ml_failure([name for name, _ in order])

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
        parser.add_argument("--engine", default="spleeter", help="Separation engine (spleeter, demucs, or ffmpeg)")
        parser.add_argument("--demucs-folder", default=None, help="Optional portable Demucs install to use instead of the bundled one")
        parser.add_argument("--segment", default=None, help="Demucs chunk size (lower = less RAM)")
        parser.add_argument("--device", default=None, help="Demucs device override; omit to let demucs auto-detect")
        parser.add_argument("--spleeter-folder", default=None, help="Optional portable Spleeter install to use instead of the bundled one")
        parser.add_argument("--spleeter-python", default=None, help="Optional direct path to Spleeter Python binary")
        parser.add_argument("--threads", default=None, type=int, help="CPU threads Demucs may use (its share when several tabs separate at once)")

        args = parser.parse_args()
        result = separate(
            args.input,
            args.output,
            engine=args.engine,
            demucs_folder=args.demucs_folder,
            segment=args.segment,
            device=args.device,
            spleeter_folder=args.spleeter_folder,
            spleeter_python=args.spleeter_python,
            threads=args.threads
        )
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))

if __name__ == "__main__":
    main()

