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
  function pairScore(S, L, maxShift = MAX_SHIFT) {
    const gap = gapBetween(S.start, S.end, L.start, L.end);
    if (gap > maxShift) return -Infinity;
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
  function pairLines(subs, lines, maxShift = MAX_SHIFT) {
    const n = subs.length, m = lines.length;
    // best[j][i + 1]: best total over lines < j with every owner <= i (column 0: no owner yet).
    const best = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
    const how = Array.from({ length: m + 1 }, () => new Int8Array(n + 1)); // 0 skip, 1 pair, 2 from i-1
    for (let j = 1; j <= m; j++) {
      best[j][0] = best[j - 1][0];
      for (let i = 1; i <= n; i++) {
        const s = pairScore(subs[i - 1], lines[j - 1], maxShift);
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
  function matchSubtitles(subs, lines, { maxShift = MAX_SHIFT } = {}) {
    const S = prepare(subs || []).filter((s) => s.start !== null && s.end !== null);
    const L = prepare(lines || []).filter((l) => l.start !== null && l.end !== null && l.end > l.start);
    S.sort((a, b) => a.start - b.start);
    L.sort((a, b) => a.start - b.start);
    const owner = pairLines(S, L, maxShift);

    // owners[j]: the subtitles showing during line j (in order). A subtitle left without a
    // line may share a neighbour's line, when the line holds its text.
    const owners = owner.map((i) => (i >= 0 ? [i] : []));
    const hasLine = new Set(owner.filter((i) => i >= 0));
    S.forEach((s, i) => {
      if (hasLine.has(i) || !s.text) return;
      let pick = -1, pickScore = 0;
      L.forEach((l, j) => {
        if (gapBetween(s.start, s.end, l.start, l.end) > maxShift || !l.text) return;
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

  // Second pass, for the subtitles the first left without a line: the transcription's times can
  // drift several seconds over a tab (measured: 3-5 s, 14 lines of one tab kept their wrong times
  // and 20 of its on-screen lines had no subtitle). Each is paired with a line no subtitle shows
  // with yet, further away (maxShift) but only by its text, and only between the lines of its
  // matched neighbours, so no subtitle moves past another. Fills `matches` (matchSubtitles'
  // result for the same subs) in place and returns it.
  const FAR_SHIFT = 8;
  function matchLeftovers(subs, lines, matches, { maxShift = FAR_SHIFT } = {}) {
    const S = prepare(subs || []);
    const L = prepare(lines || []).filter((l) => l.start !== null && l.end !== null && l.end > l.start && l.text);
    const free = L.filter((l) => !matches.some((m) => m && overlapOf(m.start, m.end, l.start, l.end) > 0.5 * (l.end - l.start)));
    const left = S.filter((s) => !matches[s.i] && s.text && s.start !== null && s.end !== null);
    if (!free.length || !left.length) return matches;
    const far = matchSubtitles(left.map((s) => subs[s.i]), free.map((l) => lines[l.i]), { maxShift });
    // Neighbours in time: subs are compared by their transcribed start.
    const order = S.filter((s) => s.start !== null).sort((a, b) => a.start - b.start).map((s) => s.i);
    far.forEach((m, k) => {
      if (!m) return;
      const i = left[k].i;
      const at = order.indexOf(i);
      const prev = order.slice(0, at).reverse().find((j) => matches[j]);
      const next = order.slice(at + 1).find((j) => matches[j]);
      if (prev !== undefined && m.start < matches[prev].end - 0.05) return;
      if (next !== undefined && m.end > matches[next].start + 0.05) return;
      matches[i] = m;
    });
    return matches;
  }

  // Times for every subtitle with the transcription's error around it taken off. A matched
  // subtitle tells the error where it is (its line's start minus its transcribed start), and the
  // error drifts over a tab (measured on 164 tabs: one went from 0.6 s to 12 s early over 4
  // minutes, another 6 s late after minute 3), so an unmatched one is moved by the error of the
  // matched ones on either side of it, in between by time (a jump - a part transcribed apart -
  // is kept sharp: a median of several neighbours put the line at the jump on the wrong side).
  // Matched ones keep their transcribed times here.
  //   -> [{ start, end }] (same order as subs)
  const median = (v) => {
    const s = v.slice().sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };

  // The error at time t, from anchors [{ t, off }] in time order (see driftShifted).
  function offsetAt(anchors, t) {
    if (!anchors.length) return 0;
    let k = 0;
    while (k < anchors.length && anchors[k].t < t) k++;
    if (k < anchors.length && anchors[k].t === t) return anchors[k].off;
    if (k === 0) return anchors[0].off;
    if (k === anchors.length) return anchors[k - 1].off;
    const a = anchors[k - 1], b = anchors[k];
    return a.off + ((b.off - a.off) * (t - a.t)) / (b.t - a.t);
  }

  function driftShifted(subs, matches) {
    const S = prepare(subs || []);
    const anchors = S.filter((s) => matches[s.i] && s.start !== null)
      .map((s) => ({ t: s.start, off: matches[s.i].start - s.start }))
      .sort((a, b) => a.t - b.t);
    return S.map((s) => {
      if (matches[s.i] || s.start === null || !anchors.length) return { start: s.start, end: s.end };
      const off = offsetAt(anchors, s.start);
      return { start: s.start + off, end: s.end === null ? null : s.end + off };
    });
  }

  // Subtitles that are surely one on-screen line, found by their text alone, to measure the
  // transcription's error before anything is matched: matching within MAX_SHIFT first paired
  // lines 15 s off with the wrong line next to them (alike letters), which then kept the right
  // one from them. Only text of ANCHOR_MIN letters or more that both sides hold nearly all of
  // (ANCHOR_ALIKE), within ANCHOR_WINDOW s, the most of them in order; one whose error is far
  // from its neighbours' (a line said twice) is left out. -> [{ t, off }] in time order
  const ANCHOR_WINDOW = 30;
  const ANCHOR_MIN = 4;
  const ANCHOR_ALIKE = 0.8;
  const ANCHOR_OUTLIER = 2; // s
  function textAnchors(subs, lines) {
    const S = prepare(subs || []).filter((s) => s.start !== null && s.text.length >= ANCHOR_MIN).sort((a, b) => a.start - b.start);
    const L = prepare(lines || []).filter((l) => l.start !== null && l.end !== null && l.text.length >= ANCHOR_MIN).sort((a, b) => a.start - b.start);
    const cand = []; // [sub k, line j, how alike]
    S.forEach((s, k) => {
      L.forEach((l, j) => {
        if (Math.abs(l.start - s.start) > ANCHOR_WINDOW) return;
        const common = commonLetters(s.counts, l.counts);
        const alike = Math.min(common / s.text.length, common / l.text.length);
        if (alike >= ANCHOR_ALIKE) cand.push([k, j, alike]);
      });
    });
    // The heaviest chain with subs and lines both in order.
    const best = cand.map((c) => c[2]), from = cand.map(() => -1);
    for (let a = 0; a < cand.length; a++) {
      for (let b = 0; b < a; b++) {
        if (cand[b][0] < cand[a][0] && cand[b][1] < cand[a][1] && best[b] + cand[a][2] > best[a]) {
          best[a] = best[b] + cand[a][2];
          from[a] = b;
        }
      }
    }
    let top = -1;
    best.forEach((v, a) => { if (top < 0 || v > best[top]) top = a; });
    const chain = [];
    for (let a = top; a >= 0; a = from[a]) chain.unshift({ t: S[cand[a][0]].start, off: L[cand[a][1]].start - S[cand[a][0]].start });
    return chain.filter((a, k) => {
      const near = chain.slice(Math.max(0, k - 3), k + 4).map((n) => n.off);
      return Math.abs(a.off - median(near)) <= ANCHOR_OUTLIER;
    });
  }

  // Every subtitle paired with its on-screen line, however far the transcription drifted: each
  // is first moved by the error measured around it (textAnchors), then matchSubtitles and
  // matchLeftovers pair them as usual, and the leftovers are paired again moved by the error of
  // the pairs around them until no more are found. Returns matchSubtitles' result for the same
  // subs; driftShifted(subs, result) gives the unmatched ones their best times.
  const DRIFT_PASSES = 5;
  function matchFollowingDrift(subs, lines) {
    const anchors = textAnchors(subs, lines);
    let moved = (subs || []).map((s) => {
      const start = num(s.start), end = num(s.end);
      if (start === null || !anchors.length) return s;
      const off = offsetAt(anchors, start);
      return { ...s, start: start + off, end: end === null ? s.end : end + off };
    });
    const matches = matchSubtitles(moved, lines);
    matchLeftovers(moved, lines, matches);
    for (let pass = 0; pass < DRIFT_PASSES; pass++) {
      const before = matches.filter(Boolean).length;
      if (before === matches.length) break;
      moved = driftShifted(moved, matches).map((t, i) => ({ ...moved[i], start: t.start, end: t.end }));
      matchLeftovers(moved, lines, matches);
      if (matches.filter(Boolean).length === before) break;
    }
    return matches;
  }

  // On-screen lines no matched subtitle shows over (their own text, no line of the transcription
  // for them): [{ start, end, text }]. Only the video's subtitles: on screen at least minSeconds,
  // with text, and centred like them - measured over 4,044 subtitles, 99% sit within 2% of the
  // middle; what the reader also finds in that row off-centre is not said (chat bubbles on a
  // phone, 8-14% off; signs and logos, 22-33%).
  const MAX_OFF_CENTRE = 3; // % of the width
  function uncoveredLines(lines, matches, { minSeconds = 0.5, maxOffCentre = MAX_OFF_CENTRE } = {}) {
    const centred = (l) => num(l.x) === null || num(l.w) === null || Math.abs(num(l.x) + num(l.w) / 2 - 50) <= maxOffCentre;
    return (lines || []).filter((l) => num(l.start) !== null && num(l.end) !== null && l.end - l.start >= minSeconds && normText(l.text).length >= 1
      && centred(l) && !matches.some((m) => m && overlapOf(m.start, m.end, l.start, l.end) > 0.5 * (l.end - l.start)));
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
      } else if (hi - lo >= MIN_LEFT) {
        // Its neighbours moved over (or past) it, but there is room between them: it goes into
        // that room - keeping its length when it fits - instead of overlapping a matched line.
        const len = Math.min(Math.max(out[k].end - out[k].start, MIN_LEFT), hi - lo);
        out[k].start = Math.min(Math.max(out[k].start, lo), hi - len);
        out[k].end = out[k].start + len;
      }
    });
    return out;
  }

  return { MAX_SHIFT, FAR_SHIFT, MIN_HELD, MIN_SHARE, JOIN_GAP, normText, matchSubtitles, matchLeftovers, driftShifted, matchFollowingDrift, uncoveredLines, placeUnmatched, pairLines };
});
