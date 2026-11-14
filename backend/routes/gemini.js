// Gemini model resolution, fallback engine, key rotation, and AI pipeline
// (transcription, subtitle repair, translation, emotion detection, line shortening,
// title generation, name consistency). Extracted out of server.js into a dedicated router.
// Mounted at /api.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const {
    STORAGE_BASE, SEPARATED_DIR, resolveLocalFilePath
} = require('../lib/paths');
const security = require('../lib/security');
const { isNetworkPath } = security;
const { hasForeignText, stripForeignScript } = require('../lib/text-rules');
const { trackProcess } = require('../lib/process-tracker');
const { secureFetch } = require('../lib/secure-fetch');
const { getDRRouterManager } = require('../lib/dr-router');

function getDRRouterProxyForKey(apiKey) {
    try {
        const mgr = getDRRouterManager();
        return mgr.getProxyForApiKey(apiKey);
    } catch (e) {
        return null;
    }
}
const { createCodeCraftClient } = require('../lib/codecraft');
const { createKeyRest } = require('../lib/key-rest');
const {
    KHMER_SYLLABLES_PER_SEC, KHMER_DUBBING_RULES, khmerMaxSyllables, lineSeconds,
    getKhmerDramaRegisterGuidance, parseSrtBlocksForTranslate, translatePromptLine,
    buildTranslateSystemPrompt, buildTranslateUserPrompt, buildReviewSystemPrompt,
    buildReviewUserPrompt, estimateSpeechSeconds, findOverlongLines
} = require('../lib/khmer-prompts');
const { MISSING_RESPONSE_SCHEMA, buildMissingLinesPrompt, checkMissingLine } = require('../lib/missing-lines');
const { SPLIT_RESPONSE_SCHEMA, buildSplitLinesPrompt, checkSplitLine } = require('../lib/split-lines');
const {
    CHARACTER_SHEET_SCHEMA, normalizeSheet, mergeSheets, sheetSize,
    applyGlossaryToSheet, formatSheetForPrompt, buildCharacterSheetPrompt,
    loadSeriesSheet, saveSeriesSheet, loadSeriesSpeakers, saveSeriesSpeakers,
    addSeriesSpeakers, seriesNameOf, foldSpeakers, formatSpeakersForPrompt,
    castDir, withSeriesLock
} = require('../lib/character-sheet');
const NameConsistency = require('../../frontend/js/name-consistency.js');

// --- GEMINI MODEL RESOLUTION & FALLBACK ENGINE ---
// Retired by Google on Oct 8, 2026: the names still answer, but Google routes them to another
// model. Asking one is asking its replacement - as a fallback after the replacement hit its limit
// it only asked the same model again - so the fallbacks leave them out.
const GEMINI_ROUTED_MODELS = { 'gemini-3.7-flash': 'gemini-3.8-flash', 'gemini-3.5-flash': 'gemini-3.6-flash' };
function resolveGeminiModel(modelName) {
    if (!modelName || modelName === 'latest') return 'gemini-3.8-flash';
    const m = String(modelName).toLowerCase().trim();
    if (m === 'gemini-3.8-flash' || m.includes('3.8-flash') || m.includes('3.8')) return 'gemini-3.8-flash';
    // Audio-only (no prompt or JSON): it can't do the app's jobs, so an older saved setting gets 3.8 Flash.
    if (m.includes('3.5-transcribe') || m.includes('audio-specialist')) return 'gemini-3.8-flash';
    // Retired 3.7 / 3.5 Flash (see GEMINI_ROUTED_MODELS): an older saved setting gets the model
    // Google answers it with anyway.
    if (m === 'gemini-3.7-flash' || m.includes('3.7-flash') || m.includes('3.7')) return 'gemini-3.8-flash';
    if (m === 'gemini-3.6-flash' || m.includes('3.6-flash') || m.includes('3.6')) return 'gemini-3.6-flash';
    if (m === 'gemini-3.1-pro-preview' || m === 'gemini-3.1-pro' || m.includes('3.1-pro') || m.includes('2.5-pro')) return 'gemini-3.1-pro-preview';
    // Lite models produce broken Unicode, wrong pronouns and unreadable Khmer; route to 3.8 Flash.
    if (m.includes('flash-lite') || m.includes('-lite') || m.includes('lite')) return 'gemini-3.8-flash';
    if (m === 'gemini-3.5-flash' || m.includes('3.5-flash') || m.includes('3.5')) return 'gemini-3.6-flash';
    // Shut down (or never a Gemini API model): an older saved setting gets Google's replacement.
    if (m === 'gemini-3.1-flash' || m.includes('3.1-flash') || m.includes('3.1')) return 'gemini-3.8-flash';
    if (m.includes('2.5-flash') || m.includes('2.5')) return 'gemini-3.8-flash';
    if (m === 'gemini-2.0-flash' || m.includes('2.0-flash') || m.includes('2.0')) return 'gemini-3.6-flash';
    if (m.includes('1.5-pro') || m.includes('1.5-flash')) return 'gemini-3.8-flash';
    return m;
}

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// A whole tab (API saver: up to 10 min of audio + video) writes ~12k tokens and thinks ~15k more,
// which takes Google 1.5-3 minutes. At 65s (v1.17.0) most of them were cut off while still being
// written - 154 in one day, 0 in the three weeks at 240s - each cut-off still counting against the
// key's per-minute limit, so 50 keys ran into "per-minute limit" 572 times. Back to v1.16.0's values.
const GEMINI_ATTEMPT_TIMEOUT_MS = 240000;
// Short text-only requests (shorten rushed lines, re-translate up to 40 lines, read the names,
// the review of up to 100 lines) answer well within this.
const GEMINI_TEXT_TIMEOUT_MS = 120000;
// Check limits sends "Reply with OK": no answer in this time is Google overloaded, not a long reply.
const GEMINI_CHECK_TIMEOUT_MS = 30000;
const geminiModelListCache = new Map(); // apiKey -> { at, models: Set<string> }

