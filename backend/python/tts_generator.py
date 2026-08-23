#!/usr/bin/env python3
"""
High-Fidelity Neural TTS Generator with High-Speed Batching & Fast Duration Parsing
Supports Khmer (Piseth & Sreymom), English, Chinese, Thai, and 100+ voices via Edge-TTS.
"""

import sys
import os
import struct
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

# Bitrate lookup tables for MPEG Version 1, Layer III (MP3)
MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
SAMPLERATES = {
    1: [44100, 48000, 32000],      # MPEG-1
    2: [22050, 24000, 16000],      # MPEG-2
    2.5: [11025, 12000, 8000]      # MPEG-2.5
}

def parse_mp3_duration_fast(file_path):
    """
    Blazing-fast in-process MP3 duration parser (<0.1ms).
    Parses ID3v2, Xing/Info header, or CBR frame headers directly from byte stream.
    """
    try:
        with open(file_path, 'rb') as f:
            data = f.read(16384) # Read first 16KB which covers ID3 and header frame
            file_size = os.path.getsize(file_path)

        if len(data) < 10:
            return None

        offset = 0
        # Check for ID3v2 tag
        if data[:3] == b'ID3':
            id3_size = ((data[6] & 0x7F) << 21) | ((data[7] & 0x7F) << 14) | ((data[8] & 0x7F) << 7) | (data[9] & 0x7F)
            offset = 10 + id3_size
            if offset >= len(data):
                # ID3 is larger than initial read; read further
                with open(file_path, 'rb') as f:
                    f.seek(offset)
                    data = f.read(8192)
                    offset = 0

        # Scan for MP3 sync word (11 bits set: 0xFF followed by 0xE0 or higher)
        header_idx = -1
        for i in range(offset, len(data) - 4):
            if data[i] == 0xFF and (data[i + 1] & 0xE0) == 0xE0:
                # Verify valid MPEG Layer III
                version_bits = (data[i + 1] >> 3) & 0x03
                layer_bits = (data[i + 1] >> 1) & 0x03
                if layer_bits == 1: # Layer III
                    header_idx = i
                    break

        if header_idx == -1:
            return None

        b1, b2, b3, b4 = data[header_idx], data[header_idx + 1], data[header_idx + 2], data[header_idx + 3]
        version_id = (b2 >> 3) & 0x03
        version = 1 if version_id == 3 else (2 if version_id == 2 else 2.5)
        layer = 4 - ((b2 >> 1) & 0x03)
        bitrate_idx = (b3 >> 4) & 0x0F
        sr_idx = (b3 >> 2) & 0x03
        padding = (b3 >> 1) & 0x01
        channel_mode = (b4 >> 6) & 0x03

        if sr_idx >= 3 or bitrate_idx == 0 or bitrate_idx == 15:
            return None

        sample_rate = SAMPLERATES[version][sr_idx]
        bitrate = (MPEG1_L3_BITRATES if version == 1 else MPEG2_L3_BITRATES)[bitrate_idx] * 1000

        # Look for Xing / Info header (VBR)
        # Side info size: 32 bytes (stereo MPEG-1), 17 bytes (mono MPEG-1), 17 bytes (stereo MPEG-2), 9 bytes (mono MPEG-2)
        if version == 1:
            side_info_len = 32 if channel_mode != 3 else 17
        else:
            side_info_len = 17 if channel_mode != 3 else 9

        xing_offset = header_idx + 4 + side_info_len
        if xing_offset + 12 <= len(data):
            tag = data[xing_offset:xing_offset + 4]
            if tag in (b'Xing', b'Info'):
                flags = struct.unpack('>I', data[xing_offset + 4:xing_offset + 8])[0]
                if flags & 0x0001: # Frames field is present
                    frames = struct.unpack('>I', data[xing_offset + 8:xing_offset + 12])[0]
                    samples_per_frame = 1152 if version == 1 else 576
                    duration = (frames * samples_per_frame) / float(sample_rate)
                    return round(duration, 3)

        # Fallback for CBR: estimate duration from file size and bitrate
        audio_bytes = max(0, file_size - offset)
        if bitrate > 0:
            duration = (audio_bytes * 8.0) / bitrate
            return round(duration, 3)

    except Exception:
        pass
    return None

