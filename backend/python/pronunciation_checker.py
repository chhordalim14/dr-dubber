#!/usr/bin/env python3
"""
Pronunciation checker for Khmer voice lines (runs in the VoxCPM2 venv: it needs PyTorch).

For each line it gets the Edge voice's reading and Google Translate's reading (the answer key),
and writes both down with a Khmer speech recogniser (seanghay/whisper-small-khmer-v2). The
server compares the two (backend/lib/pronunciation.js): a word Edge says differently from Google
is a word Edge misreads. The recogniser hears its own spellings (ឲ្យ/ឱ្យ...), but it hears both
voices the same way, so comparing them with each other cancels most of that.

--serve: one JSON request per stdin line ({"id", "text", "voice"}), one JSON result per stdout
line ({"id", "success", "edgeHeard", "googleHeard"} or {"id", "success": false, "error"}).
Ends when stdin closes.
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from collections import OrderedDict

GOOGLE_TTS = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=km&q="
GOOGLE_CACHE = 300  # Google's reading of a line is the same for both voices and every fix tried


def below_normal_priority():
    # A background job: the dub and the export come first.
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
        except Exception:
            pass
    else:
        try:
            os.nice(5)
        except Exception:
            pass


class Recogniser:
    def __init__(self, model_dir, ffmpeg):
        import numpy as np
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        self.np, self.torch, self.ffmpeg = np, torch, ffmpeg
        free_gb = 0.0
        if torch.cuda.is_available():
            try:
                free_gb = torch.cuda.mem_get_info()[0] / 2**30
            except Exception:
                pass
        # The GPU only with room to spare: VoxCPM2 may be holding most of it.
        self.device = "cuda" if free_gb >= 2.0 else "cpu"
        dtype = torch.float16 if self.device == "cuda" else torch.float32
        self.proc = WhisperProcessor.from_pretrained(model_dir)
        self.model = WhisperForConditionalGeneration.from_pretrained(model_dir, torch_dtype=dtype).to(self.device).eval()
        self.dtype = dtype
        # The model's generation config predates language= ; give it the token ids it needs.
        with open(os.path.join(model_dir, "added_tokens.json"), encoding="utf-8") as f:
            added = json.load(f)
        gc = self.model.generation_config
        gc.lang_to_id = {t: i for t, i in added.items() if 50259 <= i < 50358}
        gc.task_to_id = {"transcribe": added["<|transcribe|>"], "translate": added["<|translate|>"]}
        gc.is_multilingual = True
        gc.no_timestamps_token_id = added["<|notimestamps|>"]
        gc.forced_decoder_ids = None
        self.model.config.forced_decoder_ids = None
        self.lock = threading.Lock()

    def decode(self, mp3):
        raw = subprocess.run([self.ffmpeg, "-v", "error", "-i", "pipe:0", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                             input=mp3, capture_output=True, check=True,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
        return self.np.frombuffer(raw, self.np.float32)

    def hear(self, clips):
        audio = [self.decode(c) for c in clips]
        with self.lock:
            feats = self.proc(audio, sampling_rate=16000, return_tensors="pt").input_features.to(self.device, self.dtype)
            with self.torch.no_grad():
                ids = self.model.generate(feats, language="km", task="transcribe", max_new_tokens=200)
        return [t.strip() for t in self.proc.batch_decode(ids, skip_special_tokens=True)]


async def edge_clip(text, voice):
    import edge_tts
    out = bytearray()
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            out += chunk["data"]
    if not out:
        raise RuntimeError("Edge returned no audio")
    return bytes(out)


def google_clip(text):
    req = urllib.request.Request(GOOGLE_TTS + urllib.parse.quote(text), headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    if len(data) < 500:
        raise RuntimeError("Google returned no audio")
    return data


async def serve(rec, concurrency):
    loop = asyncio.get_running_loop()
    sem = asyncio.Semaphore(concurrency)
    lines = asyncio.Queue()
    google_cache = OrderedDict()

    def reader():
        for raw in sys.stdin:
            loop.call_soon_threadsafe(lines.put_nowait, raw)
        loop.call_soon_threadsafe(lines.put_nowait, None)

    def reply(obj):
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    async def google(text):
        if text in google_cache:
            google_cache.move_to_end(text)
            return google_cache[text]
        clip = await loop.run_in_executor(None, google_clip, text)
        google_cache[text] = clip
        if len(google_cache) > GOOGLE_CACHE:
            google_cache.popitem(last=False)
        return clip

    async def run(item):
        res = {"id": item.get("id")}
        try:
            async with sem:
                text = str(item.get("text") or "")
                edge, ref = await asyncio.gather(edge_clip(text, item.get("voice") or "km-KH-PisethNeural"), google(text))
                edge_heard, google_heard = await loop.run_in_executor(None, rec.hear, [edge, ref])
            res.update(success=True, edgeHeard=edge_heard, googleHeard=google_heard)
        except Exception as e:
            res.update(success=False, error=str(e)[:300])
        reply(res)

    threading.Thread(target=reader, daemon=True).start()
    reply({"ready": True, "device": rec.device})
    pending = set()
    while True:
        raw = await lines.get()
        if raw is None:
            break
        try:
            item = json.loads(raw)
        except ValueError:
            continue
        task = asyncio.ensure_future(run(item))
        pending.add(task)
        task.add_done_callback(pending.discard)
    if pending:
        await asyncio.gather(*pending)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Folder of seanghay/whisper-small-khmer-v2")
    parser.add_argument("--ffmpeg", default=os.environ.get("DR_FFMPEG_PATH") or "ffmpeg")
    parser.add_argument("--concurrency", type=int, default=3)
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    below_normal_priority()
    rec = Recogniser(args.model, args.ffmpeg)
    asyncio.run(serve(rec, max(1, args.concurrency)))


if __name__ == "__main__":
    main()
