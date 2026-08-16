#!/usr/bin/env python3
"""
Speech-to-Text & Subtitle Synchronizer
Parses and exports SRT, VTT, and interfaces with Whisper if available.
"""

import sys
import os
import re
import json
import argparse
import subprocess

def parse_srt(srt_content):
    blocks = srt_content.strip().split("\n\n")
    subtitles = []
    
    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) >= 3:
            idx = lines[0].strip()
            timing_match = re.match(r"(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})", lines[1])
            if timing_match:
                start_time = timing_match.group(1).replace(".", ",")
                end_time = timing_match.group(2).replace(".", ",")
                text = " ".join(lines[2:]).strip()
                
                # Calculate start and end in seconds
                def time_to_sec(t_str):
                    parts = t_str.replace(",", ".").split(":")
                    return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])

                start_sec = time_to_sec(start_time)
                end_sec = time_to_sec(end_time)
                
                subtitles.append({
                    "id": f"sub_{len(subtitles) + 1}",
                    "index": len(subtitles) + 1,
                    "startTime": start_time,
                    "endTime": end_time,
                    "startSec": start_sec,
                    "endSec": end_sec,
                    "duration": round(end_sec - start_sec, 3),
                    "originalText": text,
                    "dubbedText": text,
                    "voice": "km-KH-PisethNeural",
                    "rate": "+0%",
                    "pitch": "+0Hz",
                    "volume": "+0%",
                    "audioPath": None
                })
    return subtitles

def format_sec_to_srt_time(seconds):
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds - int(seconds)) * 1000)
    return f"{hrs:02d}:{mins:02d}:{secs:02d},{millis:03d}"

def export_srt(subtitles_list, output_path):
    with open(output_path, "w", encoding="utf-8") as f:
        for idx, sub in enumerate(subtitles_list, 1):
            text = sub.get("dubbedText") or sub.get("originalText") or ""
            start = sub.get("startTime") or format_sec_to_srt_time(sub.get("startSec", 0))
            end = sub.get("endTime") or format_sec_to_srt_time(sub.get("endSec", 0))
            f.write(f"{idx}\n{start} --> {end}\n{text}\n\n")

def main():
    parser = argparse.ArgumentParser(description="SRT and Subtitle Processing")
    parser.add_argument("--parse-srt", type=str, help="Path to SRT file to parse")
    parser.add_argument("--export-srt", type=str, help="Path to export SRT file")
    parser.add_argument("--data", type=str, help="JSON string of subtitles")

    args = parser.parse_args()

    if args.parse_srt:
        if os.path.exists(args.parse_srt):
            with open(args.parse_srt, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            subs = parse_srt(content)
            print(json.dumps({"success": True, "subtitles": subs}))
        else:
            print(json.dumps({"success": False, "error": "File not found"}))
            
    elif args.export_srt and args.data:
        subs = json.loads(args.data)
        export_srt(subs, args.export_srt)
        print(json.dumps({"success": True, "file": args.export_srt}))

if __name__ == "__main__":
    main()