// Ask Google which models this key can actually call, so we never burn retries on
// names that 404 (retired 1.5 models, previews that were renamed, etc.).
async function listGeminiModels(apiKey, signal) {
    const cached = geminiModelListCache.get(apiKey);
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.models;
    try {
        const proxy = getDRRouterProxyForKey(apiKey);
        const fetchOpts = { signal, headers: { 'x-goog-api-key': apiKey } };
        if (proxy) fetchOpts.proxy = proxy;
        const res = await secureFetch(`${GEMINI_API_BASE}/models?pageSize=1000`, fetchOpts);
        if (!res.ok) return null;
        const json = await res.json();
        const models = new Set((json.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map(m => String(m.name || '').replace(/^models\//, '')));
        geminiModelListCache.set(apiKey, { at: Date.now(), models });
        return models;
    } catch (e) {
        if (e.name === 'AbortError') throw e;
        return null;
    }
}

// Best general-purpose text/audio models first: flash before pro (pro free-tier quota
// is tiny), stable before preview (previews are the ones Google throttles with
// "high demand" 503s), then newer before older.
function rankGeminiFallbacks(available) {
    const parsed = [];
    for (const name of available) {
        if (GEMINI_ROUTED_MODELS[name]) continue;
        // Skip 2.5 / 2.0 / 1.5 - Google returns 404 ("no longer available to new users")
        // Skip flash-lite models - they produce unreadable/garbled Khmer dubbing lines
        if (name.includes('2.5') || name.includes('2.0') || name.includes('1.5') || name.includes('-lite')) continue;
        // Dated previews only ("-preview-09-2025"); skips -tts, -image, -live variants and
        // -transcribe (audio only: it refuses a prompt and JSON, so every request to it failed).
        // gemini-4-hydrogen: tested 2026-11-14 on a free key - good Khmer (pronouns, royal words),
        // 13s for 5 lines. Ranked like a Flash preview: after the stable Flash models, before older
        // previews. (gemini-4-argon / -carbon answered "quota exceeded" with no quota at all on a free key.)
        const m = name.match(/^gemini-(\d+(?:\.\d+)?)-(flash|pro|hydrogen)(?:-(latest|preview(?:-\d[\d-]*)?))?$/);
        if (!m) continue;
        const tier = m[2] === 'pro' ? 'pro' : 'flash';
        const tag = m[3] || (m[2] === 'hydrogen' ? 'hydrogen' : '');
        parsed.push({ name, version: parseFloat(m[1]), tier, tag });
    }
    parsed.sort((a, b) =>
        (a.tier === 'flash' ? 0 : 1) - (b.tier === 'flash' ? 0 : 1) ||
        (a.tag ? 1 : 0) - (b.tag ? 1 : 0) ||
        b.version - a.version);
    return parsed.map(p => p.name);
}

async function getCandidateModels(apiKey, requestedModel, signal) {
    const primary = resolveGeminiModel(requestedModel);
    const available = await listGeminiModels(apiKey, signal);
    if (!available) {
        // (2.5 Flash / Pro answer only keys that used them before; lite models produce bad Khmer)
        return [primary, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.1-pro-preview']
            .filter((v, i, a) => a.indexOf(v) === i);
    }
    const ranked = rankGeminiFallbacks(available);
    const list = available.has(primary) ? [primary, ...ranked] : ranked;
    if (!available.has(primary) && !geminiModelListCache.get(apiKey).warned) {
        geminiModelListCache.get(apiKey).warned = true;
        console.warn(`[Gemini] Model "${primary}" is not available for this key. Using: ${list[0] || 'none'}`);
    }
    const unique = list.filter((v, i, a) => a.indexOf(v) === i);
    const top = unique.slice(0, 4);
    // Each model has its own daily allowance per key, and the ranking puts every Flash model
    // first - so with many Flash models the Pro allowance was never reached. Always offer the
    // newest Pro model as a fallback.
    const bestPro = unique.filter(m => /-pro\b/.test(m))
        .sort((a, b) => parseFloat((b.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0) - parseFloat((a.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0))[0];
    if (bestPro && !top.includes(bestPro)) top.push(bestPro);
    return top;
}

async function fetchWithTimeout(url, options, parentSignal, timeoutMs) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (parentSignal) {
        if (parentSignal.aborted) ctrl.abort();
        else parentSignal.addEventListener('abort', onAbort, { once: true });
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try {
        // Read the body here too, so the timeout and the user's Stop also cover a slow or
        // dropped body download (not just the headers).
        const res = await secureFetch(url, { ...options, signal: ctrl.signal });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
    } catch (e) {
        if (timedOut) {
            const err = new Error(`Gemini did not respond within ${Math.round(timeoutMs / 1000)}s`);
            err.code = 'TIMEOUT';
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
        if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
    }
}

// Models that answered "JSON mode is not enabled for this model": they get the request without
// responseMimeType/responseSchema. Every prompt also asks for JSON in words, and the parsers
// (parseJsonArrayLoose) read it from plain text.
const geminiNoJsonModeModels = new Set();
// ...and of those, the ones whose plain reply had no JSON at all (e.g. an audio "transcribe" model
// answering with a bare transcript). They are skipped for JSON requests from then on.
const geminiNoJsonOutputModels = new Set();
// apiKey|model -> when it answered 404 (gone, renamed, or not open to this key). Asked again
// after a while, in case Google opens it.
const geminiGoneModels = new Map();
const GEMINI_GONE_MS = 6 * 60 * 60 * 1000;
function isGeminiModelGone(apiKey, m) {
    const at = geminiGoneModels.get(`${apiKey}|${m}`);
    if (at && Date.now() - at < GEMINI_GONE_MS) return true;
    if (at) geminiGoneModels.delete(`${apiKey}|${m}`);
    return false;
}
const isJsonModeUnsupported = (msg) => /JSON mode is not enabled|response_?mime_?type|response_?schema/i.test(String(msg || ''));

// Thinking tokens are billed as output. Text jobs that follow clear rules (translate, shorten, the
// character sheet) ask for little of it: Gemini 3 by level, 2.5 by budget (2.5 Pro can't go below
// 128); older and unknown models are sent nothing. A model that refuses the setting gets the
// request again without it, and is remembered.
const geminiNoThinkingConfigModels = new Set();
function geminiThinkingConfig(model, level) {
    const m = String(model || '').match(/^gemini-(\d+(?:\.\d+)?)-(flash-lite|flash|pro)\b/);
    if (!m || !level) return null;
    const version = parseFloat(m[1]);
    if (version >= 3) return { thinkingLevel: level };
    if (version >= 2.5) return { thinkingBudget: m[2] === 'pro' ? 128 : 0 };
    return null;
}

// Token use of one reply, from Gemini's usageMetadata or an OpenAI-style usage (CodeCraft), added
// into a job's running total: { requests, input, cached, output, thinking }.
function createTokenUsage() {
    return { requests: 0, input: 0, cached: 0, output: 0, thinking: 0 };
}
function addTokenUsage(acc, result) {
    if (!acc || !result || !result.success) return acc;
    acc.requests++;
    const g = result.json && result.json.usageMetadata;
    const o = result.usage;
    if (g) {
        acc.input += g.promptTokenCount || 0;
        acc.cached += g.cachedContentTokenCount || 0;
        acc.output += g.candidatesTokenCount || 0;
        acc.thinking += g.thoughtsTokenCount || 0;
    } else if (o) {
        const reasoning = (o.completion_tokens_details && o.completion_tokens_details.reasoning_tokens) || 0;
        acc.input += o.prompt_tokens || 0;
        acc.cached += (o.prompt_tokens_details && o.prompt_tokens_details.cached_tokens) || 0;
        acc.output += Math.max(0, (o.completion_tokens || 0) - reasoning);
        acc.thinking += reasoning;
    }
    return acc;
}
function formatTokenUsage(u) {
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    return `${u.requests} request(s), input ${k(u.input)}${u.cached ? ` (${k(u.cached)} cached)` : ''}, output ${k(u.output)}${u.thinking ? ` + ${k(u.thinking)} thinking` : ''} tokens`;
}

// The first JSON array/object in a model's free-text reply: the whole text, a ```json fence
// anywhere, or a balanced [...] / {...} inside prose. Brackets in prose ("[Male]") don't parse
// and are skipped. An array cut off mid-way (MAX_TOKENS) keeps its complete items. undefined
// when there's none.
function extractJsonValue(raw) {
    const s = String(raw || '').trim();
    const tryParse = (t) => { try { const v = JSON.parse(t); return v && typeof v === 'object' ? v : undefined; } catch (e) { return undefined; } };
    let v = tryParse(s);
    if (v !== undefined) return v;
    for (const m of s.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
        v = tryParse(m[1].trim());
        if (v !== undefined) return v;
    }
    for (let start = 0; start < s.length; start++) {
        const open = s[start];
        if (open !== '[' && open !== '{') continue;
        let depth = 0, inStr = false, esc = false, lastItemEnd = -1;
        for (let i = start; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') inStr = true;
            else if (c === '[' || c === '{') depth++;
            else if (c === ']' || c === '}') {
                if (--depth === 0) {
                    v = tryParse(s.slice(start, i + 1));
                    if (v !== undefined) return v;
                    break;
                }
                if (depth === 1 && c === '}') lastItemEnd = i;
            }
        }
        if (depth > 0 && open === '[' && lastItemEnd > start) {
            v = tryParse(s.slice(start, lastItemEnd + 1) + ']');
            if (v !== undefined) return v;
        }
    }
    return undefined;
}

// Global state / caches for module (can be wired with external keyRest via factory)
let defaultKeyRest = null;
function getDefaultKeyRest() {
    if (!defaultKeyRest) {
        if (typeof keyRest !== 'undefined' && keyRest) return keyRest;
        const { KEY_REST_FILE, KEY_REST_LEGACY_FILES } = require('../lib/paths');
        defaultKeyRest = createKeyRest({ file: KEY_REST_FILE, legacyFiles: KEY_REST_LEGACY_FILES });
    }
    return defaultKeyRest;
}

// Daily/minute limits are per key AND per model: "key|model" -> { until, daily, msg }. A model that
// hit its limit is skipped until it resets, while the key's other models keep working.
let geminiModelCooldowns = (typeof keyRest !== 'undefined' && keyRest ? keyRest : getDefaultKeyRest()).modelLimits;

// Google's 503 "high demand" (or no answer in time) is a model overloaded for everyone, not one
// key's limit: model -> { at, strikes }. While it rests, requests ask the models that are
// answering first instead of every part asking the busy one again and waiting. Each time it is
// busy again its rest doubles (1, 2, 4, 8, then 10 min) - a model that stays overloaded for an
// hour no longer costs every part a 503 or a hung request; one answer clears it.
const geminiBusyModels = new Map();
const GEMINI_BUSY_MEMORY_MS = 60 * 1000;
const GEMINI_BUSY_MAX_MS = 10 * 60 * 1000;
function geminiBusyRestMs(strikes) {
    return Math.min(GEMINI_BUSY_MAX_MS, GEMINI_BUSY_MEMORY_MS * 2 ** Math.max(0, strikes - 1));
}
function isGeminiModelBusy(m) {
    const b = geminiBusyModels.get(m);
    return !!b && Date.now() - b.at < geminiBusyRestMs(b.strikes);
}
function markGeminiModelBusy(m) {
    const b = geminiBusyModels.get(m);
    geminiBusyModels.set(m, { at: Date.now(), strikes: Math.min(10, (b ? b.strikes : 0) + 1) });
}
function markGeminiModelAnswering(m) {
    geminiBusyModels.delete(m);
}
// A model whose rest is over is tried again by ONE request: it counts as busy for everyone else
// (same rest again) until that request answers - many parts at once don't all test it.
function claimGeminiModelProbe(m) {
    const b = geminiBusyModels.get(m);
    if (b && !isGeminiModelBusy(m)) b.at = Date.now();
}

// Google's 429 body says exactly which limit was hit and how long to wait:
//   details: [{ '@type': '...QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
//             { '@type': '...RetryInfo', retryDelay: '55s' }]
// The message text doesn't always say "per day", so the details are read first.
function parseGeminiQuotaError(errData, errMsg) {
    const details = Array.isArray(errData?.error?.details) ? errData.error.details : [];
    const quotaIds = [];
    let retryMs = null;
    for (const d of details) {
        for (const v of (Array.isArray(d?.violations) ? d.violations : [])) if (v && v.quotaId) quotaIds.push(String(v.quotaId));
        if (d && typeof d.retryDelay === 'string' && isFinite(parseFloat(d.retryDelay))) retryMs = Math.ceil(parseFloat(d.retryDelay) * 1000);
    }
    if (retryMs === null) {
        // "Please retry in 33.2s" or, for a daily limit, "Please retry in 20h3m39.5s".
        const m = /retry in\s*(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?/i.exec(errMsg || '');
        if (m && (m[1] || m[2] || m[3])) retryMs = Math.ceil(((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (parseFloat(m[3]) || 0)) * 1000);
    }
    // A daily limit can still come with a short retryDelay; quotaCooldownUntil only trusts long ones.
    const daily = quotaIds.some(id => /PerDay/i.test(id)) || /per\s*-?day|daily quota|requests per day/i.test(errMsg || '');
    return { daily, retryMs, quotaIds };
}

// Google's daily quotas reset at midnight Pacific time.
function msUntilPacificMidnight(now = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' })
        .formatToParts(new Date(now));
    const get = (t) => +((parts.find(p => p.type === t) || {}).value || 0);
    const sinceMidnightMs = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000;
    return Math.max(60 * 1000, 24 * 3600 * 1000 - sinceMidnightMs);
}

// Google's 429 can name the per-day quota while its own usage page shows the project
// far below that limit (seen: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" on
// every key with RPD at 2/20). Parking the key until midnight on the first such answer
// sidelined the whole pool for hours, so recheck after 15 min, then 1 h, and only
// trust it until the reset once Google repeats it three times in a row.
const DAILY_RECHECK_MS = [15 * 60 * 1000, 60 * 60 * 1000];
// `${key}|${model}` -> { count, at }; kept on disk (key-rest), so a restart doesn't start over.
let geminiDailyStrikes = (typeof keyRest !== 'undefined' && keyRest ? keyRest : getDefaultKeyRest()).dailyStrikes;
// key -> when Google last answered it (any answer that says how the key stands: an answer, a
// limit, a refusal - not "busy"). Settings shows a key not answered since the daily reset as
// "Not checked today" instead of "Ready".
let geminiKeyAnswered = (typeof keyRest !== 'undefined' && keyRest ? keyRest : getDefaultKeyRest()).answered;
const noteKeyAnswered = (key) => { if (key) geminiKeyAnswered.set(key, Date.now()); };

function dailyCooldownUntil(strikeKey, now = Date.now()) {
    const prev = geminiDailyStrikes.get(strikeKey);
    const count = prev && now - prev.at < 6 * 60 * 60 * 1000 ? prev.count + 1 : 1;
    geminiDailyStrikes.set(strikeKey, { count, at: now });
    const untilReset = now + msUntilPacificMidnight(now) + 60 * 1000;
    return count <= DAILY_RECHECK_MS.length ? Math.min(untilReset, now + DAILY_RECHECK_MS[count - 1]) : untilReset;
}

function quotaCooldownUntil(quota, now = Date.now(), strikeKey = null) {
    // Google states when the daily window frees up ("Please retry in 20h3m39s" - a rolling
    // window, not midnight Pacific). When it gives a long wait, that is the answer.
    if (quota.daily && quota.retryMs != null && quota.retryMs > 10 * 60 * 1000) return now + quota.retryMs + 60 * 1000;
    if (quota.daily) return strikeKey ? dailyCooldownUntil(strikeKey, now) : now + msUntilPacificMidnight(now) + 60 * 1000;
    const wait = quota.retryMs != null ? quota.retryMs : RATE_LIMIT_COOLDOWN_MS;
    return now + Math.min(2 * 60 * 1000, Math.max(5000, wait)) + 500;
}

function formatWait(ms) {
    const min = Math.ceil(ms / 60000);
    if (ms < 60 * 1000) return `${Math.max(1, Math.ceil(ms / 1000))}s`;
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

// stayOnModel: only the requested model (or the best one this key has, if it lacks it). A
// rate-limited model then comes back as a rate limit the caller waits out, instead of the
// request moving to another model - for transcription, where another model splits the
// dialogue differently (fewer, longer lines).
// timeoutMs: how long one attempt may take before it counts as a dead connection.
// thinking: 'low' asks for little thinking (geminiThinkingConfig) - text jobs only.
// onlyModel: ask exactly requestedModel, no other (Check limits, which asks each model in turn).
async function executeGeminiGenerate(apiKey, requestedModel, payload, signal, { stayOnModel = false, timeoutMs = GEMINI_ATTEMPT_TIMEOUT_MS, thinking = null, onlyModel = false } = {}) {
    apiKey = String(apiKey || '').trim();
    if (typeof isGeminiWebKey === 'function' && isGeminiWebKey(apiKey)) {
        const ctx = keyAttemptContext && keyAttemptContext.getStore();
        const r = await geminiWeb().generate(apiKey, payload, signal, { timeoutMs: Math.max(timeoutMs || 0, 10 * 60 * 1000), noWait: !!(ctx && ctx.apiBackup) });
        if (r && (r.success || r.status < 500)) noteKeyAnswered(apiKey);
        return r;
    }
    if (onlyModel) stayOnModel = false; // the fallbacks that stayOnModel adds would ask other models
    const listed = onlyModel ? [resolveGeminiModel(requestedModel)] : await getCandidateModels(apiKey, requestedModel, signal);
    // A model that answered 404 for this key is left out (unless nothing else is left).
    const reachable = listed.filter(m => !isGeminiModelGone(apiKey, m));
    const allModels = reachable.length ? reachable : listed;
    const body = JSON.stringify(payload);
    const gen = payload && payload.generationConfig;
    const plainBody = gen && (gen.responseMimeType || gen.responseSchema)
        ? JSON.stringify({ ...payload, generationConfig: (({ responseMimeType, responseSchema, ...rest }) => rest)(gen) })
        : body;
    // The body for one model: plain-JSON mode if it needs it, and its own thinking setting.
    const bodyFor = (m) => {
        const base = geminiNoJsonModeModels.has(m) ? plainBody : body;
        const tc = thinking && !geminiNoThinkingConfigModels.has(m) ? geminiThinkingConfig(m, thinking) : null;
        if (!tc) return base;
        const p = JSON.parse(base);
        p.generationConfig = { ...(p.generationConfig || {}), thinkingConfig: tc };
        return JSON.stringify(p);
    };
    // Models already known not to return JSON can't serve a JSON request. With
    // stayOnModel, staying on such a model meant every request failed with "No
    // usable Gemini model" (e.g. gemini-3.5-transcribe, which has no JSON mode and
    // answered the plain-text retry with nothing), so move to the next usable one.
    const usableModels = plainBody !== body ? allModels.filter(m => !geminiNoJsonOutputModels.has(m)) : allModels;
    if (stayOnModel && usableModels[0] && usableModels[0] !== allModels[0]) {
        console.warn(`[Gemini] ${allModels[0]} can't return JSON for this request - using ${usableModels[0]} instead`);
    }
    // stayOnModel waits out a per-minute limit on the chosen model, but a model that is out
    // for the DAY on this key won't come back for hours (Google: "retry in 20h"). Each model
    // has its own daily allowance, so use the next one instead of stopping the whole job.
    const dailyOut = (m) => { const c = geminiModelCooldowns.get(`${apiKey}|${m}`); return !!(c && c.daily && c.until > Date.now()); };
    const stayPool = usableModels.filter(m => !dailyOut(m));
    let firstChoice = stayOnModel ? (stayPool.length ? stayPool : usableModels)[0] : allModels[0];
    // Models Google just said are busy go last (still tried if every model is busy).
    const candidateModels = stayOnModel ? [firstChoice].filter(Boolean)
        : [...allModels.filter(m => !isGeminiModelBusy(m)), ...allModels.filter(isGeminiModelBusy)];

    let primaryError = null; // first meaningful error, reported to the user
    let sawRateLimit = false;
    let sawOverload = false;
    let networkFailures = 0;
    let rateLimitMsg = '';
    let keyFreeAt = Infinity; // soonest time one of this key's rate-limited models is free again
    let allDaily = true;      // every rate-limited model is out for the day (not just the minute)

    for (let idx = 0; idx < candidateModels.length; idx++) {
        const m = candidateModels[idx];
        if (plainBody !== body && geminiNoJsonOutputModels.has(m)) continue;
        const cooldown = geminiModelCooldowns.get(`${apiKey}|${m}`);
        if (cooldown && cooldown.until > Date.now()) {
            sawRateLimit = true;
            if (!rateLimitMsg) rateLimitMsg = cooldown.msg;
            keyFreeAt = Math.min(keyFreeAt, cooldown.until);
            allDaily = allDaily && !!cooldown.daily;
            continue;
        }
        claimGeminiModelProbe(m);
        // Transient server errors (500/503 "overloaded") get one retry on the same model.
        for (let attempt = 0; attempt < 2; attempt++) {
            if (signal && signal.aborted) {
                const err = new Error('Aborted'); err.name = 'AbortError'; throw err;
            }
            let res;
            const sentAt = Date.now(); // see the 429 below: was this key+model resting already?
            try {
                const proxy = getDRRouterProxyForKey(apiKey);
                const fetchOpts = {
                    method: 'POST',
                    // Key in a header, not the URL: URLs end up in proxy logs and error messages.
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                    body: bodyFor(m)
                };
                if (proxy) fetchOpts.proxy = proxy;
                res = await fetchWithTimeout(`${GEMINI_API_BASE}/models/${m}:generateContent`, fetchOpts, signal, timeoutMs);
            } catch (fetchErr) {
                if (fetchErr.name === 'AbortError' && signal && signal.aborted) throw fetchErr;
                if (fetchErr.code === 'TIMEOUT') {
                    // No answer in time over a working connection: Google is busy on this model.
                    // Mark it busy, record the overload, and break to try the next candidate model immediately.
                    markGeminiModelBusy(m);
                    console.warn(`[Gemini] ${m}: ${fetchErr.message} - Google is busy, trying next candidate model`);
                    sawOverload = true;
                    if (!primaryError) primaryError = { status: 503, code: 'OVERLOADED', error: `${m} timed out - Google is busy`, message: `${m}: Google is busy` };
                    break;
                }
                const cause = fetchErr.cause && (fetchErr.cause.code || fetchErr.cause.message);
                const msg = fetchErr.code === 'TIMEOUT'
                    ? fetchErr.message
                    : `Cannot reach Google Gemini (${cause || fetchErr.message}). Check your internet connection / VPN / firewall.`;
                console.warn(`[Gemini] ${m} network error:`, msg);
                if (!primaryError) primaryError = { status: 503, code: 'NETWORK_ERROR', error: msg, message: msg };
                // A dead network is not model-specific: stop after two failures instead
                // of cycling every model.
                if (++networkFailures >= 2) return { success: false, ...primaryError };
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }

            // Google answered (not "busy"): the key's state is known today.
            if (res.status < 500) noteKeyAnswered(apiKey);
            if (res.ok) {
                geminiDailyStrikes.delete(`${apiKey}|${m}`);
                let json;
                try { json = JSON.parse(res.text); } catch (e) {
                    // Truncated/garbled body: same handling as a network blip.
                    const msg = 'Gemini response was cut off. Check your internet connection.';
                    console.warn(`[Gemini] ${m}: unreadable response body (${res.text.length} bytes)`);
                    if (!primaryError) primaryError = { status: 503, code: 'NETWORK_ERROR', error: msg, message: msg };
                    if (++networkFailures >= 2) return { success: false, ...primaryError };
                    continue;
                }
                const cand = json?.candidates?.[0];
                const text = (cand?.content?.parts || []).map(p => p.text || '').join('');
                if (!text && (json?.promptFeedback?.blockReason || cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT')) {
                    const reason = json?.promptFeedback?.blockReason || cand?.finishReason;
                    if (!primaryError) primaryError = { status: 422, code: 'CONTENT_BLOCKED', error: `Gemini blocked this content (${reason}).`, message: `Gemini blocked this content (${reason}).` };
                    break; // try next model
                }
                if (geminiNoJsonModeModels.has(m) && plainBody !== body) {
                    // Plain-mode reply to a JSON request: hand callers clean JSON, as JSON mode would.
                    const value = extractJsonValue(text);
                    if (value === undefined) {
                        geminiNoJsonOutputModels.add(m);
                        console.warn(`[Gemini] ${m} replied without JSON - skipping it for JSON requests from now on. Reply began: ${text.slice(0, 200)}`);
                        if (!primaryError) primaryError = { status: 502, error: `${m} did not return the requested JSON.`, message: `${m} did not return the requested JSON. Reply began: ${text.slice(0, 160)}` };
                        // stayOnModel offered only this model: try the next usable one now instead of failing the chunk.
                        if (stayOnModel) {
                            const next = allModels.find(x => !geminiNoJsonOutputModels.has(x) && !candidateModels.includes(x));
                            if (next) candidateModels.push(next);
                        }
                        break; // next model
                    }
                    const clean = JSON.stringify(value);
                    if (cand && cand.content) cand.content.parts = [{ text: clean }];
                    markGeminiModelAnswering(m);
                    return { success: true, json, text: clean, finishReason: cand?.finishReason, modelUsed: m, fellBack: m !== firstChoice };
                }
                markGeminiModelAnswering(m);
                return { success: true, json, text, finishReason: cand?.finishReason, modelUsed: m, fellBack: m !== firstChoice };
            }

            let errData = {};
            try { errData = JSON.parse(res.text); } catch (e) { }
            const errMsg = errData?.error?.message || `HTTP ${res.status}`;
            if (res.status !== 429) console.warn(`[Gemini] ${m} returned ${res.status}: ${errMsg}`); // 429 logs one short line below

            if (res.status === 400 && /API_KEY_INVALID|API key not valid|API key expired/i.test(errMsg)) {
                return { success: false, status: 400, error: 'INVALID_API_KEY', message: errMsg };
            }
            // 401 "bound service account is deleted or disabled": the key is dead, not the model.
            if (res.status === 403 || res.status === 401) {
                return { success: false, status: res.status, error: 'INVALID_API_KEY', message: errMsg };
            }
            if (res.status === 400 && /payload size|exceeds the limit|too large/i.test(errMsg)) {
                return { success: false, status: 413, code: 'AUDIO_TOO_LARGE', error: `Audio is too large for Gemini: ${errMsg}`, message: errMsg };
            }
            if (res.status === 404) {
                // Model gone/renamed, or closed to this key (Google gives the 2.5 models only to
                // keys that used them before: "no longer available to new users"). Remembered,
                // so the next requests don't ask it first. stayOnModel offered only this model:
                // the best one the key has takes its place (and counts as the chosen one, so its
                // results aren't redone as a fallback's).
                geminiGoneModels.set(`${apiKey}|${m}`, Date.now());
                console.warn(`[Gemini] ${m} is not available to key …${apiKey.slice(-4)} - not asking it again for this key`);
                if (stayOnModel) {
                    const next = usableModels.find(x => !candidateModels.includes(x) && !isGeminiModelGone(apiKey, x) && !dailyOut(x));
                    if (next) {
                        candidateModels.push(next);
                        if (m === firstChoice) firstChoice = next;
                    }
                }
                break;
            }
            if (res.status === 400 && thinking && /thinking/i.test(errMsg) && !geminiNoThinkingConfigModels.has(m) && geminiThinkingConfig(m, thinking)) {
                geminiNoThinkingConfigModels.add(m);
                console.warn(`[Gemini] ${m} refused the thinking setting - asking it again without one`);
                attempt--; // not a transient failure: don't use up the retry
                continue;
            }
            if (res.status === 400 && isJsonModeUnsupported(errMsg)) {
                if (plainBody !== body && !geminiNoJsonModeModels.has(m)) {
                    geminiNoJsonModeModels.add(m);
                    console.warn(`[Gemini] ${m} has no JSON mode - retrying it with plain-text JSON`);
                    attempt--; // not a transient failure: don't use up the retry
                    continue;
                }
                break; // model can't do this request: next model, and don't mask the real error (e.g. quota)
            }
            if (res.status === 429) {
                // A limit answer to a request sent while this key+model was already resting means
                // something asked it anyway (the check at the top of the loop is meant to stop that).
                // One sent before the rest began was simply already on its way - normal with many tabs.
                const prior = geminiModelCooldowns.get(`${apiKey}|${m}`);
                if (prior && prior.until > sentAt && (prior.at || 0) < sentAt) {
                    console.warn(`[Gemini] ${m} on key …${apiKey.slice(-4)} was asked while resting (rest set ${Math.round((sentAt - prior.at) / 1000)}s before this request) - please report`);
                }
                sawRateLimit = true;
                if (!rateLimitMsg) rateLimitMsg = errMsg;
                const quota = parseGeminiQuotaError(errData, errMsg);
                const until = quotaCooldownUntil(quota, Date.now(), `${apiKey}|${m}`);
                // Google's own wording names the metric and the limit it applied; keep it for diagnosis.
                if (quota.daily) console.warn(`[Gemini] Google's 429 for ${m} on key …${apiKey.slice(-4)}: ${String(errMsg).replace(/\s+/g, ' ').slice(0, 400)}`);
                geminiModelCooldowns.set(`${apiKey}|${m}`, { until, daily: quota.daily, msg: errMsg });
                keyFreeAt = Math.min(keyFreeAt, until);
                allDaily = allDaily && quota.daily;
                console.warn(`[Gemini] ${m} on key …${apiKey.slice(-4)}: ${quota.daily ? 'daily quota used up' : 'per-minute limit'}` +
                    ` (${quota.quotaIds[0] || 'quota'}) - skipping it for ${formatWait(until - Date.now())}`);
                if (stayOnModel && quota.daily) {
                    const next = usableModels.find(x => !dailyOut(x) && !candidateModels.includes(x));
                    if (next) {
                        console.warn(`[Gemini] ${m} is out for the day on key …${apiKey.slice(-4)} - continuing with ${next}`);
                        candidateModels.push(next);
                    }
                }
                break; // the key's other models have their own limits
            }
            // 503 "high demand" / overloaded: switch straight to the next model. The caller
            // backs off and retries if every model is busy.
            if (res.status === 503 || /high demand|overloaded|UNAVAILABLE/i.test(errMsg)) {
                sawOverload = true;
                markGeminiModelBusy(m);
                if (!primaryError) primaryError = { status: 503, code: 'OVERLOADED', error: errMsg, message: errMsg };
                break;
            }
            if (!primaryError) primaryError = { status: res.status, error: errMsg, message: errMsg };
            if (res.status >= 500 && attempt === 0) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            break;
        }
    }

    if (sawRateLimit && !sawOverload && (!primaryError || primaryError.code === 'NETWORK_ERROR')) {
        // Google's per-day quota (free tier: as low as 20 requests/day/model) reads as the
        // same HTTP 429 as a per-minute burst limit, but it won't clear in seconds - it won't
        // clear until the daily window rolls over. Flag it so the caller stops burning more
        // requests (across every model, every retry) on a key that's done for the day.
        const isDailyQuota = allDaily && isFinite(keyFreeAt);
        const retryAfterMs = isFinite(keyFreeAt) ? Math.max(0, keyFreeAt - Date.now()) : RATE_LIMIT_COOLDOWN_MS;
        return {
            success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED', isDailyQuota, retryAfterMs,
            message: isDailyQuota
                ? `Google reports the daily free Gemini quota used up for key …${apiKey.slice(-4)} - checking again in ${formatWait(retryAfterMs)}.`
                : `Key …${apiKey.slice(-4)} is rate-limited by Google - free again in ${formatWait(retryAfterMs)}.`
        };
    }
    // Busy, and this key's other models are out of their limit (e.g. the free tier's 20 requests
    // a day per model): another key may still have those models - tryKeysOnce asks it.
    const otherModelsLimited = sawOverload && sawRateLimit;
    return { success: false, ...(primaryError || { status: 500, error: 'No usable Gemini model for this API key.', message: 'No usable Gemini model for this API key.' }), ...(otherModelsLimited ? { otherModelsLimited } : {}) };
}

// ── Text AI provider (Settings → API → "Translate subtitles with") ──────────
// Text-only jobs (translate, Fix Missing's re-translation, shorten/rewrite, names, titles) can go
// to CodeCraft instead of Google. The app sends the choice to /api/text-ai at start and on every
// change. The CodeCraft keys then go first in those jobs' key list, with the Gemini keys after
// them. Several CodeCraft keys share the work: each job starts on the least busy one and a
// translation's lanes are spread over them. A CodeCraft key that is rejected, out of credit or
// rate-limited is skipped like a bad Gemini key (the other CodeCraft keys first, then Gemini).
// Audio (Direct transcription and its gap checks) always uses Gemini.
const codecraft = createCodeCraftClient({ fetch: secureFetch, extractJsonValue });
const CODECRAFT_LANES_PER_KEY = 4; // requests one translate job sends at once per CodeCraft key
const textAi = {
    provider: 'gemini', keys: [], model: '', backupModel: '',
    issues: new Map(), // CodeCraft key -> { at, message, outOfCredit } (rejected / no credit)
    okAt: new Map()    // CodeCraft key -> last time it answered
};

function codecraftActive() {
    return textAi.provider === 'codecraft' && textAi.keys.length > 0 && !!textAi.model;
}
function isCodeCraftKey(key) {
    return !!key && (textAi.keys.includes(key) || /^cc_/i.test(key));
}
// The CodeCraft keys, least busy first (requests running right now, across every job).
function codecraftKeysByLoad() {
    return textAi.keys
        .map((k, i) => ({ k, i, busy: geminiKeyInFlight.get(k) || 0 }))
        .sort((a, b) => a.busy - b.busy || a.i - b.i)
        .map(x => x.k);
}
function getDRRouterKeys() {
    const keys = [];
    try {
        const { getDRRouterManager } = require('../lib/dr-router');
        keys.push(...getDRRouterManager().keysForDubber());
    } catch (e) {}
    // Gemini Web Router: each ready Gmail is a "gweb:<id>" key (lib/gemini-web-router.js).
    try { keys.push(...geminiWeb().keysForDubber()); } catch (e) {}
    return keys;
}
function geminiWeb() { return require('../lib/gemini-web-router').getGeminiWebRouter(); }
function isGeminiWebKey(key) { return typeof key === 'string' && key.startsWith('gweb:'); }
// "Router first" (Gemini Web Router page, on by default): the Gmails go before every other key
// and a job gets one lane per Gmail; API keys stay as backups, used when a Gmail is busy with
// another job, out of credits or signed out.
function geminiWebFirst() {
    try { return geminiWeb().settings().routerFirst !== false; } catch (e) { return false; }
}
function orderPool(keys) {
    if (!geminiWebFirst()) return keys;
    const web = keys.filter(isGeminiWebKey);
    if (!web.length) return keys;
    // "Gmails only" (router page): no API key while a Gmail is there - a job waits for a free
    // Gmail instead. With no Gmail at all (none signed in) the API keys still do the work.
    let gmailOnly = false;
    try { gmailOnly = geminiWeb().settings().gmailOnly === true; } catch (e) { }
    return gmailOnly ? web : [...web, ...keys.filter(k => !isGeminiWebKey(k))];
}
function webLaneCount(keys) {
    return geminiWebFirst() ? keys.filter(isGeminiWebKey).length : 0;
}
// Set around each key attempt (tryKeysOnce): whether a non-Gmail key is there to fall back to.
// Only then does a busy Gmail say "busy" at once instead of queueing the request.
// (Tests run parts of this file with no `require`: then there is simply no context.)
const keyAttemptContext = typeof require === 'function' ? new (require('async_hooks').AsyncLocalStorage)() : null;
const getDaPoolKeys = getDRRouterKeys;

// DR Router Fast mode: transcribe every chunk at once (one chunk per key) and skip API saver's
// big chunks, trading some requests for speed when the pool has keys to spare.
function drRouterFastMode() {
    try {
        const { getDRRouterManager } = require('../lib/dr-router');
        return !!getDRRouterManager().fastMode;
    } catch (e) { return false; }
}

// Count a pool key's live requests so the DR Router dashboard shows them in flight.
function notifyDRRouterInFlight(key, delta) {
    try {
        const { getDRRouterManager } = require('../lib/dr-router');
        const acc = getDRRouterManager().findByKey(key);
        if (acc) getDRRouterManager().trackInFlight(acc.id, delta);
    } catch (e) {}
}

function notifyDRRouterSuccess(key) {
    try {
        const { getDRRouterManager } = require('../lib/dr-router');
        const dr = getDRRouterManager();
        const acc = dr.accounts.find(a => a.apiKey === key);
        if (acc) dr.markSuccess(acc.id);
    } catch (e) {}
}
const notifyDaPoolSuccess = notifyDRRouterSuccess;

function notifyDRRouterRateLimited(key, waitMs) {
    try {
        const { getDRRouterManager } = require('../lib/dr-router');
        const dr = getDRRouterManager();
        const acc = dr.accounts.find(a => a.apiKey === key);
        if (acc) dr.markRateLimited(acc.id, waitMs);
    } catch (e) {}
}
const notifyDaPoolRateLimited = notifyDRRouterRateLimited;

// dead: Google says the key itself is bad (retired). Otherwise (e.g. a 403 for region or a
// disabled API) the pool account only rests for restMs, like the key does here.
function notifyDRRouterInvalid(key, msg, dead = true, restMs = undefined) {
    try {
        const { getDRRouterManager } = require('../lib/dr-router');
        const dr = getDRRouterManager();
        const acc = dr.accounts.find(a => a.apiKey === key);
        if (acc) {
            if (dead) dr.markInvalid(acc.id, msg);
            else dr.markRejected(acc.id, msg, restMs);
        }
    } catch (e) {}
}
const notifyDaPoolInvalid = notifyDRRouterInvalid;

// enabled: false for jobs that must stay on Gemini (the re-translation inside Direct transcription).
function textKeys(geminiKeys, enabled = true) {
    const rawKeys = Array.isArray(geminiKeys) ? geminiKeys : (geminiKeys ? [geminiKeys] : []);
    const drKeys = getDRRouterKeys();
    const combined = rawKeys.filter(Boolean).length ? [...rawKeys, ...drKeys] : drKeys;
    const keys = orderPool(combined.map(k => String(k || '').trim()).filter((k, i, a) => k && a.indexOf(k) === i));
    if (!(enabled && codecraftActive())) return keys;
    return [...codecraftKeysByLoad(), ...keys.filter(k => !textAi.keys.includes(k))];
}
// Lane n's key order: its own key first, the others as backups - the CodeCraft keys (rotated)
// always before the Gemini keys (rotated).
function textLaneKeys(keys, lane) {
    const rotate = (list) => (list.length ? [...list.slice(lane % list.length), ...list.slice(0, lane % list.length)] : list);
    const cc = keys.filter(isCodeCraftKey);
    return [...rotate(cc), ...rotate(keys.filter(k => !isCodeCraftKey(k)))];
}
function textLaneCount(keys) {
    const cc = keys.filter(isCodeCraftKey).length;
    return cc ? cc * CODECRAFT_LANES_PER_KEY : (webLaneCount(keys) || keys.length);
}

// executeGeminiGenerate for text-only jobs: a CodeCraft key goes to CodeCraft (with the model
// chosen in Settings, not the Gemini one), any other key to Google.
async function generateText(key, model, payload, signal, opts = {}) {
    if (!isCodeCraftKey(key)) return executeGeminiGenerate(key, model, payload, signal, opts);
    // opts.thinking is a Gemini setting; CodeCraft's models take the request as it is.
    const r = await codecraft.generate({
        key, model: textAi.model, backupModel: textAi.backupModel, payload, signal,
        timeoutMs: opts.timeoutMs || GEMINI_ATTEMPT_TIMEOUT_MS, preferBackup: !!opts.preferBackup
    });
    if (r.success) {
        textAi.issues.delete(key);
        textAi.okAt.set(key, Date.now());
        if (r.fellBack) console.warn(`[CodeCraft] ${textAi.model} failed - answered by backup model ${r.modelUsed}`);
    } else {
        console.warn(`[CodeCraft] key …${key.slice(-4)}: ${r.message || r.error}`);
        if (r.code === 'PROVIDER_KEY') textAi.issues.set(key, { at: Date.now(), message: r.message, outOfCredit: !!r.outOfCredit });
    }
    return r;
}

// For routes that were given a single Gemini key: with CodeCraft or pool/Gmail keys active,
// try the full pool with that Gemini key as backup; otherwise the direct single-key call.
async function generateTextForKey(apiKey, model, payload, signal, opts = {}) {
    const keys = textKeys([apiKey]);
    if (!codecraftActive() && keys.length <= 1 && keys[0] === String(apiKey || '').trim()) {
        return executeGeminiGenerate(apiKey, model, payload, signal, opts);
    }
    const out = await tryKeysOnce(keys, async (key) => {
        const r = await generateText(key, model, payload, signal, opts);
        return r.success ? { ok: true, r } : { ok: false, result: r };
    });
    return out.ok ? out.r : out.result;
}

// A CodeCraft key problem (rejected, no credit) seen since `since`: the app shows it, because the
// job itself still finished on the other keys.
function textAiNotice(since) {
    const fresh = [...textAi.issues.values()].filter(x => x.at >= since);
    if (!fresh.length) return undefined;
    return `${fresh.map(x => x.message).join(' ')} The job carried on with your other keys.`;
}

// What one CodeCraft key can do right now, for the key list in Settings. probe: the answer of a
// model-list request just made with it (proves the key is accepted; credit only shows on use).
function codecraftKeyStatus(key, probe) {
    const now = Date.now();
    if (probe && !probe.success) {
        return { state: probe.status === 401 || probe.status === 403 ? 'refused' : 'error', message: probe.error };
    }
    const issue = textAi.issues.get(key);
    if (issue && isGeminiKeyInvalid(key)) return { state: issue.outOfCredit ? 'no-credit' : 'refused', message: issue.message };
    const parked = rateLimitedGeminiKeys.get(key);
    if (parked && parked.until > now) return { state: 'cooling', retryAfterMs: parked.until - now };
    if (probe || textAi.okAt.has(key)) return { state: 'ok' };
    return { state: 'unknown' };
}

// ── Khmer Dubbing & Subtitle Dialogue Engine ──────────────────────────
function sanitizeKhmerDialogue(text) {
    if (!text || typeof text !== 'string') return '';
    let cleaned = text
        // Strip zero-width and invisible control characters
        .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
        // Normalize whitespace
        .replace(/[ \t]+/g, ' ')
        .trim();

    // Strip robotic formal question start "តើ" if directly preceding spoken pronouns or verbs
    cleaned = cleaned
        .replace(/^តើ\s*(?=(?:ឯង|បង|អូន|លោក|នាង|អ្នក|យើង|ពួកយើង|ពួកឯង|មាន|កើត|ធ្វើ|ទៅ|មក|មែន|ចង់|អាច|គួរ|ស្មាន|ម៉េច|ណា|នរណា|ហេតុ|អី|ប៉ុន្មាន|យ៉ាង|ពិត|ដឹង|ឮ|ឃើញ))/u, '')
        // Fix excessive punctuation
        .replace(/\?{2,}/g, '?')
        .replace(/!{2,}/g, '!')
        .replace(/\.{4,}/g, '...')
        .trim();
    return cleaned;
}

function applyGlossary(text, glossary) {
    if (!text || !glossary) return text;
    let result = text;
    if (typeof glossary === 'object' && !Array.isArray(glossary)) {
        for (const [key, val] of Object.entries(glossary)) {
            if (key && val && typeof key === 'string' && typeof val === 'string') {
                const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                result = result.replace(new RegExp(escaped, 'gi'), val);
            }
        }
    } else if (Array.isArray(glossary)) {
        for (const item of glossary) {
            if (item && item.from && item.to) {
                const escaped = item.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                result = result.replace(new RegExp(escaped, 'gi'), item.to);
            }
        }
    }
    return result;
}

// 4. Transcription & Gemini Speech-to-Text Pipeline
const TRANSCRIBE_CHUNK_TARGET_SEC = 180;
const TRANSCRIBE_SINGLE_MAX_SEC = 240;
const SAVER_CHUNK_TARGET_SEC = 540;
const SAVER_SINGLE_MAX_SEC = 600;
const TRANSCRIBE_MAX_LANES = 24;
const transcribeProgress = new Map(); // requestId -> { done, total }
const activeTranscribeRequests = new Map(); // requestId -> AbortController
const TRANSCRIBE_EMOTIONS = ['Neutral', 'Angry', 'Sad', 'Whisper', 'Excited', 'Royal', 'Romantic', 'Fear'];
const TRANSCRIBE_RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            start: { type: 'STRING' },
            end: { type: 'STRING' },
            text: { type: 'STRING' },
            originalText: { type: 'STRING' },
            speaker: { type: 'STRING' },
            gender: { type: 'STRING', enum: ['Male', 'Female'] },
            emotion: { type: 'STRING', enum: TRANSCRIBE_EMOTIONS }
        },
        required: ['start', 'end', 'text', 'originalText', 'speaker', 'gender'],
        propertyOrdering: ['start', 'end', 'originalText', 'text', 'speaker', 'gender', 'emotion']
    }
};

let _getFFmpegBinary = require('../ffmpeg_env').getFFmpegBinary;
let _getFFprobeBinary = require('../ffmpeg_env').getFFprobeBinary;

function runFFmpegCapture(args, signal) {
    return new Promise((resolve, reject) => {
        const proc = spawn(_getFFmpegBinary(), args, { windowsHide: true });
        trackProcess(proc);
        let stderr = '';
        const onAbort = () => { try { proc.kill('SIGKILL'); } catch (e) { } };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('error', reject);
        proc.on('close', code => {
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve({ code, stderr });
        });
    });
}

async function probeAudioDuration(file) {
    const { stderr } = await runFFmpegCapture(['-hide_banner', '-i', file]);
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
}

async function detectSilences(file, signal) {
    const { stderr } = await runFFmpegCapture(
        ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-35dB:d=0.3', '-f', 'null', '-'], signal);
    const silences = [];
    let pendingStart = null;
    for (const line of stderr.split('\n')) {
        const s = line.match(/silence_start:\s*(-?[\d.]+)/);
        if (s) { pendingStart = Math.max(0, parseFloat(s[1])); continue; }
        const e = line.match(/silence_end:\s*([\d.]+)/);
        if (e && pendingStart !== null) {
            silences.push({ start: pendingStart, end: parseFloat(e[1]) });
            pendingStart = null;
        }
    }
    return silences;
}

// Cut near every TARGET seconds, snapped to the middle of the closest pause so we
// never slice through a word.
function planTranscribeChunks(totalSec, silences, { singleMax = TRANSCRIBE_SINGLE_MAX_SEC, target: targetSec = TRANSCRIBE_CHUNK_TARGET_SEC } = {}) {
    const chunks = [];
    let cursor = 0;
    while (cursor < totalSec) {
        const target = cursor + targetSec;
        if (totalSec - cursor <= singleMax) {
            chunks.push({ start: cursor, end: totalSec });
            return chunks;
        }
        let best = null, bestDist = Infinity;
        for (const s of silences) {
            const mid = (s.start + s.end) / 2;
            if (mid <= cursor + 30 || mid >= cursor + singleMax) continue;
            const dist = Math.abs(mid - target);
            if (dist < bestDist) { bestDist = dist; best = { mid, dur: s.end - s.start }; }
        }
        const cut = best ? best.mid : target;
        chunks.push({ start: cursor, end: cut });
        cursor = cut;
    }
    chunks.push({ start: cursor, end: totalSec });
    return chunks;
}

function parseTimestampSeconds(val) {
    if (val === undefined || val === null) return NaN;
    if (typeof val === 'number') return val;
    const str = String(val).trim().replace(',', '.');
    if (!str.includes(':')) return parseFloat(str.replace(/[^0-9.]/g, ''));
    const parts = str.split(':').map(p => parseFloat(p) || 0);
    return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function formatTimestamp(sec) {
    const s = Math.max(0, sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = (s % 60).toFixed(2).padStart(5, '0');
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${rest}`;
}

// Accepts fenced JSON, {subtitles:[...]} wrappers, and arrays truncated by MAX_TOKENS.
function parseJsonArrayLoose(raw) {
    const v = extractJsonValue(raw);
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.subtitles)) return v.subtitles;
    return null;
}

function buildTranscribePrompt({ clipSec, glossaryHint, genreGuidance, previousLines, video = false }) {
    const clipLen = clipSec > 0 ? clipSec.toFixed(1) : null;
    const contextHint = previousLines && previousLines.length
        ? `\n\nPREVIOUS DIALOGUE (context only, for consistent names and pronouns; do NOT repeat these lines):\n${previousLines.map(l => `- [${l.gender || '?'}] ${l.originalText || ''} => ${l.text}`).join('\n')}`
        : '';
    return `You are an elite master film/TV dialogue adapter and dubbing director specializing in Asian and Chinese drama (C-Drama: 古装/宫斗/仙侠/武侠/现代甜宠/总裁/动作) localization into cinematic, natural and highly readable Khmer.

TASK:
Listen to the audio carefully and transcribe and translate all spoken dialogue into NATURAL, SPEAKABLE Khmer lines for professional voice dubbing, each one taking about as long to say as the original line.

${KHMER_DUBBING_RULES}
${glossaryHint}${contextHint}

TIMESTAMPS & ACTING RULES:
1. Exact Timestamps:
   - "start" and "end" are measured from the start of THIS audio clip (00:00.00). Format: MM:SS.ss.${clipLen ? `\n   - This clip is ${clipLen} seconds long. No timestamp may exceed ${clipLen}.` : ''}
   - "start" is the exact moment the speaker's voice begins; "end" is the moment it stops. Never pad into silence or music.
   - One subtitle per utterance (usually 1 to 4 seconds). Start a new line whenever the speaker changes. Never put two speakers in one line.
   - Lines must be in chronological order and must not overlap.

2. What to include:
   - Only real spoken dialogue and narration. Skip background music, song lyrics, sound effects, breathing, and crowd noise.
   - Never invent, summarize, or skip dialogue. If the clip has no speech, return [].
   - "originalText" is the exact words spoken in the original language.
   - Size each "text" to its own start-to-end duration: about ${KHMER_SYLLABLES_PER_SEC} Khmer syllables per second (a 2-second line is about ${Math.round(2 * KHMER_SYLLABLES_PER_SEC)} syllables).
   - "text" is written in Khmer script only: never leave a word in Chinese or put in a word from any other language or script (Arabic, Thai, Japanese...). Write names and places in Khmer letters.

3. Speaker, Gender & Emotion:
   - speaker: WHO says this line, so each character keeps one voice through the whole series. A character on the CHARACTER SHEET: their name exactly as written there in the original language (e.g. 赵淑芬), the name before "=" even when the line calls them another way the sheet lists ("also written"). Anyone else: a short role in the original language that stays the same for that person in every line (母亲, 助理, 司机, 记者...). "?" only when it truly cannot be told. Work it out from the voice and the scene: a line calling "妈" is spoken TO the mother, by her child; "韩总，..." is said to 韩总, not by him. Never use a title several people can share as the name (韩总 can be any 韩 in charge): name the person, or an unnamed family member by role (韩父, 韩母).${video ? `
   - You also see the picture: the speaker is the person whose mouth moves (or who the camera shows talking) during the line; the same face and the same voice is the same person in every line. A voice heard from off screen or a phone is whoever is on the other end, not the person shown.` : ''}
   - gender: "Male" or "Female" - the gender of the voice actually speaking this line. Judge by the voice you hear, not by who is being talked about.
   - emotion: "Neutral", "Angry", "Sad", "Whisper", "Excited", "Royal", "Romantic", "Fear".${genreGuidance}

4. Output Format:
   - Output ONLY a valid JSON array of objects with the exact schema below. No markdown, no extra text.

SCHEMA:
[
  {
    "start": "00:00.00",
    "end": "00:02.50",
    "originalText": "Original spoken dialogue",
    "text": "Natural Khmer line sized to start-end",
    "speaker": "韩峥",
    "gender": "Male",
    "emotion": "Neutral"
  }
]`;
}

// ── Cast pictures: one character, one name, in every episode ──
const CAST_FRAMES = 2;
const CAST_MAX_PEOPLE = 12;

function seriesCastParts(dir, speakers, sheet) {
    const named = new Set(normalizeSheet(sheet).characters.map(c => c.name));
    const people = [];
    for (const s of speakers || []) {
        const files = (s.frames || []).map(f => path.join(dir || '', f)).filter(f => dir && fs.existsSync(f)).slice(0, CAST_FRAMES);
        if (files.length) people.push({ s, files });
    }
    if (!people.length) return [];
    people.sort((a, b) => (named.has(b.s.name) - named.has(a.s.name)) || ((b.s.lines || 0) - (a.s.lines || 0)));
    const parts = [{ text: 'CAST - people already voiced in earlier episodes of this series. Each picture was taken while that person was speaking (someone else may be in it too: the person shown in all of their pictures is them). Someone in this clip who looks like one of them IS that character: write their name as "speaker", even when the dialogue only calls them by a title.' }];
    for (const { s, files } of people.slice(0, CAST_MAX_PEOPLE)) {
        parts.push({ text: `${s.name} (${s.gender}):` });
        for (const f of files) parts.push({ inlineData: { mimeType: 'image/jpeg', data: fs.readFileSync(f).toString('base64') } });
    }
    return parts;
}

async function captureCastFrames({ video, cues, dir, speakers }) {
    if (!dir) return false;
    let added = false;
    for (const s of speakers || []) {
        const have = (s.frames || []).filter(f => fs.existsSync(path.join(dir, f)));
        if (have.length >= CAST_FRAMES) continue;
        const lines = (cues || []).filter(c => c.speaker === s.name && c._end - c._start >= 1.0)
            .sort((a, b) => (b._end - b._start) - (a._end - a._start)).slice(0, CAST_FRAMES - have.length);
        for (const c of lines) {
            fs.mkdirSync(dir, { recursive: true });
            const file = `${crypto.createHash('md5').update(s.name).digest('hex').slice(0, 12)}_${Date.now().toString(36)}_${have.length}.jpg`;
            const { code } = await runFFmpegCapture(['-hide_banner', '-y', '-ss', ((c._start + c._end) / 2).toFixed(2), '-i', video,
                '-frames:v', '1', '-vf', 'scale=-2:320', '-q:v', '6', path.join(dir, file)]);
            if (code === 0 && fs.existsSync(path.join(dir, file))) {
                have.push(file);
                added = true;
            }
        }
        s.frames = have;
    }
    return added;
}

// Transcribe one clip; returns cues with times relative to the clip start.
async function transcribeClipWithGemini({ apiKey, model, audioBase64, mimeType, clipSec, promptOpts, signal, stayOnModel = false, timeoutMs = GEMINI_ATTEMPT_TIMEOUT_MS }) {
    const payload = {
        contents: [{
            role: 'user',
            parts: [
                ...((promptOpts && promptOpts.castParts) || []),
                { inlineData: { mimeType, data: audioBase64 } },
                { text: buildTranscribePrompt({ ...promptOpts, clipSec }) }
            ]
        }],
        generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: TRANSCRIBE_RESPONSE_SCHEMA,
            maxOutputTokens: 32768
        }
    };

    const usage = promptOpts && promptOpts.usage;
    if (typeof isGeminiWebKey === 'function' && isGeminiWebKey(apiKey)) return transcribeClipWithGeminiWeb({ apiKey, payload, audioBase64, mimeType, clipSec, signal, timeoutMs, usage });
    let lastRaw = '';
    let lowAnswer = null; // the low-thinking answer, if the normal-thinking try does no better
    for (let attempt = 0; attempt < 2; attempt++) {
        const thinking = attempt === 0 ? 'low' : null;
        const result = await executeGeminiGenerate(apiKey, model, payload, signal, { stayOnModel, timeoutMs, thinking });
        if (!result.success) return lowAnswer ? { ...lowAnswer, truncated: true } : { ok: false, result };
        addTokenUsage(usage, result);
        lastRaw = result.text || '';
        const items = parseJsonArrayLoose(lastRaw);
        if (items) {
            const truncated = !!result.finishReason && result.finishReason !== 'STOP';
            const answer = { ok: true, items, raw: lastRaw, modelUsed: result.modelUsed, fellBack: !!result.fellBack, truncated };
            if (thinking && looksIncomplete(items, clipSec, truncated)) {
                console.warn(`[Transcribe] Low-thinking reply looks incomplete (${items.length} line(s) for ${Math.round(clipSec)}s${truncated ? `, ended with ${result.finishReason}` : ''}) - asking again with normal thinking`);
                lowAnswer = answer;
                continue;
            }
            if (lowAnswer && items.length < lowAnswer.items.length && !(lowAnswer.truncated && !truncated)) return lowAnswer;
            if (truncated) console.warn(`[Transcribe] Reply ended with ${result.finishReason}; kept complete lines only.`);
            return answer;
        }
        console.error('[Transcribe] Unparseable Gemini output:', lastRaw.slice(0, 500));
    }
    if (lowAnswer) return { ...lowAnswer, truncated: true };
    return { ok: false, result: { status: 502, error: 'Gemini returned an unreadable transcript. Please try again.', message: `Gemini returned an unreadable transcript. Please try again. Reply began: ${lastRaw.slice(0, 160)}` }, raw: lastRaw };
}

// Gemini Web Router: the website writes the lines but guesses their times (seconds off), so
// while it works the PC hears the same clip and each line gets the time of its own Chinese
// characters (lib/gemini-web-timing.js). Without the VoxCPM2 install the website's times stay.
const gwebTimelineCache = new Map(); // clipHash -> Promise<timeline>
async function transcribeClipWithGeminiWeb({ apiKey, payload, audioBase64, mimeType, clipSec, signal, timeoutMs, usage }) {
    const timing = require('../lib/gemini-web-timing');
    // Router first / multiple Gmails: a Gmail busy with another job hands this clip to the next
    // free Gmail (or API backup) at once, before any PC timing is started for it.
    const ctx = keyAttemptContext && keyAttemptContext.getStore();
    if (ctx && (ctx.apiBackup || ctx.hasAlternativeKey)) {
        const busy = geminiWeb().busyResult(apiKey);
        if (busy) return { ok: false, result: busy };
    }
    let timelineP = null;
    if (timing.available()) {
        const clipHash = crypto.createHash('md5').update(audioBase64).digest('hex');
        timelineP = gwebTimelineCache.get(clipHash) || null;
        if (!timelineP) {
            const ext = /video/.test(mimeType || '') ? '.mp4' : /wav/.test(mimeType || '') ? '.wav' : /ogg/.test(mimeType || '') ? '.ogg' : '.mp3';
            const clipFile = path.join(require('os').tmpdir(), `gweb_clip_${crypto.randomBytes(5).toString('hex')}${ext}`);
            fs.writeFileSync(clipFile, Buffer.from(audioBase64, 'base64'));
            timelineP = timing.timelineFor(clipFile, { ffmpeg: _getFFmpegBinary() })
                .catch((e) => {
                    gwebTimelineCache.delete(clipHash);
                    console.warn(`[Transcribe] PC timing failed, keeping Gemini Web's own times: ${e.message}`);
                    return null;
                })
                .finally(() => fs.promises.unlink(clipFile).catch(() => {}));
            if (gwebTimelineCache.size >= 24) gwebTimelineCache.delete(gwebTimelineCache.keys().next().value);
            gwebTimelineCache.set(clipHash, timelineP);
        }
    }
    // The website's answers vary: now and then it skips half the clip (seen: 13 lines where the
    // next try gave 35). The PC heard the clip too, so an answer covering under 75% of the speech
    // it heard is asked once more, and the fuller answer is kept.
    let best = null;
    let lastFailure = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await executeGeminiGenerate(apiKey, null, payload, signal, { timeoutMs });
        if (!result.success) { lastFailure = { ok: false, result }; break; }
        addTokenUsage(usage, result);
        const raw = result.text || '';
        const parsed = parseJsonArrayLoose(raw);
        if (!parsed) {
            console.error('[Transcribe] Unparseable Gemini Web output:', raw.slice(0, 500));
            lastFailure = { ok: false, result: { status: 502, error: 'Gemini Web returned an unreadable transcript.', message: `Gemini Web returned an unreadable transcript. Reply began: ${raw.slice(0, 160)}` }, raw };
            continue;
        }
        const timeline = timelineP ? await timelineP : null;
        let items = parsed;
        let coverage = null;
        if (timeline && timeline.length) {
            const retimed = timing.retimeLines(parsed, timeline);
            coverage = retimed.coverage;
            const byPc = retimed.filter(l => l.timedBy === 'pc').length;
            items = retimed.map(({ gStart, gEnd, timedBy, ...l }) => l);
            console.log(`[Transcribe] Gemini Web (${result.gweb && result.gweb.email}): ${items.length} line(s) in ${((result.gweb && result.gweb.ms) || 0) / 1000}s, covering ${Math.round(coverage * 100)}% of the speech; times from the PC for ${byPc}`);
        }
        const answer = { ok: true, items, raw, modelUsed: result.modelUsed || 'gemini-web', fellBack: false, truncated: false, coverage };
        if (!best || (coverage != null && coverage > (best.coverage || 0)) || (coverage == null && items.length > best.items.length)) best = answer;
        const short = coverage != null ? coverage < 0.75 : looksIncomplete(items, clipSec, false);
        if (!short) break;
        if (attempt === 0) console.warn(`[Transcribe] Gemini Web answer looks incomplete (${items.length} line(s)${coverage != null ? `, ${Math.round(coverage * 100)}% of the speech` : ''}) - asking again`);
    }
    if (best) { delete best.coverage; return best; }
    return lastFailure;
}

function looksIncomplete(items, clipSec, truncated) {
    if (truncated) return true;
    return clipSec > 90 && items.length < clipSec / 60;
}

function normalizeClipCues(items, offsetSec, clipSec, glossary) {
    const cues = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        let text = sanitizeKhmerDialogue(item.text || '');
        if (glossary) text = applyGlossary(text, glossary);
        if (!text && !String(item.originalText || '').trim()) continue;
        let start = parseTimestampSeconds(item.start);
        let end = parseTimestampSeconds(item.end);
        if (!isFinite(start)) continue;
        if (clipSec > 0) start = Math.min(Math.max(0, start), clipSec);
        if (!isFinite(end) || end <= start) end = start + 2;
        if (clipSec > 0) end = Math.min(end, clipSec + 0.3);
        cues.push({
            ...item,
            text,
            originalText: item.originalText ? String(item.originalText).trim() : (item.original || undefined),
            _start: offsetSec + start,
            _end: offsetSec + end
        });
    }
    return cues;
}

function finalizeCues(cues) {
    cues.sort((a, b) => a._start - b._start);
    for (let i = 0; i < cues.length - 1; i++) {
        const next = cues[i + 1];
        if (cues[i]._end > next._start) cues[i]._end = Math.max(cues[i]._start + 0.3, next._start);
    }
    return cues.map(({ _start, _end, ...rest }) => ({
        ...rest,
        start: formatTimestamp(_start),
        end: formatTimestamp(_end)
    }));
}

// Worth waiting and retrying: Google busy/rate-limited, a network blip, or garbled output.
function isTransientGeminiFailure(result) {
    if (!result) return false;
    return result.error === 'RATE_LIMIT_EXCEEDED' || result.code === 'OVERLOADED' ||
        result.code === 'NETWORK_ERROR' || Number(result.status) >= 500;
}
const GEMINI_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];
function geminiRetryLimit(result) {
    if (result && result.isDailyQuota) return 0;
    return result && result.code === 'NETWORK_ERROR' ? 1 : GEMINI_RETRY_DELAYS_MS.length;
}

const GEMINI_BUSY_RETRY_BUDGET_MS = 30 * 60 * 1000;
const GEMINI_BUSY_MAX_WAIT_MS = 30 * 1000;
function isGeminiBusy(result) {
    return !!result && result.code !== 'NETWORK_ERROR' && (result.code === 'OVERLOADED' || result.code === 'GWEB_BUSY' || result.code === 'GWEB_SIGNED_OUT' || Number(result.status) === 503);
}

function geminiShouldRetry(result, otherRetries, startedAt, busyBudgetMs = GEMINI_BUSY_RETRY_BUDGET_MS) {
    if (!isTransientGeminiFailure(result)) return false;
    if (isGeminiBusy(result)) return Date.now() - startedAt < busyBudgetMs;
    return otherRetries < geminiRetryLimit(result);
}

function sleepAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

const transcribeChunkCache = new Map(); // key -> { at, out }
const TRANSCRIBE_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
function transcribeCacheKey(clipBase64, parts) {
    return crypto.createHash('sha1').update(clipBase64).update(JSON.stringify(parts)).digest('hex');
}
function transcribeCacheGet(key) {
    const hit = transcribeChunkCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > TRANSCRIBE_CACHE_TTL_MS) { transcribeChunkCache.delete(key); return null; }
    return hit.out;
}
function transcribeCacheSet(key, out) {
    if (transcribeChunkCache.size >= 500) transcribeChunkCache.delete(transcribeChunkCache.keys().next().value);
    transcribeChunkCache.set(key, { at: Date.now(), out });
}

function geminiFailureResponse(res, result) {
    const code = result.error === 'RATE_LIMIT_EXCEEDED' || result.error === 'INVALID_API_KEY' ? result.error : null;
    return res.status(result.status || 500).json({
        success: false,
        status: result.status || 500,
        error: code || result.error || result.message || 'GENERATION_FAILED',
        message: result.message || result.error,
        isDailyQuota: !!result.isDailyQuota,
        retryAfterMs: result.retryAfterMs != null ? result.retryAfterMs : undefined
    });
}

// ── Missing-dialogue repair ──────────────────────────────────────────────────
const KHMER_CHAR_RE = /[ក-៿]/;
const REPAIR_GAP_SEC = 20;
const REPAIR_MAX_GAPS = 40;
const REPAIR_WINDOW_MAX_SEC = 180;
const REPAIR_TRANSLATE_BATCH = 40;
const REPAIR_GAP_BUDGET_MS = 2 * 60 * 1000;
const REPAIR_BUSY_BUDGET_MS = 3 * 60 * 1000;

function cueNeedsTranslation(cue) {
    const text = String(cue.text || '').trim();
    const original = String(cue.originalText || '').trim();
    if (!original) return false;
    return !text || !KHMER_CHAR_RE.test(text) || text === original || hasForeignText(text);
}

function findDialogueGaps(cues, totalSec) {
    const sorted = [...cues].sort((a, b) => a._start - b._start);
    const gaps = [];
    let cursor = 0;
    for (const c of sorted) {
        if (c._start - cursor >= REPAIR_GAP_SEC) gaps.push({ start: cursor, end: c._start });
        cursor = Math.max(cursor, c._end);
    }
    if (totalSec - cursor >= REPAIR_GAP_SEC) gaps.push({ start: cursor, end: totalSec });
    const windows = [];
    for (const g of gaps) {
        for (let s = g.start; s < g.end - 1; s += REPAIR_WINDOW_MAX_SEC) {
            windows.push({ start: Math.max(0, s - 0.5), end: Math.min(g.end + 0.5, s + REPAIR_WINDOW_MAX_SEC) });
        }
    }
    return windows;
}

async function silentFraction(file, start, dur, signal) {
    const { stderr } = await runFFmpegCapture(['-hide_banner', '-nostats', '-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', file,
        '-vn', '-af', 'silencedetect=noise=-38dB:d=0.4', '-f', 'null', '-'], signal);
    let silent = 0, open = null;
    for (const line of stderr.split('\n')) {
        const s = line.match(/silence_start:\s*(-?[\d.]+)/);
        if (s) { open = Math.max(0, parseFloat(s[1])); continue; }
        const e = line.match(/silence_end:\s*([\d.]+)/);
        if (e && open !== null) { silent += parseFloat(e[1]) - open; open = null; }
    }
    if (open !== null) silent += dur - open;
    return dur > 0 ? Math.min(1, silent / dur) : 1;
}

// chunk would otherwise hit it again). A key Google says is dead (invalid, expired, its service
// account deleted) rests a day - it never comes back by itself - unless it is added again in
// Settings; any other refusal (403, a CodeCraft key out of credit) rests 10 minutes.
let invalidGeminiKeys = (typeof keyRest !== 'undefined' && keyRest ? keyRest : getDefaultKeyRest()).invalid; // key -> { until, dead, message }
const INVALID_KEY_REST_MS = 10 * 60 * 1000;
const DEAD_KEY_REST_MS = 24 * 60 * 60 * 1000;
function isDeadKeyAnswer(key, result) {
    return !isCodeCraftKey(key) && !!result && result.error === 'INVALID_API_KEY' && (Number(result.status) === 400 || Number(result.status) === 401);
}
// Keys that just got a 429 are skipped for a cooldown too. Without this, every
// concurrent lane/chunk/retry keeps trying that same key first (it's always first in
// its own rotation) and piling fresh requests onto a key that's already over quota,
// instead of going straight to a key that isn't. This is what actually gets chunk 1
// off key 1 and onto key 2 quickly when there are multiple keys in play.
let rateLimitedGeminiKeys = (typeof keyRest !== 'undefined' && keyRest ? keyRest : getDefaultKeyRest()).keyLimits; // key -> { until, daily }
const RATE_LIMIT_COOLDOWN_MS = 20 * 1000;
function isGeminiKeyInvalid(key) {
    const e = invalidGeminiKeys.get(key);
    return !!(e && e.until > Date.now());
}
function isGeminiKeyCooling(key) {
    const parked = rateLimitedGeminiKeys.get(key);
    return !!(parked && parked.until > Date.now());
}
function usableGeminiKeys(keys) {
    const notInvalid = keys.filter(k => !isGeminiKeyInvalid(k));
    if (!notInvalid.length) return keys;
    return notInvalid.filter(k => !isGeminiKeyCooling(k));
}

function keysCoolingResult(keys) {
    const now = Date.now();
    const parked = keys.map(k => rateLimitedGeminiKeys.get(k)).filter(p => p && p.until > now);
    const isDailyQuota = parked.length > 0 && parked.every(p => p.daily);
    const retryAfterMs = parked.length ? Math.max(0, Math.min(...parked.map(p => p.until)) - now) : RATE_LIMIT_COOLDOWN_MS;
    const n = keys.length;
    const message = isDailyQuota
        ? `Google reports the daily free Gemini quota used up on all ${n} API key(s). The app checks again in ${formatWait(retryAfterMs)}` +
          '. ' +
          'To continue now: pick another Gemini model (each has its own daily limit), or add a key from another Google project.'
        : `All ${n} API key(s) are rate-limited by Google - free again in ${formatWait(retryAfterMs)}.`;
    return { ok: false, result: { success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED', isDailyQuota, retryAfterMs, message } };
}

function geminiRetryWaitMs(result, retry) {
    if (result && result.error === 'RATE_LIMIT_EXCEEDED' && result.retryAfterMs != null) {
        return Math.min(90 * 1000, Math.max(2000, result.retryAfterMs + 500));
    }
    const wait = GEMINI_RETRY_DELAYS_MS[Math.min(retry, GEMINI_RETRY_DELAYS_MS.length - 1)];
    return isGeminiBusy(result) ? Math.min(wait, GEMINI_BUSY_MAX_WAIT_MS) : wait;
}

// checkedToday: Google answered this key since its last daily reset (midnight Pacific), so
// "ok" means ready - not just "no limit seen" (another computer may have used the key up).
function geminiKeyStatus(key) {
    const now = Date.now();
    const answeredAt = geminiKeyAnswered.get(key) || null;
    const lastReset = now - (24 * 3600 * 1000 - msUntilPacificMidnight(now));
    const known = { answeredAt, checkedToday: !!answeredAt && answeredAt >= lastReset };
    if (isGeminiKeyInvalid(key)) {
        const e = invalidGeminiKeys.get(key);
        return { state: 'invalid', dead: !!e.dead, message: e.message || '', retryAfterMs: e.until - now, ...known };
    }
    const models = [];
    for (const [id, c] of geminiModelCooldowns) {
        if (!id.startsWith(`${key}|`) || !(c.until > now)) continue;
        models.push({ model: id.slice(key.length + 1), daily: !!c.daily, retryAfterMs: c.until - now });
    }
    const parked = rateLimitedGeminiKeys.get(key);
    if (parked && parked.until > now) {
        return { state: parked.daily ? 'daily' : 'cooling', retryAfterMs: parked.until - now, models, ...known };
    }
    return { state: models.length ? 'partial' : 'ok', models, ...known };
}

const geminiKeyInFlight = new Map();

function pickNextGeminiKey(keys, tried) {
    const usable = usableGeminiKeys(keys).filter(k => !tried.has(k));
    if (!usable.length) return null;
    if (usable[0] === keys[0]) return keys[0];
    const sameKind = usable.filter(k => isCodeCraftKey(k) === isCodeCraftKey(keys[0]));
    const candidates = sameKind.length ? sameKind : usable;
    let best = candidates[0];
    for (const k of candidates) {
        if ((geminiKeyInFlight.get(k) || 0) < (geminiKeyInFlight.get(best) || 0)) best = k;
    }
    return best;
}

async function tryKeysOnce(keys, call) {
    let transientOut = null, lastOut = null;
    if (!usableGeminiKeys(keys).length) return keysCoolingResult(keys);
    const tried = new Set();
    for (let key = pickNextGeminiKey(keys, tried); key; key = pickNextGeminiKey(keys, tried)) {
        tried.add(key);
        geminiKeyInFlight.set(key, (geminiKeyInFlight.get(key) || 0) + 1);
        if (typeof notifyDRRouterInFlight === 'function') notifyDRRouterInFlight(key, 1);
        let out;
        try {
            // (Guarded like the DR Router hooks: tests run this block without the Gemini Web parts.)
            const attempt = typeof keyAttemptContext !== 'undefined' && keyAttemptContext && typeof isGeminiWebKey === 'function'
                ? { apiBackup: usableGeminiKeys(keys).some(k => !isGeminiWebKey(k) && !tried.has(k)) } : null;
            out = attempt ? await keyAttemptContext.run(attempt, () => call(key)) : await call(key);
        } finally {
            const left = (geminiKeyInFlight.get(key) || 1) - 1;
            if (left > 0) geminiKeyInFlight.set(key, left); else geminiKeyInFlight.delete(key);
            if (typeof notifyDRRouterInFlight === 'function') notifyDRRouterInFlight(key, -1);
        }
        if (out.ok) {
            if (typeof notifyDRRouterSuccess === 'function') notifyDRRouterSuccess(key);
            else if (typeof notifyDaPoolSuccess === 'function') notifyDaPoolSuccess(key);
            return out;
        }
        lastOut = out;
        if (out.result && (out.result.error === 'INVALID_API_KEY' || out.result.code === 'PROVIDER_KEY')) {
            const dead = isDeadKeyAnswer(key, out.result);
            if (typeof notifyDRRouterInvalid === 'function') notifyDRRouterInvalid(key, out.result.message || '', dead, INVALID_KEY_REST_MS);
            else if (typeof notifyDaPoolInvalid === 'function') notifyDaPoolInvalid(key, out.result.message || '');
            invalidGeminiKeys.set(key, { until: Date.now() + (dead ? DEAD_KEY_REST_MS : INVALID_KEY_REST_MS), dead, message: out.result.message || '' });
            console.warn(`[Gemini] key …${String(key).slice(-4)} rejected (${out.result.message || 'invalid'}); ${dead ? 'not used for a day (adding it again in Settings tries it sooner)' : 'skipping it'}`);
            continue;
        }
        if (out.result && out.result.code === 'NETWORK_ERROR') return out;
        if (out.result && (out.result.code === 'OVERLOADED' || Number(out.result.status) === 503)) {
            // A 503 is the model overloaded for everyone, not this key's fault: the pool account
            // stays ready (parking it only shrank the pool for the next jobs). The key already
            // asked every model, so the next key would only ask the same busy models again (seen:
            // 15 keys x 3 models in a row, 10 min for one 2-minute clip) - the caller waits and
            // asks again instead. Unless this key's other models are out of quota: another key
            // may still have them.
            if (!out.result.otherModelsLimited) return out;
            if (!transientOut || transientOut.result.error === 'RATE_LIMIT_EXCEEDED') transientOut = out;
            continue;
        }
        if (isTransientGeminiFailure(out.result)) {
            if (out.result.error === 'RATE_LIMIT_EXCEEDED') {
                const daily = !!out.result.isDailyQuota;
                const waitMs = out.result.retryAfterMs != null ? out.result.retryAfterMs : RATE_LIMIT_COOLDOWN_MS;
                if (typeof notifyDRRouterRateLimited === 'function') notifyDRRouterRateLimited(key, waitMs);
                else if (typeof notifyDaPoolRateLimited === 'function') notifyDaPoolRateLimited(key, waitMs);
                rateLimitedGeminiKeys.set(key, { until: Date.now() + waitMs, daily });
                console.warn(`[Gemini] key …${String(key).slice(-4)} ${daily ? 'used up its daily quota' : 'rate-limited'}; parked for ${formatWait(waitMs)}, trying the next key`);
            }
            if (!transientOut || transientOut.result.error === 'RATE_LIMIT_EXCEEDED') transientOut = out;
            continue;
        }
        return out;
    }
    if (transientOut && transientOut.result.error === 'RATE_LIMIT_EXCEEDED' && !usableGeminiKeys(keys).length) {
        return keysCoolingResult(keys);
    }
    return transientOut || lastOut;
}

async function geminiWithKeys(keys, call, signal, { retries = 2, busyBudgetMs = 0 } = {}) {
    let out = null;
    const startedAt = Date.now();
    let otherRetries = 0;
    for (let retry = 0; ; retry++) {
        out = await tryKeysOnce(keys, call);
        if (out.ok || !isTransientGeminiFailure(out.result)) return out;
        const busy = busyBudgetMs > 0 && isGeminiBusy(out.result);
        if (busy ? Date.now() - startedAt >= busyBudgetMs : otherRetries >= Math.min(retries, geminiRetryLimit(out.result))) return out;
        await sleepAbortable(geminiRetryWaitMs(out.result, busy ? retry : otherRetries), signal);
        if (!busy) otherRetries++;
    }
}

async function retranslateCues(targets, allCues, { keys, model, promptOpts, glossary, signal }) {
    let fixed = 0;
    for (let b = 0; b < targets.length; b += REPAIR_TRANSLATE_BATCH) {
        const batch = targets.slice(b, b + REPAIR_TRANSLATE_BATCH);
        const lines = batch.map(({ cue, index }) => {
            const around = (from, to) => allCues.slice(Math.max(0, from), Math.max(0, to))
                .map(c => `${c.originalText || ''}${c.text && KHMER_CHAR_RE.test(c.text) ? ` => ${c.text}` : ''}`).filter(Boolean);
            return { i: index, text: cue.originalText, ...(cue.gender && { gender: cue.gender }), context: [...around(index - 2, index), '>>> THIS LINE <<<', ...around(index + 1, index + 3)].join(' | ') };
        });
        const payload = {
            systemInstruction: { parts: [{ text: buildTranslateSystemPrompt({ genreGuidance: promptOpts.genreGuidance }) }] },
            contents: [{ role: 'user', parts: [{ text: buildTranslateUserPrompt({
                lines, glossaryHint: promptOpts.glossaryHint, sheetHint: promptOpts.sheetHint, previousLines: [],
                note: 'Each line has a "context" field with the neighbouring dialogue - use it only to understand the meaning; translate only "text".'
            }) }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: TRANSLATE_RESPONSE_SCHEMA, maxOutputTokens: 16384 }
        };
        const out = await geminiWithKeys(keys, async (key) => {
            const r = await generateText(key, model, payload, signal, { timeoutMs: GEMINI_TEXT_TIMEOUT_MS, thinking: 'low' });
            return r.success ? { ok: true, items: parseJsonArrayLoose(r.text) || [] } : { ok: false, result: r };
        }, signal, { busyBudgetMs: REPAIR_BUSY_BUDGET_MS });
        if (!out.ok) return { fixed, error: out.result };
        const byIndex = new Map(out.items.map(it => [Number(it && it.i), it]));
        for (const { cue, index } of batch) {
            const it = byIndex.get(index);
            if (!it) continue;
            let clean = sanitizeKhmerDialogue(it.text || '');
            if (glossary) clean = applyGlossary(clean, glossary);
            if (!clean || !KHMER_CHAR_RE.test(clean)) continue;
            cue.text = clean;
            if (!cue.speaker && it.speaker) cue.speaker = it.speaker;
            if (!cue.gender && it.gender) cue.gender = it.gender;
            if (!cue.emotion && it.emotion) cue.emotion = it.emotion;
            cue._repaired = 'translated';
            fixed++;
        }
    }
    return { fixed };
}

async function repairTranscript({ cues, sourceFile, totalSec, keys, model, promptOpts, glossary, workDir, signal, progress, checkGaps = true, stayOnModel = false, maxLanes = TRANSCRIBE_MAX_LANES, useTextAi = false }) {
    const report = { gapsFound: 0, gapsChecked: 0, linesAdded: 0, retranslated: 0, stillUntranslated: 0 };

    if (checkGaps && sourceFile && totalSec > 0) {
        const windows = findDialogueGaps(cues, totalSec).slice(0, REPAIR_MAX_GAPS);
        report.gapsFound = windows.length;
        const toCheck = [];
        for (const w of windows) {
            if (signal && signal.aborted) break;
            if ((await silentFraction(sourceFile, w.start, w.end - w.start, signal)) > 0.85) continue;
            toCheck.push(w);
        }
        const setGapNote = () => {
            if (progress && toCheck.length) progress.note = `Double-checking ${toCheck.length} stretch(es) with no subtitles for missed dialogue (${report.gapsChecked}/${toCheck.length})…`;
        };
        setGapNote();
        const existing = [...cues];
        const budgetEnd = Date.now() + REPAIR_GAP_BUDGET_MS;
        let next = 0;
        const worker = async (lane) => {
            const laneKeys = [...keys.slice(lane), ...keys.slice(0, lane)];
            while (next < toCheck.length) {
                if ((signal && signal.aborted) || report.quotaError) return;
                if (Date.now() > budgetEnd) {
                    report.gapsSkippedForTime = toCheck.length - next;
                    return;
                }
                const w = toCheck[next++];
                try {
                const clipSec = w.end - w.start;
                const clipFile = path.join(workDir, `gap_${Math.round(w.start * 1000)}.mp3`);
                const { code } = await runFFmpegCapture(['-hide_banner', '-y', '-ss', w.start.toFixed(3), '-t', clipSec.toFixed(3), '-i', sourceFile,
                    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', clipFile], signal);
                if (code !== 0 || !fs.existsSync(clipFile)) continue;
                const clipBase64 = fs.readFileSync(clipFile).toString('base64');
                const before = existing.filter(c => c._end <= w.start + 0.5).slice(-4);
                const left = () => Math.max(1, budgetEnd - Date.now());
                const out = await geminiWithKeys(laneKeys, (key) => transcribeClipWithGemini({
                    apiKey: key, model, audioBase64: clipBase64, mimeType: 'audio/mp3', clipSec,
                    promptOpts: { ...promptOpts, previousLines: before }, signal, stayOnModel,
                    timeoutMs: Math.min(GEMINI_ATTEMPT_TIMEOUT_MS, Math.max(45000, left()))
                }), signal, { busyBudgetMs: left() });
                report.gapsChecked++;
                setGapNote();
                if (!out.ok) {
                    report.gapsFailed = (report.gapsFailed || 0) + 1;
                    if (out.result && out.result.isDailyQuota) {
                        report.quotaError = out.result.message;
                        return;
                    }
                    continue;
                }
                for (const cue of normalizeClipCues(out.items, w.start, clipSec, glossary)) {
                    const dur = Math.max(0.1, cue._end - cue._start);
                    const clash = cues.some(c => Math.min(c._end, cue._end) - Math.max(c._start, cue._start) > dur * 0.4);
                    if (clash) continue;
                    cue._repaired = 'added';
                    cues.push(cue);
                    report.linesAdded++;
                }
                } catch (e) {
                    if (e.name === 'AbortError') throw e;
                    console.warn(`[Repair] gap ${w.start.toFixed(0)}-${w.end.toFixed(0)}s skipped:`, e.message);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(webLaneCount(keys) || keys.length, TRANSCRIBE_MAX_LANES, maxLanes, toCheck.length)) }, (_, lane) => worker(lane)));
        cues.sort((a, b) => a._start - b._start);
    }

    const targets = cues.map((cue, index) => ({ cue, index })).filter(({ cue }) => cueNeedsTranslation(cue));
    if (targets.length && !report.quotaError) {
        if (progress) progress.note = `Translating ${targets.length} line(s) that came back without Khmer…`;
        const r = await retranslateCues(targets, cues, { keys: textKeys(keys, useTextAi), model, promptOpts, glossary, signal });
        report.retranslated = r.fixed;
        if (r.error) report.translateError = r.error.message || r.error.error;
        if (r.error && r.error.isDailyQuota) report.quotaError = r.error.message;
    }
    for (const cue of cues) {
        const text = String(cue.text || '');
        if (KHMER_CHAR_RE.test(text) && hasForeignText(text)) {
            cue.text = stripForeignScript(text);
            if (cue._repaired !== 'added') cue._repaired = 'translated';
        }
    }
    report.stillUntranslated = cues.filter(cueNeedsTranslation).length;
    console.log('[Repair]', JSON.stringify(report));
    return report;
}

const CHARACTER_SHEETS_DIR = path.join(STORAGE_BASE, 'character_sheets');
const CHARACTER_SHEET_MIN_LINES = 20;

async function prepareCharacterSheet({ lines, sourceFilePath, glossary, glossaryHint = '', keys, model, signal, usage }) {
    return withSeriesLock(CHARACTER_SHEETS_DIR, sourceFilePath, async () => {
        const saved = loadSeriesSheet(CHARACTER_SHEETS_DIR, sourceFilePath);
        const known = saved && applyGlossaryToSheet(saved, glossary);
        if (lines.filter(l => l && l.text).length < CHARACTER_SHEET_MIN_LINES) return known;
        const payload = {
            contents: [{ role: 'user', parts: [{ text: buildCharacterSheetPrompt({ lines, known, glossaryHint, speakers: sourceFilePath ? loadSeriesSpeakers(CHARACTER_SHEETS_DIR, sourceFilePath) : [] }) }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: CHARACTER_SHEET_SCHEMA, maxOutputTokens: 8192 }
        };
        let out;
        try {
            out = await tryKeysOnce(keys, async (key) => {
                const r = await generateText(key, model, payload, signal, { timeoutMs: GEMINI_TEXT_TIMEOUT_MS, thinking: 'low' });
                return r.success ? { ok: true, r } : { ok: false, result: r };
            });
        } catch (e) {
            if (e.name === 'AbortError') throw e;
            out = { ok: false, result: { message: e.message } };
        }
        if (!out.ok) {
            console.warn(`[Sheet] Character sheet skipped: ${(out.result && (out.result.message || out.result.error)) || 'no answer'}`);
            return known;
        }
        addTokenUsage(usage, out.r);
        const merged = applyGlossaryToSheet(mergeSheets(known, normalizeSheet(extractJsonValue(out.r.text))), glossary);
        if (!sheetSize(merged)) return known;
        try {
            if (sourceFilePath) saveSeriesSheet(CHARACTER_SHEETS_DIR, sourceFilePath, merged);
        } catch (e) {
            console.warn('[Sheet] Could not save the series sheet:', e.message);
        }
        console.log(`[Sheet] ${merged.characters.length} name(s), ${merged.address.length} form(s) of address, ${merged.terms.length} term(s)${known ? ` (series sheet had ${sheetSize(known)} entries)` : ''}`);
        return merged;
    });
}

const REVIEW_BATCH = 100;
const REVIEW_RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: { i: { type: 'INTEGER' }, text: { type: 'STRING' } },
        required: ['i', 'text'],
        propertyOrdering: ['i', 'text']
    }
};

// ── Shared review requests ──
// A short tab (an episode of ~20 lines) spent a whole review request on its own, though one
// request takes REVIEW_BATCH lines: on 2026-11-06, 113 episodes made 113 review requests, each
// less than a quarter full - half of all requests, and Google's free tier allows 20 a day per
// model per project. Tabs transcribed at the same time (Dub Whole Series: several at once) now
// share review requests: a review waits until every running transcription has joined, the lines
// fill a request, or REVIEW_GATHER_MS pass (measured: waits of 20 s would have made 46 requests
// of the 113). Only reviews with the same model, register, glossary and sheet share.
const REVIEW_GATHER_MS = 20 * 1000;
let transcribesRunning = 0;
const reviewGroups = new Map(); // group key -> { jobs: [], lines, timer }

function sharedReview(groupKey, job) {
    return new Promise((resolve) => {
        let g = reviewGroups.get(groupKey);
        if (g && g.lines + job.items.length > REVIEW_BATCH) { // full: it goes, this tab starts the next
            flushReviewGroup(groupKey);
            g = null;
        }
        if (!g) {
            g = { jobs: [], lines: 0, timer: null };
            reviewGroups.set(groupKey, g);
            g.timer = setTimeout(() => flushReviewGroup(groupKey), REVIEW_GATHER_MS);
        }
        g.jobs.push({ ...job, resolve });
        g.lines += job.items.length;
        if (g.lines >= REVIEW_BATCH) flushReviewGroup(groupKey);
        else flushReviewGroupsIfComplete();
    });
}

// Every running transcription is already waiting in a group: nobody else will join.
function flushReviewGroupsIfComplete() {
    const waiting = [...reviewGroups.values()].reduce((n, g) => n + g.jobs.length, 0);
    if (waiting && waiting >= transcribesRunning) [...reviewGroups.keys()].forEach(flushReviewGroup);
}

// One request for the group's lines (numbered across its tabs); each tab gets its own answers
// back, numbered as it sent them - or { error } when Gemini didn't answer.
async function flushReviewGroup(groupKey) {
    const g = reviewGroups.get(groupKey);
    if (!g) return;
    reviewGroups.delete(groupKey);
    clearTimeout(g.timer);
    const jobs = g.jobs.filter(j => !(j.signal && j.signal.aborted));
    g.jobs.filter(j => j.signal && j.signal.aborted).forEach(j => j.resolve({ error: { error: 'CANCELLED' } }));
    if (!jobs.length) return;
    const back = new Map();
    const items = [];
    jobs.forEach((j, k) => j.items.forEach((it) => { back.set(items.length, { k, i: it.i }); items.push({ ...it, i: items.length }); }));
    const first = jobs[0];
    const payload = {
        systemInstruction: first.systemInstruction,
        contents: [{ role: 'user', parts: [{ text: buildReviewUserPrompt({ lines: items, glossaryHint: first.glossaryHint, sheetHint: first.sheetHint, previousLines: first.previousLines }) }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: REVIEW_RESPONSE_SCHEMA, maxOutputTokens: 16384 }
    };
    if (jobs.length > 1) console.log(`[Review] ${jobs.length} tabs share one request (${items.length} lines)`);
    let out;
    try {
        out = await geminiWithKeys(first.keys, async (key) => {
            const r = await generateText(key, first.model, payload, null);
            if (!r.success) return { ok: false, result: r };
            addTokenUsage(first.usage, r); // counted once, on the first tab's total
            const parsed = parseJsonArrayLoose(r.text);
            return Array.isArray(parsed) ? { ok: true, parsed } : { ok: false, result: { status: 502, error: 'JSON_PARSE_ERROR' } };
        }, null, { retries: GEMINI_RETRY_DELAYS_MS.length, busyBudgetMs: REPAIR_BUSY_BUDGET_MS });
    } catch (e) {
        out = { ok: false, result: { error: e.message } };
    }
    const per = jobs.map(() => []);
    if (out.ok) {
        for (const item of out.parsed) {
            const b = back.get(Number(item && item.i));
            if (b) per[b.k].push({ ...item, i: b.i });
        }
    }
    jobs.forEach((j, k) => j.resolve(out.ok ? { parsed: per[k] } : { error: out.result }));
}

async function reviewKhmerLines({ lines, texts, apply, genre, glossary, glossaryHint = '', sheetHint = '', keyPool, model, signal, usage, tag, share = false }) {
    const todo = lines.map((_, i) => i).filter(i => texts[i] && KHMER_CHAR_RE.test(texts[i]) && lines[i].source);
    if (!todo.length) return 0;
    const systemInstruction = { parts: [{ text: buildReviewSystemPrompt({ genreGuidance: getKhmerDramaRegisterGuidance(genre || 'historical') }) }] };
    const batches = [];
    for (let b = 0; b < todo.length; b += REVIEW_BATCH) batches.push(todo.slice(b, b + REVIEW_BATCH));
    const laneCount = Math.max(1, Math.min(textLaneCount(keyPool), TRANSCRIBE_MAX_LANES, batches.length));
    let changed = 0;
    let failed = 0;

    const reviewBatch = async (keys, idx) => {
        const items = idx.map(i => {
            const seconds = Number(lines[i].seconds) > 0 ? Number(Number(lines[i].seconds).toFixed(2)) : null;
            return {
                i, source: lines[i].source, khmer: texts[i],
                ...(lines[i].gender && { gender: lines[i].gender }),
                ...(seconds && { seconds, maxSyllables: khmerMaxSyllables(seconds) })
            };
        });
        const previousLines = todo.slice(Math.max(0, todo.indexOf(idx[0]) - 6), todo.indexOf(idx[0]))
            .map(i => ({ source: lines[i].source, khmer: texts[i], gender: lines[i].gender }));
        let out;
        if (share && batches.length === 1) {
            // A short tab: its lines go in a request shared with the other tabs being transcribed.
            const r = await sharedReview(JSON.stringify([model, genre || 'historical', glossaryHint, sheetHint]),
                { items, previousLines, keys, model, systemInstruction, glossaryHint, sheetHint, signal, usage });
            out = r.error ? { ok: false, result: r.error } : { ok: true, parsed: r.parsed };
        } else {
            const payload = {
                systemInstruction,
                contents: [{ role: 'user', parts: [{ text: buildReviewUserPrompt({ lines: items, glossaryHint, sheetHint, previousLines }) }] }],
                generationConfig: { responseMimeType: 'application/json', responseSchema: REVIEW_RESPONSE_SCHEMA, maxOutputTokens: 16384 }
            };
            out = await geminiWithKeys(keys, async (key) => {
                const r = await generateText(key, model, payload, signal);
                if (!r.success) return { ok: false, result: r };
                addTokenUsage(usage, r);
                const parsed = parseJsonArrayLoose(r.text);
                return Array.isArray(parsed) ? { ok: true, parsed } : { ok: false, result: { status: 502, error: 'JSON_PARSE_ERROR' } };
            }, signal, { retries: GEMINI_RETRY_DELAYS_MS.length, busyBudgetMs: REPAIR_BUSY_BUDGET_MS });
        }
        if (!out.ok) {
            failed += idx.length;
            console.warn(`[${tag}] Review of lines ${idx[0] + 1}-${idx[idx.length - 1] + 1} skipped: ${out.result.message || out.result.error}`);
            return;
        }
        const wanted = new Set(idx);
        for (const item of out.parsed) {
            const i = Number(item && item.i);
            if (!wanted.has(i)) continue;
            wanted.delete(i);
            let text = sanitizeKhmerDialogue(String(item.text || ''));
            if (glossary) text = applyGlossary(text, glossary);
            if (!text || !KHMER_CHAR_RE.test(text) || text === texts[i] || hasForeignText(text)) continue;
            const seconds = Number(lines[i].seconds) || 0;
            if (estimateSpeechSeconds(text) > Math.max(estimateSpeechSeconds(texts[i]) * 1.25, seconds * 1.3)) continue;
            apply(i, text);
            texts[i] = text;
            changed++;
        }
    };

    await Promise.all(Array.from({ length: laneCount }, async (_, lane) => {
        const keys = textLaneKeys(keyPool, lane);
        const from = Math.floor(lane * batches.length / laneCount);
        const to = Math.floor((lane + 1) * batches.length / laneCount);
        for (let b = from; b < to; b++) {
            if (signal && signal.aborted) return;
            await reviewBatch(keys, batches[b]);
        }
    }));
    if (signal && signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    console.log(`[${tag}] Review: ${todo.length} line(s) checked, ${changed} corrected${failed ? `, ${failed} not checked (Gemini did not answer)` : ''}`);
    return changed;
}

async function fitOverlongLines({ lines, texts, apply, genre, glossary, keyPool, model, signal, usage, sheetHint = '', tag }) {
    const overlong = findOverlongLines(lines, texts);
    if (!overlong.length) return 0;
    let fitted = 0;
    try {
        const out = await shortenLines({
            items: overlong.map(({ i, room, speed }) => ({ id: String(i), text: texts[i], seconds: room, speed, originalText: lines[i].text })),
            genre, glossary, keyPool, model, signal, strength: 'fit', usage, sheetHint
        });
        for (const { id, text } of out.results) {
            const i = Number(id);
            if (!texts[i] || !KHMER_CHAR_RE.test(text) || text.length >= texts[i].length) continue;
            apply(i, text);
            fitted++;
        }
        if (!out.ok) console.warn(`[${tag}] Timeline fit stopped early: ${(out.result && (out.result.message || out.result.error)) || 'no answer'}`);
    } catch (e) {
        if (e.name === 'AbortError' || (signal && signal.aborted)) throw e;
        console.warn(`[${tag}] Timeline fit skipped:`, e.message);
    }
    console.log(`[${tag}] ${overlong.length} line(s) too long for their time, ${fitted} re-worded to fit`);
    return fitted;
}

const TRANSLATE_RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            i: { type: 'INTEGER' },
            text: { type: 'STRING' },
            gender: { type: 'STRING', enum: ['Male', 'Female'] },
            emotion: { type: 'STRING', enum: TRANSCRIBE_EMOTIONS }
        },
        required: ['i', 'text', 'gender'],
        propertyOrdering: ['i', 'text', 'gender', 'emotion']
    }
};

const TRANSLATE_BATCH_SIZE = 120;

const EMOTION_BATCH = 120;
const EMOTION_RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: { i: { type: 'INTEGER' }, emotion: { type: 'STRING', enum: TRANSCRIBE_EMOTIONS } },
        required: ['i', 'emotion'],
        propertyOrdering: ['i', 'emotion']
    }
};
const EMOTION_SYSTEM_PROMPT = `You direct the voice actors who dub a drama into Khmer. For every subtitle line, choose the emotion the actor should speak it with:
- "Neutral": ordinary talk, questions, explanations, small talk. Most lines are Neutral.
- "Angry": shouting, scolding, threatening, arguing, cold fury.
- "Sad": grief, crying, heartbreak, loss, a painful apology or farewell.
- "Whisper": a secret, a plot, something said so others nearby do not hear.
- "Excited": joy, delight, surprise, cheering, eagerness.
- "Royal": a ruler, a lord or a commander speaking with authority: orders, decrees, judgments.
- "Romantic": tender words between lovers, flirting, affection.
- "Fear": terror, panic, begging for mercy, nervous stammering.
Read the lines as one scene: a mood carries over several lines, and a reply inside an argument is usually still Angry. Judge from the words, the punctuation (! ? ...) and the scene. When unsure, choose "Neutral" - a wrong strong emotion sounds worse than a calm line.
Answer with a JSON array holding one {"i", "emotion"} for every line, using each line's "i".`;

const SHORTEN_CHUNK = 80;

function buildShortenPrompt({ lines, targetLanguage, registerGuidance, glossaryHint, strength }) {
    const task = strength === 'shorter'
        ? `Rewrite each line ("text") SHORTER and punchier: clearly fewer spoken syllables than the input, as natural spoken dialogue. When a line has "slotSeconds", it must also fit that slot at a relaxed, natural 1.0x speaking pace.`
        : `These lines are too long for their time slot, so the voice has to be sped up (currentSpeed) and sounds rushed.
Rewrite each line ("text") into SHORT, NATURAL spoken dialogue that fits within its "slotSeconds" at a relaxed, natural 1.0x speaking pace.`;
    return `You are a master film/TV dubbing script adapter and dialogue doctor.

YOUR TASK:
${task}

STRICT DUBBING CONSTRAINTS:
1. Stay within each line's "maxSyllables" spoken syllables when it has one. Shorter is fine; never exceed it.
2. Keep the exact emotional tone, dramatic intent, speaker register and key plot facts. It must sound like authentic, natural film/TV dialogue.
3. Keep forms of address and pronouns (បង, អូន, លោក, ព្រះអង្គ ...) and names unchanged - they carry who is talking to whom. Cut other words first: filler particles, formal padding and verbose structures.
4. Write in ${targetLanguage} (the same language as "text"). "sourceText", when present, is the original-language line for meaning reference only.${registerGuidance}${glossaryHint}

LINES TO SHORTEN:
${JSON.stringify(lines)}

OUTPUT FORMAT:
Return ONLY a JSON array with one object per input line: [{ "id": "<same id>", "condensedText": "<shortened line>" }]`;
}

const SHORTEN_RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            id: { type: 'STRING' },
            condensedText: { type: 'STRING' }
        },
        required: ['id', 'condensedText']
    }
};

async function shortenLines({ items, targetLanguage = 'Khmer', genre = 'historical', glossary, keyPool, model, signal, strength = 'fit', usage = null, sheetHint = '' }) {
    const isKhmer = /khmer|^km/i.test(String(targetLanguage));
    const registerGuidance = isKhmer ? getKhmerDramaRegisterGuidance(genre || 'historical') : '';
    const glossaryHint = (glossary
        ? `\n\nGLOSSARY (keep these names/terms exactly as given):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}`
        : '') + (sheetHint || '');
    const linesData = items.map((s) => {
        const seconds = Number(s.seconds) > 0 ? Number(s.seconds) : null;
        const speed = parseFloat(s.speed);
        return {
            id: String(s.id),
            text: String(s.text).trim(),
            ...(seconds ? { slotSeconds: Number(seconds.toFixed(2)), maxSyllables: khmerMaxSyllables(seconds) } : {}),
            ...(speed > 0 ? { currentSpeed: `${speed.toFixed(2)}x` } : {}),
            ...(s.originalText ? { sourceText: String(s.originalText) } : {})
        };
    });

    const results = [];
    const seen = new Set();
    for (let start = 0; start < linesData.length; start += SHORTEN_CHUNK) {
        const chunk = linesData.slice(start, start + SHORTEN_CHUNK);
        const payload = {
            contents: [{ role: 'user', parts: [{ text: buildShortenPrompt({ lines: chunk, targetLanguage, registerGuidance, glossaryHint, strength }) }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: SHORTEN_RESPONSE_SCHEMA }
        };
        const out = await geminiWithKeys(keyPool, async (key) => {
            const r = await generateText(key, model, payload, signal, { timeoutMs: GEMINI_TEXT_TIMEOUT_MS, thinking: 'low' });
            if (!r.success) return { ok: false, result: r };
            addTokenUsage(usage, r);
            const parsed = parseJsonArrayLoose(r.text);
            if (!Array.isArray(parsed)) return { ok: false, result: { status: 502, error: 'JSON_PARSE_ERROR', message: 'The AI did not return a list of lines.' } };
            return { ok: true, parsed };
        }, signal, { retries: GEMINI_RETRY_DELAYS_MS.length, busyBudgetMs: REPAIR_BUSY_BUDGET_MS });
        if (!out.ok) return { ok: false, result: out.result, results };

        const requestedIds = new Set(chunk.map(l => l.id));
        for (const item of out.parsed) {
            const id = item && String(item.id);
            let text = item && typeof item.condensedText === 'string' ? item.condensedText.trim() : '';
            if (!id || !text || !requestedIds.has(id) || seen.has(id)) continue;
            if (isKhmer) text = sanitizeKhmerDialogue(text);
            if (glossary) text = applyGlossary(text, glossary);
            if (!text) continue;
            seen.add(id);
            results.push({ id, text });
        }
    }
    return { ok: true, results };
}

const TITLE_SAMPLE_CHARS = 30000;
const TITLE_RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
        synopsis: { type: 'STRING' },
        titles: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    khmerTitle: { type: 'STRING' },
                    englishTitle: { type: 'STRING' },
                    vibe: { type: 'STRING' },
                    reasoning: { type: 'STRING' }
                },
                required: ['khmerTitle', 'englishTitle', 'vibe', 'reasoning'],
                propertyOrdering: ['khmerTitle', 'englishTitle', 'vibe', 'reasoning']
            }
        }
    },
    required: ['synopsis', 'titles'],
    propertyOrdering: ['synopsis', 'titles']
};

function srtToDialogueLines(text) {
    return String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map(block => {
        const lines = block.split('\n').filter(l => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^\[File:/.test(l) && !/^WEBVTT/.test(l));
        return lines.join(' ').replace(/<[^>]+>/g, '').replace(/^\[(?:Male|Female|Hero|Heroine|Father|Mother|Villain|Queen|Elder|Child)(?::[^\]]+)?\]\s*/i, '').trim();
    }).filter(Boolean);
}

function sampleDialogue(lines, budget) {
    const total = lines.reduce((n, l) => n + l.length + 1, 0);
    if (total <= budget) return lines;
    const RUN = 6;
    const avg = total / lines.length;
    const runs = Math.max(2, Math.floor(budget / (avg * RUN)));
    const out = [];
    let used = 0;
    for (let r = 0; r < runs; r++) {
        const start = Math.round(r * (lines.length - RUN) / (runs - 1));
        for (let i = start; i < Math.min(lines.length, start + RUN); i++) {
            if (used + lines[i].length + 1 > budget) return out;
            out.push(lines[i]);
            used += lines[i].length + 1;
        }
        if (r < runs - 1) out.push('…');
    }
    return out;
}

const NAMES_LINES_PER_CHUNK = 400;
const NAMES_PARALLEL = 3;
const NAMES_RESPONSE_SCHEMA = {
    type: 'ARRAY',
    items: {
        type: 'OBJECT',
        properties: {
            original: { type: 'STRING' },
            type: { type: 'STRING', enum: ['person', 'place', 'group', 'other'] },
            khmer: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['original', 'type', 'khmer'],
        propertyOrdering: ['original', 'type', 'khmer']
    }
};

function buildNameExtractionPrompt(lines) {
    return `You are checking the subtitles of a Khmer-dubbed movie for consistent names.

Each line below is: original-language dialogue => the Khmer subtitle for it.

List every proper name that appears in the ORIGINAL dialogue:
- people (including nicknames and names used to address someone),
- places (cities, kingdoms, mountains, palaces, villages),
- groups (clans, sects, families, companies, armies),
- other named things (named swords, martial-arts techniques, shops, titles used as a name).

For each name return:
- "original": the name copied EXACTLY as written in the original dialogue (same characters and spelling). Use the shortest form that identifies it (e.g. 林峰, not 林峰哥哥).
- "type": person, place, group or other.
- "khmer": every DIFFERENT Khmer spelling the subtitles use for this name in these lines, copied character-for-character from the Khmer text. Only include spellings that literally appear in the Khmer subtitles. Do not translate, correct or invent spellings. If the Khmer never writes the name (e.g. it uses a pronoun), return an empty list.

Do not list ordinary words, pronouns, generic titles on their own (e.g. 王爷, 师父, 老板, boss) or words that only appear in the Khmer.
Return only the JSON array.

LINES:
${lines.map(l => `${l.originalText} => ${l.text}`).join('\n')}`;
}

// Router factory
function createGeminiRouter(options = {}) {
    const {
        getFFmpegBinary = require('../ffmpeg_env').getFFmpegBinary,
        getFFprobeBinary = require('../ffmpeg_env').getFFprobeBinary,
        backgroundable = (fn) => fn,
        saveTranscribeAudio = () => null,
        keyRest = getDefaultKeyRest()
    } = options;

    _getFFmpegBinary = getFFmpegBinary;
    _getFFprobeBinary = getFFprobeBinary;
    geminiModelCooldowns = keyRest.modelLimits;
    invalidGeminiKeys = keyRest.invalid;
    rateLimitedGeminiKeys = keyRest.keyLimits;
    if (keyRest.dailyStrikes) geminiDailyStrikes = keyRest.dailyStrikes;
    if (keyRest.answered) geminiKeyAnswered = keyRest.answered;

    const router = express.Router();

    // ── Transcribe route ──
    router.post('/transcribe', backgroundable(async (req, res) => {
        const {
            audioBase64,
            audioPath,
            mimeType = 'audio/mp3',
            duration,
            genre = 'historical',
            dramaRegister,
            glossary,
            apiKey,
            apiKeys,
            model = 'gemini-3.8-flash',
            requestId,
            videoName,
            partIndex,
            customFolder,
            sourceFilePath,
            apiSaver = true,
            stayOnModel = false,
            fitToTime = true,
            review = true,
            sendVideo = true,
            maxLanes = TRANSCRIBE_MAX_LANES
        } = req.body;
        const laneCap = Math.max(1, Math.min(TRANSCRIBE_MAX_LANES, parseInt(maxLanes, 10) || TRANSCRIBE_MAX_LANES));

        if (!audioBase64 && !audioPath) {
            return res.status(400).json({ success: false, error: 'No audio data or audio path received.' });
        }

        const usePath = !!(audioPath && fs.existsSync(audioPath));
        let audioBuffer = null;
        try {
            if (!usePath && audioBase64) {
                audioBuffer = Buffer.from(audioBase64, 'base64');
                saveTranscribeAudio(audioBuffer, videoName, partIndex, customFolder, sourceFilePath);
            }
        } catch (err) {
            console.warn('[Outputs] Error saving transcribe chunk:', err.message);
        }

        const rawKeys = [apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]
            .map(k => String(k || '').trim())
            .filter((k, i, a) => k && a.indexOf(k) === i);
        const dpKeys = getDRRouterKeys();
        const keyPool = orderPool(rawKeys.length ? [...rawKeys, ...dpKeys.filter(k => !rawKeys.includes(k))] : dpKeys);
        if (!keyPool.length) {
            return res.status(400).json({
                success: false,
                error: 'INVALID_API_KEY',
                message: 'Please enter your Gemini API Key in Settings ➔ General.'
            });
        }

        const abortCtrl = new AbortController();
        if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);
        const workDir = path.join(SEPARATED_DIR, `transcribe_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
        transcribesRunning++; // the review pool waits for the others still running (sharedReview)

        try {
            const genreRegister = genre || dramaRegister || 'historical';
            console.log(`[Transcribe] register: ${genreRegister}${videoName ? ` (${videoName})` : ''}`);
            const userGlossaryHint = glossary ? `\n\nCUSTOM CHARACTER / GLOSSARY DICTIONARY (STRICTLY USE THESE TRANSLATIONS):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : '';
            const savedSheet = loadSeriesSheet(CHARACTER_SHEETS_DIR, sourceFilePath);
            const seriesSheet = savedSheet && applyGlossaryToSheet(savedSheet, glossary);
            const seriesSpeakers = sourceFilePath ? foldSpeakers(loadSeriesSpeakers(CHARACTER_SHEETS_DIR, sourceFilePath), seriesSheet) : [];
            const promptOpts = {
                genreGuidance: getKhmerDramaRegisterGuidance(genreRegister),
                glossaryHint: userGlossaryHint + formatSheetForPrompt(seriesSheet) + formatSpeakersForPrompt(seriesSpeakers, seriesSheet),
                usage: createTokenUsage()
            };

            fs.mkdirSync(workDir, { recursive: true });
            let inputFile;
            if (usePath) {
                inputFile = audioPath;
            } else {
                const ext = /wav/i.test(mimeType) ? '.wav' : /m4a|mp4|aac/i.test(mimeType) ? '.m4a' : /ogg|opus/i.test(mimeType) ? '.ogg' : '.mp3';
                inputFile = path.join(workDir, `input${ext}`);
                fs.writeFileSync(inputFile, audioBuffer || Buffer.from(audioBase64, 'base64'));
            }

            const totalSec = (await probeAudioDuration(inputFile)) || Number(duration) || 0;
            const fastMode = typeof drRouterFastMode === 'function' && drRouterFastMode();
            const webLanes = webLaneCount(keyPool);
            // Gemini Web Router has its own credits and shorter output window on gemini.google.com,
            // so 3-minute chunks avoid truncated web replies and run faster through PC timing.
            const saverOn = apiSaver && !fastMode && !webLanes;
            const chunkPlan = saverOn ? { singleMax: SAVER_SINGLE_MAX_SEC, target: SAVER_CHUNK_TARGET_SEC } : {};
            const silences = totalSec > (chunkPlan.singleMax || TRANSCRIBE_SINGLE_MAX_SEC) ? await detectSilences(inputFile, abortCtrl.signal) : [];
            const chunks = totalSec > 0 ? planTranscribeChunks(totalSec, silences, chunkPlan) : [{ start: 0, end: 0 }];
            console.log(`[Transcribe] ${totalSec.toFixed(1)}s audio -> ${chunks.length} chunk(s)`);

            let videoSource = null;
            if (sendVideo !== false && totalSec > 0) {
                const src = resolveLocalFilePath(sourceFilePath);
                if (src && security.VIDEO_EXTS.has(path.extname(src).toLowerCase()) && fs.existsSync(src)) {
                    const videoSec = await probeAudioDuration(src);
                    if (videoSec && Math.abs(videoSec - totalSec) < 1.5) videoSource = src;
                }
            }
            const castParts = videoSource ? seriesCastParts(castDir(CHARACTER_SHEETS_DIR, sourceFilePath), seriesSpeakers, seriesSheet) : [];
            if (videoSource) console.log(`[Transcribe] Gemini sees the video (who talks)${castParts.length ? `, with pictures of ${castParts.filter(p => p.text && p.text.endsWith('):')).length} known speaker(s)` : ''}`);

            // Normally a lane does two chunks in a row (the second sees the first one's last lines);
            // Fast mode gives every chunk its own key so the whole film is asked at once.
            // Router first: one lane per Gmail; the API keys stay behind them as backups.
            const laneCount = Math.max(1, Math.min(webLanes || keyPool.length, laneCap, fastMode ? chunks.length : Math.ceil(chunks.length / 2)));
            const chunkCues = new Array(chunks.length);
            const rawParts = new Array(chunks.length);
            // phase: 'translate' while the chunks are with Gemini, 'polish' for the checks after.
            // (No progress yet = the audio is still being extracted and split.)
            const progress = { done: 0, total: chunks.length, phase: 'translate' };
            if (requestId) transcribeProgress.set(requestId, progress);
            let failure = null;
            let anyTruncated = false;
            const modelsUsed = new Set();
            const fellBackModels = new Set();
            console.log(`[Transcribe] ${chunks.length} chunk(s) across ${laneCount} API key lane(s)${saverOn ? ' [API saver]' : ''}${fastMode ? ' [Fast mode]' : ''}`);

            const cutClip = async (i) => {
                const chunk = chunks[i];
                const clipSec = chunk.end - chunk.start;
                if (videoSource) {
                    const clipFile = path.join(workDir, `clip_${i}.mp4`);
                    const { code } = await runFFmpegCapture(['-hide_banner', '-y', '-ss', chunk.start.toFixed(3), '-t', clipSec.toFixed(3),
                        '-i', videoSource, '-vf', 'scale=-2:360,fps=2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32',
                        '-c:a', 'aac', '-ac', '1', '-ar', '16000', '-b:a', '48k', '-movflags', '+faststart', clipFile], abortCtrl.signal);
                    if (code === 0 && fs.existsSync(clipFile) && fs.statSync(clipFile).size < 15 * 1024 * 1024) {
                        return { clipBase64: fs.readFileSync(clipFile).toString('base64'), clipMime: 'video/mp4' };
                    }
                }
                if (!(chunks.length > 1 || usePath || audioBase64.length > 14 * 1024 * 1024) || !(totalSec > 0)) {
                    return usePath
                        ? { clipBase64: fs.readFileSync(inputFile).toString('base64'), clipMime: mimeType || 'audio/mp3' }
                        : { clipBase64: audioBase64, clipMime: mimeType || 'audio/mp3' };
                }
                const clipFile = path.join(workDir, `clip_${i}.mp3`);
                const { code } = await runFFmpegCapture(['-hide_banner', '-y', '-ss', chunk.start.toFixed(3), '-t', clipSec.toFixed(3),
                    '-i', inputFile, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', clipFile], abortCtrl.signal);
                if (code !== 0 || !fs.existsSync(clipFile)) throw new Error(`FFmpeg failed to cut audio chunk ${i + 1}`);
                return { clipBase64: fs.readFileSync(clipFile).toString('base64'), clipMime: 'audio/mp3' };
            };

            const runLane = async (lane) => {
                const from = Math.floor(lane * chunks.length / laneCount);
                const to = Math.floor((lane + 1) * chunks.length / laneCount);
                const keys = [...keyPool.slice(lane), ...keyPool.slice(0, lane)];
                let laneCues = [];
                let nextClipP = from < to ? cutClip(from) : null;
                if (nextClipP) nextClipP.catch(() => {});
                for (let i = from; i < to; i++) {
                    if (failure || abortCtrl.signal.aborted) return;
                    const chunk = chunks[i];
                    const clipSec = chunk.end - chunk.start;
                    const curClipP = nextClipP || cutClip(i);
                    nextClipP = (i + 1 < to) ? cutClip(i + 1) : null;
                    if (nextClipP) nextClipP.catch(() => {});
                    const { clipBase64, clipMime } = await curClipP;
                    const cacheKey = transcribeCacheKey(clipBase64, [promptOpts.genreGuidance, promptOpts.glossaryHint, laneCues.slice(-2)]);
                    let out = transcribeCacheGet(cacheKey);
                    if (out) console.log(`[Transcribe] Chunk ${i + 1}/${chunks.length} reused from cache`);
                    if (!out) {
                        out = await geminiWithKeys(keys, (key) => {
                            // Stay on the chosen model unless Google just said it is busy.
                            const holdModel = !!stayOnModel && !isGeminiModelBusy(resolveGeminiModel(model));
                            return transcribeClipWithGemini({
                                apiKey: key,
                                model,
                                audioBase64: clipBase64,
                                mimeType: clipMime,
                                clipSec,
                                promptOpts: { ...promptOpts, previousLines: laneCues.slice(-4), video: clipMime === 'video/mp4', castParts: clipMime === 'video/mp4' ? castParts : null },
                                signal: abortCtrl.signal,
                                stayOnModel: holdModel
                            });
                        }, abortCtrl.signal, {
                            busyBudgetMs: GEMINI_BUSY_RETRY_BUDGET_MS
                        });
                    }
                    if (out.ok && !out.truncated && out.items.length) transcribeCacheSet(cacheKey, out);
                    if (!out.ok) {
                        console.warn(`[Transcribe] Chunk ${i + 1}/${chunks.length} failed:`, out.result.error);
                        failure = failure || out.result;
                        return;
                    }
                    rawParts[i] = out.raw;
                    if (out.modelUsed) modelsUsed.add(out.modelUsed);
                    if (out.fellBack && out.modelUsed) fellBackModels.add(out.modelUsed);
                    if (out.truncated || !out.items.length) anyTruncated = true;
                    chunkCues[i] = normalizeClipCues(out.items, chunk.start, clipSec, glossary);
                    laneCues = chunkCues[i].length ? chunkCues[i] : laneCues;
                    progress.done++;
                    if (progress.note && progress.note.includes(`retrying part ${i + 1} `)) progress.note = null;
                    console.log(`[Transcribe] Chunk ${i + 1}/${chunks.length} (${chunk.start.toFixed(1)}-${chunk.end.toFixed(1)}s) -> ${chunkCues[i].length} lines via ${out.modelUsed} [lane ${lane + 1}]`);
                }
            };

            await Promise.all(Array.from({ length: laneCount }, (_, lane) => runLane(lane).catch((e) => {
                if (e.name !== 'AbortError') failure = failure || { status: 500, error: e.message };
            })));
            if (abortCtrl.signal.aborted) return res.json({ success: false, error: 'CANCELLED' });
            if (failure) return geminiFailureResponse(res, failure);
            progress.phase = 'polish';
            const allCues = chunkCues.flat();
            const fallbackModels = [...fellBackModels];
            if (fallbackModels.length) console.warn(`[Transcribe] Some chunks used a fallback model: ${fallbackModels.join(', ')} (asked for ${resolveGeminiModel(model)})`);

            let repair = null;
            try {
                repair = await repairTranscript({
                    cues: allCues, sourceFile: totalSec > 0 ? inputFile : null, totalSec, keys: keyPool, model,
                    promptOpts, glossary, workDir, signal: abortCtrl.signal, progress, stayOnModel: !!stayOnModel, maxLanes: laneCap,
                    checkGaps: !saverOn || anyTruncated
                });
            } catch (e) {
                if (e.name === 'AbortError' || abortCtrl.signal.aborted) throw e;
                console.warn('[Repair] skipped:', e.message);
            }

            if (allCues.length === 0) {
                return res.status(422).json({ success: false, error: 'No spoken dialogue was detected in this audio.' });
            }
            const speakerNameOf = seriesNameOf(seriesSheet, seriesSpeakers);
            allCues.forEach(c => { if (c.speaker) c.speaker = speakerNameOf(c.speaker); });

            let reviewed = 0;
            if (review !== false) {
                const reviewTexts = allCues.map(c => c.text);
                progress.note = 'Checking the Khmer lines against the original';
                reviewed = await reviewKhmerLines({
                    lines: allCues.map(c => ({ source: c.originalText || '', gender: c.gender, seconds: c._end - c._start })),
                    texts: reviewTexts,
                    apply: (i, text) => { allCues[i].text = text; allCues[i]._reviewed = true; },
                    genre: genreRegister, glossary, glossaryHint: userGlossaryHint, sheetHint: formatSheetForPrompt(seriesSheet),
                    keyPool: textKeys(keyPool), model, signal: abortCtrl.signal, usage: promptOpts.usage, tag: 'Transcribe',
                    share: true // with the other tabs being transcribed (sharedReview)
                });
                progress.note = null;
            }

            const fitted = fitToTime === false ? 0 : await fitOverlongLines({
                lines: allCues.map(c => ({ text: c.originalText || '', start: c._start, seconds: c._end - c._start })),
                texts: allCues.map(c => c.text),
                apply: (i, text) => { allCues[i].text = text; },
                genre: genreRegister, glossary, keyPool: textKeys(keyPool), model, signal: abortCtrl.signal,
                sheetHint: formatSheetForPrompt(seriesSheet), tag: 'Transcribe', usage: promptOpts.usage
            });
            console.log(`[Transcribe] ${allCues.length} lines${videoName ? ` (${videoName})` : ''}: ${formatTokenUsage(promptOpts.usage)}`);

            if (sourceFilePath) {
                try {
                    const speakers = addSeriesSpeakers(CHARACTER_SHEETS_DIR, sourceFilePath, allCues, seriesSheet);
                    if (videoSource) {
                        captureCastFrames({ video: videoSource, cues: allCues, dir: castDir(CHARACTER_SHEETS_DIR, sourceFilePath), speakers })
                            .then((changed) => { if (changed) saveSeriesSpeakers(CHARACTER_SHEETS_DIR, sourceFilePath, speakers); })
                            .catch(e => console.warn('[Sheet] Could not keep the cast pictures:', e.message));
                    }
                } catch (e) {
                    console.warn('[Sheet] Could not keep the speaker names:', e.message);
                }
            }

            if (sourceFilePath && allCues.length >= CHARACTER_SHEET_MIN_LINES) {
                prepareCharacterSheet({
                    lines: allCues.map(c => ({ text: c.originalText, gender: c.gender, khmer: c.text })),
                    sourceFilePath, glossary, glossaryHint: userGlossaryHint, keys: textKeys(keyPool), model, usage: createTokenUsage()
                }).catch(e => console.warn('[Sheet] Series sheet update failed:', e.message));
            }

            res.json({
                success: true,
                data: finalizeCues(allCues),
                reviewed,
                fitted,
                usage: promptOpts.usage,
                repair,
                modelsUsed: [...modelsUsed],
                fallbackModels,
                rawText: rawParts.filter(Boolean).join('\n')
            });

        } catch (e) {
            if (e.name === 'AbortError' || abortCtrl.signal.aborted) {
                return res.json({ success: false, error: 'CANCELLED' });
            }
            console.error('[Transcribe] Error:', e);
            res.status(500).json({ success: false, error: e.message });
        } finally {
            transcribesRunning--;
            flushReviewGroupsIfComplete(); // a review waiting for this tab need not wait any longer
            if (requestId) {
                activeTranscribeRequests.delete(requestId);
                transcribeProgress.delete(requestId);
            }
            fs.rm(workDir, { recursive: true, force: true }, () => { });
        }
    }));

    // ── Repair subtitles route ──
    router.post('/repair-subtitles', backgroundable(async (req, res) => {
        const { subtitles, videoPath, duration, genre = 'historical', dramaRegister, glossary, apiKey, apiKeys, model = 'gemini-3.8-flash', requestId, checkGaps = true, maxLanes = TRANSCRIBE_MAX_LANES } = req.body || {};
        if (!Array.isArray(subtitles)) return res.status(400).json({ success: false, error: 'No subtitles provided.' });
        const laneCap = Math.max(1, Math.min(TRANSCRIBE_MAX_LANES, parseInt(maxLanes, 10) || TRANSCRIBE_MAX_LANES));
        const rawKeys = [apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])].map(k => String(k || '').trim()).filter((k, i, a) => k && a.indexOf(k) === i);
        const dpKeys = getDRRouterKeys();
        const keyPool = orderPool(rawKeys.length ? [...rawKeys, ...dpKeys.filter(k => !rawKeys.includes(k))] : dpKeys);
        if (!keyPool.length && !codecraftActive()) return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'Gemini API key is required.' });

        const abortCtrl = new AbortController();
        const progress = { done: 0, total: 0 };
        if (requestId) { activeTranscribeRequests.set(requestId, abortCtrl); transcribeProgress.set(requestId, progress); }
        const workDir = path.join(SEPARATED_DIR, `repair_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
        try {
            fs.mkdirSync(workDir, { recursive: true });
            const genreRegister = genre || dramaRegister || 'historical';
            const promptOpts = {
                genreGuidance: getKhmerDramaRegisterGuidance(genreRegister),
                glossaryHint: glossary ? `\n\nCUSTOM CHARACTER / GLOSSARY DICTIONARY (STRICTLY USE THESE TRANSLATIONS):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : ''
            };
            const sourceFile = resolveLocalFilePath(videoPath);
            const hasSource = !!(sourceFile && fs.existsSync(sourceFile));
            const totalSec = hasSource ? ((await probeAudioDuration(sourceFile)) || Number(duration) || 0) : 0;

            const cues = subtitles.map(s => ({
                id: s.id, text: s.text || '', speaker: s.speaker, gender: s.gender, emotion: s.emotion,
                originalText: s.originalText || (s.text && !KHMER_CHAR_RE.test(s.text) ? s.text : ''),
                _start: parseTimestampSeconds(s.start), _end: parseTimestampSeconds(s.end)
            })).filter(c => isFinite(c._start) && isFinite(c._end));
            const before = new Map(cues.map(c => [c.id, c.text]));

            const report = await repairTranscript({
                cues, sourceFile: hasSource ? sourceFile : null, totalSec, keys: keyPool, model, promptOpts, glossary, workDir,
                signal: abortCtrl.signal, progress, checkGaps: checkGaps !== false && hasSource && keyPool.length > 0, maxLanes: laneCap,
                useTextAi: true
            });
            if (!hasSource && checkGaps !== false) report.gapsSkipped = 'Video file not available on disk - only re-translated lines.';
            else if (!keyPool.length && checkGaps !== false) report.gapsSkipped = 'Checking for missed dialogue listens to the audio, which needs a Gemini API key - only re-translated lines.';

            const updated = cues.filter(c => c.id !== undefined && c._repaired === 'translated' && before.get(c.id) !== c.text)
                .map(c => ({ id: c.id, text: c.text, speaker: c.speaker, gender: c.gender, emotion: c.emotion }));
            const added = cues.filter(c => c._repaired === 'added')
                .map(c => ({ start: +c._start.toFixed(2), end: +c._end.toFixed(2), text: c.text, originalText: c.originalText, speaker: c.speaker, gender: c.gender, emotion: c.emotion }));
            res.json({ success: true, updated, added, report });
        } catch (e) {
            if (e.name === 'AbortError' || abortCtrl.signal.aborted) return res.json({ success: false, error: 'CANCELLED' });
            console.error('[Repair] Error:', e);
            res.status(500).json({ success: false, error: e.message });
        } finally {
            if (requestId) { activeTranscribeRequests.delete(requestId); transcribeProgress.delete(requestId); }
            fs.rm(workDir, { recursive: true, force: true }, () => { });
        }
    }));

    // ── Translate SRT route ──
    router.post('/translate-srt', async (req, res) => {
        const {
            srtBase64,
            srtText,
            genre = 'historical',
            dramaRegister,
            glossary,
            apiKey,
            apiKeys,
            model = 'gemini-3.8-flash',
            requestId,
            sourceFilePath,
            review = true
        } = req.body;

        let content = srtText;
        if (!content && srtBase64) {
            try {
                content = Buffer.from(srtBase64, 'base64').toString('utf8');
            } catch (e) {
                content = '';
            }
        }

        if (!content || !content.trim()) {
            return res.status(400).json({ success: false, error: 'No subtitle content provided to translate.' });
        }

        const keyPool = textKeys([apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]);
        if (!keyPool.length) {
            return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'API key is required.' });
        }

        const abortCtrl = new AbortController();
        if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);
        const jobStartedAt = Date.now();

        try {
            const genreRegister = genre || dramaRegister || 'historical';
            const genreGuidance = getKhmerDramaRegisterGuidance(genreRegister);
            const glossaryHint = glossary ? `\n\nCUSTOM CHARACTER / GLOSSARY DICTIONARY (STRICTLY USE THESE TRANSLATIONS):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : '';

            const sourceLines = parseSrtBlocksForTranslate(content);
            if (sourceLines.length === 0) {
                return res.status(400).json({ success: false, error: 'No subtitle lines found in the SRT.' });
            }

            const results = new Array(sourceLines.length).fill(null);
            const rawParts = [];
            const usage = createTokenUsage();

            const sheet = await prepareCharacterSheet({
                lines: sourceLines, sourceFilePath, glossary, glossaryHint, keys: keyPool, model, signal: abortCtrl.signal, usage
            });
            if (abortCtrl.signal.aborted) return res.json({ success: false, error: 'CANCELLED' });
            const sheetHint = formatSheetForPrompt(sheet);
            const systemInstruction = { parts: [{ text: buildTranslateSystemPrompt({ genreGuidance }) }] };

            const translateBatch = async (key, indexes, previousLines, preferBackup = false) => {
                const payload = {
                    systemInstruction,
                    contents: [{
                        role: 'user',
                        parts: [{ text: buildTranslateUserPrompt({
                            lines: indexes.map(i => translatePromptLine(i, sourceLines[i])),
                            glossaryHint, sheetHint, previousLines
                        }) }]
                    }],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        responseSchema: TRANSLATE_RESPONSE_SCHEMA,
                        maxOutputTokens: 32768
                    }
                };
                const result = await generateText(key, model, payload, abortCtrl.signal, { preferBackup, thinking: 'low' });
                if (!result.success) return result;
                addTokenUsage(usage, result);
                rawParts.push(result.text || '');
                const wanted = new Set(indexes);
                for (const item of parseJsonArrayLoose(result.text) || []) {
                    const i = Number(item && item.i);
                    if (!wanted.has(i)) continue;
                    let clean = sanitizeKhmerDialogue(item.text || '');
                    if (glossary) clean = applyGlossary(clean, glossary);
                    if (clean && KHMER_CHAR_RE.test(clean)) results[i] = { ...item, text: clean, ...(sourceLines[i].gender && { gender: sourceLines[i].gender }) };
                }
                return result;
            };

            const batchStarts = [];
            for (let start = 0; start < sourceLines.length; start += TRANSLATE_BATCH_SIZE) batchStarts.push(start);
            const laneCount = Math.max(1, Math.min(textLaneCount(keyPool), TRANSCRIBE_MAX_LANES, batchStarts.length));
            let failure = null;

            const runLane = async (lane) => {
                const keys = textLaneKeys(keyPool, lane);
                const from = Math.floor(lane * batchStarts.length / laneCount);
                const to = Math.floor((lane + 1) * batchStarts.length / laneCount);
                for (let b = from; b < to; b++) {
                    if (failure || abortCtrl.signal.aborted) return;
                    const start = batchStarts[b];
                    const indexes = [];
                    for (let i = start; i < Math.min(start + TRANSLATE_BATCH_SIZE, sourceLines.length); i++) indexes.push(i);
                    const previousLines = [];
                    for (let i = Math.max(0, start - 4); i < start; i++) {
                        if (results[i]) previousLines.push({ source: sourceLines[i].text, text: results[i].text, gender: results[i].gender });
                        else if (sourceLines[i].text) previousLines.push({ source: sourceLines[i].text, gender: sourceLines[i].gender });
                    }

                    const attempt = async (idx, preferBackup = false) => {
                        let r = null;
                        let otherRetries = 0;
                        const startedAt = Date.now();
                        for (let retry = 0; ; retry++) {
                            const out = await tryKeysOnce(keys, async (key) => {
                                const res = await translateBatch(key, idx, previousLines, preferBackup);
                                return res.success ? { ok: true, res } : { ok: false, result: res };
                            });
                            r = out.ok ? out.res : out.result;
                            if (r.success || failure || !geminiShouldRetry(r, otherRetries, startedAt)) return r;
                            const busy = isGeminiBusy(r);
                            const wait = geminiRetryWaitMs(r, busy ? retry : otherRetries);
                            console.warn(`[Translate] ${r.error === 'RATE_LIMIT_EXCEEDED' ? 'Rate-limited' : 'Google busy'}, retrying lines ${idx[0] + 1}-${idx[idx.length - 1] + 1} in ${Math.round(wait / 1000)}s: ${r.message || r.error}`);
                            if (!busy) otherRetries++;
                            await sleepAbortable(wait, abortCtrl.signal);
                        }
                    };
                    const result = await attempt(indexes);
                    if (!result.success) { failure = failure || result; return; }

                    const missing = indexes.filter(i => !results[i] && sourceLines[i].text);
                    if (missing.length) {
                        console.warn(`[Translate] Retrying ${missing.length} skipped line(s)`);
                        const retry = await attempt(missing, true);
                        if (!retry.success) { failure = failure || retry; return; }
                    }
                }
            };

            await Promise.all(Array.from({ length: laneCount }, (_, lane) => runLane(lane).catch((e) => {
                if (e.name !== 'AbortError') failure = failure || { status: 500, error: e.message };
            })));
            if (abortCtrl.signal.aborted) return res.json({ success: false, error: 'CANCELLED' });
            if (failure) return geminiFailureResponse(res, failure);

            let reviewed = 0;
            let fitted = 0;
            try {
                if (review !== false) {
                    reviewed = await reviewKhmerLines({
                        lines: sourceLines.map(l => ({ source: l.text, gender: l.gender, seconds: l.seconds })),
                        texts: results.map(r => r && r.text),
                        apply: (i, text) => { results[i] = { ...results[i], text, reviewed: true }; },
                        genre: genreRegister, glossary, glossaryHint, sheetHint, keyPool, model, signal: abortCtrl.signal, usage, tag: 'Translate'
                    });
                }
                fitted = await fitOverlongLines({
                    lines: sourceLines, texts: results.map(r => r && r.text),
                    apply: (i, text) => { results[i] = { ...results[i], text, fitted: true }; },
                    genre: genreRegister, glossary, keyPool, model, signal: abortCtrl.signal, usage, sheetHint, tag: 'Translate'
                });
            } catch (e) {
                if (e.name === 'AbortError' || abortCtrl.signal.aborted) return res.json({ success: false, error: 'CANCELLED' });
                throw e;
            }
            console.log(`[Translate] ${sourceLines.length} lines: ${formatTokenUsage(usage)}`);

            res.json({
                success: true,
                data: results,
                rawText: rawParts.join('\n'),
                notice: textAiNotice(jobStartedAt),
                usage,
                reviewed,
                fitted,
                sheet: sheet ? { names: sheet.characters.length, address: sheet.address.length, terms: sheet.terms.length } : null
            });
        } catch (e) {
            if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
            res.status(500).json({ success: false, error: e.message });
        } finally {
            if (requestId) activeTranscribeRequests.delete(requestId);
        }
    });

    // ── Detect emotions route ──
    router.post('/detect-emotions', async (req, res) => {
        const { lines, genre = 'historical', apiKey, apiKeys, model = 'gemini-3.8-flash', requestId } = req.body || {};
        if (!Array.isArray(lines) || !lines.length) {
            return res.status(400).json({ success: false, error: 'No lines to read.' });
        }
        const keyPool = textKeys([apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]);
        if (!keyPool.length) {
            return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'API key is required.' });
        }
        const items = lines.slice(0, 5000).map((l, i) => ({
            i,
            text: String((l && l.text) || '').slice(0, 400),
            ...(l && (l.gender === 'Male' || l.gender === 'Female') && { gender: l.gender })
        }));
        const abortCtrl = new AbortController();
        if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);
        try {
            const results = new Array(items.length).fill(null);
            const batches = [];
            for (let s = 0; s < items.length; s += EMOTION_BATCH) batches.push(items.slice(s, s + EMOTION_BATCH));
            const laneCount = Math.max(1, Math.min(textLaneCount(keyPool), TRANSCRIBE_MAX_LANES, batches.length));
            let failure = null;

            const runLane = async (lane) => {
                const keys = textLaneKeys(keyPool, lane);
                const from = Math.floor(lane * batches.length / laneCount);
                const to = Math.floor((lane + 1) * batches.length / laneCount);
                for (let b = from; b < to; b++) {
                    if (failure || abortCtrl.signal.aborted) return;
                    const chunk = batches[b];
                    const payload = {
                        systemInstruction: { parts: [{ text: EMOTION_SYSTEM_PROMPT }] },
                        contents: [{ role: 'user', parts: [{ text: JSON.stringify(chunk) }] }],
                        generationConfig: { responseMimeType: 'application/json', responseSchema: EMOTION_RESPONSE_SCHEMA, maxOutputTokens: 8192 }
                    };
                    const out = await geminiWithKeys(keys, async (key) => {
                        const r = await generateText(key, model, payload, abortCtrl.signal, { thinking: 'low' });
                        return r.success ? { ok: true, items: parseJsonArrayLoose(r.text) || [] } : { ok: false, result: r };
                    }, abortCtrl.signal);
                    if (!out.ok) { failure = failure || out.result; return; }
                    for (const it of out.items) {
                        const i = Number(it && it.i);
                        if (i >= 0 && i < results.length && it.emotion && TRANSCRIBE_EMOTIONS.includes(it.emotion)) results[i] = it.emotion;
                    }
                }
            };

            await Promise.all(Array.from({ length: laneCount }, (_, lane) => runLane(lane).catch((e) => {
                if (e.name !== 'AbortError') failure = failure || { status: 500, error: e.message };
            })));
            if (abortCtrl.signal.aborted) return res.json({ success: false, error: 'CANCELLED' });
            if (failure) return geminiFailureResponse(res, failure);

            res.json({ success: true, emotions: results.map(e => e || 'Neutral') });
        } catch (e) {
            if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
            res.status(500).json({ success: false, error: e.message });
        } finally {
            if (requestId) activeTranscribeRequests.delete(requestId);
        }
    });

    // ── Rewrite dialogue route ──
    router.post('/rewrite-dialogue', async (req, res) => {
        const {
            text,
            originalText,
            mode = 'shorten',
            genre = 'historical',
            glossary,
            apiKey,
            apiKeys,
            model = 'gemini-3.8-flash',
            requestId
        } = req.body;

        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'No dialogue text provided.' });
        }

        const keyPool = textKeys([apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]);
        if (!keyPool.length) {
            return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'API key is required.' });
        }

        if (mode === 'shorten') {
            const abortCtrl = new AbortController();
            if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);
            try {
                const out = await shortenLines({
                    items: [{ id: '0', text, seconds: lineSeconds(req.body), originalText }],
                    genre, glossary, keyPool, model,
                    signal: abortCtrl.signal, strength: 'shorter'
                });
                if (!out.ok) return res.status(out.result.status || 500).json({ success: false, error: out.result.message || out.result.error || 'REWRITE_FAILED' });
                if (!out.results.length) return res.status(502).json({ success: false, error: 'The AI did not return a shorter line. Please try again.' });
                return res.json({ success: true, rewrittenText: out.results[0].text, mode });
            } catch (e) {
                if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
                return res.status(500).json({ success: false, error: e.message });
            } finally {
                if (requestId) activeTranscribeRequests.delete(requestId);
            }
        }

        let instruction = '';
        if (mode === 'dramatic') {
            instruction = 'Rewrite this Khmer dialogue line to sound deeply dramatic, intense, cinematic, and emotional for film/drama dubbing. Keep names and meaning accurate.';
        } else if (mode === 'royal') {
            instruction = 'Rewrite this Khmer dialogue line using refined historical/royal Khmer vocabulary (រាជស័ព្ទ / ភាសាបុរាណ) appropriate for historical kings, queens, and court ministers. Keep the exact original meaning.';
        } else if (mode === 'comedy') {
            instruction = 'Rewrite this Khmer dialogue line to sound funny, witty, playful, and hilarious for Khmer comedy dubbing while keeping the core intent and character names intact.';
        } else {
            instruction = 'Rewrite this Khmer dialogue line into natural, speakable, fluent modern spoken Khmer.';
        }

        const glossaryHint = glossary ? `\n\nGLOSSARY RULES:\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : '';
        const prompt = `You are a professional film/drama subtitle and dialogue adapter.
Instruction: ${instruction}
Register / Genre: ${genre}
Original foreign line (reference only): "${originalText || ''}"
Current Khmer line: "${text}"
${glossaryHint}

Respond ONLY with a JSON object: { "rewrittenText": "..." }`;

        const payload = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'OBJECT',
                    properties: { rewrittenText: { type: 'STRING' } },
                    required: ['rewrittenText']
                }
            }
        };

        const abortCtrl = new AbortController();
        if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);

        try {
            const geminiResult = await generateTextForKey(apiKey, model, payload, abortCtrl.signal);
            if (!geminiResult.success) {
                return res.status(geminiResult.status || 500).json({
                    success: false,
                    error: geminiResult.message || geminiResult.error || 'REWRITE_FAILED'
                });
            }
            let rewritten = '';
            try {
                const parsed = JSON.parse(geminiResult.text);
                rewritten = parsed.rewrittenText || '';
            } catch (e) {
                rewritten = geminiResult.text.trim();
            }
            rewritten = sanitizeKhmerDialogue(rewritten);
            if (glossary) rewritten = applyGlossary(rewritten, glossary);
            res.json({ success: true, rewrittenText: rewritten, mode });
        } catch (e) {
            if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
            res.status(500).json({ success: false, error: e.message });
        } finally {
            if (requestId) activeTranscribeRequests.delete(requestId);
        }
    });

    // ── Refactor subtitles batch route ──
    router.post('/refactor-subtitles-batch', async (req, res) => {
        const {
            subtitles: rawSubtitles = [],
            mode = 'natural',
            genre = 'historical',
            dramaRegister,
            glossary,
            apiKey,
            apiKeys,
            model = 'gemini-3.8-flash',
            requestId
        } = req.body;

        const subtitles = Array.isArray(rawSubtitles) ? rawSubtitles : [];
        if (subtitles.length === 0) {
            return res.status(400).json({ success: false, error: 'No subtitles provided for refactoring.' });
        }

        const keyPool = textKeys([apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]);
        if (!keyPool.length) {
            return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'Gemini API key is required in Settings.' });
        }

        if (mode === 'shorten') {
            const abortCtrl = new AbortController();
            if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);
            try {
                const items = subtitles
                    .map((s, i) => ({ id: String(s.id ?? i), text: s.text || '', seconds: lineSeconds(s), originalText: s.originalText || '' }))
                    .filter(s => s.text.trim());
                const out = await shortenLines({
                    items, genre: genre || dramaRegister || 'historical', glossary,
                    keyPool, model, signal: abortCtrl.signal, strength: 'shorter'
                });
                if (!out.ok) return geminiFailureResponse(res, out.result);
                const byId = new Map(out.results.map(r => [r.id, r.text]));
                const refactored = subtitles.map((s, i) => {
                    const id = String(s.id ?? i);
                    return byId.has(id) ? { ...s, text: byId.get(id) } : s;
                });
                return res.json({ success: true, subtitles: refactored, count: out.results.length, mode });
            } catch (e) {
                if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
                return res.status(500).json({ success: false, error: e.message });
            } finally {
                if (requestId) activeTranscribeRequests.delete(requestId);
            }
        }

        let modeInstruction = '';
        if (mode === 'dramatic') {
            modeInstruction = 'Make every dialogue line sound intensely cinematic, emotional, dramatic, and impactful for movie dubbing.';
        } else if (mode === 'royal') {
            modeInstruction = 'Translate and polish every dialogue line into elegant historical/royal court Khmer (រាជស័ព្ទ / ភាសាបុរាណ) appropriate for ancient court characters.';
        } else if (mode === 'comedy') {
            modeInstruction = 'Rewrite dialogue lines to be delightfully humorous, witty, playful, and funny for comedic dubbing.';
        } else {
            modeInstruction = 'Make dialogue lines sound 100% natural, speakable, fluent, and authentic modern spoken Khmer for dubbing.';
        }

        const glossaryHint = glossary ? `\n\nCUSTOM CHARACTER / GLOSSARY RULES (MUST FOLLOW):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : '';
        const linesData = subtitles.map((s, i) => ({
            id: s.id ?? i,
            original: s.originalText || '',
            text: s.text || ''
        }));

        const BATCH_SIZE = 40;
        const batches = [];
        for (let i = 0; i < linesData.length; i += BATCH_SIZE) {
            batches.push(linesData.slice(i, i + BATCH_SIZE));
        }

        const abortCtrl = new AbortController();
        if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);

        try {
            const resultsMap = new Map();
            for (let b = 0; b < batches.length; b++) {
                if (abortCtrl.signal.aborted) throw new Error('AbortError');
                const chunk = batches[b];
                const prompt = `You are a master script adapter and voice dubbing director specializing in Asian drama localization into spoken Khmer.

