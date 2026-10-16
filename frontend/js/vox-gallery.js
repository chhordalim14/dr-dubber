// VoxCPM2 voice gallery (Settings → VoxCPM2 AI): the profiles as a searchable,
// filterable grid (or list) of small cards, and audio-first adding — every
// picked file becomes a profile, its name and gender read from the file name.
// Card ids (voxcmp2-play-btn-*, voxcpm2-audio-name-*) are the ones
// voxCmp2PlayAudio / voxCmp2BrowseAudio in studio-main.js update in place.
(function () {
  const VIEW_KEY = "voxGallery:view";
  const SORT_KEY = "voxGallery:sort";
  const AUDIO_EXTS = ["wav", "mp3", "m4a", "flac", "ogg"];
  const COLORS = ["#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#14b8a6", "#f97316", "#a855f7", "#6366f1"];
  const SORTS = [
    { id: "added", label: "Added", icon: "clock" },
    { id: "az", label: "A–Z", icon: "arrow-down-a-z" },
    { id: "gender", label: "♂/♀", icon: "users" },
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const isMale = (p) => (p.gender || "").toLowerCase() === "male";
  const get = (k, d) => {
    try { return localStorage.getItem(k) || d; } catch (e) { return d; }
  };
  const put = (k, v) => {
    try { localStorage.setItem(k, v); } catch (e) { }
  };

  const G = { q: "", filter: "all", view: get(VIEW_KEY, "grid"), sort: get(SORT_KEY, "added") };

  function sorted(list) {
    const out = list.slice();
    if (G.sort === "az") out.sort((a, b) => String(a.label || "").localeCompare(String(b.label || ""), undefined, { numeric: true }));
    else if (G.sort === "gender") out.sort((a, b) => Number(isMale(b)) - Number(isMale(a)) || String(a.label || "").localeCompare(String(b.label || ""), undefined, { numeric: true }));
    return out;
  }

  function groupBadges(data, p) {
    return (Array.isArray(data.groups) ? data.groups : [])
      .filter((g) => (g.profileIds || []).includes(p.id))
      .map((g) => `<span class="vg-badge" title="Voice group: ${esc(g.name)}"><span class="vox-group-dot" style="background:${esc(g.color)}"></span><span class="font-khmer">${esc(g.name)}</span></span>`)
      .join("");
  }

  function card(data, p) {
    const id = esc(p.id);
    const g = isMale(p) ? "Male" : "Female";
    return `
      <div class="vg-card${p.isNew ? " is-new" : ""}" data-vox-profile-id="${id}">
        <div class="vg-card-top">
          <input type="color" class="vg-color" value="${esc(p.color || "#6366f1")}" data-vox-field="color" title="Voice colour — used in dropdowns and A1 audio items" />
          <input type="text" class="vg-name font-khmer" value="${esc(p.label)}" data-vox-field="label" placeholder="Profile name" spellcheck="false" />
          <button type="button" class="vg-gtog" data-g="${g}" data-vox-action="gender" title="${g} — click to switch">${g === "Male" ? "♂" : "♀"}</button>
        </div>
        <textarea rows="1" class="vg-ins" data-vox-field="instruction" placeholder="Control instruction, e.g. calm, deep tone…">${esc(p.instruction)}</textarea>
        <div class="vg-badges">${groupBadges(data, p)}</div>
        <div class="vg-card-foot">
          <span class="vg-file" id="voxcpm2-audio-name-${id}" title="${esc(p.audioPath || "")}">${esc(p.audioName || "No audio yet")}</span>
          <button type="button" id="voxcmp2-play-btn-${id}" data-vox-action="play" class="vg-ib" ${p.audioPath ? "" : "disabled"} title="Preview the reference voice"><i data-lucide="circle-play" class="w-3.5 h-3.5"></i></button>
          <button type="button" data-vox-action="browse" class="vg-ib" title="Choose the reference audio"><i data-lucide="folder-open" class="w-3.5 h-3.5"></i></button>
          <button type="button" data-vox-action="delete" class="vg-ib vg-del" title="Delete this voice"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
        </div>
      </div>`;
  }

  function counts(profiles) {
    const set = (id, n) => {
      const el = $(id);
      if (el) el.textContent = String(n);
    };
    set("vg-cnt-all", profiles.length);
    set("vg-cnt-new", profiles.filter((p) => p.isNew).length);
    set("vg-cnt-m", profiles.filter(isMale).length);
    set("vg-cnt-f", profiles.filter((p) => !isMale(p)).length);
    set("voxcmp2-profile-count", profiles.length);
    const newBtn = document.querySelector('#vg-filter [data-g="new"]');
    if (newBtn) newBtn.hidden = !profiles.some((p) => p.isNew) && G.filter !== "new";
  }

  function syncTools() {
    document.querySelectorAll("#vg-filter [data-g]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.g === G.filter)));
    document.querySelectorAll("#vg-view [data-v]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === G.view)));
    const sortBtn = $("vg-sort");
    if (sortBtn) {
      const s = SORTS.find((x) => x.id === G.sort) || SORTS[0];
      sortBtn.dataset.sort = s.id;
      sortBtn.innerHTML = `<i data-lucide="${s.icon}" class="w-3.5 h-3.5"></i><span>${esc(s.label)}</span>`;
    }
  }

  function voxGalleryRender(profiles) {
    const container = $("voxcmp2-profiles-list");
    if (!container) return;
    const data = typeof voxCmp2Load === "function" ? voxCmp2Load() : { profiles: profiles || [] };
    profiles = profiles || data.profiles || [];
    counts(profiles);
    if (G.filter === "new" && !profiles.some((p) => p.isNew)) G.filter = "all";
    syncTools();

    const q = G.q.trim().toLowerCase();
    const shown = sorted(
      profiles.filter((p) => {
        if (G.filter === "new" && !p.isNew) return false;
        if (G.filter === "Male" && !isMale(p)) return false;
        if (G.filter === "Female" && isMale(p)) return false;
        if (q && !`${p.label || ""} ${p.audioName || ""} ${p.instruction || ""}`.toLowerCase().includes(q)) return false;
        return true;
      }),
    );
    container.classList.toggle("vg-as-list", G.view === "list");
    container.innerHTML = shown.map((p) => card(data, p)).join("");
    const empty = $("vg-empty");
    if (empty) {
      empty.classList.toggle("hidden", shown.length > 0);
      empty.innerHTML = profiles.length ? `<i data-lucide="search-x" class="w-5 h-5"></i><span>No voice matches.</span>` : `<i data-lucide="mic-2" class="w-5 h-5"></i><span>No voices yet — add audio files below, or capture one from the movie.</span>`;
    }
    if (typeof _lucideCreateIcons === "function") {
      _lucideCreateIcons({ root: container });
      if ($("vg-sort")) _lucideCreateIcons({ root: $("vg-sort") });
      if (empty) _lucideCreateIcons({ root: empty });
    }
  }
  window.voxGalleryRender = voxGalleryRender;

  function rerender() {
    if (typeof voxCmp2Load === "function") voxGalleryRender(voxCmp2Load().profiles);
  }

  // ── adding from files ──────────────────────────────────────────────────
  function guessGender(name) {
    const s = String(name || "");
    if (/ស្រី|female|woman|girl|lady|\bf\b|(^|[_\-\s])f([_\-\s.]|$)/i.test(s)) return "Female";
    if (/ប្រុស|male|\bman\b|\bboy\b|\bm\b|(^|[_\-\s])m([_\-\s.]|$)/i.test(s)) return "Male";
    return null;
  }

  function cleanName(fileName) {
    return (
      String(fileName || "")
        .replace(/\.[a-z0-9]{2,4}$/i, "")
        .replace(/[_]+/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim() || "Voice"
    );
  }

  function addFiles(files) {
    if (!files || !files.length || typeof voxCmp2Load !== "function") return;
    const data = voxCmp2Load();
    const used = new Set(data.profiles.map((p) => (p.color || "").toLowerCase()));
    const known = new Set(data.profiles.map((p) => (p.audioPath || "").toLowerCase()));
    let added = 0;
    let skipped = 0;
    files.forEach((f) => {
      if (!f.filePath || known.has(f.filePath.toLowerCase())) {
        skipped++;
        return;
      }
      known.add(f.filePath.toLowerCase());
      const color = COLORS.find((c) => !used.has(c)) || COLORS[(data.profiles.length + added) % COLORS.length];
      used.add(color);
      data.profiles.push({
        id: crypto.randomUUID().substring(0, 8),
        label: cleanName(f.fileName),
        gender: guessGender(f.fileName) || "Female",
        color,
        instruction: "",
        audioPath: f.filePath,
        audioName: f.fileName,
        createdAt: Date.now(),
        isNew: true,
      });
      added++;
    });
    // The blank starter profile is replaced by real voices once they arrive.
    if (added) {
      data.profiles = data.profiles.filter((p, i, arr) => !(arr.length > 1 && /^(male|female)-default$/.test(p.id) && !p.audioPath && !p.instruction));
      if (typeof voxGroupsPrune === "function") voxGroupsPrune(data);
    }
    voxCmp2Save(data);
    G.filter = added ? "new" : G.filter;
    rerender();
    if (typeof showToast === "function") {
      if (added) showToast(`Added ${added} voice${added === 1 ? "" : "s"}${skipped ? ` (${skipped} already in the list)` : ""}. Check the ♂/♀ of each.`, "success");
      else showToast("Those files are already voice profiles.", "info");
    }
  }

  async function pick(multi) {
    const api = window.electronAPI;
    if (!api?.openFile) {
      if (typeof showToast === "function") showToast("File picker only works in the desktop app.", "error");
      return;
    }
    const opts = {
      title: multi ? "Choose voice audio files" : "Choose a voice audio file",
      filters: [{ name: "Audio", extensions: AUDIO_EXTS }],
      defaultPath: get("lastPath:browseAudio", ""),
    };
    const r = multi && api.openMultiFile ? await api.openMultiFile(opts) : await api.openFile(opts);
    if (!r || r.canceled) return;
    if (r.dirPath) put("lastPath:browseAudio", r.dirPath);
    addFiles(r.files && r.files.length ? r.files : r.filePath ? [{ filePath: r.filePath, fileName: r.fileName }] : []);
  }

  window.voxCmp2AddSingle = () => pick(false);
  window.voxCmp2AddMultiple = () => pick(true);

  // ── wiring ─────────────────────────────────────────────────────────────
  function markSeen(id) {
    const data = voxCmp2Load();
    const p = data.profiles.find((x) => x.id === id);
    if (p && p.isNew) {
      delete p.isNew;
      voxCmp2Save(data, { quiet: true });
      const el = document.querySelector(`[data-vox-profile-id="${CSS.escape(id)}"]`);
      el?.classList.remove("is-new");
      counts(data.profiles);
    }
  }

  function wire() {
    const list = $("voxcmp2-profiles-list");
    if (!list) return;
    list.addEventListener("change", (e) => {
      const el = e.target.closest("[data-vox-field]");
      const card = e.target.closest("[data-vox-profile-id]");
      if (!el || !card) return;
      voxCmp2SaveField(card.dataset.voxProfileId, el.dataset.voxField, el.value);
    });
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-vox-action]");
      const card = e.target.closest("[data-vox-profile-id]");
      if (!btn || !card) return;
      const id = card.dataset.voxProfileId;
      const act = btn.dataset.voxAction;
      if (act === "play") {
        markSeen(id);
        voxCmp2PlayAudio(id);
      } else if (act === "browse") voxCmp2BrowseAudio(id);
      else if (act === "delete") voxCmp2DeleteProfile(id);
      else if (act === "gender") {
        const next = btn.dataset.g === "Male" ? "Female" : "Male";
        btn.dataset.g = next;
        btn.textContent = next === "Male" ? "♂" : "♀";
        btn.title = `${next} — click to switch`;
        voxCmp2SaveField(id, "gender", next);
      }
    });
    // Auto-grow the instruction box while typing.
    list.addEventListener("input", (e) => {
      if (e.target.classList.contains("vg-ins")) {
        e.target.style.height = "auto";
        e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`;
      }
    });

    $("vg-search")?.addEventListener("input", (e) => {
      G.q = e.target.value;
      rerender();
    });
    $("vg-filter")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-g]");
      if (!b) return;
      G.filter = b.dataset.g;
      rerender();
    });
    $("vg-view")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-v]");
      if (!b) return;
      G.view = b.dataset.v;
      put(VIEW_KEY, G.view);
      rerender();
    });
    $("vg-sort")?.addEventListener("click", () => {
      const i = SORTS.findIndex((s) => s.id === G.sort);
      G.sort = SORTS[(i + 1) % SORTS.length].id;
      put(SORT_KEY, G.sort);
      rerender();
    });
    $("vg-groups-btn")?.addEventListener("click", () => typeof window.voxGroupsOpenManager === "function" && window.voxGroupsOpenManager());
    // Group membership shows on the cards.
    document.addEventListener("voxcpm2-settings-changed", () => {
      const pane = $("settings-voxcmp2");
      if (pane && !pane.classList.contains("hidden") && !list.contains(document.activeElement)) rerender();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
