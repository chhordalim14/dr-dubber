// Settings → VoxCPM2 AI → "Install VoxCPM2 on this PC": one click builds a folder with a
// private Python, PyTorch, VoxCPM2, the model and the app's server (main process:
// backend/lib/voxcpm-installer.js), then fills "VoxCPM2 Local Path" so Start Server works.
(function () {
  const DIR_KEY = "voxInstall:dir";
  const $ = (id) => document.getElementById(id);
  const api = () => window.electronAPI || {};
  const toast = (m, t) => typeof showToast === "function" && showToast(m, t);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const get = (k) => {
    try { return localStorage.getItem(k) || ""; } catch (e) { return ""; }
  };
  const put = (k, v) => {
    try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { }
  };

  let info = null;
  let installing = false;

  function setState(state) {
    const card = $("vox-install-card");
    if (card) card.dataset.state = state;
  }

  function fact(ok, text, title = "") {
    const cls = ok === true ? "is-ok" : ok === false ? "is-bad" : "is-warn";
    return `<span class="vox-fact ${cls}" title="${esc(title)}"><span class="vox-fact-dot"></span>${esc(text)}</span>`;
  }

  function render() {
    const btn = $("vox-install-btn");
    const label = $("vox-install-btn-label");
    const sub = $("vox-install-sub");
    const title = $("vox-install-title");
    const facts = $("vox-install-facts");
    if (!btn || !info) return;
    $("vox-install-dir").textContent = info.dir;
    $("vox-install-dir").title = info.dir;
    $("vox-install-dir-change").disabled = installing;

    const py = info.python || {};
    const gpu = info.gpu;
    const lowDisk = info.freeGB != null && info.freeGB < info.needGB;
    facts.innerHTML = [
      py.cmd ? fact(true, `Python ${py.version}`) : fact(false, py.version ? `Python ${py.version} — needs 3.10–3.12` : "No Python 3.10–3.12"),
      info.device === "cuda"
        ? fact(true, `GPU: ${gpu.name}`, "VoxCPM2 runs on your NVIDIA card — about a second per line")
        : fact(null, gpu ? `${gpu.name}: under 6 GB — CPU mode` : "No NVIDIA GPU — CPU mode (slow)", "Without an NVIDIA graphics card (6 GB or more) VoxCPM2 runs on the processor: about 30 seconds per second of speech, so a 3-second line takes 1–2 minutes"),
      fact(true, `~${info.downloadGB} GB download`),
      info.freeGB != null ? fact(!lowDisk, `${info.freeGB.toFixed(0)} GB free`, `Needs about ${info.needGB} GB`) : "",
    ].join("");

    $("vox-install-python").classList.toggle("hidden", !!py.cmd || installing);
    if (!py.cmd) $("vox-install-python-t").textContent = py.version ? `Python ${py.version} is installed, but VoxCPM2 needs Python 3.10, 3.11 or 3.12. Install 3.11 (tick "Add python.exe to PATH"), then come back.` : `VoxCPM2 needs Python 3.10, 3.11 or 3.12. Install 3.11 (tick "Add python.exe to PATH"), then come back.`;

    $("vox-install-cancel").classList.toggle("hidden", !installing);
    btn.classList.toggle("hidden", installing);
    if (installing) {
      setState("installing");
      title.textContent = "Installing VoxCPM2…";
      sub.textContent = "You can keep working. Closing the app stops the install; clicking Install again carries on where it stopped.";
      return;
    }
    if (info.installed) {
      setState("installed");
      title.textContent = "VoxCPM2 is installed";
      const m = info.marker || {};
      sub.textContent = `${m.device === "cuda" ? "GPU" : "CPU"} build · Python ${m.python || "?"} · ${m.installedAt ? new Date(m.installedAt).toLocaleDateString() : ""} — Start Server below to use it.`;
      label.textContent = "Repair / update";
      btn.classList.remove("vg-primary");
    } else {
      setState(py.cmd ? "ready" : "blocked");
      title.textContent = "Install VoxCPM2 on this PC";
      sub.textContent = py.cmd
        ? "One click: a private Python, PyTorch, VoxCPM2 and the voice model, set up for Start Server. Nothing else on your PC is changed."
        : "Install Python first (button below), then click Check again.";
      label.textContent = py.cmd ? "Install VoxCPM2" : "Check again";
      btn.classList.add("vg-primary");
    }
    btn.disabled = lowDisk && !!py.cmd && !info.installed;
  }

  async function refresh() {
    if (!api().voxInstallInfo || installing) return;
    const res = await api().voxInstallInfo({ dir: get(DIR_KEY) });
    if (!res || !res.success) return;
    info = res;
    if (res.running && !installing) {
      // An install started earlier is still running in the main process.
      installing = true;
      $("vox-install-progress").classList.remove("hidden");
    }
    render();
    if (typeof _lucideCreateIcons === "function") _lucideCreateIcons({ root: $("vox-install-card") });
  }

  function onProgress(d) {
    if (!d) return;
    const box = $("vox-install-progress");
    box.classList.remove("hidden");
    if (typeof d.pct === "number") {
      $("vox-install-fill").style.width = `${d.pct.toFixed(1)}%`;
      $("vox-install-pct").textContent = `${Math.floor(d.pct)}%`;
    }
    if (d.label) $("vox-install-label").textContent = d.label;
    if (d.line) {
      $("vox-install-line").textContent = d.line;
      // The full log goes to the server log box too, for when something fails.
      if (typeof voxCmp2LogAppend === "function") voxCmp2LogAppend({ type: "stdout", text: `[install] ${d.line}` });
    }
  }

  async function install() {
    if (!api().voxInstall) return toast("Installing only works in the desktop app.", "error");
    if (!info?.python?.cmd) return refresh();
    if (typeof voxCmp2Load === "function" && voxCmp2Load().enabled !== true) {
      return toast("Turn on VoxCPM2 AI first (the switch at the top).", "warning");
    }
    installing = true;
    render();
    onProgress({ pct: 0, label: "Starting…", line: "" });
    const res = await api().voxInstall({ dir: info.dir });
    installing = false;
    if (res && res.success) {
      // Point Start Server at the new folder.
      if (typeof voxCmp2Load === "function") {
        const data = voxCmp2Load();
        data.pythonPath = res.dir;
        data.serverUrl = data.serverUrl || "http://localhost:8808/";
        voxCmp2Save(data, { quiet: true });
      }
      const input = $("voxcmp2-output-path");
      if (input) input.value = res.dir;
      toast(`VoxCPM2 is installed (${res.device === "cuda" ? "GPU" : "CPU"} build). Click Start Server to load it.`, "success");
      $("voxcpm2-server-toggle-btn")?.classList.add("vox-install-nudge");
      setTimeout(() => $("voxcpm2-server-toggle-btn")?.classList.remove("vox-install-nudge"), 6000);
    } else if (res && res.cancelled) {
      toast("Install stopped. Click Install again to carry on.", "info");
    } else {
      toast(res?.error || "VoxCPM2 could not be installed.", "error");
      if (res?.error) $("vox-install-line").textContent = res.error;
    }
    await refresh();
  }

  async function changeDir() {
    if (!api().selectFolder) return;
    const r = await api().selectFolder({ title: "Folder to install VoxCPM2 in (needs about 12 GB)" });
    const dir = r && !r.canceled ? r.path || (r.filePaths && r.filePaths[0]) : "";
    if (!dir) return;
    // A folder named for it, not loose files in e.g. "Downloads".
    const pick = /voxcpm/i.test(dir) ? dir : `${dir.replace(/[\\/]+$/, "")}\\DR Dubber VoxCPM2`;
    put(DIR_KEY, pick === info?.defaultDir ? "" : pick);
    refresh();
  }

  function wire() {
    if (!$("vox-install-card")) return;
    $("vox-install-btn").addEventListener("click", install);
    $("vox-install-cancel").addEventListener("click", () => api().voxCancelInstall?.());
    $("vox-install-dir-change").addEventListener("click", changeDir);
    api().onVoxInstallProgress?.(onProgress);
    // Checked when the VoxCPM2 pane is opened (Python may have been installed meanwhile).
    document.addEventListener("click", (e) => {
      if (e.target.closest('[data-target="settings-voxcmp2"]')) setTimeout(refresh, 50);
    });
    refresh();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