GOAL:
${modeInstruction}

RULES:
- Maintain dialogue meaning and emotional context.
- Keep character names consistent.
- Size lines naturally so they can be spoken at normal speed.
- Output ONLY valid JSON: [ { "id": <same id>, "text": "<refactored line>" }, ... ]
${glossaryHint}

DIALOGUE LINES TO REFACTOR:
${JSON.stringify(chunk)}`;

                const payload = {
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: 'application/json',
                        responseSchema: {
                            type: 'ARRAY',
                            items: {
                                type: 'OBJECT',
                                properties: {
                                    id: { type: 'STRING' },
                                    text: { type: 'STRING' }
                                },
                                required: ['id', 'text']
                            }
                        }
                    }
                };

                const geminiResult = await generateTextForKey(apiKey, model, payload, abortCtrl.signal);
                if (!geminiResult.success) {
                    return res.status(geminiResult.status || 500).json({
                        success: false,
                        error: geminiResult.message || geminiResult.error || `Failed at batch ${b + 1}`
                    });
                }

                let items = [];
                try {
                    items = JSON.parse(geminiResult.text);
                } catch (e) {
                    const match = geminiResult.text.match(/\[[\s\S]*\]/);
                    if (match) items = JSON.parse(match[0]);
                }

                if (Array.isArray(items)) {
                    for (const item of items) {
                        if (item && item.id !== undefined && item.text) {
                            let clean = sanitizeKhmerDialogue(item.text);
                            if (glossary) clean = applyGlossary(clean, glossary);
                            resultsMap.set(String(item.id), clean);
                        }
                    }
                }
            }

            const refactoredSubtitles = subtitles.map((s, i) => {
                const idStr = String(s.id ?? i);
                if (resultsMap.has(idStr)) {
                    return { ...s, text: resultsMap.get(idStr) };
                }
                return s;
            });

            res.json({
                success: true,
                subtitles: refactoredSubtitles,
                count: resultsMap.size,
                mode
            });
        } catch (e) {
            if (e.name === 'AbortError' || e.message === 'AbortError') {
                return res.json({ success: false, error: 'CANCELLED' });
            }
            res.status(500).json({ success: false, error: e.message });
        } finally {
            if (requestId) activeTranscribeRequests.delete(requestId);
        }
    });

    // ── Condense fast subtitles route ──
    router.post('/condense-fast-subtitles', async (req, res) => {
        const {
            subtitles: rawSubtitles = [],
            targetLanguage = 'Khmer',
            genre = 'historical',
            dramaRegister,
            glossary,
            apiKey,
            apiKeys,
            model = 'gemini-3.8-flash',
            requestId
        } = req.body;

        const subtitles = Array.isArray(rawSubtitles) ? rawSubtitles : [];
        if (subtitles.length === 0) {
            return res.status(400).json({ success: false, error: 'No subtitles provided for condensing.' });
        }

        const keyPool = textKeys([apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]);
        if (!keyPool.length) {
            return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'API key is required in Settings.' });
        }

        const abortCtrl = new AbortController();
        if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);

        try {
            const items = subtitles
                .map((s, i) => ({ id: String(s.id ?? i), text: s.text || '', seconds: lineSeconds(s), speed: s.speed, originalText: s.originalText || '' }))
                .filter(s => s.text.trim());
            const out = await shortenLines({
                items, targetLanguage, genre: genre || dramaRegister || 'historical', glossary,
                keyPool, model, signal: abortCtrl.signal, strength: 'fit'
            });
            if (!out.ok) return geminiFailureResponse(res, out.result);
            const byId = new Map(out.results.map(r => [r.id, r.text]));
            const condensedSubtitles = subtitles.map((s, i) => {
                const id = String(s.id ?? i);
                return byId.has(id) ? { ...s, text: byId.get(id) } : s;
            });
            res.json({ success: true, subtitles: condensedSubtitles, condensedCount: out.results.length });
        } catch (e) {
            if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
            res.status(500).json({ success: false, error: e.message });
        } finally {
            if (requestId) activeTranscribeRequests.delete(requestId);
        }
    });

    // ── Translate missing lines route ──
    router.post('/translate-missing-lines', async (req, res) => {
        const { lines: rawLines = [], targetLanguage = 'Khmer', genre = 'historical', glossary, apiKey, apiKeys, model = 'gemini-3.8-flash', sourceFilePath, requestId, lastResortKeys } = req.body || {};
        const items = (Array.isArray(rawLines) ? rawLines : []).filter(l => l && l.id !== undefined && String(l.onScreen || '').trim()).slice(0, 200);
        if (!items.length) return res.json({ success: true, results: [] });
        const keyPool = textKeys([apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]);
        if (keyPool.length === 0) {
            return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'Gemini API key is required in Settings.' });
        }
        const abortCtrl = new AbortController();
        if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);
        try {
            const isKhmer = /khmer|^km/i.test(String(targetLanguage));
            const registerGuidance = isKhmer ? getKhmerDramaRegisterGuidance(genre || 'historical') : '';
            const savedSheet = sourceFilePath ? loadSeriesSheet(CHARACTER_SHEETS_DIR, sourceFilePath) : null;
            const glossaryHint = (glossary ? `\n\nGLOSSARY (keep these names/terms exactly as given):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary, null, 2)}` : '')
                + formatSheetForPrompt(savedSheet && applyGlossaryToSheet(savedSheet, glossary));
            const payload = {
                contents: [{ role: 'user', parts: [{ text: buildMissingLinesPrompt({ items, targetLanguage, registerGuidance, glossaryHint }) }] }],
                generationConfig: { responseMimeType: 'application/json', responseSchema: MISSING_RESPONSE_SCHEMA }
            };
            const ask = (pool) => geminiWithKeys(pool, async (key) => {
                const r = await generateText(key, model, payload, abortCtrl.signal, { timeoutMs: GEMINI_TEXT_TIMEOUT_MS, thinking: 'low' });
                if (!r.success) return { ok: false, result: r };
                const parsed = parseJsonArrayLoose(r.text);
                if (!Array.isArray(parsed)) return { ok: false, result: { status: 502, error: 'JSON_PARSE_ERROR', message: 'The AI did not return a list of lines.' } };
                return { ok: true, parsed };
            }, abortCtrl.signal, { retries: GEMINI_RETRY_DELAYS_MS.length });
            let out = await ask(keyPool);
            // The series' last check before export (every subtitle on screen has a voice): no Gmail
            // answered, so an API key from Settings does - even with "Gmails only" on. A few short
            // lines a series; the other way is a silent line in the export (2026-11-09: 6 subtitles
            // in a row at the end of a piece went out silent).
            let via = 'pool';
            const rescue = (Array.isArray(lastResortKeys) ? lastResortKeys : []).map(k => String(k || '').trim())
                .filter((k, i, a) => k && a.indexOf(k) === i && !isGeminiWebKey(k) && !keyPool.includes(k));
            if (!out.ok && !abortCtrl.signal.aborted && rescue.length) {
                console.warn(`[Missing lines] no Gmail answered (${(out.result && (out.result.error || out.result.code)) || 'failed'}) - asking an API key`);
                out = await ask(rescue);
                via = 'API key';
            }
            if (!out.ok) {
                console.warn(`[Missing lines] ${items.length} subtitle(s) got no answer: ${(out.result && (out.result.message || out.result.error)) || 'failed'}`);
                return geminiFailureResponse(res, out.result);
            }
            const asked = new Set(items.map(it => String(it.id)));
            const results = [];
            for (const answer of out.parsed) {
                const ok = checkMissingLine(answer, { isKhmer });
                if (!ok || !asked.has(ok.id)) continue;
                asked.delete(ok.id);
                let text = isKhmer ? sanitizeKhmerDialogue(ok.text) : ok.text;
                if (glossary) text = applyGlossary(text, glossary);
                if (text) results.push({ ...ok, text });
            }
            console.log(`[Missing lines] ${items.length} subtitle(s) with no line: ${results.length} got one, ${items.length - results.length} not speech${via === 'pool' ? '' : ` (via ${via})`}`);
            res.json({ success: true, results });
        } catch (e) {
            if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
            res.status(500).json({ success: false, error: e.message });
        } finally {
            if (requestId) activeTranscribeRequests.delete(requestId);
        }
    });

    // Joined lines cut at their pauses (lib/split-lines.js): { items: [{ id, line, original, parts }] }
    // -> { results: [{ id, parts }] }; an item whose split did not pass checkSplitLine is left out
    // (the line stays as it was).
    router.post('/split-joined-lines', async (req, res) => {
        const { items: rawItems = [], targetLanguage = 'Khmer', apiKey, apiKeys, model = 'gemini-3.8-flash', requestId } = req.body || {};
        const items = (Array.isArray(rawItems) ? rawItems : []).filter(it => it && it.id !== undefined && String(it.line || '').trim() && Array.isArray(it.parts) && it.parts.length >= 2).slice(0, 120);
        if (!items.length) return res.json({ success: true, results: [] });
        const keyPool = textKeys([apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]);
        if (keyPool.length === 0) {
            return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'Gemini API key is required in Settings.' });
        }
        const abortCtrl = new AbortController();
        if (requestId) activeTranscribeRequests.set(requestId, abortCtrl);
        try {
            const isKhmer = /khmer|^km/i.test(String(targetLanguage));
            const payload = {
                contents: [{ role: 'user', parts: [{ text: buildSplitLinesPrompt({ items, targetLanguage }) }] }],
                generationConfig: { responseMimeType: 'application/json', responseSchema: SPLIT_RESPONSE_SCHEMA }
            };
            const out = await geminiWithKeys(keyPool, async (key) => {
                const r = await generateText(key, model, payload, abortCtrl.signal, { timeoutMs: GEMINI_TEXT_TIMEOUT_MS, thinking: 'low' });
                if (!r.success) return { ok: false, result: r };
                const parsed = parseJsonArrayLoose(r.text);
                if (!Array.isArray(parsed)) return { ok: false, result: { status: 502, error: 'JSON_PARSE_ERROR', message: 'The AI did not return a list of lines.' } };
                return { ok: true, parsed };
            }, abortCtrl.signal, { retries: GEMINI_RETRY_DELAYS_MS.length });
            if (!out.ok) return geminiFailureResponse(res, out.result);
            const byId = new Map(items.map(it => [String(it.id), it]));
            const results = [];
            for (const answer of out.parsed) {
                const item = answer && byId.get(String(answer.id));
                const parts = checkSplitLine(answer, item, { isKhmer });
                if (!parts) continue;
                byId.delete(String(answer.id));
                results.push({ id: String(answer.id), parts: isKhmer ? parts.map(p => sanitizeKhmerDialogue(p) || p) : parts });
            }
            console.log(`[Split lines] ${items.length} joined line(s) with pauses: ${results.length} cut into parts`);
            res.json({ success: true, results });
        } catch (e) {
            if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
            res.status(500).json({ success: false, error: e.message });
        } finally {
            if (requestId) activeTranscribeRequests.delete(requestId);
        }
    });

    // ── Transcribe progress ──
    router.get('/transcribe-progress', (req, res) => {
        const p = transcribeProgress.get(String(req.query.requestId || ''));
        res.json(p ? { success: true, ...p } : { success: false });
    });

    // ── Gemini key status ──
    router.post('/gemini-key-status', (req, res) => {
        const keys = (Array.isArray(req.body?.keys) ? req.body.keys : []).map(k => String(k || '').trim()).filter(Boolean);
        res.json({ success: true, keys: keys.map(k => ({ suffix: k.slice(-4), ...geminiKeyStatus(k) })) });
    });

    // ── Check limits: every model a job would use, on every key ──
    // The app only learns a key's limits from Google's answers, so a key another computer used up
    // shows as "Not checked today" until it is asked. This asks each key's job models (the chosen
    // one and its backups, getCandidateModels) with one tiny request each, 6 keys at a time, and
    // lists per model: ready, per-minute limit, out for today, no quota on this plan (Google's
    // "limit: 0"), not available to the key, or Google busy. A used-up model is refused at no
    // cost; one that still works spends a single request. Models already resting, closed to the
    // key or busy at Google are not asked. Keys parked as a whole (invalid / out) are not asked.
    // Why every model, not just the chosen one: on 2026-11-14 gemini-3.8-flash did not answer
    // "Reply with OK" in 90s while 3.6 Flash answered in 7s - asking only the chosen model timed
    // out every key and said nothing about the backups a job would run on.
    let checkProgress = { running: false, total: 0, done: 0 };
    router.get('/gemini-check-limits/progress', (req, res) => res.json({ success: true, ...checkProgress }));

    // What the app knows about one model of one key, without asking Google.
    function knownModelState(key, m) {
        if (isGeminiModelGone(key, m)) return { model: m, state: 'gone' };
        const c = geminiModelCooldowns.get(`${key}|${m}`);
        if (c && c.until > Date.now()) {
            return { model: m, state: c.daily ? 'daily' : 'minute', retryAfterMs: c.until - Date.now(), noQuota: /limit:\s*0\b/.test(c.msg || '') };
        }
        if (isGeminiModelBusy(m)) return { model: m, state: 'busy' };
        return null;
    }

    router.post('/gemini-check-limits', async (req, res) => {
        const keys = [...new Set((Array.isArray(req.body?.keys) ? req.body.keys : []).map(k => String(k || '').trim()).filter(Boolean))];
        const model = String(req.body?.model || 'gemini-3.8-flash');
        const payload = { contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 8 } };
        const resting = (k) => ['invalid', 'daily', 'cooling'].includes(geminiKeyStatus(k).state);
        const todo = keys.filter(k => !resting(k));
        const results = new Map(); // key -> verdict for the whole key
        const checks = new Map();  // key -> [{ model, state, retryAfterMs?, noQuota?, asked }]
        let next = 0;
        checkProgress = { running: true, total: todo.length, done: 0 };

        async function checkModel(key, m) {
            const known = knownModelState(key, m);
            if (known) return { ...known, asked: false };
            const r = await executeGeminiGenerate(key, m, payload, null, { onlyModel: true, timeoutMs: GEMINI_CHECK_TIMEOUT_MS });
            if (r.success) return { model: m, state: 'ok', asked: true };
            if (r.error === 'INVALID_API_KEY') return { model: m, state: 'invalid', asked: true, message: r.message || '', r };
            const after = knownModelState(key, m);
            if (after) return { ...after, asked: true };
            if (r.code === 'OVERLOADED' || Number(r.status) === 503) return { model: m, state: 'busy', asked: true };
            return { model: m, state: 'error', asked: true, message: String(r.message || r.error || '').slice(0, 200) };
        }

        // "Busy" on every model of the first keys: the other keys would only be busy too
        // (seen: 32 keys, 2.5 min, all "high demand") - stop and say so.
        const BUSY_STOP = 6;
        let busyRun = 0, stoppedBusy = false;
        await Promise.all(Array.from({ length: Math.min(6, todo.length) }, async () => {
            while (next < todo.length && !stoppedBusy) {
                const key = todo[next++];
                let verdict = 'error';
                try {
                    const models = await getCandidateModels(key, model, null);
                    const list = await Promise.all(models.map(m => checkModel(key, m).catch(e => ({ model: m, state: 'error', asked: true, message: e.message }))));
                    // A whole-key refusal is parked the way tryKeysOnce does it.
                    const refused = list.find(x => x.state === 'invalid');
                    if (refused) {
                        const dead = isDeadKeyAnswer(key, refused.r);
                        invalidGeminiKeys.set(key, { until: Date.now() + (dead ? DEAD_KEY_REST_MS : INVALID_KEY_REST_MS), dead, message: refused.message });
                    }
                    checks.set(key, list.map(({ r, ...x }) => x));
                    const has = (s) => list.some(x => x.state === s);
                    verdict = has('ok') ? 'ok' : refused ? 'refused' : has('busy') ? 'busy' : (has('minute') || has('daily')) ? 'limited' : 'refused';
                } catch (e) { }
                results.set(key, verdict);
                busyRun = verdict === 'busy' ? busyRun + 1 : 0;
                if (busyRun >= BUSY_STOP && ![...results.values()].some(v => v !== 'busy')) stoppedBusy = true;
                checkProgress.done = results.size;
            }
        }));
        checkProgress = { running: false, total: todo.length, done: results.size };
        const count = (v) => [...results.values()].filter(x => x === v).length;
        const notAsked = todo.length - results.size;
        // Per model: on how many keys it is ready / resting.
        const models = {};
        for (const list of checks.values()) for (const x of list) {
            const s = models[x.model] || (models[x.model] = { ready: 0, minute: 0, daily: 0, noQuota: 0, other: 0 });
            if (x.state === 'ok') s.ready++;
            else if (x.noQuota) s.noQuota++;
            else if (x.state === 'minute') s.minute++;
            else if (x.state === 'daily') s.daily++;
            else s.other++;
        }
        console.log(`[Gemini] Check limits on ${model}: ${keys.length} key(s), ${keys.length - todo.length} already resting, ${count('ok')} ready, ${count('limited')} limited, ${count('refused')} refused, ${count('busy')} busy` +
            (Object.keys(models).length ? ` - per model: ${Object.entries(models).map(([m, s]) => `${m} ${s.ready} ready/${s.minute} minute/${s.daily} day/${s.noQuota} no quota`).join(', ')}` : '') +
            (stoppedBusy ? ` - stopped: Google is overloaded on every model, ${notAsked} not asked` : ''));
        res.json({
            success: true,
            asked: results.size,
            alreadyResting: keys.length - todo.length,
            ready: count('ok'), limited: count('limited'), refused: count('refused'), busy: count('busy'),
            stoppedBusy, notAsked, models, chosenBusy: isGeminiModelBusy(resolveGeminiModel(model)),
            keys: keys.map(k => ({ suffix: k.slice(-4), ...geminiKeyStatus(k), ...(checks.has(k) ? { checks: checks.get(k) } : {}) }))
        });
    });

    // ── Gemini keys added ──
    router.post('/gemini-keys-added', (req, res) => {
        const keys = (Array.isArray(req.body?.keys) ? req.body.keys : []).map(k => String(k || '').trim()).filter(Boolean);
        keys.forEach(k => invalidGeminiKeys.delete(k));
        res.json({ success: true });
    });

    // ── Text AI settings ──
    router.post('/text-ai', (req, res) => {
        const b = req.body || {};
        const provider = b.provider === 'codecraft' ? 'codecraft' : 'gemini';
        const keys = (Array.isArray(b.keys) ? b.keys : [b.key]).map(k => String(k || '').trim()).filter((k, i, a) => k && a.indexOf(k) === i);
        const model = String(b.model || '').trim();
        const backupModel = String(b.backupModel || '').trim();
        for (const k of textAi.keys) if (!keys.includes(k)) { textAi.issues.delete(k); textAi.okAt.delete(k); }
        for (const k of keys) if (!textAi.keys.includes(k)) { invalidGeminiKeys.delete(k); rateLimitedGeminiKeys.delete(k); }
        Object.assign(textAi, { provider, keys, model, backupModel: backupModel === model ? '' : backupModel });
        res.json({ success: true, active: codecraftActive() });
    });

    // ── CodeCraft keys ──
    router.post('/codecraft/keys', async (req, res) => {
        const b = req.body || {};
        const keys = (Array.isArray(b.keys) ? b.keys : []).map(k => String(k || '').trim()).filter(Boolean).slice(0, 20);
        if (!keys.length) return res.status(400).json({ success: false, error: 'Enter your CodeCraft API key.' });
        const abortCtrl = new AbortController();
        res.on('close', () => { if (!res.writableFinished) abortCtrl.abort(); });
        try {
            let models = null;
            const statuses = await Promise.all(keys.map(async (key) => {
                let probe = null;
                if (b.probe) {
                    probe = await codecraft.listModels(key, abortCtrl.signal);
                    if (probe.success) {
                        invalidGeminiKeys.delete(key);
                        rateLimitedGeminiKeys.delete(key);
                        textAi.issues.delete(key);
                        if (!models) models = probe.models;
                    }
                }
                return { suffix: key.slice(-4), ...codecraftKeyStatus(key, probe) };
            }));
            res.json({ success: true, keys: statuses, models });
        } catch (e) {
            if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Cancel transcribe ──
    router.post('/cancel-transcribe', (req, res) => {
        const { requestId } = req.body;
        if (requestId && activeTranscribeRequests.has(requestId)) {
            const ctrl = activeTranscribeRequests.get(requestId);
            ctrl.abort();
            activeTranscribeRequests.delete(requestId);
        }
        res.json({ success: true });
    });

    // ── Suggest movie title ──
    router.post('/suggest-movie-title', async (req, res) => {
        const { originalTitle = '', subtitlesContent = '', projectSubtitles, genre = 'historical', glossary, apiKey, apiKeys, model = 'gemini-3.8-flash', count = 8, notes = '' } = req.body || {};
        const keyPool = textKeys([apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]);
        if (!keyPool.length) return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'Gemini API key is required.' });

        const fromProject = Array.isArray(projectSubtitles)
            ? projectSubtitles.map(s => [s.originalText, s.text].map(x => String(x || '').trim()).filter(Boolean).join(' => ')).filter(Boolean)
            : [];
        const dialogue = sampleDialogue([...fromProject, ...srtToDialogueLines(subtitlesContent)], TITLE_SAMPLE_CHARS);
        if (!String(originalTitle).trim() && dialogue.length < 5) {
            return res.status(400).json({ success: false, error: 'Enter the original title, or open a project / add subtitle files so the story can be read.' });
        }
        const n = Math.min(12, Math.max(3, parseInt(count, 10) || 8));
        const glossaryHint = glossary ? `\nCHARACTER / NAME GLOSSARY (use these Khmer names):\n${typeof glossary === 'string' ? glossary : JSON.stringify(glossary)}\n` : '';

        const prompt = `You are a top Cambodian YouTube/Facebook editor who names dubbed Chinese dramas (short dramas, C-dramas) for a Khmer audience. Great titles get clicks without lying about the story.

