// Name consistency across the parts of one movie.
//
// When a long movie is split into parts (one tab per part), each part is
// transcribed/translated separately, so the same character or place can get a
// different Khmer spelling in part 1 and part 5. This module holds the pure,
// testable logic of the "Make names consistent" action:
//
//   1. mergeExtracted()  - combine the name lists Gemini returned for each chunk
//                          of lines (backend).
//   2. analyzeNames()    - for every name, count how each Khmer spelling is used,
//                          drop anything Gemini made up, and suggest one spelling
//                          (the Character Glossary's, else the most-used one).
//   3. planChanges()     - given the spelling the user chose for each name, work
//                          out exactly which lines change and how (frontend).
//
// Safety rules, because Khmer is written without spaces between words and a
// careless find-and-replace could corrupt unrelated text:
//   - A line is only touched for a name if that name literally appears in the
//     line's ORIGINAL-language text.
//   - Spellings that contain, or are contained in, the chosen spelling (full name
//     vs. given name, name with an honorific) are treated as related forms and
//     never rewritten.
//   - Every name's chosen spelling is protected, so fixing one name can never
//     rewrite part of another name's spelling.
//   - Very short spellings are never rewritten.
//
// Loaded by the browser as a classic script (exposes window.NameConsistency)
// and by Node via require() (backend/server.js, tests).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NameConsistency = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Shortest spelling (in code points) that is ever rewritten automatically.
  const MIN_SPELLING_LENGTH = 2;

  const clean = (s) => String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim();
  const fold = (s) => clean(s).toLowerCase();
  const contains = (haystack, needle) => {
    const n = fold(needle);
    return !!n && fold(haystack).includes(n);
  };
  const codePoints = (s) => Array.from(s).length;
  const related = (a, b) => a.includes(b) || b.includes(a);
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // batches: arrays of { original, type, khmer: [spellings] } (one array per chunk).
  // Returns one entry per distinct original name (case-insensitive), spellings merged.
  function mergeExtracted(batches) {
    const byKey = new Map();
    for (const list of batches || []) {
      for (const item of Array.isArray(list) ? list : []) {
        const original = clean(item && item.original);
        if (!original) continue;
        const key = fold(original);
        let entry = byKey.get(key);
        if (!entry) {
          entry = { original, type: clean(item.type) || 'other', spellings: new Set() };
          byKey.set(key, entry);
        }
        for (const k of Array.isArray(item.khmer) ? item.khmer : []) {
          const s = clean(k);
          if (s) entry.spellings.add(s);
        }
      }
    }
    return [...byKey.values()].map((e) => ({ original: e.original, type: e.type, spellings: [...e.spellings] }));
  }

  // glossary: { original: khmer } or [{ original, khmer }] (or legacy [{ from, to }]).
  function lookupGlossary(glossary, original) {
    if (!glossary) return null;
    const key = fold(original);
    if (Array.isArray(glossary)) {
      for (const g of glossary) {
        const o = g && (g.original != null ? g.original : g.from);
        const k = g && (g.khmer != null ? g.khmer : g.to);
        if (o && clean(k) && fold(o) === key) return clean(k);
      }
      return null;
    }
    for (const [o, k] of Object.entries(glossary)) {
      if (fold(o) === key && clean(k)) return clean(k);
    }
    return null;
  }

  function flatten(tabs) {
    const out = [];
    let order = 0;
    for (const tab of tabs || []) {
      for (const line of (tab && tab.lines) || []) {
        out.push({
          tabId: tab.id,
          lineId: line.id,
          originalText: line.originalText || '',
          text: line.text || '',
          order: order++,
        });
      }
    }
    return out;
  }

  // tabs: [{ id, lines: [{ id, originalText, text }] }] in part order.
  // Returns [{ original, type, suggested, source, inGlossary, linesWithName,
  //            spellings: [{ khmer, lines, firstOrder }], conflicting: [khmer] }]
  // with inconsistent names first.
  function analyzeNames(tabs, extracted, glossary) {
    const lines = flatten(tabs);
    const results = [];
    for (const name of extracted || []) {
      const anchorLines = lines.filter((l) => contains(l.originalText, name.original));
      // The name never appears in the original text as written: it can't be checked safely.
      if (!anchorLines.length) continue;

      const spellings = [];
      for (const khmer of name.spellings || []) {
        const hits = anchorLines.filter((l) => l.text.includes(khmer));
        // Only spellings that really occur next to this name count (drops invented ones).
        if (hits.length) spellings.push({ khmer, lines: hits.length, firstOrder: hits[0].order });
      }
      const glossaryKhmer = lookupGlossary(glossary, name.original);
      if (!spellings.length && !glossaryKhmer) continue;

      // Most-used spelling first; on a tie, the one that appears earliest in the movie.
      spellings.sort((a, b) => b.lines - a.lines || a.firstOrder - b.firstOrder);
      const suggested = glossaryKhmer || spellings[0].khmer;
      const conflicting = spellings
        .map((s) => s.khmer)
        .filter((k) => k !== suggested && !related(k, suggested) && codePoints(k) >= MIN_SPELLING_LENGTH);

      results.push({
        original: name.original,
        type: name.type || 'other',
        suggested,
        source: glossaryKhmer ? 'glossary' : 'most-used',
        inGlossary: !!glossaryKhmer,
        linesWithName: anchorLines.length,
        spellings,
        conflicting,
      });
    }
    results.sort((a, b) =>
      (b.conflicting.length > 0) - (a.conflicting.length > 0) || b.linesWithName - a.linesWithName);
    return results;
  }

  // Replace any of `froms` with `to`, never touching text inside a protected spelling.
  function replaceSpellings(text, froms, to, protectedList) {
    if (!froms.length || !text) return text;
    const locked = [...new Set(protectedList.concat([to]).filter(Boolean))].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(froms.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'), 'g');
    let out = '';
    let free = '';
    let i = 0;
    const flush = () => {
      if (free) out += free.replace(pattern, to);
      free = '';
    };
    while (i < text.length) {
      const hit = locked.find((p) => text.startsWith(p, i));
      if (hit) {
        flush();
        out += hit;
        i += hit.length;
      } else {
        free += text[i];
        i += 1;
      }
    }
    flush();
    return out;
  }

  // decisions: [{ original, use, replace: [spellings to turn into `use`] }]
  // Returns [{ tabId, lineId, before, after }] for the lines that change.
  function planChanges(tabs, decisions) {
    const active = (decisions || [])
      .map((d) => {
        const use = clean(d && d.use);
        const replace = [...new Set(((d && d.replace) || []).map(clean))]
          .filter((s) => s && s !== use && !related(s, use) && codePoints(s) >= MIN_SPELLING_LENGTH);
        return { original: clean(d && d.original), use, replace };
      })
      .filter((d) => d.original && d.use && d.replace.length);
    if (!active.length) return [];

    // Every chosen spelling is protected while fixing any name.
    const protectedList = (decisions || []).map((d) => clean(d && d.use)).filter(Boolean);
    // A spelling that is another name's chosen spelling is never rewritten.
    active.forEach((d) => {
      d.replace = d.replace.filter((s) => !protectedList.includes(s));
    });

    const changes = [];
    for (const tab of tabs || []) {
      for (const line of (tab && tab.lines) || []) {
        const before = line.text || '';
        let after = before;
        for (const d of active) {
          if (d.replace.length && contains(line.originalText, d.original)) {
            after = replaceSpellings(after, d.replace, d.use, protectedList);
          }
        }
        if (after !== before) changes.push({ tabId: tab.id, lineId: line.id, before, after });
      }
    }
    return changes;
  }

  // Merge chosen names into a glossary list ([{ original, khmer }]); an existing
  // entry for the same original name is updated, otherwise one is added.
  function mergeIntoGlossary(list, entries) {
    const out = Array.isArray(list) ? list.map((g) => ({ ...g })) : [];
    let added = 0;
    let updated = 0;
    for (const e of entries || []) {
      const original = clean(e && e.original);
      const khmer = clean(e && e.khmer);
      if (!original || !khmer) continue;
      const existing = out.find((g) => fold(g && (g.original != null ? g.original : g.from)) === fold(original));
      if (existing) {
        if (clean(existing.khmer != null ? existing.khmer : existing.to) !== khmer) {
          if (existing.original == null) existing.original = original;
          existing.khmer = khmer;
          updated++;
        }
      } else {
        out.push({ original, khmer });
        added++;
      }
    }
    return { list: out, added, updated };
  }

  return {
    MIN_SPELLING_LENGTH,
    mergeExtracted,
    lookupGlossary,
    analyzeNames,
    replaceSpellings,
    planChanges,
    mergeIntoGlossary,
  };
});
