// Gemini Web Router page: add spare Gmail accounts (signed in once in a hidden Chrome), see each
// one's state and credits, switch the router on for transcribe / translate. Backend:
// backend/routes/gemini-web.js, backend/lib/gemini-web-router.js.
(function () {
  'use strict';

  // The page is served by the backend itself (main.js loads APP_ORIGIN), so its own origin is the API.
  const API = (/^https?:$/.test(location.protocol) ? location.origin : 'http://localhost:3001') + '/api/gemini-web';
  let el = null;
  let timer = null;
  let data = null;
  let busy = false;
  const codeDrafts = {};
  let proxyEdit = null; // account id whose proxy is being changed

  // <select> of proxies: none, DR Router PRO's list, or typed in.
  function proxySelect(id, current) {
    const choices = (data && data.proxyChoices) || [];
    return `<select data-proxy-select="${esc(id)}" class="px-2 py-1.5 rounded-lg bg-gray-950 border border-gray-800 text-white text-[12px] outline-none focus:border-sky-400 max-w-[260px]">
      <option value="">No proxy (this PC's address)</option>
      ${choices.map((p) => `<option value="id:${esc(p.id)}" ${current === p.label ? 'selected' : ''}>${esc(p.label)}${p.status === 'offline' ? ' (offline)' : ''}</option>`).join('')}
      <option value="custom">Type a proxy…</option>
    </select>
    <input data-proxy-custom="${esc(id)}" placeholder="host:port:user:pass or http://user:pass@host:port" class="hidden mt-1 w-full px-2 py-1.5 rounded-lg bg-gray-950 border border-gray-800 text-white text-[12px] outline-none focus:border-sky-400" />`;
  }
  function readProxy(root, id) {
    const sel = root.querySelector(`[data-proxy-select="${CSS.escape(id)}"]`);
    const v = sel ? sel.value : '';
    if (v.startsWith('id:')) return { proxyId: v.slice(3) };
    if (v === 'custom') return { proxy: (root.querySelector(`[data-proxy-custom="${CSS.escape(id)}"]`) || {}).value || '' };
    return { proxy: '' };
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const j = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
    if (!j.success) throw new Error(j.error || 'Request failed');
    return j;
  }

  const STATE = {
    ready: ['Ready', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'],
    starting: ['Starting', 'bg-sky-500/15 text-sky-300 border-sky-500/30'],
    signed_out: ['Signed out', 'bg-rose-500/15 text-rose-300 border-rose-500/30'],
    limited: ['Out of credits', 'bg-amber-500/15 text-amber-300 border-amber-500/30'],
    error: ['Error', 'bg-rose-500/15 text-rose-300 border-rose-500/30'],
    off: ['Off', 'bg-gray-500/15 text-gray-400 border-gray-500/30']
  };

  function chip(a) {
    const [label, cls] = a.busy ? ['Busy', 'bg-violet-500/15 text-violet-300 border-violet-500/30'] : (STATE[a.state] || [a.state, 'bg-gray-500/15 text-gray-300 border-gray-500/30']);
    return `<span class="inline-block px-2 py-0.5 rounded-full border text-[11px] font-semibold ${cls}">${esc(label)}</span>`;
  }

  function credits(a) {
    const q = a.quota;
    if (!q || !q.total) return '<span class="text-gray-500">–</span>';
    const pct = Math.max(0, Math.min(100, Math.round((q.remaining / q.total) * 100)));
    const reset = q.resetAt ? new Date(q.resetAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="min-w-[110px]"><div class="text-[12px] text-gray-200">${q.remaining} / ${q.total}</div>
      <div class="h-1 rounded bg-gray-800 mt-1"><div class="h-1 rounded ${pct < 15 ? 'bg-rose-400' : pct < 40 ? 'bg-amber-400' : 'bg-emerald-400'}" style="width:${pct}%"></div></div>
      ${reset ? `<div class="text-[10px] text-gray-500 mt-0.5">refills ${esc(reset)}</div>` : ''}</div>`;
  }

  function signInBlock(a) {
    const s = a.signIn;
    if (!s || s.state === 'done') return '';
    const detail = s.detail ? `<pre class="mt-1 text-[11px] text-gray-400 whitespace-pre-wrap font-sans">${esc(s.detail)}</pre>` : '';
    let action = '';
    if (s.state === 'need_code') {
      action = `<div class="flex gap-2 mt-2"><input data-code="${esc(a.id)}" value="${esc(codeDrafts[a.id] || '')}" placeholder="Code from Google" class="px-2 py-1 rounded bg-gray-950 border border-gray-700 text-white text-sm w-40 outline-none focus:border-sky-400" />
        <button data-act="code" data-id="${esc(a.id)}" class="px-3 py-1 rounded bg-sky-500/20 border border-sky-500/40 text-sky-200 text-xs font-semibold hover:bg-sky-500/30">Send code</button>
        <button data-act="show" data-id="${esc(a.id)}" class="px-3 py-1 rounded border border-gray-700 text-gray-300 text-xs hover:bg-gray-800">Show window</button></div>`;
    } else if (s.state === 'need_window' || s.state === 'need_action') {
      action = `<div class="flex gap-2 mt-2"><button data-act="show" data-id="${esc(a.id)}" class="px-3 py-1 rounded bg-sky-500/20 border border-sky-500/40 text-sky-200 text-xs font-semibold hover:bg-sky-500/30">Show window</button></div>`;
    }
    const color = s.state === 'failed' ? 'border-rose-500/40 bg-rose-500/10' : 'border-sky-500/30 bg-sky-500/5';
    const spinner = s.state === 'working' ? '<span class="inline-block w-3 h-3 mr-1 rounded-full border-2 border-sky-300 border-t-transparent animate-spin align-[-2px]"></span>' : '';
    return `<tr><td colspan="5" class="pb-3"><div class="rounded-lg border ${color} px-3 py-2 text-[12px] text-gray-200">
      ${spinner}<b>${s.state === 'failed' ? 'Sign-in failed: ' : 'Sign-in: '}</b>${esc(s.message)}${s.visible ? ' <span class="text-gray-400">(window shown)</span>' : ''}
      ${detail}${action}
      ${s.state !== 'failed' ? `<button data-act="cancel" data-id="${esc(a.id)}" class="mt-2 text-[11px] text-gray-400 underline hover:text-gray-200">Cancel</button>` : ''}
    </div></td></tr>`;
  }

  function row(a) {
    const last = a.lastMs ? `${(a.lastMs / 1000).toFixed(0)} s` : '–';
    const needsSignIn = a.state === 'signed_out' && !(a.signIn && a.signIn.state !== 'failed');
    const route = a.proxy
      ? `via proxy ${esc(String(a.proxy).replace(/^\w+:\/\//, ''))}${a.ip ? ` · IP ${esc(a.ip)}` : ''}`
      : `no proxy${a.ip ? ` · IP ${esc(a.ip)}` : ''}`;
    const models = (a.models || []).filter((m) => m.available).map((m) => m.display || m.name);
    const editing = proxyEdit === a.id ? `<tr><td colspan="5" class="pb-3"><div class="rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2">
        <div class="text-[12px] text-gray-300 mb-1.5">Proxy for ${esc(a.email)}</div>
        <div class="flex flex-wrap items-start gap-2"><div>${proxySelect(a.id, a.proxy)}</div>
          <button data-act="proxy-save" data-id="${esc(a.id)}" class="px-3 py-1.5 rounded bg-sky-500/20 border border-sky-500/40 text-sky-200 text-xs font-semibold hover:bg-sky-500/30">Save</button>
          <button data-act="proxy-cancel" data-id="${esc(a.id)}" class="px-3 py-1.5 rounded border border-gray-700 text-gray-300 text-xs hover:bg-gray-800">Cancel</button></div>
        <div class="text-[11px] text-gray-500 mt-1.5">Google then sees this Gmail only from the proxy's address. Signing in again uses it too.</div>
      </div></td></tr>` : '';
    return `<tr class="border-t border-gray-800/80 align-top">
      <td class="py-2.5 pr-3"><div class="text-[13px] text-white font-medium">${esc(a.email)}</div>
        <div class="text-[11px] text-gray-500 mt-0.5">${route}</div>
        ${models.length ? `<div class="text-[11px] text-gray-500">models: ${esc(models.join(', '))}</div>` : ''}
        ${a.error && a.state !== 'ready' ? `<div class="text-[11px] text-rose-300/80 mt-0.5 max-w-[260px] break-words">${esc(a.error)}</div>` : ''}</td>
      <td class="py-2.5 pr-3">${chip(a)}</td>
      <td class="py-2.5 pr-3">${credits(a)}</td>
      <td class="py-2.5 pr-3 text-[12px] text-gray-300">${a.served || 0} done<br><span class="text-gray-500">last ${last}</span></td>
      <td class="py-2.5 text-right whitespace-nowrap">
        ${needsSignIn ? `<button data-act="signin" data-id="${esc(a.id)}" class="px-2 py-1 rounded bg-sky-500/20 border border-sky-500/40 text-sky-200 text-[11px] font-semibold hover:bg-sky-500/30">Sign in again</button>` : ''}
        ${a.state === 'ready' ? `<button data-act="test" data-id="${esc(a.id)}" class="px-2 py-1 rounded border border-gray-700 text-gray-300 text-[11px] hover:bg-gray-800">Test</button>` : ''}
        <button data-act="proxy" data-id="${esc(a.id)}" class="px-2 py-1 rounded border border-gray-700 text-gray-300 text-[11px] hover:bg-gray-800">Proxy</button>
        <button data-act="toggle" data-id="${esc(a.id)}" data-on="${a.enabled ? 1 : 0}" class="px-2 py-1 rounded border border-gray-700 text-gray-300 text-[11px] hover:bg-gray-800">${a.enabled ? 'Turn off' : 'Turn on'}</button>
        <button data-act="remove" data-id="${esc(a.id)}" class="px-2 py-1 rounded border border-rose-900/60 text-rose-300 text-[11px] hover:bg-rose-500/10">Remove</button>
      </td></tr>${editing}${signInBlock(a)}`;
  }

  // Model menu: each Gmail's default, or a model some Gmails offer (the others keep their default).
  function modelControls(accs) {
    const s = data.settings || {};
    const offered = new Map();
    for (const a of accs) for (const m of a.models || []) {
      if (!m.available) continue;
      const o = offered.get(m.name) || { name: m.name, display: m.display || m.name, n: 0 };
      o.n++;
      offered.set(m.name, o);
    }
    const opts = [...offered.values()];
    if (s.model && !offered.has(s.model)) opts.push({ name: s.model, display: s.model, n: 0 });
    return `<div class="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 text-[12px] text-gray-300">
      <label class="flex items-center gap-2">Model
        <select id="gw-model" class="px-2 py-1.5 rounded-lg bg-gray-950 border border-gray-800 text-white text-[12px] outline-none focus:border-sky-400">
          <option value="" ${!s.model ? 'selected' : ''}>Each Gmail's default</option>
          ${opts.map((o) => `<option value="${esc(o.name)}" ${s.model === o.name ? 'selected' : ''}>${esc(o.display)} (${o.n} of ${accs.length} Gmail${accs.length === 1 ? '' : 's'})</option>`).join('')}
        </select></label>
      <label class="flex items-center gap-2">Thinking
        <select id="gw-thinking" class="px-2 py-1.5 rounded-lg bg-gray-950 border border-gray-800 text-white text-[12px] outline-none focus:border-sky-400">
          <option value="standard" ${s.thinking !== 'extended' ? 'selected' : ''}>Standard</option>
          <option value="extended" ${s.thinking === 'extended' ? 'selected' : ''}>Extended (slower, more credits)</option>
        </select></label>
      <span class="text-[11px] text-gray-500">Free Gmails only have Auto; Pro and Argon need Google's paid plan.</span>
    </div>`;
  }

  // Proxy menus keep what was picked / typed across the 2-second redraws.
  const proxyDrafts = {};
  function restoreProxyDrafts(root) {
    for (const [key, v] of Object.entries(proxyDrafts)) {
      const [kind, id] = key.split('|');
      const elx = root.querySelector(`[data-proxy-${kind}="${CSS.escape(id)}"]`);
      if (elx) elx.value = v;
    }
    root.querySelectorAll('[data-proxy-select]').forEach((sel) => {
      const custom = root.querySelector(`[data-proxy-custom="${CSS.escape(sel.dataset.proxySelect)}"]`);
      if (custom) custom.classList.toggle('hidden', sel.value !== 'custom');
    });
  }

  function render() {
    if (!el || !data) return;
    const body = el.querySelector('#gw-body');
    const active = document.activeElement;
    const focusKey = active && (active.dataset.code ? `code:${active.dataset.code}` : active.dataset.proxyCustom ? `pc:${active.dataset.proxyCustom}` : active.id);
    if (!data.envReady) {
      const ins = data.install || {};
      body.innerHTML = `<div class="text-[13px] text-gray-300 leading-relaxed">The router needs a small Python part (the <code>gemini_webapi</code> library, about 20 MB). It installs into <code>DR Dubber Gemini Web</code> in your user folder.</div>
        <button id="gw-install" ${ins.running ? 'disabled' : ''} class="mt-4 px-4 py-2 rounded-lg bg-sky-500/20 border border-sky-500/40 text-sky-200 text-sm font-semibold hover:bg-sky-500/30 disabled:opacity-50">${ins.running ? 'Installing…' : 'Install'}</button>
        ${ins.lines && ins.lines.length ? `<pre class="mt-3 max-h-48 overflow-auto rounded bg-gray-950 border border-gray-800 p-2 text-[11px] text-gray-400 whitespace-pre-wrap">${esc(ins.lines.slice(-30).join('\n'))}</pre>` : ''}
        ${ins.error ? `<div class="mt-2 text-rose-300 text-[12px]">${esc(ins.error)}</div>` : ''}`;
      return;
    }
    const accs = data.accounts || [];
    const ready = accs.filter((a) => a.enabled && a.state === 'ready').length;
    body.innerHTML = `
      <div class="flex flex-wrap items-center gap-3 justify-between">
        <label class="flex items-center gap-2 text-[13px] text-gray-200 cursor-pointer select-none">
          <input id="gw-use" type="checkbox" ${data.settings && data.settings.useForDubbing ? 'checked' : ''} class="w-4 h-4 accent-sky-400" />
          Use these Gmails for transcribe &amp; translate
        </label>
        <label class="flex items-center gap-2 text-[13px] text-gray-200 cursor-pointer select-none" title="On: Gmails do the work first and API keys only step in when every Gmail is busy, out of credits or signed out (saves API quota). Off: Gmails and API keys share the work.">
          <input id="gw-first" type="checkbox" ${data.settings && data.settings.routerFirst !== false ? 'checked' : ''} class="w-4 h-4 accent-sky-400" />
          Router first (API keys only as backup)
        </label>
        <label class="flex items-center gap-2 text-[13px] text-gray-200 cursor-pointer select-none" title="On: while any Gmail is signed in, API keys are not used at all - an episode waits for a free Gmail, and a Gmail Google signs out keeps its place while it signs back in (seconds). API keys are used only when no Gmail can sign in.">
          <input id="gw-only" type="checkbox" ${data.settings && data.settings.gmailOnly === true ? 'checked' : ''} class="w-4 h-4 accent-sky-400" />
          Gmails only (no API keys while a Gmail works)
        </label>
        <div class="text-[12px] text-gray-400">${ready} of ${accs.length} ready${data.running ? '' : ' · <span class="text-rose-300">service not running</span>'}</div>
      </div>
      ${modelControls(accs)}
      ${data.serviceError ? `<div class="mt-2 text-[12px] text-rose-300">${esc(data.serviceError)}</div>` : ''}
      ${data.timing ? '' : '<div class="mt-2 text-[12px] text-amber-300">PC timing is off: it needs the VoxCPM2 install. Without it, line times come from the website and can be seconds off.</div>'}
      <table class="w-full mt-4 text-left"><thead><tr class="text-[11px] uppercase tracking-wide text-gray-500">
        <th class="pb-2 font-semibold">Gmail</th><th class="pb-2 font-semibold">State</th><th class="pb-2 font-semibold">Credits</th><th class="pb-2 font-semibold">Work</th><th></th></tr></thead>
        <tbody>${accs.length ? accs.map(row).join('') : '<tr><td colspan="5" class="py-6 text-center text-gray-500 text-[13px]">No Gmail yet. Add one below.</td></tr>'}</tbody></table>
      <div class="mt-5 rounded-xl border border-gray-800 bg-gray-900/60 p-4">
        <div class="text-[13px] font-semibold text-white">Add Gmail</div>
        <div class="text-[11px] text-gray-400 mt-0.5">DR Dubber signs in once in a hidden Chrome window. The password is only typed into Google's page; it is not saved.</div>
        <div class="flex flex-wrap gap-2 mt-3">
          <input id="gw-email" type="email" autocomplete="off" placeholder="name@gmail.com" class="flex-1 min-w-[180px] px-3 py-2 rounded-lg bg-gray-950 border border-gray-800 text-white text-sm outline-none focus:border-sky-400" />
          <input id="gw-pass" type="password" autocomplete="new-password" placeholder="Password" class="flex-1 min-w-[150px] px-3 py-2 rounded-lg bg-gray-950 border border-gray-800 text-white text-sm outline-none focus:border-sky-400" />
          <button id="gw-add" class="px-4 py-2 rounded-lg bg-sky-500/20 border border-sky-500/40 text-sky-200 text-sm font-semibold hover:bg-sky-500/30">Add</button>
        </div>
        <div class="mt-2"><div class="text-[11px] text-gray-400 mb-1">Proxy (optional; the sign-in uses it too)</div>${proxySelect('new', null)}</div>
        <div id="gw-msg" class="text-[12px] mt-2 text-gray-400"></div>
      </div>
      <div class="mt-4 text-[11px] text-gray-500 leading-relaxed">Uses gemini.google.com the way a person does, with free accounts (about 600 credits each, one 3-minute clip costs about 6). Google's terms do not allow this: use spare Gmails only, they can be banned.</div>`;
    // keep what the user was typing
    const keep = el._keep || {};
    if (keep.email) body.querySelector('#gw-email').value = keep.email;
    if (keep.pass) body.querySelector('#gw-pass').value = keep.pass;
    if (keep.msg) { const m = body.querySelector('#gw-msg'); m.textContent = keep.msg.text; m.className = `text-[12px] mt-2 ${keep.msg.cls}`; }
    restoreProxyDrafts(body);
    if (focusKey) {
      const f = focusKey.startsWith('code:') ? body.querySelector(`[data-code="${CSS.escape(focusKey.slice(5))}"]`)
        : focusKey.startsWith('pc:') ? body.querySelector(`[data-proxy-custom="${CSS.escape(focusKey.slice(3))}"]`)
          : body.querySelector(`#${CSS.escape(focusKey)}`);
      if (f) { f.focus(); try { f.setSelectionRange(f.value.length, f.value.length); } catch (e) { } }
    }
  }

  function message(text, cls = 'text-gray-400') {
    el._keep = { ...(el._keep || {}), msg: { text, cls } };
    const m = el.querySelector('#gw-msg');
    if (m) { m.textContent = text; m.className = `text-[12px] mt-2 ${cls}`; }
  }

  async function refresh(quota = false) {
    if (busy && !quota) return;
    try {
      data = await api(`/status${quota ? '?quota=1' : ''}`);
      render();
    } catch (e) { /* backend restarting */ }
  }

  async function onClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    const id = t.dataset.id;
    try {
      if (t.id === 'gw-close') return close();
      if (t.id === 'gw-install') { await api('/install', { body: {} }); return refresh(); }
      if (t.id === 'gw-add') {
        const email = el.querySelector('#gw-email').value.trim();
        const password = el.querySelector('#gw-pass').value;
        if (!email || !password) return message('Type the Gmail and its password.', 'text-amber-300');
        t.disabled = true;
        await api('/accounts', { body: { email, password, ...readProxy(el, 'new') } });
        el._keep = { msg: { text: `Signing in ${email}…`, cls: 'text-sky-300' } };
        delete proxyDrafts['select|new'];
        delete proxyDrafts['custom|new'];
        return refresh();
      }
      if (!id) return;
      const act = t.dataset.act;
      if (act === 'code') {
        const code = (el.querySelector(`[data-code="${CSS.escape(id)}"]`) || {}).value || '';
        await api(`/accounts/${id}/code`, { body: { code } });
        delete codeDrafts[id];
      } else if (act === 'proxy') { proxyEdit = proxyEdit === id ? null : id; render(); return; }
      else if (act === 'proxy-cancel') { proxyEdit = null; delete proxyDrafts[`select|${id}`]; delete proxyDrafts[`custom|${id}`]; render(); return; }
      else if (act === 'proxy-save') {
        t.disabled = true; t.textContent = 'Checking…';
        busy = true;
        try { await api(`/accounts/${id}/proxy`, { body: readProxy(el, id) }); } finally { busy = false; }
        proxyEdit = null;
        delete proxyDrafts[`select|${id}`]; delete proxyDrafts[`custom|${id}`];
        message('Proxy saved. The Gmail reconnects through it (its new IP shows under the address).', 'text-emerald-300');
      } else if (act === 'show') await api(`/accounts/${id}/show`, { body: {} });
      else if (act === 'cancel') await api(`/accounts/${id}/cancel`, { body: {} });
      else if (act === 'toggle') await api(`/accounts/${id}/enabled`, { body: { enabled: t.dataset.on !== '1' } });
      else if (act === 'remove') {
        if (!confirm('Remove this Gmail from the router?')) return;
        await api(`/accounts/${id}`, { method: 'DELETE' });
      } else if (act === 'signin') {
        // Electron has no prompt(): the Add form signs an account in again when its Gmail is typed.
        const acc = (data.accounts || []).find((a) => a.id === id);
        el._keep = { email: acc ? acc.email : '', msg: { text: 'Type the password and click Add to sign in again.', cls: 'text-sky-300' } };
        render();
        el.querySelector('#gw-pass')?.focus();
        return;
      } else if (act === 'test') {
        t.disabled = true; t.textContent = 'Testing…';
        busy = true;
        try {
          const r = await api('/test', { body: { account: id } });
          message(`Answered in ${(r.ms / 1000).toFixed(1)} s: ${r.text}`, 'text-emerald-300');
        } finally { busy = false; }
      }
      refresh();
    } catch (err) {
      message(err.message, 'text-rose-300');
      t.disabled = false;
    }
  }

  function onInput(e) {
    const t = e.target;
    if (t.dataset && t.dataset.code) codeDrafts[t.dataset.code] = t.value;
    if (t.dataset && (t.dataset.proxySelect || t.dataset.proxyCustom)) {
      const id = t.dataset.proxySelect || t.dataset.proxyCustom;
      proxyDrafts[`${t.dataset.proxySelect ? 'select' : 'custom'}|${id}`] = t.value;
      restoreProxyDrafts(el);
      return;
    }
    if ((t.id === 'gw-model' || t.id === 'gw-thinking') && e.type === 'change') {
      api('/settings', { body: t.id === 'gw-model' ? { model: t.value } : { thinking: t.value } })
        .then(() => { message(t.id === 'gw-model' ? 'Model saved.' : 'Thinking saved.', 'text-emerald-300'); refresh(); })
        .catch((err) => message(err.message, 'text-rose-300'));
      return;
    }
    if (t.id === 'gw-email' || t.id === 'gw-pass') el._keep = { ...(el._keep || {}), [t.id === 'gw-email' ? 'email' : 'pass']: t.value };
    if (t.id === 'gw-only' && e.type === 'change') {
      api('/settings', { body: { gmailOnly: t.checked, ...(t.checked ? { routerFirst: true } : {}) } })
        .then(() => { message(t.checked ? 'Gmails only: API keys are used only if no Gmail can sign in.' : 'API keys are a backup again when the Gmails are busy.', 'text-emerald-300'); refresh(); })
        .catch((err) => message(err.message, 'text-rose-300'));
      return;
    }
    if (t.id === 'gw-first' && e.type === 'change') {
      api('/settings', { body: { routerFirst: t.checked } })
        .then(() => { message(t.checked ? 'Router first: Gmails work first, API keys only as backup.' : 'Gmails and API keys now share the work.', 'text-emerald-300'); refresh(); })
        .catch((err) => message(err.message, 'text-rose-300'));
      return;
    }
    if (t.id === 'gw-use' && e.type === 'change') api('/settings', { body: { useForDubbing: t.checked } }).then(() => refresh()).catch((err) => message(err.message, 'text-rose-300'));
  }

  function build() {
    el = document.createElement('div');
    el.id = 'gemini-web-modal';
    el.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-md';
    el.innerHTML = `<div class="w-[min(860px,94vw)] max-h-[90vh] overflow-auto rounded-2xl border border-gray-800 bg-[#0b0f17] shadow-2xl">
      <div class="flex items-center justify-between px-5 py-4 border-b border-gray-800">
        <div><div class="text-white text-[16px] font-bold">Gemini Web Router</div>
          <div class="text-[12px] text-gray-400">Spare Gmail accounts on gemini.google.com instead of API keys. No Chrome stays open.</div></div>
        <button id="gw-close" class="w-8 h-8 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 text-lg leading-none">×</button>
      </div>
      <div id="gw-body" class="px-5 py-4 text-gray-200"><div class="text-gray-500 text-sm">Loading…</div></div>
    </div>`;
    el.addEventListener('click', (e) => { if (e.target === el) close(); else onClick(e); });
    el.addEventListener('input', onInput);
    el.addEventListener('change', onInput);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && e.target.dataset && e.target.dataset.code) el.querySelector(`[data-act="code"][data-id="${CSS.escape(e.target.dataset.code)}"]`)?.click();
      if (e.key === 'Enter' && (e.target.id === 'gw-pass' || e.target.id === 'gw-email')) el.querySelector('#gw-add')?.click();
    });
    document.body.appendChild(el);
  }

  function open() {
    if (!el) build();
    el.style.display = '';
    refresh(true);
    clearInterval(timer);
    timer = setInterval(() => refresh(), 2000);
  }

  function close() {
    if (!el) return;
    el.style.display = 'none';
    clearInterval(timer);
    timer = null;
  }

  window.openGeminiWebModal = open;
  window.closeGeminiWebModal = close;
})();
