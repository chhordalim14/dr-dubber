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
import re
import shutil
import subprocess
from array import array
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

# ── Silence trimming ──
# Edge pads every clip with ~0.25s of silence before the voice and ~0.8s after it
# (measured on km-KH Piseth and Sreymom). The app treats the whole file as the voice,
# so the voice started ~0.25s after its subtitle, and the extra ~1s made short lines
# look "rushed": they got sped up, or sent to Gemini to be shortened, when they already
# fit. Edge can also leave a pause of a second or more at a mid-line '?' or '។'.
TRIM_THRESHOLD_DB = -45.0   # quieter than this is silence (Edge's pads are digital silence)
TRIM_MIN_SILENCE = 0.05     # quiet stretches shorter than this are part of a word (stops, breaths)
TRIM_KEEP_LEAD = 0.04       # kept before the first sound so consonant onsets aren't clipped
TRIM_KEEP_TAIL = 0.08       # kept after the last sound so word releases fade out naturally
TRIM_LONG_PAUSE = 0.5       # interior pauses longer than this...
TRIM_PAUSE_KEEP = 0.3       # ...are shortened to this
TRIM_MIN_SPEECH = 0.15      # below this the "speech" is probably a click: keep the clip as Edge made it
TRIM_MIN_SAVING = 0.02      # not worth a re-encode (a second MP3 generation) for less than this
TRIM_WINDOW = 0.005         # analysis resolution
# Edge sends 48k mono 24 kHz. Trimming decodes and re-encodes it (a second MP3 generation), and
# the clip is mixed and encoded once more on export, so 64k keeps that extra pass from adding
# audible artefacts. It costs ~120 kB more per minute of voice, and the trimmed clips are shorter anyway.
TRIM_BITRATE = "64k"

def log_stderr(message):
    # stdout carries the JSON result the server parses, so diagnostics go to stderr.
    try:
        print(message, file=sys.stderr, flush=True)
    except Exception:
        pass

def find_ffmpeg():
    """The app's FFmpeg: the path the server passes, then backend/bin next to this script, then PATH."""
    env_path = os.environ.get("DR_FFMPEG_PATH", "")
    if env_path and os.path.isfile(env_path):
        return env_path
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    bundled = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin", exe)
    if os.path.isfile(bundled):
        return os.path.abspath(bundled)
    return shutil.which("ffmpeg")

def _run_quiet(cmd, **kwargs):
    # CREATE_NO_WINDOW: no console window flashing up for every voice line on Windows.
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), **kwargs)

def find_speech_spans(samples, sample_rate):
    """[(start, end)] sample ranges that are louder than the threshold, joined across gaps shorter than TRIM_MIN_SILENCE."""
    threshold = max(1, int(round(32768 * (10 ** (TRIM_THRESHOLD_DB / 20.0)))))
    win = max(1, int(sample_rate * TRIM_WINDOW))
    min_gap = int(sample_rate * TRIM_MIN_SILENCE)
    spans = []
    span_start = None
    span_end = None
    for i in range(0, len(samples), win):
        chunk = samples[i:i + win]
        if max(chunk) < threshold and -min(chunk) < threshold:
            continue
        # Sample-exact edges inside the loud window, so the kept padding is what we asked for.
        loud = [j for j, s in enumerate(chunk) if s >= threshold or -s >= threshold]
        first, last = i + loud[0], i + loud[-1] + 1
        if span_start is None:
            span_start, span_end = first, last
        elif first - span_end >= min_gap:
            spans.append((span_start, span_end))
            span_start, span_end = first, last
        else:
            span_end = last
    if span_start is not None:
        spans.append((span_start, span_end))
    return spans

def plan_keep_ranges(spans, total, sample_rate):
    """Sample ranges to keep: the speech plus short lead/tail pads, with long interior pauses shortened."""
    lead = int(sample_rate * TRIM_KEEP_LEAD)
    tail = int(sample_rate * TRIM_KEEP_TAIL)
    long_pause = int(sample_rate * TRIM_LONG_PAUSE)
    # Keep half of the shortened pause on each side, so the cut lands in the middle of the silence.
    half_pause = int(sample_rate * TRIM_PAUSE_KEEP / 2)
    ranges = []
    cur_start = max(0, spans[0][0] - lead)
    cur_end = spans[0][1]
    for start, end in spans[1:]:
        if start - cur_end > long_pause:
            ranges.append((cur_start, cur_end + half_pause))
            cur_start = start - half_pause
        cur_end = end
    ranges.append((cur_start, min(total, cur_end + tail)))
    return ranges

