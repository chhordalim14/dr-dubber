// Timeline look: the fixed column of track names on the left, the Video track's
// frame thumbnails, the Original Audio track's waveform and the waveform drawn
// inside each dubbed clip. Purely visual - every track keeps its own clips,
// buttons and drag handles; this only moves each track's name tag into the
// column and paints canvases.
//
// studio-main.js calls TimelineVisuals.setSource() when a video's metadata
// loads and TimelineVisuals.paintClipWave() for each dubbed clip it renders.
(function () {
  "use strict";

  const API = "http://localhost:3001";
  const FRAME_COUNT_MAX = 60; // thumbnails pulled per video (tiles reuse the nearest one)
  const FRAME_STORE_PX = 128; // longest side of a stored thumbnail
  const CLIP_PEAKS = 160; // waveform points per dubbed clip
  const WAVE_BAR = 2;
  const WAVE_GAP = 1;

  const $ = (id) => document.getElementById(id);
  const dpr = () => window.devicePixelRatio || 1;

  let scroller, content, tracksEl, headsEl, headsList, mainVideo;

  // ── Track names column ────────────────────────────────────────────────────
  // Each track's name tag (the div holding .track-name and its buttons) is moved
  // into a row of #timeline-heads lined up with the track. Buttons keep their ids
  // and listeners; a track that re-renders (Music) brings a fresh tag, which
  // replaces the old row's contents.
  function syncHeads() {
    if (!tracksEl || !headsList) return;
    const alive = new Set();
    for (const track of tracksEl.children) {
      if (!track.id || !track.id.startsWith("track-")) continue;
      alive.add(track.id);
      let row = headsList.querySelector(`.tl-head[data-track="${track.id}"]`);
      const tag = [...track.children].find((c) => c.querySelector(":scope > .track-name"));
      if (tag) {
        if (!row) {
          row = document.createElement("div");
          row.className = "tl-head";
          row.dataset.track = track.id;
          headsList.appendChild(row);
        }
        row.replaceChildren(...tag.childNodes);
        tag.remove();
      }
      if (row) {
        row.style.top = `${track.offsetTop}px`;
        row.style.height = `${track.offsetHeight}px`;
        row.classList.toggle("is-hidden", track.offsetParent === null);
      }
    }
    for (const row of [...headsList.querySelectorAll(".tl-head")]) {
      if (!alive.has(row.dataset.track)) row.remove();
    }
    headsList.style.height = `${content.scrollHeight}px`;
    syncHeadsScroll();
  }

  function syncHeadsScroll() {
    if (headsList) headsList.style.transform = `translateY(${-scroller.scrollTop}px)`;
  }

  // ── Shared: the visible slice of a track ──────────────────────────────────
  // Canvases only cover what's on screen (zoom can make a track 75,000px wide,
  // past what a canvas can hold), so they're moved and redrawn as you scroll.
  function fitCanvasToView(track, canvas) {
    const laneW = track.clientWidth;
    const visL = Math.max(0, Math.min(laneW, scroller.scrollLeft - track.offsetLeft));
    const visW = Math.max(0, Math.min(laneW - visL, scroller.clientWidth));
    const h = canvas.clientHeight;
    canvas.style.left = `${visL}px`;
    canvas.style.width = `${visW}px`;
    const r = dpr();
    const pw = Math.round(visW * r);
    const ph = Math.round(h * r);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, visW, h);
    return { ctx, laneW, visL, visW, h };
  }

  // ── Source video ──────────────────────────────────────────────────────────
  let source = null; // { key, src, filePath, duration }
  let token = 0;

  const filmCache = new Map(); // src -> { frames: [], aspect }
  let film = null;
  const peaksCache = new Map(); // filePath -> { peaks, peaksPerSecond }
  let wave = null;

  function remember(map, key, value, max) {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  }

  function setSource({ videoSrc, filePath, duration, isAudioOnly } = {}) {
    const dur = Number(duration);
    if (!videoSrc || !(dur > 0) || !isFinite(dur)) return clear();
    const key = `${videoSrc}|${filePath || ""}|${dur}`;
    if (source && source.key === key) return;
    const my = ++token;
    source = { key, src: videoSrc, filePath: filePath || "", duration: dur };

    film = isAudioOnly ? null : filmCache.get(videoSrc) || null;
    if (!isAudioOnly) extractFrames(videoSrc, dur, my);
    wave = source.filePath ? peaksCache.get(source.filePath) || null : null;
    if (source.filePath && !wave) loadPeaks(source.filePath, my);
    document.getElementById("track-a0")?.classList.toggle("is-loading", !!source.filePath && !wave);
    repaint();
  }

  function clear() {
    token++;
    source = null;
    film = null;
    wave = null;
    document.getElementById("track-a0")?.classList.remove("is-loading");
    repaint();
  }

  // Thumbnails come from a second, hidden <video> seeking through the file, coarse
  // to fine (0, middle, quarters...), so the strip looks complete early.
  function bisectOrder(n) {
    const order = [];
    const seen = new Set();
    for (let step = n; step >= 1; step = Math.floor(step / 2)) {
      for (let i = 0; i < n; i += step) {
        if (!seen.has(i)) {
          seen.add(i);
          order.push(i);
        }
      }
      if (step === 1) break;
    }
    return order;
  }

  function waitFor(el, event, ms) {
    return new Promise((resolve) => {
      const done = (ok) => {
        clearTimeout(timer);
        el.removeEventListener(event, onOk);
        el.removeEventListener("error", onErr);
        resolve(ok);
      };
      const onOk = () => done(true);
      const onErr = () => done(false);
      const timer = setTimeout(() => done(false), ms);
      el.addEventListener(event, onOk);
      el.addEventListener("error", onErr);
    });
  }

  async function extractFrames(src, dur, my) {
    let entry = filmCache.get(src);
    const count = Math.max(1, Math.min(FRAME_COUNT_MAX, Math.ceil(dur / 2)));
    if (entry && entry.frames.length === count && entry.frames.every(Boolean)) {
      film = entry;
      repaint();
      return;
    }
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    v.src = src;
    try {
      if (!(await waitFor(v, "loadeddata", 20000)) || my !== token || !v.videoWidth) return;
      if (!entry || entry.frames.length !== count) {
        entry = { frames: new Array(count).fill(null), aspect: v.videoWidth / v.videoHeight };
      }
      remember(filmCache, src, entry, 8);
      if (my === token) film = entry;
      const scale = FRAME_STORE_PX / Math.max(v.videoWidth, v.videoHeight);
      const fw = Math.max(1, Math.round(v.videoWidth * scale));
      const fh = Math.max(1, Math.round(v.videoHeight * scale));
      for (const i of bisectOrder(count)) {
        if (my !== token) return;
        if (entry.frames[i]) continue;
        v.currentTime = Math.min(dur - 0.05, ((i + 0.5) * dur) / count);
        if (!(await waitFor(v, "seeked", 8000))) continue;
        if (my !== token) return;
        const c = document.createElement("canvas");
        c.width = fw;
        c.height = fh;
        c.getContext("2d").drawImage(v, 0, 0, fw, fh);
        entry.frames[i] = c;
        scheduleRepaint();
      }
    } catch (e) {
      console.warn("[Timeline] thumbnails skipped:", e.message);
    } finally {
      v.removeAttribute("src");
      v.load();
    }
  }

  async function loadPeaks(filePath, my) {
    try {
      const res = await fetch(`${API}/api/audio-peaks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath }),
      });
      const data = await res.json();
      if (!data.success || !Array.isArray(data.peaks)) throw new Error(data.error || "no peaks");
      const entry = { peaks: Uint8Array.from(data.peaks), peaksPerSecond: data.peaksPerSecond };
      remember(peaksCache, filePath, entry, 12);
      if (my !== token) return;
      wave = entry;
    } catch (e) {
      console.warn("[Timeline] original audio waveform skipped:", e.message);
    } finally {
      if (my === token) document.getElementById("track-a0")?.classList.remove("is-loading");
    }
    scheduleRepaint();
  }

  // ── Painting ──────────────────────────────────────────────────────────────
  function paintFilmstrip() {
    const track = $("track-v0");
    const canvas = $("v0-filmstrip");
    if (!track || !canvas || track.offsetParent === null) return;
    const { ctx, laneW, visL, visW, h } = fitCanvasToView(track, canvas);
    if (!source || !film || !visW || !h) return;
    const frames = film.frames;
    const n = frames.length;
    // Tiles are landscape even for a vertical drama: centre-cropped like an editor's strip.
    const tileAspect = Math.max(1.2, Math.min(16 / 9, film.aspect));
    const tileW = Math.max(12, h * tileAspect);
    const first = Math.floor(visL / tileW);
    const last = Math.ceil((visL + visW) / tileW);
    for (let t = first; t < last; t++) {
      const x = t * tileW - visL;
      const time = (((t + 0.5) * tileW) / laneW) * source.duration;
      let i = Math.max(0, Math.min(n - 1, Math.floor((time / source.duration) * n)));
      let frame = frames[i];
      for (let d = 1; !frame && d < n; d++) frame = frames[i - d] || frames[i + d];
      if (!frame) break;
      const fa = frame.width / frame.height;
      let sw = frame.width;
      let sh = frame.height;
      if (fa > tileAspect) sw = sh * tileAspect;
      else sh = sw / tileAspect;
      const w = Math.min(tileW, laneW - t * tileW);
      ctx.drawImage(frame, (frame.width - sw) / 2, (frame.height - sh) / 2, sw * (w / tileW), sh, x, 0, w, h);
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x + w - 1, 0, 1, h);
    }
  }

  function paintOriginalWave() {
    const track = $("track-a0");
    const canvas = $("a0-waveform-canvas");
    if (!track || !canvas || track.offsetParent === null) return;
    const { ctx, laneW, visL, visW, h } = fitCanvasToView(track, canvas);
    if (!source || !wave || !visW || !h) return;
    const { peaks, peaksPerSecond } = wave;
    const step = WAVE_BAR + WAVE_GAP;
    const secPerPx = source.duration / laneW;
    const mid = h / 2;
    const color = getComputedStyle(track).getPropertyValue("--wave").trim() || "#4f8cff";
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.95;
    // Bars sit on fixed lane positions, so scrolling doesn't make them shimmer.
    for (let lx = Math.floor(visL / step) * step; lx < visL + visW; lx += step) {
      const i0 = Math.floor(lx * secPerPx * peaksPerSecond);
      const i1 = Math.max(i0 + 1, Math.ceil((lx + step) * secPerPx * peaksPerSecond));
      let m = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
      const amp = Math.pow(m / 255, 0.7);
      const bh = Math.max(1, amp * (mid - 2));
      ctx.fillRect(lx - visL, mid - bh, WAVE_BAR, bh * 2);
    }
    ctx.globalAlpha = 1;
  }

  let rafId = 0;
  function scheduleRepaint() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      repaint();
    });
  }

  function repaint() {
    if (!scroller) return;
    try {
      paintFilmstrip();
      paintOriginalWave();
    } catch (e) {
      console.warn("[Timeline] paint failed:", e.message);
    }
  }

  // ── Dubbed clips ──────────────────────────────────────────────────────────
  // Each ready clip gets its own little canvas; peaks are decoded once per audio
  // URL (it changes when the line is regenerated), two at a time so playback's
  // own requests still get through.
  const clipPeaks = new Map(); // url -> Float32Array | Promise
  const clipQueue = [];
  let clipActive = 0;
  let decodeCtx = null;

  function decodeClip(url) {
    return new Promise((resolve) => {
      clipQueue.push({ url, resolve });
      pumpClipQueue();
    });
  }

  function pumpClipQueue() {
    while (clipActive < 2 && clipQueue.length) {
      const { url, resolve } = clipQueue.shift();
      clipActive++;
      (async () => {
        try {
          const buf = await (await fetch(url)).arrayBuffer();
          decodeCtx = decodeCtx || new OfflineAudioContext(1, 1, 8000);
          const audio = await decodeCtx.decodeAudioData(buf);
          const data = audio.getChannelData(0);
          const out = new Float32Array(CLIP_PEAKS);
          const per = data.length / CLIP_PEAKS;
          for (let p = 0; p < CLIP_PEAKS; p++) {
            let m = 0;
            const end = Math.min(data.length, Math.floor((p + 1) * per));
            for (let i = Math.floor(p * per); i < end; i++) {
              const v = data[i] < 0 ? -data[i] : data[i];
              if (v > m) m = v;
            }
            out[p] = m;
          }
          // Each clip is scaled to its own loudest point, so quiet voices still fill it.
          let top = 0;
          for (let p = 0; p < CLIP_PEAKS; p++) if (out[p] > top) top = out[p];
          if (top > 0.02) for (let p = 0; p < CLIP_PEAKS; p++) out[p] /= top;
          resolve(out);
        } catch (e) {
          resolve(null);
        } finally {
          clipActive--;
          pumpClipQueue();
        }
      })();
    }
  }

  function drawClipWave(canvas, peaks) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const r = dpr();
    const pw = Math.min(4096, Math.round(w * r));
    canvas.width = pw;
    canvas.height = Math.round(h * r);
    const ctx = canvas.getContext("2d");
    const sx = pw / w;
    ctx.setTransform(sx, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = canvas.dataset.waveColor || "#a855f7";
    const step = WAVE_BAR + WAVE_GAP;
    const mid = h / 2;
    for (let x = 0; x < w; x += step) {
      const i0 = Math.floor((x / w) * peaks.length);
      const i1 = Math.max(i0 + 1, Math.ceil(((x + step) / w) * peaks.length));
      let m = 0;
      for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
      const bh = Math.max(1, Math.min(1, Math.pow(m, 0.8)) * (mid - 3));
      ctx.fillRect(x, mid - bh, WAVE_BAR, bh * 2);
    }
  }

  const pendingClipDraws = new Set();
  let clipRaf = 0;
  function queueClipDraw(canvas) {
    pendingClipDraws.add(canvas);
    if (clipRaf) return;
    clipRaf = requestAnimationFrame(() => {
      clipRaf = 0;
      const list = [...pendingClipDraws];
      pendingClipDraws.clear();
      for (const c of list) {
        const peaks = clipPeaks.get(c.dataset.waveUrl);
        if (c.isConnected && peaks instanceof Float32Array) drawClipWave(c, peaks);
      }
    });
  }

  function paintClipWave(canvas, url) {
    if (!canvas || !url) return;
    canvas.dataset.waveUrl = url;
    const known = clipPeaks.get(url);
    if (known instanceof Float32Array) return queueClipDraw(canvas);
    if (known) return; // decoding; drawn when it lands
    const job = decodeClip(url).then((peaks) => {
      if (!peaks) return clipPeaks.delete(url);
      clipPeaks.set(url, peaks);
      if (clipPeaks.size > 3000) clipPeaks.delete(clipPeaks.keys().next().value);
      // Clips re-render often; draw whichever canvases show this audio now.
      document.querySelectorAll("canvas.a1-clip-wave").forEach((c) => {
        if (c.dataset.waveUrl === url) queueClipDraw(c);
      });
    });
    clipPeaks.set(url, job);
  }

  function redrawAllClipWaves() {
    document.querySelectorAll("#track-a1 canvas.a1-clip-wave").forEach(queueClipDraw);
  }

  // ── Original-audio mute button (same as the "Mute Original Video Audio" switch) ──
  function syncMuteA0() {
    const btn = $("btn-mute-a0");
    if (!btn || !mainVideo) return;
    const muted = mainVideo.muted;
    if (btn.dataset.muted === String(muted)) return;
    btn.dataset.muted = String(muted);
    btn.classList.toggle("is-off", muted);
    btn.innerHTML = `<i data-lucide="${muted ? "volume-x" : "volume-2"}" class="w-3.5 h-3.5"></i>`;
    if (window.lucide) window.lucide.createIcons({ root: btn });
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  function init() {
    scroller = $("timeline-scroll-container");
    content = $("timeline-content");
    tracksEl = $("timeline-tracks");
    headsEl = $("timeline-heads");
    headsList = $("timeline-heads-list");
    mainVideo = $("main-video");
    if (!scroller || !content || !tracksEl || !headsEl || !headsList) return;

    syncHeads();
    new MutationObserver(syncHeads).observe(tracksEl, { childList: true });
    const ro = new ResizeObserver(() => {
      syncHeads();
      scheduleRepaint();
    });
    ro.observe(tracksEl);
    ro.observe(scroller);
    // Track heights change by dragging their bottom edge.
    const watchTracks = () => [...tracksEl.children].forEach((t) => t.id && ro.observe(t));
    watchTracks();
    new MutationObserver(watchTracks).observe(tracksEl, { childList: true });

    // Zoom stretches #timeline-content: repaint the strips, and the clip waves once it settles.
    let zoomTimer = 0;
    new ResizeObserver(() => {
      scheduleRepaint();
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(redrawAllClipWaves, 160);
    }).observe(content);

    scroller.addEventListener("scroll", () => {
      syncHeadsScroll();
      scheduleRepaint();
    }, { passive: true });

    // The name column scrolls the tracks up and down.
    headsEl.addEventListener("wheel", (e) => {
      if (!e.deltaY) return;
      scroller.scrollTop += e.deltaY;
      e.preventDefault();
    }, { passive: false });

    if (mainVideo) {
      mainVideo.addEventListener("emptied", clear);
      mainVideo.addEventListener("volumechange", syncMuteA0);
      syncMuteA0();
    }
    $("btn-mute-a0")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      $("btn-mute-audio")?.click();
      syncMuteA0();
    });
  }

  window.TimelineVisuals = { setSource, clear, repaint: scheduleRepaint, paintClipWave, syncHeads };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
