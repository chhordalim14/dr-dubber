// Settings → API → "Translate subtitles with": Google Gemini or CodeCraft API.
//
// CodeCraft (codecraftapi.com) is an OpenAI-compatible gateway: "cc_" keys, many models
// (Gemini, Claude, GPT, DeepSeek ...). The choice and the key list are saved in localStorage and
// sent to the backend (/api/text-ai) at start and on every change; the backend then sends the
// text-only jobs (Whisper + Translate, Fix Missing's re-translation, shorten/rewrite, names,
// titles) to CodeCraft, sharing them over the keys, with the Gemini keys as the last resort.
// Direct (Gemini) transcription listens to the audio, so it always uses Gemini.
//
// window.textAi.ready(): CodeCraft is chosen and has a key and a model - the text tools then
// work without a Gemini key.
(function () {
  // ── Pure helpers (also used by tests/text-ai.test.js) ─────────────────────
  const FAMILIES = [
    { re: /gemini|gemma|palm/i, name: 'Google', letter: 'G', bg: 'linear-gradient(135deg,#84cc16,#22c55e)' },
    { re: /claude|fable|anthropic/i, name: 'Anthropic', letter: 'A', bg: 'linear-gradient(135deg,#e08a5f,#c2410c)' },
    { re: /gpt|chatgpt|openai|^o\d/i, name: 'OpenAI', letter: 'O', bg: 'linear-gradient(135deg,#34d399,#0f766e)' },
    { re: /deepseek/i, name: 'DeepSeek', letter: 'D', bg: 'linear-gradient(135deg,#60a5fa,#4338ca)' },
    { re: /qwen|qwq/i, name: 'Qwen', letter: 'Q', bg: 'linear-gradient(135deg,#a78bfa,#6d28d9)' },
    { re: /seed|doubao/i, name: 'ByteDance', letter: 'S', bg: 'linear-gradient(135deg,#38bdf8,#0369a1)' },
    { re: /llama|meta-/i, name: 'Meta', letter: 'M', bg: 'linear-gradient(135deg,#3b82f6,#1d4ed8)' },
    { re: /mistral|mixtral|codestral/i, name: 'Mistral', letter: 'M', bg: 'linear-gradient(135deg,#fb923c,#ea580c)' },
    { re: /grok/i, name: 'xAI', letter: 'X', bg: 'linear-gradient(135deg,#6b7280,#111827)' },
    { re: /kimi|moonshot/i, name: 'Moonshot', letter: 'K', bg: 'linear-gradient(135deg,#6b7280,#111827)' },
    { re: /glm|zhipu/i, name: 'Zhipu', letter: 'Z', bg: 'linear-gradient(135deg,#60a5fa,#2563eb)' },
    { re: /minimax/i, name: 'MiniMax', letter: 'M', bg: 'linear-gradient(135deg,#fb7185,#be123c)' }
  ];
  const OTHER = { name: 'Other', bg: 'linear-gradient(135deg,#94a3b8,#475569)' };

  function modelFamily(model) {
    const text = `${(model && model.id) || ''} ${(model && model.name) || ''}`;
    const f = FAMILIES.find((x) => x.re.test(text));
    if (f) return f;
    const letter = (String((model && (model.name || model.id)) || '?').match(/[a-z0-9]/i) || ['?'])[0].toUpperCase();
    return { ...OTHER, letter };
  }

  function formatContext(n) {
    if (!(n > 0)) return '';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    return `${Math.round(n / 1000)}K`;
  }
  const money = (n) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

  // "1.0M context · $1.24 / $1.24 per 1M tokens"
  function formatMeta(model) {
    if (!model) return '';
    const parts = [];
    const ctx = formatContext(model.contextWindow);
    if (ctx) parts.push(`${ctx} context`);
    const i = model.inputPer1M, o = model.outputPer1M;
    if (i === 0 && o === 0) parts.push('Free');
    else if (i != null && o != null) parts.push(`${money(i)} / ${money(o)} per 1M tokens`);
    return parts.join(' · ');
  }

  // A sensible first model: the newest Gemini Flash (not Lite), else the first one listed.
  function pickDefaultModel(models) {
    const list = Array.isArray(models) ? models : [];
    const flash = list
      .map((m) => ({ m, v: parseFloat((String(m.id).match(/gemini-(\d+(?:\.\d+)?)-flash(?!-lite)/i) || [])[1]) }))
      .filter((x) => isFinite(x.v))
      .sort((a, b) => b.v - a.v);
    return flash.length ? flash[0].m.id : (list[0] ? list[0].id : '');
  }

  function maskKey(key) {
    const k = String(key || '');
    if (k.length <= 8) return k ? '••••••' : '';
    return `${k.slice(0, 3)}••••••${k.slice(-4)}`;
  }

  // Models grouped by maker, Google first (the drama prompts were tuned on Gemini).
  function groupModels(models) {
    const groups = new Map();
    for (const m of models || []) {
      const f = modelFamily(m);
      if (!groups.has(f.name)) groups.set(f.name, []);
      groups.get(f.name).push(m);
    }
    const order = [...FAMILIES.map((f) => f.name), OTHER.name];
    return [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }

  const helpers = { modelFamily, formatContext, formatMeta, pickDefaultModel, maskKey, groupModels };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;

  // ── Settings card ────────────────────────────────────────────────────────
  // The page is served by the backend itself, so its own origin is the backend.
  const BACKEND = /^https?:$/.test(location.protocol) ? location.origin : 'http://localhost:3001';
  const LS = {
    provider: 'aiDubberTextProvider',
    keys: 'aiDubberCodecraftKeys',
    oldKey: 'aiDubberCodecraftKey', // one key, before the key list
    model: 'aiDubberCodecraftModel',
    backup: 'aiDubberCodecraftBackup',
    models: 'aiDubberCodecraftModels'
  };
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const write = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { } };
  const readJson = (k) => { try { const v = JSON.parse(read(k) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };

  function readKeys() {
    const keys = readJson(LS.keys).map((k) => String(k || '').trim()).filter(Boolean);
    const old = read(LS.oldKey).trim();
    if (old && !keys.includes(old)) keys.unshift(old);
    return keys.filter((k, i, a) => a.indexOf(k) === i);
  }

  const state = {
    provider: read(LS.provider) === 'codecraft' ? 'codecraft' : 'gemini',
    // { key, state: unknown|checking|ok|refused|error|no-credit|cooling, message, retryAfterMs }
    keys: readKeys().map((key) => ({ key, state: 'unknown', message: '', retryAfterMs: 0 })),
    model: read(LS.model),
    backup: read(LS.backup),
    models: readJson(LS.models), // last list seen, so the card shows names and prices offline too
    checkedAt: 0,
    open: null,       // 'main' | 'backup' while its list is open
    draftKey: '',     // what was typed in the add box, kept when adding fails
    adding: false,
    addError: '',
    note: ''
  };

  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const icon = (name) => `<i data-lucide="${name}"></i>`;
  const findModel = (id) => state.models.find((m) => m.id === id) || null;
  const keyList = () => state.keys.map((k) => k.key);

  function ready() {
    return state.provider === 'codecraft' && state.keys.length > 0 && !!state.model;
  }
  function label() {
    if (!ready()) return 'Gemini';
    const m = findModel(state.model);
    return `CodeCraft · ${m ? m.name : state.model}`;
  }

  // Send the choice to the backend. Retried for a few seconds: at start the backend may still be loading.
  let syncTimer = null;
  async function sync(tries = 6) {
    clearTimeout(syncTimer);
    try {
      await fetch(`${BACKEND}/api/text-ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: state.provider, keys: keyList(), model: state.model, backupModel: state.backup })
      });
    } catch (e) {
      if (tries > 1) syncTimer = setTimeout(() => sync(tries - 1), 2000);
    }
  }

  function save() {
    write(LS.provider, state.provider);
    write(LS.keys, state.keys.length ? JSON.stringify(keyList()) : '');
    write(LS.oldKey, '');
    write(LS.model, state.model);
    write(LS.backup, state.backup);
    sync();
  }

  // A fresh model list: keep the chosen models when they are still offered.
  function applyModels(models) {
    if (!Array.isArray(models) || !models.length) return;
    state.models = models;
    write(LS.models, JSON.stringify(models));
    if (!state.model || !findModel(state.model)) {
      const pick = pickDefaultModel(models);
      if (state.model) state.note = `"${state.model}" is no longer offered, so ${findModel(pick).name} was picked instead.`;
      state.model = pick;
    }
    if (state.backup && !findModel(state.backup)) state.backup = '';
  }

  async function postKeys(keys, probe) {
    const res = await fetch(`${BACKEND}/api/codecraft/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys, probe })
    });
    // A web page instead of JSON: the engine running is older than this page (the window was
    // reloaded after an update, but the engine only restarts with the app).
    if (!/json/i.test(res.headers.get('content-type') || '')) {
      throw new Error('The app engine is out of date. Close DR Dubber completely and open it again, then add the key.');
    }
    const data = await res.json();
    if (!data.success) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // probe: ask CodeCraft with each key (and reload the models); otherwise only what the app has
  // seen while working (out of credit, rate-limited).
  async function checkKeys(rows = state.keys, { probe = true } = {}) {
    rows = rows.filter((r) => state.keys.includes(r));
    if (!rows.length) return;
    if (probe) rows.forEach((r) => { r.state = 'checking'; r.message = ''; });
    render();
    try {
      const data = await postKeys(rows.map((r) => r.key), probe);
      rows.forEach((r, i) => {
        const s = (data.keys || [])[i] || {};
        if (!probe && s.state === 'unknown' && r.state !== 'checking') return; // keep the last check's answer
        Object.assign(r, { state: s.state || 'unknown', message: s.message || '', retryAfterMs: s.retryAfterMs || 0 });
      });
      if (probe) {
        state.checkedAt = Date.now();
        if (data.models) { applyModels(data.models); save(); }
      }
    } catch (e) {
      rows.forEach((r) => { if (r.state === 'checking') Object.assign(r, { state: 'error', message: String((e && e.message) || e) }); });
    }
    render();
  }

  async function addKey() {
    const key = state.draftKey.trim();
    if (!key) { state.addError = 'Paste your CodeCraft API key first (it starts with "cc_").'; render(); return; }
    if (keyList().includes(key)) { state.addError = 'This key is already in the list.'; render(); return; }
    state.adding = true;
    state.addError = '';
    render();
    try {
      const data = await postKeys([key], true);
      const s = (data.keys || [])[0] || {};
      if (s.state !== 'ok') throw new Error(s.message || 'CodeCraft did not accept this key.');
      state.keys.push({ key, state: 'ok', message: '', retryAfterMs: 0 });
      state.draftKey = '';
      state.checkedAt = Date.now();
      applyModels(data.models);
      save();
    } catch (e) {
      state.addError = String((e && e.message) || e);
    }
    state.adding = false;
    render();
    const input = root && root.querySelector('[data-role="key-input"]');
    if (input && state.addError) input.focus();
  }

  function openSite() {
    const url = 'https://codecraftapi.com/';
    if (window.electronAPI && typeof window.electronAPI.openExternalUrl === 'function') window.electronAPI.openExternalUrl(url);
    else window.open(url, '_blank', 'noopener');
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  let root = null;

  function tile(model, small) {
    if (!model) return `<span class="tai-tile${small ? ' sm' : ''} is-empty">+</span>`;
    const f = modelFamily(model);
    return `<span class="tai-tile${small ? ' sm' : ''}" style="background:${f.bg}">${esc(f.letter)}</span>`;
  }

  function pickerButton(which) {
    const id = which === 'main' ? state.model : state.backup;
    const m = id ? findModel(id) : null;
    const open = state.open === which;
    let name, meta;
    if (which === 'backup' && !id) {
      name = '<div class="tai-pick-name is-empty">No backup</div>';
      meta = 'Lines the main model leaves behind go to this one';
    } else {
      name = `<div class="tai-pick-name">${esc(m ? m.name : id || 'Choose a model')}</div>`;
      meta = m ? formatMeta(m) : (id ? 'Not in the current list' : '');
    }
    return `<button type="button" class="tai-pick${open ? ' is-open' : ''}" data-act="toggle" data-which="${which}" aria-expanded="${open}">
        ${which === 'backup' && !id ? tile(null) : tile(m || { id })}
        <span class="tai-pick-text">${name}<div class="tai-pick-meta">${esc(meta)}</div></span>
        ${icon('chevron-down')}
      </button>`;
  }

  function modelList(which) {
    const current = which === 'main' ? state.model : state.backup;
    const rows = [];
    if (which === 'backup') {
      rows.push(`<button type="button" class="tai-opt${!current ? ' is-on' : ''}" data-act="pick" data-which="backup" data-id="" data-search="no backup none">
          ${tile(null, true)}<span class="tai-opt-text"><div class="tai-opt-name">No backup</div><div class="tai-opt-meta">Only the main model is used</div></span>${!current ? icon('check') : ''}
        </button>`);
    }
    for (const [group, models] of groupModels(state.models)) {
      const items = models.filter((m) => !(which === 'backup' && m.id === state.model));
      if (!items.length) continue;
      rows.push(`<div class="tai-group" data-group="${esc(group)}">${esc(group)}</div>`);
      for (const m of items) {
        const on = m.id === current;
        rows.push(`<button type="button" class="tai-opt${on ? ' is-on' : ''}" data-act="pick" data-which="${which}" data-id="${esc(m.id)}" data-group="${esc(group)}" data-search="${esc(`${m.name} ${m.id} ${group}`.toLowerCase())}" title="${esc(m.description || m.id)}">
            ${tile(m, true)}<span class="tai-opt-text"><div class="tai-opt-name">${esc(m.name)}</div><div class="tai-opt-meta">${esc(formatMeta(m) || m.id)}</div></span>${on ? icon('check') : ''}
          </button>`);
      }
    }
    return `<div class="tai-list">
        <input type="text" class="tai-search" data-act="search" placeholder="Search ${state.models.length} models…" autocomplete="off" spellcheck="false" />
        <div class="tai-list-scroll">${rows.join('')}<div class="tai-empty" hidden>No model matches.</div></div>
      </div>`;
  }

  // One row's status: dot colour and text.
  function keyStatus(r) {
    switch (r.state) {
      case 'checking': return { dot: 'wait', cls: '', text: 'Checking…' };
      case 'ok': return { dot: 'ok', cls: '', text: 'Connected and working' };
      case 'refused': return { dot: 'bad', cls: 'bad', text: 'Refused by CodeCraft - check or remove this key' };
      case 'no-credit': return { dot: 'warn', cls: 'warn', text: 'Out of credit - top up at codecraftapi.com' };
      case 'cooling': return { dot: 'warn', cls: 'warn', text: `Rate-limited - free again in ${Math.max(1, Math.ceil(r.retryAfterMs / 1000))}s` };
      case 'error': return { dot: 'bad', cls: 'bad', text: r.message || 'Could not check this key' };
      default: return { dot: '', cls: '', text: 'Not checked yet' };
    }
  }

  function keysCard() {
    const n = state.keys.length;
    const head = n === 0 ? 'Add your CodeCraft API key' : n === 1 ? '1 key' : `${n} keys · the work is shared between them`;
    const anyChecking = state.keys.some((r) => r.state === 'checking');
    const rows = state.keys.map((r, i) => {
      const s = keyStatus(r);
      return `<div class="tai-key">
          <span class="tai-key-num">${i + 1}</span>
          <span class="tai-dot ring ${s.dot}"></span>
          <div class="tai-key-text">
            <div class="tai-key-mask">${esc(maskKey(r.key))}</div>
            <div class="tai-key-state ${s.cls}" title="${esc(r.message || s.text)}">${esc(s.text)}</div>
          </div>
          <button type="button" class="tai-icon-btn" data-act="check-key" data-index="${i}" title="Check this key"${r.state === 'checking' ? ' disabled' : ''}>${icon('refresh-cw')}</button>
          <button type="button" class="tai-icon-btn danger" data-act="remove-key" data-index="${i}" title="Remove this key">${icon('trash-2')}</button>
        </div>`;
    }).join('');
    return `<div class="tai-card">
        <div class="tai-keys-head">
          <span>${esc(head)}</span>
          ${n ? `<button type="button" class="tai-icon-btn" data-act="check-all" title="Check every key and reload the models"${anyChecking ? ' disabled' : ''}>${icon('refresh-cw')}</button>` : ''}
        </div>
        ${rows}
        <div class="tai-keyrow">
          <input type="password" class="tai-input" data-role="key-input" placeholder="${n ? 'Add another key: cc_...' : 'cc_...'}" autocomplete="off" spellcheck="false" value="${esc(state.draftKey)}" />
          <button type="button" class="tai-btn tai-btn-primary" data-act="add-key"${state.adding ? ' disabled' : ''}>${state.adding ? 'Checking…' : `${icon('plus')}Add key`}</button>
        </div>
        ${state.addError ? `<div class="tai-msg bad">${icon('circle-alert')}<span>${esc(state.addError)}</span></div>` : ''}
        <button type="button" class="tai-link" data-act="site">${icon('external-link')}Get a key at codecraftapi.com (free: 1M tokens a month)</button>
        <p class="tai-foot">The keys stay on this computer and are only sent to CodeCraft, through the app's own backend. With several keys, every job and every tab of Dub Whole Series starts on the least busy key, and a key that is limited or refused is skipped.</p>
      </div>`;
  }

  function modelsCard() {
    const n = state.models.length;
    return `<div class="tai-card">
        ${state.note ? `<div class="tai-msg warn">${icon('info')}<span>${esc(state.note)}</span></div>` : ''}
        <div class="tai-label-row"><span>Model</span>${n ? `<span class="tai-muted">${n} available</span>` : ''}</div>
        ${pickerButton('main')}
        ${state.open === 'main' ? modelList('main') : ''}
        <div class="tai-label-row"><span>Backup model · <span class="tai-muted">optional</span></span></div>
        ${pickerButton('backup')}
        ${state.open === 'backup' ? modelList('backup') : ''}
        <p class="tai-foot">If every CodeCraft key is refused or out of credit, your Gemini keys take over automatically, so a job never stops halfway.</p>
      </div>`;
  }

  function render() {
    if (!root) return;
    const active = document.activeElement;
    const focusedSearch = active && root.contains(active) && active.classList.contains('tai-search');
    const focusedKey = active && root.contains(active) && active.matches('[data-role="key-input"]');
    const cc = state.provider === 'codecraft';
    root.innerHTML = `<div class="tai">
        <div class="tai-head">${icon('languages')}<span>Translate subtitles with</span></div>
        <div class="tai-seg" role="radiogroup" aria-label="Translate subtitles with">
          <button type="button" role="radio" aria-checked="${!cc}" class="tai-seg-btn${!cc ? ' is-on' : ''}" data-act="provider" data-value="gemini">${icon('sparkles')}Google Gemini</button>
          <button type="button" role="radio" aria-checked="${cc}" class="tai-seg-btn${cc ? ' is-on' : ''}" data-act="provider" data-value="codecraft">${icon('boxes')}CodeCraft API</button>
        </div>
        <p class="tai-note">Used by Whisper + Translate, Fix Missing, shortening and rewriting lines, the name check and title ideas. Direct (Gemini) listens to the audio itself, so it always uses Gemini.</p>
        ${cc ? keysCard() : ''}
        ${cc && state.keys.length ? modelsCard() : ''}
      </div>`;
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try { window.lucide.createIcons({ root }); } catch (e) { }
    }
    if (focusedSearch) { const s = root.querySelector('.tai-search'); if (s) s.focus(); }
    if (focusedKey) { const k = root.querySelector('[data-role="key-input"]'); if (k) { k.focus(); k.setSelectionRange(k.value.length, k.value.length); } }
  }

  // Filtering hides rows in place (re-rendering would take the focus away from the search box).
  function filterList(input) {
    const list = input.closest('.tai-list');
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    const visibleGroups = new Set();
    list.querySelectorAll('.tai-opt').forEach((opt) => {
      const hit = !q || (opt.dataset.search || '').includes(q);
      opt.hidden = !hit;
      if (hit) { shown++; if (opt.dataset.group) visibleGroups.add(opt.dataset.group); }
    });
    list.querySelectorAll('.tai-group').forEach((g) => { g.hidden = !!q && !visibleGroups.has(g.dataset.group); });
    const empty = list.querySelector('.tai-empty');
    if (empty) empty.hidden = shown > 0;
  }

  function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el) || el.disabled) return;
    const act = el.dataset.act;
    const row = el.dataset.index != null ? state.keys[Number(el.dataset.index)] : null;
    if (act === 'provider') {
      if (state.provider === el.dataset.value) return;
      state.provider = el.dataset.value;
      state.open = null;
      save();
      render();
      if (state.provider === 'codecraft' && state.keys.length && Date.now() - state.checkedAt > 60 * 1000) checkKeys();
    } else if (act === 'add-key') {
      addKey();
    } else if (act === 'check-key' && row) {
      checkKeys([row]);
    } else if (act === 'check-all') {
      checkKeys();
    } else if (act === 'remove-key' && row) {
      state.keys = state.keys.filter((r) => r !== row);
      save();
      render();
    } else if (act === 'site') {
      openSite();
    } else if (act === 'toggle') {
      state.open = state.open === el.dataset.which ? null : el.dataset.which;
      render();
      const s = state.open && root.querySelector('.tai-search');
      if (s) s.focus();
    } else if (act === 'pick') {
      const id = el.dataset.id || '';
      if (el.dataset.which === 'main') {
        state.model = id;
        if (state.backup === id) state.backup = '';
      } else {
        state.backup = id;
      }
      state.open = null;
      state.note = '';
      save();
      render();
    }
  }

  function onKeydown(e) {
    if (e.target.matches('[data-role="key-input"]') && e.key === 'Enter') {
      e.preventDefault();
      addKey();
    } else if (e.target.classList.contains('tai-search') && e.key === 'Escape') {
      state.open = null;
      render();
    }
  }

  function onInput(e) {
    if (e.target.classList.contains('tai-search')) filterList(e.target);
    else if (e.target.matches('[data-role="key-input"]')) {
      state.draftKey = e.target.value;
      if (state.addError) { state.addError = ''; const msg = root.querySelector('.tai-keyrow + .tai-msg'); if (msg) msg.remove(); }
    }
  }

  function init() {
    root = document.getElementById('text-ai-settings');
    if (root) {
      root.addEventListener('click', onClick);
      root.addEventListener('keydown', onKeydown);
      root.addEventListener('input', onInput);
      render();
    }
    if (read(LS.oldKey)) save(); // move a single saved key into the list
    else sync();
    // Opening Settings → API shows fresh key states: a full check at most once a minute, otherwise
    // what the app saw while working (out of credit, rate-limited).
    const apiTab = document.querySelector('.settings-tab-btn[data-target="settings-api"]');
    if (apiTab) apiTab.addEventListener('click', () => {
      if (state.provider !== 'codecraft' || !state.keys.length) return;
      checkKeys(state.keys, { probe: Date.now() - state.checkedAt > 60 * 1000 });
    });
    if (state.provider === 'codecraft' && state.keys.length) checkKeys();
  }

  window.textAi = { ready, label, isCodeCraft: () => state.provider === 'codecraft', helpers };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
