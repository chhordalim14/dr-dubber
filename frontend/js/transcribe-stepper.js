// The "AI is analyzing audio..." screen's three steps: Extract -> Translate -> Polish.
// studio-main.js puts #transcribe-stepper in the loading screen and, from its progress poll
// (/api/transcribe-progress), calls transcribeStepper.update(p):
//   no progress yet         -> Extract   (the audio is being cut out of the video and split)
//   phase 'translate'       -> Translate (chunks are with Gemini, done/total)
//   phase 'polish'          -> Polish    (Khmer lines checked against the original, long lines fitted)
(function () {
  "use strict";

  const STEPS = ["Extract", "Translate", "Polish"];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function stageOf(p) {
    if (!p || !p.success) return 0;
    return p.phase === "polish" ? 2 : 1;
  }

  function detailOf(p, at) {
    if (at === 0) return "Extracting the sound from the video…";
    if (at === 1) {
      return p.total > 1
        ? `AI is transcribing and translating part ${Math.min(p.done + 1, p.total)} of ${p.total}`
        : "AI is transcribing and translating…";
    }
    return p.note || "Checking and fitting the lines…";
  }

  function percentOf(p, at) {
    if (at === 0) return 4;
    if (at === 1) return 10 + Math.round(80 * (p.total ? Math.min(1, p.done / p.total) : 0));
    return 94;
  }

  function inner(p) {
    const at = stageOf(p);
    const steps = STEPS.map((label, i) => {
      const done = i < at, now = i === at;
      const dot = done
        ? `background:var(--accent-primary);color:#fff`
        : now
          ? `border:1.5px solid var(--accent-primary);color:var(--accent-primary)`
          : `border:1.5px solid color-mix(in srgb, var(--text-muted) 45%, transparent);color:var(--text-muted)`;
      const text = done || now ? "color:var(--text-bright)" : "color:var(--text-muted)";
      const step = `<div class="flex items-center gap-1.5 shrink-0">
          <span class="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${now ? "animate-pulse" : ""}" style="${dot}">${done ? "✓" : i + 1}</span>
          <span class="text-[11px] font-semibold" style="${text}">${label}</span>
        </div>`;
      const line = i < STEPS.length - 1
        ? `<div class="flex-1 h-0.5 rounded-full mx-2" style="background:${i < at ? "var(--accent-primary)" : "color-mix(in srgb, var(--text-muted) 35%, transparent)"}"></div>`
        : "";
      return step + line;
    }).join("");
    return `<div class="flex items-center w-full">${steps}</div>
      <div class="w-full h-1 rounded-full overflow-hidden" style="background:color-mix(in srgb, var(--text-muted) 22%, transparent)">
        <div class="h-full rounded-full transition-all duration-700" style="width:${percentOf(p, at)}%;background:var(--accent-primary)"></div>
      </div>
      <div class="text-[11px]" style="color:var(--text-muted)">${esc(detailOf(p, at))}</div>`;
  }

  function html(p) {
    return `<div id="transcribe-stepper" class="w-80 max-w-full flex flex-col items-center gap-2 mt-1">${inner(p)}</div>`;
  }

  function update(p) {
    const el = document.getElementById("transcribe-stepper");
    if (el) el.innerHTML = inner(p);
  }

  window.transcribeStepper = { html, update, inner };
})();
