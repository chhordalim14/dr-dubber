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
