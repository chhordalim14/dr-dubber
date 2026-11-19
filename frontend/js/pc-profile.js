// How much the window starts at once, from this PC (backend/lib/pc-profile.js decides; Settings >
// Performance can change it). pcLimit(name, fallback) gives the current limit, or the fallback
// (the number the app always used) until the server has answered.
(function () {
  "use strict";
  const API = "http://localhost:3001/api/performance";
  let profile = null;
  const listeners = [];

  function pcLimit(name, fallback) {
    const v = profile && profile.limits ? Number(profile.limits[name]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  function apply(p) {
    if (!p || !p.success || !p.limits) return null;
    profile = p;
    listeners.forEach((fn) => { try { fn(p); } catch (e) { } });
    return p;
  }

  async function load() {
    try {
      return apply(await (await fetch(API)).json());
    } catch (e) {
      return null;
    }
  }

  async function setMode(mode) {
    const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
    const p = await res.json();
    if (!p.success) throw new Error(p.error || "Could not save");
    return apply(p);
  }

  window.pcLimit = pcLimit;
  window.pcProfile = {
    load,
    setMode,
    get current() { return profile; },
    onChange(fn) { listeners.push(fn); if (profile) fn(profile); },
  };

  // Settings > General > Performance.
  const GROUP = { light: "Light", standard: "Standard", strong: "Strong" };
  function showInSettings(p) {
    const sel = document.getElementById("setting-performance");
    const detected = document.getElementById("performance-detected");
    const limits = document.getElementById("performance-limits");
    if (!sel || !p) return;
    sel.value = p.mode;
    const hw = p.hardware || {};
    // Rounded up: Windows reports a 16 GB laptop as ~15.4 GB usable, and people know it as 16.
    const ram = Math.ceil(Number(hw.ramGB) || 0);
    const group = GROUP[p.detectedTier] || p.detectedTier;
    if (detected) {
      detected.textContent = hw.gpu && hw.gpu.name
        ? `This PC: ${ram} GB of memory, ${hw.cores} CPU threads, ${hw.gpu.name}. Group: ${group}.`
        : `This PC: ${ram} GB of memory, ${hw.cores} CPU threads. Group: ${group}.`;
    }
    if (limits) {
      const l = p.limits;
      limits.textContent = `At once now: ${l.renders} export(s), ${l.isolateTabs} Isolate BGM tab(s), ${l.textDetect} subtitle search(es), ${l.transcribeTabs} Transcribe tab(s).`;
    }
  }

  function wireSettings() {
    const sel = document.getElementById("setting-performance");
    if (!sel || sel.dataset.wired) return;
    sel.dataset.wired = "1";
    // The new limits show at once; the note under them says it was saved (or why not).
    sel.addEventListener("change", async () => {
      const note = document.getElementById("performance-saved");
      try {
        await setMode(sel.value);
        if (note) note.textContent = "Saved. It applies to the next job.";
      } catch (e) {
        if (note) note.textContent = `Could not save: ${e.message}`;
        if (profile) sel.value = profile.mode;
      }
    });
    listeners.push(showInSettings);
    if (profile) showInSettings(profile);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireSettings);
  else wireSettings();
  load();
})();
