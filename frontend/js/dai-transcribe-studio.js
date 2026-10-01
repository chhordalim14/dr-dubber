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
    activeItemId: null,
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

  async function addFilesToQueue(files, { quiet = false } = {}) {
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const isElectronObj = f && typeof f === 'object' && f.filePath;
      const fileName = isElectronObj ? f.fileName : f.name;
      const filePath = isElectronObj ? f.filePath : (f.path || null);
      const size = isElectronObj ? 0 : (f.size || 0);

      // Check if already in queue
      const existing = state.queue.find(q => (filePath && q.filePath === filePath) || q.fileName === fileName);
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

  function renderQueueTable() {
    const list = $('dai-queue-list');
    const emptyState = $('dai-queue-empty');
    const countBadge = $('dai-queue-count-badge');
    const statsSummary = $('dai-queue-stats-summary');
    const overallBar = $('dai-overall-progress-bar');
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

    if (overallBar) {
      const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
      overallBar.style.width = `${pct}%`;
    }

    if (total === 0) {
      if (emptyState) emptyState.classList.remove('hidden');
      list.innerHTML = '';
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
        statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center gap-1 animate-pulse">
          <i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Extracting Audio
        </span>`;
      } else if (item.status === 'transcribing') {
        statusBadge = `<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 flex items-center gap-1 animate-pulse">
          <i data-lucide="sparkles" class="w-3.5 h-3.5 animate-spin"></i> ${escapeHtml(item.progressText || 'AI Transcribing')}
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
            <div class="flex flex-col gap-1 min-w-[150px]">
              <div class="flex items-center justify-between">
                ${statusBadge}
                ${item.progress > 0 && item.status !== 'completed' ? `<span class="text-[10px] font-mono text-indigo-400 font-bold">${item.progress}%</span>` : ''}
              </div>
              ${item.status === 'transcribing' || item.status === 'extracting' ? `
                <div class="w-full h-1 rounded-full bg-[var(--bg-base)] overflow-hidden">
                  <div class="h-full bg-gradient-to-r from-indigo-500 to-cyan-400 transition-all duration-300" style="width: ${Math.max(item.progress, 15)}%"></div>
                </div>
              ` : ''}
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
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BATCH EXECUTION RUNNER
  // ──────────────────────────────────────────────────────────────────────────

  async function startBatch() {
    if (state.isBatchRunning) return;

    const apiKeys = getActiveApiKeys();
    if (apiKeys.length === 0) {
      showToast('Please add at least one Gemini API Key in Settings ➔ General.', 'error');
      document.getElementById('btn-open-settings')?.click();
      return;
    }

    const pendingItems = state.queue.filter(q => q.status === 'pending' || q.status === 'failed');
    if (pendingItems.length === 0) {
      showToast('No pending files to process in the queue.', 'info');
      return;
    }

    state.isBatchRunning = true;
    state.batchAbortController = new AbortController();
    updateBatchControlsState();

    const genre = $('dai-genre-select')?.value || 'historical';
    const model = $('dai-model-select')?.value || getActiveModel();
    const customFolder = state.outputFolder || localStorage.getItem('aiDubberAutoSaveSrtCustomPath') || '';
    const glossaryDict = state.glossary.length > 0
      ? state.glossary.reduce((acc, cur) => {
          if (cur.original && cur.khmer) acc[cur.original.trim()] = cur.khmer.trim();
          return acc;
        }, {})
      : null;

    showToast(`🚀 Starting Batch Transcribe for ${pendingItems.length} file(s)...`, 'info');

    for (let i = 0; i < pendingItems.length; i++) {
      if (!state.isBatchRunning || state.batchAbortController?.signal.aborted) break;
      const item = pendingItems[i];
      state.activeItemId = item.id;

      try {
        await processSingleBatchItem(item, {
          apiKeys,
          model,
          genre,
          glossaryDict,
          customFolder,
          signal: state.batchAbortController.signal
        });
      } catch (err) {
        if (err.name === 'AbortError') {
          showToast('Batch transcription stopped.', 'warning');
          break;
        }
        item.status = 'failed';
        item.error = err.message || 'Processing failed';
        console.error(`[DAI Batch] Error processing ${item.fileName}:`, err);
        renderQueueTable();
      }
    }

    state.isBatchRunning = false;
    state.activeItemId = null;
    updateBatchControlsState();
    renderQueueTable();

    const successCount = state.queue.filter(q => q.status === 'completed').length;
    showToast(`🎉 Batch processing finished! ${successCount}/${state.queue.length} completed.`, 'success');
  }

  function stopBatch() {
    if (state.batchAbortController) {
      state.batchAbortController.abort();
    }
    // Aborting the fetch doesn't stop the server's Gemini calls - cancel those too, and mark
    // the interrupted file as failed so it can be retried.
    const current = state.queue.find(q => q.id === state.activeItemId);
    if (current && current.status !== 'completed') {
      fetch(`${getBackendBase()}/api/cancel-transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: current.requestId })
      }).catch(() => {});
      current.status = 'failed';
      current.error = 'Stopped';
    }
    state.isBatchRunning = false;
    state.activeItemId = null;
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
    const { apiKeys, model, genre, glossaryDict, customFolder, signal } = opts;
    const backendBase = getBackendBase();

    // Step 1: Extract Audio (if video or not already an mp3)
    item.status = 'extracting';
    item.progress = 10;
    item.progressText = 'Extracting Audio...';
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
    item.progress = 30;
    item.progressText = 'Transcribing with Gemini...';
    renderQueueTable();

    // Start progress polling
    const pollInterval = setInterval(async () => {
      try {
        const pRes = await fetch(`${backendBase}/api/transcribe-progress?requestId=${encodeURIComponent(item.requestId)}`);
        const pData = await pRes.json();
        if (pData.success && pData.total > 0) {
          const chunkPct = Math.round((pData.done / pData.total) * 60) + 30;
          item.progress = Math.min(90, chunkPct);
          // After the last chunk the server double-checks gaps / fills missing Khmer, and says so in `note`
          // (also "Google is busy - retrying..." while waiting) - show it instead of a frozen "chunk 2/2".
          item.progressText = pData.note && (pData.done >= pData.total || /retrying/i.test(pData.note))
            ? pData.note
            : `Transcribing chunk ${pData.done}/${pData.total}...`;
          renderQueueTable();
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
          apiSaver: localStorage.getItem('aiDubberApiSaver') === 'true'
        }),
        signal
      });

      transcribeResult = await transcribeRes.json();
    } finally {
      clearInterval(pollInterval);
    }

    if (!transcribeResult || !transcribeResult.success) {
      throw new Error(transcribeResult?.message || transcribeResult?.error || 'Gemini transcription failed');
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

    item.subtitles = standardized;
    item.cuesCount = standardized.length;
    item.srtText = cuesToSrt(standardized);
    item.status = 'completed';
    item.progress = 100;
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

  const buildGlossaryDict = () => state.glossary.length > 0
    ? state.glossary.reduce((acc, cur) => {
        if (cur.original && cur.khmer) acc[cur.original.trim()] = cur.khmer.trim();
        return acc;
      }, {})
    : null;

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
              <span class="text-[10px] text-emerald-400 flex items-center gap-1">
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Active Key Pool
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