TASK: Read the story below and write ${n} different Khmer titles for the dubbed drama, plus a short Khmer synopsis.
${String(originalTitle).trim() ? `\nORIGINAL TITLE: ${String(originalTitle).trim()}` : ''}
GENRE / REGISTER: ${genre}${notes ? `\nCREATOR NOTES: ${notes}` : ''}
${glossaryHint}
TITLE RULES:
- Natural, catchy spoken Khmer - the way Cambodian drama channels actually title videos. No stiff textbook phrasing, no literal word-for-word translation of the original title.
- Each title 6-18 Khmer words; one strong hook: the twist, the relationship, the revenge, the secret identity, the status reversal.
- Mix of styles across the ${n} titles, e.g. dramatic hook, emotional/romantic, mystery/suspense, revenge/power reversal, short & punchy, and (if it fits) royal/historical wording.
- Use main characters' roles (e.g. ប្រពន្ធ, ប្ដី, មហាសេដ្ឋី, ក្សត្រ, ព្រះនាង, គ្រូ) rather than foreign names unless a name is famous.
- It must match what really happens in the dialogue. No invented plot, no fake "EP.1-100" or clickbait that the story doesn't support.
- "vibe": a 1-2 word English style label (e.g. "Dramatic", "Romance", "Mystery", "Revenge", "Punchy", "Royal").
- "englishTitle": an English version of the same title.
- "reasoning": ONE short Khmer sentence explaining which part of the story the title hooks on.

