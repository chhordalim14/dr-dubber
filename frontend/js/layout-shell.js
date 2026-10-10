    // App shell: the tool rail on the left opens one tools panel at a time in
    // a floating drawer, and a shared helper places pop-up menus next to the
    // button that opened them.

    // Place a menu with position: fixed under its button, or above it when
    // there is more room above (the toolbars scroll sideways, which would clip
    // an absolutely positioned menu).
    function placeFixedMenu(menu, anchor, menuWidth) {
      const rect = anchor.getBoundingClientRect();
      menu.style.position = "fixed";
      menu.style.left = `${Math.min(window.innerWidth - menuWidth - 10, Math.max(10, rect.left))}px`;
      if (rect.top > window.innerHeight - rect.bottom) {
        menu.style.top = "auto";
        menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
      } else {
        menu.style.top = `${rect.bottom + 6}px`;
        menu.style.bottom = "auto";
      }
      menu.style.zIndex = "99999";
    }

    (function () {
      const rail = document.getElementById("app-rail");
      const drawer = document.getElementById("rail-drawer");
      if (!rail || !drawer) return;

      let openPanel = null;

      const setOpen = (name) => {
        // One panel at a time: a drawer panel closes the video inspector.
        if (name && typeof window.closeVideoInspector === "function") window.closeVideoInspector();
        openPanel = name;
        drawer.querySelectorAll("[data-rail-panel]").forEach((panel) => {
          panel.hidden = panel.dataset.railPanel !== name;
        });
        rail.querySelectorAll("[data-rail]").forEach((btn) => {
          const active = btn.dataset.rail === name;
          btn.classList.toggle("is-active", active);
          btn.setAttribute("aria-expanded", active ? "true" : "false");
        });
        drawer.classList.toggle("hidden", !name);
        // Shortcut rows (Effects) follow their tool: disabled until a video is loaded.
        drawer.querySelectorAll("[data-click]").forEach((row) => {
          const tool = document.getElementById(row.dataset.click);
          if (tool) row.disabled = tool.disabled;
        });
      };

      rail.addEventListener("click", (e) => {
        // Rail shortcuts (data-click) open a window of their own: close the drawer.
        if (e.target.closest("[data-click]")) {
          setOpen(null);
          return;
        }
        const btn = e.target.closest("[data-rail]");
        if (!btn) return;
        setOpen(openPanel === btn.dataset.rail ? null : btn.dataset.rail);
      });

      drawer.addEventListener("click", (e) => {
        // Shortcut rows (Effects) open a panel of their own: close the drawer.
        if (e.target.closest("[data-rail-close], [data-click]")) setOpen(null);
      });

      // Close on a click anywhere else, or Escape.
      document.addEventListener("mousedown", (e) => {
        if (openPanel && !drawer.contains(e.target) && !rail.contains(e.target)) setOpen(null);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && openPanel) setOpen(null);
      });

      setOpen(null);
    })();

    // Shortcut buttons (e.g. in empty states) press the real tool button
    // named by data-click, so they share its file picker and handlers.
    document.addEventListener("click", (e) => {
      const shortcut = e.target.closest("[data-click]");
      if (shortcut) document.getElementById(shortcut.dataset.click)?.click();
    });

    // Subtitle panel tabs (Subtitles / AI Dubbing / Voice): each shows its own
    // toolbar above the subtitle list, which stays in view. The last tab is
    // remembered.
    (function () {
      const card = document.getElementById("subtitle-card");
      if (!card) return;
      const tabs = card.querySelectorAll("[data-subs-tab]");
      const panes = card.querySelectorAll("[data-subs-pane]");
      const show = (name) => {
        if (![...tabs].some((t) => t.dataset.subsTab === name)) name = "subs";
        tabs.forEach((tab) => {
          const active = tab.dataset.subsTab === name;
          tab.classList.toggle("is-active", active);
          tab.setAttribute("aria-selected", active ? "true" : "false");
        });
        panes.forEach((pane) => {
          pane.hidden = pane.dataset.subsPane !== name;
        });
        try {
          localStorage.setItem("drSubsTab", name);
        } catch (e) {}
      };
      tabs.forEach((tab) => tab.addEventListener("click", () => show(tab.dataset.subsTab)));
      let saved = null;
      try {
        saved = localStorage.getItem("drSubsTab");
      } catch (e) {}
      show(saved || "subs");
    })();

    // Header "Auto Save" chip: lit while Settings › Auto Save Subtitle is on.
    // A click presses that switch (data-click); its class change re-syncs the chip.
    (function () {
      const chip = document.getElementById("hdr-autosave");
      const toggle = document.getElementById("autosave-srt-toggle");
      if (!chip) return;
      const sync = () => {
        let on = false;
        try {
          on = localStorage.getItem("aiDubberAutoSaveSrt") === "true";
        } catch (e) {}
        chip.classList.toggle("is-on", on);
        chip.setAttribute("aria-pressed", on ? "true" : "false");
      };
      sync();
      if (toggle) new MutationObserver(sync).observe(toggle, { attributes: true, attributeFilter: ["class"] });
    })();

    // Video inspector (preset / colour / vignette panels): its close button
    // and Escape press the toolbar button of each open panel, so the panels
    // close through their own handlers.
    (function () {
      const PANELS = [
        ["video-preset-panel", "btn-video-preset"],
        ["color-adjust-panel", "btn-color-adjust"],
        ["vignette-panel", "btn-vignette"],
      ];
      const closeInspector = () => {
        let closed = false;
        PANELS.forEach(([panelId, btnId]) => {
          if (document.getElementById(panelId)?.classList.contains("flex")) {
            document.getElementById(btnId)?.click();
            closed = true;
          }
        });
        return closed;
      };
      window.closeVideoInspector = closeInspector;
      document.addEventListener("click", (e) => {
        if (e.target.closest("[data-close-inspector]")) closeInspector();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || document.querySelector("#rail-drawer:not(.hidden)")) return;
        // Leave Escape to text fields (it cancels an edit there).
        if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable='true']")) return;
        closeInspector();
      });
    })();

    // Width classes for the preview and subtitle columns, so their toolbars
    // can drop labels when narrow. (CSS container queries would do this, but a
    // container becomes the containing block of the position: fixed menus
    // inside it - Language, Genre, All Tabs - and they open in the wrong place.)
    (function () {
      const WIDTHS = [
        // The tool strip shares its row with the file name: icons only below ~760px.
        ["left-sidebar", [["is-narrow", 760]]],
        ["subtitle-card", [["is-narrow", 720], ["is-xnarrow", 520]]],
      ];
      if (typeof ResizeObserver !== "function") return;
      WIDTHS.forEach(([id, steps]) => {
        const el = document.getElementById(id);
        if (!el) return;
        new ResizeObserver(([entry]) => {
          const w = entry.contentRect.width;
          steps.forEach(([cls, max]) => el.classList.toggle(cls, w <= max));
        }).observe(el);
      });
    })();

    // Keyboard focus ring: shown only while the user moves focus with Tab.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Tab") document.body.classList.add("kbd-nav");
    });
    document.addEventListener("mousedown", () => document.body.classList.remove("kbd-nav"));

    // Aspect Ratio opens at the top-left of the preview, under the tool row
    // (same place as the Color panel): place it each time it is shown.
    (function () {
      const modal = document.getElementById("aspect-ratio-modal");
      const stage = document.getElementById("preview-stage");
      if (!modal || !stage) return;
      const place = () => {
        const r = stage.getBoundingClientRect();
        modal.style.setProperty("--pop-top", `${Math.round(r.top + 8)}px`);
        modal.style.setProperty("--pop-left", `${Math.round(r.left + 8)}px`);
      };
      new MutationObserver(() => {
        if (!modal.classList.contains("hidden")) place();
      }).observe(modal, { attributes: true, attributeFilter: ["class"] });
      window.addEventListener("resize", () => {
        if (!modal.classList.contains("hidden")) place();
      });
    })();

    // Settings search: lists the matching sections from every Settings page;
    // picking one opens its page and scrolls to it.
    (function () {
      const input = document.getElementById("settings-search-input");
      const list = document.getElementById("settings-search-results");
      if (!input || !list) return;

      const clean = (text) => (text || "").replace(/\s+/g, " ").trim();
      const TITLE = "h2, h3, h4, label, [class*='font-bold'], [class*='font-semibold'], [class*='font-medium']";
      let results = [];
      let active = 0;

      // Every section of every page, read fresh each time (some are built later).
      const collect = () => {
        const entries = [];
        document.querySelectorAll("#settings-panel .settings-tab-btn").forEach((tab) => {
          const pane = document.getElementById(tab.dataset.target);
          if (!pane) return;
          const page = clean(tab.textContent);
          entries.push({ tab, page, title: page, text: page.toLowerCase(), section: null });
          Array.from(pane.children).forEach((section) => {
            const text = clean(section.textContent);
            if (!text) return;
            const head = section.matches("label") ? section.querySelector(TITLE) || section : section.querySelector(TITLE);
            const title = clean(head ? head.textContent : text).slice(0, 60);
            const extra = Array.from(section.querySelectorAll("input[placeholder]"), (el) => el.placeholder).join(" ");
            entries.push({ tab, page, title, text: `${text} ${extra}`.toLowerCase(), section });
          });
        });
        return entries;
      };

      const hide = () => {
        list.hidden = true;
        list.replaceChildren();
        results = [];
      };

      const go = (result) => {
        hide();
        input.value = "";
        input.blur();
        const switching = !result.tab.classList.contains("active-tab");
        if (switching) result.tab.click();
        if (!result.section) return;
        // Wait for the page swap (studio-main.js fades the old page out first).
        setTimeout(() => {
          const section = result.section;
          section.scrollIntoView({ behavior: "smooth", block: "center" });
          section.classList.remove("settings-search-hit");
          void section.offsetWidth; // restart the flash if it is still running
          section.classList.add("settings-search-hit");
          setTimeout(() => section.classList.remove("settings-search-hit"), 1700);
        }, switching ? 480 : 0);
      };

      const render = () => {
        list.replaceChildren();
        if (!results.length) {
          const empty = document.createElement("div");
          empty.className = "settings-search__empty";
          empty.textContent = "No settings match.";
          list.append(empty);
        }
        results.forEach((result, i) => {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "settings-search__item" + (i === active ? " is-active" : "");
          item.setAttribute("role", "option");
          const title = document.createElement("b");
          title.textContent = result.title;
          const page = document.createElement("span");
          page.textContent = result.section ? result.page : "Open page";
          item.append(title, page);
          item.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the box
          item.addEventListener("click", () => go(result));
          list.append(item);
        });
        list.hidden = false;
      };

      input.addEventListener("input", () => {
        const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
        if (!words.length) return hide();
        results = collect()
          .filter((entry) => words.every((w) => entry.text.includes(w)))
          .sort((a, b) => words.every((w) => b.title.toLowerCase().includes(w)) - words.every((w) => a.title.toLowerCase().includes(w)))
          .slice(0, 12);
        active = 0;
        render();
      });

      input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // the editor's own shortcuts stay out of the search box
        if (e.key === "Escape") {
          input.value = "";
          hide();
        } else if (e.key === "Enter" && results[active]) {
          e.preventDefault();
          go(results[active]);
        } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && results.length) {
          e.preventDefault();
          active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
          render();
          list.children[active]?.scrollIntoView({ block: "nearest" });
        }
      });

      input.addEventListener("blur", () => setTimeout(hide, 120));
    })();

    // About page: fills Details from the running app and What's new from the
    // same update.json that "Check for Updates" reads (fetched once).
    (function () {
      const pane = document.getElementById("settings-about");
      const notes = document.getElementById("about-whats-new");
      if (!pane || !notes) return;

      const NOTES_URL = "https://raw.githubusercontent.com/chhordalim14/dr-dubber/main/update.json";
      const NOTES_SHOWN = 6;
      const set = (id, text) => {
        const el = document.getElementById(id);
        if (el && text) el.textContent = text;
      };
      const ua = navigator.userAgent;
      const version = () => (document.getElementById("about-app-version")?.textContent || "").replace(/^Version\s*/, "").trim();

      const system = () => {
        const platform = window.electronAPI?.platform || "";
        const os = { win32: "Windows", darwin: "macOS", linux: "Linux" }[platform] || (/Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : "Linux");
        const arch = /arm64|aarch64/i.test(ua) ? "ARM64" : /Win64|x64|x86_64/.test(ua) ? "64-bit" : "";
        return arch ? `${os} · ${arch}` : os;
      };

      const engine = () => {
        const electron = ua.match(/Electron\/([\d.]+)/);
        const chrome = ua.match(/Chrome\/(\d+)/);
        return [electron && `Electron ${electron[1]}`, chrome && `Chromium ${chrome[1]}`].filter(Boolean).join(" · ");
      };

      let notesLoaded = false;
      const loadNotes = async () => {
        if (notesLoaded) return;
        notesLoaded = true;
        const message = (text) => {
          const p = document.createElement("p");
          p.className = "about-notes__msg";
          p.textContent = text;
          notes.replaceChildren(p);
        };
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const res = await fetch(`${NOTES_URL}?nocache=${Date.now()}`, { signal: controller.signal });
          clearTimeout(timer);
          if (!res.ok) throw new Error(res.status);
          const data = await res.json();
          const lines = String(data.notes || "").split("\n").map((l) => l.trim());
          const items = lines.filter((l) => l.startsWith("-")).map((l) => l.replace(/^-\s*/, ""));
          if (!items.length) return message("No release notes yet.");

          const head = document.createElement("div");
          head.className = "about-notes__head";
          head.append(`Version ${data.version}`);
          const tag = document.createElement("span");
          tag.className = "about-notes__tag";
          tag.textContent = data.version === version() ? "Installed" : "Latest release";
          head.append(tag);

          const list = document.createElement("ul");
          items.forEach((text, i) => {
            const li = document.createElement("li");
            li.textContent = text;
            li.hidden = i >= NOTES_SHOWN;
            list.append(li);
          });
          notes.replaceChildren(head, list);

          if (items.length > NOTES_SHOWN) {
            const more = document.createElement("button");
            more.type = "button";
            more.className = "about-notes__more";
            more.textContent = `Show all ${items.length} changes`;
            more.addEventListener("click", () => {
              list.querySelectorAll("li[hidden]").forEach((li) => (li.hidden = false));
              more.remove();
            });
            notes.append(more);
          }
        } catch (e) {
          notesLoaded = false; // try again next time the page opens
          message("Couldn't load release notes. Check your internet connection.");
        }
      };

      const fill = () => {
        set("about-detail-version", version());
        set("about-detail-system", system());
        set("about-detail-engine", engine());
        set("about-detail-model", document.getElementById("gemini-model-label")?.textContent.trim());
        loadNotes();
      };

      document.querySelector('.settings-tab-btn[data-target="settings-about"]')?.addEventListener("click", fill);
      document.getElementById("btn-open-settings")?.addEventListener("click", () => {
        if (!pane.classList.contains("hidden")) fill();
      });
    })();
