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
      };

      rail.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-rail]");
        if (!btn) return;
        setOpen(openPanel === btn.dataset.rail ? null : btn.dataset.rail);
      });

      drawer.addEventListener("click", (e) => {
        if (e.target.closest("[data-rail-close]")) setOpen(null);
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
        ["left-sidebar", [["is-narrow", 600]]],
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
