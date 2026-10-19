"""DR Dubber Pro - who speaks each line (Clone Voices from Video).

Copied beside app.py (voxcpm2_server.py) and used by its POST /api/speakers. Each line of
the transcript gets a voice print (CAM++, 3D-Speaker's speaker model trained on Chinese
speech: 28 MB, downloaded once from huggingface.co/funasr/campplus), the prints are
grouped into speakers, and each speaker's clearest lines are named so the app can cut a
reference clip of that actor for VoxCPM2 to clone.

Runs on the CPU (a line takes a few ms), so it never competes with VoxCPM2 for the GPU.
Needs only torch, torchaudio, numpy and huggingface_hub, which VoxCPM2 installs anyway.
"""

import threading
from collections import OrderedDict

import numpy as np

SR = 16000
REPO, WEIGHTS = "funasr/campplus", "campplus_cn_common.bin"

# Lines shorter than this give a print too unsteady to group by; they join a speaker afterwards.
MIN_PRINT_SECONDS = 1.2
MAX_PRINT_SECONDS = 12.0
# Two groups of lines are one speaker while their prints are at least this alike (cosine, average
# over every pair). Measured on C-drama episodes with music under the dialogue: the same actor
# 0.55-0.85, two actors of the same gender up to about 0.45.
SAME_SPEAKER = 0.52
# A short line (or a speaker with too little speech to clone from) joins its nearest speaker.
JOIN_SPEAKER = 0.30
# Seconds of speech a speaker needs to get a voice of their own; less joins the nearest speaker.
MIN_SPEAKER_SECONDS = 2.5
# A speaker matches a voice from an earlier episode at this likeness (stricter than within one
# episode: a wrong match gives a character another actor's voice for the rest of the series).
KNOWN_SPEAKER = 0.70
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


def encoder():
    """The CAM++ model, loaded (and downloaded the first time) on first use."""
    with _lock:
        if _model["m"] is None:
            import torch
            from huggingface_hub import hf_hub_download

            model = _build()
            try:  # the copy already on disk: asking huggingface.co first took 30 s on a slow line
                path = hf_hub_download(REPO, WEIGHTS, local_files_only=True)
            except Exception:  # noqa: BLE001 - not downloaded yet
                path = hf_hub_download(REPO, WEIGHTS)
            state = torch.load(path, map_location="cpu", weights_only=True)
            model.load_state_dict(state)
            _model["m"] = model.eval()
        return _model["m"]


def voice_print(model, wav):
    """A unit-length voice print of a 16 kHz mono float clip."""
    import torch
    import torchaudio

    x = torch.from_numpy(np.ascontiguousarray(wav, dtype=np.float32)).unsqueeze(0)
    feats = torchaudio.compliance.kaldi.fbank(x, num_mel_bins=80, sample_frequency=SR, dither=0.0)
    feats = feats - feats.mean(dim=0, keepdim=True)
    with torch.inference_mode():
        e = model(feats.unsqueeze(0))[0].numpy().astype(np.float32)
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


def _group(prints, genders):
    """Average-linkage grouping of voice prints; two groups of opposite gender never merge.

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
        if sim[i, j] < SAME_SPEAKER:
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
    known  [{"id", "gender", "embedding"}] voices from earlier episodes of the same series

    Returns {"speakers": [{"key", "gender", "lines", "refs", "seconds", "embedding", "known"}]}:
    lines are the line ids that speaker says, refs their clearest lines (best first) to cut
    reference clips from (a calm one, and one per feeling the app finds among them), known
    the id of the earlier voice they match (or None).
    """
    import time

    t0 = time.time()
    model = encoder()
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
                     "gender": _gender(ln.get("gender")), "clip": clip})
    if not rows:
        return {"speakers": []}

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
                                                     [r["gender"] for r in sure])]

    def centroid(g):
        # Only lines long enough for a steady print: a few short ones of another voice folded
        # into a speaker pulled their print towards a woman's voice (0.83 to a female speaker).
        core = [r["print"] for r in g if r["dur"] >= MIN_PRINT_SECONDS] or [r["print"] for r in g if "print" in r]
        return _unit(np.mean(core, axis=0))

    def gender_of(g):
        m = sum(r["dur"] for r in g if r["gender"] == "Male")
        f = sum(r["dur"] for r in g if r["gender"] == "Female")
        return None if m == f else ("Male" if m > f else "Female")

    # A speaker with too little speech to clone from joins the nearest speaker (any gender if
    # their voices are alike: the gender heard on one line can be wrong).
    groups.sort(key=lambda g: -sum(r["dur"] for r in g))
    big = [g for g in groups if sum(r["dur"] for r in g) >= MIN_SPEAKER_SECONDS]
    if not big and groups:
        big = [groups[0]]
    for g in groups:
        if any(g is b for b in big):
            continue
        c = centroid(g)
        gg = gender_of(g)
        scored = sorted(((float(c @ centroid(b)), b) for b in big), key=lambda t: -t[0])
        same = [(s, b) for s, b in scored if not gg or not gender_of(b) or gender_of(b) == gg]
        pick = scored[0] if scored and scored[0][0] >= SAME_SPEAKER else (same[0] if same and same[0][0] >= JOIN_SPEAKER else None)
        if pick:
            pick[1].extend(g)
        else:
            big.append(g)
    groups = big

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
    known = [k for k in (known or []) if k.get("embedding") and len(k["embedding"]) == 192]
    speakers = []
    for n, g in enumerate(groups):
        c = centroid(g)
        gg = gender_of(g)
        match, score = None, KNOWN_SPEAKER
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
    log(f"Found {len(speakers)} speaker(s) in {len(rows)} lines in {time.time() - t0:.1f}s"
        + (f" ({matched} matched from earlier episodes)" if known else ""))
    return {"speakers": speakers}
