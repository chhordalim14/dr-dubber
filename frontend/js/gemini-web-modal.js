// Gemini Web Router page: add spare Gmail accounts (signed in once in a hidden Chrome), see each
// one's state and credits, switch the router on for transcribe / translate. Backend:
// backend/routes/gemini-web.js, backend/lib/gemini-web-router.js.
//
// Drawn with the app's theme variables (--bg-panel, --text-bright, --border-light, --accent-primary…)
// in its own small stylesheet (#gw-style), so it reads in the light theme and every preset. It
// used to hard-code white and grey text on Tailwind dark colours, while shell.css gives every
// "*-modal" window the theme's panel: in the light theme the Gmails and the title were white on white.
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
  let menuOpen = null; // account id whose "⋯" menu is open
  let addOpen = null; // Add Gmail form shown (null: open while there is no Gmail yet)
  let settingsOpen = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const STYLE = `
#gemini-web-modal{--gw-ok:#10b981;--gw-warn:#f59e0b;--gw-bad:#f43f5e;--gw-busy:#8b5cf6;--gw-info:#0ea5e9}
#gemini-web-modal .gw-panel{width:min(820px,94vw);max-height:90vh;display:flex;flex-direction:column;border:1px solid var(--border-light);border-radius:14px;background:var(--bg-panel);box-shadow:var(--float-shadow);color:var(--text-primary);font-family:var(--font-sans);overflow:hidden}
#gemini-web-modal .gw-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border-color)}
#gemini-web-modal .gw-title{font-size:16px;font-weight:700;color:var(--text-bright);line-height:1.2}
#gemini-web-modal .gw-sub{font-size:12px;color:var(--text-secondary);margin-top:2px}
#gemini-web-modal .gw-x{margin-left:auto;width:32px;height:32px;border-radius:8px;color:var(--text-secondary);font-size:20px;line-height:1}
#gemini-web-modal .gw-x:hover{background:var(--bg-hover);color:var(--text-bright)}
#gemini-web-modal .gw-body{padding:16px 20px 18px;overflow:auto}
#gemini-web-modal .gw-sec{margin-top:18px}
#gemini-web-modal .gw-sec:first-child{margin-top:0}
#gemini-web-modal .gw-h{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px}
#gemini-web-modal .gw-h .gw-sp{flex:1}
#gemini-web-modal .gw-hint{font-size:12px;color:var(--text-secondary);margin-top:6px;line-height:1.45}
#gemini-web-modal .gw-muted{color:var(--text-muted)}
#gemini-web-modal .gw-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--border-light);color:var(--text-secondary);white-space:nowrap}
#gemini-web-modal .gw-pill.on{color:var(--gw-ok);border-color:color-mix(in srgb,var(--gw-ok) 45%,transparent);background:color-mix(in srgb,var(--gw-ok) 10%,transparent)}
#gemini-web-modal .gw-seg{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-base)}
#gemini-web-modal .gw-seg button{padding:7px 8px;border-radius:7px;font-size:12.5px;font-weight:600;color:var(--text-secondary)}
#gemini-web-modal .gw-seg button:hover{color:var(--text-bright);background:var(--bg-hover)}
#gemini-web-modal .gw-seg button.sel{color:#fff;background:var(--accent-primary)}
#gemini-web-modal .gw-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
#gemini-web-modal .gw-tile{border:1px solid var(--border-color);border-radius:10px;padding:10px 12px;background:var(--bg-base)}
#gemini-web-modal .gw-tile b{display:block;font-size:20px;font-weight:700;color:var(--text-bright);line-height:1.2}
#gemini-web-modal .gw-tile span{font-size:11.5px;color:var(--text-secondary)}
#gemini-web-modal .gw-alert{display:flex;align-items:center;gap:10px;margin-top:8px;padding:8px 12px;border-radius:9px;font-size:12.5px;border:1px solid;line-height:1.4}
#gemini-web-modal .gw-alert .gw-sp{flex:1}
#gemini-web-modal .gw-alert.warn{color:var(--text-primary);border-color:color-mix(in srgb,var(--gw-warn) 45%,transparent);background:color-mix(in srgb,var(--gw-warn) 9%,transparent)}
#gemini-web-modal .gw-alert.bad{color:var(--text-primary);border-color:color-mix(in srgb,var(--gw-bad) 45%,transparent);background:color-mix(in srgb,var(--gw-bad) 9%,transparent)}
#gemini-web-modal .gw-alert.info{color:var(--text-primary);border-color:color-mix(in srgb,var(--gw-info) 40%,transparent);background:color-mix(in srgb,var(--gw-info) 8%,transparent)}
#gemini-web-modal .gw-alert.ok{color:var(--text-primary);border-color:color-mix(in srgb,var(--gw-ok) 40%,transparent);background:color-mix(in srgb,var(--gw-ok) 8%,transparent)}
#gemini-web-modal .gw-list{border:1px solid var(--border-color);border-radius:10px;overflow:visible}
#gemini-web-modal .gw-row{position:relative;display:grid;grid-template-columns:12px minmax(0,1fr) 150px 150px;align-items:center;gap:12px;padding:11px 14px}
#gemini-web-modal .gw-row + .gw-row,#gemini-web-modal .gw-row + .gw-extra,#gemini-web-modal .gw-extra + .gw-row{border-top:1px solid var(--border-color)}
#gemini-web-modal .gw-row.off{opacity:.55}
#gemini-web-modal .gw-dot{width:10px;height:10px;border-radius:50%;background:var(--text-muted)}
#gemini-web-modal .gw-dot.ready{background:var(--gw-ok)}
#gemini-web-modal .gw-dot.busy{background:var(--gw-busy);box-shadow:0 0 0 3px color-mix(in srgb,var(--gw-busy) 25%,transparent)}
#gemini-web-modal .gw-dot.limited{background:var(--gw-warn)}
#gemini-web-modal .gw-dot.signed_out,#gemini-web-modal .gw-dot.error{background:var(--gw-bad)}
#gemini-web-modal .gw-dot.starting{background:var(--gw-info)}
#gemini-web-modal .gw-email{font-size:13.5px;font-weight:600;color:var(--text-bright);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gemini-web-modal .gw-meta{font-size:12px;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gemini-web-modal .gw-meta .st{font-weight:600}
#gemini-web-modal .gw-meta .st.ready{color:var(--gw-ok)}#gemini-web-modal .gw-meta .st.busy{color:var(--gw-busy)}#gemini-web-modal .gw-meta .st.limited{color:var(--gw-warn)}
#gemini-web-modal .gw-meta .st.signed_out,#gemini-web-modal .gw-meta .st.error{color:var(--gw-bad)}#gemini-web-modal .gw-meta .st.starting{color:var(--gw-info)}
#gemini-web-modal .gw-err{font-size:11.5px;color:var(--gw-bad);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gemini-web-modal .gw-tag{display:inline-block;padding:0 6px;border-radius:5px;font-size:10.5px;font-weight:600;border:1px solid var(--border-light);color:var(--text-secondary);vertical-align:1px}
#gemini-web-modal .gw-tag.bad{color:var(--gw-bad);border-color:color-mix(in srgb,var(--gw-bad) 45%,transparent)}
#gemini-web-modal .gw-credit{font-size:12px;color:var(--text-primary)}
#gemini-web-modal .gw-bar{height:5px;border-radius:3px;background:var(--border-color);margin:4px 0 2px;overflow:hidden}
#gemini-web-modal .gw-bar i{display:block;height:100%;border-radius:3px}
#gemini-web-modal .gw-credit small{font-size:11px;color:var(--text-muted)}
#gemini-web-modal .gw-actions{display:flex;align-items:center;gap:6px;justify-content:flex-end}
#gemini-web-modal .gw-btn{padding:5px 11px;border-radius:7px;font-size:12px;font-weight:600;border:1px solid var(--border-light);color:var(--text-primary);background:transparent;white-space:nowrap}
#gemini-web-modal .gw-btn:hover{background:var(--bg-hover);color:var(--text-bright)}
#gemini-web-modal .gw-btn:disabled{opacity:.5;cursor:default}
#gemini-web-modal .gw-btn.pri{color:#fff;border-color:var(--accent-primary);background:var(--accent-primary)}
#gemini-web-modal .gw-btn.pri:hover{filter:brightness(1.1)}
#gemini-web-modal .gw-btn.icon{padding:4px 9px;font-size:15px;line-height:1;letter-spacing:1px}
#gemini-web-modal .gw-menu{position:absolute;right:14px;top:44px;z-index:5;min-width:190px;padding:5px;border:1px solid var(--border-light);border-radius:10px;background:var(--bg-panel);box-shadow:var(--float-shadow)}
#gemini-web-modal .gw-menu button{display:block;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;color:var(--text-primary)}
#gemini-web-modal .gw-menu button:hover{background:var(--bg-hover);color:var(--text-bright)}
#gemini-web-modal .gw-menu button.bad{color:var(--gw-bad)}
#gemini-web-modal .gw-menu hr{border:0;border-top:1px solid var(--border-color);margin:4px 0}
#gemini-web-modal .gw-extra{padding:4px 14px 12px 38px}
#gemini-web-modal .gw-box{border:1px solid var(--border-color);border-radius:10px;padding:12px 14px;background:var(--bg-base)}
#gemini-web-modal .gw-box.sign{border-color:color-mix(in srgb,var(--gw-info) 40%,transparent)}
#gemini-web-modal .gw-box.fail{border-color:color-mix(in srgb,var(--gw-bad) 45%,transparent)}
#gemini-web-modal .gw-input,#gemini-web-modal select.gw-input{padding:7px 10px;border-radius:8px;border:1px solid var(--border-light);background:var(--bg-panel);color:var(--text-bright);font-size:13px;min-width:0}
#gemini-web-modal .gw-input::placeholder{color:var(--text-muted)}
#gemini-web-modal .gw-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
#gemini-web-modal .gw-form .gw-input{flex:1 1 180px}
#gemini-web-modal .gw-msg{margin-top:10px;font-size:12.5px}
#gemini-web-modal .gw-msg.ok{color:var(--gw-ok)}#gemini-web-modal .gw-msg.warn{color:var(--gw-warn)}#gemini-web-modal .gw-msg.bad{color:var(--gw-bad)}#gemini-web-modal .gw-msg.info{color:var(--gw-info)}
#gemini-web-modal .gw-toggle{display:flex;align-items:center;gap:8px;width:100%;padding:10px 0 2px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)}
#gemini-web-modal .gw-toggle:hover{color:var(--text-bright)}
#gemini-web-modal .gw-set{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px 14px;align-items:start;margin-top:8px}
#gemini-web-modal .gw-set > label{font-size:12.5px;color:var(--text-secondary);padding-top:7px}
#gemini-web-modal .gw-check{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text-primary);cursor:pointer;margin-top:8px}
#gemini-web-modal .gw-check input{width:15px;height:15px;accent-color:var(--accent-primary)}
#gemini-web-modal pre.gw-log{margin-top:8px;max-height:160px;overflow:auto;border:1px solid var(--border-color);border-radius:8px;padding:8px;font-size:11px;color:var(--text-secondary);background:var(--bg-panel);white-space:pre-wrap}
#gemini-web-modal .gw-foot{margin-top:18px;padding-top:12px;border-top:1px solid var(--border-color);font-size:11.5px;color:var(--text-muted);line-height:1.5}
#gemini-web-modal .gw-spin{display:inline-block;width:12px;height:12px;border-radius:50%;border:2px solid var(--gw-info);border-top-color:transparent;animation:gwspin .8s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes gwspin{to{transform:rotate(360deg)}}
@media (max-width:640px){#gemini-web-modal .gw-row{grid-template-columns:12px minmax(0,1fr) auto}#gemini-web-modal .gw-credit{display:none}#gemini-web-modal .gw-seg{grid-template-columns:repeat(2,1fr)}#gemini-web-modal .gw-tiles{grid-template-columns:1fr}}
`;

  // <select> of proxies: auto, none, the Router's own list, or typed in.
  function proxySelect(id, current, isAuto = false) {
    const choices = (data && data.proxyChoices) || [];
    // A new Gmail: Auto by default - its own address (your proxies first, free ones only if allowed).
    const defaultAuto = id === 'new' && !current;
    return `<select data-proxy-select="${esc(id)}" class="gw-input" style="max-width:300px">
      <option value="auto" ${(defaultAuto || isAuto) ? 'selected' : ''}>Auto: its own address (your proxies first)</option>
      <option value="" ${(!defaultAuto && !isAuto && !current) ? 'selected' : ''}>No proxy (this PC's address)</option>
      ${choices.map((p) => `<option value="id:${esc(p.id)}" ${(!isAuto && current === p.label) ? 'selected' : ''}>${esc(p.label)}${p.status === 'offline' ? ' (offline)' : ''}</option>`).join('')}
      <option value="custom">Type a proxy…</option>
    </select>
    <input data-proxy-custom="${esc(id)}" placeholder="host:port:user:pass or http://user:pass@host:port" class="gw-input hidden" style="margin-top:6px;width:100%" />`;
  }
  function readProxy(root, id) {
    const sel = root.querySelector(`[data-proxy-select="${CSS.escape(id)}"]`);
    const v = sel ? sel.value : '';
    if (v === 'auto') return { autoProxy: true };
    if (v.startsWith('id:')) return { proxyId: v.slice(3) };
    if (v === 'custom') return { proxy: (root.querySelector(`[data-proxy-custom="${CSS.escape(id)}"]`) || {}).value || '' };
    return { proxy: '' };
  }

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

  const STATE_LABEL = { ready: 'Ready', starting: 'Starting', signed_out: 'Signed out', limited: 'Out of credits', error: 'Error', off: 'Off' };
  const stateOf = (a) => (a.busy ? 'busy' : a.state);
  const time = (sec) => new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // The four ways the Router can work, from the three settings it keeps.
  const MODES = [
    { key: 'off', label: 'Off', set: { useForDubbing: false, routerFirst: false, gmailOnly: false }, hint: 'Transcribe and translate use only your Gemini API keys from Settings.' },
    { key: 'shared', label: 'Share with API keys', set: { useForDubbing: true, routerFirst: false, gmailOnly: false }, hint: 'Gmails and API keys share the work.' },
    { key: 'first', label: 'Gmails first', set: { useForDubbing: true, routerFirst: true, gmailOnly: false }, hint: 'Gmails do the work; API keys step in only when every Gmail is busy, out of credits or signed out. Saves API quota.' },
    { key: 'only', label: 'Gmails only', set: { useForDubbing: true, routerFirst: true, gmailOnly: true }, hint: 'No API keys while any Gmail works: a job waits for a free Gmail. API keys are used only if no Gmail can sign in.' }
  ];
  function modeOf(s) {
    if (!s || !s.useForDubbing) return 'off';
    if (s.gmailOnly === true) return 'only';
    return s.routerFirst !== false ? 'first' : 'shared';
  }

  function credits(a) {
    const q = a.quota;
    if (!q || !q.total) return '<div class="gw-credit gw-muted">–</div>';
    const pct = Math.max(0, Math.min(100, Math.round((q.remaining / q.total) * 100)));
    const color = pct < 15 ? 'var(--gw-bad)' : pct < 40 ? 'var(--gw-warn)' : 'var(--gw-ok)';
    return `<div class="gw-credit">${q.remaining} / ${q.total} credits
      <div class="gw-bar"><i style="width:${pct}%;background:${color}"></i></div>
      ${q.resetAt ? `<small>refills ${esc(time(q.resetAt))}</small>` : ''}</div>`;
  }

  function signInBlock(a) {
    const s = a.signIn;
    if (!s || s.state === 'done') return '';
    const detail = s.detail ? `<pre class="gw-log" style="max-height:110px">${esc(s.detail)}</pre>` : '';
    let action = '';
    if (s.state === 'need_code') {
      action = `<div class="gw-form" style="margin-top:8px"><input data-code="${esc(a.id)}" value="${esc(codeDrafts[a.id] || '')}" placeholder="Code from Google" class="gw-input" style="flex:0 1 180px" />
        <button data-act="code" data-id="${esc(a.id)}" class="gw-btn pri">Send code</button>
        <button data-act="show" data-id="${esc(a.id)}" class="gw-btn">Show window</button></div>`;
    } else if (s.state === 'need_window' || s.state === 'need_action') {
      action = `<div class="gw-form" style="margin-top:8px"><button data-act="show" data-id="${esc(a.id)}" class="gw-btn pri">Show window</button></div>`;
    }
    const failed = s.state === 'failed';
    return `<div class="gw-extra"><div class="gw-box ${failed ? 'fail' : 'sign'}" style="font-size:12.5px">
      ${s.state === 'working' ? '<span class="gw-spin"></span>' : ''}<b>${failed ? 'Sign-in failed:' : 'Sign-in:'}</b> ${esc(s.message)}${s.visible ? ' <span class="gw-muted">(window shown)</span>' : ''}
      ${detail}${action}
      ${!failed ? `<div style="margin-top:6px"><button data-act="cancel" data-id="${esc(a.id)}" class="gw-btn" style="padding:3px 9px">Cancel</button></div>` : ''}
    </div></div>`;
  }

  function row(a) {
    const st = stateOf(a);
    const label = st === 'busy' ? 'Working' : (STATE_LABEL[a.state] || a.state);
    const signingIn = a.signIn && a.signIn.state !== 'failed' && a.signIn.state !== 'done';
    const needsSignIn = a.state === 'signed_out' && !signingIn;
    const via = a.proxySource === 'own' ? 'your proxy' : a.proxySource === 'typed' ? 'typed proxy' : a.proxySource === 'free' ? 'free proxy' : 'this PC';
    // Another Gmail Google sees from the same address.
    const sameIp = a.ip && a.enabled ? (data.accounts || []).filter((b) => b.id !== a.id && b.enabled && b.ip === a.ip).map((b) => b.email) : [];
    const meta = [
      `<span class="st ${esc(st)}">${esc(label)}</span>`,
      a.served ? `${a.served} done` : '',
      a.lastMs ? `last ${Math.round(a.lastMs / 1000)} s` : '',
      `${esc(via)}${a.ip ? ` ${esc(a.ip)}` : ''}`
    ].filter(Boolean).join(' · ');
    const shared = sameIp.length ? ` <span class="gw-tag bad" title="Same address as ${esc(sameIp.join(', '))}: Google can tie them together.">shared address</span>` : '';
    // The state already says "Out of credits"; the error line is for sign-in problems and errors.
    const err = a.error && (a.state === 'signed_out' || a.state === 'error') ? `<div class="gw-err" title="${esc(a.error)}">${esc(a.error)}</div>` : '';
    const primary = needsSignIn ? `<button data-act="signin" data-id="${esc(a.id)}" class="gw-btn pri">Sign in again</button>`
      : a.state === 'ready' ? `<button data-act="test" data-id="${esc(a.id)}" class="gw-btn">Test</button>` : '';
    const menu = menuOpen === a.id ? `<div class="gw-menu" data-menu="${esc(a.id)}">
        <button data-act="proxy" data-id="${esc(a.id)}">Proxy…</button>
        <button data-act="auto-proxy" data-id="${esc(a.id)}" title="Another working address no other Gmail uses (your proxies first)">Change proxy</button>
        <hr>
        <button data-act="toggle" data-id="${esc(a.id)}" data-on="${a.enabled ? 1 : 0}">${a.enabled ? 'Turn off' : 'Turn on'}</button>
        <button data-act="remove" data-id="${esc(a.id)}" class="bad">Remove</button>
      </div>` : '';
    const editing = proxyEdit === a.id ? `<div class="gw-extra"><div class="gw-box">
        <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:8px">Proxy for <b style="color:var(--text-bright)">${esc(a.email)}</b></div>
        <div class="gw-form" style="align-items:flex-start"><div style="flex:1 1 260px">${proxySelect(a.id, a.proxy, !!a.autoProxy)}</div>
          <button data-act="proxy-save" data-id="${esc(a.id)}" class="gw-btn pri">Save</button>
          <button data-act="proxy-cancel" data-id="${esc(a.id)}" class="gw-btn">Cancel</button></div>
        <div class="gw-hint">Google then sees this Gmail only from the proxy's address. Signing in again uses it too.</div>
      </div></div>` : '';
    return `<div class="gw-row ${a.enabled ? '' : 'off'}">
      <span class="gw-dot ${esc(st)}" title="${esc(label)}"></span>
      <div style="min-width:0"><div class="gw-email" title="${esc(a.email)}">${esc(a.email)}</div>
        <div class="gw-meta">${meta}${shared}</div>${err}</div>
      ${credits(a)}
      <div class="gw-actions">${primary}<button data-act="menu" data-id="${esc(a.id)}" class="gw-btn icon" title="More">⋯</button></div>
      ${menu}
    </div>${editing}${signInBlock(a)}`;
  }

  // Ready Gmails, credits left on the working ones, and who answered in the last hour.
  function summary(accs) {
    const enabled = accs.filter((a) => a.enabled);
    const ready = enabled.filter((a) => a.state === 'ready').length;
    const withQuota = enabled.filter((a) => a.quota && a.quota.total);
    const left = withQuota.reduce((n, a) => n + (a.quota.remaining || 0), 0);
    const total = withQuota.reduce((n, a) => n + (a.quota.total || 0), 0);
    const u = data.usage || {};
    const h = u.lastHour || {};
    const answers = (h.gmail || 0) + (h.api || 0);
    const pct = answers ? Math.round(((h.gmail || 0) / answers) * 100) : null;
    const pctColor = pct == null ? '' : pct >= 80 ? 'var(--gw-ok)' : pct >= 50 ? 'var(--gw-warn)' : 'var(--gw-bad)';
    const SKIPS = [['busy', 'busy'], ['credits', 'out of credits'], ['signedOut', 'signed out'], ['blocked', 'blocked'], ['timeout', 'no answer in time'], ['error', 'errors']];
    const skips = SKIPS.filter(([k]) => h[k]).map(([k, l]) => `${l} ${h[k]}`).join(' · ');
    const t = u.total || {};
    const tAnswers = (t.gmail || 0) + (t.api || 0);
    return `<div class="gw-sec">
      <div class="gw-tiles">
        <div class="gw-tile"><b>${ready} <span style="font-size:13px;font-weight:600;color:var(--text-muted)">of ${enabled.length}</span></b><span>Gmails ready</span></div>
        <div class="gw-tile"><b>${total ? left.toLocaleString() : '–'}</b><span>${total ? `credits left of ${total.toLocaleString()}` : 'credits left'}</span></div>
        <div class="gw-tile" title="Answers in the last hour from Gmails vs API keys. Low means work goes to your API keys."><b style="${pct == null ? '' : `color:${pctColor}`}">${pct == null ? '–' : `${pct}%`}</b><span>${answers ? `on Gmails, last hour (${h.gmail || 0} Gmail · ${h.api || 0} API)` : 'on Gmails, last hour'}</span></div>
      </div>
      ${skips || tAnswers ? `<div class="gw-hint">${skips ? `Gmails passed over: ${esc(skips)}. ` : ''}${tAnswers ? `Since ${esc(new Date(u.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}: ${Math.round(((t.gmail || 0) / tAnswers) * 100)}% on Gmails (${t.gmail || 0} Gmail · ${t.api || 0} API).` : ''}</div>` : ''}
    </div>`;
  }

  // One line each, only when there is something to say.
  function alerts(useDubbing) {
    const out = [];
    const l = data.lib || {};
    const up = l.update || {};
    if (data.updating || up.running) out.push(['info', '<span class="gw-spin"></span>Updating the library: jobs use your API keys until it is done.', '']);
    else if (up.error) out.push(['bad', `Library update: ${esc(up.error)}`, '']);
    else if (up.result && up.result.status === 'rolled_back') out.push(['warn', esc(up.result.message), '']);
    else if (up.result && up.result.status === 'updated') out.push(['ok', esc(up.result.message), '']);
    else if (l.latest && l.installed && l.latest !== l.installed) {
      out.push(['info', `A newer library is out: gemini_webapi ${esc(l.latest)} (you have ${esc(l.installed)}). Update if the Router stops working.`, '<button id="gw-lib-update-alert" class="gw-btn">Update</button>']);
    }
    if (!data.running && data.serviceError) out.push(['bad', esc(data.serviceError), '']);
    if (useDubbing && !data.timing) out.push(['warn', 'Line times come from the website and can be seconds off: the PC timing needs the VoxCPM2 install.', '']);
    return out.map(([k, text, btn]) => `<div class="gw-alert ${k}"><span class="gw-sp">${text}</span>${btn}</div>`).join('');
  }

  function addForm() {
    return `<div class="gw-box" style="margin-top:10px">
      <div class="gw-form">
        <input id="gw-email" type="email" autocomplete="off" placeholder="name@gmail.com" class="gw-input" />
        <input id="gw-pass" type="password" autocomplete="new-password" placeholder="Password" class="gw-input" />
        <button id="gw-add" class="gw-btn pri" style="padding:7px 16px">Add</button>
      </div>
      <div class="gw-set" style="grid-template-columns:110px minmax(0,1fr)"><label>Address</label><div>${proxySelect('new', null)}</div></div>
      <div class="gw-hint">DR Dubber signs in once in a hidden Chrome window. The password is only typed into Google's page; it is not saved.</div>
    </div>`;
  }

  // Model, thinking, how the Gmails reach Google, and the library: behind "Settings".
  function settings(accs) {
    if (!settingsOpen) return '';
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
    const p = data.proxySummary || {};
    const parts = [
      p.own ? `${p.own} on your proxies` : '', p.typed ? `${p.typed} on typed proxies` : '',
      p.free ? `${p.free} on free proxies` : '', p.pc ? `${p.pc} on this PC's address` : ''
    ].filter(Boolean).join(' · ');
    const shared = (p.shared || []).length;
    const l = data.lib || {};
    const up = l.update || {};
    return `<div class="gw-set">
        <label>Model</label>
        <div><select id="gw-model" class="gw-input">
          <option value="" ${!s.model ? 'selected' : ''}>Each Gmail's default</option>
          ${opts.map((o) => `<option value="${esc(o.name)}" ${s.model === o.name ? 'selected' : ''}>${esc(o.display)} (${o.n} of ${accs.length} Gmail${accs.length === 1 ? '' : 's'})</option>`).join('')}
        </select><div class="gw-hint">Free Gmails only have Auto; Pro and Argon need Google's paid plan.</div></div>
        <label>Thinking</label>
        <div><select id="gw-thinking" class="gw-input">
          <option value="standard" ${s.thinking !== 'extended' ? 'selected' : ''}>Standard</option>
          <option value="extended" ${s.thinking === 'extended' ? 'selected' : ''}>Extended (slower, more credits)</option>
        </select></div>
        ${accs.length ? `<label>Addresses</label>
        <div><div style="font-size:12.5px;color:var(--text-primary);padding-top:7px">${esc(parts || '–')}${shared ? ` · <span style="color:var(--gw-bad);font-weight:600">${shared} address${shared === 1 ? ' is' : 'es are'} shared</span>` : ''}</div>
          ${p.ownProxies ? `<div class="gw-hint" style="margin-top:2px">You have ${p.ownProxies} prox${p.ownProxies === 1 ? 'y' : 'ies'} of your own.</div>` : ''}
          <div style="margin-top:8px"><button id="gw-auto-proxy-all" class="gw-btn" title="Gmails that share an address, have none, or whose proxy is dead get one no other Gmail uses. Working Gmails keep theirs. One Gmail may keep this PC's address.">Give each Gmail its own address</button></div>
          <label class="gw-check" title="Free public proxies are unknown servers, mostly cloud addresses Google trusts less, and they die often. They are tested without your Gmail and kept while they work.">
            <input id="gw-free" type="checkbox" ${p.freeProxies !== false ? 'checked' : ''} /> Fill the gap with free public proxies (riskier, they drop often)</label></div>` : ''}
        ${l.installed ? `<label>Library</label>
        <div><div class="gw-form" style="padding-top:3px"><span style="font-size:12.5px">gemini_webapi ${esc(l.installed)}${l.latest ? (l.latest !== l.installed ? ` · <span style="color:var(--gw-warn)">newest is ${esc(l.latest)}</span>` : ' · <span class="gw-muted">newest</span>') : ''}</span>
          <button id="gw-lib-update" class="gw-btn" ${up.running ? 'disabled' : ''}>${up.running ? 'Updating…' : 'Update'}</button></div>
          <div class="gw-hint">Installs the newest version, tests it with one of your Gmails and puts the old one back if it fails.</div>
          ${up.running || up.error || (up.result && up.result.status === 'rolled_back') ? `<pre class="gw-log">${esc((up.lines || []).slice(-20).join('\n'))}</pre>` : ''}</div>` : ''}
      </div>`;
  }

  function render() {
    if (!el || !data) return;
    const body = el.querySelector('#gw-body');
    const pill = el.querySelector('#gw-pill');
    const active = document.activeElement;
    const focusKey = active && (active.dataset.code ? `code:${active.dataset.code}` : active.dataset.proxyCustom ? `pc:${active.dataset.proxyCustom}` : active.id);
    const keep = el._keep || {};
    const msg = keep.msg ? `<div id="gw-msg" class="gw-msg ${esc(keep.msg.cls)}">${esc(keep.msg.text)}</div>` : '<div id="gw-msg" class="gw-msg"></div>';
    if (!data.envReady) {
      const ins = data.install || {};
      pill.className = 'gw-pill';
      pill.textContent = 'Not installed';
      body.innerHTML = `<div class="gw-box">
          <div style="font-size:13.5px;color:var(--text-bright);font-weight:600">Install the Router's Python part</div>
          <div class="gw-hint">It is the <code>gemini_webapi</code> library (about 20 MB) and installs into <code>DR Dubber Gemini Web</code> in your user folder. Python 3.10 or newer must be on this PC.</div>
          <div style="margin-top:12px"><button id="gw-install" class="gw-btn pri" ${ins.running ? 'disabled' : ''}>${ins.running ? '<span class="gw-spin" style="border-color:#fff;border-top-color:transparent"></span>Installing…' : 'Install'}</button></div>
          ${ins.lines && ins.lines.length ? `<pre class="gw-log">${esc(ins.lines.slice(-30).join('\n'))}</pre>` : ''}
          ${ins.error ? `<div class="gw-msg bad">${esc(ins.error)}</div>` : ''}
        </div>${msg}`;
      return;
    }
    const accs = data.accounts || [];
    const s = data.settings || {};
    const mode = modeOf(s);
    const useDubbing = mode !== 'off';
    const ready = accs.filter((a) => a.enabled && a.state === 'ready').length;
    pill.className = `gw-pill${useDubbing ? ' on' : ''}`;
    pill.textContent = useDubbing ? `On · ${ready} of ${accs.filter((a) => a.enabled).length} ready` : 'Off';
    const showAdd = addOpen == null ? !accs.length : addOpen;
    body.innerHTML = `
      <div class="gw-sec">
        <div class="gw-h">Use Gmails for transcribe &amp; translate</div>
        <div class="gw-seg">${MODES.map((m) => `<button data-mode="${m.key}" class="${m.key === mode ? 'sel' : ''}">${esc(m.label)}</button>`).join('')}</div>
        <div class="gw-hint">${esc(MODES.find((m) => m.key === mode).hint)}</div>
        ${msg}
      </div>
      ${useDubbing && accs.length ? summary(accs) : ''}
      ${alerts(useDubbing)}
      <div class="gw-sec">
        <div class="gw-h">Gmail accounts <span class="gw-muted" style="font-weight:600">${accs.length || ''}</span><span class="gw-sp"></span>
          <button id="gw-add-toggle" class="gw-btn" style="text-transform:none;letter-spacing:0">${showAdd && accs.length ? 'Close' : '+ Add Gmail'}</button></div>
        ${showAdd ? addForm() : ''}
        ${accs.length ? `<div class="gw-list" style="${showAdd ? 'margin-top:10px' : ''}">${accs.map(row).join('')}</div>` : (showAdd ? '' : '<div class="gw-box gw-muted" style="text-align:center;font-size:13px">No Gmail yet.</div>')}
      </div>
      <div class="gw-sec" style="margin-top:12px">
        <button id="gw-settings-toggle" class="gw-toggle">${settingsOpen ? '▾' : '▸'} Settings<span class="gw-muted" style="font-weight:500;text-transform:none;letter-spacing:0">· model, addresses, library</span></button>
        ${settings(accs)}
      </div>
      <div class="gw-foot">Uses gemini.google.com the way a person does, with free accounts (about 600 credits each; a 3-minute clip costs about 6). Google's terms do not allow this: use spare Gmails only, they can be banned.</div>`;
    // keep what the user was typing
    if (keep.email && body.querySelector('#gw-email')) body.querySelector('#gw-email').value = keep.email;
    if (keep.pass && body.querySelector('#gw-pass')) body.querySelector('#gw-pass').value = keep.pass;
    restoreProxyDrafts(body);
    if (focusKey) {
      const f = focusKey.startsWith('code:') ? body.querySelector(`[data-code="${CSS.escape(focusKey.slice(5))}"]`)
        : focusKey.startsWith('pc:') ? body.querySelector(`[data-proxy-custom="${CSS.escape(focusKey.slice(3))}"]`)
          : body.querySelector(`#${CSS.escape(focusKey)}`);
      if (f) { f.focus(); try { f.setSelectionRange(f.value.length, f.value.length); } catch (e) { } }
    }
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

  const CLS = { 'text-emerald-300': 'ok', 'text-amber-300': 'warn', 'text-rose-300': 'bad', 'text-sky-300': 'info', 'text-gray-400': '' };
  function message(text, cls = 'text-gray-400') {
    const k = CLS[cls] != null ? CLS[cls] : cls;
    el._keep = { ...(el._keep || {}), msg: { text, cls: k } };
    const m = el.querySelector('#gw-msg');
    if (m) { m.textContent = text; m.className = `gw-msg ${k}`; }
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
    // A click anywhere else closes an open "⋯" menu.
    if (menuOpen && !(t && (t.dataset.act === 'menu' || t.closest('.gw-menu')))) { menuOpen = null; render(); }
    if (!t) return;
    const id = t.dataset.id;
    try {
      if (t.id === 'gw-close') return close();
      if (t.dataset.mode) {
        const m = MODES.find((x) => x.key === t.dataset.mode);
        await api('/settings', { body: m.set });
        message({ off: 'Router off: transcribe & translate use your API keys only.', shared: 'Gmails and API keys now share the work.', first: 'Gmails first: API keys only as backup.', only: 'Gmails only: API keys are used only if no Gmail can sign in.' }[m.key], 'text-emerald-300');
        return refresh();
      }
      if (t.id === 'gw-add-toggle') { addOpen = !((addOpen == null ? !(data.accounts || []).length : addOpen)); render(); if (addOpen) el.querySelector('#gw-email')?.focus(); return; }
      if (t.id === 'gw-settings-toggle') { settingsOpen = !settingsOpen; render(); return; }
      if (t.id === 'gw-install') { await api('/install', { body: {} }); return refresh(); }
      if (t.id === 'gw-lib-update' || t.id === 'gw-lib-update-alert') {
        if (!confirm('Install the newest gemini_webapi library? It is tested with one of your Gmails and the old version is put back if it fails. Jobs use your API keys meanwhile (about a minute).')) return;
        t.disabled = true; t.textContent = 'Updating…';
        await api('/lib-update', { body: {} });
        return refresh();
      }
      if (t.id === 'gw-auto-proxy-all') {
        t.disabled = true; t.textContent = 'Finding proxies…';
        busy = true;
        try {
          const r = await api('/auto-proxy-all', { body: {} });
          const moved = [...(r.assigned || []), ...(r.upgraded || [])];
          const failed = r.failed || [];
          const SRC = { own: 'your proxy', free: 'free proxy' };
          const lines = [
            moved.length ? `${moved.length} Gmail${moved.length === 1 ? '' : 's'} got an address: ${moved.map((x) => `${x.email.split('@')[0]} → ${x.ip || x.proxy} (${SRC[x.source] || x.source})`).join(', ')}.` : '',
            r.kept ? `${r.kept} kept theirs.` : '',
            failed.length ? `${failed.length} still without one: ${failed[0].error}` : ''
          ].filter(Boolean);
          message(lines.join(' ') || 'Every Gmail already has its own address.', failed.length ? 'text-amber-300' : 'text-emerald-300');
        } finally { busy = false; }
        return refresh();
      }
      if (t.id === 'gw-add') {
        const email = el.querySelector('#gw-email').value.trim();
        const password = el.querySelector('#gw-pass').value;
        if (!email || !password) return message('Type the Gmail and its password.', 'text-amber-300');
        t.disabled = true; t.textContent = 'Starting…';
        await api('/accounts', { body: { email, password, ...readProxy(el, 'new') } });
        el._keep = { msg: { text: `Signing in ${email}…`, cls: 'info' } };
        addOpen = false;
        delete proxyDrafts['select|new'];
        delete proxyDrafts['custom|new'];
        return refresh();
      }
      if (!id) return;
      const act = t.dataset.act;
      if (act === 'menu') { menuOpen = menuOpen === id ? null : id; render(); return; }
      menuOpen = null;
      if (act === 'code') {
        const code = (el.querySelector(`[data-code="${CSS.escape(id)}"]`) || {}).value || '';
        await api(`/accounts/${id}/code`, { body: { code } });
        delete codeDrafts[id];
      } else if (act === 'auto-proxy') {
        render();
        busy = true;
        message('Finding another address…', 'text-sky-300');
        try {
          const r = await api(`/accounts/${id}/auto-proxy`, { body: {} });
          message(`${r.email || 'Gmail'} now goes through ${r.source === 'own' ? 'your proxy' : 'a free proxy'} ${r.proxy}${r.ip ? ` (IP ${r.ip})` : ''}.`, 'text-emerald-300');
        } finally { busy = false; }
      } else if (act === 'proxy') { proxyEdit = proxyEdit === id ? null : id; render(); return; }
      else if (act === 'proxy-cancel') { proxyEdit = null; delete proxyDrafts[`select|${id}`]; delete proxyDrafts[`custom|${id}`]; render(); return; }
      else if (act === 'proxy-save') {
        t.disabled = true; t.textContent = 'Checking…';
        busy = true;
        try { await api(`/accounts/${id}/proxy`, { body: readProxy(el, id) }); } finally { busy = false; }
        proxyEdit = null;
        delete proxyDrafts[`select|${id}`]; delete proxyDrafts[`custom|${id}`];
        message('Proxy saved. The Gmail reconnects through it (its new IP shows on its line).', 'text-emerald-300');
      } else if (act === 'show') await api(`/accounts/${id}/show`, { body: {} });
      else if (act === 'cancel') await api(`/accounts/${id}/cancel`, { body: {} });
      else if (act === 'toggle') { render(); await api(`/accounts/${id}/enabled`, { body: { enabled: t.dataset.on !== '1' } }); }
      else if (act === 'remove') {
        render();
        const acc = (data.accounts || []).find((a) => a.id === id);
        if (!confirm(`Remove ${acc ? acc.email : 'this Gmail'} from the router?`)) return;
        await api(`/accounts/${id}`, { method: 'DELETE' });
      } else if (act === 'signin') {
        // Electron has no prompt(): the Add form signs an account in again when its Gmail is typed.
        const acc = (data.accounts || []).find((a) => a.id === id);
        el._keep = { email: acc ? acc.email : '', msg: { text: 'Type the password and click Add to sign in again.', cls: 'info' } };
        addOpen = true;
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
    if (t.id === 'gw-free' && e.type === 'change') {
      api('/settings', { body: { freeProxies: t.checked } })
        .then(() => { message(t.checked ? 'Free proxies fill in when your own run out.' : 'Only your own proxies are used now. Gmails on free proxies keep them until they stop working.', 'text-emerald-300'); refresh(); })
        .catch((err) => message(err.message, 'text-rose-300'));
    }
  }

  function build() {
    if (!document.getElementById('gw-style')) {
      const st = document.createElement('style');
      st.id = 'gw-style';
      st.textContent = STYLE;
      document.head.appendChild(st);
    }
    el = document.createElement('div');
    el.id = 'gemini-web-modal';
    el.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/70';
    el.innerHTML = `<div class="gw-panel">
      <div class="gw-head">
        <div><div class="gw-title">Gemini Web Router</div>
          <div class="gw-sub">Spare Gmail accounts on gemini.google.com instead of API keys.</div></div>
        <span id="gw-pill" class="gw-pill" style="margin-left:auto">…</span>
        <button id="gw-close" class="gw-x" style="margin-left:4px" title="Close">×</button>
      </div>
      <div id="gw-body" class="gw-body"><div class="gw-muted" style="font-size:13px">Loading…</div></div>
    </div>`;
    el.addEventListener('click', (e) => { if (e.target === el) close(); else onClick(e); });
    el.addEventListener('input', onInput);
    el.addEventListener('change', onInput);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (menuOpen) { menuOpen = null; render(); } else close(); }
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
    timer = setInterval(() => { if (!menuOpen) refresh(); }, 2000);
  }

  function close() {
    if (!el) return;
    el.style.display = 'none';
    clearInterval(timer);
    timer = null;
    menuOpen = null;
  }

  window.openGeminiWebModal = open;
  window.closeGeminiWebModal = close;
})();
