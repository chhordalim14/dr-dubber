#!/usr/bin/env python3
"""
Audio Vocal & Background Music (BGM) Separator
Leverages Spleeter 2-stem model or FFmpeg high-order separation.
"""

import sys
import os
import subprocess
import argparse
import json

SPLEETER_PYTHON = r"C:\Software\DAI-Dubber-PRO\spleeter-env\Scripts\python.exe"
PRETRAINED_MODELS = r"C:\Software\DAI-Dubber-PRO\pretrained_models"

def separate_spleeter(input_audio, output_dir):
    try:
        output_dir = os.path.abspath(output_dir)
        os.makedirs(output_dir, exist_ok=True)
        if os.path.exists(SPLEETER_PYTHON):
            cmd = [
                SPLEETER_PYTHON, "-m", "spleeter", "separate",
                "-p", "spleeter:2stems",
                "-o", output_dir,
                "-d", "600",
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

        # Fallback to FFmpeg center-channel vocal isolation / cancellation
        return separate_ffmpeg(input_audio, output_dir)
    except Exception as e:
        return separate_ffmpeg(input_audio, output_dir)

def separate_ffmpeg(input_audio, output_dir):
    try:
        output_dir = os.path.abspath(output_dir)
        os.makedirs(output_dir, exist_ok=True)
        base_name = os.path.splitext(os.path.basename(input_audio))[0]
        bgm_path = os.path.join(output_dir, f"{base_name}_bgm.wav")
        vocal_path = os.path.join(output_dir, f"{base_name}_vocals.wav")
        
        cmd_bgm = [
            "ffmpeg", "-y", "-i", input_audio,
            "-af", "stereotools=mutec=1",
            "-vn", bgm_path
        ]
        subprocess.run(cmd_bgm, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        
        cmd_vocal = [
            "ffmpeg", "-y", "-i", input_audio,
            "-af", "stereotools=mutel=1:muter=1,highpass=f=200,lowpass=f=3500",
            "-vn", vocal_path
        ]
        subprocess.run(cmd_vocal, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        
        return {
            "success": True,
            "method": "ffmpeg_filter",
            "vocal": os.path.abspath(vocal_path),
            "bgm": os.path.abspath(bgm_path)
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    parser = argparse.ArgumentParser(description="Stem & Vocal Separator")
    parser.add_argument("--input", required=True, help="Input audio or video file")
    parser.add_argument("--output", required=True, help="Output directory")

    args = parser.parse_args()
    result = separate_spleeter(args.input, args.output)
    print(json.dumps(result))

if __name__ == "__main__":
    main()
