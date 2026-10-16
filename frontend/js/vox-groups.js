// VoxCPM2 Voice Groups: per-movie sets of voice profiles.
//
// A group only organises profiles (stored as ids in voxcmp2_settings.groups);
// nothing is deleted from Settings. Each project tab picks one group
// (projects[i].voxGroupId). Every voice dropdown, auto-assign and the plain
// Male/Female fallback at generation then use that group's voices, while a line
// already set to a specific profile keeps it.
//
// Loaded BEFORE studio-main.js: studio-main calls voxCmp2ScopedProfiles while it
// boots. Everything here that touches the page waits for DOMContentLoaded.

const VOX_GROUP_COLORS = ["#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#14b8a6", "#a855f7", "#f97316", "#64748b"];

function voxGroupsOf(data) {
  return Array.isArray(data?.groups) ? data.groups : [];
}

function voxActiveProject() {
  try {
    return typeof projects !== "undefined" ? projects[activeProjectIndex] || null : null;
  } catch (e) {
    return null;
  }
}

// The group a project uses, or null for "All voices" (also when its group was deleted).
function voxGroupOfProject(data, proj) {
  const id = proj?.voxGroupId;
  if (!id) return null;
  return voxGroupsOf(data).find((g) => g.id === id) || null;
}

// The profiles a project's lines may be voiced from. Falls back to every profile
// when the tab has no group, or its group holds no profile that still exists.
function voxCmp2ScopedProfiles(data, proj) {
  const all = Array.isArray(data?.profiles) ? data.profiles : [];
  const group = voxGroupOfProject(data, proj === undefined ? voxActiveProject() : proj);
  if (!group) return all;
  const ids = new Set(group.profileIds || []);
  const inGroup = all.filter((p) => ids.has(p.id));
  return inGroup.length ? inGroup : all;
}

function voxGroupNewId() {
  return "g" + (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).replace(/[^a-z0-9]/gi, "").slice(0, 10);
}

// Adds a group to `data` (not saved) and returns it.
function voxGroupCreate(data, name) {
  if (!Array.isArray(data.groups)) data.groups = [];
  const used = new Set(data.groups.map((g) => g.color));
  const color = VOX_GROUP_COLORS.find((c) => !used.has(c)) || VOX_GROUP_COLORS[data.groups.length % VOX_GROUP_COLORS.length];
  const group = { id: voxGroupNewId(), name: String(name || "").trim().slice(0, 40) || `Movie ${data.groups.length + 1}`, color, profileIds: [] };
  data.groups.push(group);
  return group;
}

// Drop ids of profiles that no longer exist (called when a profile is deleted).
function voxGroupsPrune(data) {
  const live = new Set((data.profiles || []).map((p) => p.id));
  voxGroupsOf(data).forEach((g) => {
    g.profileIds = (g.profileIds || []).filter((id) => live.has(id));
  });
}

function voxSetProjectGroup(groupId) {
  const proj = voxActiveProject();
  if (!proj) {
    if (typeof showToast === "function") showToast("Open a video first — the group is chosen per project tab.", "warning");
    return;
  }
  proj.voxGroupId = groupId || null;
  document.dispatchEvent(new Event("vox-group-changed"));
  if (typeof renderSubtitles === "function") renderSubtitles();
}

