/**
 * DAI-Transcribe Studio — Native Pro Suite for DR Dubber Pro
 * Batch Audio & Video Transcription, Subtitle Translation & Khmer Movie Title Localization
 * Powered by Google Gemini AI & Whisper Engine
 */

(() => {
  'use strict';

  // State
  const state = {
    isOpen: false,
    activeTab: 'batch', // 'batch' | 'translator' | 'titles'
    queue: [],
    isBatchRunning: false,
    batchAbortController: null,
    runningItemIds: new Set(), // queue items being processed right now (several run at once)
    batchItemIds: new Set(),   // every file in the current batch (for the overall %)
    batchStartedAt: 0,
    lastBatchMs: 0,            // how long the last finished batch took
    progressTimer: null,       // ticks the % / time-left display every second
    selectedPreviewItem: null,
    outputFolder: localStorage.getItem('aiDubberAutoSaveSrtCustomPath') || '',
    
    // Tab 2: Translator State
    translator: {
      file: null,
      fileName: '',
      rawText: '',
      sourceCues: [],
      translatedCues: [],
      isRunning: false,
      abortController: null,
      requestId: null,
      mode: 'upload', // 'upload' | 'raw' | 'tabs'
      tabJobs: [],    // "All Project Tabs" queue: { ref, name, lines, total, status, note }
      progress: { done: 0, total: 0 }
    },

    // Tab 3: Title Suggestions State
    titles: {
      originalTitle: '',
      contextText: '',
      subtitlesFile: null,
      genre: 'all',
      isLoading: false,
      results: []
    },

    // Character Glossary
    glossary: []
  };

  // Helper DOM selector
  const $ = (id) => document.getElementById(id);

  // Formatting helpers
  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const formatSeconds = (sec) => {
    const s = Math.round(sec || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    }
    return `${m}:${String(r).padStart(2, '0')}`;
  };

  const escapeHtml = (str) => {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  const getBackendBase = () => {
    const port = (window.electronAPI && typeof window.electronAPI.getBackendPort === 'function')
      ? 3001
      : 3001;
    return `http://localhost:${port}`;
  };

  const getActiveApiKeys = () => {
    try {
      const keys = JSON.parse(localStorage.getItem('aiDubberApiKeys') || '[]');
      if (Array.isArray(keys) && keys.length > 0) return keys.filter(k => k && k.trim());
    } catch (e) {}
    const single = (localStorage.getItem('aiDubberApiKey') || '').trim();
    return single ? [single] : [];
  };

  const getActiveModel = () => {
    return localStorage.getItem('aiDubberModel') || 'gemini-3.8-flash';
  };

  const loadGlossaryFromStorage = () => {
    try {
      const raw = localStorage.getItem('aiDubberGlossary') || localStorage.getItem('aiDubberDramaGlossary');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          state.glossary = parsed;
          return;
        }
      }
    } catch (e) {}
    state.glossary = [];
  };

  const saveGlossaryToStorage = () => {
    try {
      localStorage.setItem('aiDubberGlossary', JSON.stringify(state.glossary));
      localStorage.setItem('aiDubberDramaGlossary', JSON.stringify(state.glossary));
    } catch (e) {}
  };

  // Convert cues to SRT text
  const cuesToSrt = (cues) => {
    if (!Array.isArray(cues) || cues.length === 0) return '';
    return cues.map((c, idx) => {
      const startStr = formatSrtTimestamp(timeToSeconds(c.start));
      const endStr = formatSrtTimestamp(timeToSeconds(c.end));

      const genderTag = c.gender ? `[${c.gender}${c.emotion && c.emotion !== 'Neutral' ? `:${c.emotion}` : ''}] ` : '';
      const text = (c.text || c.khmer || '').trim();
      return `${idx + 1}\n${startStr} --> ${endStr}\n${genderTag}${text}\n`;
    }).join('\n');
  };

  // The server sends cue times as "HH:MM:SS.ss" strings; SRT files also use "HH:MM:SS,mmm".
  const timeToSeconds = (t) => {
    if (typeof t === 'number') return t;
    const parts = String(t || '').trim().replace(',', '.').split(':').map(parseFloat);
    if (parts.some(n => !Number.isFinite(n))) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  };

  const formatSrtTimestamp = (seconds) => {
    const totalMs = Math.round(Math.max(0, parseFloat(seconds) || 0) * 1000);
    const hrs = Math.floor(totalMs / 3600000);
    const mins = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
  };

  const formatVttTimestamp = (seconds) => {
    return formatSrtTimestamp(seconds).replace(',', '.');
  };

  // Convert cues to VTT text
  const cuesToVtt = (cues) => {
    if (!Array.isArray(cues) || cues.length === 0) return 'WEBVTT\n\n';
    let vtt = 'WEBVTT\n\n';
    cues.forEach((c, idx) => {
      const startStr = formatVttTimestamp(timeToSeconds(c.start));
      const endStr = formatVttTimestamp(timeToSeconds(c.end));
      const genderTag = c.gender ? `[${c.gender}] ` : '';
      vtt += `${idx + 1}\n${startStr} --> ${endStr}\n${genderTag}${(c.text || '').trim()}\n\n`;
    });
    return vtt;
  };

  // Convert cues to Plain TXT
  const cuesToTxt = (cues) => {
    if (!Array.isArray(cues) || cues.length === 0) return '';
    return cues.map(c => (c.text || '').trim()).filter(Boolean).join('\n');
  };

  // Download string as file helper
  const triggerDownload = (content, filename, mimeType = 'text/plain;charset=utf-8') => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  };

  // ──────────────────────────────────────────────────────────────────────────
  // MODAL CONTROLS & INITIALIZATION
  // ──────────────────────────────────────────────────────────────────────────

  function initDaiTranscribeStudio() {
    loadGlossaryFromStorage();
    setupEventListeners();
    updateApiStatusDisplay();
    renderQueueTable();
    updateOutputFolderDisplay();
  }

  function openDaiTranscribeModal(initialTab = 'batch') {
    const modal = $('modal-dai-transcribe');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    state.isOpen = true;
    switchTab(initialTab);
    updateApiStatusDisplay();
    updateOutputFolderDisplay();
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function closeDaiTranscribeModal() {
    const modal = $('modal-dai-transcribe');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    state.isOpen = false;
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    ['batch', 'translator', 'titles'].forEach(t => {
      const btn = $(`dai-tab-btn-${t}`);
      const pane = $(`dai-pane-${t}`);
      if (btn && pane) {
        if (t === tabName) {
          btn.className = 'dai-tab-btn active px-4 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 border bg-indigo-500/20 border-indigo-500/50 text-indigo-300 shadow-md';
          pane.classList.remove('hidden');
          pane.classList.add('flex');
        } else {
          btn.className = 'dai-tab-btn px-4 py-2.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-2 border border-transparent text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-hover)]';
          pane.classList.add('hidden');
          pane.classList.remove('flex');
        }
      }
    });

    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  // ── Per-key quota state (from the backend: what Google answered for each key so far) ──
  const formatWaitShort = (ms) => {
    if (!(ms > 0)) return '';
    if (ms < 60000) return `${Math.max(1, Math.ceil(ms / 1000))}s`;
    const min = Math.ceil(ms / 60000);
    return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
  };

  // Full class names (not built from the color name) so the Tailwind build can see them.
  const KEY_STATUS_CLASSES = {
    emerald: { text: 'text-emerald-400', dot: 'bg-emerald-400', badge: 'bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400' },
    amber: { text: 'text-amber-400', dot: 'bg-amber-400', badge: 'bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-400' },
    rose: { text: 'text-rose-400', dot: 'bg-rose-400', badge: 'bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-400' }
  };

  function keyStatusView(s) {
    if (!s) return { color: 'emerald', text: 'Ready' };
    if (s.state === 'invalid') return { color: 'rose', text: 'Rejected by Google (invalid or expired key)' };
    if (s.state === 'daily') return { color: 'rose', text: `Daily quota used up · resets in ${formatWaitShort(s.retryAfterMs)}` };
    if (s.state === 'cooling') return { color: 'amber', text: `Rate-limited · free again in ${formatWaitShort(s.retryAfterMs)}` };
    if (s.state === 'partial') {
      const out = s.models.map(m => `${m.model.replace(/^gemini-/, '')} ${m.daily ? 'out today' : `wait ${formatWaitShort(m.retryAfterMs)}`}`);
      return { color: 'amber', text: `Ready · ${out.join(', ')}` };
    }
    return { color: 'emerald', text: 'Ready' };
  }

  let keyStatusFetchedAt = 0;
  async function refreshKeyStatuses() {
    const keys = getActiveApiKeys();
    if (!keys.length) return;
    keyStatusFetchedAt = Date.now();
    let statuses;
    try {
      const res = await fetch(`${getBackendBase()}/api/gemini-key-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys })
      });
      statuses = (await res.json()).keys;
    } catch (e) { return; }
    if (!Array.isArray(statuses)) return;

    // Key list in the API key modal (rows are in the same order as the keys).
    statuses.forEach((s, idx) => {
      const el = document.querySelector(`[data-dai-keystatus="${idx}"]`);
      if (!el) return;
      const v = keyStatusView(s);
      const c = KEY_STATUS_CLASSES[v.color];
      el.className = `text-[10px] ${c.text} flex items-center gap-1 min-w-0`;
      el.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${c.dot} shrink-0"></span> <span class="truncate">${escapeHtml(v.text)}</span>`;
      el.title = v.text;
    });

    // Header badge: how many keys can take work right now.
    const badge = $('dai-api-key-badge');
    if (!badge) return;
    const ready = statuses.filter(s => s.state === 'ok' || s.state === 'partial').length;
    const allDaily = statuses.every(s => s.state === 'daily' || s.state === 'invalid');
    const soonest = Math.min(...statuses.filter(s => s.retryAfterMs > 0).map(s => s.retryAfterMs));
    const color = ready === keys.length ? 'emerald' : ready > 0 ? 'amber' : 'rose';
    const label = ready === keys.length
      ? `${keys.length} API Key${keys.length > 1 ? 's' : ''} Active`
      : ready > 0
        ? `${ready}/${keys.length} Keys Ready`
        : allDaily ? `Daily Quota Used Up · resets in ${formatWaitShort(soonest)}` : `All Keys Rate-Limited · ${formatWaitShort(soonest)}`;
    const c = KEY_STATUS_CLASSES[color];
    badge.innerHTML = `<span class="w-2 h-2 rounded-full ${c.dot}${color === 'emerald' ? ' animate-pulse' : ''}"></span>
      <span>${escapeHtml(label)}</span>
      <i data-lucide="key" class="w-3 h-3 ml-0.5 opacity-80"></i>`;
    badge.className = `flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold ${c.badge} cursor-pointer transition-all shadow-sm active:scale-95`;
    badge.title = color === 'emerald' ? '' : 'Click to see the quota state of each key';
    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
  }

  function updateApiStatusDisplay() {
    const keys = getActiveApiKeys();
    const model = getActiveModel();
    const badge = $('dai-api-key-badge');
    const modelSelect = $('dai-model-select');
    const transModelSelect = $('dai-trans-model-select');
    const titlesModelSelect = $('dai-titles-model-select');

    if (badge) {
      badge.onclick = () => openApiKeyModal();
      if (keys.length > 0) {
        badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>${keys.length} API Key${keys.length > 1 ? 's' : ''} Active</span>
          <i data-lucide="key" class="w-3 h-3 ml-0.5 opacity-80"></i>`;
        badge.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 cursor-pointer transition-all shadow-sm active:scale-95';
        refreshKeyStatuses();
      } else {
        badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-rose-400"></span>
          <span>No Gemini Key (Click to Add)</span>
          <i data-lucide="key" class="w-3 h-3 ml-0.5 opacity-80"></i>`;
        badge.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-400 cursor-pointer transition-all shadow-sm active:scale-95';
      }
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        window.lucide.createIcons();
      }
    }

    [modelSelect, transModelSelect, titlesModelSelect].forEach(sel => {
      if (sel) {
        if ([...sel.options].some(o => o.value === model)) {
          sel.value = model;
        }
      }
    });
  }

  function updateOutputFolderDisplay() {
    const folder = state.outputFolder || localStorage.getItem('aiDubberAutoSaveSrtCustomPath') || 'Desktop ➔ transcribe output';
    const el = $('dai-output-folder-text');
    if (el) el.textContent = folder;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TAB 1: BATCH QUEUE LOGIC
  // ──────────────────────────────────────────────────────────────────────────

  async function probeMediaDuration(fileOrPath) {
    return new Promise((resolve) => {
      try {
        const media = document.createElement('video');
        media.preload = 'metadata';
        let url;
        if (typeof fileOrPath === 'string') {
          url = fileOrPath.startsWith('http') ? fileOrPath : `${getBackendBase()}/api/audio?path=${encodeURIComponent(fileOrPath)}`;
        } else if (fileOrPath instanceof Blob) {
          url = URL.createObjectURL(fileOrPath);
        }
        if (!url) return resolve(0);

        media.onloadedmetadata = () => {
          if (fileOrPath instanceof Blob) URL.revokeObjectURL(url);
          resolve(media.duration || 0);
        };
        media.onerror = () => {
          if (fileOrPath instanceof Blob) URL.revokeObjectURL(url);
          resolve(0);
        };
        media.src = url;
      } catch (e) {
        resolve(0);
      }
    });
  }

  // "+ Add All Dubber Tabs": every open tab's video goes into the queue. Start Batch then extracts
  // its audio (saving transcribe_<episode>.mp3 in the Save Folder) and makes the SRT, and
  // "Open All as Dubber Tabs" puts each SRT back into the tab it came from.
  function addDubberTabsToQueue() {
    const bridge = window.dubberBridge;
    if (!bridge) {
      showToast('DR Dubber Pro projects engine not loaded.', 'error');
      return;
    }
    const tabs = bridge.tabList();
    const usable = tabs.filter((t) => t.path);
    if (usable.length === 0) {
      showToast(tabs.length ? 'None of the open tabs has a video file on disk.' : 'No Dubber tabs are open. Load your videos in DR Dubber first.', 'warning');
      return;
    }
    const before = state.queue.length;
    addFilesToQueue(usable.map((t) => ({
      filePath: t.path,
      fileName: t.path.split(/[\\/]/).pop(),
      fileUrl: `${getBackendBase()}/api/audio?path=${encodeURIComponent(t.path)}`,
      targetTab: t.ref,
      partIndex: t.number,
    })), { quiet: true });
    const added = state.queue.length - before;
    const skipped = tabs.length - usable.length;
    if (!added) {
      showToast('All open tabs are already in the queue.', 'info');
      return;
    }
    showToast(`Added ${added} tab(s) to the queue${usable.length > added ? ` (${usable.length - added} already in it)` : ''}${skipped ? `, ${skipped} tab(s) without a video file skipped` : ''}. Press Start Batch to make their SRTs.`, 'success');
  }

  // "Transcribe All Tabs" (main window): every tab with a video on disk is transcribed by this
  // batch engine (parallel, live %, quota-aware) and each transcript is written straight back
  // into its tab. Resolves with the batch summary, or null when nothing ran.
  // onlyRefs (optional Set of project objects): transcribe just those tabs, e.g. a retry of
  // the tabs that came back empty.
  // oneAtATime: one tab at a time, like pressing Transcribe on each tab. Several tabs at once
  // multiply the Gemini requests, and rate-limited chunks then go to a fallback model that
  // splits the dialogue differently (fewer, longer lines).
  // keyPerTab: one tab per API key, all at once - each key (its own Google project) carries
  // one request at a time, and a rate limit is waited out on the same model.
  async function transcribeAllTabs({ onlyRefs = null, oneAtATime = false, keyPerTab = false } = {}) {
    const bridge = window.dubberBridge;
    if (!bridge) {
      showToast('DR Dubber Pro projects engine not loaded.', 'error');
      return null;
    }
    if (state.isBatchRunning) {
      openDaiTranscribeModal('batch');
      showToast('A batch is already running - see its progress here.', 'info');
      return null;
    }
    const tabs = bridge.tabList().filter((t) => t.path && (!onlyRefs || onlyRefs.has(t.ref)));
    const busy = tabs.filter((t) => bridge.isTabBusy(t.ref));
    const usable = tabs.filter((t) => !bridge.isTabBusy(t.ref));
    if (!usable.length) {
      showToast(busy.length ? 'Every tab is busy (generating voice or transcribing).' : 'No tab has a video file on disk.', 'warning');
      return null;
    }
    await addFilesToQueue(usable.map((t) => ({
      filePath: t.path,
      fileName: t.path.split(/[\\/]/).pop(),
      fileUrl: `${getBackendBase()}/api/audio?path=${encodeURIComponent(t.path)}`,
      targetTab: t.ref,
      partIndex: t.number,
    })), { quiet: true });
    // Files already in the queue (even finished ones) are transcribed again for their tab; a
    // part done in the last few hours comes back from the server's cache without using quota.
    // Only these tabs' items run: older queue items (e.g. from a previous series part whose
    // tabs are closed) must not be re-run or counted in this batch's summary.
    const runIds = new Set();
    for (const t of usable) {
      const item = state.queue.find((q) => q.filePath === t.path);
      if (!item || ['extracting', 'transcribing'].includes(item.status)) continue;
      Object.assign(item, { targetTab: t.ref, partIndex: t.number, autoApplyToTab: true, appliedToTab: false, repairIncomplete: false, status: 'pending', error: null, progress: 0 });
      runIds.add(item.id);
    }
    renderQueueTable();
    if (busy.length) showToast(`${busy.length} busy tab(s) skipped (generating voice or transcribing).`, 'warning');
    if (!runIds.size) return null;
    openDaiTranscribeModal('batch');
    return startBatch(runIds, { maxParallel: oneAtATime ? 1 : null, keyPerTab });
  }

  async function addFilesToQueue(files, { quiet = false } = {}) {
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const isElectronObj = f && typeof f === 'object' && f.filePath;
      const fileName = isElectronObj ? f.fileName : f.name;
      const filePath = isElectronObj ? f.filePath : (f.path || null);
      const size = isElectronObj ? 0 : (f.size || 0);

      // Check if already in queue
      // By path when there is one: the same file name in another folder is a different file.
      const existing = state.queue.find(q => (filePath ? q.filePath === filePath : q.fileName === fileName));
      if (existing) continue;

      const ext = (fileName || '').split('.').pop().toLowerCase();
      const isAudio = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'].includes(ext);
      const isSubtitle = ['srt', 'vtt'].includes(ext);

      const queueItem = {
        id: `q_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        rawFile: isElectronObj ? null : f,
        fileName: fileName,
        filePath: filePath,
        fileUrl: isElectronObj ? f.fileUrl : null,
        fileExt: ext,
        isAudio,
        isSubtitle,
        size: size,
        duration: 0,
        status: 'pending', // 'pending' | 'extracting' | 'transcribing' | 'completed' | 'failed'
        progress: 0,
        progressText: 'Queued',
        cuesCount: 0,
        subtitles: [],
        srtText: '',
        error: null,
        requestId: `dai_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        // From "+ Add All Dubber Tabs": the tab the episode came from, so its SRT goes back there.
        targetTab: (isElectronObj && f.targetTab) || null,
        partIndex: (isElectronObj && f.partIndex) || 1
      };

      state.queue.push(queueItem);
      renderQueueTable();

      // Probe duration in background
      probeMediaDuration(filePath || f).then(dur => {
        queueItem.duration = dur;
        renderQueueTable();
      });
    }

    renderQueueTable();
    if (!quiet) showToast(`Added ${files.length} file(s) to Batch Queue`, 'success');
  }

  function removeQueueItem(id) {
    const idx = state.queue.findIndex(q => q.id === id);
    if (idx !== -1) {
      state.queue.splice(idx, 1);
      renderQueueTable();
    }
  }

  function clearQueue() {
    if (state.isBatchRunning) {
      if (!confirm('A batch job is currently running. Stop and clear queue?')) return;
      stopBatch();
    }
    state.queue = [];
    renderQueueTable();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PROGRESS ESTIMATES
  // ──────────────────────────────────────────────────────────────────────────
  // The server only reports when a whole chunk is finished, and with API Saver a part is ONE
  // chunk, so on its own the bar would sit still for many minutes. Between reports the bar moves
  // on time instead, using how long earlier files took per second of audio (remembered across
  // sessions, separately for API Saver on/off since their speed differs).
  //   0-10%  extract audio   10-90%  Gemini transcribe   90-98%  double-check / fix Khmer   100% saved
  const DEFAULT_SEC_PER_AUDIO_SEC = 1.0;
  const EXTRACT_EXPECTED_MS = 20000;
  const REPAIR_EXPECTED_MS = 120000; // the server's gap-check time budget

  const rateStorageKey = (apiSaver) => `daiTranscribeSecPerAudioSec${apiSaver ? '_saver' : ''}`;
  function getTranscribeRate(apiSaver) {
    try {
      const v = parseFloat(localStorage.getItem(rateStorageKey(apiSaver)));
      if (v > 0.05 && v < 20) return v;
    } catch (e) {}
    return DEFAULT_SEC_PER_AUDIO_SEC;
  }
  function learnTranscribeRate(item) {
    const audioSec = Number(item.duration) || 0;
    if (!(audioSec > 30) || !item.transcribeStartedAt) return;
    const sample = ((item.repairStartedAt || Date.now()) - item.transcribeStartedAt) / 1000 / audioSec;
    // Smoothed, so one slow file (Google busy) doesn't throw off every later estimate.
    const next = getTranscribeRate(item.apiSaver) * 0.6 + sample * 0.4;
    try { localStorage.setItem(rateStorageKey(item.apiSaver), String(next)); } catch (e) {}
  }

  // Linear up to 85% of the expected time, then slows down and never reaches the end, so a
  // stage that runs late keeps creeping instead of showing a finished bar.
  const easeShare = (t) => (t <= 0.85 ? Math.max(0, t) : 0.85 + 0.13 * (1 - Math.exp(-(t - 0.85) / 0.6)));

  function computeItemProgress(item, now = Date.now()) {
    if (item.status === 'completed') return 100;
    if (item.status === 'failed') return item.progress || 0;
    if (item.status === 'extracting') {
      return 1 + 9 * easeShare((now - (item.extractStartedAt || now)) / EXTRACT_EXPECTED_MS);
    }
    if (item.status === 'transcribing') {
      if (item.repairStartedAt) {
        const share = item.repairTotal > 0
          ? item.repairDone / item.repairTotal
          : (now - item.repairStartedAt) / REPAIR_EXPECTED_MS;
        return 90 + 8 * easeShare(share);
      }
      const chunkShare = item.chunkTotal > 0 ? item.chunkDone / item.chunkTotal : 0;
      const expectedMs = Math.max(30000, (Number(item.duration) || 300) * getTranscribeRate(item.apiSaver) * 1000);
      const timeShare = easeShare((now - (item.transcribeStartedAt || now)) / expectedMs);
      return 10 + 80 * Math.min(0.99, Math.max(chunkShare, timeShare));
    }
    return 0;
  }

  const formatDurationShort = (ms) => {
    const totalMin = Math.round(ms / 60000);
    if (totalMin < 1) return '<1m';
    const h = Math.floor(totalMin / 60);
    return h > 0 ? `${h}h ${String(totalMin % 60).padStart(2, '0')}m` : `${totalMin}m`;
  };

  // Remaining time from progress so far: elapsed * (left / done). Hidden until there is
  // enough progress for the guess to mean anything.
  function etaText(pct, elapsedMs) {
    if (!(pct >= 3) || elapsedMs < 10000 || pct >= 100) return '';
    return `~${formatDurationShort(elapsedMs * (100 - pct) / pct)} left`;
  }

  function itemStageLabel(item) {
    if (item.status === 'extracting') return 'Extracting audio';
    if (item.status !== 'transcribing') return item.progressText || '';
    const note = item.progressNote || '';
    if (/retrying/i.test(note)) return /connection/i.test(note) ? 'Connection retry' : 'Google busy, retrying';
    if (item.repairStartedAt) return /translating/i.test(note) ? 'Fixing Khmer lines' : 'Double-checking';
    return item.chunkTotal > 1 ? `Transcribing ${item.chunkDone}/${item.chunkTotal}` : 'Transcribing';
  }

  const batchItems = () => state.queue.filter(q => state.batchItemIds.has(q.id));

  // Updates only the numbers/bars in place (called every second while a batch runs); the
  // table itself is rebuilt by renderQueueTable() only when a file changes status.
  function updateProgressDom() {
    const now = Date.now();
    for (const item of state.queue) {
      const running = item.status === 'extracting' || item.status === 'transcribing';
      if (!running) continue;
      const pct = Math.floor(computeItemProgress(item, now));
      item.progress = pct;
      const sel = (attr) => document.querySelector(`[${attr}="${CSS.escape(item.id)}"]`);
      const pctEl = sel('data-dai-pct');
      const barEl = sel('data-dai-bar');
      const labelEl = sel('data-dai-label');
      const etaEl = sel('data-dai-eta');
      if (pctEl) pctEl.textContent = `${pct}%`;
      if (barEl) barEl.style.width = `${pct}%`;
      if (labelEl) labelEl.textContent = itemStageLabel(item);
      if (etaEl) {
        const elapsed = now - (item.startedAt || now);
        etaEl.textContent = [etaText(pct, elapsed), `${formatSeconds(elapsed / 1000)} elapsed`].filter(Boolean).join(' · ');
        etaEl.title = item.progressNote || '';
      }
    }

    // Overall: progress of the files in this batch, weighted by their length (a failed
    // file counts as finished - there is nothing more to wait for on it).
    const overallBar = $('dai-overall-progress-bar');
    const overallPct = $('dai-overall-percent');
    const overallEta = $('dai-overall-eta');
    let pct;
    let eta = '';
    const items = batchItems();
    if (state.isBatchRunning && items.length) {
      let sum = 0, weightSum = 0;
      for (const item of items) {
        const w = Number(item.duration) > 0 ? Number(item.duration) : 300;
        sum += w * (item.status === 'failed' ? 100 : computeItemProgress(item, now));
        weightSum += w;
      }
      pct = Math.min(99, Math.floor(sum / weightSum));
      const elapsed = now - state.batchStartedAt;
      eta = [etaText(pct, elapsed), `${formatSeconds(elapsed / 1000)} elapsed`].filter(Boolean).join(' · ');
    } else {
      const total = state.queue.length;
      pct = total === 0 ? 0 : Math.round(state.queue.filter(q => q.status === 'completed').length / total * 100);
      if (state.lastBatchMs) eta = `Finished in ${formatDurationShort(state.lastBatchMs)}`;
    }
    // Keep the key badge current while Google rate-limits keys mid-batch.
    if (state.isBatchRunning && now - keyStatusFetchedAt > 10000) refreshKeyStatuses();
    if (overallBar) overallBar.style.width = `${pct}%`;
    if (overallPct) overallPct.textContent = `${pct}%`;
    if (overallEta) overallEta.textContent = eta;
    try { window.electronAPI?.setTaskbarProgress?.(state.isBatchRunning ? pct / 100 : -1); } catch (e) {}
  }

  function renderQueueTable() {
    const list = $('dai-queue-list');
    const emptyState = $('dai-queue-empty');
    const countBadge = $('dai-queue-count-badge');
    const statsSummary = $('dai-queue-stats-summary');
    const btnStart = $('dai-btn-start-batch');

    if (!list) return;

    const total = state.queue.length;
    const completed = state.queue.filter(q => q.status === 'completed').length;
    const failed = state.queue.filter(q => q.status === 'failed').length;
    const processing = state.queue.filter(q => ['extracting', 'transcribing'].includes(q.status)).length;
    const pending = total - completed - failed - processing;

    if (countBadge) countBadge.textContent = `${total} File${total === 1 ? '' : 's'}`;
    if (statsSummary) {
      statsSummary.textContent = `${completed} Done · ${processing} Running · ${pending} Pending${failed > 0 ? ` · ${failed} Failed` : ''}`;
    }

    if (total === 0) {
      if (emptyState) emptyState.classList.remove('hidden');
      list.innerHTML = '';
      updateProgressDom();
      if (btnStart) {
        btnStart.disabled = true;
        btnStart.classList.add('opacity-50', 'cursor-not-allowed');
      }
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');
    if (btnStart) {
      btnStart.disabled = false;
      btnStart.classList.remove('opacity-50', 'cursor-not-allowed');
    }

    list.innerHTML = state.queue.map((item, idx) => {
      let statusBadge = '';
      if (item.status === 'completed') {
        statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center gap-1">
          <i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> ${item.cuesCount} Lines
        </span>`;
      } else if (item.status === 'extracting') {
        statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center gap-1 min-w-0">
          <i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin shrink-0"></i> <span data-dai-label="${escapeHtml(item.id)}" class="truncate">${escapeHtml(itemStageLabel(item))}</span>
        </span>`;
      } else if (item.status === 'transcribing') {
        statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 flex items-center gap-1 min-w-0">
          <i data-lucide="sparkles" class="w-3.5 h-3.5 animate-spin shrink-0"></i> <span data-dai-label="${escapeHtml(item.id)}" class="truncate">${escapeHtml(itemStageLabel(item))}</span>
        </span>`;
      } else if (item.status === 'failed') {
        statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-500/15 border border-rose-500/30 text-rose-400 flex items-center gap-1" title="${escapeHtml(item.error || 'Failed')}">
          <i data-lucide="alert-circle" class="w-3.5 h-3.5"></i> Error
        </span>`;
      } else {
        statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[var(--bg-hover)] border border-[var(--border-light)] text-[var(--text-muted)]">
          Queued
        </span>`;
      }

      const mediaIcon = item.isSubtitle ? 'captions' : (item.isAudio ? 'music' : 'film');
      const iconColor = item.isSubtitle ? 'text-indigo-400' : (item.isAudio ? 'text-pink-400' : 'text-sky-400');

      return `
        <tr class="border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)]/30 transition-colors group">
          <td class="px-3 py-3 text-xs font-mono text-[var(--text-muted)] text-center">${idx + 1}</td>
          <td class="px-3 py-3">
            <div class="flex items-center gap-2.5 max-w-[360px]">
              <div class="w-7 h-7 rounded-lg bg-[var(--bg-base)] border border-[var(--border-light)] flex items-center justify-center shrink-0">
                <i data-lucide="${mediaIcon}" class="w-4 h-4 ${iconColor}"></i>
              </div>
              <div class="flex flex-col truncate">
                <span class="text-xs font-semibold text-[var(--text-primary)] truncate group-hover:text-white" title="${escapeHtml(item.fileName)}">
                  ${escapeHtml(item.fileName)}
                </span>
                <span class="text-[10px] text-[var(--text-muted)] font-mono truncate">
                  ${escapeHtml(item.filePath || 'Browser File')}
                </span>
              </div>
            </div>
          </td>
          <td class="px-3 py-3 text-xs font-mono text-[var(--text-secondary)] whitespace-nowrap">
            ${item.duration > 0 ? formatSeconds(item.duration) : '--:--'}
            ${item.size > 0 ? ` · ${formatBytes(item.size)}` : ''}
          </td>
          <td class="px-3 py-3">
            <div class="flex flex-col gap-1 min-w-[190px] max-w-[260px]">
              <div class="flex items-center justify-between gap-2 min-w-0">
                ${statusBadge}
                ${item.status === 'transcribing' || item.status === 'extracting' ? `<span data-dai-pct="${escapeHtml(item.id)}" class="text-[11px] font-mono text-indigo-300 font-bold shrink-0">${item.progress}%</span>`
                  : item.status === 'failed' && item.progress > 0 ? `<span class="text-[10px] font-mono text-rose-400 font-bold shrink-0">${item.progress}%</span>` : ''}
              </div>
              ${item.status === 'transcribing' || item.status === 'extracting' ? `
                <div class="w-full h-1.5 rounded-full bg-[var(--bg-base)] overflow-hidden">
                  <div data-dai-bar="${escapeHtml(item.id)}" class="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-700" style="width: ${item.progress}%"></div>
                </div>
                <span data-dai-eta="${escapeHtml(item.id)}" class="text-[10px] font-mono text-[var(--text-muted)] truncate"></span>
              ` : ''}
              ${item.status === 'completed' && item.elapsedMs ? `<span class="text-[10px] font-mono text-[var(--text-muted)]">Done in ${formatSeconds(item.elapsedMs / 1000)}</span>` : ''}
              ${item.status === 'failed' && item.error ? `<span class="text-[10px] text-rose-300 truncate" title="${escapeHtml(item.error)}">${escapeHtml(item.error)}</span>` : ''}
            </div>
          </td>
          <td class="px-3 py-3 text-right">
            <div class="flex items-center justify-end gap-1.5">
              ${item.status === 'completed' ? `
                <button onclick="window.daiStudio.previewItem('${item.id}')"
                  title="Preview / Edit Subtitle Cues"
                  class="p-1.5 rounded-lg border border-[var(--border-light)] bg-[var(--bg-base)] hover:bg-indigo-500/20 hover:border-indigo-400 hover:text-indigo-300 text-[var(--text-secondary)] transition-all">
                  <i data-lucide="eye" class="w-3.5 h-3.5"></i>
                </button>
                <button onclick="window.daiStudio.exportItemSrt('${item.id}')"
                  title="Download .SRT"
                  class="p-1.5 rounded-lg border border-[var(--border-light)] bg-[var(--bg-base)] hover:bg-emerald-500/20 hover:border-emerald-400 hover:text-emerald-300 text-[var(--text-secondary)] transition-all">
                  <i data-lucide="download" class="w-3.5 h-3.5"></i>
                </button>
                <button onclick="window.daiStudio.sendItemToDubber('${item.id}')"
                  title="Load into DR Dubber Tab"
                  class="p-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/25 text-amber-300 transition-all flex items-center gap-1 text-[11px] font-bold">
                  <i data-lucide="plus-circle" class="w-3.5 h-3.5"></i>
                  <span>Dubber Tab</span>
                </button>
              ` : ''}
              ${item.status === 'failed' ? `
                <button onclick="window.daiStudio.retryItem('${item.id}')"
                  title="Retry"
                  class="p-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 transition-all">
                  <i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i>
                </button>
              ` : ''}
              <button onclick="window.daiStudio.removeItem('${item.id}')"
                title="Remove from queue"
                class="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-rose-400 hover:bg-[var(--bg-hover)] transition-all">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
    updateProgressDom();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BATCH EXECUTION RUNNER
  // ──────────────────────────────────────────────────────────────────────────

  // Max files transcribed at the same time (also capped by the number of API keys).
  const BATCH_MAX_PARALLEL_FILES = 6;

  // onlyIds (Set of queue item ids) limits the batch to those items; the Start button
  // passes a click event, which means "everything pending".
  async function startBatch(onlyIds, { maxParallel = null, keyPerTab = false } = {}) {
    if (state.isBatchRunning) return;
    if (!(onlyIds instanceof Set)) onlyIds = null;

    const apiKeys = getActiveApiKeys();
    if (apiKeys.length === 0) {
      showToast('Please add at least one Gemini API Key in Settings ➔ General.', 'error');
      document.getElementById('btn-open-settings')?.click();
      return;
    }

    const pendingItems = state.queue.filter(q => (q.status === 'pending' || q.status === 'failed') && (!onlyIds || onlyIds.has(q.id)));
    if (pendingItems.length === 0) {
      showToast('No pending files to process in the queue.', 'info');
      return;
    }

    state.isBatchRunning = true;
    state.batchAbortController = new AbortController();
    state.batchItemIds = new Set(pendingItems.map(q => q.id));
    state.batchStartedAt = Date.now();
    state.lastBatchMs = 0;
    for (const item of pendingItems) item.progress = 0;
    clearInterval(state.progressTimer);
    state.progressTimer = setInterval(updateProgressDom, 1000);
    updateBatchControlsState();

    const genre = $('dai-genre-select')?.value || 'historical';
    const model = $('dai-model-select')?.value || getActiveModel();
    const customFolder = state.outputFolder || localStorage.getItem('aiDubberAutoSaveSrtCustomPath') || '';
    loadGlossaryFromStorage(); // pick up names saved elsewhere (All Tabs > Make names consistent)
    const glossaryDict = state.glossary.length > 0
      ? state.glossary.reduce((acc, cur) => {
          if (cur.original && cur.khmer) acc[cur.original.trim()] = cur.khmer.trim();
          return acc;
        }, {})
      : null;

    showToast(`🚀 Starting Batch Transcribe for ${pendingItems.length} file(s)...`, 'info');

    // Files run in parallel: one file only keeps one or two keys busy (an API Saver part is a
    // single Gemini request), so a one-at-a-time queue left most keys idle and a 2 hour movie
    // took hours. Each file starts on a different key so they don't all pile onto key #1; the
    // server's per-key cooldowns spread any rate limits across the rest.
    const concurrency = Math.max(1, Math.min(maxParallel || BATCH_MAX_PARALLEL_FILES, apiKeys.length, pendingItems.length));
    const keyStride = Math.max(1, Math.floor(apiKeys.length / concurrency));
    const batchAbort = state.batchAbortController;
    const todo = [...pendingItems];
    // keyPerTab: worker w owns key w; keys beyond the parallel count replace a key that runs
    // out of its daily quota.
    const spareKeys = keyPerTab ? apiKeys.slice(concurrency) : [];
    let stopToastShown = false;

    // Every key out of its daily quota: the remaining files would all fail the same way, so they
    // stay queued (Start again once the quota resets or billing is on).
    let quotaOut = false;

    let inFlight = 0; // files being worked on - one can come back to `todo` (its key ran out)
    const worker = async (w) => {
      let ownKey = keyPerTab ? apiKeys[w] : null;
      while (todo.length || (keyPerTab && inFlight)) {
        if (!state.isBatchRunning || state.batchAbortController?.signal.aborted || quotaOut) return;
        if (!todo.length) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        const item = todo.shift();
        inFlight++;
        const offset = (pendingItems.indexOf(item) * keyStride) % apiKeys.length;
        state.runningItemIds.add(item.id);
        if (item.autoApplyToTab) window.dubberBridge?.setTabWorking(item.targetTab, true);
        try {
          await processSingleBatchItem(item, {
            // keyPerTab: own key first, the others only as backups (one request at a time), so a
            // rate-limited key passes the next chunk to an idle key instead of waiting.
            apiKeys: ownKey ? [ownKey, ...apiKeys.filter((k) => k !== ownKey)] : [...apiKeys.slice(offset), ...apiKeys.slice(0, offset)],
            maxLanes: keyPerTab ? 1 : null,
            stayOnModel: keyPerTab,
            model,
            genre,
            glossaryDict,
            customFolder,
            signal: state.batchAbortController.signal
          });
        } catch (err) {
          if (err.name === 'AbortError') {
            if (!stopToastShown) showToast('Batch transcription stopped.', 'warning');
            stopToastShown = true;
            return;
          }
          if (err.isDailyQuota && ownKey) {
            // This key is out for today: the file goes back in line for a key that still has
            // quota, and this worker carries on with a spare key (or stops).
            Object.assign(item, { status: 'pending', error: null, progress: 0 });
            todo.unshift(item);
            ownKey = spareKeys.shift() || null;
            console.warn(`[DAI Batch] Key ${w + 1} is out of daily quota${ownKey ? ' - using a spare key' : ''}.`);
            renderQueueTable();
            if (!ownKey) return;
            continue;
          }
          item.status = 'failed';
          item.error = err.message || 'Processing failed';
          console.error(`[DAI Batch] Error processing ${item.fileName}:`, err);
          if (err.isDailyQuota && !quotaOut) {
            quotaOut = true;
            showToast(`⛔ ${item.error} The remaining files stay in the queue.`, 'error');
            refreshKeyStatuses();
          }
          renderQueueTable();
        } finally {
          inFlight--;
          state.runningItemIds.delete(item.id);
          if (item.autoApplyToTab) window.dubberBridge?.setTabWorking(item.targetTab, false);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
    // keyPerTab: every key ran out of its daily quota with files left.
    if (keyPerTab && todo.length && !batchAbort.signal.aborted) {
      quotaOut = true;
      todo.forEach((item) => Object.assign(item, { status: 'failed', error: 'Every API key is out of its daily Gemini quota.' }));
      showToast(`⛔ Every API key is out of its daily quota. ${todo.length} file(s) stay in the queue.`, 'error');
      refreshKeyStatuses();
    }

    // Stopped (and maybe already restarted): stopBatch() has cleaned up, leave the new run alone.
    // A transcript that never reached its tab (tab closed) doesn't count as done.
    const reachedTab = (q) => q.status === 'completed' && (!q.autoApplyToTab || q.appliedToTab);
    const batchSummary = () => ({
      completed: pendingItems.filter(reachedTab).length,
      failed: pendingItems.filter(q => q.status === 'failed' || (q.status === 'completed' && !reachedTab(q))).length,
      partial: pendingItems.filter(q => reachedTab(q) && q.repairIncomplete).length,
      fallbackTabs: pendingItems.filter(q => reachedTab(q) && q.fallbackModels?.length).map(q => ({ tab: q.targetTab, models: q.fallbackModels })),
      total: pendingItems.length,
      quotaOut,
      stopped: batchAbort.signal.aborted
    });
    if (state.batchAbortController !== batchAbort || batchAbort.signal.aborted) return batchSummary();

    clearInterval(state.progressTimer);
    state.progressTimer = null;
    state.lastBatchMs = quotaOut ? 0 : Date.now() - state.batchStartedAt;
    state.isBatchRunning = false;
    updateBatchControlsState();
    renderQueueTable();

    const successCount = state.queue.filter(q => q.status === 'completed').length;
    if (quotaOut) {
      showToast(`Batch paused: daily Gemini quota used up. ${successCount}/${state.queue.length} completed - press Start again after the reset to continue.`, 'warning');
    } else {
      showToast(`🎉 Batch processing finished! ${successCount}/${state.queue.length} completed.`, 'success');
    }
    return batchSummary();
  }

  function stopBatch() {
    if (state.batchAbortController) {
      state.batchAbortController.abort();
    }
    // Aborting the fetch doesn't stop the server's Gemini calls - cancel those too, and mark
    // every interrupted file as failed so it can be retried.
    for (const current of state.queue.filter(q => state.runningItemIds.has(q.id))) {
      if (current.status === 'completed') continue;
      fetch(`${getBackendBase()}/api/cancel-transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: current.requestId })
      }).catch(() => {});
      current.status = 'failed';
      current.error = 'Stopped';
    }
    state.runningItemIds.clear();
    clearInterval(state.progressTimer);
    state.progressTimer = null;
    state.isBatchRunning = false;
    updateBatchControlsState();
    renderQueueTable();
    showToast('Batch transcription stopped by user.', 'warning');
  }

  function updateBatchControlsState() {
    const btnStart = $('dai-btn-start-batch');
    const btnStop = $('dai-btn-stop-batch');
    if (!btnStart || !btnStop) return;

    if (state.isBatchRunning) {
      btnStart.classList.add('hidden');
      btnStop.classList.remove('hidden');
    } else {
      btnStart.classList.remove('hidden');
      btnStop.classList.add('hidden');
    }
  }

  async function processSingleBatchItem(item, opts) {
    const { apiKeys, model, genre, glossaryDict, customFolder, signal, stayOnModel = false, maxLanes = null } = opts;
    const backendBase = getBackendBase();

    // Step 1: Extract Audio (if video or not already an mp3)
    Object.assign(item, {
      status: 'extracting', progress: 0, progressText: 'Extracting Audio...', progressNote: '',
      startedAt: Date.now(), extractStartedAt: Date.now(), transcribeStartedAt: 0, repairStartedAt: 0,
      chunkDone: 0, chunkTotal: 0, repairDone: 0, repairTotal: 0, elapsedMs: 0,
      apiSaver: localStorage.getItem('aiDubberApiSaver') === 'true'
    });
    renderQueueTable();

    let audioPath = null;
    let audioBase64 = null;

    if (item.filePath) {
      // Local path available on Electron
      const ext = (item.fileExt || '').toLowerCase();
      if (['mp3', 'wav', 'm4a'].includes(ext)) {
        audioPath = item.filePath;
      } else {
        const extractRes = await fetch(`${backendBase}/api/extract-audio`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            videoPath: item.filePath,
            videoName: item.fileName,
            partIndex: item.partIndex || 1,
            customFolder,
            sourceFilePath: item.filePath
          }),
          signal
        });
        const extractData = await extractRes.json();
        if (!extractData.success || !extractData.audioPath) {
          throw new Error(extractData.error || 'Failed to extract audio with FFmpeg');
        }
        audioPath = extractData.audioPath;
      }
    } else if (item.rawFile) {
      // Browser File object (upload via FormData)
      const formData = new FormData();
      formData.append('videoFile', item.rawFile);
      formData.append('videoName', item.fileName);
      formData.append('partIndex', '1');
      formData.append('customFolder', customFolder);

      const extractRes = await fetch(`${backendBase}/api/extract-audio`, {
        method: 'POST',
        body: formData,
        signal
      });
      const extractData = await extractRes.json();
      if (!extractData.success || !extractData.audioPath) {
        throw new Error(extractData.error || 'Failed to extract audio from uploaded file');
      }
      audioPath = extractData.audioPath;
    } else {
      throw new Error('No valid file source found for this queue item');
    }

    // Step 2: Gemini Transcribe & Translate
    item.status = 'transcribing';
    item.progress = 10;
    item.progressText = 'Transcribing with Gemini...';
    item.transcribeStartedAt = Date.now();
    renderQueueTable();

    // Start progress polling
    const pollInterval = setInterval(async () => {
      try {
        const pRes = await fetch(`${backendBase}/api/transcribe-progress?requestId=${encodeURIComponent(item.requestId)}`);
        const pData = await pRes.json();
        if (pData.success && pData.total > 0) {
          // Only store what the server said; updateProgressDom() turns it into % every second.
          item.chunkDone = pData.done;
          item.chunkTotal = pData.total;
          // After the last chunk the server double-checks gaps / fills missing Khmer, and says so in
          // `note` with "(x/y)" (also "Google is busy - retrying..." while waiting).
          item.progressNote = pData.note || '';
          if (pData.done >= pData.total && !item.repairStartedAt) item.repairStartedAt = Date.now();
          const m = item.repairStartedAt && /\((\d+)\/(\d+)\)/.exec(item.progressNote);
          item.repairDone = m ? +m[1] : 0;
          item.repairTotal = m ? +m[2] : 0;
        }
      } catch (e) {}
    }, 1500);

    let transcribeResult = null;
    try {
      const transcribeRes = await fetch(`${backendBase}/api/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioPath,
          videoName: item.fileName,
          duration: item.duration || 60,
          genre,
          dramaRegister: genre,
          glossary: glossaryDict,
          apiKey: apiKeys[0],
          apiKeys,
          model,
          requestId: item.requestId,
          customFolder,
          sourceFilePath: item.filePath,
          apiSaver: localStorage.getItem('aiDubberApiSaver') === 'true',
          stayOnModel,
          ...(maxLanes ? { maxLanes } : {})
        }),
        signal
      });

      transcribeResult = await transcribeRes.json();
    } finally {
      clearInterval(pollInterval);
    }

    if (!transcribeResult || !transcribeResult.success) {
      const err = new Error(transcribeResult?.message || transcribeResult?.error || 'Gemini transcription failed');
      err.isDailyQuota = !!transcribeResult?.isDailyQuota;
      throw err;
    }

    const rawCues = transcribeResult.data || transcribeResult.subtitles || transcribeResult.cues || [];
    if (!Array.isArray(rawCues) || rawCues.length === 0) {
      throw new Error('No spoken dialogue detected in audio.');
    }

    // Standardize cues
    const standardized = rawCues.map((c, i) => ({
      id: i + 1,
      start: c.start || '00:00.00',
      end: c.end || '00:00.00',
      text: c.text || c.khmer || '',
      originalText: c.originalText || c.source || '',
      gender: c.gender || 'Female',
      emotion: c.emotion || 'Neutral'
    }));

    // The server's missed-dialogue / translation pass didn't finish: the tab may have holes
    // or lines without Khmer. Fix Missing fills them.
    const rep = transcribeResult.repair || {};
    item.repairIncomplete = !!(rep.gapsSkippedForTime || rep.gapsFailed || rep.quotaError || rep.stillUntranslated);

    item.fallbackModels = transcribeResult.fallbackModels || [];

    item.subtitles = standardized;
    item.cuesCount = standardized.length;
    item.srtText = cuesToSrt(standardized);
    item.status = 'completed';
    item.progress = 100;
    item.elapsedMs = Date.now() - item.startedAt;
    learnTranscribeRate(item);
    item.progressText = 'Completed';

    // Auto-save SRT file
    try {
      await fetch(`${backendBase}/api/save-srt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: item.srtText,
          fileName: (item.fileName || '').replace(/\.[^/.]+$/, ''), // EP01.mp4 -> EP01.srt
          sourceFilePath: item.filePath,
          customFolder
        })
      });
    } catch (e) {
      console.warn('[DAI Studio] Auto-save SRT warning:', e);
    }

    // From "Transcribe All Tabs": the transcript goes straight back into its tab (in the
    // background - no tab switch), with original text / gender / emotion, like a normal Transcribe.
    if (item.autoApplyToTab && item.targetTab) {
      const bridge = window.dubberBridge;
      if (bridge && bridge.applyTranscriptToTab(item.targetTab, rawCues)) {
        item.appliedToTab = true;
      } else {
        showToast(`"${episodeName(item.fileName)}": its tab was closed - the SRT is saved, use "Open All as Dubber Tabs" to load it.`, 'warning');
      }
    }

    renderQueueTable();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PREVIEW / SUBTITLE EDITOR DRAWER
  // ──────────────────────────────────────────────────────────────────────────

  function previewItem(itemId) {
    const item = state.queue.find(q => q.id === itemId);
    if (!item || !item.subtitles || item.subtitles.length === 0) {
      showToast('No subtitles available for this item.', 'warning');
      return;
    }

    state.selectedPreviewItem = item;
    const modal = $('dai-preview-modal');
    const titleEl = $('dai-preview-title');
    const tableBody = $('dai-preview-table-body');
    const countEl = $('dai-preview-lines-count');

    if (titleEl) titleEl.textContent = `Subtitle Preview: ${item.fileName}`;
    if (countEl) countEl.textContent = `${item.subtitles.length} Lines`;

    renderPreviewCuesTable();
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
    }
  }

  function closePreviewModal() {
    const modal = $('dai-preview-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
    state.selectedPreviewItem = null;
  }

  function renderPreviewCuesTable(filterKeyword = '') {
    const item = state.selectedPreviewItem;
    const tableBody = $('dai-preview-table-body');
    if (!item || !tableBody) return;

    const kw = filterKeyword.toLowerCase().trim();
    const cues = item.subtitles.filter(c => {
      if (!kw) return true;
      return (c.text || '').toLowerCase().includes(kw) ||
             (c.originalText || '').toLowerCase().includes(kw) ||
             (c.gender || '').toLowerCase().includes(kw);
    });

    tableBody.innerHTML = cues.map((cue, idx) => {
      const genderBg = cue.gender === 'Male' ? 'bg-sky-500/20 text-sky-300 border-sky-500/40' : 'bg-pink-500/20 text-pink-300 border-pink-500/40';
      return `
        <tr class="border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)]/30 text-xs">
          <td class="px-2.5 py-2 font-mono text-[var(--text-muted)] text-center w-12">${idx + 1}</td>
          <td class="px-2.5 py-2 font-mono text-[var(--text-secondary)] whitespace-nowrap w-36">
            <div class="flex items-center gap-1 text-[11px]">
              <span>${escapeHtml(cue.start)}</span>
              <span class="text-[var(--text-muted)]">➔</span>
              <span>${escapeHtml(cue.end)}</span>
            </div>
          </td>
          <td class="px-2 py-2 w-24">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold border ${genderBg}">
              ${escapeHtml(cue.gender || 'Female')}
            </span>
          </td>
          <td class="px-2.5 py-2 text-[var(--text-muted)] text-[11px] max-w-[200px] truncate" title="${escapeHtml(cue.originalText || '')}">
            ${escapeHtml(cue.originalText || '-')}
          </td>
          <td class="px-2.5 py-2">
            <input type="text"
              class="w-full h-7 px-2 rounded border border-[var(--border-light)] bg-[var(--bg-base)] text-xs text-[var(--text-primary)] focus:border-indigo-400 outline-none font-khmer"
              value="${escapeHtml(cue.text || '')}"
              onchange="window.daiStudio.updateCueText(${cue.id}, this.value)" />
          </td>
        </tr>
      `;
    }).join('');
  }

  function updateCueText(cueId, newText) {
    if (!state.selectedPreviewItem) return;
    const cue = state.selectedPreviewItem.subtitles.find(c => c.id === cueId);
    if (cue) {
      cue.text = newText;
      state.selectedPreviewItem.srtText = cuesToSrt(state.selectedPreviewItem.subtitles);
    }
  }

  function savePreviewChanges() {
    if (!state.selectedPreviewItem) return;
    state.selectedPreviewItem.srtText = cuesToSrt(state.selectedPreviewItem.subtitles);
    
    // Save to disk if on Electron
    const backendBase = getBackendBase();
    fetch(`${backendBase}/api/save-srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: state.selectedPreviewItem.srtText,
        fileName: (state.selectedPreviewItem.fileName || '').replace(/\.[^/.]+$/, ''),
        sourceFilePath: state.selectedPreviewItem.filePath,
        customFolder: state.outputFolder
      })
    }).then(() => {
      showToast('Subtitle edits saved successfully!', 'success');
      closePreviewModal();
      renderQueueTable();
    }).catch(e => {
      showToast('Edits updated in memory.', 'info');
      closePreviewModal();
      renderQueueTable();
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // EXPORT & DUBBER PRO INTEGRATION
  // ──────────────────────────────────────────────────────────────────────────

  function exportItemSrt(itemId) {
    const item = state.queue.find(q => q.id === itemId);
    if (!item || !item.srtText) {
      showToast('No SRT data available for this item.', 'warning');
      return;
    }
    const cleanName = (item.fileName || 'subtitles').replace(/\.[^/.]+$/, '');
    triggerDownload(item.srtText, `${cleanName}.srt`, 'text/plain;charset=utf-8');
    showToast(`Downloaded ${cleanName}.srt`, 'success');
  }

  async function exportAllSrts() {
    const completedItems = state.queue.filter(q => q.status === 'completed' && q.srtText);
    if (completedItems.length === 0) {
      showToast('No completed subtitle files to export.', 'info');
      return;
    }

    const backendBase = getBackendBase();
    const payload = {
      items: completedItems.map(item => ({
        fileName: (item.fileName || '').replace(/\.[^/.]+$/, ''),
        content: item.srtText,
        sourceFilePath: item.filePath
      })),
      customFolder: state.outputFolder
    };

    try {
      const res = await fetch(`${backendBase}/api/batch-save-srts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast(`Saved ${data.savedCount} SRT file(s) to transcribe output folder!`, 'success');
      } else {
        // Fallback: download one by one
        completedItems.forEach(item => exportItemSrt(item.id));
      }
    } catch (e) {
      completedItems.forEach(item => exportItemSrt(item.id));
    }
  }

  // "transcribe_<episode>_part01.mp3" -> "<episode>_part01": the name the user knows the episode by.
  const episodeName = (fileName) => String(fileName || 'video').replace(/\.[^/.]+$/, '').replace(/^transcribe_(\d+_)?/i, '');

  // Opens a finished item as a new Dubber tab with its subtitles. Returns the new tab's number, or 0.
  async function openItemAsTab(item) {
    const bridge = window.dubberBridge;
    const file = item.filePath
      ? { name: item.fileName, path: item.filePath, url: `${getBackendBase()}/api/audio?path=${encodeURIComponent(item.filePath)}` }
      : item.rawFile;
    if (!file) throw new Error('No source file for this item.');
    const idx = await bridge.openTabs([file]);
    if (idx < 0) return 0; // tab limit reached - openTabs already told the user
    if (episodeName(item.fileName) !== item.fileName.replace(/\.[^/.]+$/, '')) bridge.renameActiveTab(episodeName(item.fileName));
    bridge.applySrt(item.srtText, idx);
    return idx + 1;
  }

  // Suggested destination per item: the tab with the same file, else the best name/episode match
  // (each tab used once). 'new' when nothing matches well.
  function suggestTabs(items, tabs) {
    const bridge = window.dubberBridge;
    const pairs = [];
    items.forEach((item, ii) => tabs.forEach((tab, ti) => {
      const score = item.targetTab === tab.ref ? 2000
        : item.filePath && tab.path === item.filePath ? 1000
        : bridge.matchScore(item.fileName, tab.name);
      if (score >= 40) pairs.push({ ii, ti, score });
    }));
    pairs.sort((a, b) => b.score - a.score);
    const choice = items.map(() => 'new');
    const usedTabs = new Set();
    for (const { ii, ti } of pairs) {
      if (choice[ii] !== 'new' || usedTabs.has(ti)) continue;
      choice[ii] = ti;
      usedTabs.add(ti);
    }
    return choice;
  }

  // "Load into which tab?" - one row per item. Resolves to [tab index | 'new'] per item, or null on cancel.
  function chooseTargetTabs(items, tabs) {
    return new Promise((resolve) => {
      const suggested = suggestTabs(items, tabs);
      const overlay = document.createElement('div');
      overlay.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm';
      const tabOption = (tab, ti, selected) => `<option value="${ti}" ${selected ? 'selected' : ''}>Tab ${tab.number}: ${escapeHtml(tab.name)}${tab.lines ? ` (${tab.lines} lines - replaced)` : ''}</option>`;
      overlay.innerHTML = `
        <div class="bg-[var(--bg-panel)] border border-indigo-500/40 rounded-2xl w-[680px] max-w-[94vw] max-h-[80vh] flex flex-col shadow-2xl text-[var(--text-primary)]">
          <div class="p-4 border-b border-[var(--border-color)]">
            <h3 class="text-sm font-bold text-white">Load into which Dubber tab?</h3>
            <p class="text-[11px] text-[var(--text-secondary)] mt-1">Matching tabs are picked for you. A tab that already has subtitles gets them replaced (Ctrl+Z undoes it).</p>
          </div>
          <div class="p-4 flex flex-col gap-2 overflow-y-auto custom-scrollbar">
            ${items.map((item, ii) => `
              <div class="flex items-center gap-3 text-xs">
                <span class="flex-1 min-w-0 truncate font-khmer" title="${escapeHtml(item.fileName)}">${escapeHtml(episodeName(item.fileName))}</span>
                <span class="text-[var(--text-muted)]">➔</span>
                <select data-target-row="${ii}" class="w-[300px] shrink-0 bg-[var(--bg-base)] border border-[var(--border-light)] rounded-lg px-2 py-1.5 outline-none focus:border-indigo-400 font-khmer">
                  <option value="new" ${suggested[ii] === 'new' ? 'selected' : ''}>➕ New tab</option>
                  ${tabs.map((tab, ti) => tabOption(tab, ti, suggested[ii] === ti)).join('')}
                </select>
              </div>`).join('')}
          </div>
          <div class="p-4 border-t border-[var(--border-color)] flex justify-end gap-2">
            <button data-act="cancel" class="px-4 py-2 rounded-lg text-xs font-semibold border border-[var(--border-light)] hover:bg-[var(--bg-hover)]">Cancel</button>
            <button data-act="ok" class="px-5 py-2 rounded-lg text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500">Load</button>
          </div>
        </div>`;
      const finish = (value) => { overlay.remove(); resolve(value); };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('[data-act="cancel"]')) return finish(null);
        if (!e.target.closest('[data-act="ok"]')) return;
        const picks = [...overlay.querySelectorAll('[data-target-row]')].map((sel) => (sel.value === 'new' ? 'new' : Number(sel.value)));
        const taken = picks.filter((p) => p !== 'new');
        if (new Set(taken).size !== taken.length) {
          showToast('Two files are going to the same tab - the second would replace the first. Pick another tab or "New tab".', 'warning');
          return;
        }
        finish(picks);
      });
      document.body.appendChild(overlay);
    });
  }

  // Sends finished items to Dubber tabs, asking which tab each goes to when tabs are open.
  async function loadItemsIntoDubber(items) {
    const bridge = window.dubberBridge;
    if (!bridge) {
      showToast('DR Dubber Pro projects engine not loaded.', 'error');
      return;
    }
    const tabs = bridge.tabList();
    const choice = tabs.length ? await chooseTargetTabs(items, tabs) : items.map(() => 'new');
    if (!choice) return;
    const done = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        if (choice[i] === 'new') {
          const number = await openItemAsTab(item);
          if (!number) break; // tab limit
          done.push(`${episodeName(item.fileName)} → Tab ${number} (new)`);
        } else {
          const tab = tabs[choice[i]];
          if (!bridge.applySrtToTab(tab.ref, item.srtText)) {
            showToast(`Tab "${tab.name}" was closed - "${episodeName(item.fileName)}" was not loaded.`, 'warning');
            continue;
          }
          done.push(`${episodeName(item.fileName)} → Tab ${tab.number}`);
        }
      } catch (e) {
        console.error('[DAI Studio] Send to Dubber error:', e);
        showToast(`Could not load "${item.fileName}": ${e.message}`, 'error');
        break;
      }
    }
    if (!done.length) return;
    closeDaiTranscribeModal();
    const list = done.length > 4 ? `${done.slice(0, 4).join(', ')} +${done.length - 4} more` : done.join(', ');
    showToast(`⚡ Loaded: ${list}`, done.length === items.length ? 'success' : 'warning');
  }

  function sendItemToDubber(itemId) {
    const item = state.queue.find(q => q.id === itemId);
    if (!item || !item.srtText) {
      showToast('No subtitles ready to send to Dubber.', 'warning');
      return;
    }
    return loadItemsIntoDubber([item]);
  }

  function sendAllToDubber() {
    const completedItems = state.queue.filter(q => q.status === 'completed' && q.srtText);
    if (completedItems.length === 0) {
      showToast('No completed items to load into Dubber.', 'info');
      return;
    }
    return loadItemsIntoDubber(completedItems);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TAB 2: SRT / VTT SUBTITLE AI TRANSLATOR (LARGE FILE ENGINE)
  // ──────────────────────────────────────────────────────────────────────────

  // Single-file drop zone. Without a drop handler, Electron navigates the window to the file.
  function acceptFileDrop(zone, onFile) {
    zone.addEventListener('dragover', (e) => e.preventDefault());
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) onFile(file);
    });
  }

  function setupTranslatorEvents() {
    const dropzone = $('dai-trans-dropzone');
    const fileInput = $('dai-trans-file-input');

    if (dropzone && fileInput) {
      dropzone.onclick = () => fileInput.click();
      fileInput.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (file) handleTranslatorFile(file);
      };
      acceptFileDrop(dropzone, handleTranslatorFile);
    }

    ['upload', 'raw', 'tabs'].forEach((mode) => {
      $(`dai-trans-mode-${mode}`)?.addEventListener('click', () => setTranslatorMode(mode));
    });
    $('dai-trans-tabs-reload')?.addEventListener('click', () => { if (!state.translator.isRunning) loadTabsIntoTranslator(); });

    $('dai-trans-btn-start')?.addEventListener('click', startSubtitleTranslation);
    $('dai-trans-btn-stop')?.addEventListener('click', stopSubtitleTranslation);
    $('dai-trans-btn-clear')?.addEventListener('click', clearSubtitleTranslator);
  }

  async function handleTranslatorFile(file) {
    state.translator.file = file;
    state.translator.fileName = file.name;
    const text = await file.text();
    state.translator.rawText = text;

    const label = $('dai-trans-file-label');
    if (label) label.textContent = `${file.name} (${formatBytes(file.size)})`;

    // Parse blocks
    const lines = text.split(/\r?\n/).filter(l => l.trim()).length;
    showToast(`Loaded ${file.name} (~${Math.round(lines / 3)} subtitle cues)`, 'info');
  }

  function setTranslatorMode(mode) {
    if (state.translator.isRunning) return;
    state.translator.mode = mode;
    const active = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40';
    const idle = 'px-3 py-1.5 rounded-lg text-xs font-semibold text-[var(--text-secondary)] hover:text-white border border-transparent';
    [['upload', 'dai-trans-upload-area'], ['raw', 'dai-trans-raw-area'], ['tabs', 'dai-trans-tabs-area']].forEach(([m, areaId]) => {
      const btn = $(`dai-trans-mode-${m}`);
      if (btn) btn.className = m === mode ? active : idle;
      const area = $(areaId);
      if (area) {
        area.classList.toggle('hidden', m !== mode);
        if (m === mode) area.classList.add('flex');
      }
    });
    const startLabel = $('dai-trans-btn-start')?.querySelector('span');
    if (startLabel) startLabel.textContent = mode === 'tabs' ? 'Translate All Tabs' : 'Translate Subtitle';
    if (mode === 'tabs') loadTabsIntoTranslator();
  }

  const buildGlossaryDict = () => {
    loadGlossaryFromStorage(); // pick up names saved elsewhere (All Tabs > Make names consistent)
    return state.glossary.length > 0
      ? state.glossary.reduce((acc, cur) => {
          if (cur.original && cur.khmer) acc[cur.original.trim()] = cur.khmer.trim();
          return acc;
        }, {})
      : null;
  };

  // ── All Project Tabs: re-translate every tab's original-language transcript ──
  const TAB_JOB_STATUS = {
    pending: ['Pending', 'text-[var(--text-muted)]'],
    running: ['Translating…', 'text-sky-400'],
    done: ['Done', 'text-emerald-400'],
    failed: ['Failed', 'text-rose-400'],
    skipped: ['Skipped', 'text-[var(--text-muted)]'],
  };

  function loadTabsIntoTranslator() {
    const bridge = window.dubberBridge;
    state.translator.tabJobs = (bridge ? bridge.tabTranscripts() : []).map((t) => ({
      ...t,
      status: t.lines.length ? 'pending' : 'skipped',
      note: t.lines.length ? `${t.lines.length} lines` : t.total ? 'no original-language text - Transcribe it first' : 'no subtitles yet',
    }));
    renderTabJobs();
  }

  function renderTabJobs() {
    const jobs = state.translator.tabJobs;
    const summary = $('dai-trans-tabs-summary');
    if (summary) {
      const ready = jobs.filter((j) => j.lines.length).length;
      summary.textContent = jobs.length ? `${ready} of ${jobs.length} tab(s) can be translated` : 'No project tabs open';
    }
    const list = $('dai-trans-tabs-list');
    if (!list) return;
    list.innerHTML = jobs.map((j, i) => {
      const [label, color] = TAB_JOB_STATUS[j.status];
      return `
        <div class="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-[var(--bg-base)] border border-[var(--border-color)] text-[11px]">
          <span class="font-mono text-[var(--text-muted)] w-5 shrink-0">${i + 1}</span>
          <span class="flex-1 min-w-0 truncate font-semibold text-[var(--text-primary)] font-khmer" title="${escapeHtml(j.name)}">${escapeHtml(j.name)}</span>
          <span class="shrink min-w-0 truncate text-[var(--text-secondary)]" title="${escapeHtml(j.note)}">${escapeHtml(j.note)}</span>
          <span class="shrink-0 font-semibold ${color}">${label}</span>
        </div>`;
    }).join('');
  }

  async function translateAllTabs() {
    const bridge = window.dubberBridge;
    if (!bridge) {
      showToast('DR Dubber Pro projects engine not loaded.', 'error');
      return;
    }
    loadTabsIntoTranslator(); // pick up edits and tabs opened since the list was shown
    const jobs = state.translator.tabJobs.filter((j) => j.status === 'pending');
    if (jobs.length === 0) {
      showToast('No tab has an original-language transcript to translate. Transcribe the tabs first.', 'warning');
      return;
    }
    const apiKeys = getActiveApiKeys();
    if (apiKeys.length === 0) {
      showToast('Please add your Gemini API Key in Settings ➔ General.', 'error');
      document.getElementById('btn-open-settings')?.click();
      return;
    }
    const genre = $('dai-trans-genre-select')?.value || 'historical';
    const model = $('dai-trans-model-select')?.value || getActiveModel();
    const glossaryDict = buildGlossaryDict();
    const stripHtml = $('dai-trans-chk-strip-html')?.checked;
    // One SRT block per line: no blank lines inside the text, and never empty, or the server's
    // positional results would shift.
    const cleanSource = (text) => {
      let t = stripHtml ? text.replace(/<[^>]+>/g, '') : text;
      t = t.replace(/\n\s*\n/g, '\n').trim();
      return t || text.trim() || '...';
    };

    state.translator.isRunning = true;
    state.translator.abortController = new AbortController();
    updateTranslatorButtons();
    const progressBox = $('dai-trans-progress-box');
    const progressBar = $('dai-trans-progress-bar');
    const progressLabel = $('dai-trans-progress-label');
    progressBox?.classList.remove('hidden');

    let doneTabs = 0, changedLines = 0, stoppedFor = null;
    for (let n = 0; n < jobs.length; n++) {
      const job = jobs[n];
      if (!state.translator.isRunning) break;
      if (bridge.isTabBusy(job.ref)) {
        job.status = 'skipped';
        job.note = 'busy (transcribing or voicing)';
        renderTabJobs();
        continue;
      }
      job.status = 'running';
      renderTabJobs();
      if (progressLabel) progressLabel.textContent = `Tab ${n + 1}/${jobs.length}: ${job.name} (${job.lines.length} lines)…`;
      if (progressBar) progressBar.style.width = `${Math.round((n / jobs.length) * 100)}%`;
      const requestId = `daitr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      state.translator.requestId = requestId;
      try {
        const srtText = job.lines
          .map((l, i) => `${i + 1}\n${formatSrtTimestamp(l.textStart)} --> ${formatSrtTimestamp(l.textEnd)}\n${cleanSource(l.source)}`)
          .join('\n\n');
        const res = await fetch(`${getBackendBase()}/api/translate-srt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ srtText, genre, dramaRegister: genre, glossary: glossaryDict, apiKey: apiKeys[0], apiKeys, model, requestId }),
          signal: state.translator.abortController.signal
        });
        const data = await res.json();
        if (data.error === 'CANCELLED') throw Object.assign(new Error('stopped'), { name: 'AbortError' });
        if (!data.success || !Array.isArray(data.data)) {
          throw Object.assign(new Error(data.message || data.error || 'Translation failed'), { code: data.error });
        }
        const results = job.lines
          .map((l, i) => data.data[i] && { id: l.id, text: data.data[i].text, gender: data.data[i].gender, emotion: data.data[i].emotion })
          .filter(Boolean);
        const changed = bridge.applyTabTranslation(job.ref, results);
        if (changed < 0) {
          job.status = 'skipped';
          job.note = 'tab was closed';
        } else {
          job.status = 'done';
          job.note = `${results.length}/${job.lines.length} translated`;
          doneTabs++;
          changedLines += changed;
        }
        renderTranslatorResultsTable(job.lines.map((l, i) => ({ textStart: l.textStart, textEnd: l.textEnd, text: data.data[i]?.text || l.source })));
      } catch (err) {
        job.status = 'failed';
        if (err.name === 'AbortError' || !state.translator.isRunning) {
          job.note = 'stopped';
          renderTabJobs();
          break;
        }
        job.note = err.message;
        // Out of quota or bad keys: every remaining tab would fail the same way.
        if (/RATE_LIMIT|QUOTA|INVALID_API_KEY/i.test(`${err.code || ''} ${err.message}`)) {
          stoppedFor = err.message;
          renderTabJobs();
          break;
        }
      }
      renderTabJobs();
    }

    const stopped = !state.translator.isRunning;
    state.translator.isRunning = false;
    state.translator.requestId = null;
    updateTranslatorButtons();
    if (progressBar) progressBar.style.width = '100%';
    if (progressLabel) progressLabel.textContent = `${doneTabs}/${jobs.length} tab(s) translated`;
    if (stoppedFor) showToast(`Stopped: ${stoppedFor}. Finished tabs are kept - run again later for the rest.`, 'error');
    else if (stopped) showToast(`Translation stopped. ${doneTabs} tab(s) were translated.`, 'warning');
    else showToast(`✓ Translated ${doneTabs}/${jobs.length} tab(s), ${changedLines} line(s) changed. Generate the voices again for those tabs.`, doneTabs === jobs.length ? 'success' : 'warning');
  }

  // Toolbar "DAI Translate All": open the translator on the All Project Tabs queue.
  function openTabsTranslate() {
    openDaiTranscribeModal('translator');
    setTranslatorMode('tabs');
  }

  async function startSubtitleTranslation() {
    if (state.translator.mode === 'tabs') return translateAllTabs();
    let content = state.translator.rawText;
    const rawInput = $('dai-trans-raw-input');
    // In "Raw Subtitle Text" mode the textarea wins, so edits after a first run are used.
    const rawMode = !$('dai-trans-raw-area')?.classList.contains('hidden');
    if ((rawMode || !content) && rawInput && rawInput.value.trim()) {
      content = rawInput.value.trim();
      state.translator.rawText = content;
      state.translator.fileName = 'translated_subtitles.srt';
    }

    if (!content || !content.trim()) {
      showToast('Please upload an SRT/VTT file or paste subtitle text first.', 'warning');
      return;
    }

    const apiKeys = getActiveApiKeys();
    if (apiKeys.length === 0) {
      showToast('Please add your Gemini API Key in Settings ➔ General.', 'error');
      document.getElementById('btn-open-settings')?.click();
      return;
    }

    // Strip HTML Tags if checkbox checked
    const stripHtml = $('dai-trans-chk-strip-html')?.checked;
    if (stripHtml) {
      content = content.replace(/<[^>]+>/g, '');
    }

    const genre = $('dai-trans-genre-select')?.value || 'historical';
    const model = $('dai-trans-model-select')?.value || getActiveModel();
    const glossaryDict = buildGlossaryDict();

    state.translator.isRunning = true;
    state.translator.abortController = new AbortController();
    updateTranslatorButtons();

    const progressBox = $('dai-trans-progress-box');
    const progressBar = $('dai-trans-progress-bar');
    const progressLabel = $('dai-trans-progress-label');
    if (progressBox) progressBox.classList.remove('hidden');

    try {
      showToast('Translating subtitle with Gemini Large File Engine...', 'info');
      const backendBase = getBackendBase();
      const res = await fetch(`${backendBase}/api/translate-srt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          srtText: content,
          genre,
          dramaRegister: genre,
          glossary: glossaryDict,
          apiKey: apiKeys[0],
          apiKeys,
          model,
          requestId: (state.translator.requestId = `daitr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
        }),
        signal: state.translator.abortController.signal
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Subtitle translation failed');
      }

      // Format translated results
      if (window.dubberBridge) {
        const parsed = window.dubberBridge.parseSrt(content);
        if (Array.isArray(data.data)) {
          data.data.forEach((tr, idx) => {
            if (parsed[idx] && tr && tr.text) {
              parsed[idx].text = tr.text;
              if (tr.gender) parsed[idx].gender = tr.gender;
            }
          });
        }
        state.translator.translatedCues = parsed;
        renderTranslatorResultsTable(parsed);
      }

      showToast('Subtitle translation completed!', 'success');
      if (progressLabel) progressLabel.textContent = 'Translation Complete';
    } catch (err) {
      if (progressLabel) progressLabel.textContent = err.name === 'AbortError' ? 'Translation stopped' : 'Translation failed';
      if (err.name === 'AbortError') {
        showToast('Translation stopped.', 'warning');
      } else {
        showToast(`Translation error: ${err.message}`, 'error');
      }
    } finally {
      state.translator.isRunning = false;
      updateTranslatorButtons();
      if (progressBar) progressBar.style.width = '100%';
    }
  }

  function stopSubtitleTranslation() {
    if (state.translator.abortController) {
      state.translator.abortController.abort();
    }
    // Aborting the fetch doesn't stop the server's Gemini calls.
    if (state.translator.requestId) {
      fetch(`${getBackendBase()}/api/cancel-transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: state.translator.requestId })
      }).catch(() => {});
      state.translator.requestId = null;
    }
    state.translator.isRunning = false;
    updateTranslatorButtons();
  }

  function clearSubtitleTranslator() {
    state.translator.file = null;
    state.translator.rawText = '';
    state.translator.translatedCues = [];
    const label = $('dai-trans-file-label');
    if (label) label.textContent = 'Upload .srt or .vtt subtitle file (Recommended UTF-8)';
    const rawInput = $('dai-trans-raw-input');
    if (rawInput) rawInput.value = '';
    const resultsContainer = $('dai-trans-results-container');
    if (resultsContainer) resultsContainer.classList.add('hidden');
    const progressBox = $('dai-trans-progress-box');
    if (progressBox) progressBox.classList.add('hidden');
  }

  function updateTranslatorButtons() {
    const btnStart = $('dai-trans-btn-start');
    const btnStop = $('dai-trans-btn-stop');
    if (btnStart && btnStop) {
      if (state.translator.isRunning) {
        btnStart.classList.add('hidden');
        btnStop.classList.remove('hidden');
      } else {
        btnStart.classList.remove('hidden');
        btnStop.classList.add('hidden');
      }
    }
  }

  function renderTranslatorResultsTable(cues) {
    const container = $('dai-trans-results-container');
    const tableBody = $('dai-trans-results-body');
    const countBadge = $('dai-trans-results-count');

    if (!container || !tableBody) return;
    container.classList.remove('hidden');
    if (countBadge) countBadge.textContent = `${cues.length} Cues Translated`;

    tableBody.innerHTML = cues.map((cue, idx) => {
      const startStr = formatSrtTimestamp(cue.textStart || cue.start || 0);
      const endStr = formatSrtTimestamp(cue.textEnd || cue.end || 0);
      return `
        <tr class="border-b border-[var(--border-color)] hover:bg-[var(--bg-hover)]/30 text-xs">
          <td class="px-2 py-2 font-mono text-[var(--text-muted)] text-center">${idx + 1}</td>
          <td class="px-2 py-2 font-mono text-[var(--text-secondary)] whitespace-nowrap text-[11px]">
            ${startStr} ➔ ${endStr}
          </td>
          <td class="px-2 py-2 font-khmer text-[var(--text-primary)]">
            ${escapeHtml(cue.text || '')}
          </td>
        </tr>
      `;
    }).join('');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TAB 3: KHMER MOVIE TITLE SUGGESTIONS
  // ──────────────────────────────────────────────────────────────────────────

  function setupTitlesEvents() {
    $('dai-titles-btn-suggest')?.addEventListener('click', analyzeAndSuggestTitles);
    $('dai-titles-btn-clear')?.addEventListener('click', clearTitlesForm);
    $('dai-titles-results')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-title-action]');
      if (!btn) return;
      const title = btn.dataset.title || '';
      if (btn.dataset.titleAction === 'apply') applyTitleToProject(title);
      else navigator.clipboard.writeText(title).then(() => showToast(`Copied title: ${title}`, 'success'));
    });

    const dropzone = $('dai-titles-dropzone');
    const fileInput = $('dai-titles-file-input');
    if (dropzone && fileInput) {
      const useContextFile = async (file) => {
        const text = await file.text();
        const contextArea = $('dai-titles-context-input');
        if (contextArea) contextArea.value = text.slice(0, 4000);
        showToast(`Extracted dialogue from ${file.name} for story context!`, 'info');
      };
      dropzone.onclick = () => fileInput.click();
      fileInput.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (file) useContextFile(file);
      };
      acceptFileDrop(dropzone, useContextFile);
    }
  }

  async function analyzeAndSuggestTitles() {
    const titleInput = $('dai-titles-original-input');
    const contextInput = $('dai-titles-context-input');
    const genreSelect = $('dai-titles-genre-select');
    const modelSelect = $('dai-titles-model-select');
    const resultsContainer = $('dai-titles-results');

    const title = titleInput?.value.trim() || '';
    const contextText = contextInput?.value.trim() || '';
    const genre = genreSelect?.value || 'all';
    const model = modelSelect?.value || getActiveModel();

    if (!title && !contextText) {
      showToast('Please enter an Original Movie Title or provide Story Context.', 'warning');
      return;
    }

    const apiKeys = getActiveApiKeys();
    if (apiKeys.length === 0) {
      showToast('Please add your Gemini API Key in Settings ➔ General.', 'error');
      document.getElementById('btn-open-settings')?.click();
      return;
    }

    const btn = $('dai-titles-btn-suggest');
    const btnLabel = $('dai-titles-btn-label');
    const btnIcon = $('dai-titles-btn-icon');

    if (btn) btn.disabled = true;
    if (btnLabel) btnLabel.textContent = 'Analyzing & Generating...';
    if (btnIcon) btnIcon.classList.add('animate-spin');

    try {
      const backendBase = getBackendBase();
      const res = await fetch(`${backendBase}/api/suggest-movie-titles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title || 'Untitled Project',
          contextText,
          genre,
          apiKey: apiKeys[0],
          apiKeys,
          model
        })
      });

      const data = await res.json();
      if (!data.success || !Array.isArray(data.titles) || data.titles.length === 0) {
        throw new Error(data.error || 'Failed to generate title suggestions');
      }

      state.titles.results = data.titles;
      renderTitlesResults(data.titles);
      showToast('Top 10 Khmer Movie Titles generated!', 'success');
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    } finally {
      if (btn) btn.disabled = false;
      if (btnLabel) btnLabel.textContent = '✨ Analyze & Suggest Titles';
      if (btnIcon) btnIcon.classList.remove('animate-spin');
    }
  }

  function clearTitlesForm() {
    const titleInput = $('dai-titles-original-input');
    const contextInput = $('dai-titles-context-input');
    const resultsContainer = $('dai-titles-results');
    if (titleInput) titleInput.value = '';
    if (contextInput) contextInput.value = '';
    if (resultsContainer) resultsContainer.innerHTML = '';
  }

  function renderTitlesResults(titles) {
    const container = $('dai-titles-results');
    if (!container) return;

    container.innerHTML = titles.map((item, idx) => {
      let categoryBadge = '';
      const cat = (item.category || '').toLowerCase();
      if (cat.includes('royal') || cat.includes('epic')) {
        categoryBadge = 'bg-amber-500/15 border-amber-500/30 text-amber-300';
      } else if (cat.includes('romance') || cat.includes('drama')) {
        categoryBadge = 'bg-pink-500/15 border-pink-500/30 text-pink-300';
      } else if (cat.includes('action') || cat.includes('thriller')) {
        categoryBadge = 'bg-rose-500/15 border-rose-500/30 text-rose-300';
      } else {
        categoryBadge = 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300';
      }

      return `
        <div class="p-3.5 rounded-xl border border-[var(--border-light)] bg-[var(--bg-base)] flex flex-col gap-2 hover:border-indigo-400/50 transition-all group">
          <div class="flex items-center justify-between">
            <span class="px-2 py-0.5 rounded-full text-[10px] font-bold border uppercase tracking-wider ${categoryBadge}">
              ${escapeHtml(item.category || 'Movie Title')}
            </span>
            <div class="flex items-center gap-1.5 opacity-90 group-hover:opacity-100">
              <button data-title-action="copy" data-title="${escapeHtml(item.khmerTitle)}"
                class="px-2 py-1 rounded-md text-[11px] font-semibold border border-[var(--border-light)] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-white transition-all flex items-center gap-1">
                <i data-lucide="copy" class="w-3 h-3"></i> Copy
              </button>
              <button data-title-action="apply" data-title="${escapeHtml(item.khmerTitle)}"
                class="px-2 py-1 rounded-md text-[11px] font-bold bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/30 transition-all flex items-center gap-1">
                <i data-lucide="check" class="w-3 h-3"></i> Apply to Tab
              </button>
            </div>
          </div>

          <div class="flex flex-col">
            <h3 class="text-base font-bold text-white font-khmer leading-snug">
              ${escapeHtml(item.khmerTitle)}
            </h3>
            ${item.englishTranslation ? `
              <span class="text-xs text-[var(--text-muted)] font-mono">
                ${escapeHtml(item.englishTranslation)}
              </span>
            ` : ''}
          </div>

          ${item.tagline ? `
            <div class="p-2 rounded-lg bg-[var(--bg-hover)]/40 border border-[var(--border-color)] text-xs text-amber-200/90 font-khmer italic">
              "${escapeHtml(item.tagline)}"
            </div>
          ` : ''}

          ${item.whyItWorks ? `
            <p class="text-[11px] text-[var(--text-secondary)] leading-relaxed">
              ${escapeHtml(item.whyItWorks)}
            </p>
          ` : ''}
        </div>
      `;
    }).join('');

    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function applyTitleToProject(khmerTitle) {
    if (window.dubberBridge && window.dubberBridge.renameActiveTab(khmerTitle)) {
      showToast(`Applied title to Tab: "${khmerTitle}"`, 'success');
    } else {
      navigator.clipboard.writeText(khmerTitle).then(() => showToast(`Copied title: ${khmerTitle}`, 'success'));
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GLOSSARY DICTIONARY MODAL
  // ──────────────────────────────────────────────────────────────────────────

  function openGlossaryModal() {
    loadGlossaryFromStorage();
    const modal = $('dai-glossary-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      renderGlossaryTable();
    }
  }

  function closeGlossaryModal() {
    const modal = $('dai-glossary-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
  }

  function renderGlossaryTable() {
    const body = $('dai-glossary-table-body');
    if (!body) return;

    if (state.glossary.length === 0) {
      body.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-xs text-[var(--text-muted)]">No glossary terms added yet. Add characters below!</td></tr>`;
      return;
    }

    body.innerHTML = state.glossary.map((item, idx) => `
      <tr class="border-b border-[var(--border-color)] text-xs">
        <td class="px-3 py-2 text-center text-[var(--text-muted)] font-mono">${idx + 1}</td>
        <td class="px-3 py-2 font-semibold text-[var(--text-primary)]">${escapeHtml(item.original)}</td>
        <td class="px-3 py-2 font-khmer text-indigo-300 font-bold">${escapeHtml(item.khmer)}</td>
        <td class="px-3 py-2 text-right">
          <button onclick="window.daiStudio.removeGlossaryItem(${idx})" class="p-1 rounded text-rose-400 hover:bg-rose-500/10 transition-colors">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </td>
      </tr>
    `).join('');

    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function addGlossaryItem() {
    const origInput = $('dai-glossary-orig-input');
    const khmerInput = $('dai-glossary-khmer-input');
    if (!origInput || !khmerInput) return;

    const original = origInput.value.trim();
    const khmer = khmerInput.value.trim();
    if (!original || !khmer) {
      showToast('Please enter both Original Name and Khmer Translation.', 'warning');
      return;
    }

    loadGlossaryFromStorage(); // don't overwrite names saved elsewhere since the modal opened
    state.glossary.push({ original, khmer });
    saveGlossaryToStorage();
    renderGlossaryTable();

    origInput.value = '';
    khmerInput.value = '';
    origInput.focus();
  }

  function removeGlossaryItem(idx) {
    state.glossary.splice(idx, 1);
    saveGlossaryToStorage();
    renderGlossaryTable();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // API KEY MANAGEMENT
  // ──────────────────────────────────────────────────────────────────────────

  function openApiKeyModal() {
    const modal = $('dai-apikey-modal');
    if (!modal) return;
    renderApiKeyList();
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setTimeout(() => {
      $('dai-new-apikey-input')?.focus();
    }, 100);
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  function closeApiKeyModal() {
    const modal = $('dai-apikey-modal');
    if (modal) {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
    updateApiStatusDisplay();
  }

  function renderApiKeyList() {
    const listEl = $('dai-apikey-list');
    const countEl = $('dai-apikey-count');
    const keys = getActiveApiKeys();

    if (countEl) countEl.textContent = keys.length;
    if (!listEl) return;

    if (keys.length === 0) {
      listEl.innerHTML = `
        <div class="p-6 text-center text-xs text-[var(--text-muted)] flex flex-col items-center gap-2">
          <i data-lucide="key-round" class="w-8 h-8 text-slate-500 opacity-60"></i>
          <p class="font-medium text-slate-300">No Gemini API keys configured yet</p>
          <p class="text-[11px] max-w-xs text-slate-400">Add an API key above from Google AI Studio to unlock automated batch transcription and translation.</p>
        </div>
      `;
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        window.lucide.createIcons();
      }
      return;
    }

    listEl.innerHTML = keys.map((key, idx) => {
      const masked = key.length > 12 
        ? `${key.slice(0, 8)}••••••••${key.slice(-4)}` 
        : '••••••••••••';
      return `
        <div class="px-3 py-2.5 flex items-center justify-between hover:bg-[var(--bg-hover)] transition-colors group">
          <div class="flex items-center gap-2.5 min-w-0">
            <span class="w-5 h-5 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-[10px] font-bold shrink-0">
              ${idx + 1}
            </span>
            <div class="flex flex-col min-w-0">
              <span class="font-mono text-xs text-slate-200 select-all truncate">${masked}</span>
              <span data-dai-keystatus="${idx}" class="text-[10px] text-emerald-400 flex items-center gap-1 min-w-0">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"></span> Active Key Pool
              </span>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button type="button" title="Copy Key" onclick="window.daiStudio && window.daiStudio.copyApiKey(${idx})"
              class="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-white hover:bg-slate-700/50 transition-colors">
              <i data-lucide="copy" class="w-3.5 h-3.5"></i>
            </button>
            <button type="button" title="Remove Key" onclick="window.daiStudio && window.daiStudio.removeApiKey(${idx})"
              class="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-rose-400 hover:bg-rose-500/10 transition-colors">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');

    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
    refreshKeyStatuses();
  }

  function addApiKey(rawKey) {
    const key = (rawKey || '').trim();
    if (!key) return;

    if (key.length < 20) {
      showToast("API key is too short. Please paste a valid Gemini API Key from Google AI Studio.", "error");
      return;
    }

    let keys = [];
    try {
      keys = JSON.parse(localStorage.getItem('aiDubberApiKeys') || '[]');
      if (!Array.isArray(keys)) keys = [];
    } catch (e) {
      keys = [];
    }

    if (keys.includes(key)) {
      showToast("This API Key is already in your pool.", "warning");
      return;
    }

    keys.push(key);
    localStorage.setItem('aiDubberApiKeys', JSON.stringify(keys));
    if (!localStorage.getItem('aiDubberApiKey')) {
      localStorage.setItem('aiDubberApiKey', key);
    }

    const input = $('dai-new-apikey-input');
    if (input) input.value = '';

    renderApiKeyList();
    updateApiStatusDisplay();
    showToast(`Added Gemini API Key (${keys.length} active in pool)`, "success");

    // Also sync global settings if open
    try { window.dubberBridge?.reloadApiKeys(); } catch (e) {}
  }

  function removeApiKey(index) {
    let keys = [];
    try {
      keys = JSON.parse(localStorage.getItem('aiDubberApiKeys') || '[]');
    } catch (e) {
      keys = [];
    }

    if (index >= 0 && index < keys.length) {
      keys.splice(index, 1);
      localStorage.setItem('aiDubberApiKeys', JSON.stringify(keys));
      if (keys.length > 0) {
        localStorage.setItem('aiDubberApiKey', keys[0]);
      } else {
        localStorage.removeItem('aiDubberApiKey');
      }
      renderApiKeyList();
      updateApiStatusDisplay();
      showToast("API Key removed from pool", "info");

      try { window.dubberBridge?.reloadApiKeys(); } catch (e) {}
    }
  }

  function copyApiKey(index) {
    const keys = getActiveApiKeys();
    if (index >= 0 && index < keys.length) {
      navigator.clipboard.writeText(keys[index]).then(() => {
        showToast("API Key copied to clipboard", "success");
      }).catch(() => {
        showToast("Failed to copy API key", "error");
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // EVENT LISTENERS & SETUP
  // ──────────────────────────────────────────────────────────────────────────

  function setupEventListeners() {
    // Top Tabs
    $('dai-tab-btn-batch')?.addEventListener('click', () => switchTab('batch'));
    $('dai-tab-btn-translator')?.addEventListener('click', () => switchTab('translator'));
    $('dai-tab-btn-titles')?.addEventListener('click', () => switchTab('titles'));

    // Model Select Synchronization
    const onModelChange = (e) => {
      const val = e.target.value;
      if (!val) return;
      localStorage.setItem('aiDubberModel', val);
      ['dai-model-select', 'dai-trans-model-select', 'dai-titles-model-select'].forEach(id => {
        const el = $(id);
        if (el && el !== e.target) el.value = val;
      });
      const settingSelect = $('setting-ai-model');
      if (settingSelect) settingSelect.value = val;
      const settingLabel = $('gemini-model-label');
      if (settingLabel) {
        const opt = e.target.selectedOptions?.[0];
        if (opt) settingLabel.textContent = opt.textContent;
      }
    };
    $('dai-model-select')?.addEventListener('change', onModelChange);
    $('dai-trans-model-select')?.addEventListener('change', onModelChange);
    $('dai-titles-model-select')?.addEventListener('change', onModelChange);

    // Modal Close
    $('dai-btn-close-modal')?.addEventListener('click', closeDaiTranscribeModal);

    // Queue Inputs
    $('dai-btn-add-tabs')?.addEventListener('click', addDubberTabsToQueue);
    $('dai-btn-add-files')?.addEventListener('click', async () => {
      try {
        if (window.electronAPI && typeof window.electronAPI.openMultiFile === 'function') {
          const res = await window.electronAPI.openMultiFile({
            title: 'Select Audio / Video Files for Batch Transcribe',
            filters: [
              { name: 'Supported Media & Subtitles', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'ts', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'srt', 'vtt'] },
              { name: 'All Files', extensions: ['*'] }
            ]
          });
          if (res && !res.canceled && Array.isArray(res.files)) {
            addFilesToQueue(res.files);
          }
        } else {
          $('dai-hidden-file-input')?.click();
        }
      } catch (e) {
        $('dai-hidden-file-input')?.click();
      }
    });

    $('dai-hidden-file-input')?.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) addFilesToQueue(files);
      e.target.value = '';
    });

    // Add Entire Folder
    $('dai-btn-add-folder')?.addEventListener('click', async () => {
      try {
        if (window.electronAPI && typeof window.electronAPI.selectFolder === 'function') {
          const res = await window.electronAPI.selectFolder({ title: 'Select Folder with Episodes / Media' });
          if (res && !res.canceled && res.path) {
            showToast(`Scanning folder: ${res.path}...`, 'info');
            const scanRes = await fetch(`${getBackendBase()}/api/episodes/scan`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folder: res.path })
            });
            const scanData = await scanRes.json();
            if (scanData.success && Array.isArray(scanData.files) && scanData.files.length > 0) {
              const usable = scanData.files.filter(f => !f.error).map(f => ({
                filePath: f.path,
                fileName: f.name,
                fileUrl: `${getBackendBase()}/api/audio?path=${encodeURIComponent(f.path)}`
              }));
              addFilesToQueue(usable);
            } else {
              showToast('No video/audio files found in this folder.', 'warning');
            }
          }
        }
      } catch (err) {
        showToast(`Could not scan folder: ${err.message}`, 'error');
      }
    });

    // Drag and Drop
    const dropzone = $('dai-queue-dropzone');
    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('border-indigo-400', 'bg-indigo-500/10');
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('border-indigo-400', 'bg-indigo-500/10');
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('border-indigo-400', 'bg-indigo-500/10');
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length > 0) addFilesToQueue(files);
      });
    }

    // A drop that misses a drop zone would navigate the app away to the dropped file.
    const studioModal = $('modal-dai-transcribe');
    ['dragover', 'drop'].forEach(type => document.addEventListener(type, (e) => {
      if (studioModal && !studioModal.classList.contains('hidden')) e.preventDefault();
    }));

    // Output Folder Change
    $('dai-btn-change-output')?.addEventListener('click', async () => {
      try {
        if (window.electronAPI && typeof window.electronAPI.selectFolder === 'function') {
          const res = await window.electronAPI.selectFolder({
            title: 'Select Destination Folder for Transcribed SRTs & Audio',
            defaultPath: state.outputFolder || ''
          });
          if (res && !res.canceled && res.path) {
            state.outputFolder = res.path;
            localStorage.setItem('aiDubberAutoSaveSrtCustomPath', res.path);
            updateOutputFolderDisplay();
            showToast(`Output folder set to: ${res.path}`, 'success');
          }
        }
      } catch (e) {}
    });

    // Batch Action Buttons
    $('dai-btn-start-batch')?.addEventListener('click', startBatch);
    $('dai-btn-stop-batch')?.addEventListener('click', stopBatch);
    $('dai-btn-clear-queue')?.addEventListener('click', clearQueue);
    $('dai-btn-export-all')?.addEventListener('click', exportAllSrts);
    $('dai-btn-send-all-dubber')?.addEventListener('click', sendAllToDubber);

    // Glossary Modal Buttons
    $('dai-btn-open-glossary')?.addEventListener('click', openGlossaryModal);
    $('dai-btn-close-glossary')?.addEventListener('click', closeGlossaryModal);
    $('dai-btn-add-glossary-item')?.addEventListener('click', addGlossaryItem);

    // API Key Modal Buttons
    $('dai-btn-close-apikey-modal')?.addEventListener('click', closeApiKeyModal);
    $('dai-btn-add-apikey')?.addEventListener('click', () => {
      const input = $('dai-new-apikey-input');
      if (input) addApiKey(input.value);
    });
    $('dai-new-apikey-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addApiKey(e.target.value);
      }
    });
    $('dai-btn-toggle-apikey-visibility')?.addEventListener('click', () => {
      const input = $('dai-new-apikey-input');
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    $('dai-btn-paste-apikey')?.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        const input = $('dai-new-apikey-input');
        if (input && text) {
          input.value = text.trim();
          input.focus();
        }
      } catch (e) {}
    });
    $('dai-btn-open-full-settings')?.addEventListener('click', () => {
      closeApiKeyModal();
      document.getElementById('btn-open-settings')?.click();
      setTimeout(() => {
        const apiTab = document.querySelector('.settings-tab-btn[data-target="settings-api"]');
        if (apiTab) apiTab.click();
      }, 150);
    });

    // Preview Modal Buttons
    $('dai-btn-close-preview')?.addEventListener('click', closePreviewModal);
    $('dai-btn-save-preview-changes')?.addEventListener('click', savePreviewChanges);
    $('dai-preview-search-input')?.addEventListener('input', (e) => {
      renderPreviewCuesTable(e.target.value);
    });

    // Setup Tab 2 & Tab 3
    setupTranslatorEvents();
    setupTitlesEvents();
  }

  // Expose global controller
  window.daiStudio = {
    open: openDaiTranscribeModal,
    close: closeDaiTranscribeModal,
    switchTab,
    previewItem,
    closePreviewModal,
    removeItem: removeQueueItem,
    translateAllTabs: openTabsTranslate,
    transcribeAllTabs,
    stopBatch,
    isBatchRunning: () => state.isBatchRunning,
    retryItem: (id) => {
      const item = state.queue.find(q => q.id === id);
      if (item) {
        item.status = 'pending';
        item.error = null;
        renderQueueTable();
      }
    },
    exportItemSrt,
    sendItemToDubber,
    updateCueText,
    openGlossaryModal,
    closeGlossaryModal,
    // Called after another part of the app saved names to the shared glossary.
    reloadGlossary: () => {
      loadGlossaryFromStorage();
      if (!$('dai-glossary-modal')?.classList.contains('hidden')) renderGlossaryTable();
    },
    removeGlossaryItem,
    openApiKeyModal,
    closeApiKeyModal,
    addApiKey,
    removeApiKey,
    copyApiKey,
    applyTitleToProject
  };

  // Auto-init once DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDaiTranscribeStudio);
  } else {
    initDaiTranscribeStudio();
  }
})();
