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

import os
import subprocess
import wave

import numpy as np

SAMPLE_RATE = 44100
HOP = 1024
DIM_T = 256  # STFT frames per model call (2 ** mdx_dim_t_set)
DEFAULT_MODEL = "UVR-MDX-NET-Voc_FT.onnx"
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

        opts = ort.SessionOptions()
        if threads:
            opts.intra_op_num_threads = int(threads)
            opts.inter_op_num_threads = 1
        opts.log_severity_level = 3
        # "Extended", not the default "all": the NCHWc layout rewrite that
        # "all" adds makes these conv stacks ~20% slower on CPU.
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
        self.session = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

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
            pred = (self.session.run(None, {self.input_name: spec})[0]
                    - self.session.run(None, {self.input_name: -spec})[0]) * 0.5
        else:
            pred = self.session.run(None, {self.input_name: spec})[0]
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

    def primary_stem(self, mix, overlap=0.1, denoise=False, progress=None):
        """
        mix: float32 [2, n]. Returns the model's own stem (BGM for Inst
        models, vocals for vocal models), float32 [2, n].
        overlap is the share of each chunk that its neighbour also covers.
        """
        n = mix.shape[1]
        overlap_len = max(4 * HOP, int(self.chunk * overlap))
        step = self.chunk - overlap_len
        weight = self.blend_weight(overlap_len)
        # The audio sits at [lead, lead + n) of a virtual zero-padded signal,
        # so the first and last real samples are mid-chunk, never at an edge.
        lead = self.trim
        total = lead + n + self.trim
        starts = list(range(0, max(1, total - overlap_len), step))
        out = np.zeros((2, n), dtype=np.float32)
        div = np.zeros(n, dtype=np.float32)
        part = np.zeros((2, self.chunk), dtype=np.float32)
        for k, start in enumerate(starts):
            # This chunk's span, clipped to the real audio.
            a, b = max(start, lead), min(start + self.chunk, lead + n)
            part[:] = 0.0
            if b > a:
                part[:, a - start:b - start] = mix[:, a - lead:b - lead]
                pred = self.run_chunk(part, denoise=denoise)
                w = weight[a - start:b - start]
                out[:, a - lead:b - lead] += pred[:, a - start:b - start] * w
                div[a - lead:b - lead] += w
            if progress:
                progress(k + 1, len(starts))
        out /= np.maximum(div, 1e-8)
        out *= self.compensate
        return out

    def bgm(self, mix, **kw):
        stem = self.primary_stem(mix, **kw)
        return stem if self.primary == "bgm" else mix - stem


def read_audio(path, ffmpeg="ffmpeg"):
    """Any audio/video file -> float32 [2, n] at 44.1 kHz stereo."""
    res = subprocess.run(
        [ffmpeg, "-v", "error", "-nostdin", "-i", path, "-vn", "-f", "f32le",
         "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(SAMPLE_RATE), "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if res.returncode != 0 or not res.stdout:
        err = res.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("ffmpeg could not decode the audio" + (f": {err[-1]}" if err else ""))
    data = np.frombuffer(res.stdout, dtype=np.float32)
    return data.reshape(-1, 2).T.copy()


def to_pcm16(audio):
    """float32 [2, n] -> interleaved 16-bit bytes (peaks above full scale are clipped)."""
    return (np.clip(audio, -1.0, 1.0).T * 32767.0).astype("<i2").tobytes()


def write_wav(path, audio):
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(to_pcm16(audio))


def find_model(name=DEFAULT_MODEL):
    """The model file: MDX_MODEL_PATH, else backend/models next to this script."""
    override = os.environ.get("MDX_MODEL_PATH")
    if override and os.path.isfile(override):
        return override
    py_dir = os.path.dirname(os.path.abspath(__file__))
    if "app.asar" in py_dir and "app.asar.unpacked" not in py_dir:
        py_dir = py_dir.replace("app.asar", "app.asar.unpacked")
    for cand in (os.path.join(py_dir, "..", "models", name),
                 os.path.join(py_dir, "models", name)):
        if os.path.isfile(cand):
            return os.path.abspath(cand)
    return None


def separate_file(input_path, job_dir, model_path, ffmpeg="ffmpeg", threads=None, progress=None):
    """
    Writes job_dir/vocals.wav and job_dir/accompaniment.wav (the BGM) and
    returns their paths. The BGM is the mix minus the separated voice, so
    music and sound effects between and under the lines are kept as they are.
    """
    model = MdxModel(model_path, threads=threads)
    mix = read_audio(input_path, ffmpeg)
    stem = model.primary_stem(mix, overlap=OVERLAP, progress=progress)
    stem_is_bgm = model.primary == "bgm"
    vocal_path = os.path.join(job_dir, "vocals.wav")
    bgm_path = os.path.join(job_dir, "accompaniment.wav")
    with wave.open(vocal_path, "wb") as wv, wave.open(bgm_path, "wb") as wb:
        for w in (wv, wb):
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
        block = 1 << 20  # a block at a time: no second full-length copy in memory
        for i in range(0, mix.shape[1], block):
            m = mix[:, i:i + block]
            s = stem[:, i:i + block]
            vocal, bgm = (m - s, s) if stem_is_bgm else (s, m - s)
            wv.writeframes(to_pcm16(vocal))
            wb.writeframes(to_pcm16(bgm))
    return vocal_path, bgm_path
