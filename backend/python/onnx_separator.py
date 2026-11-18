#!/usr/bin/env python3
"""
Vocal / BGM separation with a UVR MDX-Net model run by onnxruntime.

Needs only numpy and onnxruntime (both already in the bundled python_env) plus
ffmpeg for decoding, so it ships inside the installer: no TensorFlow (Spleeter)
or torch (Demucs) environment to download.

The STFT framing, chunking and "compensate" scaling follow UVR's own MDX
separator, so a model gives the same stems here as in UVR.

The shipped model is UVR-MDX-NET-Voc_FT from the Ultimate Vocal Remover
project (github.com/Anjok07/ultimatevocalremovergui). On drama-style test mixes
(dialogue over known music) its BGM came out cleanest of everything tried:
SDR 19.9 dB, against 19.1 for Inst_HQ_4, 16.9 for Demucs htdemucs and 12.5 for
Spleeter 2stems. As a vocal model it leaves the music between lines untouched.
"""

import hashlib
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.request
import wave

import numpy as np

SAMPLE_RATE = 44100
HOP = 1024
DIM_T = 256  # STFT frames per model call (2 ** mdx_dim_t_set)
DEFAULT_MODEL = "UVR-MDX-NET-Voc_FT.onnx"
# Where download_model gets the shipped model when backend/models doesn't have it: only
# setup_python_env.bat (Windows) puts it there, so a Mac or source install had none and
# every Isolate BGM fell back to Spleeter (~6 GB of RAM per 7-minute tab, two tabs at once).
# Same file and checksum as that script.
MODEL_URL = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/" + DEFAULT_MODEL
MODEL_SHA256 = "534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111"
# Share of each ~6 s chunk that the next chunk also covers. 0.1 scored within
# 0.03 dB of 0.5 and takes 1.1 model runs per sample instead of 2.
OVERLAP = 0.1

# Settings per model file, from UVR's mdx_model_data (keyed there by a hash of
# the file). primary is the stem the network outputs; the other stem is
# mix - primary.
MODELS = {
    "UVR-MDX-NET-Inst_HQ_3.onnx": {"n_fft": 6144, "dim_f": 3072, "compensate": 1.022, "primary": "bgm"},
    "UVR-MDX-NET-Inst_HQ_4.onnx": {"n_fft": 5120, "dim_f": 2560, "compensate": 1.019, "primary": "bgm"},
    "UVR-MDX-NET-Inst_HQ_5.onnx": {"n_fft": 5120, "dim_f": 2560, "compensate": 1.010, "primary": "bgm"},
    "UVR-MDX-NET-Inst_Main.onnx": {"n_fft": 5120, "dim_f": 2048, "compensate": 1.025, "primary": "bgm"},
    "UVR-MDX-NET-Voc_FT.onnx": {"n_fft": 7680, "dim_f": 3072, "compensate": 1.021, "primary": "vocal"},
    "Kim_Vocal_2.onnx": {"n_fft": 7680, "dim_f": 3072, "compensate": 1.009, "primary": "vocal"},
}


# GPU runtimes MdxModel uses, best first: DirectML (onnxruntime-directml, Windows) and
# Core ML (the stock onnxruntime on a Mac).
GPU_PROVIDERS = ("DmlExecutionProvider", "CoreMLExecutionProvider")


def gpu_provider(ort):
    """The GPU runtime this onnxruntime has, or None (CPU only)."""
    available = ort.get_available_providers()
    if "DmlExecutionProvider" in available:
        return "DmlExecutionProvider"
    if sys.platform == "darwin" and "CoreMLExecutionProvider" in available:
        return "CoreMLExecutionProvider"
    return None


def hann(n):
    """Periodic Hann window, the same as torch.hann_window(n)."""
    return (0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n) / n)).astype(np.float32)


