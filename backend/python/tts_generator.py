#!/usr/bin/env python3
"""
High-Fidelity Neural TTS Generator
Supports Khmer (Piseth & Sreymom), English, Chinese, Thai, and 100+ voices via Edge-TTS.
"""

import sys
import os
import asyncio
import argparse
import json
import subprocess
import edge_tts

VOICE_PRESETS = {
    "km-KH-PisethNeural": {"name": "Khmer - Piseth (Male)", "gender": "Male", "lang": "km-KH"},
    "km-KH-SreymomNeural": {"name": "Khmer - Sreymom (Female)", "gender": "Female", "lang": "km-KH"},
    "en-US-GuyNeural": {"name": "English - Guy (Male)", "gender": "Male", "lang": "en-US"},
    "en-US-JennyNeural": {"name": "English - Jenny (Female)", "gender": "Female", "lang": "en-US"},
    "en-US-ChristopherNeural": {"name": "English - Christopher (Male Deep)", "gender": "Male", "lang": "en-US"},
    "en-US-AriaNeural": {"name": "English - Aria (Female Expressive)", "gender": "Female", "lang": "en-US"},
    "zh-CN-YunxiNeural": {"name": "Chinese - Yunxi (Male)", "gender": "Male", "lang": "zh-CN"},
    "zh-CN-XiaoxiaoNeural": {"name": "Chinese - Xiaoxiao (Female)", "gender": "Female", "lang": "zh-CN"},
    "th-TH-NiwatNeural": {"name": "Thai - Niwat (Male)", "gender": "Male", "lang": "th-TH"},
    "th-TH-PremwadeeNeural": {"name": "Thai - Premwadee (Female)", "gender": "Female", "lang": "th-TH"},
    "vi-VN-NamMinhNeural": {"name": "Vietnamese - Nam Minh (Male)", "gender": "Male", "lang": "vi-VN"},
    "vi-VN-HoaiMyNeural": {"name": "Vietnamese - Hoai My (Female)", "gender": "Female", "lang": "vi-VN"},
    "ja-JP-KeitaNeural": {"name": "Japanese - Keita (Male)", "gender": "Male", "lang": "ja-JP"},
    "ja-JP-NanamiNeural": {"name": "Japanese - Nanami (Female)", "gender": "Female", "lang": "ja-JP"},
    "ko-KR-InJoonNeural": {"name": "Korean - InJoon (Male)", "gender": "Male", "lang": "ko-KR"},
    "ko-KR-SunHiNeural": {"name": "Korean - SunHi (Female)", "gender": "Female", "lang": "ko-KR"}
}

def get_audio_duration(file_path):
    try:
        cmd = [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", file_path
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
        return float(res.stdout.strip())
    except Exception:
        return 0.0

async def generate_speech(text: str, voice: str, rate: str, pitch: str, volume: str, output_path: str):
    try:
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        
        rate_str = rate if rate.startswith(("+", "-")) else f"+{rate}"
        if not rate_str.endswith("%"):
            rate_str += "%"
            
        pitch_str = pitch if pitch.startswith(("+", "-")) else f"+{pitch}"
        if not pitch_str.endswith("Hz"):
            pitch_str += "Hz"
            
        vol_str = volume if volume.startswith(("+", "-")) else f"+{volume}"
        if not vol_str.endswith("%"):
            vol_str += "%"

        communicate = edge_tts.Communicate(
            text=text,
            voice=voice,
            rate=rate_str,
            pitch=pitch_str,
            volume=vol_str
        )
        
        await communicate.save(output_path)
        
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            duration = get_audio_duration(output_path)
            print(json.dumps({
                "success": True,
                "file": output_path,
                "size": os.path.getsize(output_path),
                "duration": duration
            }))
            return True
        else:
            print(json.dumps({"success": False, "error": "Generated audio file is empty"}))
            return False
            
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        return False

async def list_voices():
    try:
        voices = await edge_tts.list_voices()
        result = []
        for v in voices:
            result.append({
                "shortName": v["ShortName"],
                "friendlyName": v["FriendlyName"],
                "gender": v["Gender"],
                "locale": v["Locale"]
            })
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

def main():
    parser = argparse.ArgumentParser(description="Neural TTS Engine")
    parser.add_argument("--text", type=str, help="Text to speak")
    parser.add_argument("--voice", type=str, default="km-KH-PisethNeural", help="Voice ShortName")
    parser.add_argument("--rate", type=str, default="+0%", help="Speed / rate adjustment e.g. +15pct")
    parser.add_argument("--pitch", type=str, default="+0Hz", help="Pitch e.g. -5Hz")
    parser.add_argument("--volume", type=str, default="+0%", help="Volume adjustment e.g. +10pct")
    parser.add_argument("--output", type=str, help="Output MP3 file path")
    parser.add_argument("--list-voices", action="store_true", help="List all available voices")
    parser.add_argument("--presets", action="store_true", help="List preset voices")

    args = parser.parse_args()

    if args.presets:
        print(json.dumps(VOICE_PRESETS))
        return

    if args.list_voices:
        asyncio.run(list_voices())
        return

    if not args.text or not args.output:
        print(json.dumps({"success": False, "error": "Both --text and --output are required"}))
        sys.exit(1)

    asyncio.run(generate_speech(args.text, args.voice, args.rate, args.pitch, args.volume, args.output))

if __name__ == "__main__":
    main()
