// Capture Voice from Movie (VoxCPM2).
//
// Opens on the minute around the playhead: the backend cuts that window out of
// the original file (routes/voice-capture.js), the page decodes it, draws it and
// lets you pick 3-7 seconds of one actor. Snap to voice trims silence, Denoise
// and Dialogue only (5.1 centre channel) clean it, the Voice EQ shapes it (heard
// live in the preview, baked into the saved wav), and Save writes the clip and
// adds it as a VoxCPM2 voice profile, straight into a voice group.
(function () {
  const API = "http://localhost:3001";
  const WINDOW_SPAN = 60;
  const MIN_LEN = 0.5;
  const SWEET_LO = 3;
  const SWEET_HI = 7;
  const MAX_LEN = 7;
  const DEFAULT_LEN = 4;
  const ZOOMS = [60, 30, 15, 8, 4];
  const PROFILE_COLORS = ["#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#14b8a6", "#f97316", "#a855f7", "#6366f1"];
  const EQ_KEY = "voxCapture:eq";
  const EQ_BANDS = [
    { type: "lowshelf", f: 120, g: 0, q: 0.7, label: "Low" },
    { type: "peaking", f: 450, g: 0, q: 1.0, label: "Body" },
    { type: "peaking", f: 2800, g: 0, q: 1.0, label: "Presence" },
    { type: "highshelf", f: 8000, g: 0, q: 0.7, label: "Air" },
  ];
  const EQ_PRESETS = {
    Flat: [0, 0, 0, 0],
    Warm: [3, 1.5, -1, -2],
    Clear: [-2, -1.5, 3, 2],
    Deep: [4, 2, -1.5, -3],
    Bright: [-1, 0, 2.5, 4],
    "De-mud": [-1, -4, 1.5, 0],
  };
  const EQ_F_MIN = 40;
  const EQ_F_MAX = 16000;
  const EQ_G_MAX = 12;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = (m, t) => typeof showToast === "function" && showToast(m, t);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt = (t) => {
    t = Math.max(0, t || 0);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = (t % 60).toFixed(1).padStart(4, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  };
  const icons = (root) => typeof _lucideCreateIcons === "function" && _lucideCreateIcons({ root });
  const loadVox = () => (typeof voxCmp2Load === "function" ? voxCmp2Load() : { profiles: [], groups: [] });

  // ── state ──────────────────────────────────────────────────────────────
  const S = {
    open: false,
    proj: null,
    filePath: "",
    playhead: 0,
    movieDuration: 0,
    win: null, // { start, duration, hasCenter, samples, sr, buffer }
    loading: false,
    loadSeq: 0,
    sel: { a: 0, b: 0 },
    viewSpan: WINDOW_SPAN,
    viewStart: 0,
    denoise: false,
    center: false,
    eqOn: false,
    eq: EQ_BANDS.map((b) => ({ ...b })),
    eqPreset: "Flat",
    name: "",
    nameTouched: false,
    color: PROFILE_COLORS[0],
    gender: "Female",
    groupId: null,
    saved: [],
    ctx: null,
    src: null,
    playStartedAt: 0,
    playFrom: 0,
    playTo: 0,
    raf: 0,
    linesOpen: false,
    saving: false,
  };

  function ensureCtx() {
    if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (S.ctx.state === "suspended") S.ctx.resume().catch(() => {});
    return S.ctx;
  }

  // ── markup ─────────────────────────────────────────────────────────────
  function build() {
    if ($("vcx-modal")) return;
    const el = document.createElement("div");
    el.id = "vcx-modal";
    el.className = "vcx-modal hidden";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Capture Voice from Movie");
    // No backdrop blur: this sits over the hardware-decoded <video>.
    el.innerHTML = `
      <div class="vcx-panel" id="vcx-panel">
        <div class="vcx-head">
          <div class="vcx-title">
            <i data-lucide="mic-vocal" class="w-4 h-4 text-violet-400"></i>
            <span class="vcx-title-t">Capture Voice from Movie</span>
            <span class="vcx-title-s">· the minute around your playhead</span>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" id="vcx-cl-toggle" class="vcx-chipbtn" aria-pressed="false" hidden title="Show every line — click one to capture it">
              <i data-lucide="users" class="w-3.5 h-3.5"></i><span>Lines</span>
            </button>
            <button type="button" id="vcx-close" class="vcx-x" title="Close (Esc)"><i data-lucide="x" class="w-4 h-4"></i></button>
          </div>
        </div>

        <div class="vcx-grid" id="vcx-grid">
          <aside class="vcx-cl" id="vcx-cl" hidden>
            <div class="vcx-sec-h"><span>Lines</span><span id="vcx-cl-count" class="vcx-muted"></span></div>
            <div class="vcx-muted vcx-small">Click a line to frame it on the wave and hear it.</div>
            <div id="vcx-cl-list" class="vcx-cl-list custom-scrollbar"></div>
          </aside>

          <div class="vcx-left">
            <div class="vcx-sec-h"><span>Pick the moment</span><span class="vcx-muted">drag · edges resize · click to jump · scroll to zoom</span></div>
            <div class="vcx-wavebox">
              <div id="vcx-wavewrap" class="vcx-wavewrap">
                <canvas id="vcx-wave"></canvas>
                <div id="vcx-shade-l" class="vcx-shade"></div>
                <div id="vcx-shade-r" class="vcx-shade"></div>
                <div id="vcx-sel" class="vcx-sel" role="slider" aria-label="Capture window" tabindex="0">
                  <span id="vcx-dur" class="vcx-dur">4.0s</span>
                  <span class="vcx-h vcx-h-l" data-h="l"></span>
                  <span class="vcx-h vcx-h-r" data-h="r"></span>
                </div>
                <div id="vcx-cursor" class="vcx-cursor hidden"></div>
                <div id="vcx-ph-line" class="vcx-ph-line" title="Where the movie's playhead was"></div>
              </div>
              <div id="vcx-ov" class="vcx-ov" title="The whole window — drag the box to move, click to jump">
                <canvas id="vcx-ovcanvas"></canvas>
                <div id="vcx-ph" class="vcx-ph"></div>
                <div id="vcx-ovsel" class="vcx-ovsel"></div>
                <div id="vcx-ovport" class="vcx-ovport"></div>
              </div>
              <div id="vcx-loading" class="vcx-loading hidden"><i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span id="vcx-loading-t">Reading the movie's audio…</span></div>
            </div>
            <div id="vcx-timerow" class="vcx-timerow"><span></span><span></span><span></span><span></span><span></span></div>

            <div class="vcx-ctrls">
              <button type="button" id="vcx-play" class="vcx-btn vcx-primary" title="Preview the selection (Space)">
                <i data-lucide="play" class="w-3.5 h-3.5" id="vcx-play-ic"></i><span id="vcx-play-lbl">Preview</span>
              </button>
              <button type="button" id="vcx-snap" class="vcx-btn" title="Tighten the window to the speech inside it — trims silence off both ends">
                <i data-lucide="sparkles" class="w-3.5 h-3.5"></i>Snap to voice
              </button>
              <button type="button" id="vcx-dn" class="vcx-tog" aria-pressed="false" title="Clean hiss and the music bed off the capture — the wave, checks and preview all use the cleaned audio">
                <span class="vcx-tog-sw"></span>
                <span class="vcx-tog-tx"><b>Denoise</b><small id="vcx-dn-sub">movie noise stays in the clone</small></span>
              </button>
              <button type="button" id="vcx-ctr" class="vcx-tog" aria-pressed="false" hidden title="This movie has a 5.1 soundtrack — take the voice from the centre channel, where dialogue is mixed on its own">
                <span class="vcx-tog-sw"></span>
                <span class="vcx-tog-tx"><b>Dialogue only</b><small id="vcx-ctr-sub">5.1 centre channel</small></span>
              </button>
              <span class="vcx-zoom">
                <button type="button" id="vcx-prev" class="vcx-zbtn" title="Move the window 45 seconds earlier"><i data-lucide="chevrons-left" class="w-3.5 h-3.5"></i></button>
                <button type="button" id="vcx-zoom-out" class="vcx-zbtn" title="Show more time" aria-label="Zoom out"><i data-lucide="zoom-out" class="w-3.5 h-3.5"></i></button>
                <span id="vcx-zoom-lvl" class="vcx-zoom-lvl">60s</span>
                <button type="button" id="vcx-zoom-in" class="vcx-zbtn" title="Zoom in for finer edges" aria-label="Zoom in"><i data-lucide="zoom-in" class="w-3.5 h-3.5"></i></button>
                <button type="button" id="vcx-next" class="vcx-zbtn" title="Move the window 45 seconds later"><i data-lucide="chevrons-right" class="w-3.5 h-3.5"></i></button>
              </span>
            </div>

            <div id="vcx-gauge" class="vcx-gauge" data-zone="sweet">
              <span id="vcx-gnum" class="vcx-gnum">4.0<small>s</small></span>
              <div class="vcx-gbar"><span class="vcx-gsweet"></span><span id="vcx-gfill" class="vcx-gfill"></span></div>
              <span class="vcx-muted vcx-small">sweet spot ${SWEET_LO}–${SWEET_HI}s · max ${MAX_LEN.toFixed(1)}s</span>
            </div>

            <div id="vcx-checks" class="vcx-checks">
              <div id="vcx-ck-len" class="vcx-ck" data-ok="1"><span class="vcx-ck-dot"></span><div><b id="vcx-ck-len-t"></b><span id="vcx-ck-len-s"></span></div></div>
              <div id="vcx-ck-sil" class="vcx-ck" data-ok="1"><span class="vcx-ck-dot"></span><div><b id="vcx-ck-sil-t"></b><span id="vcx-ck-sil-s"></span></div></div>
              <div id="vcx-ck-lvl" class="vcx-ck" data-ok="1"><span class="vcx-ck-dot"></span><div><b id="vcx-ck-lvl-t"></b><span id="vcx-ck-lvl-s"></span></div></div>
            </div>

            <div id="vcx-eq" class="vcx-eq" data-on="0">
              <div class="vcx-eq-top">
                <button type="button" id="vcx-eq-on" class="vcx-tog" aria-pressed="false" title="Shape the tone of the capture — the preview and the saved voice both get this curve">
                  <span class="vcx-tog-sw"></span>
                  <span class="vcx-tog-tx"><b>Voice EQ</b><small id="vcx-eq-sub">the movie's own tone</small></span>
                </button>
                <div id="vcx-eq-presets" class="vcx-eq-presets" role="radiogroup" aria-label="EQ preset"></div>
              </div>
              <div id="vcx-eq-plot" class="vcx-eq-plot">
                <svg id="vcx-eq-svg" viewBox="0 0 600 88" preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <linearGradient id="vcx-eq-grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stop-color="#a78bfa" stop-opacity="0.35"></stop>
                      <stop offset="1" stop-color="#a78bfa" stop-opacity="0"></stop>
                    </linearGradient>
                  </defs>
                  <g id="vcx-eq-gridlines"></g>
                  <path id="vcx-eq-fill" d="" fill="url(#vcx-eq-grad)"></path>
                  <path id="vcx-eq-curve" d="" fill="none" stroke="#a78bfa" stroke-width="2" vector-effect="non-scaling-stroke"></path>
                </svg>
                <div id="vcx-eq-dots"></div>
                <div id="vcx-eq-tip" class="vcx-eq-tip hidden"></div>
              </div>
              <div class="vcx-eq-foot">
                <span id="vcx-eq-hint" class="vcx-muted vcx-small">Drag a dot up or down for gain, sideways for frequency · double-click to reset it</span>
                <button type="button" id="vcx-eq-reset" class="vcx-linkbtn" title="Back to flat">Reset</button>
              </div>
            </div>
          </div>

          <div class="vcx-right">
            <div class="vcx-sec-h"><span>The voice profile</span><span class="vcx-muted">builds live</span></div>
            <div class="vcx-card">
              <div class="vcx-name-row">
                <span id="vcx-pdot" class="vcx-pdot" title="Click to change the profile colour" role="button" tabindex="0"></span>
                <input id="vcx-pname" class="vcx-input font-khmer" value="" spellcheck="false" maxlength="60" aria-label="Profile name" />
              </div>
              <canvas id="vcx-pwave" class="vcx-pwave" height="30"></canvas>
              <div class="vcx-pmeta"><span id="vcx-pmeta-time"></span><span id="vcx-pmeta-dur"></span></div>
              <div id="vcx-gseg" class="vcx-gseg" data-value="Female" role="radiogroup" aria-label="Voice gender">
                <button type="button" data-gender="Female" role="radio" aria-checked="true"><span>♀</span><span>Female</span></button>
                <button type="button" data-gender="Male" role="radio" aria-checked="false"><span>♂</span><span>Male</span></button>
              </div>
            </div>

            <div class="vcx-card">
              <div class="vcx-sec-h vcx-sec-h-sm"><span>Voice group</span><span class="vcx-muted">which movie's cast</span></div>
              <div id="vcx-chips" class="vcx-chips"></div>
              <div id="vcx-newg-row" class="vcx-newg-row hidden">
                <input id="vcx-newg-name" class="vcx-input font-khmer" placeholder="New group name…" maxlength="40" />
                <button type="button" id="vcx-newg-ok" class="vcx-btn">Add</button>
              </div>
              <div id="vcx-roster" class="vcx-roster"></div>
              <div id="vcx-addex-row" class="vcx-addex-row hidden">
                <select id="vcx-addex" class="vcx-input font-khmer" aria-label="Voices not in this group"></select>
                <button type="button" id="vcx-addex-ok" class="vcx-btn" title="Put this existing voice into the group">Add</button>
              </div>
            </div>

            <button type="button" id="vcx-save" class="vcx-save">
              <i data-lucide="save" class="w-4 h-4"></i><span id="vcx-save-lbl">Save Voice Profile</span>
            </button>

            <div class="vcx-saved-wrap">
              <div class="vcx-sec-h vcx-sec-h-sm"><span>Saved this session</span><span id="vcx-saved-count" class="vcx-muted"></span></div>
              <div id="vcx-saved" class="vcx-saved custom-scrollbar"></div>
            </div>
          </div>
        </div>

        <div class="vcx-foot">
          <span class="vcx-muted flex items-center gap-1 shrink-0"><i data-lucide="folder-open" class="w-3.5 h-3.5"></i>Saving to</span>
          <span id="vcx-path" class="vcx-path" title=""><bdi></bdi></span>
          <button type="button" id="vcx-path-change" class="vcx-linkbtn" title="Choose the folder captures are written to">Change…</button>
          <button type="button" id="vcx-path-reset" class="vcx-linkbtn" title="Go back to the app's own VoiceCaptures folder">Use default</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    wire();
  }

  // ── open / close ───────────────────────────────────────────────────────
  function sourcePath(proj) {
    if (!proj) return "";
    return proj.videoFilePath || (proj.file && proj.file.path) || "";
  }

  async function open() {
    const data = loadVox();
    if (!data.enabled) return toast("Turn on VoxCPM2 AI in Settings first.", "warning");
    const proj = typeof projects !== "undefined" ? projects[activeProjectIndex] : null;
    const filePath = sourcePath(proj);
    if (!proj || !filePath) return toast("Open a video from your PC first — the voice is cut out of its audio.", "warning");

    build();
    const video = typeof mainVideo !== "undefined" ? mainVideo : $("main-video");
    if (video && !video.paused) video.pause();

    S.open = true;
    S.proj = proj;
    S.filePath = filePath;
    S.playhead = (video && video.currentTime) || 0;
    S.groupId = (typeof voxGroupOfProject === "function" && voxGroupOfProject(data, proj)?.id) || null;
    S.saved = [];
    S.nameTouched = false;
    S.color = nextColor(data);
    restoreEq();

    // A line under the playhead is the natural first pick.
    const line = lineAt(S.playhead);
    if (line) S.gender = genderOfLine(line) || S.gender;
    $("vcx-modal").classList.remove("hidden");
    icons($("vcx-modal"));
    renderAll();
    await loadWindow(S.playhead, line ? { a: line.start, b: line.end, snap: true } : { center: S.playhead, snap: true });
    refreshPath();
  }

  function close() {
    if (!S.open) return;
    stop();
    S.open = false;
    $("vcx-modal")?.classList.add("hidden");
    if (S.saved.length) {
      // New profiles may need the subtitle dropdowns refreshed once.
      if (typeof renderSubtitles === "function") renderSubtitles();
    }
  }

  // ── subtitle lines ─────────────────────────────────────────────────────
  function projectLines() {
    const subs = S.proj && typeof projects !== "undefined" && projects[activeProjectIndex] === S.proj && typeof subtitles !== "undefined" ? subtitles : S.proj?.subtitles || [];
    return (subs || [])
      .map((s) => ({ id: s.id, start: parseFloat(s.textStart), end: parseFloat(s.textEnd), text: s.originalText || s.text || "", speaker: s.speaker || s.character || s.gender || "", gender: s.gender }))
      .filter((l) => isFinite(l.start) && isFinite(l.end) && l.end > l.start);
  }

  function lineAt(t) {
    return projectLines().find((l) => t >= l.start - 0.05 && t <= l.end + 0.05) || null;
  }

  function genderOfLine(line) {
    const tag = String(line.gender || line.speaker || "");
    const data = loadVox();
    const prof = (data.profiles || []).find((p) => p.id === tag);
    if (prof) return (prof.gender || "").toLowerCase() === "male" ? "Male" : "Female";
    if (/female|woman|girl|ស្រី/i.test(tag)) return "Female";
    if (/male|man|boy|ប្រុស/i.test(tag)) return "Male";
    return null;
  }

  function renderLines() {
    const lines = projectLines();
    const tog = $("vcx-cl-toggle");
    if (tog) {
      tog.hidden = lines.length === 0;
      tog.setAttribute("aria-pressed", String(S.linesOpen));
    }
    const rail = $("vcx-cl");
    if (rail) rail.hidden = !S.linesOpen || lines.length === 0;
    $("vcx-grid")?.classList.toggle("with-lines", S.linesOpen && lines.length > 0);
    if (!S.linesOpen || !lines.length) return;
    $("vcx-cl-count").textContent = `${lines.length}`;
    const data = loadVox();
    const labelOf = (tag) => {
      const p = (data.profiles || []).find((x) => x.id === tag);
      return p ? p.label : tag || "—";
    };
    // Grouped by who speaks, so one actor's lines sit together.
    const byWho = new Map();
    lines.forEach((l) => {
      const k = labelOf(l.gender || l.speaker);
      if (!byWho.has(k)) byWho.set(k, []);
      byWho.get(k).push(l);
    });
    $("vcx-cl-list").innerHTML = [...byWho.entries()]
      .map(
        ([who, ls]) => `<div class="vcx-cl-grp"><div class="vcx-cl-who font-khmer">${esc(who)} <span class="vcx-muted">${ls.length}</span></div>${ls
          .map((l) => {
            const len = l.end - l.start;
            const ok = len >= SWEET_LO * 0.6;
            return `<button type="button" class="vcx-cl-line${ok ? "" : " is-short"}" data-s="${l.start}" data-e="${l.end}" title="${esc(l.text)}"><span class="vcx-cl-t">${fmt(l.start)}</span><span class="vcx-cl-x font-khmer">${esc(l.text)}</span><span class="vcx-cl-d">${len.toFixed(1)}s</span></button>`;
          })
          .join("")}</div>`,
      )
      .join("");
  }

  // ── window loading ─────────────────────────────────────────────────────
  // pick: { a, b } absolute times to select, or { center } to put a default
  // length around; snap: tighten to the speech once loaded.
  async function loadWindow(center, pick) {
    const seq = ++S.loadSeq;
    stop();
    S.loading = true;
    showLoading(true, "Reading the movie's audio…");
    try {
      const res = await fetch(`${API}/api/voice-capture/window`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: S.filePath, center, span: WINDOW_SPAN, denoise: S.denoise, center_only: S.center }),
      });
      const info = await res.json();
      if (!info.success) throw new Error(info.error || "Could not read the movie's audio.");
      const audioRes = await fetch(`${API}${info.url}`);
      if (!audioRes.ok) throw new Error(`Audio window HTTP ${audioRes.status}`);
      const buf = await ensureCtx().decodeAudioData(await audioRes.arrayBuffer());
      if (seq !== S.loadSeq) return;
      S.win = { start: info.start, duration: buf.duration, hasCenter: !!info.hasCenter, samples: buf.getChannelData(0), sr: buf.sampleRate, buffer: buf };
      S.movieDuration = info.movieDuration || S.movieDuration;
      if (!S.win.hasCenter) S.center = false;
      const ctr = $("vcx-ctr");
      if (ctr) ctr.hidden = !S.win.hasCenter;
      S.viewSpan = Math.min(S.viewSpan, S.win.duration) || S.win.duration;
      if (S.viewSpan > S.win.duration) S.viewSpan = S.win.duration;

      const w0 = S.win.start;
      const w1 = S.win.start + S.win.duration;
      if (pick && pick.a != null) {
        let a = clamp(pick.a, w0, w1);
        let b = clamp(pick.b, a + MIN_LEN, w1);
        if (b - a > MAX_LEN) b = a + MAX_LEN;
        S.sel = { a, b };
      } else if (pick && pick.keep) {
        S.sel = { a: clamp(S.sel.a, w0, w1 - MIN_LEN), b: clamp(S.sel.b, w0 + MIN_LEN, w1) };
      } else {
        const c = clamp(pick?.center ?? center, w0, w1);
        const a = clamp(c - DEFAULT_LEN / 2, w0, Math.max(w0, w1 - DEFAULT_LEN));
        S.sel = { a, b: Math.min(w1, a + DEFAULT_LEN) };
      }
      if (pick && pick.snap) snapToVoice(true);
      centerViewOnSel();
    } catch (e) {
      if (seq !== S.loadSeq) return;
      toast(e.message || "Could not read the movie's audio.", "error");
    } finally {
      if (seq === S.loadSeq) {
        S.loading = false;
        showLoading(false);
        renderAll();
      }
    }
  }

  function showLoading(on, text) {
    const l = $("vcx-loading");
    if (!l) return;
    l.classList.toggle("hidden", !on);
    if (text) $("vcx-loading-t").textContent = text;
    $("vcx-wavewrap")?.classList.toggle("is-loading", on);
  }

  // ── analysis ───────────────────────────────────────────────────────────
  const FRAME = 0.02;

  function frameDb(a, b) {
    // RMS in dBFS per 20 ms frame between absolute times a..b
    const w = S.win;
    if (!w) return [];
    const out = [];
    const n = Math.max(1, Math.round(FRAME * w.sr));
    let i0 = Math.max(0, Math.floor((a - w.start) * w.sr));
    const i1 = Math.min(w.samples.length, Math.floor((b - w.start) * w.sr));
    for (; i0 + n <= i1; i0 += n) {
      let sum = 0;
      for (let i = i0; i < i0 + n; i++) sum += w.samples[i] * w.samples[i];
      out.push(10 * Math.log10(sum / n + 1e-12));
    }
    return out;
  }

  function stats(a, b) {
    const w = S.win;
    if (!w) return null;
    const i0 = Math.max(0, Math.floor((a - w.start) * w.sr));
    const i1 = Math.min(w.samples.length, Math.floor((b - w.start) * w.sr));
    let peak = 0;
    let sum = 0;
    for (let i = i0; i < i1; i++) {
      const v = Math.abs(w.samples[i]);
      if (v > peak) peak = v;
      sum += v * v;
    }
    const n = Math.max(1, i1 - i0);
    const frames = frameDb(a, b);
    const loud = frames.length ? Math.max(...frames) : -100;
    // Movies rarely go silent: a gap is where only the music bed is left, well
    // under the loudest word.
    const gate = Math.max(-55, loud - 20);
    const quiet = frames.filter((d) => d < gate).length;
    return { peakDb: 20 * Math.log10(peak + 1e-12), rmsDb: 10 * Math.log10(sum / n + 1e-12), silence: frames.length ? quiet / frames.length : 1 };
  }

  // Trim silence off both ends of the selection (looking a little past each edge
  // so a word cut in half is pulled back in).
  function snapToVoice(silent) {
    const w = S.win;
    if (!w) return;
    const w0 = w.start;
    const w1 = w.start + w.duration;
    const look = 0.4;
    const a0 = clamp(S.sel.a - look, w0, w1);
    const b0 = clamp(S.sel.b + look, w0, w1);
    const frames = frameDb(a0, b0);
    if (frames.length < 5) return;
    const loud = Math.max(...frames);
    if (loud < -60) {
      if (!silent) toast("There is no speech in this selection.", "warning");
      return;
    }
    const gate = Math.max(-50, loud - 26);
    const hang = 3; // frames: a breath between words is not the end
    let first = frames.findIndex((d) => d >= gate);
    let last = frames.length - 1;
    while (last > 0 && frames[last] < gate) last--;
    if (first < 0 || last <= first) return;
    first = Math.max(0, first - hang);
    last = Math.min(frames.length - 1, last + hang);
    let a = a0 + first * FRAME;
    let b = a0 + (last + 1) * FRAME;
    if (b - a > MAX_LEN) {
      // Too long for a reference: keep the loudest MAX_LEN stretch.
      const win = Math.round(MAX_LEN / FRAME);
      let best = first;
      let bestSum = -Infinity;
      let acc = 0;
      for (let i = first; i <= last; i++) {
        acc += Math.pow(10, frames[i] / 10);
        if (i - first >= win) acc -= Math.pow(10, frames[i - win] / 10);
        if (i - first >= win - 1 && acc > bestSum) {
          bestSum = acc;
          best = i - win + 1;
        }
      }
      a = a0 + best * FRAME;
      b = a + MAX_LEN;
    }
    if (b - a < MIN_LEN) return;
    S.sel = { a: clamp(a, w0, w1), b: clamp(b, w0, w1) };
    if (!silent) {
      renderAll();
      toast(`Snapped to ${(S.sel.b - S.sel.a).toFixed(1)}s of speech.`, "success");
    }
  }

  // ── view geometry ──────────────────────────────────────────────────────
  function centerViewOnSel() {
    const w = S.win;
    if (!w) return;
    const mid = (S.sel.a + S.sel.b) / 2;
    S.viewStart = clamp(mid - S.viewSpan / 2, w.start, w.start + w.duration - S.viewSpan);
  }

  function ensureSelVisible() {
    const w = S.win;
    if (!w) return;
    if (S.sel.a < S.viewStart || S.sel.b > S.viewStart + S.viewSpan) centerViewOnSel();
    S.viewStart = clamp(S.viewStart, w.start, w.start + w.duration - S.viewSpan);
  }

  const tToX = (t, width) => ((t - S.viewStart) / S.viewSpan) * width;
  const xToT = (x, width) => S.viewStart + (x / width) * S.viewSpan;

  // ── drawing ────────────────────────────────────────────────────────────
  function sizeCanvas(c) {
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr));
    const H = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    return { W, H, dpr };
  }

  function drawWave(c, t0, t1, color, opts = {}) {
    const ctx = c.getContext("2d");
    const { W, H } = sizeCanvas(c);
    ctx.clearRect(0, 0, W, H);
    const w = S.win;
    if (!w) return;
    const mid = H / 2;
    const span = t1 - t0;
    const sel = opts.sel;
    for (let x = 0; x < W; x++) {
      const ta = t0 + (x / W) * span;
      const tb = t0 + ((x + 1) / W) * span;
      const i0 = Math.max(0, Math.floor((ta - w.start) * w.sr));
      const i1 = Math.min(w.samples.length, Math.max(i0 + 1, Math.floor((tb - w.start) * w.sr)));
      let mn = 0;
      let mx = 0;
      const step = Math.max(1, Math.floor((i1 - i0) / 64));
      for (let i = i0; i < i1; i += step) {
        const v = w.samples[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const inSel = sel && ta >= sel.a && tb <= sel.b + span / W;
      ctx.fillStyle = inSel ? opts.selColor || color : color;
      const y0 = mid - mx * mid * 0.95;
      const y1 = mid - mn * mid * 0.95;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function renderWave() {
    const w = S.win;
    const wrap = $("vcx-wavewrap");
    const cv = $("vcx-wave");
    if (!wrap || !cv) return;
    const muted = cssVar("--text-muted", "#777");
    if (w) drawWave(cv, S.viewStart, S.viewStart + S.viewSpan, muted, { sel: S.sel, selColor: "#a78bfa" });
    else cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);

    const width = wrap.clientWidth;
    const xa = clamp(tToX(S.sel.a, width), 0, width);
    const xb = clamp(tToX(S.sel.b, width), 0, width);
    const sel = $("vcx-sel");
    sel.style.left = `${xa}px`;
    sel.style.width = `${Math.max(2, xb - xa)}px`;
    sel.classList.toggle("hidden", !w || xb <= 0 || xa >= width);
    $("vcx-shade-l").style.width = `${xa}px`;
    $("vcx-shade-r").style.left = `${xb}px`;
    $("vcx-shade-r").style.width = `${Math.max(0, width - xb)}px`;
    $("vcx-dur").textContent = `${(S.sel.b - S.sel.a).toFixed(1)}s`;
    const phx = tToX(S.playhead, width);
    const ph = $("vcx-ph-line");
    ph.style.left = `${phx}px`;
    ph.classList.toggle("hidden", !w || phx < 0 || phx > width);

    // time ruler
    const spans = $("vcx-timerow")?.children || [];
    for (let i = 0; i < spans.length; i++) spans[i].textContent = w ? fmt(S.viewStart + (i / (spans.length - 1)) * S.viewSpan) : "";
    $("vcx-zoom-lvl").textContent = `${Math.round(S.viewSpan)}s`;
    $("vcx-zoom-in").disabled = !w || S.viewSpan <= ZOOMS[ZOOMS.length - 1];
    $("vcx-zoom-out").disabled = !w || S.viewSpan >= w.duration - 0.01;
    $("vcx-prev").disabled = !w || w.start <= 0.01;
    $("vcx-next").disabled = !w || (S.movieDuration && w.start + w.duration >= S.movieDuration - 0.01);

    // overview
    const ov = $("vcx-ovcanvas");
    if (ov && w) {
      drawWave(ov, w.start, w.start + w.duration, cssVar("--text-muted", "#777"), { sel: S.sel, selColor: "#a78bfa" });
      const ow = $("vcx-ov").clientWidth;
      const ox = (t) => ((t - w.start) / w.duration) * ow;
      const port = $("vcx-ovport");
      port.style.left = `${ox(S.viewStart)}px`;
      port.style.width = `${Math.max(4, ox(S.viewStart + S.viewSpan) - ox(S.viewStart))}px`;
      port.classList.toggle("hidden", S.viewSpan >= w.duration - 0.01);
      const os = $("vcx-ovsel");
      os.style.left = `${ox(S.sel.a)}px`;
      os.style.width = `${Math.max(2, ox(S.sel.b) - ox(S.sel.a))}px`;
      $("vcx-ph").style.left = `${ox(S.playhead)}px`;
    }
  }

  function renderGaugeAndChecks() {
    const len = S.sel.b - S.sel.a;
    const zone = len < SWEET_LO ? "short" : len > SWEET_HI ? "long" : "sweet";
    const g = $("vcx-gauge");
    g.dataset.zone = zone;
    $("vcx-gnum").innerHTML = `${len.toFixed(1)}<small>s</small>`;
    $("vcx-gfill").style.width = `${clamp((len / MAX_LEN) * 100, 0, 100)}%`;

    const set = (id, ok, t, s) => {
      $(id).dataset.ok = String(ok);
      $(`${id}-t`).textContent = t;
      $(`${id}-s`).textContent = s;
    };
    if (len < 2) set("vcx-ck-len", 0, "Too short", "Under 2 s the clone guesses — pick a whole sentence");
    else if (len < SWEET_LO) set("vcx-ck-len", 2, "A bit short", `${SWEET_LO}–${SWEET_HI} s gives the steadiest clone`);
    else set("vcx-ck-len", 1, "Good length", `${len.toFixed(1)} s of one speaker`);

    const st = S.win ? stats(S.sel.a, S.sel.b) : null;
    if (!st) {
      set("vcx-ck-sil", 2, "Silence", "—");
      set("vcx-ck-lvl", 2, "Level", "—");
      return;
    }
    const pct = Math.round(st.silence * 100);
    if (st.silence > 0.45) set("vcx-ck-sil", 0, "Mostly silence", `${pct}% is quiet — try Snap to voice`);
    else if (st.silence > 0.25) set("vcx-ck-sil", 2, "Some gaps", `${pct}% is quiet — Snap to voice can trim it`);
    else set("vcx-ck-sil", 1, "Little silence", `${pct}% quiet — mostly speech`);

    if (st.peakDb > -0.5) set("vcx-ck-lvl", 0, "Clipping", "The voice distorts here — pick a calmer line");
    else if (st.rmsDb < -38) set("vcx-ck-lvl", 0, "Very quiet", "Whispers or far away — the clone will be thin");
    else if (st.rmsDb < -30) set("vcx-ck-lvl", 2, "Quiet", "Usable; it is levelled when saved");
    else set("vcx-ck-lvl", 1, "Clean level", `peak ${st.peakDb.toFixed(1)} dB`);
  }

  function renderProfile() {
    const name = $("vcx-pname");
    if (!S.nameTouched) S.name = suggestName();
    if (name && document.activeElement !== name) name.value = S.name;
    $("vcx-pdot").style.background = S.color;
    $("vcx-pmeta-time").textContent = S.win ? `${fmt(S.sel.a)} → ${fmt(S.sel.b)}` : "";
    $("vcx-pmeta-dur").textContent = S.win ? `${(S.sel.b - S.sel.a).toFixed(1)}s` : "";
    const seg = $("vcx-gseg");
    seg.dataset.value = S.gender;
    seg.querySelectorAll("[data-gender]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.gender === S.gender)));
    const pw = $("vcx-pwave");
    if (pw && S.win) drawWave(pw, S.sel.a, S.sel.b, S.color);
  }

  function suggestName() {
    const data = loadVox();
    const group = (data.groups || []).find((g) => g.id === S.groupId);
    const base = group ? `${group.name} ${S.gender === "Male" ? "ប្រុស" : "ស្រី"}` : S.gender;
    const taken = new Set((data.profiles || []).map((p) => String(p.label || "").trim()));
    for (let i = 1; i < 999; i++) {
      const n = `${base} ${i}`;
      if (!taken.has(n)) return n;
    }
    return base;
  }

  function nextColor(data) {
    const used = new Set((data.profiles || []).map((p) => (p.color || "").toLowerCase()));
    return PROFILE_COLORS.find((c) => !used.has(c)) || PROFILE_COLORS[(data.profiles || []).length % PROFILE_COLORS.length];
  }

  function renderGroups() {
    const data = loadVox();
    const groups = data.groups || [];
    if (S.groupId && !groups.some((g) => g.id === S.groupId)) S.groupId = null;
    const chip = (id, name, color, active) =>
      `<button type="button" class="vcx-gchip${active ? " is-active" : ""}" data-gid="${esc(id)}">${color ? `<span class="vox-group-dot" style="background:${esc(color)}"></span>` : ""}<span class="font-khmer">${esc(name)}</span></button>`;
    $("vcx-chips").innerHTML =
      chip("", "No group", "", !S.groupId) +
      groups.map((g) => chip(g.id, g.name, g.color, g.id === S.groupId)).join("") +
      `<button type="button" class="vcx-gchip vcx-gchip-new" data-gid="__new"><i data-lucide="plus" class="w-3 h-3"></i><span>New</span></button>`;
    icons($("vcx-chips"));

    const roster = $("vcx-roster");
    const addRow = $("vcx-addex-row");
    const group = groups.find((g) => g.id === S.groupId);
    if (!group) {
      roster.innerHTML = `<div class="vcx-muted vcx-small">Saved voices will be in every tab's list. Pick a group to keep this movie's cast together.</div>`;
      addRow.classList.add("hidden");
      return;
    }
    const ids = new Set(group.profileIds || []);
    const members = (data.profiles || []).filter((p) => ids.has(p.id));
    const col = (g, sym, cls) => {
      const list = members.filter((p) => ((p.gender || "").toLowerCase() === "male") === (g === "Male"));
      return `<div class="vcx-rcol"><div class="vcx-rhead ${cls}">${sym} ${g} <span class="vcx-muted">${list.length}</span></div>${
        list.length ? list.map((p) => `<div class="vcx-rname font-khmer"><span class="vox-group-dot" style="background:${esc(p.color || "#6366f1")}"></span><span class="truncate">${esc(p.label)}</span></div>`).join("") : `<div class="vcx-muted vcx-small">none yet</div>`
      }</div>`;
    };
    roster.innerHTML = `<div class="vcx-rgrid">${col("Male", "♂", "text-blue-400")}${col("Female", "♀", "text-pink-400")}</div>`;
    const others = (data.profiles || []).filter((p) => !ids.has(p.id));
    addRow.classList.toggle("hidden", others.length === 0);
    $("vcx-addex").innerHTML = `<option value="">Add an existing voice…</option>` + others.map((p) => `<option value="${esc(p.id)}">${(p.gender || "").toLowerCase() === "male" ? "♂" : "♀"} ${esc(p.label)}</option>`).join("");
  }

  function renderSaved() {
    $("vcx-saved-count").textContent = S.saved.length ? String(S.saved.length) : "";
    $("vcx-saved").innerHTML = S.saved.length
      ? S.saved
          .map(
            (p) => `<div class="vcx-saved-row"><span class="vox-group-dot" style="background:${esc(p.color)}"></span><span class="${p.gender === "Male" ? "text-blue-400" : "text-pink-400"}">${p.gender === "Male" ? "♂" : "♀"}</span><span class="truncate flex-1 font-khmer">${esc(p.label)}</span><button type="button" class="vcx-zbtn" data-play-saved="${esc(p.id)}" title="Play the saved clip"><i data-lucide="play" class="w-3 h-3"></i></button></div>`,
          )
          .join("")
      : `<div class="vcx-muted vcx-small">Nothing yet — each save becomes a voice in Settings → VoxCPM2 AI.</div>`;
    icons($("vcx-saved"));
  }

  function renderToggles() {
    const set = (id, on) => $(id)?.setAttribute("aria-pressed", String(!!on));
    set("vcx-dn", S.denoise);
    set("vcx-ctr", S.center);
    set("vcx-eq-on", S.eqOn);
    $("vcx-dn-sub").textContent = S.denoise ? "hiss & music bed cleaned" : "movie noise stays in the clone";
    $("vcx-ctr-sub").textContent = S.center ? "centre channel only" : "5.1 centre channel";
    $("vcx-eq").dataset.on = S.eqOn ? "1" : "0";
    $("vcx-eq-sub").textContent = S.eqOn ? `${S.eqPreset === "Custom" ? "your curve" : S.eqPreset}` : "the movie's own tone";
  }

  function renderAll() {
    if (!S.open) return;
    ensureSelVisible();
    renderWave();
    renderGaugeAndChecks();
    renderProfile();
    renderGroups();
    renderSaved();
    renderToggles();
    renderEq();
    renderLines();
    const save = $("vcx-save");
    save.disabled = !S.win || S.loading || S.saving || S.sel.b - S.sel.a < MIN_LEN;
    $("vcx-save-lbl").textContent = S.saving ? "Saving…" : "Save Voice Profile";
  }

  // ── EQ ─────────────────────────────────────────────────────────────────
  const fToX = (f) => (Math.log(f / EQ_F_MIN) / Math.log(EQ_F_MAX / EQ_F_MIN)) * 600;
  const xToF = (x) => EQ_F_MIN * Math.pow(EQ_F_MAX / EQ_F_MIN, clamp(x, 0, 600) / 600);
  const gToY = (g) => 44 - (g / EQ_G_MAX) * 40;
  const yToG = (y) => clamp(((44 - y) / 40) * EQ_G_MAX, -EQ_G_MAX, EQ_G_MAX);

  function restoreEq() {
    try {
      const saved = JSON.parse(localStorage.getItem(EQ_KEY) || "null");
      if (saved && Array.isArray(saved.bands) && saved.bands.length === EQ_BANDS.length) {
        S.eq = EQ_BANDS.map((b, i) => ({ ...b, f: Number(saved.bands[i].f) || b.f, g: Number(saved.bands[i].g) || 0 }));
        S.eqOn = !!saved.on;
        S.eqPreset = saved.preset || "Custom";
        return;
      }
    } catch (e) { }
    S.eq = EQ_BANDS.map((b) => ({ ...b }));
    S.eqOn = false;
    S.eqPreset = "Flat";
  }

  function rememberEq() {
    try {
      localStorage.setItem(EQ_KEY, JSON.stringify({ on: S.eqOn, preset: S.eqPreset, bands: S.eq.map((b) => ({ f: b.f, g: b.g })) }));
    } catch (e) { }
  }

  function makeEqNodes(ctx) {
    return S.eq.map((b) => {
      const n = ctx.createBiquadFilter();
      n.type = b.type;
      n.frequency.value = b.f;
      n.gain.value = S.eqOn ? b.g : 0;
      n.Q.value = b.q;
      return n;
    });
  }

  function renderEq() {
    const pres = $("vcx-eq-presets");
    if (pres && !pres.childElementCount) {
      pres.innerHTML = Object.keys(EQ_PRESETS)
        .map((k) => `<button type="button" role="radio" data-preset="${esc(k)}">${esc(k)}</button>`)
        .join("");
    }
    pres?.querySelectorAll("[data-preset]").forEach((b) => b.setAttribute("aria-checked", String(S.eqOn && b.dataset.preset === S.eqPreset)));

    const grid = $("vcx-eq-gridlines");
    if (grid && !grid.childElementCount) {
      const lines = [];
      [100, 1000, 10000].forEach((f) => lines.push(`<line x1="${fToX(f)}" x2="${fToX(f)}" y1="0" y2="88" class="vcx-eq-gl"/>`));
      [-6, 0, 6].forEach((g) => lines.push(`<line x1="0" x2="600" y1="${gToY(g)}" y2="${gToY(g)}" class="vcx-eq-gl${g === 0 ? " is-zero" : ""}"/>`));
      grid.innerHTML = lines.join("");
    }

    // Curve from the same Biquad maths the preview uses.
    const ctx = ensureCtx();
    const nodes = makeEqNodes(ctx);
    const N = 160;
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = xToF((i / (N - 1)) * 600);
    const total = new Float32Array(N).fill(0);
    const mag = new Float32Array(N);
    const ph = new Float32Array(N);
    nodes.forEach((n) => {
      n.getFrequencyResponse(freqs, mag, ph);
      for (let i = 0; i < N; i++) total[i] += 20 * Math.log10(mag[i] + 1e-9);
    });
    let d = "";
    for (let i = 0; i < N; i++) d += `${i ? "L" : "M"}${((i / (N - 1)) * 600).toFixed(1)},${gToY(clamp(total[i], -EQ_G_MAX, EQ_G_MAX)).toFixed(1)}`;
    $("vcx-eq-curve").setAttribute("d", d);
    $("vcx-eq-fill").setAttribute("d", `${d}L600,88L0,88Z`);

    const dots = $("vcx-eq-dots");
    if (dots) {
      if (dots.childElementCount !== S.eq.length) {
        dots.innerHTML = S.eq.map((b, i) => `<span class="vcx-eq-dot" data-band="${i}" title="${esc(b.label)}"></span>`).join("");
      }
      S.eq.forEach((b, i) => {
        const el = dots.children[i];
        el.style.left = `${(fToX(b.f) / 600) * 100}%`;
        el.style.top = `${(gToY(b.g) / 88) * 100}%`;
      });
    }
    // live preview follows
    if (S.src && S.eqNodes) S.eqNodes.forEach((n, i) => {
      n.frequency.value = S.eq[i].f;
      n.gain.value = S.eqOn ? S.eq[i].g : 0;
    });
  }

  function applyPreset(name) {
    const gains = EQ_PRESETS[name];
    if (!gains) return;
    S.eqOn = true;
    S.eqPreset = name;
    S.eq = EQ_BANDS.map((b, i) => ({ ...b, g: gains[i] }));
    rememberEq();
    renderToggles();
    renderEq();
  }

  // ── preview playback ───────────────────────────────────────────────────
  function play() {
    if (!S.win) return;
    if (S.src) return stop();
    const ctx = ensureCtx();
    const src = ctx.createBufferSource();
    src.buffer = S.win.buffer;
    const nodes = makeEqNodes(ctx);
    let tail = src;
    nodes.forEach((n) => {
      tail.connect(n);
      tail = n;
    });
    tail.connect(ctx.destination);
    const off = S.sel.a - S.win.start;
    const dur = S.sel.b - S.sel.a;
    src.start(0, Math.max(0, off), Math.max(0.05, dur));
    S.src = src;
    S.eqNodes = nodes;
    S.playStartedAt = ctx.currentTime;
    S.playFrom = S.sel.a;
    S.playTo = S.sel.b;
    src.onended = () => {
      if (S.src === src) stop();
    };
    setPlayUI(true);
    const tick = () => {
      if (!S.src) return;
      const t = S.playFrom + (ctx.currentTime - S.playStartedAt);
      const wrap = $("vcx-wavewrap");
      const cur = $("vcx-cursor");
      if (wrap && cur) {
        cur.classList.remove("hidden");
        cur.style.left = `${tToX(t, wrap.clientWidth)}px`;
      }
      S.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function playFile(path) {
    stop();
    if (!window.electronAPI?.readFileAsBase64) return;
    window.electronAPI.readFileAsBase64(path).then((r) => {
      const b64 = typeof r === "string" ? r : r?.data || r?.base64;
      if (!b64) return;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      ensureCtx().decodeAudioData(bytes.buffer).then((buf) => {
        const src = S.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(S.ctx.destination);
        src.start();
        S.src = src;
        src.onended = () => S.src === src && stop();
        setPlayUI(true);
      });
    });
  }

  function stop() {
    if (S.src) {
      try { S.src.onended = null; S.src.stop(); } catch (e) { }
    }
    S.src = null;
    S.eqNodes = null;
    cancelAnimationFrame(S.raf);
    $("vcx-cursor")?.classList.add("hidden");
    setPlayUI(false);
  }

  function setPlayUI(on) {
    const ic = $("vcx-play-ic");
    const lbl = $("vcx-play-lbl");
    if (lbl) lbl.textContent = on ? "Stop" : "Preview";
    if (ic) {
      ic.setAttribute("data-lucide", on ? "square" : "play");
      icons($("vcx-play"));
    }
  }

  // ── save ───────────────────────────────────────────────────────────────
  async function save() {
    if (!S.win || S.saving) return;
    const label = ($("vcx-pname").value || "").trim() || suggestName();
    S.saving = true;
    renderAll();
    try {
      const data = loadVox();
      const res = await fetch(`${API}/api/voice-capture/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: S.filePath,
          start: S.sel.a,
          end: S.sel.b,
          denoise: S.denoise,
          center_only: S.center,
          eq: S.eqOn ? S.eq.map((b) => ({ type: b.type, f: b.f, g: b.g, q: b.q })) : [],
          name: label,
          outDir: data.captureDir || "",
        }),
      });
      const out = await res.json();
      if (!out.success) throw new Error(out.error || "The clip could not be saved.");

      const fresh = loadVox();
      const profile = {
        id: crypto.randomUUID().substring(0, 8),
        label,
        gender: S.gender,
        color: S.color,
        instruction: "",
        audioPath: out.filePath,
        audioName: out.fileName,
        createdAt: Date.now(),
        source: "capture",
        isNew: true,
      };
      fresh.profiles = [...(fresh.profiles || []), profile];
      const group = (fresh.groups || []).find((g) => g.id === S.groupId);
      if (group) group.profileIds = [...new Set([...(group.profileIds || []), profile.id])];
      // Quiet: the subtitle table refreshes once when the dialog closes.
      if (typeof voxCmp2Save === "function") voxCmp2Save(fresh, { quiet: true });
      if (S.eqOn) rememberEq();
      S.saved.unshift(profile);
      S.nameTouched = false;
      S.color = nextColor(fresh);
      toast(`Saved "${label}"${group ? ` to ${group.name}` : ""}.`, "success");
      if (typeof voxCmp2RenderProfiles === "function" && $("voxcmp2-profiles-list")) voxCmp2RenderProfiles(fresh.profiles);
    } catch (e) {
      toast(e.message || "The clip could not be saved.", "error");
    } finally {
      S.saving = false;
      renderAll();
    }
  }

  async function refreshPath() {
    const data = loadVox();
    let dir = data.captureDir || "";
    if (!dir) {
      try {
        const r = await fetch(`${API}/api/voice-capture/default-dir`);
        dir = (await r.json()).dir || "";
      } catch (e) { }
    }
    const el = $("vcx-path");
    if (el) {
      el.querySelector("bdi").textContent = dir;
      el.title = dir;
    }
    $("vcx-path-reset")?.classList.toggle("hidden", !data.captureDir);
  }

  // ── interaction ────────────────────────────────────────────────────────
  function wire() {
    $("vcx-close").addEventListener("click", close);
    $("vcx-modal").addEventListener("mousedown", (e) => {
      if (e.target.id === "vcx-modal") close();
    });
    document.addEventListener("keydown", (e) => {
      if (!S.open) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.code === "Space" && !typing) {
        e.preventDefault();
        e.stopPropagation();
        play();
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && document.activeElement === $("vcx-sel")) {
        e.preventDefault();
        const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 0.1);
        moveSel(S.sel.a + d);
      }
    }, true);

    $("vcx-play").addEventListener("click", play);
    $("vcx-snap").addEventListener("click", () => {
      stop();
      snapToVoice(false);
    });
    $("vcx-dn").addEventListener("click", () => {
      S.denoise = !S.denoise;
      renderToggles();
      loadWindow(S.win ? S.win.start + S.win.duration / 2 : S.playhead, { keep: true });
    });
    $("vcx-ctr").addEventListener("click", () => {
      S.center = !S.center;
      renderToggles();
      loadWindow(S.win ? S.win.start + S.win.duration / 2 : S.playhead, { keep: true });
    });
    $("vcx-zoom-in").addEventListener("click", () => zoom(1));
    $("vcx-zoom-out").addEventListener("click", () => zoom(-1));
    const shift = (dir) => {
      if (!S.win) return;
      const c = S.win.start + S.win.duration / 2 + dir * 45;
      loadWindow(c, { center: c });
    };
    $("vcx-prev").addEventListener("click", () => shift(-1));
    $("vcx-next").addEventListener("click", () => shift(1));
    $("vcx-cl-toggle").addEventListener("click", () => {
      S.linesOpen = !S.linesOpen;
      renderLines();
      requestAnimationFrame(renderWave);
    });
    $("vcx-cl-list").addEventListener("click", (e) => {
      const b = e.target.closest("[data-s]");
      if (!b) return;
      const a = parseFloat(b.dataset.s);
      const z = parseFloat(b.dataset.e);
      const line = lineAt((a + z) / 2);
      if (line) {
        const g = genderOfLine(line);
        if (g) S.gender = g;
      }
      const w = S.win;
      if (w && a >= w.start && z <= w.start + w.duration) {
        stop();
        S.sel = { a, b: Math.min(z, a + MAX_LEN) };
        snapToVoice(true);
        centerViewOnSel();
        renderAll();
        play();
      } else {
        loadWindow((a + z) / 2, { a, b: z, snap: true }).then(() => play());
      }
    });

    // wave drag
    const wrap = $("vcx-wavewrap");
    wrap.addEventListener("mousedown", (e) => {
      if (!S.win || e.button !== 0) return;
      e.preventDefault();
      stop();
      const rect = wrap.getBoundingClientRect();
      const W = rect.width;
      const t = xToT(e.clientX - rect.left, W);
      const h = e.target.closest("[data-h]")?.dataset.h;
      const inSel = e.target.closest("#vcx-sel");
      const startSel = { ...S.sel };
      let mode = h === "l" ? "l" : h === "r" ? "r" : inSel ? "move" : "new";
      let moved = false;
      const onMove = (ev) => {
        const tt = xToT(clamp(ev.clientX - rect.left, 0, W), W);
        const dt = tt - t;
        if (Math.abs(ev.clientX - e.clientX) > 3) moved = true;
        if (!moved) return;
        const w0 = S.win.start;
        const w1 = S.win.start + S.win.duration;
        if (mode === "move") {
          const len = startSel.b - startSel.a;
          const a = clamp(startSel.a + dt, w0, w1 - len);
          S.sel = { a, b: a + len };
        } else if (mode === "l") {
          S.sel.a = clamp(startSel.a + dt, Math.max(w0, startSel.b - MAX_LEN), startSel.b - MIN_LEN);
        } else if (mode === "r") {
          S.sel.b = clamp(startSel.b + dt, startSel.a + MIN_LEN, Math.min(w1, startSel.a + MAX_LEN));
        } else {
          const a = clamp(Math.min(t, tt), w0, w1);
          const b = clamp(Math.max(t, tt), w0, w1);
          if (b - a >= MIN_LEN) S.sel = { a: b - a > MAX_LEN ? (tt < t ? b - MAX_LEN : a) : a, b: b - a > MAX_LEN ? (tt < t ? b : a + MAX_LEN) : b };
        }
        renderWave();
        renderGaugeAndChecks();
        renderProfile();
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (!moved && mode === "new") {
          // click to jump: the selection keeps its length, centred on the click
          const len = S.sel.b - S.sel.a;
          moveSel(t - len / 2);
        }
        renderAll();
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
    wrap.addEventListener("wheel", (e) => {
      if (!S.win) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 1 : -1, xToT(e.clientX - rect.left, rect.width));
    }, { passive: false });
    wrap.addEventListener("dblclick", (e) => {
      if (e.target.closest("#vcx-sel")) play();
    });

    // overview drag
    const ov = $("vcx-ov");
    ov.addEventListener("mousedown", (e) => {
      if (!S.win || e.button !== 0) return;
      e.preventDefault();
      const rect = ov.getBoundingClientRect();
      const toT = (x) => S.win.start + (clamp(x - rect.left, 0, rect.width) / rect.width) * S.win.duration;
      const onPort = e.target.closest("#vcx-ovport");
      const t0 = toT(e.clientX);
      const v0 = S.viewStart;
      let moved = false;
      const onMove = (ev) => {
        moved = true;
        if (onPort) S.viewStart = clamp(v0 + (toT(ev.clientX) - t0), S.win.start, S.win.start + S.win.duration - S.viewSpan);
        else S.viewStart = clamp(toT(ev.clientX) - S.viewSpan / 2, S.win.start, S.win.start + S.win.duration - S.viewSpan);
        renderWave();
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (!moved && !onPort) {
          stop();
          const len = S.sel.b - S.sel.a;
          moveSel(t0 - len / 2);
          centerViewOnSel();
          renderAll();
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

    // profile
    $("vcx-pname").addEventListener("input", (e) => {
      S.name = e.target.value;
      S.nameTouched = !!e.target.value.trim();
    });
    $("vcx-pname").addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });
    const cycleColor = () => {
      const i = PROFILE_COLORS.indexOf(S.color);
      S.color = PROFILE_COLORS[(i + 1) % PROFILE_COLORS.length];
      renderProfile();
    };
    $("vcx-pdot").addEventListener("click", cycleColor);
    $("vcx-pdot").addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), cycleColor()));
    $("vcx-gseg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-gender]");
      if (!b) return;
      S.gender = b.dataset.gender;
      renderProfile();
    });

    // groups
    $("vcx-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-gid]");
      if (!b) return;
      if (b.dataset.gid === "__new") {
        $("vcx-newg-row").classList.remove("hidden");
        $("vcx-newg-name").focus();
        return;
      }
      S.groupId = b.dataset.gid || null;
      renderGroups();
      renderProfile();
    });
    const addGroup = () => {
      const name = $("vcx-newg-name").value.trim();
      if (!name || typeof voxGroupCreate !== "function") return;
      const data = loadVox();
      const g = voxGroupCreate(data, name);
      voxCmp2Save(data, { quiet: true });
      S.groupId = g.id;
      $("vcx-newg-name").value = "";
      $("vcx-newg-row").classList.add("hidden");
      // A group made here is meant for this movie: the tab starts using it.
      if (S.proj && !S.proj.voxGroupId) {
        S.proj.voxGroupId = g.id;
        document.dispatchEvent(new Event("vox-group-changed"));
      }
      renderGroups();
      renderProfile();
    };
    $("vcx-newg-ok").addEventListener("click", addGroup);
    $("vcx-newg-name").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addGroup();
      if (e.key === "Escape") {
        e.stopPropagation();
        $("vcx-newg-row").classList.add("hidden");
      }
    });
    $("vcx-addex-ok").addEventListener("click", () => {
      const pid = $("vcx-addex").value;
      if (!pid) return;
      const data = loadVox();
      const g = (data.groups || []).find((x) => x.id === S.groupId);
      if (!g) return;
      g.profileIds = [...new Set([...(g.profileIds || []), pid])];
      voxCmp2Save(data, { quiet: true });
      renderGroups();
    });

    $("vcx-save").addEventListener("click", save);
    $("vcx-saved").addEventListener("click", (e) => {
      const b = e.target.closest("[data-play-saved]");
      if (!b) return;
      const p = S.saved.find((x) => x.id === b.dataset.playSaved);
      if (p) playFile(p.audioPath);
    });

    // EQ
    $("vcx-eq-on").addEventListener("click", () => {
      S.eqOn = !S.eqOn;
      rememberEq();
      renderToggles();
      renderEq();
    });
    $("vcx-eq-presets").addEventListener("click", (e) => {
      const b = e.target.closest("[data-preset]");
      if (b) applyPreset(b.dataset.preset);
    });
    $("vcx-eq-reset").addEventListener("click", () => applyPreset("Flat"));
    const plot = $("vcx-eq-plot");
    const tip = $("vcx-eq-tip");
    plot.addEventListener("mousedown", (e) => {
      const dot = e.target.closest("[data-band]");
      if (!dot) return;
      e.preventDefault();
      const i = Number(dot.dataset.band);
      const rect = plot.getBoundingClientRect();
      S.eqOn = true;
      S.eqPreset = "Custom";
      renderToggles();
      const onMove = (ev) => {
        const x = ((ev.clientX - rect.left) / rect.width) * 600;
        const y = ((ev.clientY - rect.top) / rect.height) * 88;
        const band = S.eq[i];
        band.f = Math.round(clamp(xToF(x), EQ_F_MIN, EQ_F_MAX));
        band.g = Math.round(yToG(y) * 2) / 2;
        tip.classList.remove("hidden");
        tip.textContent = `${band.label} · ${band.f >= 1000 ? (band.f / 1000).toFixed(1) + " kHz" : band.f + " Hz"} · ${band.g > 0 ? "+" : ""}${band.g.toFixed(1)} dB`;
        tip.style.left = `${(fToX(band.f) / 600) * 100}%`;
        renderEq();
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        tip.classList.add("hidden");
        rememberEq();
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
    plot.addEventListener("dblclick", (e) => {
      const dot = e.target.closest("[data-band]");
      if (!dot) return;
      const i = Number(dot.dataset.band);
      S.eq[i] = { ...EQ_BANDS[i] };
      S.eqPreset = "Custom";
      rememberEq();
      renderToggles();
      renderEq();
    });

    // folder
    $("vcx-path-change").addEventListener("click", async () => {
      if (!window.electronAPI?.selectFolder) return toast("Folder picker only works in the desktop app.", "error");
      const r = await window.electronAPI.selectFolder({ title: "Folder for captured voices" });
      const dir = r && !r.canceled ? r.path || (r.filePaths && r.filePaths[0]) : "";
      if (!dir) return;
      const data = loadVox();
      data.captureDir = dir;
      voxCmp2Save(data, { quiet: true });
      refreshPath();
    });
    $("vcx-path-reset").addEventListener("click", () => {
      const data = loadVox();
      data.captureDir = "";
      voxCmp2Save(data, { quiet: true });
      refreshPath();
    });

    window.addEventListener("resize", () => S.open && renderWave());
  }

  function moveSel(a) {
    if (!S.win) return;
    const len = S.sel.b - S.sel.a;
    const w0 = S.win.start;
    const w1 = S.win.start + S.win.duration;
    a = clamp(a, w0, w1 - len);
    S.sel = { a, b: a + len };
    ensureSelVisible();
    renderAll();
  }

  function zoom(dir, around) {
    if (!S.win) return;
    const steps = ZOOMS.filter((z) => z <= S.win.duration + 0.01);
    if (!steps.length || steps[0] < S.win.duration - 0.01) steps.unshift(S.win.duration);
    let i = steps.findIndex((z) => Math.abs(z - S.viewSpan) < 0.5);
    if (i < 0) i = 0;
    i = clamp(i + dir, 0, steps.length - 1);
    const pivot = around ?? (S.sel.a + S.sel.b) / 2;
    const frac = (pivot - S.viewStart) / S.viewSpan;
    S.viewSpan = steps[i];
    S.viewStart = clamp(pivot - frac * S.viewSpan, S.win.start, S.win.start + S.win.duration - S.viewSpan);
    renderWave();
  }

  // ── entry point ────────────────────────────────────────────────────────
  window.openVoiceCapture = open;
  const btn = $("btn-voice-capture");
  if (btn) btn.addEventListener("click", open);
})();
