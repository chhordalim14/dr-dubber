// Matches a tab's subtitles to the lines burned into its video, so each translated subtitle
// shows exactly while its original line does.
//
// The lines come from the text detector (backend/python/text_detector.py, via proj.textBlur):
// [{ start, end, text }] with the frame each line appears and disappears and what it says.
// The subtitles' times come from the transcription (a guess from the audio, often a few
// tenths of a second off) and their original-language text from the same transcription.
//
// A subtitle is paired with the on-screen lines whose text it holds (a misread letter here
// and there doesn't matter), close to it in time and in order. One subtitle often covers
// two on-screen lines (the video breaks a long sentence over two screens): it then spans
// both, and its translation is split between them in proportion. Two subtitles that the
// transcription made out of one on-screen line share that line's time.
//
// Loaded by the browser as a classic script (window.ScreenSync) and by Node (tests).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScreenSync = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const MAX_SHIFT = 2.5;    // s a subtitle may be from its on-screen line (the transcription's error)
  const MIN_HELD = 0.5;     // share of an on-screen line's letters a subtitle must hold to be its text
  const MIN_SHARE = 0.6;    // share of a subtitle's letters a line must hold for the two to share it
  const JOIN_GAP = 0.3;     // s: a gap this short between a subtitle's lines is shown through
  const MIN_LEFT = 0.4;     // s an unmatched subtitle needs between its neighbours to be kept there

  const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  // Letters and digits only (no punctuation or spaces), lower case.
  function normText(text) {
    return Array.from(String(text || '').normalize('NFKC').toLowerCase()).filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');
  }

  function letterCounts(str) {
    const m = new Map();
    for (const ch of str) m.set(ch, (m.get(ch) || 0) + 1);
    return m;
  }

  // Letters two texts have in common (each letter counted as often as both have it).
  function commonLetters(a, b) {
    let n = 0;
    for (const [ch, k] of a) n += Math.min(k, b.get(ch) || 0);
    return n;
  }

  // Time between two ranges (0 when they overlap).
  const gapBetween = (a0, a1, b0, b1) => Math.max(0, b0 - a1, a0 - b1);
  const overlapOf = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

  function prepare(items) {
    return items.map((it, i) => {
      const text = normText(it.text);
      return { i, start: num(it.start), end: num(it.end), text, counts: letterCounts(text) };
    });
  }

  // How well on-screen line L is subtitle S's text (higher is better), or -Infinity.
  function pairScore(S, L) {
    const gap = gapBetween(S.start, S.end, L.start, L.end);
    if (gap > MAX_SHIFT) return -Infinity;
    const near = overlapOf(S.start, S.end, L.start, L.end) / Math.max(0.1, L.end - L.start);
    if (S.text && L.text) {
      const held = commonLetters(L.counts, S.counts) / L.text.length;
      if (held < MIN_HELD) return -Infinity;
      return held + 0.2 * near - 0.1 * gap;
    }
    // No text to compare (a subtitle without its original, or a line the reader got
    // nothing from): only a clear overlap in time pairs them.
    const ov = overlapOf(S.start, S.end, L.start, L.end) / Math.max(0.1, Math.min(S.end - S.start, L.end - L.start));
    return ov >= 0.5 ? 0.5 * ov : -Infinity;
  }

  // Each on-screen line to at most one subtitle, in order (a later line never goes to an
  // earlier subtitle), as many good pairs as possible: lineOwner[j] = subtitle index or -1.
  function pairLines(subs, lines) {
    const n = subs.length, m = lines.length;
    // best[j][i + 1]: best total over lines < j with every owner <= i (column 0: no owner yet).
    const best = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
    const how = Array.from({ length: m + 1 }, () => new Int8Array(n + 1)); // 0 skip, 1 pair, 2 from i-1
    for (let j = 1; j <= m; j++) {
      best[j][0] = best[j - 1][0];
      for (let i = 1; i <= n; i++) {
        const s = pairScore(subs[i - 1], lines[j - 1]);
        let v = best[j - 1][i], h = 0;
        if (s > 0 && best[j - 1][i] + s > v) { v = best[j - 1][i] + s; h = 1; }
        if (best[j][i - 1] > v) { v = best[j][i - 1]; h = 2; }
        best[j][i] = v;
        how[j][i] = h;
      }
    }
    const owner = new Array(m).fill(-1);
    for (let j = m, i = n; j > 0 && i > 0;) {
      const h = how[j][i];
      if (h === 2) i--;
      else {
        if (h === 1) owner[j - 1] = i - 1;
        j--;
      }
    }
    return owner;
  }

  // Matches subtitles to on-screen lines.
  //   subs:  [{ start, end, text }]  text: the ORIGINAL-language text (what the video shows)
  //   lines: [{ start, end, text }]  from the detector
  // Returns one entry per subtitle (same order):
  //   { start, end, parts }  its new times; parts (2 or more on-screen pieces) or null:
  //                          [{ start, end, share }] share = part of the translation shown there
  //   null                   no on-screen line found for it (see placeUnmatched)
  function matchSubtitles(subs, lines) {
    const S = prepare(subs || []).filter((s) => s.start !== null && s.end !== null);
    const L = prepare(lines || []).filter((l) => l.start !== null && l.end !== null && l.end > l.start);
    S.sort((a, b) => a.start - b.start);
    L.sort((a, b) => a.start - b.start);
    const owner = pairLines(S, L);

    // owners[j]: the subtitles showing during line j (in order). A subtitle left without a
    // line may share a neighbour's line, when the line holds its text.
    const owners = owner.map((i) => (i >= 0 ? [i] : []));
    const hasLine = new Set(owner.filter((i) => i >= 0));
    S.forEach((s, i) => {
      if (hasLine.has(i) || !s.text) return;
      let pick = -1, pickScore = 0;
      L.forEach((l, j) => {
        if (gapBetween(s.start, s.end, l.start, l.end) > MAX_SHIFT || !l.text) return;
        // Only a line of a subtitle right next to it, or a line nobody has.
        if (owners[j].length && !owners[j].some((o) => Math.abs(o - i) === 1)) return;
        const share = commonLetters(s.counts, l.counts) / s.text.length;
        if (share >= MIN_SHARE && share > pickScore) { pick = j; pickScore = share; }
      });
      if (pick >= 0) {
        owners[pick].push(i);
        owners[pick].sort((a, b) => a - b);
        hasLine.add(i);
      }
    });

    // Pieces of time per subtitle: a whole line, or its part of a shared line (split by how
    // many of the line's letters each one says).
    const pieces = S.map(() => []);
    owners.forEach((list, j) => {
      const l = L[j];
      if (!list.length) return;
      const weights = list.map((i) => Math.max(1, l.text ? commonLetters(S[i].counts, l.counts) : S[i].text.length || 1));
      const total = weights.reduce((a, b) => a + b, 0);
      let at = l.start;
      list.forEach((i, k) => {
        const end = k === list.length - 1 ? l.end : at + ((l.end - l.start) * weights[k]) / total;
        pieces[i].push({ start: at, end, weight: list.length > 1 ? weights[k] : Math.max(1, l.text.length) });
        at = end;
      });
    });

    const out = new Array((subs || []).length).fill(null);
    S.forEach((s, i) => {
      const ps = pieces[i].sort((a, b) => a.start - b.start);
      if (!ps.length) return;
      for (let k = 1; k < ps.length; k++) if (ps[k].start - ps[k - 1].end <= JOIN_GAP) ps[k - 1].end = ps[k].start;
      const total = ps.reduce((a, p) => a + p.weight, 0);
      out[s.i] = {
        start: ps[0].start,
        end: ps[ps.length - 1].end,
        parts: ps.length > 1 ? ps.map((p) => ({ start: p.start, end: p.end, share: p.weight / total })) : null,
      };
    });
    return out;
  }

  // Times for the subtitles no on-screen line was found for (speech the video has no
  // subtitle for): kept where they are, moved off the matched ones. Mutates nothing.
  //   items: [{ start, end, matched }] in time order -> [{ start, end }] (same order)
  function placeUnmatched(items) {
    const out = items.map((it) => ({ start: num(it.start), end: num(it.end) }));
    items.forEach((it, k) => {
      if (it.matched) return;
      let lo = -Infinity, hi = Infinity;
      for (let p = k - 1; p >= 0; p--) if (items[p].matched) { lo = out[p].end; break; }
      for (let q = k + 1; q < items.length; q++) if (items[q].matched) { hi = out[q].start; break; }
      const s = Math.max(out[k].start, lo), e = Math.min(out[k].end, hi);
      if (e - s >= MIN_LEFT) {
        out[k].start = s;
        out[k].end = e;
      }
    });
    return out;
  }

  return { MAX_SHIFT, MIN_HELD, MIN_SHARE, JOIN_GAP, normText, matchSubtitles, placeUnmatched, pairLines };
});
