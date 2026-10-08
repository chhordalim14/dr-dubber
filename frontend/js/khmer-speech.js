// Khmer subtitle text made ready for the voice (VoxCPM2 and edge-tts both get this): what is
// written one way and said another is written the way it is said.
//
//   numbers      ១៨ម៉ឺន -> ដប់ប្រាំបីម៉ឺន, អាយុ ៣៣ -> អាយុ សាមសិបបី, 2,500 -> ពីរពាន់ប្រាំរយ, 3.5 -> បីក្បៀសប្រាំ,
//                50% -> ហាសិបភាគរយ, $20 -> ម្ភៃដុល្លារ; a code with a leading 0 (0927) digit by digit
//   ៗ            the word before it said twice: មែនៗ -> មែនមែន, ផ្សេងៗ -> ផ្សេងផ្សេង
//   acronyms     VIP -> វីអាយភី (letter names, the way Khmer speakers say them)
//   punctuation  ... and dashes are pauses, quotes and brackets are not read, a closing ? or !
//                is kept (it carries the question / the shout), anything else closes with ។
//   tags         [Female:female-default] and the like are dropped
//   pronunciation  words the voice misreads as written, respelled: លំហ -> លំហា (see SAY_AS)
//
// Loaded by the browser as a classic script (window.KhmerSpeech) and by Node (tests).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KhmerSpeech = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const KHMER_RE = /[ក-៿]/;
  const ONES = ['សូន្យ', 'មួយ', 'ពីរ', 'បី', 'បួន', 'ប្រាំ', 'ប្រាំមួយ', 'ប្រាំពីរ', 'ប្រាំបី', 'ប្រាំបួន'];
  const TENS = ['', 'ដប់', 'ម្ភៃ', 'សាមសិប', 'សែសិប', 'ហាសិប', 'ហុកសិប', 'ចិតសិប', 'ប៉ែតសិប', 'កៅសិប'];
  // Below a million Khmer counts in its own units: រយ 100, ពាន់ 1,000, ម៉ឺន 10,000, សែន 100,000.
  const UNITS = [[100000, 'សែន'], [10000, 'ម៉ឺន'], [1000, 'ពាន់'], [100, 'រយ']];
  const LETTERS = {
    A: 'អេ', B: 'ប៊ី', C: 'ស៊ី', D: 'ឌី', E: 'អ៊ី', F: 'អេហ្វ', G: 'ជី', H: 'អេច', I: 'អាយ', J: 'ជេ', K: 'ខេ', L: 'អែល', M: 'អែម',
    N: 'អែន', O: 'អូ', P: 'ភី', Q: 'ឃ្យូ', R: 'អា', S: 'អេស', T: 'ធី', U: 'យូ', V: 'វី', W: 'ដាប់ប៊ែលយូ', X: 'អិច', Y: 'វ៉ាយ', Z: 'ហ្សេត',
  };

  // A whole number (0 .. 999,999,999,999) in Khmer words.
  function numberToWords(n) {
    n = Math.floor(Math.abs(Number(n)));
    if (!Number.isFinite(n)) return '';
    if (n < 10) return ONES[n];
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ONES[n % 10] : '');
    if (n >= 1e9) return numberToWords(Math.floor(n / 1e9)) + 'ពាន់លាន' + (n % 1e9 ? numberToWords(n % 1e9) : '');
    if (n >= 1e6) return numberToWords(Math.floor(n / 1e6)) + 'លាន' + (n % 1e6 ? numberToWords(n % 1e6) : '');
    for (const [size, word] of UNITS) {
      if (n >= size) return ONES[Math.floor(n / size)] + word + (n % size ? numberToWords(n % size) : '');
    }
    return '';
  }

  const toAsciiDigits = (s) => s.replace(/[០-៩]/g, (d) => String(d.charCodeAt(0) - 0x17E0));

  // A number as written (ASCII digits, maybe with thousands commas and a decimal part).
  function sayNumber(raw) {
    const s = raw.replace(/,(?=\d{3}\b)/g, '');
    const [whole, frac] = s.split('.');
    // A code, phone or card number (leading zero, or very long): digit by digit.
    if ((whole.length > 1 && whole[0] === '0') || whole.length > 12) return Array.from(whole, (d) => ONES[+d]).join(' ');
    let out = numberToWords(parseInt(whole, 10));
    if (frac) out += 'ក្បៀស' + (frac.length > 1 && frac[0] === '0' ? Array.from(frac, (d) => ONES[+d]).join('') : numberToWords(parseInt(frac, 10)));
    return out;
  }

  function sayNumbers(text) {
    return toAsciiDigits(text)
      .replace(/\$\s?(\d[\d,]*(?:\.\d+)?)/g, (_, n) => `${sayNumber(n)}ដុល្លារ`)
      .replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, (_, n) => `${sayNumber(n)}ភាគរយ`)
      .replace(/(\d[\d,]*(?:\.\d+)?)\s?([$៛])/g, (_, n, c) => `${sayNumber(n)}${c === '$' ? 'ដុល្លារ' : 'រៀល'}`)
      .replace(/\d[\d,]*(?:\.\d+)?/g, (n) => sayNumber(n.replace(/,$/, '')) + (n.endsWith(',') ? ',' : ''));
  }

  // ៗ: the word before it, said again.
  const words = (() => {
    try {
      return typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('km', { granularity: 'word' }) : null;
    } catch (e) {
      return null;
    }
  })();
  function lastWord(text) {
    if (words) {
      const segs = Array.from(words.segment(text)).filter((s) => s.isWordLike);
      if (segs.length) return segs[segs.length - 1].segment;
    }
    const m = text.match(/[ក-៓៝]+$/); // no segmenter: the Khmer run before it
    return m ? m[0] : '';
  }
  function expandRepeat(text) {
    let out = '';
    for (const part of text.split('ៗ')) {
      if (!out) {
        out = part;
        continue;
      }
      const before = out.replace(/\s+$/, '');
      out = before + lastWord(before) + part;
    }
    return out;
  }

  // Words the voice says wrong as written, respelled the way they are said.
  //
  // Edge-TTS (also the source of the cloned voices) takes a ហ right after ំ with no vowel of its
  // own for a silent final, at a word's end and inside a compound alike: លំហ came out "លំ",
  // លំហអាកាស "លំអាកាស", ចំហ "ចំ". It is a syllable of its own (lum-ha, cham-ha). Measured on
  // both Khmer voices: written ហា it is spoken (+0.2 s of speech), written ហ it is not.
  const SAY_AS = new Map([
    // 'written': 'said'  (whole words; add one here when a voice misreads a word)
  ]);
  const NIKAHIT_HA_RE = /([ក-អ]ំហ)(?![឴-៓៝])/g; // …ំហ not followed by its vowel / a subscript
  function fixPronunciation(text) {
    let s = text;
    if (SAY_AS.size && words) {
      s = Array.from(words.segment(s), (seg) => (seg.isWordLike && SAY_AS.has(seg.segment) ? SAY_AS.get(seg.segment) : seg.segment)).join('');
    }
    return s.replace(NIKAHIT_HA_RE, '$1ា');
  }

  // Acronyms (2 to 5 capitals, maybe with a digit: VIP, BE, CEO) by their Khmer letter names.
  const spellAcronyms = (text) => text.replace(/\b[A-Z]{2,5}\b/g, (w) => Array.from(w, (c) => LETTERS[c] || c).join(''));

  // Subtitle text -> what the voice is given. Text without Khmer is only tidied.
  function normalizeForSpeech(text) {
    let s = String(text == null ? '' : text)
      .replace(/^\s*\[[^\]]*:[^\]]*\]\s*/, '') // [Female:female-default] speaker tags
      .replace(/<[^>]+>/g, '')
      .replace(/[​-‍﻿]/g, '')
      .replace(/\r?\n/g, ' ');
    if (!KHMER_RE.test(s)) return s.replace(/\s+/g, ' ').trim();
    s = expandRepeat(s);
    s = fixPronunciation(s);
    s = sayNumbers(s);
    s = spellAcronyms(s);
    s = s
      .replace(/[？]/g, '?').replace(/[！]/g, '!').replace(/[，、]/g, ',').replace(/[；]/g, ';').replace(/[：]/g, ':')
      .replace(/["“”„«»「」『』]/g, '')
      .replace(/(^|[^A-Za-z])'|'(?![A-Za-z])/g, '$1')       // quotes, not the apostrophe in Ting'an
      .replace(/[()[\]{}（）【】]/g, ' ')
      .replace(/\s*(?:\.{2,}|…+)\s*/g, ', ')              // ... is a pause
      .replace(/\s*[—–~]+\s*/g, ', ')                     // so is a dash
      .replace(/([?!])[?!.។,]+/g, '$1')                    // ?! -> ?, !!! -> !
      .replace(/,\s*,+/g, ',')
      .replace(/^[\s,។]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    // The close: a question or a shout keeps its mark; anything else ends with ។.
    const end = s.match(/[?!]\s*$/);
    s = s.replace(/[\s,;:.។៕!?]+$/, '');
    if (!s) return '';
    return s + (end ? end[0].trim() : '។');
  }

  return { normalizeForSpeech, numberToWords, sayNumbers, expandRepeat };
});