def trim_silence(path, ffmpeg=None):
    """
    Trim the silence Edge puts around a clip and shorten long interior pauses, in place.
    Never loses a voice: on any failure, or when there's too little speech to trust, the
    original file stays untouched. Returns {"trimmed": bool, "duration": seconds or None,
    "original_duration": seconds or None, "reason": str}; duration is None when the file
    wasn't changed (measure it the usual way).
    """
    result = {"trimmed": False, "duration": None, "original_duration": None, "reason": ""}
    tmp_path = path + ".trim.tmp"
    try:
        ffmpeg = ffmpeg or find_ffmpeg()
        if not ffmpeg:
            result["reason"] = "ffmpeg not found"
            log_stderr(f"[TTS trim] kept original (ffmpeg not found): {path}")
            return result

        # Decode to 16-bit mono PCM at the clip's own sample rate; the rate comes from the stream header.
        dec = _run_quiet([ffmpeg, "-hide_banner", "-nostdin", "-i", path, "-vn", "-ac", "1", "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"])
        header = dec.stderr.decode("utf-8", "replace")
        rate_match = re.search(r"Audio:.*?(\d+) Hz", header)
        if dec.returncode != 0 or not dec.stdout or not rate_match:
            raise RuntimeError(f"decode failed (exit {dec.returncode})")
        sample_rate = int(rate_match.group(1))
        samples = array("h")
        pcm = dec.stdout[:len(dec.stdout) - (len(dec.stdout) % 2)]
        samples.frombytes(pcm)
        if sys.byteorder == "big":
            samples.byteswap()
        total = len(samples)
        result["original_duration"] = round(total / float(sample_rate), 3)

        spans = find_speech_spans(samples, sample_rate)
        if not spans or (spans[-1][1] - spans[0][0]) < TRIM_MIN_SPEECH * sample_rate:
            result["reason"] = "too little speech detected"
            log_stderr(f"[TTS trim] kept original (too little speech detected): {path}")
            return result

        ranges = plan_keep_ranges(spans, total, sample_rate)
        kept = sum(end - start for start, end in ranges)
        if total - kept < TRIM_MIN_SAVING * sample_rate:
            result["reason"] = "nothing to trim"
            return result

        trimmed_pcm = b"".join(samples[start:end].tobytes() if sys.byteorder == "little" else _swapped(samples[start:end]) for start, end in ranges)
        enc = _run_quiet([ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                          "-f", "s16le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
                          "-c:a", "libmp3lame", "-b:a", TRIM_BITRATE, "-ar", str(sample_rate), "-ac", "1",
                          "-f", "mp3", tmp_path], input=trimmed_pcm)
        if enc.returncode != 0 or not os.path.isfile(tmp_path) or os.path.getsize(tmp_path) == 0:
            raise RuntimeError(f"encode failed (exit {enc.returncode}): {enc.stderr.decode('utf-8', 'replace').strip()[:300]}")
        # Atomic swap: a reader never sees a half-written clip, and a failed swap leaves the original.
        os.replace(tmp_path, path)
        result["trimmed"] = True
        # The encoder's LAME header records its delay/padding, so players and ffprobe
        # decode exactly the samples we wrote.
        result["duration"] = round(kept / float(sample_rate), 3)
        return result
    except Exception as e:
        result["reason"] = str(e)
        log_stderr(f"[TTS trim] kept original ({e}): {path}")
        return result
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass

def _swapped(part):
    part = array("h", part)
    part.byteswap()
    return part.tobytes()

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

        max_attempts = 3
        last_error = ""

        for attempt in range(1, max_attempts + 1):
            # Clean up any partial or 0-byte file from previous failed attempt
            if os.path.exists(output_path):
                try:
                    os.remove(output_path)
                except Exception:
                    pass

            try:
                communicate = edge_tts.Communicate(
                    text=clean_text,
                    voice=voice,
                    rate=rate_str,
                    pitch=pitch_str,
                    volume=vol_str
                )

                # Guard against hanging coroutine on network stall / throttling
                await asyncio.wait_for(communicate.save(output_path), timeout=TTS_TIMEOUT_SECONDS)

                if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                    # Trim before measuring, so the duration the app plans with is the voice
                    # itself. FFmpeg runs in a worker thread so batch lines keep streaming.
                    trim = await asyncio.get_running_loop().run_in_executor(None, trim_silence, output_path)
                    duration = trim.get("duration") or get_audio_duration(output_path)
                    return {
                        "success": True,
                        "file": output_path,
                        "size": os.path.getsize(output_path),
                        "duration": duration,
                        "trimmed": bool(trim.get("trimmed")),
                        "untrimmedDuration": trim.get("original_duration")
                    }
                else:
                    last_error = "Generated audio file is empty"
            except asyncio.TimeoutError:
                last_error = f"TTS request timed out after {TTS_TIMEOUT_SECONDS}s"
            except Exception as e:
                last_error = str(e)

            if attempt < max_attempts:
                # Exponential backoff with small sleep before retry
                await asyncio.sleep(0.4 * attempt)

        # Ensure no corrupt 0-byte file lingers on disk
        if os.path.exists(output_path) and os.path.getsize(output_path) == 0:
            try:
                os.remove(output_path)
            except Exception:
                pass

        return {"success": False, "error": last_error or "Generated audio file is empty"}

    except Exception as e:
        if os.path.exists(output_path) and os.path.getsize(output_path) == 0:
            try:
                os.remove(output_path)
            except Exception:
                pass
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
    parser.add_argument("--trim-only", type=str, help="Only trim the silence around an existing MP3 clip (in place)")

    args = parser.parse_args()

    if args.trim_only:
        if not os.path.isfile(args.trim_only):
            print(json.dumps({"success": False, "error": "File not found"}))
            sys.exit(1)
        trim = trim_silence(args.trim_only)
        trim["success"] = True
        trim["duration"] = trim.get("duration") or get_audio_duration(args.trim_only)
        print(json.dumps(trim))
        return

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
