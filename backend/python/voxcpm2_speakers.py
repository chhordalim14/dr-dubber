"""DR Dubber Pro - who speaks each line (Clone Voices from Video).

Copied beside app.py (voxcpm2_server.py) and used by its POST /api/speakers. Each line of
the transcript gets a voice print, the prints are grouped into speakers, and each speaker's
clearest lines are named so the app can cut a reference clip of that actor for VoxCPM2 to clone.

The print is ERes2NetV2 (3D-Speaker, trained on 200k Chinese speakers: 71 MB, downloaded once
from modelscope.cn into MODELSCOPE_CACHE), through modelscope, which VoxCPM2's install brings for
its clip cleaner. Where it cannot load (offline on first use), CAM++ (28 MB, huggingface.co/
funasr/campplus) stands in with its own thresholds; prints of one model are never compared with
the other's, so each print handed back says which model made it ("print_model").

Runs on the CPU (ERes2NetV2 ~0.24 s a line, CAM++ ~0.08 s), so it never competes with VoxCPM2
for the GPU.
"""

import threading
from collections import OrderedDict

import numpy as np

SR = 16000
REPO, WEIGHTS = "funasr/campplus", "campplus_cn_common.bin"
ERES2NETV2 = "iic/speech_eres2netv2_sv_zh-cn_16k-common"

# Lines shorter than this give a print too unsteady to group by; they join a speaker afterwards.
MIN_PRINT_SECONDS = 1.2
MAX_PRINT_SECONDS = 12.0
# A line's gender is its pitch where that is clear (median Hz of its loud frames), else the one
# Transcribe heard: opposite genders never group, and Transcribe's is often wrong (457 lines of 4
# C-dramas: "Male" lines median 111 Hz but 8% at 190 or more; "Female" 224 Hz, 2.5% at 140 or
# less), so a woman's line heard as a man's made a male voice of her own. Measured on 17
# transcripts of E60 (2 actors, man 88-106 Hz, woman 183-231 Hz): lines grouped with the other
# actor 21 -> 3; the 4 dramas joined: lines given another drama's actor 57 -> 60.
MALE_BELOW_HZ = 150.0
FEMALE_ABOVE_HZ = 175.0
# Two groups of lines are one speaker while their prints are at least this alike (cosine, average
# over every pair). Measured on C-drama episodes with music under the dialogue: the same actor
# 0.55-0.85, two actors of the same gender up to about 0.45.
SAME_SPEAKER = 0.52
# A short line (or a speaker with too little speech to clone from) joins its nearest speaker.
JOIN_SPEAKER = 0.30
# Seconds of speech a speaker needs to get a voice of their own; less joins the nearest speaker.
MIN_SPEAKER_SECONDS = 2.5
# And lines: one line alone is often two people in one subtitle (a reply joined to the line before
# it), whose mixed print made a voice of its own. Measured: E60's line holding both actors got
# a third voice; with 2 lines it joins its actor, and on 4 dramas joined into one movie voices
# went 40 -> 33 with lines given another drama's actor 58 -> 60 (3 lines: 24 voices but 71).
MIN_SPEAKER_LINES = 2
# A speaker of a few lines joins the nearest bigger one of their gender at this centroid likeness:
# loose subtitle times split one actor in two (E60: 2 voices in 4 of 17 transcripts, 11 with this).
# Two actors of different dramas, the smaller with <= 5 lines, reached 0.62; the price on 4 dramas
# joined: lines given another drama's actor 60 -> 67 (a minor character sharing a like voice).
MERGE_MAX_LINES = 5
MERGE_LIKE = 0.65
# A speaker matches a voice from an earlier episode at this likeness (stricter than within one
# episode: a wrong match gives a character another actor's voice for the rest of the series).
KNOWN_SPEAKER = 0.70
# The likeness figures above are CAM++'s. ERes2NetV2's, measured on the same tests (audio as
# the app sends it: FFmpeg 16 kHz, lines packed): with grouping at 0.65 and merging at 0.75, E60
# came out as its 2 actors in 15 of 18 transcripts (CAM++ 11) and the 4 dramas joined gave 48 lines
# to another drama's actor (CAM++ 69). Its best match in another drama (a different actor)
# reached 0.85, hence 0.86 for a voice from an earlier episode.
THRESHOLDS = {
    "campplus": {"same": SAME_SPEAKER, "join": JOIN_SPEAKER, "merge": MERGE_LIKE, "known": KNOWN_SPEAKER},
    "eres2netv2": {"same": 0.65, "join": JOIN_SPEAKER, "merge": 0.75, "known": 0.86},
}
# Clearest lines handed back per speaker: the app picks a calm clip and one clip per feeling
# (angry, sad...) from them, so it needs more than the very best few.
MAX_REFS = 80