SYNOPSIS: 2-3 Khmer sentences, spoiler-light, usable as a video description.

Return JSON: { "synopsis": "...", "titles": [ { "khmerTitle", "englishTitle", "vibe", "reasoning" } ] }

STORY (dialogue sampled from beginning to end${fromProject.length ? '; "original => Khmer"' : ''}):
${dialogue.join('\n') || '(no dialogue provided - work from the original title)'}`;

        const payload = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', responseSchema: TITLE_RESPONSE_SCHEMA, maxOutputTokens: 8192 }
        };
        const abortCtrl = new AbortController();
        res.on('close', () => { if (!res.writableFinished) abortCtrl.abort(); });
        try {
            const out = await geminiWithKeys(keyPool, async (key) => {
                const r = await generateText(key, model, payload, abortCtrl.signal);
                if (!r.success) return { ok: false, result: r };
                let parsed = null;
                try { parsed = JSON.parse(String(r.text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '')); } catch (e) { }
                if (!parsed || !Array.isArray(parsed.titles) || !parsed.titles.length) return { ok: false, result: { status: 502, error: 'Gemini returned no titles. Please try again.' } };
                return { ok: true, parsed };
            }, abortCtrl.signal);
            if (!out.ok) return geminiFailureResponse(res, out.result);
            const titles = out.parsed.titles
                .map(t => ({ khmerTitle: String(t.khmerTitle || '').trim(), englishTitle: String(t.englishTitle || '').trim(), vibe: String(t.vibe || '').trim(), reasoning: String(t.reasoning || '').trim() }))
                .filter(t => t.khmerTitle);
            res.json({ success: true, data: titles, synopsis: String(out.parsed.synopsis || '').trim(), linesUsed: dialogue.length });
        } catch (e) {
            if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── Unify names route ──
    router.post('/unify-names', async (req, res) => {
        const { tabs, glossary, apiKey, apiKeys, model = 'gemini-3.8-flash', requestId } = req.body || {};
        const keyPool = textKeys([apiKey, ...(Array.isArray(apiKeys) ? apiKeys : [])]);
        if (!keyPool.length) return res.status(400).json({ success: false, error: 'INVALID_API_KEY', message: 'Gemini API key is required.' });
        if (!Array.isArray(tabs) || !tabs.length) return res.status(400).json({ success: false, error: 'NO_TABS', message: 'No tabs were sent.' });

        const lines = [];
        tabs.forEach(t => (Array.isArray(t && t.lines) ? t.lines : []).forEach(l => {
            const originalText = String((l && l.originalText) || '').replace(/\s+/g, ' ').trim();
            const text = String((l && l.text) || '').replace(/\s+/g, ' ').trim();
            if (originalText && text) lines.push({ originalText, text });
        }));
        if (!lines.length) {
            return res.json({ success: false, error: 'NO_ORIGINAL_TEXT', message: 'None of the tabs has original-language text next to its Khmer lines, so names cannot be matched. Transcribe with Gemini first.' });
        }
        const chunks = [];
        for (let i = 0; i < lines.length; i += NAMES_LINES_PER_CHUNK) chunks.push(lines.slice(i, i + NAMES_LINES_PER_CHUNK));

        const abortCtrl = new AbortController();
        res.on('close', () => { if (!res.writableFinished) abortCtrl.abort(); });
        const progress = { done: 0, total: chunks.length, note: `Reading names… 0/${chunks.length}` };
        if (requestId) { activeTranscribeRequests.set(requestId, abortCtrl); transcribeProgress.set(requestId, progress); }
        try {
            const results = new Array(chunks.length);
            let failure = null;
            let next = 0;
            const worker = async (w) => {
                const workerKeys = textLaneKeys(keyPool, w);
                while (!failure && !abortCtrl.signal.aborted) {
                    const idx = next++;
                    if (idx >= chunks.length) return;
                    const payload = {
                        contents: [{ role: 'user', parts: [{ text: buildNameExtractionPrompt(chunks[idx]) }] }],
                        generationConfig: { responseMimeType: 'application/json', responseSchema: NAMES_RESPONSE_SCHEMA, temperature: 0, maxOutputTokens: 16384 }
                    };
                    const out = await geminiWithKeys(workerKeys, async (key) => {
                        const r = await generateText(key, model, payload, abortCtrl.signal, { timeoutMs: GEMINI_TEXT_TIMEOUT_MS });
                        if (!r.success) return { ok: false, result: r };
                        const parsed = extractJsonValue(r.text);
                        if (!Array.isArray(parsed)) return { ok: false, result: { status: 502, error: 'Gemini returned an unreadable name list. Please try again.' } };
                        return { ok: true, parsed };
                    }, abortCtrl.signal);
                    if (!out.ok) { failure = out.result; return; }
                    results[idx] = out.parsed;
                    progress.done++;
                    progress.note = `Reading names… ${progress.done}/${progress.total}`;
                }
            };
            await Promise.all(Array.from({ length: Math.min(NAMES_PARALLEL, chunks.length) }, (_, w) => worker(w)));
            if (abortCtrl.signal.aborted) return res.json({ success: false, error: 'CANCELLED' });
            if (failure) return geminiFailureResponse(res, failure);

            const names = NameConsistency.analyzeNames(tabs, NameConsistency.mergeExtracted(results), glossary || null);
            res.json({ success: true, names, linesChecked: lines.length });
        } catch (e) {
            if (e.name === 'AbortError') return res.json({ success: false, error: 'CANCELLED' });
            res.status(500).json({ success: false, error: e.message });
        } finally {
            if (requestId) { activeTranscribeRequests.delete(requestId); transcribeProgress.delete(requestId); }
        }
    });

    Object.assign(router, {
        resolveGeminiModel,
        rankGeminiFallbacks,
        executeGeminiGenerate,
        geminiWithKeys,
        geminiShouldRetry,
        tryKeysOnce,
        geminiKeyStatus,
        geminiThinkingConfig,
        addTokenUsage,
        createTokenUsage,
        textAi,
        codecraftActive,
        textKeys,
        textLaneKeys,
        textLaneCount,
        textAiNotice,
        codecraftKeyStatus,
        activeTranscribeRequests,
        transcribeProgress
    });

    return router;
}

module.exports = createGeminiRouter;
Object.assign(module.exports, {
    resolveGeminiModel,
    rankGeminiFallbacks,
    executeGeminiGenerate,
    geminiWithKeys,
    geminiShouldRetry,
    tryKeysOnce,
    geminiKeyStatus,
    geminiThinkingConfig,
    addTokenUsage,
    createTokenUsage,
    textAi,
    codecraftActive,
    textKeys,
    textLaneKeys,
    textLaneCount,
    textAiNotice,
    codecraftKeyStatus,
    GEMINI_RETRY_DELAYS_MS,
    GEMINI_BUSY_RETRY_BUDGET_MS,
    activeTranscribeRequests,
    transcribeProgress,
    buildTranscribePrompt,
    parseJsonArrayLoose
});
