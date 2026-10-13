/* Interface language: English or Khmer (ខ្មែរ).
 *
 * The UI is written in English. In Khmer mode this file swaps what the user
 * sees for the Khmer in js/i18n-km.js, which is keyed by the English text, so
 * the markup and studio-main.js stay as they are:
 *   - text nodes and the title / placeholder / aria-label attributes;
 *   - a sentence split by inline tags ("On Mac, <strong>CPU</strong> is …")
 *     is one key, "On Mac, <0>CPU</0> is …", so the Khmer can reorder it;
 *   - keys with {0}, {1}… match text built at runtime ("Saved {0} files");
 *     a captured value that is itself a key is translated too.
 * A MutationObserver translates whatever the app renders later (toasts,
 * menus, progress), and alert/confirm/prompt messages go through t().
 * Switching back to English gives every node its own text back.
 * Never touched: inputs, textareas, contenteditable (subtitle and overlay
 * text) and anything under [data-i18n-skip].
 */
(function () {
  "use strict";

  const STORE_KEY = "uiLanguage";
  const ATTRS = ["title", "placeholder", "aria-label"];
  const SKIP = "script, style, noscript, svg, canvas, video, audio, [data-i18n-skip]";
  // User text: their placeholder / title are translated, never their content.
  const NO_TEXT = "textarea, [contenteditable=''], [contenteditable='true']";
  const NO_TEXT_DEEP = `${SKIP}, ${NO_TEXT}`;
  // Tags that may sit inside a sentence; a leaf one's text joins the sentence key.
  const INLINE = new Set(["B", "STRONG", "EM", "I", "U", "S", "SPAN", "A", "CODE", "KBD", "SMALL", "SUP", "SUB", "MARK", "BR", "svg"]);
  const HAS_WORD = /[A-Za-z]{2}/;
  const TAG = /<(\d+)>([\s\S]*?)<\/\1>|<(\d+)\/>/g;

  const norm = (s) => s.replace(/\s+/g, " ").trim();

  // ── Dictionary ────────────────────────────────────────────────────────────
  const exact = new Map();
  const patterns = new Map(); // first two characters of the key → patterns
  const loosePatterns = []; // keys that start with a placeholder
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const [en, km] of Object.entries(window.I18N_KM || {})) {
    if (!km) continue;
    const key = norm(en);
    if (!/\{\d+\}/.test(key)) {
      exact.set(key, km);
      continue;
    }
    const pieces = key.split(/\{(\d+)\}/); // literal, index, literal, …
    const literals = pieces.filter((_, i) => i % 2 === 0);
    if (!HAS_WORD.test(literals.join(""))) continue; // "{0} ({1})" would match anything
    const order = pieces.filter((_, i) => i % 2 === 1);
    const re = new RegExp("^" + literals.map(escapeRe).join("([\\s\\S]*?)") + "$");
    const p = { re, order, km, prefix: literals[0], suffix: literals[literals.length - 1], weight: literals.join("").length };
    if (p.prefix.length >= 2) {
      const head = p.prefix.slice(0, 2);
      if (!patterns.has(head)) patterns.set(head, []);
      patterns.get(head).push(p);
    } else loosePatterns.push(p);
  }
  // Most specific (longest literal text) first.
  for (const list of [...patterns.values(), loosePatterns]) list.sort((a, b) => b.weight - a.weight);

  const fill = (p, m) =>
    p.km.replace(/\{(\d+)\}/g, (_, n) => {
      const v = m[p.order.indexOf(n) + 1];
      return v == null ? "" : exact.get(norm(v)) ?? v;
    });

  const matchPattern = (key) => {
    for (const list of [patterns.get(key.slice(0, 2)), loosePatterns]) {
      if (!list) continue;
      for (const p of list) {
        if (!key.startsWith(p.prefix) || !key.endsWith(p.suffix)) continue;
        const m = p.re.exec(key);
        if (m) return fill(p, m);
      }
    }
    return null;
  };

  const cache = new Map();
  const missing = new Set(); // English text seen in Khmer mode with no translation
  const lookup = (key) => {
    let out = cache.get(key);
    if (out !== undefined) return out;
    out = exact.get(key) ?? matchPattern(key);
    if (out == null && missing.size < 3000) missing.add(key);
    if (cache.size > 5000) cache.clear();
    cache.set(key, out);
    return out;
  };

  // Khmer for a whole string, keeping its surrounding whitespace; null if none.
  const translateRaw = (s) => {
    if (!s || !HAS_WORD.test(s)) return null;
    const out = lookup(norm(s));
    if (out == null) return null;
    return s.match(/^\s*/)[0] + out + s.match(/\s*$/)[0];
  };

  // ── DOM ───────────────────────────────────────────────────────────────────
  // What was there before we translated, so English can come back.
  const textRec = new WeakMap(); // Text → { src, out }
  const attrRec = new WeakMap(); // Element → { [attr]: { src, out } }
  const richRec = new WeakMap(); // Element → { orig: Node[], now: Node[], texts: Map<Element, string> }

  const translateText = (node) => {
    const rec = textRec.get(node);
    if (rec && node.data === rec.out) return;
    const out = translateRaw(node.data);
    if (out == null) return void textRec.delete(node);
    textRec.set(node, { src: node.data, out });
    node.data = out;
  };

  const translateAttr = (el, name) => {
    const v = el.getAttribute(name);
    if (v == null) return;
    let recs = attrRec.get(el);
    if (recs?.[name] && v === recs[name].out) return;
    const out = translateRaw(v);
    if (out == null) return void (recs && delete recs[name]);
    if (!recs) attrRec.set(el, (recs = {}));
    recs[name] = { src: v, out };
    el.setAttribute(name, out);
  };

  // "On Mac, <0>CPU</0> is …" for an element mixing text with inline leaf
  // tags; null when it is plain text, icons + text, or has nested markup.
  const richKey = (el) => {
    let words = false;
    let tagged = false;
    let n = 0;
    let key = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        if (HAS_WORD.test(node.data)) words = true;
        key += node.data;
        continue;
      }
      if (node.nodeType !== 1) continue;
      if (!INLINE.has(node.tagName)) return null;
      const text = node.textContent;
      if (node.firstElementChild || node.tagName === "svg") {
        if (HAS_WORD.test(text)) return null;
        key += `<${n}/>`;
      } else if (HAS_WORD.test(text)) {
        tagged = true;
        key += `<${n}>${text}</${n}>`;
      } else {
        // Icons, line breaks and numbers ("Total: <0/>") stay as they are.
        if (node.tagName === "BR") tagged = true;
        key += `<${n}/>`;
      }
      n++;
    }
    return words && tagged ? norm(key) : null;
  };

  const applyRich = (el, out) => {
    const orig = Array.from(el.childNodes);
    const kids = orig.filter((n) => n.nodeType === 1);
    const texts = new Map();
    const now = [];
    let last = 0;
    for (const m of out.matchAll(TAG)) {
      if (m.index > last) now.push(document.createTextNode(out.slice(last, m.index)));
      last = m.index + m[0].length;
      const kid = kids[+(m[1] ?? m[3])];
      if (!kid || now.includes(kid)) continue;
      if (m[1] != null) {
        texts.set(kid, kid.textContent);
        kid.textContent = m[2];
      }
      now.push(kid);
    }
    if (last < out.length) now.push(document.createTextNode(out.slice(last)));
    el.replaceChildren(...now);
    richRec.set(el, { orig, now, texts });
  };

  const sameNodes = (el, list) => el.childNodes.length === list.length && list.every((n, i) => el.childNodes[i] === n);

  const walk = (el) => {
    if (el.matches(SKIP)) return;
    // An <option> without a value is valued by its text: pin it to the English.
    if (el.tagName === "OPTION" && !el.hasAttribute("value")) el.setAttribute("value", el.textContent);
    for (const a of ATTRS) if (el.hasAttribute(a)) translateAttr(el, a);
    if (el.matches(NO_TEXT)) return;
    const rec = richRec.get(el);
    if (rec && sameNodes(el, rec.now)) return;
    const key = richKey(el);
    const out = key && lookup(key);
    if (out) {
      el.querySelectorAll("*").forEach((kid) => ATTRS.forEach((a) => kid.hasAttribute(a) && translateAttr(kid, a)));
      return applyRich(el, out);
    }
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) translateText(node);
      else if (node.nodeType === 1) walk(node);
    }
  };

  const skipped = (el, sel = NO_TEXT_DEEP) => !el || !el.isConnected || !!el.closest(sel);

  // lucide swapped an <i> for its <svg> inside a translated sentence.
  const iconSwapped = (r) => {
    const rec = richRec.get(r.target);
    if (!rec || r.addedNodes.length !== 1 || r.removedNodes.length !== 1 || r.addedNodes[0].nodeName !== "svg") return false;
    const [gone, svg] = [r.removedNodes[0], r.addedNodes[0]];
    for (const list of [rec.now, rec.orig]) {
      const i = list.indexOf(gone);
      if (i >= 0) list[i] = svg;
    }
    return true;
  };

  const onMutations = (records) => {
    for (const r of records) {
      const t = r.target;
      if (r.type === "characterData") {
        if (!skipped(t.parentElement)) translateText(t);
      } else if (r.type === "attributes") {
        if (!skipped(t, SKIP)) translateAttr(t, r.attributeName);
      } else if (!iconSwapped(r) && !skipped(t)) {
        // New children may complete a sentence with its parent's other nodes.
        if (richKey(t)) walk(t);
        else
          for (const node of r.addedNodes) {
            if (!node.isConnected || node.parentNode !== t) continue;
            if (node.nodeType === 3) translateText(node);
            else if (node.nodeType === 1) walk(node);
          }
      }
    }
    // Everything queued since the batch started is our own writes.
    observer.takeRecords();
  };
  const observer = new MutationObserver(onMutations);
  const observe = () =>
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });

  const restore = (root) => {
    const els = [root, ...root.querySelectorAll("*")];
    for (const el of els) {
      const rec = richRec.get(el);
      if (!rec) continue;
      richRec.delete(el);
      if (!sameNodes(el, rec.now)) continue;
      rec.texts.forEach((text, kid) => (kid.textContent = text));
      el.replaceChildren(...rec.orig);
    }
    for (const el of root.querySelectorAll("*")) {
      const recs = attrRec.get(el);
      if (!recs) continue;
      attrRec.delete(el);
      for (const [name, { src, out }] of Object.entries(recs)) if (el.getAttribute(name) === out) el.setAttribute(name, src);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const rec = textRec.get(node);
      if (!rec) continue;
      textRec.delete(node);
      if (node.data === rec.out) node.data = rec.src;
    }
  };

  // ── Language ──────────────────────────────────────────────────────────────
  let lang = "en";
  try {
    if (localStorage.getItem(STORE_KEY) === "km") lang = "km";
  } catch {}

  const syncSwitches = () =>
    document.querySelectorAll("[data-lang-opt]").forEach((opt) => {
      const active = opt.dataset.langOpt === lang;
      opt.classList.toggle("is-active", active);
      opt.setAttribute("aria-pressed", active ? "true" : "false");
    });

  const apply = () => {
    document.documentElement.lang = lang;
    if (lang === "km") {
      walk(document.body);
      observe();
    } else {
      observer.disconnect();
      restore(document.body);
    }
    syncSwitches();
  };

  const setLang = (next) => {
    if (next !== "km") next = "en";
    if (next === lang) return;
    lang = next;
    try {
      localStorage.setItem(STORE_KEY, lang);
    } catch {}
    apply();
    window.dispatchEvent(new CustomEvent("languagechange-ui", { detail: { lang } }));
  };

  // Khmer for an English UI string (or the string itself in English mode).
  const t = (s) => (lang === "km" && typeof s === "string" ? translateRaw(s) ?? s : s);

  // The English an element showed before translation (for code that reads labels).
  const sourceText = (el) => {
    if (!el) return "";
    const rec = richRec.get(el);
    if (rec && sameNodes(el, rec.now)) return rec.orig.map((n) => (n.nodeType === 1 ? rec.texts.get(n) ?? n.textContent : n.textContent)).join("");
    if (el.nodeType === 3) {
      const r = textRec.get(el);
      return r && el.data === r.out ? r.src : el.data;
    }
    return Array.from(el.childNodes, sourceText).join("");
  };

  for (const fn of ["alert", "confirm", "prompt"]) {
    const native = window[fn]?.bind(window);
    if (native) window[fn] = (msg, ...rest) => native(t(msg), ...rest);
  }

  document.addEventListener("click", (e) => {
    const opt = e.target.closest?.("[data-lang-opt]");
    if (opt) setLang(opt.dataset.langOpt);
  });

  window.I18N = {
    get lang() {
      return lang;
    },
    setLang,
    t,
    sourceText,
    // Untranslated English seen while in Khmer: I18N.missing() in DevTools.
    missing: () => [...missing].sort(),
    // Every key a subtree would look up (used to build the dictionary).
    keys(root) {
      const out = new Set();
      const add = (s) => s && HAS_WORD.test(s) && out.add(norm(s));
      const visit = (el) => {
        if (el.matches(SKIP)) return;
        for (const a of ATTRS) add(el.getAttribute(a));
        if (el.matches(NO_TEXT)) return;
        const key = richKey(el);
        if (key) {
          el.querySelectorAll("*").forEach((kid) => ATTRS.forEach((a) => add(kid.getAttribute(a))));
          return add(key);
        }
        for (const node of el.childNodes) {
          if (node.nodeType === 3) add(node.data);
          else if (node.nodeType === 1) visit(node);
        }
      };
      visit(root);
      return [...out];
    },
  };

  // Last script on the page: run after the app's own DOMContentLoaded setup.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
  else apply();
})();