_model = {"m": None}
_lock = threading.Lock()


# ── CAM++ (3D-Speaker, Apache-2.0: github.com/alibaba-damo-academy/3D-Speaker), inference only ──

def _nonlinear(config_str, channels):
    import torch.nn as nn

    seq = nn.Sequential()
    for name in config_str.split("-"):
        if name == "relu":
            seq.add_module("relu", nn.ReLU(inplace=True))
        elif name == "batchnorm":
            seq.add_module("batchnorm", nn.BatchNorm1d(channels))
        elif name == "batchnorm_":
            seq.add_module("batchnorm", nn.BatchNorm1d(channels, affine=False))
    return seq


def _build(feat_dim=80, embedding_size=192, growth_rate=32, bn_size=4, init_channels=128):
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    class ResBlock(nn.Module):
        def __init__(self, cin, cout, stride):
            super().__init__()
            self.conv1 = nn.Conv2d(cin, cout, 3, stride=(stride, 1), padding=1, bias=False)
            self.bn1 = nn.BatchNorm2d(cout)
            self.conv2 = nn.Conv2d(cout, cout, 3, stride=1, padding=1, bias=False)
            self.bn2 = nn.BatchNorm2d(cout)
            self.shortcut = nn.Sequential()
            if stride != 1 or cin != cout:
                self.shortcut = nn.Sequential(nn.Conv2d(cin, cout, 1, stride=(stride, 1), bias=False), nn.BatchNorm2d(cout))

        def forward(self, x):
            out = self.bn2(self.conv2(F.relu(self.bn1(self.conv1(x)))))
            return F.relu(out + self.shortcut(x))

    class FCM(nn.Module):
        def __init__(self, m=32):
            super().__init__()
            self.conv1 = nn.Conv2d(1, m, 3, stride=1, padding=1, bias=False)
            self.bn1 = nn.BatchNorm2d(m)
            self.layer1 = nn.Sequential(ResBlock(m, m, 2), ResBlock(m, m, 1))
            self.layer2 = nn.Sequential(ResBlock(m, m, 2), ResBlock(m, m, 1))
            self.conv2 = nn.Conv2d(m, m, 3, stride=(2, 1), padding=1, bias=False)
            self.bn2 = nn.BatchNorm2d(m)
            self.out_channels = m * (feat_dim // 8)

        def forward(self, x):
            out = F.relu(self.bn1(self.conv1(x.unsqueeze(1))))
            out = F.relu(self.bn2(self.conv2(self.layer2(self.layer1(out)))))
            s = out.shape
            return out.reshape(s[0], s[1] * s[2], s[3])

    class TDNN(nn.Module):
        def __init__(self, cin, cout, k, stride=1, dilation=1):
            super().__init__()
            self.linear = nn.Conv1d(cin, cout, k, stride=stride, padding=(k - 1) // 2 * dilation, dilation=dilation, bias=False)
            self.nonlinear = _nonlinear("batchnorm-relu", cout)

        def forward(self, x):
            return self.nonlinear(self.linear(x))

    class CAMLayer(nn.Module):
        def __init__(self, cbn, cout, k, dilation):
            super().__init__()
            self.linear_local = nn.Conv1d(cbn, cout, k, padding=(k - 1) // 2 * dilation, dilation=dilation, bias=False)
            self.linear1 = nn.Conv1d(cbn, cbn // 2, 1)
            self.relu = nn.ReLU(inplace=True)
            self.linear2 = nn.Conv1d(cbn // 2, cout, 1)
            self.sigmoid = nn.Sigmoid()

        def forward(self, x):
            y = self.linear_local(x)
            seg = F.avg_pool1d(x, kernel_size=100, stride=100, ceil_mode=True)
            s = seg.shape
            seg = seg.unsqueeze(-1).expand(*s, 100).reshape(*s[:-1], -1)[..., : x.shape[-1]]
            m = self.sigmoid(self.linear2(self.relu(self.linear1(x.mean(-1, keepdim=True) + seg))))
            return y * m

    class DenseTDNNLayer(nn.Module):
        def __init__(self, cin, cout, cbn, k, dilation):
            super().__init__()
            self.nonlinear1 = _nonlinear("batchnorm-relu", cin)
            self.linear1 = nn.Conv1d(cin, cbn, 1, bias=False)
            self.nonlinear2 = _nonlinear("batchnorm-relu", cbn)
            self.cam_layer = CAMLayer(cbn, cout, k, dilation)

        def forward(self, x):
            return self.cam_layer(self.nonlinear2(self.linear1(self.nonlinear1(x))))

    class DenseBlock(nn.ModuleList):
        def __init__(self, n, cin, cout, cbn, k, dilation):
            super().__init__()
            for i in range(n):
                self.add_module(f"tdnnd{i + 1}", DenseTDNNLayer(cin + i * cout, cout, cbn, k, dilation))

        def forward(self, x):
            for layer in self:
                x = torch.cat([x, layer(x)], dim=1)
            return x

    class Transit(nn.Module):
        def __init__(self, cin, cout):
            super().__init__()
            self.nonlinear = _nonlinear("batchnorm-relu", cin)
            self.linear = nn.Conv1d(cin, cout, 1, bias=False)

        def forward(self, x):
            return self.linear(self.nonlinear(x))

    class Dense(nn.Module):
        def __init__(self, cin, cout):
            super().__init__()
            self.linear = nn.Conv1d(cin, cout, 1, bias=False)
            self.nonlinear = _nonlinear("batchnorm_", cout)

        def forward(self, x):
            return self.nonlinear(self.linear(x.unsqueeze(-1)).squeeze(-1))

    class StatsPool(nn.Module):
        def forward(self, x):
            return torch.cat([x.mean(dim=-1), x.std(dim=-1)], dim=-1)

    class CAMPPlus(nn.Module):
        def __init__(self):
            super().__init__()
            self.head = FCM()
            ch = self.head.out_channels
            self.xvector = nn.Sequential(OrderedDict([("tdnn", TDNN(ch, init_channels, 5, stride=2))]))
            ch = init_channels
            for i, (n, k, d) in enumerate(zip((12, 24, 16), (3, 3, 3), (1, 2, 2))):
                self.xvector.add_module(f"block{i + 1}", DenseBlock(n, ch, growth_rate, bn_size * growth_rate, k, d))
                ch += n * growth_rate
                self.xvector.add_module(f"transit{i + 1}", Transit(ch, ch // 2))
                ch //= 2
            self.xvector.add_module("out_nonlinear", _nonlinear("batchnorm-relu", ch))
            self.xvector.add_module("stats", StatsPool())
            self.xvector.add_module("dense", Dense(ch * 2, embedding_size))

        def forward(self, feats):  # (B, T, 80) -> (B, 192)
            return self.xvector(self.head(feats.permute(0, 2, 1)))

    return CAMPPlus()


class _Campplus:
    name = "campplus"

    def __init__(self):
        import torch
        from huggingface_hub import hf_hub_download

        model = _build()
        try:  # the copy already on disk: asking huggingface.co first took 30 s on a slow line
            path = hf_hub_download(REPO, WEIGHTS, local_files_only=True)
        except Exception:  # noqa: BLE001 - not downloaded yet
            path = hf_hub_download(REPO, WEIGHTS)
        model.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))
        self.model = model.eval()

    def embed(self, wav):
        import torch
        import torchaudio

        x = torch.from_numpy(np.ascontiguousarray(wav, dtype=np.float32)).unsqueeze(0)
        feats = torchaudio.compliance.kaldi.fbank(x, num_mel_bins=80, sample_frequency=SR, dither=0.0)
        feats = feats - feats.mean(dim=0, keepdim=True)
        with torch.inference_mode():
            return self.model(feats.unsqueeze(0))[0].numpy()


class _Eres2netv2:
    name = "eres2netv2"

    def __init__(self):
        from modelscope.hub.snapshot_download import snapshot_download
        from modelscope.pipelines import pipeline
        from modelscope.utils.constant import Tasks

        try:  # the copy already on disk: by its name, modelscope asks modelscope.cn first (fails offline)
            path = snapshot_download(ERES2NETV2, local_files_only=True)
        except Exception:  # noqa: BLE001 - not downloaded yet (71 MB, once)
            path = snapshot_download(ERES2NETV2)
        self.pipe = pipeline(task=Tasks.speaker_verification, model=path, device="cpu")

    def embed(self, wav):
        return self.pipe([np.ascontiguousarray(wav, dtype=np.float32)], output_emb=True)["embs"][0]


def encoder(log=print):
    """The voice-print model, loaded (and downloaded the first time) on first use."""
    with _lock:
        if _model["m"] is None:
            import time

            t0 = time.time()
            try:
                _model["m"] = _Eres2netv2()
            except Exception as e:  # noqa: BLE001 - offline on first use, or no modelscope
                log(f"Could not load the ERes2NetV2 speaker model ({e}); finding speakers with CAM++")
                _model["m"] = _Campplus()
            log(f"Loaded the {_model['m'].name} speaker model in {time.time() - t0:.0f}s")
        return _model["m"]


def voice_print(model, wav):
    """A unit-length voice print of a 16 kHz mono float clip."""
    e = np.asarray(model.embed(wav), dtype=np.float32).reshape(-1)
    return e / (np.linalg.norm(e) + 1e-9)


def _unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / (np.linalg.norm(v) + 1e-9)


def _noise_db(wav):
    """How loud the quiet between words is against the speech (dB; lower is cleaner)."""
    hop = int(SR * 0.02)
    n = len(wav) // hop
    if n < 5:
        return 0.0
    db = 20 * np.log10(np.sqrt(np.mean(wav[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-12))
    loud = np.nonzero(db > db.max() - 35)[0]
    if len(loud) < 5:
        return 0.0
    speech = db[loud[0]: loud[-1] + 1]
    return float(np.percentile(speech, 5) - np.percentile(speech, 90))


def _gender(g):
    g = str(g or "").strip().lower()
    return "Female" if g == "female" else "Male" if g == "male" else None


def _pitch(clip):
    """Median pitch (Hz) of a line's loud frames, or None when too little of it is voiced."""
    import librosa

    if len(clip) < SR * 0.3:
        return None
    f0 = librosa.yin(clip, fmin=65, fmax=400, sr=SR, frame_length=1024, hop_length=256)
    rms = librosa.feature.rms(y=clip, frame_length=1024, hop_length=256)[0]
    n = min(len(f0), len(rms))
    loud = rms[:n] > rms[:n].max() * 0.3
    return float(np.median(f0[:n][loud])) if loud.sum() >= 5 else None


def _heard_gender(g, clip):
    """The line's gender by its pitch where that is clear, else the one Transcribe gave it."""
    hz = _pitch(clip)
    if hz and hz < MALE_BELOW_HZ:
        return "Male"
    if hz and hz > FEMALE_ABOVE_HZ:
        return "Female"
    return _gender(g)


def _group(prints, genders, same=SAME_SPEAKER):
    """Average-linkage grouping of voice prints (one speaker while at least `same` alike); two
    groups of opposite gender never merge.

    Returns a list of member-index lists.
    """
    n = len(prints)
    if n == 0:
        return []
    sim = prints @ prints.T
    np.fill_diagonal(sim, -np.inf)
    size = np.ones(n)
    alive = np.ones(n, dtype=bool)
    members = [[i] for i in range(n)]
    votes = [{"Male": 0, "Female": 0} for _ in range(n)]
    for i, g in enumerate(genders):
        if g:
            votes[i][g] += 1

    def side(i):
        m, f = votes[i]["Male"], votes[i]["Female"]
        return None if m == f else ("Male" if m > f else "Female")

    def block(i):
        gi = side(i)
        for k in np.nonzero(alive)[0]:
            if k != i and gi and side(k) and side(k) != gi:
                sim[i, k] = sim[k, i] = -np.inf

    for i in range(n):
        block(i)
    while alive.sum() > 1:
        flat = int(np.argmax(sim))
        i, j = divmod(flat, n)
        if sim[i, j] < same:
            break
        # Lance-Williams update for average linkage: i absorbs j.
        row = (size[i] * sim[i] + size[j] * sim[j]) / (size[i] + size[j])
        sim[i, :] = row
        sim[:, i] = row
        sim[i, i] = -np.inf
        sim[j, :] = -np.inf
        sim[:, j] = -np.inf
        alive[j] = False
        size[i] += size[j]
        members[i] += members[j]
        for g in ("Male", "Female"):
            votes[i][g] += votes[j][g]
        dead = ~alive
        sim[i, dead] = -np.inf
        sim[dead, i] = -np.inf
        block(i)
    return [members[i] for i in np.nonzero(alive)[0]]


def find_speakers(wav, lines, known=None, log=print):
    """Group the lines by who speaks them.

    wav    16 kHz mono float32 audio the line times refer to
    lines  [{"id", "start", "end", "gender"}] (gender "Male"/"Female" when known)
    known  [{"id", "gender", "embedding", "model"}] voices from earlier episodes of the same series
           (model: the print model that made the embedding, "campplus" when missing)

    Returns {"speakers": [{"key", "gender", "lines", "refs", "seconds", "embedding", "known"}],
    "print_model"}: lines are the line ids that speaker says, refs their clearest lines (best
    first) to cut reference clips from (a calm one, and one per feeling the app finds among
    them), known the id of the earlier voice they match (or None), print_model the model the
    embeddings come from.
    """
    import time

    t0 = time.time()
    model = encoder(log)
    t = THRESHOLDS[model.name]
    rows = []
    for ln in lines:
        try:
            a, b = float(ln["start"]), float(ln["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if not b > a:
            continue
        clip = wav[max(0, int(a * SR)): min(len(wav), int(b * SR))]
        rows.append({"id": str(ln["id"]), "start": a, "end": b, "dur": len(clip) / SR,
                     "gender": _heard_gender(ln.get("gender"), clip), "clip": clip})
    if not rows:
        return {"speakers": [], "print_model": model.name}

    sure = [r for r in rows if r["dur"] >= MIN_PRINT_SECONDS]
    for r in rows:
        if r["dur"] >= 0.4:
            c = r["clip"]
            if r["dur"] > MAX_PRINT_SECONDS:  # the middle: a long line's ends drift into the next one
                mid, half = len(c) // 2, int(MAX_PRINT_SECONDS * SR / 2)
                c = c[mid - half: mid + half]
            r["print"] = voice_print(model, c)
    log(f"Voice prints for {sum('print' in r for r in rows)} of {len(rows)} lines in {time.time() - t0:.1f}s")

    groups = [[sure[i] for i in g] for g in _group(np.stack([r["print"] for r in sure]) if sure else np.zeros((0, 192)),
                                                     [r["gender"] for r in sure], t["same"])]

    def centroid(g):
        # Only lines long enough for a steady print: a few short ones of another voice folded
        # into a speaker pulled their print towards a woman's voice (0.83 to a female speaker).
        core = [r["print"] for r in g if r["dur"] >= MIN_PRINT_SECONDS] or [r["print"] for r in g if "print" in r]
        return _unit(np.mean(core, axis=0))

    def gender_of(g):
        m = sum(r["dur"] for r in g if r["gender"] == "Male")
        f = sum(r["dur"] for r in g if r["gender"] == "Female")
        return None if m == f else ("Male" if m > f else "Female")

    # A speaker with too little speech (or one line) to clone from joins the nearest speaker (any gender if
    # their voices are alike: the gender heard on one line can be wrong).
    groups.sort(key=lambda g: -sum(r["dur"] for r in g))
    big = [g for g in groups if sum(r["dur"] for r in g) >= MIN_SPEAKER_SECONDS and len(g) >= MIN_SPEAKER_LINES]
    if not big and groups:
        big = [groups[0]]
    for g in groups:
        if any(g is b for b in big):
            continue
        c = centroid(g)
        gg = gender_of(g)
        scored = sorted(((float(c @ centroid(b)), b) for b in big), key=lambda t: -t[0])
        same = [(s, b) for s, b in scored if not gg or not gender_of(b) or gender_of(b) == gg]
        pick = scored[0] if scored and scored[0][0] >= t["same"] else (same[0] if same and same[0][0] >= t["join"] else None)
        if pick:
            pick[1].extend(g)
        else:
            big.append(g)
    groups = big

    # A speaker of a few lines that sounds like a bigger one of their gender is that speaker.
    merged = True
    while merged and len(groups) > 1:
        merged = False
        groups.sort(key=lambda g: -sum(r["dur"] for r in g))
        for j in range(len(groups) - 1, 0, -1):
            if len(groups[j]) > MERGE_MAX_LINES:
                continue
            c, gg = centroid(groups[j]), gender_of(groups[j])
            fits = [i for i in range(j) if not gg or not gender_of(groups[i]) or gender_of(groups[i]) == gg]
            best = max(fits, key=lambda i: float(c @ centroid(groups[i])), default=None)
            if best is not None and float(c @ centroid(groups[best])) >= t["merge"]:
                groups[best].extend(groups.pop(j))
                merged = True
                break

    # Short lines: the nearest speaker of their gender, else the main speaker of their gender.
    taken = {r["id"] for g in groups for r in g}
    cents = [centroid(g) for g in groups]
    genders = [gender_of(g) for g in groups]
    for r in rows:
        if r["id"] in taken or not groups:
            continue
        fits = [i for i in range(len(groups)) if not r["gender"] or not genders[i] or genders[i] == r["gender"]] or list(range(len(groups)))
        if "print" in r:
            best = max(fits, key=lambda i: float(r["print"] @ cents[i]))
        else:
            best = fits[0]  # groups are biggest first
        groups[best].append(r)

    # Earlier episodes: each speaker takes the earlier voice they match best, if close enough.
    # Only prints of this model: another model's place the same voice somewhere else entirely.
    known = [k for k in (known or []) if k.get("embedding") and len(k["embedding"]) == 192
             and (k.get("model") or "campplus") == model.name]
    speakers = []
    for n, g in enumerate(groups):
        c = centroid(g)
        gg = gender_of(g)
        match, score = None, t["known"]
        for k in known:
            if gg and _gender(k.get("gender")) and _gender(k.get("gender")) != gg:
                continue
            s = float(c @ _unit(k["embedding"]))
            if s >= score:
                match, score = k["id"], s
        # The clearest lines: most like the speaker as a whole, long enough to hear the voice,
        # little music or noise under them.
        def quality(r):
            if "print" not in r or r["dur"] < 1.0:
                return -9.0
            like = float(r["print"] @ c)
            length = min(r["dur"], 6.0) / 6.0
            noise = min(0.0, (-30.0 - _noise_db(r["clip"])) / 30.0)
            return like + 0.25 * length + 0.5 * noise
        ranked = sorted(g, key=quality, reverse=True)
        speakers.append({
            "key": f"S{n + 1}",
            "gender": gg,
            "lines": [r["id"] for r in sorted(g, key=lambda r: r["start"])],
            "refs": [r["id"] for r in ranked if "print" in r and r["dur"] >= 1.0][:MAX_REFS],
            "seconds": round(sum(r["dur"] for r in g), 1),
            "embedding": [round(float(v), 5) for v in c],
            "known": match,
            "known_score": round(score, 3) if match else None,
        })
    matched = sum(1 for s in speakers if s["known"])
    log(f"Found {len(speakers)} speaker(s) in {len(rows)} lines in {time.time() - t0:.1f}s ({model.name})"
        + (f" ({matched} matched from earlier episodes)" if known else ""))
    return {"speakers": speakers, "print_model": model.name}