def get_audio_duration(file_path):
    """Get accurate audio duration with fast in-process parser, falling back to ffprobe."""
    fast_dur = parse_mp3_duration_fast(file_path)
    if fast_dur is not None and fast_dur > 0:
        return fast_dur

    try:
        cmd = [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", file_path
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
        return round(float(res.stdout.strip()), 3)
    except Exception:
        return 0.0

def sanitize_prosody(rate: str, pitch: str, volume: str):
    rate_str = rate if rate.startswith(("+", "-")) else f"+{rate}"
    if not rate_str.endswith("%"):
        rate_str += "%"
        
    pitch_str = pitch if pitch.startswith(("+", "-")) else f"+{pitch}"
    if not pitch_str.endswith("Hz"):
        pitch_str += "Hz"
        
    vol_str = volume if volume.startswith(("+", "-")) else f"+{volume}"
    if not vol_str.endswith("%"):
        vol_str += "%"

    return rate_str, pitch_str, vol_str

async def generate_single_item(text: str, voice: str, rate: str, pitch: str, volume: str, output_path: str, sem: asyncio.Semaphore = None):
    """Generate a single speech audio file using Edge-TTS with concurrency limiting."""
    if sem:
        async with sem:
            return await _generate_speech_core(text, voice, rate, pitch, volume, output_path)
    else:
        return await _generate_speech_core(text, voice, rate, pitch, volume, output_path)

TTS_TIMEOUT_SECONDS = 30

async def _generate_speech_core(text: str, voice: str, rate: str, pitch: str, volume: str, output_path: str):
    try:
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        rate_str, pitch_str, vol_str = sanitize_prosody(rate, pitch, volume)

        # Clean up zero-width and invisible control characters
        clean_text = text.replace('\u200b', '').replace('\u200c', '').replace('\u200d', '').replace('\ufeff', '').strip()
        if not clean_text:
            return {"success": False, "error": "Empty text after sanitization"}

        communicate = edge_tts.Communicate(
            text=clean_text,
            voice=voice,
            rate=rate_str,
            pitch=pitch_str,
            volume=vol_str
        )

        # Without a timeout, a network stall or throttling from Microsoft's
        # endpoint hangs this coroutine forever; the Node caller's
        # child.on('close') would never fire and the HTTP request (or, in a
        # batch, every other item queued behind it) would hang indefinitely.
        try:
            await asyncio.wait_for(communicate.save(output_path), timeout=TTS_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            return {"success": False, "error": f"TTS request timed out after {TTS_TIMEOUT_SECONDS}s"}

        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            duration = get_audio_duration(output_path)
            return {
                "success": True,
                "file": output_path,
                "size": os.path.getsize(output_path),
                "duration": duration
            }
        else:
            return {"success": False, "error": "Generated audio file is empty"}

    except Exception as e:
        return {"success": False, "error": str(e)}

async def generate_speech(text: str, voice: str, rate: str, pitch: str, volume: str, output_path: str):
    result = await generate_single_item(text, voice, rate, pitch, volume, output_path)
    print(json.dumps(result))
    return result.get("success", False)

async def generate_batch(batch_items, max_concurrency=6):
    """
    Process a list of TTS tasks in parallel with an async semaphore.
    Drastically faster than launching separate Python processes.
    """
    sem = asyncio.Semaphore(max_concurrency)
    tasks = []

    async def worker(item):
        item_id = item.get("id") or item.get("index")
        text = item.get("text", "")
        voice = item.get("voice", "km-KH-PisethNeural")
        rate = item.get("rate", "+0%")
        pitch = item.get("pitch", "+0Hz")
        volume = item.get("volume", "+0%")
        output_path = item.get("output") or item.get("output_path")

        if not text or not output_path:
            return {
                "id": item_id,
                "success": False,
                "error": "Missing text or output path"
            }

        res = await generate_single_item(text, voice, rate, pitch, volume, output_path, sem)
        res["id"] = item_id
        return res

    item_ids = [item.get("id") or item.get("index") for item in batch_items]
    for item in batch_items:
        tasks.append(worker(item))

    # return_exceptions=True: previously one worker raising unhandled turned
    # the whole batch into a single failure via asyncio.gather, discarding
    # every other subtitle line's already-completed (or independently
    # failing) result instead of returning partial success per item.
    raw_results = await asyncio.gather(*tasks, return_exceptions=True)
    results = []
    for item_id, r in zip(item_ids, raw_results):
        if isinstance(r, Exception):
            results.append({"id": item_id, "success": False, "error": str(r)})
        else:
            results.append(r)

    print(json.dumps({
        "success": True,
        "count": len(results),
        "results": results
    }))

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
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="High-Speed Neural TTS Engine")
    parser.add_argument("--text", type=str, help="Text to speak")
    parser.add_argument("--voice", type=str, default="km-KH-PisethNeural", help="Voice ShortName")
    parser.add_argument("--rate", type=str, default="+0%", help="Speed / rate adjustment e.g. +15pct")
    parser.add_argument("--pitch", type=str, default="+0Hz", help="Pitch e.g. -5Hz")
    parser.add_argument("--volume", type=str, default="+0%", help="Volume adjustment e.g. +10pct")
    parser.add_argument("--output", type=str, help="Output MP3 file path")
    parser.add_argument("--batch", type=str, help="Path to JSON batch file or JSON string")
    parser.add_argument("--concurrency", type=int, default=6, help="Max concurrent TTS streams")
    parser.add_argument("--list-voices", action="store_true", help="List all available voices")
    parser.add_argument("--presets", action="store_true", help="List preset voices")

    args = parser.parse_args()

    if args.presets:
        print(json.dumps(VOICE_PRESETS))
        return

    if args.list_voices:
        asyncio.run(list_voices())
        return

    if args.batch:
        try:
            if os.path.exists(args.batch):
                with open(args.batch, "r", encoding="utf-8") as f:
                    batch_data = json.load(f)
            else:
                batch_data = json.loads(args.batch)
            asyncio.run(generate_batch(batch_data, max_concurrency=args.concurrency))
            return
        except Exception as e:
            print(json.dumps({"success": False, "error": f"Batch parse error: {e}"}))
            sys.exit(1)

    if not args.text or not args.output:
        print(json.dumps({"success": False, "error": "Both --text and --output are required"}))
        sys.exit(1)

    asyncio.run(generate_speech(args.text, args.voice, args.rate, args.pitch, args.volume, args.output))

if __name__ == "__main__":
    main()
