// DR Router PRO - Multi-Account Manager UI & Orbit Dashboard
(function () {
  'use strict';

  let drRouterModalEl = null;
  let activeTab = 'dashboard'; // 'dashboard' | 'accounts' | 'settings'
  let pollInterval = null;
  let accountsData = [];
  let proxiesData = [];
  let proxyMode = 'dedicated';
  let statsData = {
    total: 0,
    ready: 0,
    cooling: 0,
    invalid: 0,
    inFlight: 0,
    served: 0,
    strategy: 'round-robin',
    port: 8765,
    proxyActive: true,
    proxiesTotal: 0,
    proxiesOnline: 0,
    proxyMode: 'dedicated'
  };

  const API_BASE = (typeof getBackendBase === 'function' ? getBackendBase() : 'http://localhost:3001') + '/api/dr-router';

  function createModalHtml() {
    return `
    <div id="dr-router-modal" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-md transition-opacity duration-300 opacity-0 pointer-events-none select-none">
      <div class="relative w-[95vw] max-w-[1180px] h-[85vh] max-h-[680px] bg-[#0c0e14] border border-amber-500/30 rounded-2xl shadow-[0_0_50px_rgba(245,158,11,0.15)] flex flex-col overflow-hidden text-gray-200 font-sans">
        
        <!-- TOP HEADER BAR -->
        <header class="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-gray-800/80 bg-[#10131c]">
          <!-- Brand & Proxy info -->
          <div class="flex items-center gap-3 shrink-0 whitespace-nowrap">
            <div class="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center shadow-[0_0_15px_rgba(245,158,11,0.5)]">
              <span class="text-black font-extrabold text-sm tracking-tighter">DR</span>
            </div>
            <div class="hidden xl:block">
              <span class="font-bold text-white tracking-wide text-base">DR Router <span class="text-amber-400 font-black">PRO</span></span>
            </div>
            
            <div class="h-4 w-[1px] bg-gray-800 mx-1"></div>

            <!-- Proxy IP & status pill -->
            <button id="dr-proxy-toggle-btn" class="flex items-center gap-2 px-2.5 py-1 rounded-full bg-gray-900 border border-gray-800 hover:border-amber-500/40 transition-colors text-xs" title="Local proxy for other tools - click to turn it on or off">
              <span id="dr-proxy-dot" class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span class="text-gray-300 font-mono text-[11px]">127.0.0.1:<span id="dr-proxy-port">8765</span></span>
            </button>

            <!-- Link pill: does DR Dubber's own dubbing use the pool? -->
            <button id="dr-link-btn" class="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors bg-emerald-950/60 text-emerald-300 border-emerald-500/30" title="Click to link or unlink DR Dubber's dubbing from the pool">
              <span id="dr-link-icon">🔗</span><span id="dr-link-text">Linked</span>
            </button>
          </div>

          <!-- Strategy selector & Actions -->
          <div class="flex items-center gap-1.5 whitespace-nowrap">
            <!-- Strategy Pills -->
            <div class="flex items-center p-0.5 rounded-lg bg-gray-900/90 border border-gray-800 text-xs" id="dr-strategy-group">
              <button data-strategy="round-robin" class="dr-strat-btn px-2.5 py-1 rounded-md text-gray-400 hover:text-white transition-all text-xs font-medium">Round robin</button>
              <button data-strategy="least-used" class="dr-strat-btn px-2.5 py-1 rounded-md text-gray-400 hover:text-white transition-all text-xs font-medium">Least used</button>
              <button data-strategy="random" class="dr-strat-btn px-2.5 py-1 rounded-md text-gray-400 hover:text-white transition-all text-xs font-medium">Random</button>
            </div>

            <!-- Action buttons -->
            <button id="dr-btn-google-login" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg shrink-0 bg-white hover:bg-gray-100 text-gray-900 font-semibold text-xs transition-all shadow-sm" title="Sign into Gmail directly without copying API keys">
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
              <span>Sign in</span>
            </button>

            <button id="dr-btn-send-test" title="Send a test request through a ready account" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg shrink-0 bg-gray-900 hover:bg-gray-800 border border-gray-700/80 hover:border-amber-400/50 text-xs font-medium text-gray-200 transition-all shadow-sm">
              <span class="text-amber-400">⚡</span> <span>Test</span>
            </button>

            <button id="dr-btn-verify-all" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg shrink-0 bg-gray-900 hover:bg-gray-800 border border-gray-700/80 hover:border-emerald-400/50 text-xs font-medium text-gray-200 transition-all shadow-sm">
              <span class="text-emerald-400">🔄</span> <span>Verify all</span>
            </button>

            <button id="dr-btn-add-account" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg shrink-0 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-semibold text-xs transition-all shadow-[0_0_12px_rgba(245,158,11,0.3)]">
              <span>+</span> <span>Add account</span>
            </button>

            <button id="dr-btn-close" class="ml-1 shrink-0 w-7 h-7 flex items-center justify-center rounded-lg bg-gray-900 hover:bg-red-500/20 text-gray-400 hover:text-red-300 border border-gray-800 transition-all">
              ✕
            </button>
          </div>
        </header>

        <!-- MAIN CONTENT: Sidebar + Central Space -->
        <div class="flex-1 flex overflow-hidden">
          
          <!-- LEFT SIDEBAR -->
          <aside class="w-52 border-r border-gray-800/80 bg-[#0e111a] flex flex-col justify-between p-3 shrink-0">
            <!-- Nav list -->
            <div class="flex flex-col gap-1">
              <button data-tab="dashboard" class="dr-nav-item flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-white bg-amber-500/10 border border-amber-500/20">
                <span class="text-amber-400">🪐</span> <span>Dashboard</span>
              </button>
              <button data-tab="accounts" class="dr-nav-item flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-gray-400 hover:text-gray-200 hover:bg-gray-800/50">
                <span>👥</span> <span>Accounts</span>
              </button>
              <button data-tab="proxies" class="dr-nav-item flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-gray-400 hover:text-gray-200 hover:bg-gray-800/50">
                <span>🌐</span> <span>Proxies</span>
              </button>
              <button data-tab="settings" class="dr-nav-item flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors text-gray-400 hover:text-gray-200 hover:bg-gray-800/50">
                <span>⚙️</span> <span>Settings</span>
              </button>
            </div>

            <!-- Stats & Connection Box -->
            <div class="flex flex-col gap-3">
              <!-- Counters -->
              <div class="grid grid-cols-2 gap-2 p-2.5 rounded-xl bg-gray-950/80 border border-gray-800">
                <div class="flex flex-col items-center">
                  <span id="dr-stat-ready" class="text-xl font-bold text-emerald-400 leading-none">0</span>
                  <span class="text-[10px] text-gray-400 uppercase mt-1">Ready</span>
                </div>
                <div class="flex flex-col items-center border-l border-gray-800">
                  <span id="dr-stat-total" class="text-xl font-bold text-gray-200 leading-none">0</span>
                  <span class="text-[10px] text-gray-400 uppercase mt-1">Total</span>
                </div>
              </div>

              <!-- Client card -->
              <div class="p-2.5 rounded-xl bg-gray-950/80 border border-gray-800 flex flex-col gap-1 text-[11px]">
                <div class="flex items-center gap-1.5 font-semibold text-gray-300">
                  <span id="dr-client-dot" class="w-2 h-2 rounded-full bg-gray-500"></span>
                  <span>DR Dubber PRO</span>
                </div>
                <span id="dr-client-seen" class="text-[10px] text-gray-400">No requests yet</span>
                <span id="dr-client-proxy" class="text-[10px] text-emerald-400/80 mt-0.5">● Listening for requests</span>
              </div>
            </div>
          </aside>

          <!-- CENTRAL DISPLAY AREA -->
          <main class="flex-1 relative overflow-hidden bg-[#090b10] flex flex-col">
            
            <!-- VIEW 1: DASHBOARD (ORBIT GALAXY) -->
            <div id="dr-view-dashboard" class="absolute inset-0 flex flex-col items-center justify-center p-4">
              <!-- Orbit Canvas -->
              <div class="relative w-full h-full flex items-center justify-center overflow-hidden" id="dr-orbit-container">
                <canvas id="dr-orbit-canvas" class="absolute inset-0 w-full h-full"></canvas>
                
                <!-- Central Core -->
                <!-- Live HUD: heart rate = requests answered per minute -->
                <div class="absolute top-3 left-4 z-10 flex flex-col gap-0.5 pointer-events-none">
                  <div class="flex items-center gap-1.5 text-sm font-bold text-rose-400"><span>♥</span><span id="dr-hud-bpm">0</span><span class="text-[10px] font-medium text-gray-500">req/min</span></div>
                  <div class="flex items-center gap-1.5 text-[11px] text-gray-400"><span id="dr-hud-ready">0</span><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span><span>ready</span></div>
                  <div id="dr-hud-fast" class="hidden text-[11px] font-semibold text-amber-400">⚡ Fast mode</div>
                </div>
                <div class="absolute top-3 right-4 z-10 flex items-center p-0.5 rounded-lg bg-gray-900/90 border border-gray-800 text-[11px]">
                  <button data-view="orbit" class="dr-view-btn px-2.5 py-1 rounded-md font-medium">Orbit</button>
                  <button data-view="pulse" class="dr-view-btn px-2.5 py-1 rounded-md font-medium">Pulse</button>
                </div>
                <div id="dr-core-sun" class="relative z-10 w-20 h-20 rounded-full bg-[radial-gradient(circle_at_40%_35%,#fef3c7_0%,#fcd34d_30%,#f59e0b_70%,#b45309_100%)] flex items-center justify-center shadow-[0_0_45px_rgba(245,158,11,0.65),0_0_110px_rgba(245,158,11,0.25)] cursor-pointer border border-amber-200/60">
                  <svg id="dr-core-icon-orbit" class="w-7 h-7" viewBox="0 0 28 28" fill="none" stroke="#451a03" stroke-width="2"><circle cx="14" cy="14" r="9" stroke-dasharray="2.5 3"/><circle cx="14" cy="14" r="3" fill="#451a03"/></svg>
                  <svg id="dr-core-icon-pulse" class="w-8 h-6 hidden" viewBox="0 0 28 20" fill="none" stroke="#451a03" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 10h6l2.5-5 4 11 3.5-15 2.5 9H27"/></svg>
                  <div class="absolute top-full mt-2.5 left-1/2 -translate-x-1/2 flex flex-col items-center whitespace-nowrap pointer-events-none">
                    <span class="text-white font-bold text-sm leading-tight">Core</span>
                    <span id="dr-core-status-text" class="text-[11px] text-amber-200/80 leading-tight">Every account is ready</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- VIEW 2: ACCOUNTS LIST -->
            <div id="dr-view-accounts" class="absolute inset-0 p-5 overflow-y-auto hidden">
              <div class="flex items-center justify-between mb-4">
                <h3 class="font-bold text-base text-white">Gmail Account Pool</h3>
                <span class="text-xs text-gray-400">Each account contributes its free Gemini tier quota</span>
              </div>
              
              <div class="border border-gray-800 rounded-xl overflow-hidden bg-gray-950/60">
                <table class="w-full text-left text-xs">
                  <thead class="bg-gray-900/80 text-gray-400 uppercase text-[10px] border-b border-gray-800">
                    <tr>
                      <th class="px-4 py-2.5">Account / Email</th>
                      <th class="px-4 py-2.5">API Key</th>
                      <th class="px-4 py-2.5">Proxy IP</th>
                      <th class="px-4 py-2.5">Status</th>
                      <th class="px-4 py-2.5 text-center">Served</th>
                      <th class="px-4 py-2.5 text-center">In Flight</th>
                      <th class="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody id="dr-accounts-table-body" class="divide-y divide-gray-800/60 text-gray-300">
                    <!-- Dynamic Rows -->
                  </tbody>
                </table>
              </div>
            </div>

            <!-- VIEW 3: PROXIES LIST & ROUTING -->
            <div id="dr-view-proxies" class="absolute inset-0 p-5 overflow-y-auto hidden">
              <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
                <div>
                  <h3 class="font-bold text-base text-white flex items-center gap-2">
                    <span>🌐 Proxy Routing (Anti-Detection)</span>
                  </h3>
                  <span class="text-xs text-gray-400">Routes each Gmail account through a different IP address so Google sees separate locations</span>
                </div>

                <div class="flex items-center gap-2 flex-wrap">
                  <!-- Mode Switcher -->
                  <div class="flex items-center p-0.5 rounded-lg bg-gray-900/90 border border-gray-800 text-xs">
                    <button id="dr-btn-mode-dedicated" class="px-2.5 py-1 rounded-md font-medium text-xs transition-all bg-amber-500 text-black font-bold" title="Each Gmail account binds to a dedicated proxy IP">Dedicated (1:1)</button>
                    <button id="dr-btn-mode-rotating" class="px-2.5 py-1 rounded-md font-medium text-xs transition-all text-gray-400 hover:text-white" title="Requests rotate evenly across healthy proxies">Rotating Pool</button>
                  </div>

                  <button id="dr-btn-auto-assign" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg shrink-0 bg-gray-900 hover:bg-gray-800 border border-gray-700/80 hover:border-amber-400/50 text-xs font-medium text-gray-200 transition-all shadow-sm" title="Automatically assign proxies to accounts 1:1">
                    <span>🔗 Auto-Assign 1:1</span>
                  </button>

                  <button id="dr-btn-check-all-proxies" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg shrink-0 bg-gray-900 hover:bg-gray-800 border border-gray-700/80 hover:border-emerald-400/50 text-xs font-medium text-gray-200 transition-all shadow-sm" title="Check connection and latency to Google">
                    <span class="text-emerald-400">🔄</span> <span>Check all</span>
                  </button>

                  <button id="dr-btn-open-proxy-modal" class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg shrink-0 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-semibold text-xs transition-all shadow-[0_0_12px_rgba(245,158,11,0.3)]">
                    <span>+</span> <span>Add proxy</span>
                  </button>
                </div>
              </div>
              
              <div class="border border-gray-800 rounded-xl overflow-hidden bg-gray-950/60">
                <table class="w-full text-left text-xs">
                  <thead class="bg-gray-900/80 text-gray-400 uppercase text-[10px] border-b border-gray-800">
                    <tr>
                      <th class="px-4 py-2.5">Proxy Host / IP</th>
                      <th class="px-4 py-2.5">Protocol</th>
                      <th class="px-4 py-2.5">Assigned Account (1:1)</th>
                      <th class="px-4 py-2.5">Status &amp; Latency</th>
                      <th class="px-4 py-2.5 text-center">Enabled</th>
                      <th class="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody id="dr-proxies-table-body" class="divide-y divide-gray-800/60 text-gray-300">
                    <!-- Dynamic Proxy Rows -->
                  </tbody>
                </table>
              </div>
            </div>

            <!-- VIEW 4: SETTINGS -->
            <div id="dr-view-settings" class="absolute inset-0 p-6 overflow-y-auto hidden text-xs flex flex-col gap-4">
              <h3 class="font-bold text-base text-white">DR Router PRO Settings</h3>
              
              <div class="p-4 rounded-xl bg-gray-950 border border-gray-800 flex flex-col gap-3">
                <div class="flex items-center justify-between">
                  <div>
                    <h4 class="font-semibold text-white">Local Proxy Listener</h4>
                    <p class="text-gray-400 text-[11px]">Listens on 127.0.0.1:8765 to route requests from DR Dubber Pro or external tools</p>
                  </div>
                  <button id="dr-settings-proxy-btn" class="px-3 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-medium">Enabled</button>
                </div>
              </div>

              <div class="p-4 rounded-xl bg-gray-950 border border-gray-800 flex flex-col gap-3">
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <h4 class="font-semibold text-white">⚡ Fast mode</h4>
                    <p class="text-gray-400 text-[11px] leading-relaxed">Transcribes every part of the video at the same time, one part per key, and ignores API saver.
                    With 20+ keys the transcribe step of a 1-hour film takes about half the time. Uses more requests, and each part no longer sees the end of the part before it.</p>
                  </div>
                  <button id="dr-settings-fast-btn" class="shrink-0 px-3 py-1.5 rounded-lg font-medium border bg-gray-900 text-gray-400 border-gray-700">Off</button>
                </div>
              </div>

              <div class="p-4 rounded-xl bg-gray-950 border border-gray-800 flex flex-col gap-2">
                <h4 class="font-semibold text-white">How multi-account pooling works</h4>
                <p class="text-gray-400 leading-relaxed text-[11px]">
                  Google enforces free-tier Gemini limits (15 RPM / 1,500 RPD) per project/account. 
                  By adding multiple distinct Gmail accounts to DR Router PRO, the router balances your workload across the entire pool, multiplying your capacity and automatically waiting out short rate limits without stalling your dubbing pipeline.
                </p>
              </div>
            </div>

          </main>
        </div>

        <!-- BOTTOM STATUS BAR -->
        <footer class="flex items-center justify-between px-5 py-2.5 border-t border-gray-800/80 bg-[#10131c] text-xs text-gray-400">
          <div class="flex items-center gap-4">
            <span><strong id="dr-bar-ready" class="text-emerald-400">0</strong> ready</span>
            <span><strong id="dr-bar-pool" class="text-gray-200">0</strong> in the pool</span>
            <span><strong id="dr-bar-inflight" class="text-amber-400">0</strong> in flight</span>
            <span><strong id="dr-bar-served" class="text-sky-400">0</strong> served</span>
          </div>

          <!-- Progress / health indicator -->
          <div class="flex items-center gap-2">
            <div class="w-32 h-1.5 rounded-full bg-gray-800 overflow-hidden">
              <div id="dr-health-bar" class="h-full bg-emerald-400 transition-all duration-500" style="width: 100%;"></div>
            </div>
            <span id="dr-health-percent" class="text-[10px] text-gray-400">100%</span>
          </div>
        </footer>

        <!-- ADD ACCOUNT MODAL POPUP -->
        <div id="dr-add-modal" class="absolute inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4 hidden">
          <div class="w-full max-w-md bg-[#121520] border border-amber-500/30 rounded-xl p-5 shadow-2xl flex flex-col gap-4 text-xs">
            <div class="flex items-center justify-between border-b border-gray-800 pb-2">
              <span class="font-bold text-white text-sm">Add Accounts to Pool</span>
              <button id="dr-add-close" class="text-gray-400 hover:text-white text-base">✕</button>
            </div>

            <!-- Instant Google Sign-In Button -->
            <button id="dr-add-btn-google" type="button" class="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-white hover:bg-gray-100 text-gray-900 font-bold text-xs shadow-md hover:shadow-lg transition-all active:scale-98">
              <svg class="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
              <span>Sign in with Google (Instant &amp; No API Key Needed)</span>
            </button>

            <div class="flex items-center gap-2 my-0.5">
              <div class="flex-1 h-[1px] bg-gray-800"></div>
              <span class="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Or manual keys</span>
              <div class="flex-1 h-[1px] bg-gray-800"></div>
            </div>

            <!-- Single vs Bulk Tabs -->
            <div class="flex items-center gap-2">
              <button id="dr-add-tab-single" type="button" class="px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-medium text-xs">Single Key</button>
              <button id="dr-add-tab-bulk" type="button" class="px-2.5 py-1 rounded bg-gray-900 text-gray-400 hover:text-white border border-gray-800 font-medium text-xs">⚡ Bulk Paste (20+ Keys)</button>
            </div>

            <!-- Single Account Form -->
            <div id="dr-add-single-container" class="flex flex-col gap-3">
              <div class="flex flex-col gap-1.5">
                <label class="text-gray-300 font-medium">Gmail Address / Label</label>
                <input id="dr-add-email" type="text" placeholder="example@gmail.com" class="w-full px-3 py-2 rounded-lg bg-gray-950 border border-gray-800 focus:border-amber-400 text-white outline-none" />
                <p class="text-[10px] text-gray-400">Used as your account label in the orbital pool.</p>
              </div>

              <div class="flex flex-col gap-1.5">
                <label class="text-gray-300 font-medium">Gemini API Key</label>
                <input id="dr-add-key" type="password" placeholder="AIzaSy..." class="w-full px-3 py-2 rounded-lg bg-gray-950 border border-gray-800 focus:border-amber-400 text-white font-mono outline-none" />
                <p class="text-[10px] text-gray-400">Generated from Google AI Studio under this Gmail account.</p>
              </div>
            </div>

            <!-- Bulk Account Form -->
            <div id="dr-add-bulk-container" class="flex flex-col gap-2 hidden">
              <label class="text-gray-300 font-medium">Paste Keys (one per line, or email,key):</label>
              <textarea id="dr-add-bulk-text" rows="7" placeholder="AIzaSyKey1...&#10;AIzaSyKey2...&#10;user@gmail.com,AIzaSyKey3..." class="w-full px-3 py-2 rounded-lg bg-gray-950 border border-gray-800 focus:border-amber-400 text-white font-mono text-xs outline-none resize-none"></textarea>
              <p class="text-[10px] text-gray-400">Paste your 20+ keys here. Accounts will be auto-generated and added to the pool.</p>
            </div>

            <div class="flex items-center justify-end gap-2 pt-2 border-t border-gray-800">
              <button id="dr-add-cancel" class="px-3 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-800 text-gray-300">Cancel</button>
              <button id="dr-add-submit" class="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-bold shadow-[0_0_10px_rgba(245,158,11,0.4)]">Add to Pool</button>
            </div>
          </div>
        </div>

        <!-- ADD PROXY MODAL POPUP -->
        <div id="dr-proxy-modal" class="absolute inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4 hidden">
          <div class="w-full max-w-md bg-[#121520] border border-amber-500/30 rounded-xl p-5 shadow-2xl flex flex-col gap-4 text-xs">
            <div class="flex items-center justify-between border-b border-gray-800 pb-2">
              <span class="font-bold text-white text-sm">Add Proxies (HTTP / SOCKS5)</span>
              <button id="dr-proxy-modal-close" class="text-gray-400 hover:text-white text-base">✕</button>
            </div>

            <!-- Single vs Bulk Tabs -->
            <div class="flex items-center gap-2">
              <button id="dr-proxy-tab-single" type="button" class="px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-medium text-xs">Single Proxy</button>
              <button id="dr-proxy-tab-bulk" type="button" class="px-2.5 py-1 rounded bg-gray-900 text-gray-400 hover:text-white border border-gray-800 font-medium text-xs">⚡ Bulk Paste</button>
            </div>

            <!-- Single Proxy Form -->
            <div id="dr-proxy-single-form" class="flex flex-col gap-3">
              <div class="grid grid-cols-3 gap-2">
                <div class="col-span-2 flex flex-col gap-1.5">
                  <label class="text-gray-300 font-medium">Host / IP</label>
                  <input id="dr-proxy-host" type="text" placeholder="192.168.1.1 or proxy.domain.com" class="w-full px-3 py-2 rounded-lg bg-gray-950 border border-gray-800 focus:border-amber-400 text-white font-mono text-xs outline-none" />
                </div>
                <div class="flex flex-col gap-1.5">
                  <label class="text-gray-300 font-medium">Port</label>
                  <input id="dr-proxy-port-input" type="number" placeholder="8080" class="w-full px-3 py-2 rounded-lg bg-gray-950 border border-gray-800 focus:border-amber-400 text-white font-mono text-xs outline-none" />
                </div>
              </div>

              <div class="flex flex-col gap-1.5">
                <label class="text-gray-300 font-medium">Protocol</label>
                <select id="dr-proxy-protocol" class="w-full px-3 py-2 rounded-lg bg-gray-950 border border-gray-800 focus:border-amber-400 text-white text-xs outline-none">
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks5">SOCKS5</option>
                  <option value="socks4">SOCKS4</option>
                </select>
              </div>

              <div class="grid grid-cols-2 gap-2">
                <div class="flex flex-col gap-1.5">
                  <label class="text-gray-300 font-medium">Username <span class="text-gray-500 font-normal">(optional)</span></label>
                  <input id="dr-proxy-user" type="text" placeholder="username" class="w-full px-3 py-2 rounded-lg bg-gray-950 border border-gray-800 focus:border-amber-400 text-white text-xs outline-none" />
                </div>
                <div class="flex flex-col gap-1.5">
                  <label class="text-gray-300 font-medium">Password <span class="text-gray-500 font-normal">(optional)</span></label>
                  <input id="dr-proxy-pass" type="password" placeholder="••••••••" class="w-full px-3 py-2 rounded-lg bg-gray-950 border border-gray-800 focus:border-amber-400 text-white text-xs outline-none" />
                </div>
              </div>
            </div>

            <!-- Bulk Proxy Form -->
            <div id="dr-proxy-bulk-form" class="flex flex-col gap-2 hidden">
              <label class="text-gray-300 font-medium">Paste Proxies (one per line):</label>
              <textarea id="dr-proxy-bulk-text" rows="7" placeholder="1.2.3.4:8080&#10;1.2.3.4:8080:user:pass&#10;socks5://user:pass@1.2.3.4:1080&#10;http://1.2.3.4:3128" class="w-full px-3 py-2 rounded-lg bg-gray-950 border border-gray-800 focus:border-amber-400 text-white font-mono text-xs outline-none resize-none"></textarea>
              <p class="text-[10px] text-gray-400">Supports <code class="text-amber-400">ip:port</code>, <code class="text-amber-400">ip:port:user:pass</code>, or <code class="text-amber-400">protocol://user:pass@ip:port</code>.</p>
            </div>

            <div class="flex items-center justify-end gap-2 pt-2 border-t border-gray-800">
              <button id="dr-proxy-modal-cancel" class="px-3 py-1.5 rounded-lg bg-gray-900 hover:bg-gray-800 text-gray-300">Cancel</button>
              <button id="dr-proxy-modal-submit" class="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-bold shadow-[0_0_10px_rgba(245,158,11,0.4)]">Add Proxy</button>
            </div>
          </div>
        </div>

      </div>
    </div>
    `;
  }

  // ---- Live network view: Core -> heartbeat links -> accounts, with request pulses ----
  let canvas, ctx, animFrameId = null;
  let lastSeq = null;          // newest activity event already animated
  const pulses = [];           // { id, dir: 'out' | 'in', color, born, dur }
  const flashes = new Map();   // account id -> { color, born }
  const beats = [];            // times of answered requests (heart rate + monitor trace)
  const PULSE_MS = 900;
  // 'orbit' = accounts circling the Core on tilted rings; 'pulse' = heartbeat links + monitor trace.
  let viewMode = 'orbit';
  try { if (localStorage.getItem('drRouterView') === 'pulse') viewMode = 'pulse'; } catch (e) { }

  function initOrbitCanvas() {
    canvas = document.getElementById('dr-orbit-canvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }

  function resizeCanvas() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }

  function statusColor(acc) {
    if (acc.enabled === false) return '#4b5563';
    if (acc.status === 'invalid') return '#ef4444';
    if (acc.status === 'cooling') return '#f59e0b';
    return '#10b981';
  }

  // Small stable per-account number so each link's heartbeat blip sits in its own place.
  function hashOf(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  // Polyline from the Core's edge to the node with an ECG (P-QRS-T) blip along the way.
  function linkPath(cx, cy, nx, ny, seed) {
    const dx = nx - cx, dy = ny - cy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, vx = -uy, vy = ux;
    const r0 = 52;
    const span = len - r0;
    const amp = Math.min(1, span / 160);
    const at = 0.3 + (seed % 30) / 100;
    const shape = [[0, 0], [at, 0], [at + 0.03, -4], [at + 0.06, 0], [at + 0.08, 5], [at + 0.11, -24],
      [at + 0.14, 11], [at + 0.17, 0], [at + 0.24, -6], [at + 0.28, 0], [1, 0]];
    const pts = shape.map(([f, off]) => {
      const d = r0 + span * f;
      return [cx + ux * d + vx * off * amp, cy + uy * d + vy * off * amp];
    });
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    return { pts, cum, total: cum[cum.length - 1] };
  }

  function pointOnPath(path, t) {
    const target = Math.max(0, Math.min(1, t)) * path.total;
    for (let i = 1; i < path.pts.length; i++) {
      if (path.cum[i] >= target) {
        const seg = path.cum[i] - path.cum[i - 1] || 1;
        const f = (target - path.cum[i - 1]) / seg;
        const a = path.pts[i - 1], b = path.pts[i];
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      }
    }
    return path.pts[path.pts.length - 1];
  }

  function strokePath(path) {
    ctx.beginPath();
    path.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }

  function straightPath(cx, cy, nx, ny) {
    const len = Math.hypot(nx - cx, ny - cy) || 1;
    const r0 = Math.min(44, len * 0.5);
    const sx = cx + ((nx - cx) / len) * r0, sy = cy + ((ny - cy) / len) * r0;
    const total = Math.hypot(nx - sx, ny - sy);
    return { pts: [[sx, sy], [nx, ny]], cum: [0, total], total };
  }

  const ORBIT_TILT = -0.3;
  const ORBIT_RINGS = [0.5, 0.75, 1];

  function orbitGeometry(w, h) {
    const cx = w / 2, cy = h / 2;
    // Room on the right of each dot for its label; rings are flattened to 55% height.
    const rx = Math.max(110, Math.min(w / 2 - 150, (h / 2 - 34) / 0.62));
    return { cx, cy, rx, ry: rx * 0.55 };
  }

  // How many accounts sit on each ring: bigger rings hold more, a small pool uses the middle one.
  function ringCounts(n) {
    if (n <= 4) return [0, n, 0];
    const sum = ORBIT_RINGS.reduce((a, b) => a + b, 0);
    const counts = ORBIT_RINGS.map(f => Math.floor((n * f) / sum));
    let left = n - counts.reduce((a, b) => a + b, 0);
    for (let k = ORBIT_RINGS.length - 1; left > 0; k = (k + ORBIT_RINGS.length - 1) % ORBIT_RINGS.length, left--) counts[k]++;
    return counts;
  }

  function layoutNodes(w, h, now) {
    const n = accountsData.length;
    if (viewMode === 'orbit') {
      const g = orbitGeometry(w, h);
      const counts = ringCounts(n);
      const cosT = Math.cos(ORBIT_TILT), sinT = Math.sin(ORBIT_TILT);
      const nodes = [];
      let i = 0;
      counts.forEach((count, k) => {
        const rx = g.rx * ORBIT_RINGS[k], ry = g.ry * ORBIT_RINGS[k];
        const spin = ((Math.PI * 2) / (150 + 70 * k)) * (now / 1000); // one lap every few minutes
        for (let j = 0; j < count; j++, i++) {
          const acc = accountsData[i];
          const a = (Math.PI * 2 * j) / count + k * 0.7 + spin;
          const ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
          const nx = g.cx + ex * cosT - ey * sinT;
          const ny = g.cy + ex * sinT + ey * cosT;
          nodes.push({ acc, nx, ny, theta: 0, path: straightPath(g.cx, g.cy, nx, ny) });
        }
      });
      return nodes;
    }
    const cx = w / 2, cy = h / 2; // matches the Core element, which is centred in the same box
    const R = Math.max(90, Math.min(w * 0.42, h / 2 - 52)); // leave room for the monitor trace
    return accountsData.map((acc, i) => {
      const theta = -Math.PI / 2 + (i * Math.PI * 2) / Math.max(1, n);
      const r = n > 14 && i % 2 ? R * 0.74 : R;
      const nx = cx + Math.cos(theta) * r;
      const ny = cy + Math.sin(theta) * r;
      return { acc, nx, ny, theta, path: linkPath(cx, cy, nx, ny, hashOf(acc.id || String(i))) };
    });
  }

  function drawOrbits(w, h) {
    const g = orbitGeometry(w, h);
    const glow = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.rx * 0.9);
    glow.addColorStop(0, 'rgba(245, 158, 11, 0.10)');
    glow.addColorStop(1, 'rgba(245, 158, 11, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    ORBIT_RINGS.forEach((f, k) => {
      ctx.strokeStyle = `rgba(45, 212, 191, ${0.32 - k * 0.06})`;
      ctx.beginPath();
      ctx.ellipse(g.cx, g.cy, g.rx * f, g.ry * f, ORBIT_TILT, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  function statusWord(acc) {
    if (acc.enabled === false) return 'Off';
    if (acc.status === 'invalid') return 'Invalid';
    if (acc.status === 'cooling') {
      const sec = Math.ceil((acc.cooldownRemainingMs || 0) / 1000);
      return sec > 0 ? `Cooling ${sec}s` : 'Cooling';
    }
    if ((acc.inFlight || 0) > 0) return 'Working';
    return 'Ready';
  }

  function drawGrid(w, h) {
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0.5; x < w; x += 24) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = 0.5; y < h; y += 24) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  // Monitor trace along the bottom: each answered request is a heartbeat scrolling left.
  function drawMonitor(w, h, now) {
    const base = h - 20, speed = 70;
    ctx.strokeStyle = 'rgba(244, 63, 94, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, base);
    const xs = beats.map(t => w - ((now - t) / 1000) * speed).filter(x => x > -20).sort((a, b) => a - b);
    for (const x of xs) {
      ctx.lineTo(x - 8, base);
      ctx.lineTo(x - 5, base - 3);
      ctx.lineTo(x - 2, base + 4);
      ctx.lineTo(x, base - 16);
      ctx.lineTo(x + 3, base + 6);
      ctx.lineTo(x + 6, base);
    }
    ctx.lineTo(w, base);
    ctx.stroke();
  }

  function render() {
    animFrameId = null;
    if (!ctx || !canvas || !drRouterModalEl || drRouterModalEl.classList.contains('pointer-events-none')) return;
    animFrameId = requestAnimationFrame(render);

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr, h = canvas.height / dpr;
    if (!w || !h) return;
    const now = performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const orbit = viewMode === 'orbit';
    if (orbit) drawOrbits(w, h); else drawGrid(w, h);

    const nodes = layoutNodes(w, h, now);
    const byId = new Map(nodes.map(nd => [nd.acc.id, nd]));

    // Links: dim at rest, bright with a moving dash while a request is in flight.
    for (const nd of nodes) {
      const col = statusColor(nd.acc);
      const busy = (nd.acc.inFlight || 0) > 0;
      if (orbit && !busy) continue; // orbit view: a link only shows while a request runs
      ctx.globalAlpha = orbit ? 0.3 : (busy ? 0.9 : 0.35);
      ctx.strokeStyle = col;
      ctx.lineWidth = busy ? 1.8 : 1.1;
      ctx.setLineDash([]);
      strokePath(nd.path);
      if (busy) {
        ctx.globalAlpha = orbit ? 0.45 : 0.9;
        ctx.strokeStyle = '#fde68a';
        ctx.setLineDash([4, 10]);
        ctx.lineDashOffset = -now / 25;
        strokePath(nd.path);
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;

    // Pulses travelling along the links.
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      const nd = byId.get(p.id);
      const t = (now - p.born) / p.dur;
      if (!nd || t >= 1) { pulses.splice(i, 1); continue; }
      for (let k = 0; k < 4; k++) {
        const tt = t - k * 0.035;
        if (tt < 0) continue;
        const [x, y] = pointOnPath(nd.path, p.dir === 'out' ? tt : 1 - tt);
        ctx.globalAlpha = 1 - k * 0.24;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = k ? 0 : 12;
        ctx.beginPath();
        ctx.arc(x, y, k ? 2.2 : 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;

    // Nodes + labels.
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const nd of nodes) {
      const col = statusColor(nd.acc);
      const fl = flashes.get(nd.acc.id);
      if (fl) {
        const ft = (now - fl.born) / 900;
        if (ft >= 1) flashes.delete(nd.acc.id);
        else {
          ctx.strokeStyle = fl.color;
          ctx.globalAlpha = 1 - ft;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(nd.nx, nd.ny, 6 + ft * 16, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = (nd.acc.inFlight || 0) > 0 ? 14 : 6;
      ctx.beginPath();
      ctx.arc(nd.nx, nd.ny, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      if (orbit) {
        const name = nd.acc.maskedEmail || '';
        ctx.textAlign = 'left';
        ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = '#f3f4f6';
        ctx.fillText(name, nd.nx + 10, nd.ny - 6);
        const nameW = ctx.measureText(name).width;
        ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = '#9ca3af';
        ctx.fillText(String(nd.acc.served || 0), nd.nx + 22 + nameW, nd.ny - 6);
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = (nd.acc.inFlight || 0) > 0 && nd.acc.status === 'ready' ? '#fbbf24' : col;
        ctx.fillText(statusWord(nd.acc), nd.nx + 10, nd.ny + 7);
        continue;
      }
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      const right = Math.cos(nd.theta) >= -0.01;
      ctx.textAlign = right ? 'left' : 'right';
      const lx = nd.nx + (right ? 10 : -10);
      ctx.fillStyle = '#d1d5db';
      const name = nd.acc.maskedEmail || '';
      ctx.fillText(name, lx, nd.ny);
      const nameW = ctx.measureText(name).width;
      ctx.fillStyle = '#9ca3af';
      ctx.fillText(String(nd.acc.served || 0), lx + (right ? nameW + 6 : -nameW - 6), nd.ny);
    }

    if (!orbit) drawMonitor(w, h, now);
  }

  function startOrbitLoop() {
    if (!animFrameId) animFrameId = requestAnimationFrame(render);
  }

  function stopOrbitLoop() {
    if (animFrameId) cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  function beatCore() {
    const core = document.getElementById('dr-core-sun');
    if (core && core.animate) {
      core.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'ease-out' });
    }
  }

  function playActivity(activity) {
    if (!activity) return;
    if (lastSeq === null) { lastSeq = activity.seq; return; } // don't replay history on open
    const now = performance.now();
    const events = (activity.events || []).slice(-40);
    events.forEach((ev, i) => {
      const born = now + i * 60; // stagger a burst so each pulse stays visible
      if (ev.type === 'start') pulses.push({ id: ev.id, dir: 'out', color: '#fbbf24', born, dur: PULSE_MS });
      else if (ev.type === 'ok') {
        pulses.push({ id: ev.id, dir: 'in', color: '#34d399', born, dur: PULSE_MS });
        beats.push(now + i * 60 + PULSE_MS);
        setTimeout(beatCore, i * 60 + PULSE_MS);
      } else if (ev.type === 'cool') flashes.set(ev.id, { color: '#f59e0b', born });
      else if (ev.type === 'invalid') flashes.set(ev.id, { color: '#ef4444', born });
    });
    lastSeq = activity.seq;
    const cutoff = now - 60000;
    while (beats.length && beats[0] < cutoff) beats.shift();
  }

  function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Fetch accounts and update UI
  async function fetchDRRouterData() {
    try {
      const [accRes, proxRes] = await Promise.all([
        fetch(`${API_BASE}/accounts${lastSeq === null ? '' : `?since=${lastSeq}`}`),
        fetch(`${API_BASE}/proxies`)
      ]);
      if (accRes && accRes.ok) {
        const data = await accRes.json();
        if (data && data.success) {
          accountsData = data.accounts || [];
          statsData = data.stats || statsData;
          playActivity(data.activity);
        }
      }
      if (proxRes && proxRes.ok) {
        const pData = await proxRes.json();
        if (pData && pData.success) {
          proxiesData = pData.proxies || [];
          if (pData.proxyMode) proxyMode = pData.proxyMode;
        }
      }
      updateUI();
    } catch (e) {
      // offline / not listening
    }
  }

  function updateUI() {
    // Stats cards
    const readyEl = document.getElementById('dr-stat-ready');
    const totalEl = document.getElementById('dr-stat-total');
    if (readyEl) readyEl.textContent = statsData.ready;
    if (totalEl) totalEl.textContent = statsData.total;

    // Bottom Bar
    const barReady = document.getElementById('dr-bar-ready');
    const barPool = document.getElementById('dr-bar-pool');
    const barInFlight = document.getElementById('dr-bar-inflight');
    const barServed = document.getElementById('dr-bar-served');
    if (barReady) barReady.textContent = statsData.ready;
    if (barPool) barPool.textContent = statsData.total;
    if (barInFlight) barInFlight.textContent = statsData.inFlight;
    if (barServed) barServed.textContent = statsData.served;

    // Health bar
    const healthPercent = statsData.total ? Math.round((statsData.ready / statsData.total) * 100) : 100;
    const barEl = document.getElementById('dr-health-bar');
    const barText = document.getElementById('dr-health-percent');
    if (barEl) barEl.style.width = `${healthPercent}%`;
    if (barText) barText.textContent = `${healthPercent}%`;

    // HUD: heart rate = requests answered in the last minute
    const nowMs = performance.now();
    const bpmEl = document.getElementById('dr-hud-bpm');
    const hudReady = document.getElementById('dr-hud-ready');
    if (bpmEl) bpmEl.textContent = beats.filter(t => t > nowMs - 60000 && t <= nowMs + PULSE_MS).length;
    if (hudReady) hudReady.textContent = statsData.ready;

    // Core status text
    const coreText = document.getElementById('dr-core-status-text');
    if (coreText) {
      if (statsData.total === 0) coreText.textContent = 'Add accounts to start';
      else if (statsData.ready === statsData.total) coreText.textContent = 'Every account is ready';
      else if (statsData.ready > 0) coreText.textContent = `${statsData.ready} of ${statsData.total} ready`;
      else coreText.textContent = 'All accounts resting';
    }

    // DR Dubber card: is the app using the pool right now?
    const clientDot = document.getElementById('dr-client-dot');
    const clientSeen = document.getElementById('dr-client-seen');
    const ago = statsData.lastRequestAt ? Math.max(0, Date.now() - statsData.lastRequestAt) : null;
    let seenText = 'No requests yet';
    let live = false;
    if (statsData.linked === false && !(statsData.inFlight > 0)) seenText = 'Not linked · dubbing uses only your own keys';
    else if (statsData.inFlight > 0) { seenText = `Working now · ${statsData.inFlight} in flight`; live = true; }
    else if (ago !== null && ago < 120000) { seenText = `Active · last request ${Math.round(ago / 1000)}s ago`; live = true; }
    else if (ago !== null) { seenText = `Idle · last request ${Math.round(ago / 60000)} min ago`; }
    if (clientSeen) clientSeen.textContent = seenText;
    if (clientDot) clientDot.className = `w-2 h-2 rounded-full ${live ? 'bg-emerald-400' : 'bg-gray-500'}`;

    // Fast mode
    const fast = statsData.fastMode === true;
    document.getElementById('dr-hud-fast')?.classList.toggle('hidden', !fast);
    const fastBtn = document.getElementById('dr-settings-fast-btn');
    if (fastBtn) {
      fastBtn.textContent = fast ? 'On' : 'Off';
      fastBtn.className = `shrink-0 px-3 py-1.5 rounded-lg font-medium border ${fast ? 'bg-amber-500 text-black border-amber-400' : 'bg-gray-900 text-gray-400 border-gray-700 hover:text-white'}`;
    }

    // Link pill
    const linked = statsData.linked !== false;
    const linkBtn = document.getElementById('dr-link-btn');
    if (linkBtn) {
      linkBtn.className = `flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${linked ? 'bg-emerald-950/60 text-emerald-300 border-emerald-500/30 hover:border-emerald-400/60' : 'bg-gray-900 text-gray-300 border-gray-700 hover:border-amber-500/50'}`;
      const icon = document.getElementById('dr-link-icon');
      const text = document.getElementById('dr-link-text');
      if (icon) icon.textContent = linked ? '🔗' : '+';
      if (text) text.textContent = linked ? 'Linked' : 'Link';
    }

    // Proxy on/off
    const on = statsData.proxyActive !== false;
    const proxyDot = document.getElementById('dr-proxy-dot');
    const proxyBadge = document.getElementById('dr-proxy-badge');
    const proxyPort = document.getElementById('dr-proxy-port');
    const proxyLine = document.getElementById('dr-client-proxy');
    const settingsProxy = document.getElementById('dr-settings-proxy-btn');
    if (proxyDot) proxyDot.className = `w-2 h-2 rounded-full ${on ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'}`;
    if (proxyBadge) {
      proxyBadge.textContent = on ? 'Active' : 'Off';
      proxyBadge.className = `px-1.5 rounded text-[10px] border ${on ? 'bg-emerald-950/80 text-emerald-400 border-emerald-500/30' : 'bg-gray-900 text-gray-400 border-gray-700'}`;
    }
    if (proxyPort && statsData.port) proxyPort.textContent = statsData.port;
    if (proxyLine) {
      proxyLine.textContent = on ? `● Listening on :${statsData.port || 8765}` : '○ Proxy off';
      proxyLine.className = `text-[10px] mt-0.5 ${on ? 'text-emerald-400/80' : 'text-gray-500'}`;
    }
    if (settingsProxy) {
      settingsProxy.textContent = on ? 'Enabled' : 'Disabled';
      settingsProxy.className = `px-3 py-1.5 rounded-lg font-medium border ${on ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-gray-900 text-gray-400 border-gray-700'}`;
    }

    // Orbit / Pulse switch
    document.querySelectorAll('.dr-view-btn').forEach(btn => {
      const active = btn.dataset.view === viewMode;
      btn.className = `dr-view-btn px-2.5 py-1 rounded-md font-medium ${active ? 'bg-amber-500 text-black' : 'text-gray-400 hover:text-white'}`;
    });
    document.getElementById('dr-core-icon-orbit')?.classList.toggle('hidden', viewMode !== 'orbit');
    document.getElementById('dr-core-icon-pulse')?.classList.toggle('hidden', viewMode !== 'pulse');

    // Strategy buttons
    document.querySelectorAll('.dr-strat-btn').forEach(btn => {
      const active = btn.dataset.strategy === statsData.strategy;
      btn.className = `dr-strat-btn px-2.5 py-1 rounded-md text-xs font-medium ${active ? 'bg-amber-500 text-black font-bold shadow-sm' : 'text-gray-400 hover:text-white'}`;
    });

    // Accounts Table
    const tbody = document.getElementById('dr-accounts-table-body');
    if (tbody) {
      if (!accountsData.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-8 text-center text-gray-500">No Gmail accounts added yet. Click "+ Add account" to start pooling.</td></tr>`;
      } else {
        tbody.innerHTML = accountsData.map(acc => {
          let statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-500/30">Ready</span>`;
          if (acc.status === 'cooling') {
            const sec = Math.ceil((acc.cooldownRemainingMs || 0) / 1000);
            statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-amber-950 text-amber-400 border border-amber-500/30">Cooling (${sec}s)</span>`;
          } else if (acc.status === 'invalid') {
            statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-red-950 text-red-400 border border-red-500/30">Invalid</span>`;
          }

          const proxyPill = acc.proxyHost
            ? `<span class="px-2 py-0.5 rounded text-[10px] font-mono ${acc.proxyStatus === 'online' ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/30' : (acc.proxyStatus === 'offline' ? 'bg-red-950 text-red-300 border border-red-500/30' : 'bg-gray-900 text-gray-300 border border-gray-700')}">🌐 ${escapeHtml(acc.proxyHost)}</span>`
            : `<span class="text-gray-500 text-[10px]">Direct (No Proxy)</span>`;

          return `
            <tr class="hover:bg-gray-900/40 transition-colors">
              <td class="px-4 py-3 font-medium text-white flex items-center gap-2">
                <span class="w-2 h-2 rounded-full ${acc.status === 'ready' ? 'bg-emerald-400' : (acc.status === 'cooling' ? 'bg-amber-400' : 'bg-red-400')}"></span>
                <span>${escapeHtml(acc.email)}</span>
              </td>
              <td class="px-4 py-3 font-mono text-gray-400">${escapeHtml(acc.maskedKey)}</td>
              <td class="px-4 py-3">${proxyPill}</td>
              <td class="px-4 py-3">${statusBadge}</td>
              <td class="px-4 py-3 text-center font-bold text-gray-200">${acc.served}</td>
              <td class="px-4 py-3 text-center text-amber-400">${acc.inFlight}</td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-1.5">
                  <button data-action="test" data-id="${acc.id}" class="px-2 py-1 rounded bg-gray-900 hover:bg-gray-800 text-gray-300 border border-gray-700/60" title="Test this key">⚡</button>
                  <button data-action="delete" data-id="${acc.id}" class="px-2 py-1 rounded bg-gray-900 hover:bg-red-500/20 text-gray-400 hover:text-red-300 border border-gray-700/60" title="Delete account">🗑️</button>
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }
    }

    // Proxies Mode Buttons
    const btnDedicated = document.getElementById('dr-btn-mode-dedicated');
    const btnRotating = document.getElementById('dr-btn-mode-rotating');
    if (btnDedicated && btnRotating) {
      if (proxyMode === 'rotating') {
        btnRotating.className = 'px-2.5 py-1 rounded-md font-medium text-xs transition-all bg-amber-500 text-black font-bold';
        btnDedicated.className = 'px-2.5 py-1 rounded-md font-medium text-xs transition-all text-gray-400 hover:text-white';
      } else {
        btnDedicated.className = 'px-2.5 py-1 rounded-md font-medium text-xs transition-all bg-amber-500 text-black font-bold';
        btnRotating.className = 'px-2.5 py-1 rounded-md font-medium text-xs transition-all text-gray-400 hover:text-white';
      }
    }

    // Proxies Table
    const pTbody = document.getElementById('dr-proxies-table-body');
    if (pTbody) {
      if (!proxiesData.length) {
        pTbody.innerHTML = `<tr><td colspan="6" class="px-4 py-8 text-center text-gray-500">No proxies configured yet. Click "+ Add proxy" or "Bulk Import" to assign IPs to your accounts.</td></tr>`;
      } else {
        pTbody.innerHTML = proxiesData.map(p => {
          let statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-gray-900 text-gray-400 border border-gray-700">Untested</span>`;
          if (p.status === 'online') {
            statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-emerald-950 text-emerald-300 border border-emerald-500/30 flex items-center gap-1 w-fit"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Online ${p.latencyMs ? `(${p.latencyMs}ms)` : ''}</span>`;
          } else if (p.status === 'offline') {
            statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-red-950 text-red-300 border border-red-500/30 flex items-center gap-1 w-fit"><span class="w-1.5 h-1.5 rounded-full bg-red-400"></span> Offline</span>`;
          } else if (p.status === 'checking') {
            statusBadge = `<span class="px-2 py-0.5 rounded text-[10px] bg-amber-950 text-amber-300 border border-amber-500/30 animate-pulse w-fit">Testing...</span>`;
          }

          const accountOpts = [
            `<option value="">-- Direct / Unassigned --</option>`,
            ...accountsData.map(a => `<option value="${a.id}" ${p.accountId === a.id ? 'selected' : ''}>${escapeHtml(a.email)}</option>`)
          ].join('');

          return `
            <tr class="hover:bg-gray-900/40 transition-colors">
              <td class="px-4 py-3 font-mono text-white flex items-center gap-2">
                <span>🌐</span>
                <span class="font-bold">${escapeHtml(p.host)}:${p.port}</span>
                ${p.hasAuth ? `<span class="text-amber-400 text-[10px]" title="Authenticated">🔒</span>` : ''}
              </td>
              <td class="px-4 py-3 uppercase text-[10px] font-bold text-gray-400">${escapeHtml(p.protocol)}</td>
              <td class="px-4 py-3">
                <select data-action="bind-proxy" data-proxy-id="${p.id}" class="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-200 outline-none hover:border-gray-700 focus:border-amber-400">
                  ${accountOpts}
                </select>
              </td>
              <td class="px-4 py-3">${statusBadge}</td>
              <td class="px-4 py-3 text-center">
                <input type="checkbox" data-action="toggle-proxy-enabled" data-id="${p.id}" ${p.enabled !== false ? 'checked' : ''} class="w-4 h-4 rounded bg-gray-900 border-gray-700 text-amber-500 focus:ring-0 cursor-pointer" />
              </td>
              <td class="px-4 py-3 text-right">
                <div class="flex items-center justify-end gap-1.5">
                  <button data-action="test-proxy" data-id="${p.id}" class="px-2 py-1 rounded bg-gray-900 hover:bg-gray-800 text-gray-300 border border-gray-700/60" title="Test this proxy">⚡ Test</button>
                  <button data-action="delete-proxy" data-id="${p.id}" class="px-2 py-1 rounded bg-gray-900 hover:bg-red-500/20 text-gray-400 hover:text-red-300 border border-gray-700/60" title="Delete proxy">🗑️</button>
                </div>
              </td>
            </tr>
          `;
        }).join('');
      }
    }
  }

  function bindEvents() {
    // Close button
    document.getElementById('dr-btn-close')?.addEventListener('click', closeDRRouterModal);

    // Orbit / Pulse view
    document.querySelectorAll('.dr-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        viewMode = btn.dataset.view === 'pulse' ? 'pulse' : 'orbit';
        try { localStorage.setItem('drRouterView', viewMode); } catch (e) { }
        updateUI();
      });
    });

    // Proxy on/off (header pill and Settings button)
    async function toggleProxy() {
      try {
        await fetch(`${API_BASE}/proxy/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: statsData.proxyActive === false })
        });
        setTimeout(fetchDRRouterData, 300); // the server reports "listening" once the port is open
      } catch (e) { }
    }
    document.getElementById('dr-proxy-toggle-btn')?.addEventListener('click', toggleProxy);

    // Fast mode on / off
    document.getElementById('dr-settings-fast-btn')?.addEventListener('click', async () => {
      try {
        const res = await fetch(`${API_BASE}/fast-mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: statsData.fastMode !== true })
        });
        const d = await res.json();
        if (d && d.stats) { statsData = d.stats; updateUI(); }
      } catch (e) { }
    });

    // Link / unlink DR Dubber's dubbing from the pool
    document.getElementById('dr-link-btn')?.addEventListener('click', async () => {
      const next = statsData.linked === false;
      if (!next && !confirm('Unlink DR Dubber from the pool?\n\nDubbing will use only the API keys in Settings. The proxy keeps serving other tools.')) return;
      try {
        const res = await fetch(`${API_BASE}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linked: next })
        });
        const d = await res.json();
        if (d && d.stats) { statsData = d.stats; updateUI(); }
      } catch (e) { }
    });
    document.getElementById('dr-settings-proxy-btn')?.addEventListener('click', toggleProxy);

    // Strategy switch
    document.querySelectorAll('.dr-strat-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const strat = btn.dataset.strategy;
        try {
          await fetch(`${API_BASE}/strategy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ strategy: strat })
          });
          statsData.strategy = strat;
          updateUI();
        } catch (e) { }
      });
    });

    // Nav tabs
    document.querySelectorAll('.dr-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        switchTab(tab);
      });
    });

    // Add Account button & modal
    const addModal = document.getElementById('dr-add-modal');
    document.getElementById('dr-btn-add-account')?.addEventListener('click', () => {
      if (addModal) addModal.classList.remove('hidden');
      document.getElementById('dr-add-email')?.focus();
    });

    document.getElementById('dr-add-close')?.addEventListener('click', () => {
      if (addModal) addModal.classList.add('hidden');
    });

    document.getElementById('dr-add-cancel')?.addEventListener('click', () => {
      if (addModal) addModal.classList.add('hidden');
    });

    // Add Account modal tab toggle
    let addMode = 'single'; // 'single' | 'bulk'
    const tabSingle = document.getElementById('dr-add-tab-single');
    const tabBulk = document.getElementById('dr-add-tab-bulk');
    const singleContainer = document.getElementById('dr-add-single-container');
    const bulkContainer = document.getElementById('dr-add-bulk-container');

    tabSingle?.addEventListener('click', () => {
      addMode = 'single';
      tabSingle.className = 'px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-medium text-xs';
      tabBulk.className = 'px-2.5 py-1 rounded bg-gray-900 text-gray-400 hover:text-white border border-gray-800 font-medium text-xs';
      singleContainer?.classList.remove('hidden');
      bulkContainer?.classList.add('hidden');
    });

    tabBulk?.addEventListener('click', () => {
      addMode = 'bulk';
      tabBulk.className = 'px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-medium text-xs';
      tabSingle.className = 'px-2.5 py-1 rounded bg-gray-900 text-gray-400 hover:text-white border border-gray-800 font-medium text-xs';
      bulkContainer?.classList.remove('hidden');
      singleContainer?.classList.add('hidden');
      document.getElementById('dr-add-bulk-text')?.focus();
    });

    document.getElementById('dr-add-submit')?.addEventListener('click', async () => {
      if (addMode === 'bulk') {
        const rawText = document.getElementById('dr-add-bulk-text')?.value.trim();
        if (!rawText) {
          alert('Please paste at least one Gemini API key.');
          return;
        }
        try {
          const res = await fetch(`${API_BASE}/account/bulk-add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawText })
          });
          const d = await res.json();
          if (d.success) {
            if (addModal) addModal.classList.add('hidden');
            document.getElementById('dr-add-bulk-text').value = '';
            fetchDRRouterData();
          } else {
            alert(d.error || 'Failed to add accounts.');
          }
        } catch (e) {
          alert(e.message);
        }
      } else {
        const email = document.getElementById('dr-add-email')?.value.trim();
        const apiKey = document.getElementById('dr-add-key')?.value.trim();
        if (!apiKey) {
          alert('Please enter a Gemini API Key.');
          return;
        }
        try {
          const res = await fetch(`${API_BASE}/account/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, apiKey })
          });
          const d = await res.json();
          if (d.success) {
            if (addModal) addModal.classList.add('hidden');
            document.getElementById('dr-add-email').value = '';
            document.getElementById('dr-add-key').value = '';
            fetchDRRouterData();
          } else {
            alert(d.error || 'Failed to add account.');
          }
        } catch (e) {
          alert(e.message);
        }
      }
    });

    // Google Sign-In Handlers
    async function triggerGoogleLogin() {
      if (!window.electronAPI || typeof window.electronAPI.drRouterGoogleLogin !== 'function') {
        alert('Google direct sign-in is available in the DR Dubber Pro desktop application.');
        return;
      }
      const btn1 = document.getElementById('dr-btn-google-login');
      const btn2 = document.getElementById('dr-add-btn-google');
      if (btn1) btn1.innerHTML = `<span>⏳</span> <span>Signing in...</span>`;
      if (btn2) btn2.innerHTML = `<span>⏳</span> <span>Signing in...</span>`;

      try {
        const result = await window.electronAPI.drRouterGoogleLogin();
        if (result && result.success && result.apiKey) {
          const res = await fetch(`${API_BASE}/account/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: result.email, apiKey: result.apiKey })
          });
          const d = await res.json();
          if (d.success) {
            if (addModal) addModal.classList.add('hidden');
            fetchDRRouterData();
            alert(`Account ${result.email} linked and added to the pool successfully!`);
          } else {
            alert(d.error || 'Failed to add account.');
          }
        } else if (result && result.error && result.error !== 'Login window closed.') {
          alert(`Sign-in error: ${result.error}`);
        }
      } catch (err) {
        alert(`Google Sign-In failed: ${err.message}`);
      } finally {
        if (btn1) btn1.innerHTML = `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg><span>Sign in</span>`;
        if (btn2) btn2.innerHTML = `<svg class="w-4 h-4" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg><span>Sign in with Google (Instant &amp; No API Key Needed)</span>`;
      }
    }

    document.getElementById('dr-btn-google-login')?.addEventListener('click', triggerGoogleLogin);
    document.getElementById('dr-add-btn-google')?.addEventListener('click', triggerGoogleLogin);

    // Verify all
    document.getElementById('dr-btn-verify-all')?.addEventListener('click', async () => {
      const btn = document.getElementById('dr-btn-verify-all');
      if (btn) btn.innerHTML = `<span>⏳</span> <span>Verifying...</span>`;
      try {
        await fetch(`${API_BASE}/verify-all`, { method: 'POST' });
        await fetchDRRouterData();
      } catch (e) {
      } finally {
        if (btn) btn.innerHTML = `<span class="text-emerald-400">🔄</span> <span>Verify all</span>`;
      }
    });

    // Send a test
    document.getElementById('dr-btn-send-test')?.addEventListener('click', async () => {
      const ready = accountsData.find(a => a.status === 'ready');
      if (!ready) {
        alert('No ready accounts to test.');
        return;
      }
      const btn = document.getElementById('dr-btn-send-test');
      if (btn) btn.innerHTML = `<span>⏳</span> <span>Testing...</span>`;
      try {
        const res = await fetch(`${API_BASE}/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: ready.id })
        });
        const d = await res.json();
        alert(`Test result for ${ready.email}: ${d.result?.message || 'OK'}`);
        await fetchDRRouterData();
      } catch (e) {
        alert(`Test error: ${e.message}`);
      } finally {
        if (btn) btn.innerHTML = `<span class="text-amber-400">⚡</span> <span>Test</span>`;
      }
    });

    // Table actions (test, delete)
    document.getElementById('dr-accounts-table-body')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'delete') {
        if (!confirm('Remove this account from the pool?')) return;
        try {
          await fetch(`${API_BASE}/account/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          fetchDRRouterData();
        } catch (err) { }
      } else if (action === 'test') {
        btn.textContent = '⏳';
        try {
          const res = await fetch(`${API_BASE}/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          const d = await res.json();
          alert(`Test result: ${d.result?.message || 'OK'}`);
          fetchDRRouterData();
        } catch (err) {
          alert(`Error: ${err.message}`);
        } finally {
          btn.textContent = '⚡';
        }
      }
    });

    // Proxy Modal Handlers
    const proxyModal = document.getElementById('dr-proxy-modal');
    document.getElementById('dr-btn-open-proxy-modal')?.addEventListener('click', () => {
      if (proxyModal) proxyModal.classList.remove('hidden');
      document.getElementById('dr-proxy-host')?.focus();
    });

    document.getElementById('dr-btn-bulk-proxy')?.addEventListener('click', () => {
      if (proxyModal) {
        proxyModal.classList.remove('hidden');
        document.getElementById('dr-proxy-tab-bulk')?.click();
      }
    });

    document.getElementById('dr-proxy-modal-close')?.addEventListener('click', () => {
      if (proxyModal) proxyModal.classList.add('hidden');
    });

    document.getElementById('dr-proxy-modal-cancel')?.addEventListener('click', () => {
      if (proxyModal) proxyModal.classList.add('hidden');
    });

    // Proxy modal single vs bulk tab switch
    let proxyAddMode = 'single';
    const tabProxySingle = document.getElementById('dr-proxy-tab-single');
    const tabProxyBulk = document.getElementById('dr-proxy-tab-bulk');
    const formProxySingle = document.getElementById('dr-proxy-single-form');
    const formProxyBulk = document.getElementById('dr-proxy-bulk-form');

    tabProxySingle?.addEventListener('click', () => {
      proxyAddMode = 'single';
      tabProxySingle.className = 'px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-medium text-xs';
      tabProxyBulk.className = 'px-2.5 py-1 rounded bg-gray-900 text-gray-400 hover:text-white border border-gray-800 font-medium text-xs';
      formProxySingle?.classList.remove('hidden');
      formProxyBulk?.classList.add('hidden');
    });

    tabProxyBulk?.addEventListener('click', () => {
      proxyAddMode = 'bulk';
      tabProxyBulk.className = 'px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-medium text-xs';
      tabProxySingle.className = 'px-2.5 py-1 rounded bg-gray-900 text-gray-400 hover:text-white border border-gray-800 font-medium text-xs';
      formProxyBulk?.classList.remove('hidden');
      formProxySingle?.classList.add('hidden');
      document.getElementById('dr-proxy-bulk-text')?.focus();
    });

    // Submit proxy
    document.getElementById('dr-proxy-modal-submit')?.addEventListener('click', async () => {
      if (proxyAddMode === 'bulk') {
        const rawText = document.getElementById('dr-proxy-bulk-text')?.value.trim();
        if (!rawText) {
          alert('Please paste at least one proxy.');
          return;
        }
        try {
          const res = await fetch(`${API_BASE}/proxy/bulk-add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawText })
          });
          const d = await res.json();
          if (d.success) {
            if (proxyModal) proxyModal.classList.add('hidden');
            document.getElementById('dr-proxy-bulk-text').value = '';
            fetchDRRouterData();
          } else {
            alert(d.error || 'Failed to add proxies.');
          }
        } catch (e) {
          alert(e.message);
        }
      } else {
        const host = document.getElementById('dr-proxy-host')?.value.trim();
        const port = document.getElementById('dr-proxy-port-input')?.value.trim();
        const protocol = document.getElementById('dr-proxy-protocol')?.value || 'http';
        const username = document.getElementById('dr-proxy-user')?.value.trim();
        const password = document.getElementById('dr-proxy-pass')?.value.trim();

        if (!host) {
          alert('Please enter a proxy host or IP.');
          return;
        }
        try {
          const res = await fetch(`${API_BASE}/proxy/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port: parseInt(port, 10) || 8080, protocol, username, password })
          });
          const d = await res.json();
          if (d.success) {
            if (proxyModal) proxyModal.classList.add('hidden');
            document.getElementById('dr-proxy-host').value = '';
            document.getElementById('dr-proxy-port-input').value = '';
            document.getElementById('dr-proxy-user').value = '';
            document.getElementById('dr-proxy-pass').value = '';
            fetchDRRouterData();
          } else {
            alert(d.error || 'Failed to add proxy.');
          }
        } catch (e) {
          alert(e.message);
        }
      }
    });

    // Proxy Mode Switch (Dedicated vs Rotating)
    document.getElementById('dr-btn-mode-dedicated')?.addEventListener('click', async () => {
      try {
        await fetch(`${API_BASE}/proxy/mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'dedicated' })
        });
        proxyMode = 'dedicated';
        updateUI();
      } catch (e) { }
    });

    document.getElementById('dr-btn-mode-rotating')?.addEventListener('click', async () => {
      try {
        await fetch(`${API_BASE}/proxy/mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'rotating' })
        });
        proxyMode = 'rotating';
        updateUI();
      } catch (e) { }
    });

    // Auto-Assign 1:1 Proxies
    document.getElementById('dr-btn-auto-assign')?.addEventListener('click', async () => {
      try {
        const res = await fetch(`${API_BASE}/proxy/auto-assign`, {
          method: 'POST'
        });
        const d = await res.json();
        if (d.success) {
          await fetchDRRouterData();
          alert(`Auto-assigned ${d.assignedCount || 0} proxies 1:1 to accounts.`);
        }
      } catch (e) {
        alert(`Auto-assign error: ${e.message}`);
      }
    });

    // Check all proxies
    document.getElementById('dr-btn-check-all-proxies')?.addEventListener('click', async () => {
      const btn = document.getElementById('dr-btn-check-all-proxies');
      if (btn) btn.innerHTML = `<span>⏳</span> <span>Checking...</span>`;
      try {
        await fetch(`${API_BASE}/proxy/test-all`, { method: 'POST' });
        await fetchDRRouterData();
      } catch (e) {
      } finally {
        if (btn) btn.innerHTML = `<span class="text-emerald-400">🔄</span> <span>Check all</span>`;
      }
    });

    // Proxies table delegations (bind, toggle enabled, test, delete)
    const pTbody = document.getElementById('dr-proxies-table-body');
    pTbody?.addEventListener('change', async (e) => {
      const bindSel = e.target.closest('select[data-action="bind-proxy"]');
      if (bindSel) {
        const proxyId = bindSel.dataset.proxyId;
        const accountId = bindSel.value || null;
        try {
          await fetch(`${API_BASE}/proxy/bind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId, proxyId })
          });
          fetchDRRouterData();
        } catch (err) { }
        return;
      }

      const toggleInput = e.target.closest('input[data-action="toggle-proxy-enabled"]');
      if (toggleInput) {
        const id = toggleInput.dataset.id;
        const enabled = toggleInput.checked;
        try {
          await fetch(`${API_BASE}/proxy/toggle-enabled`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, enabled })
          });
          fetchDRRouterData();
        } catch (err) { }
      }
    });

    pTbody?.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'delete-proxy') {
        if (!confirm('Remove this proxy from the list?')) return;
        try {
          await fetch(`${API_BASE}/proxy/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          fetchDRRouterData();
        } catch (err) { }
      } else if (action === 'test-proxy') {
        btn.textContent = '⏳ Testing';
        try {
          const res = await fetch(`${API_BASE}/proxy/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          const d = await res.json();
          alert(d.result?.success ? `Proxy Online! Latency: ${d.result.latencyMs}ms` : `Proxy Offline: ${d.result?.error || 'Failed'}`);
          fetchDRRouterData();
        } catch (err) {
          alert(`Test error: ${err.message}`);
        } finally {
          btn.textContent = '⚡ Test';
        }
      }
    });
  }

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.dr-nav-item').forEach(btn => {
      if (btn.dataset.tab === tab) {
        btn.classList.add('text-white', 'bg-amber-500/10', 'border', 'border-amber-500/20');
        btn.classList.remove('text-gray-400');
      } else {
        btn.classList.remove('text-white', 'bg-amber-500/10', 'border', 'border-amber-500/20');
        btn.classList.add('text-gray-400');
      }
    });

    const vDash = document.getElementById('dr-view-dashboard');
    const vAccs = document.getElementById('dr-view-accounts');
    const vProx = document.getElementById('dr-view-proxies');
    const vSets = document.getElementById('dr-view-settings');

    if (vDash) vDash.classList.toggle('hidden', tab !== 'dashboard');
    if (vAccs) vAccs.classList.toggle('hidden', tab !== 'accounts');
    if (vProx) vProx.classList.toggle('hidden', tab !== 'proxies');
    if (vSets) vSets.classList.toggle('hidden', tab !== 'settings');

    if (tab === 'dashboard') {
      resizeCanvas();
    }
  }

  function openDRRouterModal() {
    if (!drRouterModalEl) {
      document.body.insertAdjacentHTML('beforeend', createModalHtml());
      drRouterModalEl = document.getElementById('dr-router-modal');
      bindEvents();
      initOrbitCanvas();
    }

    drRouterModalEl.classList.remove('pointer-events-none', 'opacity-0');
    drRouterModalEl.classList.add('opacity-100');

    lastSeq = null;
    fetchDRRouterData();
    if (!pollInterval) {
      pollInterval = setInterval(fetchDRRouterData, 1000);
    }
    resizeCanvas();
    startOrbitLoop();
  }

  function closeDRRouterModal() {
    if (!drRouterModalEl) return;
    drRouterModalEl.classList.add('opacity-0', 'pointer-events-none');
    drRouterModalEl.classList.remove('opacity-100');
    stopOrbitLoop();
    pulses.length = 0;
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  // The pool's ready keys, kept fresh for the app's batch: Dub Whole Series / Batch Transcribe
  // give every key a tab of its own, Settings keys first, then the pool's (DR Router linked).
  const pool = { keys: [] };
  async function refreshPoolKeys() {
    try {
      const res = await fetch(`${API_BASE}/dubber-keys`);
      const d = await res.json();
      if (d && d.success && Array.isArray(d.keys)) pool.keys = d.keys.filter(Boolean);
    } catch (e) { /* backend not up yet: keep the last list */ }
    return pool.keys.slice();
  }
  window.drPool = {
    keys: () => pool.keys.slice(),
    refresh: refreshPoolKeys,
    // Settings keys first (as given), then the pool's that aren't already among them.
    merge(keys) {
      const own = (Array.isArray(keys) ? keys : []).map((k) => String(k || '').trim()).filter(Boolean);
      return [...own, ...pool.keys.filter((k) => !own.includes(k))];
    }
  };
  refreshPoolKeys();
  setInterval(refreshPoolKeys, 5000);

  // Export to window
  window.openDRRouterModal = openDRRouterModal;
  window.closeDRRouterModal = closeDRRouterModal;
  // Aliases for compatibility
  window.openDaPoolModal = openDRRouterModal;
  window.closeDaPoolModal = closeDRRouterModal;

  // Auto wire top bar buttons
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-open-dr-router')?.addEventListener('click', openDRRouterModal);
    document.getElementById('btn-open-dr-router-tools')?.addEventListener('click', openDRRouterModal);
    document.getElementById('btn-open-dapool')?.addEventListener('click', openDRRouterModal);
    document.getElementById('btn-open-dapool-tools')?.addEventListener('click', openDRRouterModal);
  });
})();

