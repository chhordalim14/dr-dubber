// Khmer subtitle text made ready for the voice (VoxCPM2 and edge-tts both get this): what is
// written one way and said another is written the way it is said.
//
//   numbers      ១៨ម៉ឺន -> ដប់ប្រាំបីម៉ឺន, អាយុ ៣៣ -> អាយុ សាមសិបបី, 2,500 -> ពីរពាន់ប្រាំរយ, 3.5 -> បីក្បៀសប្រាំ,
//                50% -> ហាសិបភាគរយ, $20 -> ម្ភៃដុល្លារ, ¥500 -> ប្រាំរយយ័ន, -5°C -> ដកប្រាំអង្សាសេ, dates
//                (15/5/2026, 2026-05-15); a code with a leading 0 (0927) digit by digit
//   ៗ            the word before it said twice: មែនៗ -> មែនមែន, ផ្សេងៗ -> ផ្សេងផ្សេង
//   marks        ។ល។ -> ជាដើម, ៖ a pause, ព.ស. -> ពុទ្ធសករាជ, គ.ម. -> គីឡូម៉ែត្រ
//   acronyms     VIP -> វីអាយភី, 5G -> ប្រាំជី (letter names, the way Khmer speakers say them)
//   punctuation  ... and dashes are pauses, quotes and brackets are not read, a closing ? or !
//                is kept (it carries the question / the shout), anything else closes with ។
//   tags         [Female:female-default] and the like are dropped
//   pronunciation  words the voice misreads as written, respelled: ម្ចាស់ -> ម៉ាចាស់, ម្នាក់ -> ម៉ានាក់
//                (see SAY_AS, RESPELL)
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

  const MONTHS = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];
  const digitByDigit = (s) => Array.from(s.replace(/\D/g, ''), (d) => ONES[+d]).join(' ');
  // Units read after a number: 5km -> ប្រាំគីឡូម៉ែត្រ. Not followed by a letter, so 3 min stays.
  const UNIT_WORDS = {
    'km/h': 'គីឡូម៉ែត្រក្នុងមួយម៉ោង', km: 'គីឡូម៉ែត្រ', cm: 'សង់ទីម៉ែត្រ', mm: 'មីលីម៉ែត្រ', m: 'ម៉ែត្រ',
    kg: 'គីឡូក្រាម', g: 'ក្រាម', ml: 'មីលីលីត្រ', '°C': 'អង្សាសេ',
  };
  const NUM = '\\d[\\d,]*(?:\\.\\d+)?';
  const UNIT_RE = new RegExp(`(${NUM})\\s?(km\\/h|km|cm|mm|kg|ml|°C|m|g)(?![A-Za-z])`, 'g');

  const sayDate = (all, d, m, y) => (+m >= 1 && +m <= 12 && +d >= 1 && +d <= 31
    ? `ថ្ងៃទី${numberToWords(+d)} ខែ${MONTHS[+m - 1]} ឆ្នាំ${numberToWords(+y)}`
    : all);
  // Money after a number (or $ € £ ¥ ฿ before it). ¥ / 元 are yuan: the films are Chinese.
  const CURRENCY = { $: 'ដុល្លារ', USD: 'ដុល្លារ', '៛': 'រៀល', KHR: 'រៀល', '€': 'អឺរ៉ូ', '£': 'ផោន', '¥': 'យ័ន', '元': 'យ័ន', '฿': 'បាត' };
  const MONEY_BEFORE = new RegExp(`([$€£¥฿])\\s?(${NUM})`, 'g');
  const MONEY_AFTER = new RegExp(`(${NUM})\\s?([$៛€£¥฿元]|USD|KHR)(?![A-Za-z])`, 'g');

  function sayNumbers(text) {
    return toAsciiDigits(text)
      // A date d/m/yyyy, d-m-yyyy, d.m.yyyy or yyyy-mm-dd: ថ្ងៃទីដប់ប្រាំ ខែឧសភា ឆ្នាំ... (before
      // the phone numbers: 05-10-2026 has their leading 0 and dashes).
      .replace(/(?:ថ្ងៃទី\s?)?\b(\d{1,2})([/.-])(\d{1,2})\2(\d{4})\b/g, (all, d, sep, m, y) => sayDate(all, d, m, y))
      .replace(/(?:ថ្ងៃទី\s?)?\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (all, y, m, d) => sayDate(all, d, m, y))
      // A phone number in groups (012 345 678, 012-345-678): digit by digit, not 3 numbers.
      .replace(/(?<![\d.,])0\d{1,3}(?:[ -]\d{2,4}){1,3}(?![\d.,])/g, digitByDigit)
      // A minus sign (not a range: nothing counted before it): -5°C -> ដកប្រាំអង្សាសេ.
      .replace(/(^|[\s(=])[-−](?=\d)/g, '$1ដក')
      // Times: 3×4 -> បី គុណ បួន.
      .replace(/(\d)\s?[×x]\s?(?=\d)/g, '$1 គុណ ')
      // A time of day: ម៉ោង 10:30 -> ម៉ោងដប់កន្លះ, 7:15 -> ម៉ោងប្រាំពីរ ដប់ប្រាំនាទី.
      .replace(/(ម៉ោង\s?)?\b(\d{1,2}):(\d{2})\b/g, (all, pre, h, m) => {
        if (+h > 24 || +m > 59) return all;
        const mins = +m === 0 ? '' : +m === 30 ? 'កន្លះ' : ` ${numberToWords(+m)}នាទី`;
        return `ម៉ោង${numberToWords(+h)}${mins}`;
      })
      // Any other n:n is a score: 3:2 -> បី ទល់ ពីរ.
      .replace(/(\d)\s?:\s?(?=\d)/g, '$1 ទល់ ')
      // A fraction: 1/2 -> មួយភាគពីរ.
      .replace(/\b(\d{1,3})\/(\d{1,3})\b/g, (_, a, b) => `${numberToWords(+a)}ភាគ${numberToWords(+b)}`)
      // A range: 20-30 -> ម្ភៃ ទៅ សាមសិប (a dash elsewhere is a pause).
      .replace(new RegExp(`(${NUM})\\s?[-–~]\\s?(?=\\d)`, 'g'), '$1 ទៅ ')
      .replace(UNIT_RE, (_, n, u) => `${sayNumber(n)}${UNIT_WORDS[u]}`)
      .replace(MONEY_BEFORE, (_, c, n) => `${sayNumber(n)}${CURRENCY[c]}`)
      .replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, (_, n) => `${sayNumber(n)}ភាគរយ`)
      .replace(MONEY_AFTER, (_, n, c) => `${sayNumber(n)}${CURRENCY[c]}`)
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
  // Not ំហ: លំហ, ចំហ are one syllable with a soft final h ("lomh", as Google says it). Edge says
  // them nearly so as written ("lom"); respelled ហា it said a long "haa", and ហៈ / ះ an added
  // short "ha" - a vowel the word does not have. Measured with a Khmer recogniser against
  // Google's voice, 2026-10-24: none of the respellings came closer, so they are left as written.
  const SAY_AS = new Map([
    // 'written': 'said'  (whole words; add one here when a voice misreads a word)
  ]);
  // Parts of words respelled wherever they appear, also inside a compound the segmenter splits
  // differently (ព្រះអង្គម្ចាស់, លោកម្ចាស់, ខ្ញុំម្ចាស់).
  //
  // A leading ម្ before another consonant: both Khmer voices say the ម so short that the word is
  // heard without it - ព្រះអង្គម្ចាស់ came out ព្រះអង្គចាស់ ("old"). Measured inside a sentence,
  // both voices, +0% and +20%: of the length ម៉ា adds, the written ម gets only 20-75%. Respelled
  // here only where the word without its ម is another word, so the line says something else:
  // ម្ចាស់/ចាស់ (old), ម្នាង/នាង (អ្នកម្នាង -> អ្នកនាង), ម្ហូប/ហូប (eat), ម្ដង/ដង (times),
  // ម្ខាង/ខាង (side), ម្នាក់/នាក់ (ម្នាក់ឯង -> នាក់ឯង). The others (ម្ដាយ, ម្សិលមិញ, ម្ភៃ ...) are
  // still understood, and a short ម is how people say them.
  const RESPELL = [
    // [written, said]  (not after a subscript sign, so it never cuts into another cluster)
    ['ម្ចាស់', 'ម៉ាចាស់'],
    ['ម្នាង', 'ម៉ានាង'],
    ['ម្ហូប', 'ម៉ាហូប'],
    ['ម្[ដត]ង', 'ម៉ាដង'], // ម្ដង and the look-alike spelling ម្តង
    ['ម្ខាង', 'ម៉ាខាង'],
    ['ម្នាក់', 'ម៉ានាក់'],
  ].map(([from, to]) => [new RegExp(`(?<!្)${from}`, 'g'), to]);
  function fixPronunciation(text) {
    let s = text;
    if (SAY_AS.size && words) {
      s = Array.from(words.segment(s), (seg) => (seg.isWordLike && SAY_AS.has(seg.segment) ? SAY_AS.get(seg.segment) : seg.segment)).join('');
    }
    for (const [re, to] of RESPELL) s = s.replace(re, to);
    return s;
  }

  // English titles before a name, said the Khmer way (the name after them is kept).
  const TITLES = [[/\bMrs\.?(?=\s)/g, 'លោកស្រី'], [/\bMr\.?(?=\s)/g, 'លោក'], [/\bMs\.?(?=\s)/g, 'កញ្ញា'], [/\bMiss(?=\s)/g, 'កញ្ញា'], [/\bDr\.?(?=\s)/g, 'វេជ្ជបណ្ឌិត']];
  const sayTitles = (text) => TITLES.reduce((s, [re, to]) => s.replace(re, to), text);

  // The user's own list (Settings > Pronunciation): [written, said] pairs, applied wherever the
  // written form appears, longest first so a longer word wins over a part of it.
  const PRONUNCIATION_KEY = 'aiDubberPronunciations';
  let userWords = [];
  function setPronunciations(list) {
    userWords = (Array.isArray(list) ? list : [])
      .map((p) => [String((p && p[0]) || '').trim(), String((p && p[1]) || '').trim()])
      .filter(([from, to]) => from && to && from !== to)
      .sort((a, b) => b[0].length - a[0].length);
  }
  // The Settings box: one word per line, "written = said" (=> and → work too); other lines are
  // ignored, so a note can be left in it.
  function parsePronunciations(text) {
    return String(text || '').split(/\r?\n/)
      .map((line) => line.split(/\s*(?:=>|→|=)\s*/))
      .filter((parts) => parts.length === 2)
      .map(([from, to]) => [from.trim(), to.trim()]);
  }
  function applyUserWords(text) {
    if (!userWords.length) return text;
    // One pass over all of them, so a "said" form is never respelled again by another pair.
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const map = new Map(userWords);
    return text.replace(new RegExp(userWords.map(([from]) => esc(from)).join('|'), 'g'), (w) => map.get(w));
  }

  // Acronyms (1 to 5 capitals: VIP, CEO, the G of 5G, plan A) by their Khmer letter names.
  // A capital starting a word (Wen, Ting'an) is a name and is left as written.
  const spellAcronyms = (text) => text
    .replace(/(?<![A-Za-z])(?:ok|okay|Ok|Okay|OKAY)(?![A-Za-z])/g, 'OK')
    .replace(/(?<![A-Za-z'])[A-Z]{1,5}(?![A-Za-z'])/g, (w) => Array.from(w, (c) => LETTERS[c] || c).join(''));

  // Khmer marks and abbreviations read out as words: ។ល។ and ៘ "and so on", ៖ a pause before
  // what follows, ព.ស. / គ.ស. the eras, គ.ម. / គ.ក្រ. km / kg, ល.រ. "number".
  const ABBREVIATIONS = [
    [/\s*(?:។ល។|៘)/g, ' ជាដើម'],
    [/\s*៖\s*/g, ', '],
    [/(?<![ក-៓])ព\.\s?ស\.?/g, 'ពុទ្ធសករាជ'],
    [/(?<![ក-៓])គ\.\s?ស\.?/g, 'គ្រិស្តសករាជ'],
    [/(?<![ក-៓])គ\.\s?ម\.?/g, 'គីឡូម៉ែត្រ'],
    [/(?<![ក-៓])គ\.\s?ក្រ\.?/g, 'គីឡូក្រាម'],
    [/(?<![ក-៓])ល\.\s?រ\.?/g, 'លេខរៀង'],
  ];
  const sayAbbreviations = (text) => ABBREVIATIONS.reduce((s, [re, to]) => s.replace(re, to), text);

  // Subtitle text -> what the voice is given. Text without Khmer is only tidied.
  function normalizeForSpeech(text) {
    let s = String(text == null ? '' : text)
      .replace(/^\s*\[[^\]]*:[^\]]*\]\s*/, '') // [Female:female-default] speaker tags
      .replace(/<[^>]+>/g, '')
      .replace(/[​-‍﻿]/g, '')
      .replace(/\r?\n/g, ' ');
    if (!KHMER_RE.test(s)) return s.replace(/\s+/g, ' ').trim();
    s = expandRepeat(s);
    s = applyUserWords(s);
    s = sayAbbreviations(s);
    s = fixPronunciation(s);
    s = sayNumbers(s);
    s = sayTitles(s);
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

  // In the app, start with the list saved in Settings (studio-main.js keeps it up to date).
  try {
    if (typeof localStorage !== 'undefined') setPronunciations(parsePronunciations(localStorage.getItem(PRONUNCIATION_KEY)));
  } catch (e) { /* no storage: no user words */ }

  return { normalizeForSpeech, numberToWords, sayNumbers, expandRepeat, setPronunciations, parsePronunciations, PRONUNCIATION_KEY };
});