class MdxModel:
    def __init__(self, path, threads=None):
        import onnxruntime as ort

        name = os.path.basename(path)
        if name not in MODELS:
            raise ValueError(f"unknown MDX model {name}")
        cfg = MODELS[name]
        self.name = name
        self.n_fft = cfg["n_fft"]
        self.dim_f = cfg["dim_f"]
        self.compensate = cfg["compensate"]
        self.primary = cfg["primary"]
        self.chunk = HOP * (DIM_T - 1)
        self.trim = self.n_fft // 2
        self.window = hann(self.n_fft)
        # torch.istft's overlap-add normaliser for these frames.
        wsum = np.zeros(self.n_fft + HOP * (DIM_T - 1), dtype=np.float32)
        for t in range(DIM_T):
            wsum[t * HOP:t * HOP + self.n_fft] += self.window ** 2
        self.wsum = np.maximum(wsum, 1e-8)
        self.frame_idx = np.arange(DIM_T)[:, None] * HOP + np.arange(self.n_fft)[None, :]

        self.path = path
        self.threads = threads
        self.session = None
        # MDX_DEVICE=cpu keeps it off the GPU.
        if os.environ.get("MDX_DEVICE", "").lower() != "cpu" and gpu_provider(ort):
            try:
                self.session = self.open_session(gpu=True)
            except Exception:
                self.session = None  # no DirectX 12 GPU, or its driver refused: CPU
        if self.session is None:
            self.session = self.open_session(gpu=False)
        self.input_name = self.session.get_inputs()[0].name

    def open_session(self, gpu):
        """
        gpu: DirectML (onnxruntime-directml, any DirectX 12 GPU on Windows), on
        the high-performance GPU of a laptop that also has integrated graphics.
        On an RTX 3060 Laptop that is ~13x real time against ~0.7x on 8 Ryzen
        threads, with the same stems (107 dB apart).
        """
        import onnxruntime as ort

        opts = ort.SessionOptions()
        if self.threads:
            opts.intra_op_num_threads = int(self.threads)
            opts.inter_op_num_threads = 1
        opts.log_severity_level = 3
        # "Extended", not the default "all": the NCHWc layout rewrite that
        # "all" adds makes these conv stacks ~20% slower on CPU.
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
        provider = gpu_provider(ort) if gpu else None
        if not provider:
            # No memory-pattern planning: it keeps every intermediate's peak-sized buffer
            # for the whole run (M4, 5 threads: 1.7 GB against 2.4 GB, same speed, the
            # same stems bit for bit). The arena stays: without it the peak was higher.
            opts.enable_mem_pattern = False
            return ort.InferenceSession(self.path, opts, providers=["CPUExecutionProvider"])
        if provider == "CoreMLExecutionProvider":
            # A Mac: Core ML on the GPU (M4: 16.6x real time against 4.4x on 5 CPU threads,
            # 1.0 GB against 2.4 GB, the same stems: 130 dB apart). "CPUAndGPU" was faster than
            # "ALL" (which adds the Neural Engine): 3.6 s against 4.7 s for a minute of audio.
            coreml = {"MLComputeUnits": "CPUAndGPU", "ModelFormat": "MLProgram"}
            return ort.InferenceSession(self.path, opts, providers=[(provider, coreml), "CPUExecutionProvider"])
        # DirectML can't use memory patterns or run nodes in parallel.
        opts.enable_mem_pattern = False
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        dml = {"performance_preference": "high_performance", "device_filter": "gpu"}
        return ort.InferenceSession(self.path, opts, providers=[("DmlExecutionProvider", dml), "CPUExecutionProvider"])

    @property
    def on_gpu(self):
        return any(p in GPU_PROVIDERS for p in self.session.get_providers())

    def run_model(self, spec):
        try:
            out = self.session.run(None, {self.input_name: spec})[0]
            # A GPU that answers with NaN/inf (a driver or Core ML fault) would make the
            # rest of the tab silent or noise: treated like a GPU that gave up.
            if self.on_gpu and not np.isfinite(out).all():
                raise RuntimeError("the GPU gave back invalid numbers")
            return out
        except Exception:
            if not self.on_gpu:
                raise
            # The GPU gave up mid-file (driver reset, out of memory): the rest on the CPU.
            self.session = self.open_session(gpu=False)
            return self.session.run(None, {self.input_name: spec})[0]

    def stft(self, x):
        """[2, chunk] -> [1, 4, dim_f, DIM_T] as (L re, L im, R re, R im)."""
        pad = self.n_fft // 2
        xp = np.pad(x, ((0, 0), (pad, pad)), mode="reflect")
        frames = xp[:, self.frame_idx] * self.window  # [2, T, n_fft]
        spec = np.fft.rfft(frames, axis=-1)[:, :, :self.dim_f].transpose(0, 2, 1)  # [2, F, T]
        out = np.stack([spec.real, spec.imag], axis=1).reshape(1, 4, self.dim_f, DIM_T).astype(np.float32)
        out[:, :, :3, :] = 0  # UVR zeroes the lowest bins before the model
        return out

    def istft(self, spec):
        """[1, 4, dim_f, DIM_T] -> [2, chunk]."""
        s = spec.reshape(2, 2, self.dim_f, DIM_T)
        full = np.zeros((2, self.n_fft // 2 + 1, DIM_T), dtype=np.complex64)
        full[:, :self.dim_f, :] = s[:, 0] + 1j * s[:, 1]
        frames = np.fft.irfft(full.transpose(0, 2, 1), n=self.n_fft, axis=-1).astype(np.float32) * self.window
        y = np.zeros((2, self.wsum.shape[0]), dtype=np.float32)
        for t in range(DIM_T):
            y[:, t * HOP:t * HOP + self.n_fft] += frames[:, t]
        y /= self.wsum
        pad = self.n_fft // 2
        return y[:, pad:pad + self.chunk]

    def run_chunk(self, x, denoise=False):
        spec = self.stft(x)
        if denoise:
            # UVR's "Denoise Output": the network's own noise flips sign with
            # the input and cancels out, the music does not.
            pred = (self.run_model(spec) - self.run_model(-spec)) * 0.5
        else:
            pred = self.run_model(spec)
        return self.istft(pred)

    def blend_weight(self, overlap_len):
        """
        Weight of one chunk's output when chunks overlap by overlap_len
        samples. The outermost samples (where the STFT ran off the chunk's end)
        get none, then a sin^2 fade over the overlap, flat in the middle.
        Neighbouring fades sum to exactly 1, so there are no seams.
        """
        edge = min(self.trim, overlap_len // 4)
        ramp = overlap_len - 2 * edge
        w = np.ones(self.chunk, dtype=np.float32)
        w[:edge] = 0.0
        w[self.chunk - edge:] = 0.0
        fade = np.sin(0.5 * np.pi * (np.arange(ramp) + 0.5) / ramp).astype(np.float32) ** 2
        w[edge:edge + ramp] = fade
        w[self.chunk - edge - ramp:self.chunk - edge] = fade[::-1]
        return w

    def chunk_count(self, n, overlap=0.1):
        """How many chunks stream_stem runs for n samples."""
        overlap_len = max(4 * HOP, int(self.chunk * overlap))
        return len(range(0, max(1, self.trim + n + self.trim - overlap_len), self.chunk - overlap_len))

    def stream_stem(self, read, emit, overlap=0.1, denoise=False, progress=None, n_hint=None):
        """
        The model's own stem (BGM for Inst models, vocals for vocal models) of audio
        that comes in a piece at a time and goes out a piece at a time, so neither the
        mix nor the stem is ever held whole: as float32 a 48-minute tab is 1 GB a copy,
        and holding the mix, the stem and their weights took ~3.5 GB on top of the model.
        read(k): the next float32 [2, <=k] samples, fewer only at the end.
        emit(mix, stem): the next finished samples of both, in order.
        overlap is the share of each chunk that its neighbour also covers. n_hint, the
        expected sample count, only sizes the progress reports. Returns the sample count.
        """
        chunk = self.chunk
        overlap_len = max(4 * HOP, int(chunk * overlap))
        step = chunk - overlap_len
        weight = self.blend_weight(overlap_len)
        # The audio sits at [lead, lead + n) of a virtual zero-padded signal,
        # so the first and last real samples are mid-chunk, never at an edge.
        lead = self.trim
        # The mix from real sample mix0 on (never more than one chunk), and the
        # weighted sum of the chunks' outputs from virtual sample `start` on.
        mix = np.zeros((2, chunk), dtype=np.float32)
        mix0 = have = 0
        acc = np.zeros((2, chunk), dtype=np.float32)
        acc_w = np.zeros(chunk, dtype=np.float32)
        part = np.zeros((2, chunk), dtype=np.float32)
        n = None  # known once read comes up short
        emitted = 0  # real samples handed to emit so far

        def flush(upto):
            # Real samples [emitted, upto) are final: no later chunk reaches them.
            nonlocal emitted, mix0, have
            if upto <= emitted:
                return
            i = emitted + lead - start
            stem = acc[:, i:i + upto - emitted] / np.maximum(acc_w[i:i + upto - emitted], 1e-8)
            stem *= self.compensate
            emit(mix[:, emitted - mix0:upto - mix0], stem)
            keep = have - (upto - mix0)
            mix[:, :keep] = mix[:, upto - mix0:have]
            mix0, have, emitted = upto, keep, upto

        start = k = 0
        total = self.chunk_count(n_hint, overlap) if n_hint else None
        while True:
            # Read on to the end of this chunk (or of the audio).
            need = start + chunk - lead
            while n is None and mix0 + have < need:
                piece = read(need - mix0 - have)
                got = piece.shape[1]
                mix[:, have:have + got] = piece
                have += got
                if mix0 + have < need:
                    n = mix0 + have
            if n is not None and start >= max(1, lead + n + self.trim - overlap_len):
                break
            # This chunk's span, clipped to the real audio.
            a, b = max(start, lead), min(start + chunk, lead + mix0 + have)
            if b > a:
                part[:] = 0.0
                part[:, a - start:b - start] = mix[:, a - lead - mix0:b - lead - mix0]
                pred = self.run_chunk(part, denoise=denoise)
                w = weight[a - start:b - start]
                acc[:, a - start:b - start] += pred[:, a - start:b - start] * w
                acc_w[a - start:b - start] += w
            k += 1
            if progress:
                if n is not None:
                    total = self.chunk_count(n, overlap)
                if total and k < total:
                    progress(k, total)
            flush(min(start + step - lead, mix0 + have))
            acc[:, :overlap_len] = acc[:, step:]
            acc[:, overlap_len:] = 0.0
            acc_w[:overlap_len] = acc_w[step:]
            acc_w[overlap_len:] = 0.0
            start += step
        flush(n)
        if progress:
            progress(k, k)
        return n

    def primary_stem(self, mix, overlap=0.1, denoise=False, progress=None):
        """
        mix: float32 [2, n]. Returns the model's own stem (BGM for Inst
        models, vocals for vocal models), float32 [2, n].
        """
        n = mix.shape[1]
        out = np.zeros((2, n), dtype=np.float32)
        pos = {"read": 0, "out": 0}

        def read(k):
            i = pos["read"]
            pos["read"] = min(n, i + k)
            return mix[:, i:pos["read"]]

        def emit(_, stem):
            i = pos["out"]
            out[:, i:i + stem.shape[1]] = stem
            pos["out"] = i + stem.shape[1]

        self.stream_stem(read, emit, overlap=overlap, denoise=denoise, progress=progress, n_hint=n)
        return out

    def bgm(self, mix, **kw):
        stem = self.primary_stem(mix, **kw)
        return stem if self.primary == "bgm" else mix - stem


def read_audio(path, ffmpeg="ffmpeg"):
    """Any audio/video file -> float32 [2, n] at 44.1 kHz stereo (C-contiguous).

    Decoded straight into one array: holding FFmpeg's interleaved output and then a
    planar copy of it took twice the track (2 GB for a 48-minute tab) at the peak."""
    duration = probe_duration(path, ffmpeg)
    cap = int((duration or 600) * SAMPLE_RATE) + SAMPLE_RATE  # a second spare
    out = np.empty((2, cap), dtype=np.float32)
    n = 0
    block = 1 << 18  # samples per read (2 MB)
    with subprocess.Popen(
            [ffmpeg, "-v", "error", "-nostdin", "-i", path, "-vn", "-f", "f32le",
             "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(SAMPLE_RATE), "-"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
        errors = []
        reader = threading.Thread(target=lambda: errors.extend(proc.stderr.read().decode("utf-8", "replace").strip().splitlines()), daemon=True)
        reader.start()
        while True:
            data = proc.stdout.read(block * 8)
            k = len(data) // 8
            if k:
                if n + k > cap:  # the header's duration was short: grow (rare)
                    cap = max(n + k, cap + cap // 4)
                    grown = np.empty((2, cap), dtype=np.float32)
                    grown[:, :n] = out[:, :n]
                    out = grown
                out[:, n:n + k] = np.frombuffer(data[:k * 8], dtype=np.float32).reshape(-1, 2).T
                n += k
            if len(data) < block * 8:
                break
        code = proc.wait()
        reader.join(5)
    if code != 0 or not n:
        raise RuntimeError("ffmpeg could not decode the audio" + (f": {errors[-1]}" if errors else ""))
    if n == cap:
        return out
    # Pack the second channel up against the first, in place, so [2, n] is one block.
    flat = out.reshape(-1)
    for i in range(0, n, block):
        j = min(n, i + block)
        flat[n + i:n + j] = flat[cap + i:cap + j]
    return flat[:2 * n].reshape(2, n)


def to_pcm16(audio):
    """float32 [2, n] -> interleaved 16-bit bytes (peaks above full scale are clipped)."""
    return (np.clip(audio, -1.0, 1.0).T * 32767.0).astype("<i2").tobytes()


def write_wav(path, audio):
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(to_pcm16(audio))


def find_model(name=DEFAULT_MODEL, model_dir=None):
    """The model file: MDX_MODEL_PATH, else backend/models next to this script, else
    model_dir (where download_model puts it)."""
    override = os.environ.get("MDX_MODEL_PATH")
    if override and os.path.isfile(override):
        return override
    py_dir = os.path.dirname(os.path.abspath(__file__))
    if "app.asar" in py_dir and "app.asar.unpacked" not in py_dir:
        py_dir = py_dir.replace("app.asar", "app.asar.unpacked")
    cands = [os.path.join(py_dir, "..", "models", name), os.path.join(py_dir, "models", name)]
    if model_dir:
        cands.append(os.path.join(model_dir, name))
    for cand in cands:
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    return None


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def download_model(model_dir, url=MODEL_URL, sha256=MODEL_SHA256, name=DEFAULT_MODEL):
    """The shipped model downloaded into model_dir (~64 MB, once), checked against its
    sha256. Each process writes its own .part file, so two tabs downloading at once
    can't mix their bytes; the last one to finish just replaces an identical file."""
    os.makedirs(model_dir, exist_ok=True)
    path = os.path.join(model_dir, name)
    part = f"{path}.{os.getpid()}.part"
    try:
        with urllib.request.urlopen(url, timeout=60) as res, open(part, "wb") as f:
            shutil.copyfileobj(res, f, 1 << 20)
        if sha256_of(part) != sha256:
            raise RuntimeError("the download is damaged (checksum does not match)")
        os.replace(part, path)
    finally:
        if os.path.exists(part):
            os.remove(part)
    return path


def separate_file(input_path, job_dir, model_path, ffmpeg="ffmpeg", threads=None, progress=None):
    """
    Writes job_dir/vocals.wav and job_dir/accompaniment.wav (the BGM) and
    returns their paths. The BGM is the mix minus the separated voice, so
    music and sound effects between and under the lines are kept as they are.
    """
    model = MdxModel(model_path, threads=threads)
    stem_is_bgm = model.primary == "bgm"
    vocal_path = os.path.join(job_dir, "vocals.wav")
    bgm_path = os.path.join(job_dir, "accompaniment.wav")
    # The audio is decoded, separated and written a chunk (~6 s) at a time: a 10-minute
    # tab peaked at 3.1 GB on the CPU when the whole track was held three times over.
    duration = probe_duration(input_path, ffmpeg)
    proc = subprocess.Popen(
        [ffmpeg, "-v", "error", "-nostdin", "-i", input_path, "-vn", "-f", "f32le",
         "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(SAMPLE_RATE), "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    errors = []
    reader = threading.Thread(target=lambda: errors.extend(proc.stderr.read().decode("utf-8", "replace").strip().splitlines()), daemon=True)
    reader.start()

    def read(k):
        data = proc.stdout.read(k * 8)  # 2 x float32 a sample; short only at the end
        return np.frombuffer(data[:len(data) // 8 * 8], dtype=np.float32).reshape(-1, 2).T

    def failed():
        reader.join(5)
        return RuntimeError("ffmpeg could not decode the audio" + (f": {errors[-1]}" if errors else ""))

    ok = False
    try:
        with wave.open(vocal_path, "wb") as wv, wave.open(bgm_path, "wb") as wb:
            for w in (wv, wb):
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(SAMPLE_RATE)

            def emit(m, s):
                vocal, bgm = (m - s, s) if stem_is_bgm else (s, m - s)
                wv.writeframes(to_pcm16(vocal))
                wb.writeframes(to_pcm16(bgm))

            n = model.stream_stem(read, emit, overlap=OVERLAP, progress=progress,
                                  n_hint=int(duration * SAMPLE_RATE) if duration else None)
        if proc.wait() != 0 or not n:
            raise failed()
        ok = True
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        proc.stdout.close()
        if not ok:
            for p in (vocal_path, bgm_path):
                try:
                    os.remove(p)
                except OSError:
                    pass
    return vocal_path, bgm_path


def probe_duration(path, ffmpeg="ffmpeg"):
    """The file's duration in seconds from FFmpeg's header read (no decoding), or None."""
    try:
        res = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-i", path],
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30)
        m = re.search(rb"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", res.stderr)
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)) if m else None
    except Exception:
        return None
