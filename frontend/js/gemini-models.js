// The one list of Gemini models the app offers. Every model picker is filled from it at load:
// Settings (the hidden select and the dropdown shown over it), DAI Batch and DAI Translate.
// They all read and write the same setting (localStorage "aiDubberModel"); before, each had its
// own copy of the list and the Settings dropdown showed only 7 of the 14 models, so a model
// picked in DAI (e.g. 3.5 Flash) could not be shown there.
(function () {
  // Tones reuse class strings already in index.html, so the built Tailwind CSS has them.
  const TONES = {
    amber: { icon: 'text-amber-400', badge: 'text-amber-300 bg-amber-400/15 border-amber-400/30' },
    yellow: { icon: 'text-yellow-400', badge: 'text-yellow-300 bg-yellow-400/15 border-yellow-400/30' },
    emerald: { icon: 'text-emerald-400', badge: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
    violet: { icon: 'text-violet-400', badge: 'text-violet-400 bg-violet-400/10 border-violet-400/20' },
    purple: { icon: 'text-purple-400', badge: 'text-purple-400 bg-purple-400/10 border-purple-400/20' },
    fuchsia: { icon: 'text-fuchsia-400', badge: '' }
  };

  // note: shown in the selects, "Gemini 3.8 Flash (Latest)". label: the Settings dropdown's
  // longer description. paid: listed under "Billing / Paid Tier" (no free-tier quota).
  const MODELS = [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', note: 'Latest', label: 'Gemini 3.8 Flash (Latest & Tunable Thinking)', badge: 'Latest', icon: 'zap', tone: 'amber' },
    { id: 'gemini-3.5-transcribe', name: 'Gemini 3.5 Transcribe', note: 'Audio Specialist', badge: 'Audio', icon: 'audio-lines', tone: 'emerald' },
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', label: 'Gemini 3.7 Flash (Hybrid Reasoning & Ultra Fast)', icon: 'zap', tone: 'yellow' },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', icon: 'zap', tone: 'yellow' },
    { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', icon: 'zap', tone: 'yellow' },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', icon: 'feather', tone: 'emerald' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', label: 'Gemini 3.1 Pro (Most Intelligent - Paid)', badge: 'Paid / Pro', icon: 'brain-circuit', tone: 'violet', paid: true },
    { id: 'gemini-3.1-flash', name: 'Gemini 3.1 Flash', icon: 'zap', tone: 'yellow' },
    { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', icon: 'feather', tone: 'emerald' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', label: 'Gemini 2.5 Pro (Advanced Reasoning - Paid)', badge: 'Paid / Pro', icon: 'atom', tone: 'purple', paid: true },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', label: 'Gemini 2.5 Flash (Free Tier & Ultra Fast)', badge: 'Free & Fast', icon: 'zap', tone: 'yellow' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', icon: 'zap', tone: 'yellow' },
    { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', label: 'Gemini 1.5 Pro (High Context)', icon: 'atom', tone: 'fuchsia', paid: true },
    { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', label: 'Gemini 1.5 Flash (Stable Free Fallback)', badge: 'Free', icon: 'shield-check', tone: 'emerald' }
  ];
  const optionText = (m) => (m.note ? `${m.name} (${m.note})` : m.name);

  function fillSelect(select) {
    if (!select) return;
    const keep = select.value;
    select.innerHTML = '';
    for (const m of MODELS) select.add(new Option(optionText(m), m.id));
    select.value = MODELS.some((m) => m.id === keep) ? keep : MODELS[0].id;
  }

  function fillDropdown(list) {
    if (!list) return;
    const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const header = (text) => `<p class="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider px-2 pt-1 pb-0.5">${text}</p>`;
    const button = (m) => {
      const t = TONES[m.tone] || TONES.yellow;
      const badge = m.badge && t.badge ? `<span class="text-[10px] ${t.badge} px-1.5 py-0.5 rounded border">${esc(m.badge)}</span>` : '';
      return `<button data-model="${m.id}" data-label="${esc(m.label || optionText(m))}"
          class="gemini-model-opt w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors text-sm text-[var(--text-primary)] hover:text-[var(--text-bright)]">
          <i data-lucide="${m.icon}" class="w-4 h-4 ${t.icon} shrink-0"></i>
          <span class="flex-1">${esc(m.name)}</span>${badge}
        </button>`;
    };
    list.innerHTML = header('High Speed & Latest Reasoning (Recommended)') +
      MODELS.filter((m) => !m.paid).map(button).join('') +
      '<div class="border-t border-[var(--border-color)] my-1"></div>' +
      header('Flagship Intelligence (Billing / Paid Tier)') +
      MODELS.filter((m) => m.paid).map(button).join('');
  }

  window.GEMINI_MODELS = MODELS;
  window.fillGeminiModelSelect = fillSelect;

  // This script loads after the pickers' markup and before studio-main.js / dai-transcribe-studio.js
  // wire them, so they find the full list in place.
  ['setting-ai-model', 'dai-model-select', 'dai-trans-model-select'].forEach((id) => fillSelect(document.getElementById(id)));
  fillDropdown(document.getElementById('gemini-model-list'));
})();