(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const load = () => (typeof voxCmp2Load === "function" ? voxCmp2Load() : { enabled: false, profiles: [], groups: [] });
  // Quiet saves while the manager is open; the subtitle table re-renders once on close.
  let managerDirty = false;
  const save = (data) => {
    managerDirty = true;
    if (typeof voxCmp2Save === "function") voxCmp2Save(data, { quiet: true });
  };
  const icons = (root) => typeof _lucideCreateIcons === "function" && _lucideCreateIcons({ root });
  const isMale = (p) => (p.gender || "").toLowerCase() === "male";

  // ── Toolbar chip ───────────────────────────────────────────────────────
  function closeChip() {
    $("vox-group-panel")?.classList.add("hidden");
    const ch = $("vox-group-chevron");
    if (ch) ch.style.transform = "";
  }

  function renderChip() {
    const data = load();
    const on = !!data.enabled;
    $("vox-tools-left")?.classList.toggle("hidden", !on);
    if (!on) return closeChip();

    const group = voxGroupOfProject(data, voxActiveProject());
    const label = $("vox-group-chip-label");
    const dot = $("vox-group-chip-dot");
    if (label) label.textContent = group ? group.name : "All voices";
    if (dot) {
      dot.style.background = group ? group.color : "transparent";
      dot.classList.toggle("hidden", !group);
    }
    $("vox-group-chip")?.classList.toggle("is-set", !!group);

    const list = $("vox-group-list");
    if (!list) return;
    const live = new Set((data.profiles || []).map((p) => p.id));
    const row = (id, name, color, count, active) => `
      <button type="button" class="vox-group-opt${active ? " is-active" : ""}" data-group="${esc(id)}">
        <span class="vox-group-dot" style="background:${esc(color)}"></span>
        <span class="truncate flex-1 text-left font-khmer">${esc(name)}</span>
        <span class="vox-group-n">${count}</span>
        ${active ? '<i data-lucide="check" class="w-3.5 h-3.5 shrink-0"></i>' : ""}
      </button>`;
    list.innerHTML =
      row("", "All voices", "var(--text-muted)", live.size, !group) +
      voxGroupsOf(data)
        .map((g) => row(g.id, g.name, g.color, (g.profileIds || []).filter((id) => live.has(id)).length, group?.id === g.id))
        .join("") +
      (voxGroupsOf(data).length ? "" : `<div class="vox-group-hint">No groups yet. Make one per movie so each tab only offers that movie's voices.</div>`);
    icons(list);
  }

  // ── Manager modal ──────────────────────────────────────────────────────
  let selectedGroupId = null;
  let detailFilter = "";
  let detailGender = "all";

  function openManager(groupId) {
    const modal = $("modal-vox-groups");
    if (!modal) return;
    closeChip();
    const data = load();
    selectedGroupId = groupId || voxGroupOfProject(data, voxActiveProject())?.id || voxGroupsOf(data)[0]?.id || null;
    detailFilter = "";
    detailGender = "all";
    modal.classList.remove("hidden");
    renderManager();
  }

  function closeManager() {
    const modal = $("modal-vox-groups");
    if (!modal || modal.classList.contains("hidden")) return;
    modal.classList.add("hidden");
    if (managerDirty) {
      managerDirty = false;
      if (typeof renderSubtitles === "function") renderSubtitles();
    }
  }

  function renderManager() {
    const data = load();
    const groups = voxGroupsOf(data);
    if (selectedGroupId && !groups.some((g) => g.id === selectedGroupId)) selectedGroupId = groups[0]?.id || null;
    const live = new Set((data.profiles || []).map((p) => p.id));

    const list = $("vgm-group-list");
    if (list) {
      list.innerHTML = groups.length
        ? groups
            .map((g) => {
              const n = (g.profileIds || []).filter((id) => live.has(id)).length;
              return `<button type="button" class="vgm-group${g.id === selectedGroupId ? " is-active" : ""}" data-group="${esc(g.id)}">
                <span class="vox-group-dot" style="background:${esc(g.color)}"></span>
                <span class="truncate flex-1 text-left font-khmer">${esc(g.name)}</span>
                <span class="vox-group-n">${n}</span>
              </button>`;
            })
            .join("")
        : `<div class="vox-group-hint">No groups yet.</div>`;
    }

    const detail = $("vgm-detail");
    if (!detail) return;
    const group = groups.find((g) => g.id === selectedGroupId);
    if (!group) {
      detail.innerHTML = `<div class="vgm-empty"><i data-lucide="clapperboard" class="w-6 h-6"></i><p>Make a group for each movie or series, then tick the voices of its cast.</p></div>`;
      icons(detail);
      return;
    }
    const members = new Set(group.profileIds || []);
    const q = detailFilter.trim().toLowerCase();
    const profiles = (data.profiles || []).filter(
      (p) => (detailGender === "all" || (detailGender === "Male") === isMale(p)) && (!q || String(p.label || "").toLowerCase().includes(q)),
    );
    const inCount = (data.profiles || []).filter((p) => members.has(p.id)).length;
    const usedBy = (typeof projects !== "undefined" ? projects : []).filter((p) => p.voxGroupId === group.id).length;
    const swatches = VOX_GROUP_COLORS.map(
      (c) => `<button type="button" class="vgm-swatch${c === group.color ? " is-active" : ""}" data-color="${c}" style="background:${c}" title="${c}"></button>`,
    ).join("");

    detail.innerHTML = `
      <div class="vgm-detail-head">
        <div class="flex items-center gap-2">
          <span class="vox-group-dot vgm-big-dot" style="background:${esc(group.color)}"></span>
          <input id="vgm-name" class="vgm-input font-khmer" value="${esc(group.name)}" maxlength="40" spellcheck="false" aria-label="Group name" />
          <button type="button" id="vgm-delete" class="vgm-icon-btn" title="Delete this group (its voices stay in Settings)"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
        </div>
        <div class="vgm-swatches">${swatches}</div>
        <div class="vgm-meta">${inCount} voice${inCount === 1 ? "" : "s"} in this group${usedBy ? ` · used by ${usedBy} open tab${usedBy === 1 ? "" : "s"}` : ""}</div>
        <div class="flex items-center gap-2">
          <label class="vgm-search"><i data-lucide="search" class="w-3.5 h-3.5"></i><input id="vgm-filter" type="search" placeholder="Filter voices…" value="${esc(detailFilter)}" autocomplete="off" spellcheck="false" /></label>
          <div class="vg-seg" id="vgm-gender">
            ${["all", "Male", "Female"].map((g) => `<button type="button" data-g="${g}" aria-pressed="${detailGender === g}">${g === "all" ? "All" : g === "Male" ? "♂" : "♀"}</button>`).join("")}
          </div>
          <button type="button" id="vgm-all" class="vgm-text-btn" title="Tick every voice shown">All</button>
          <button type="button" id="vgm-none" class="vgm-text-btn" title="Untick every voice shown">None</button>
        </div>
      </div>
      <div class="vgm-checklist custom-scrollbar">
        ${
          profiles.length
            ? profiles
                .map(
                  (p) => `<label class="vgm-check">
                    <input type="checkbox" data-pid="${esc(p.id)}" ${members.has(p.id) ? "checked" : ""} />
                    <span class="vox-group-dot" style="background:${esc(p.color || "#6366f1")}"></span>
                    <span class="${isMale(p) ? "text-blue-400" : "text-pink-400"} w-3 text-center shrink-0">${isMale(p) ? "♂" : "♀"}</span>
                    <span class="truncate flex-1 font-khmer">${esc(p.label || p.name || p.id)}</span>
                    ${p.audioPath ? "" : '<span class="vgm-warn" title="No reference audio yet">no audio</span>'}
                  </label>`,
                )
                .join("")
            : `<div class="vox-group-hint">No voices match.</div>`
        }
      </div>`;
    icons(detail);
  }

  function mutateGroup(fn) {
    const data = load();
    const group = voxGroupsOf(data).find((g) => g.id === selectedGroupId);
    if (!group) return;
    fn(group, data);
    save(data);
  }

  function wire() {
    // chip
    $("vox-group-chip")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const panel = $("vox-group-panel");
      if (!panel) return;
      const opening = panel.classList.contains("hidden");
      if (opening) renderChip();
      panel.classList.toggle("hidden", !opening);
      const ch = $("vox-group-chevron");
      if (ch) ch.style.transform = opening ? "rotate(180deg)" : "";
    });
    $("vox-group-list")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-group]");
      if (!btn) return;
      e.stopPropagation();
      voxSetProjectGroup(btn.getAttribute("data-group"));
      closeChip();
    });
    $("vox-group-manage")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openManager();
    });
    document.addEventListener("click", (e) => {
      const wrap = $("vox-group-wrap");
      if (wrap && !wrap.contains(e.target)) closeChip();
    });

    // manager
    const modal = $("modal-vox-groups");
    $("btn-close-vox-groups")?.addEventListener("click", closeManager);
    $("btn-done-vox-groups")?.addEventListener("click", closeManager);
    modal?.addEventListener("mousedown", (e) => {
      if (e.target === modal) closeManager();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal && !modal.classList.contains("hidden")) closeManager();
    });
    $("vgm-new-group")?.addEventListener("click", () => {
      const data = load();
      const g = voxGroupCreate(data);
      save(data);
      selectedGroupId = g.id;
      renderManager();
      const name = $("vgm-name");
      name?.focus();
      name?.select();
    });
    $("vgm-group-list")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-group]");
      if (!btn) return;
      selectedGroupId = btn.getAttribute("data-group");
      detailFilter = "";
      renderManager();
    });
    const detail = $("vgm-detail");
    detail?.addEventListener("change", (e) => {
      const cb = e.target.closest("input[type=checkbox][data-pid]");
      if (cb) {
        const pid = cb.getAttribute("data-pid");
        mutateGroup((g) => {
          const ids = new Set(g.profileIds || []);
          cb.checked ? ids.add(pid) : ids.delete(pid);
          g.profileIds = [...ids];
        });
        renderManager();
        return;
      }
      if (e.target.id === "vgm-name") {
        const v = e.target.value.trim().slice(0, 40);
        if (v) mutateGroup((g) => (g.name = v));
        renderManager();
      }
    });
    detail?.addEventListener("input", (e) => {
      if (e.target.id === "vgm-filter") {
        detailFilter = e.target.value;
        const pos = e.target.selectionStart;
        renderManager();
        const f = $("vgm-filter");
        if (f) {
          f.focus();
          try { f.setSelectionRange(pos, pos); } catch (_) { }
        }
      }
    });
    detail?.addEventListener("keydown", (e) => {
      if (e.target.id === "vgm-name" && e.key === "Enter") e.target.blur();
    });
    detail?.addEventListener("click", async (e) => {
      const sw = e.target.closest("[data-color]");
      if (sw) {
        mutateGroup((g) => (g.color = sw.getAttribute("data-color")));
        return renderManager();
      }
      const gb = e.target.closest("#vgm-gender [data-g]");
      if (gb) {
        detailGender = gb.getAttribute("data-g");
        return renderManager();
      }
      if (e.target.closest("#vgm-all") || e.target.closest("#vgm-none")) {
        const add = !!e.target.closest("#vgm-all");
        const shown = [...detail.querySelectorAll("input[data-pid]")].map((cb) => cb.getAttribute("data-pid"));
        mutateGroup((g) => {
          const ids = new Set(g.profileIds || []);
          shown.forEach((id) => (add ? ids.add(id) : ids.delete(id)));
          g.profileIds = [...ids];
        });
        return renderManager();
      }
      if (e.target.closest("#vgm-delete")) {
        const data = load();
        const g = voxGroupsOf(data).find((x) => x.id === selectedGroupId);
        if (!g) return;
        const ok = typeof customConfirm === "function" ? await customConfirm(`Delete the group "${g.name}"? Its voices stay in Settings.`, "Delete group") : confirm(`Delete the group "${g.name}"?`);
        if (!ok) return;
        data.groups = voxGroupsOf(data).filter((x) => x.id !== g.id);
        (typeof projects !== "undefined" ? projects : []).forEach((p) => {
          if (p.voxGroupId === g.id) p.voxGroupId = null;
        });
        save(data);
        selectedGroupId = data.groups[0]?.id || null;
        renderManager();
        document.dispatchEvent(new Event("vox-group-changed"));
      }
    });

    document.addEventListener("vox-group-changed", renderChip);
    document.addEventListener("voxcpm2-settings-changed", () => {
      renderChip();
      if (modal && !modal.classList.contains("hidden")) renderManager();
    });
    renderChip();
  }

  window.voxGroupsOpenManager = openManager;
  window.voxGroupsRefreshChip = renderChip;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
