// Clone Voices from Video (VoxCPM2): every speaker in the movie gets a voice cloned from
// the movie itself, and each line is voiced by its own speaker.
//
// As soon as a tab's lines land (autoAssignVoxProfiles calls voxSpeakers.soon, once the tab is
// done transcribing and the VoxCPM2 server is running), and again before a tab is voiced
// (generateStandardAudioForProject calls voxSpeakers.ensure), the
// lines no one has looked at yet are sent to /api/voice-capture/speakers: the VoxCPM2
// server groups them by voice (backend/python/voxcpm2_speakers.py) and the backend cuts a
// reference clip of each new speaker. Each speaker becomes a voice profile in the tab's
// voice group, one group per series folder, so episode 2 finds episode 1's speakers again
// by their voice prints (localStorage voxSpeakerPrints: profile id -> [print, ...], kept apart
// from voxcmp2_settings, which every render reads).
//
// A line remembers the speaker it was given (sub.voxSpeaker); a line whose voice was
// changed by hand since keeps that voice when speakers are found again. The Speakers window
// lists this tab's speakers: rename, set the gender, play their clips, or merge one into another.
// Each speaker has a calm clip and one per feeling they speak enough of, so an angry line is
// cloned from the actor's own angry voice (see FEELING_ICONS below).
(function () {
  const API = "http://localhost:3001";
  const PRINTS_KEY = "voxSpeakerPrints";
  const COLORS = ["#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#14b8a6", "#f97316", "#a855f7", "#6366f1"];
  // Folders the app makes inside a series folder (Dub Whole Series): the series is the one above.
  const APP_FOLDERS = /^dr dubber (joined|split)$/i;
  // A video lying loose in one of these is a movie of its own, not an episode of a series.
  const LOOSE_FOLDERS = /^(downloads?|desktop|documents|movies|videos|music|pictures|tmp|temp|[a-z]:)$/i;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const toast = (m, t) => typeof showToast === "function" && showToast(m, t);
  const icons = (root) => typeof _lucideCreateIcons === "function" && _lucideCreateIcons({ root });
  const load = () => (typeof voxCmp2Load === "function" ? voxCmp2Load() : { enabled: false, profiles: [], groups: [] });
  const save = (data) => typeof voxCmp2Save === "function" && voxCmp2Save(data, { quiet: true });
  const isOn = (data) => !!(data && data.enabled && data.cloneFromVideo);
  const speakable = (s) => /[\p{L}\p{N}]/u.test(s.text || "");
  const tabs = () => (typeof projects !== "undefined" ? projects : []);
  const activeTab = () => tabs()[typeof activeProjectIndex !== "undefined" ? activeProjectIndex : -1] || null;
  // The open tab's live list is the global `subtitles`; other tabs keep theirs on the project.
  const liveSubs = (proj) => (proj && proj === activeTab() && typeof subtitles !== "undefined" ? subtitles : proj?.subtitles || []);
  const sourcePath = (proj) => (proj && (proj.videoFilePath || (proj.file && proj.file.path))) || "";

  function prints() {
    try {
      return JSON.parse(localStorage.getItem(PRINTS_KEY) || "{}") || {};
    } catch (e) {
      return {};
    }
  }
  // Feelings: besides a calm main clip (audioPath, calmClip), a speaker keeps a clip of each
  // feeling they speak enough of (emotionClips.Angry = { path, name, seconds }), cut from their
  // own lines in that feeling. A line is cloned from the clip of its feeling (executeVoxCpm2Synthesis).
  const FEELING_ICONS = { Sad: "😢", Angry: "😠", Whisper: "🤫", Excited: "😄", Royal: "👑", Romantic: "💕", Fear: "😨" };
  // The clips a voice has, as the backend counts them ("Neutral" = a calm main clip).
  const clipsHave = (p) => [...(p.calmClip ? ["Neutral"] : []), ...Object.keys(p.emotionClips || {})];
  const toClips = (m) => Object.fromEntries(Object.entries(m || {}).map(([e, c]) => [e, { path: c.filePath, name: c.fileName, seconds: c.seconds }]));
  // Its main clip is still the one found for it (profiles from before autoClip: the backend's name).
  const ownClip = (p) => (p.autoClip ? p.audioPath === p.autoClip : / - S\d+( \(\d+\))?\.wav$/i.test(p.audioName || ""));

  // A profile's voice prints (several once another speaker was merged into it), each { model, e }:
  // the speaker server compares a print only with prints of the model that made it. A bare array
  // is a print from before the server said its model (CAM++).
  const printsOf = (pr, id) => (Array.isArray(pr[id]) ? pr[id] : [])
    .map((x) => (Array.isArray(x) ? { model: "campplus", e: x } : x))
    .filter((x) => x && Array.isArray(x.e) && x.e.length === 192);

  function savePrints(p) {
    try {
      localStorage.setItem(PRINTS_KEY, JSON.stringify(p));
    } catch (e) {
      console.warn("[Speakers] Could not keep the voice prints:", e.message);
    }
  }

  // { key, name } of the series a video belongs to: its folder, or the video alone when it
  // lies loose in Downloads and the like.
  function seriesOf(filePath) {
    const parts = String(filePath || "").split(/[\\/]+/);
    const file = parts.pop() || "";
    while (parts.length && APP_FOLDERS.test(parts[parts.length - 1])) parts.pop();
    const folder = parts[parts.length - 1] || "";
    const stem = file.replace(/\.[^.]+$/, "");
    if (!folder || LOOSE_FOLDERS.test(folder)) return { key: [...parts, file].join("/").toLowerCase(), name: stem || "Movie" };
    return { key: parts.join("/").toLowerCase(), name: folder };
  }

  // "Male"/"Female" for a line: heard by Transcribe (its character), or its voice's gender.
  function lineGender(s, data) {
    for (const v of [s.character, s.speaker, s.gender]) {
      const preset = v && window.CHARACTER_PRESETS && window.CHARACTER_PRESETS[String(v).trim()];
      if (preset) return preset.gender;
    }
    const p = (data.profiles || []).find((x) => x.id === s.gender);
    return p && /^(male|female)$/i.test(p.gender || "") ? p.gender : null;
  }

  // The tab's voice group; a tab without one joins (or starts) its series' group, and so do
  // the other open tabs of that series without a group.
  function groupFor(data, proj) {
    const own = typeof voxGroupOfProject === "function" ? voxGroupOfProject(data, proj) : null;
    if (own) return own;
    const series = seriesOf(sourcePath(proj));
    let group = (data.groups || []).find((g) => g.seriesKey === series.key);
    if (!group) {
      group = voxGroupCreate(data, series.name);
      group.seriesKey = series.key;
    }
    tabs().forEach((p) => {
      if (p === proj || (!p.voxGroupId && seriesOf(sourcePath(p)).key === series.key)) p.voxGroupId = group.id;
    });
    return group;
  }

  // Lines no one has given a speaker yet (a new transcript, lines added by Fix Missing).
  const pending = (proj) => liveSubs(proj).filter((s) => speakable(s) && s.voxSpeaker === undefined);

  const jobs = new Map(); // tab -> the search running for it

  // Called before a tab is voiced: finds the speakers of lines not looked at yet.
  // Resolves true when profiles or lines changed (the caller reloads the settings).
  async function ensure(proj) {
    if (!proj || !isOn(load())) return false;
    if (jobs.has(proj)) return jobs.get(proj).then((r) => !!r.ok);
    if (!pending(proj).length) return false;
    const r = await find(proj, { auto: true });
    return !!r.ok;
  }

  function find(proj, opts = {}) {
    if (jobs.has(proj)) return jobs.get(proj);
    const job = run(proj, opts)
      .catch((e) => {
        console.error("[Speakers]", e);
        toast(`Could not find the speakers: ${e.message}`, "error");
        return { ok: false, error: e.message };
      })
      .finally(() => {
        jobs.delete(proj);
        renderButton();
      });
    jobs.set(proj, job);
    renderButton();
    return job;
  }

  // ── found on their own as soon as lines land ───────────────────────────
  // autoAssignVoxProfiles calls soon() after every Transcribe, Import SRT and Fix Missing. The
  // search waits until the tab is done, runs one tab at a time, and stays quiet when the
  // VoxCPM2 server is not running: Generate asks for the speakers again before voicing.
  const waiting = new Map(); // tab -> timer
  let queued = Promise.resolve(); // one search at a time
  const busy = (p) => !!(p.isTranscribing || p.isBatchTranscribing || p.isFixingMissing);

  function soon(proj) {
    if (!proj || !isOn(load())) return;
    clearTimeout(waiting.get(proj));
    waiting.set(proj, setTimeout(() => {
      waiting.delete(proj);
      queued = queued.then(() => background(proj)).catch(() => {});
    }, 2000));
  }

  // Match Subtitles to Video moved the lines onto the video's own subtitles: their tighter times
  // give steadier voice prints (E60, 23 transcripts: its 2 actors found in 19 with Transcribe's
  // times, in all 23 with the matched ones), so a tab whose speakers were found is searched
  // again. Resolves once done (or skipped: speakers not found yet, server off, tab voicing).
  function refind(proj) {
    if (!proj || !isOn(load()) || !proj.voxSpeakersAt) return Promise.resolve();
    queued = queued.then(async () => {
      if (jobs.has(proj)) await jobs.get(proj);
      if (!tabs().includes(proj) || proj.isGeneratingAudio || busy(proj) || !sourcePath(proj)) return;
      if (await serverUp(load().serverUrl)) await find(proj, { auto: true, quiet: true });
    }).catch(() => {});
    return queued;
  }

  async function background(proj) {
    if (!tabs().includes(proj) || !isOn(load()) || jobs.has(proj) || proj.isGeneratingAudio) return;
    if (!sourcePath(proj) || !pending(proj).length) return;
    if (busy(proj)) return soon(proj); // still transcribing: once it is done
    if (!(await serverUp(load().serverUrl))) return;
    await find(proj, { auto: true, quiet: true });
  }

  // The server is running: any answer counts, model loaded, loading or failed (the speaker
  // search does not need the model).
  async function serverUp(url) {
    try {
      await fetch(String(url || "http://localhost:8808/").trim(), { signal: AbortSignal.timeout(3000) });
      return true;
    } catch (e) {
      return false;
    }
  }

  async function run(proj, { auto = false, quiet = false } = {}) {
    const filePath = sourcePath(proj);
    const tabName = (proj.tabTitle || proj.file?.name || proj.name || "this tab").replace(/\.[^/.]+$/, "");
    if (!filePath) {
      toast("Clone voices from the video needs the video opened from your PC.", "warning");
      return { ok: false };
    }
    let data = load();
    const lines = liveSubs(proj)
      .filter(speakable)
      .map((s) => ({ id: s.id, start: parseFloat(s.textStart), end: parseFloat(s.textEnd), gender: lineGender(s, data), emotion: s.emotion || "Neutral" }))
      .filter((l) => l.end > l.start);
    if (!lines.length) return { ok: false };

    let group = groupFor(data, proj);
    save(data); // the new group and the tabs that joined it
    const pr = prints();
    const inGroup = new Set(group.profileIds || []);
    // A voice merged into another keeps its print there, so it is not found as a new speaker.
    const known = (data.profiles || [])
      .filter((p) => inGroup.has(p.id) && p.source === "speakers" && p.audioPath)
      .flatMap((p) => printsOf(pr, p.id).map(({ model, e }) => ({ id: p.id, gender: p.gender, embedding: e, model, emotions: clipsHave(p) })));

    toast(`Finding who speaks in "${tabName}"…`, "info");
    const res = await fetch(`${API}/api/voice-capture/speakers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath,
        serverUrl: data.serverUrl,
        lines,
        known,
        outDir: data.captureDir || "",
        name: `${group.name} - ${tabName}`.slice(0, 80),
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (!out.success) {
      if (quiet) {
        console.warn("[Speakers] Will try again at Generate:", out.error);
        return { ok: false, error: out.error };
      }
      toast(`${out.error || "Could not find the speakers."}${auto ? " Voicing with the voices you picked instead." : ""}`, auto ? "warning" : "error");
      return { ok: false, error: out.error };
    }

    // The settings may have changed while the server listened.
    data = load();
    group = (data.groups || []).find((g) => g.id === group.id) || groupFor(data, proj);
    const pr2 = prints();
    const used = new Set((data.profiles || []).map((p) => p.color));
    let number = (data.profiles || []).filter((p) => (group.profileIds || []).includes(p.id) && p.source === "speakers").length;
    const profileOf = new Map(); // speaker key -> profile id
    let made = 0;
    const madeIds = [];
    let feelings = 0;
    const knownIds = new Set();
    for (const s of out.speakers || []) {
      const known = s.known && (data.profiles || []).find((p) => p.id === s.known);
      if (known) {
        // What this episode adds to a voice from an earlier one: a calm clip if it had none (and
        // its clip is still the one found for it, not one picked by hand), and new feelings.
        if (s.filePath && s.calm && !known.calmClip && ownClip(known)) {
          Object.assign(known, { audioPath: s.filePath, audioName: s.fileName, autoClip: s.filePath, calmClip: true });
        }
        const added = toClips(s.emotionClips);
        feelings += Object.keys(added).length;
        if (Object.keys(added).length) known.emotionClips = { ...added, ...(known.emotionClips || {}) };
        profileOf.set(s.key, known.id);
        knownIds.add(known.id);
        continue;
      }
      if (!s.filePath) continue;
      const color = COLORS.find((c) => !used.has(c)) || COLORS[(number + 1) % COLORS.length];
      used.add(color);
      const profile = {
        id: crypto.randomUUID().substring(0, 8),
        label: `Speaker ${++number}`,
        gender: s.gender === "Female" ? "Female" : "Male",
        color,
        instruction: "",
        audioPath: s.filePath,
        audioName: s.fileName,
        autoClip: s.filePath,
        calmClip: !!s.calm,
        emotionClips: toClips(s.emotionClips),
        createdAt: Date.now(),
        source: "speakers",
        isNew: true,
      };
      feelings += Object.keys(profile.emotionClips).length;
      data.profiles = [...(data.profiles || []), profile];
      group.profileIds = [...new Set([...(group.profileIds || []), profile.id])];
      if (Array.isArray(s.embedding)) pr2[profile.id] = [{ model: out.printModel || "campplus", e: s.embedding }];
      profileOf.set(s.key, profile.id);
      madeIds.push(profile.id);
      made++;
    }

    // Each line's speaker; a speaker with no clip (too little clear speech) borrows the voice of
    // the speaker of their gender with the most lines.
    const lineTo = new Map();
    const heard = new Map(); // line id -> the gender of the speaker found saying it (by their voice)
    const byGender = {};
    for (const s of out.speakers || []) {
      const pid = profileOf.get(s.key);
      if (pid && s.gender && !(s.gender in byGender)) byGender[s.gender] = pid;
    }
    for (const s of out.speakers || []) {
      const pid = profileOf.get(s.key) || byGender[s.gender] || byGender.Male || byGender.Female || null;
      (s.lines || []).forEach((id) => {
        lineTo.set(String(id), pid);
        if (/^(Male|Female)$/.test(s.gender || "")) heard.set(String(id), s.gender);
      });
    }

    const active = proj === activeTab();
    if (active && !auto && typeof saveStateToPast === "function") saveStateToPast();
    let changedVoiced = 0;
    const regendered = new Set();
    const apply = (list) => {
      list.forEach((s) => {
        if (!lineTo.has(String(s.id))) {
          // Looked at but too short or untimed to place: not asked about again next time.
          if (s.voxSpeaker === undefined && speakable(s)) s.voxSpeaker = null;
          return;
        }
        // Changed by hand since its speaker was found: the hand-picked voice stays.
        if (s.voxSpeaker && s.gender !== s.voxSpeaker) return;
        const pid = lineTo.get(String(s.id));
        if (pid && s.gender !== pid && (s.file || s.audioUrl) && list === liveSubs(proj)) changedVoiced++;
        if (pid) s.gender = pid;
        s.voxSpeaker = pid;
        // The Male/Female tag Transcribe gave the line is often wrong (E60: 6 of 21), and Translate
        // picks បង / អូន from it: the speaker's gender comes from their voice, so the tag follows.
        const g = heard.get(String(s.id));
        const tagged = window.CHARACTER_PRESETS?.[String(s.character || s.speaker || "").trim()]?.gender;
        if (g && tagged !== g) {
          s.speaker = g;
          s.character = g;
          regendered.add(String(s.id));
        }
      });
    };
    apply(liveSubs(proj));
    if (active && proj.subtitles && proj.subtitles !== liveSubs(proj)) apply(proj.subtitles);

    // A voice this tab's previous search made that no line of any open tab speaks with now
    // (one actor split in two by looser times) goes: searched again, its lines found their
    // actor's voice. Voices made by other tabs, or picked by hand on some line, stay.
    const spoken = new Set(tabs().flatMap((p) => [...liveSubs(p), ...(p.subtitles || [])]).map((s) => s.gender));
    const gone = new Set((proj.voxFoundIds || []).filter((id) => !spoken.has(id) && ![...profileOf.values()].includes(id)));
    if (gone.size) {
      data.profiles = (data.profiles || []).filter((p) => !gone.has(p.id));
      (data.groups || []).forEach((g) => { g.profileIds = (g.profileIds || []).filter((id) => !gone.has(id)); });
      gone.forEach((id) => delete pr2[id]);
    }
    proj.voxFoundIds = [...madeIds, ...(proj.voxFoundIds || []).filter((id) => !gone.has(id))];

    save(data);
    savePrints(pr2);
    proj.voxSpeakersAt = Date.now();
    if (active && typeof renderSubtitles === "function") renderSubtitles();
    document.dispatchEvent(new Event("vox-group-changed"));

    const total = new Set(profileOf.values()).size; // two found as one voice they were merged into count once
    const matched = knownIds.size;
    const bits = [];
    if (made) bits.push(`${made} new voice${made === 1 ? "" : "s"}`);
    if (matched) bits.push(`${matched} already in ${group.name}`);
    if (feelings) bits.push(`${feelings} feeling${feelings === 1 ? "" : "s"} cloned`);
    if (gone.size) bits.push(`${gone.size} extra voice${gone.size === 1 ? "" : "s"} from the last search removed`);
    toast(`Found ${total} speaker${total === 1 ? "" : "s"} in "${tabName}"${bits.length ? ` (${bits.join(", ")})` : ""}.${changedVoiced ? ` ${changedVoiced} voiced line(s) now have another voice: generate them again to hear it.` : ""}${regendered.size ? ` ${regendered.size} line(s) were tagged with the wrong gender and now follow their speaker: translate them again for the right បង / អូន.` : ""}`, "success");
    if (dlg.open && dlg.proj === proj) renderDialog();
    return { ok: true, speakers: total, made, matched };
  }

  // ── Speakers window ────────────────────────────────────────────────────
  const dlg = { open: false, proj: null, audio: null, playing: null };

  function build() {
    if ($("vsp-modal")) return;
    const el = document.createElement("div");
    el.id = "vsp-modal";
    el.className = "vgm-modal hidden";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "Speakers");
    el.innerHTML = `
      <div class="vgm-panel vsp-panel">
        <div class="vgm-head">
          <h2 class="flex items-center gap-2 text-sm font-bold text-[var(--text-bright)] min-w-0">
            <i data-lucide="users" class="w-4 h-4 text-violet-400 shrink-0"></i>
            <span>Speakers</span>
            <span id="vsp-sub" class="text-xs font-normal text-[var(--text-muted)] truncate"></span>
          </h2>
          <button id="vsp-close" type="button" class="vcx-x" title="Close (Esc)"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        <div id="vsp-list" class="vsp-list custom-scrollbar"></div>
        <div class="vgm-foot">
          <span>Each speaker's voice is cloned from the video. To change one line, pick its voice on the voice pill.</span>
          <div class="flex items-center gap-2 shrink-0">
            <button id="vsp-find" type="button" class="vg-btn"><i data-lucide="scan-search" class="w-3.5 h-3.5"></i><span>Find speakers again</span></button>
            <button id="vsp-done" type="button" class="vgm-done">Done</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("mousedown", (e) => {
      if (e.target === el) close();
    });
    $("vsp-close").addEventListener("click", close);
    $("vsp-done").addEventListener("click", close);
    $("vsp-find").addEventListener("click", () => dlg.proj && find(dlg.proj).then(renderDialog));
    $("vsp-list").addEventListener("click", onListClick);
    $("vsp-list").addEventListener("change", onListChange);
    document.addEventListener("keydown", (e) => {
      if (dlg.open && e.key === "Escape") close();
    });
  }

  async function open() {
    const proj = activeTab();
    const data = load();
    if (!data.enabled) return toast("Turn on VoxCPM2 AI in Settings first.", "warning");
    if (!proj || !sourcePath(proj)) return toast("Open a video from your PC first — the voices are cloned from its audio.", "warning");
    if (!liveSubs(proj).some(speakable)) return toast("Transcribe the video first: speakers are found line by line.", "warning");
    build();
    dlg.open = true;
    dlg.proj = proj;
    $("vsp-modal").classList.remove("hidden");
    renderDialog();
    if (!liveSubs(proj).some((s) => s.voxSpeaker !== undefined)) await find(proj);
  }

  function close() {
    if (!dlg.open) return;
    dlg.open = false;
    stopPlaying();
    $("vsp-modal")?.classList.add("hidden");
    if (typeof renderSubtitles === "function") renderSubtitles();
  }

  // This tab's speakers: the speaker voices its lines use, busiest first.
  function tabSpeakers(data, proj) {
    const count = new Map();
    liveSubs(proj).forEach((s) => {
      if (s.voxSpeaker && s.gender) count.set(s.gender, (count.get(s.gender) || 0) + 1);
    });
    return (data.profiles || [])
      .filter((p) => count.has(p.id))
      .map((p) => ({ p, n: count.get(p.id) }))
      .sort((a, b) => b.n - a.n);
  }

  function renderDialog() {
    if (!dlg.open) return;
    const data = load();
    const proj = dlg.proj;
    const group = typeof voxGroupOfProject === "function" ? voxGroupOfProject(data, proj) : null;
    const list = $("vsp-list");
    const rows = tabSpeakers(data, proj);
    const busy = jobs.has(proj);
    $("vsp-sub").textContent = group ? `· ${group.name}` : "";
    $("vsp-find").disabled = busy;
    if (busy) {
      list.innerHTML = `<div class="vgm-empty"><i data-lucide="loader" class="w-6 h-6 animate-spin"></i><p>Listening to every line to find who speaks it…</p></div>`;
    } else if (!rows.length) {
      list.innerHTML = `<div class="vgm-empty"><i data-lucide="users" class="w-6 h-6"></i><p>No speakers found yet. Click <b>Find speakers again</b>.</p></div>`;
    } else {
      list.innerHTML = rows
        .map(({ p, n }) => {
          const male = (p.gender || "").toLowerCase() !== "female";
          const others = rows.filter((r) => r.p.id !== p.id);
          const feels = Object.keys(FEELING_ICONS).filter((e) => p.emotionClips?.[e]?.path);
          return `<div class="vsp-row" data-pid="${esc(p.id)}">
            <span class="vox-group-dot vgm-big-dot" style="background:${esc(p.color || "#6366f1")}"></span>
            <input class="vgm-input font-khmer" data-act="label" value="${esc(p.label || "")}" maxlength="40" spellcheck="false" aria-label="Speaker name" />
            <div class="vg-seg" role="group" aria-label="Gender">
              <button type="button" data-act="gender" data-g="Male" aria-pressed="${male}" title="Male">♂</button>
              <button type="button" data-act="gender" data-g="Female" aria-pressed="${!male}" title="Female">♀</button>
            </div>
            <span class="vsp-n">${n} line${n === 1 ? "" : "s"}</span>
            <button type="button" class="vg-ib" data-act="play" ${p.audioPath ? "" : "disabled"} title="${p.calmClip ? "Play their calm voice, cloned from the video" : "Play the voice cloned from the video"}">
              <i data-lucide="${dlg.playing === p.id ? "square" : "circle-play"}" class="w-3.5 h-3.5"></i>
            </button>
            <div class="vsp-feels" role="group" aria-label="Feelings cloned from the video">${feels
              .map((e) => `<button type="button" class="vsp-feel${dlg.playing === `${p.id}|${e}` ? " is-playing" : ""}" data-act="play" data-emo="${esc(e)}" title="Play their ${esc(e.toLowerCase())} voice from the video: their ${esc(e.toLowerCase())} lines are cloned from it">${FEELING_ICONS[e] || "🎭"}</button>`)
              .join("")}</div>
            ${others.length ? `<select class="vsp-merge" data-act="merge" title="Same person as another speaker? Merge their lines into that speaker">
              <option value="">Merge into…</option>
              ${others.map((r) => `<option value="${esc(r.p.id)}">${esc(r.p.label || r.p.id)}</option>`).join("")}
            </select>` : ""}
          </div>`;
        })
        .join("");
    }
    icons($("vsp-modal"));
  }

  function mutateProfile(pid, fn) {
    const data = load();
    const p = (data.profiles || []).find((x) => x.id === pid);
    if (!p) return;
    fn(p);
    save(data);
  }

  function onListClick(e) {
    const btn = e.target.closest("[data-act]");
    const row = e.target.closest(".vsp-row");
    if (!btn || !row || btn.tagName === "SELECT" || btn.tagName === "INPUT") return;
    const pid = row.dataset.pid;
    if (btn.dataset.act === "gender") {
      mutateProfile(pid, (p) => (p.gender = btn.dataset.g));
      renderDialog();
    } else if (btn.dataset.act === "play") {
      play(pid, btn.dataset.emo || null);
    }
  }

  function onListChange(e) {
    const el = e.target;
    const row = el.closest(".vsp-row");
    if (!row) return;
    const pid = row.dataset.pid;
    if (el.dataset.act === "label") {
      const label = el.value.trim();
      if (label) mutateProfile(pid, (p) => (p.label = label));
    } else if (el.dataset.act === "merge" && el.value) {
      merge(pid, el.value);
    }
  }

  // One speaker was really two: their lines (in every open tab) go to the other, and the
  // merged voice is removed. Its clip stays on disk.
  function merge(fromId, intoId) {
    const data = load();
    const from = (data.profiles || []).find((p) => p.id === fromId);
    const into = (data.profiles || []).find((p) => p.id === intoId);
    if (!from || !into) return;
    if (dlg.proj === activeTab() && typeof saveStateToPast === "function") saveStateToPast();
    const move = (list) =>
      (list || []).forEach((s) => {
        if (s.gender === fromId) s.gender = intoId;
        if (s.voxSpeaker === fromId) s.voxSpeaker = intoId;
      });
    tabs().forEach((p) => move(p.subtitles));
    if (typeof subtitles !== "undefined") move(subtitles);
    // The same actor: feelings only the merged voice had, and its calm clip if this one has none.
    into.emotionClips = { ...(from.emotionClips || {}), ...(into.emotionClips || {}) };
    if (from.calmClip && !into.calmClip && ownClip(into)) {
      Object.assign(into, { audioPath: from.audioPath, audioName: from.audioName, autoClip: from.audioPath, calmClip: true });
    }
    data.profiles = data.profiles.filter((p) => p.id !== fromId);
    if (typeof voxGroupsPrune === "function") voxGroupsPrune(data);
    save(data);
    const pr = prints();
    pr[intoId] = [...printsOf(pr, intoId), ...printsOf(pr, fromId)];
    delete pr[fromId];
    savePrints(pr);
    toast(`Merged "${from.label}" into "${into.label}".`, "success");
    renderDialog();
  }

  function stopPlaying() {
    if (dlg.audio) {
      dlg.audio.pause();
      URL.revokeObjectURL(dlg.audio.src);
    }
    dlg.audio = null;
    dlg.playing = null;
  }

  // A speaker's main clip, or the clip of one feeling.
  async function play(pid, emotion = null) {
    const key = emotion ? `${pid}|${emotion}` : pid;
    const was = dlg.playing;
    stopPlaying();
    if (was === key) return renderDialog();
    const p = (load().profiles || []).find((x) => x.id === pid);
    const file = emotion ? p?.emotionClips?.[emotion]?.path : p?.audioPath;
    if (!file || !window.electronAPI?.readFileAsBase64) return;
    try {
      const r = await window.electronAPI.readFileAsBase64(file);
      if (!r?.success || !r.base64) throw new Error(r?.error || "The clip could not be read.");
      const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      const audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: r.mime || "audio/wav" })));
      audio.onended = () => {
        if (dlg.audio === audio) {
          stopPlaying();
          renderDialog();
        }
      };
      dlg.audio = audio;
      dlg.playing = key;
      renderDialog();
      await audio.play();
    } catch (e) {
      stopPlaying();
      renderDialog();
      toast(e.message || "The clip could not be played.", "error");
    }
  }

  // ── toolbar button + Settings switch ───────────────────────────────────
  function renderButton() {
    const btn = $("btn-vox-speakers");
    if (!btn) return;
    const proj = activeTab();
    btn.classList.toggle("is-busy", !!(proj && jobs.has(proj)));
  }

  function syncSwitch() {
    const btn = $("voxcmp2-clone-toggle");
    const knob = $("voxcmp2-clone-knob");
    if (!btn || !knob) return;
    const on = !!load().cloneFromVideo;
    btn.setAttribute("aria-checked", String(on));
    btn.classList.toggle("bg-violet-500", on);
    btn.classList.toggle("border-violet-600", on);
    btn.classList.toggle("bg-[var(--bg-hover)]", !on);
    btn.classList.toggle("border-[var(--border-light)]", !on);
    knob.style.transform = on ? "translateX(20px)" : "translateX(0)";
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("btn-vox-speakers")?.addEventListener("click", open);
    $("voxcmp2-clone-toggle")?.addEventListener("click", () => {
      const data = load();
      data.cloneFromVideo = !data.cloneFromVideo;
      save(data);
      syncSwitch();
      if (data.cloneFromVideo) {
        toast("Each speaker's voice will be cloned from the video before the lines are voiced.", "success");
        tabs().forEach(soon); // tabs already transcribed: find their speakers now
      }
    });
    syncSwitch();
  });
  document.addEventListener("voxcpm2-settings-changed", syncSwitch);

  window.voxSpeakers = { ensure, find, open, soon, refind, seriesOf };
})();
