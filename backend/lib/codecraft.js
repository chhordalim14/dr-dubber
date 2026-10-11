// CodeCraft API (https://codecraftapi.com): an OpenAI-compatible gateway with many models
// (Gemini, Claude, GPT, DeepSeek, Qwen ...) behind one "cc_" key.
//
// Used for the text-only jobs (translate, re-translate, shorten, names, titles) when Settings ->
// "Translate subtitles with" is CodeCraft. Audio (Direct transcription) always goes to Google.
//
// generate() takes the same Gemini generateContent payload and gives back the same result shape
// as executeGeminiGenerate in server.js - including a Gemini-style `json` - so every caller and
// the key rotation (tryKeysOnce) work unchanged. Errors use the same fields too:
//   RATE_LIMIT_EXCEEDED + retryAfterMs   -> the caller waits (or another key takes over)
//   code OVERLOADED / NETWORK_ERROR      -> the caller's usual retry
//   code PROVIDER_KEY                    -> key rejected or out of credit: tryKeysOnce skips it
//                                           and the Gemini keys after it take over

const CODECRAFT_API_BASE = 'https://codecraftapi.com/v1';
const DEFAULT_TIMEOUT_MS = 240000;

// Gemini's responseSchema ({ type: 'ARRAY', items: { type: 'OBJECT', ... } }) as plain JSON
// Schema, for the prompt: the gateway's json_object mode can't return a top-level array.
function toJsonSchema(s) {
    if (!s || typeof s !== 'object') return s;
    const out = {};
    if (s.type) out.type = String(s.type).toLowerCase();
    if (s.enum) out.enum = s.enum;
    if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    if (s.items) out.items = toJsonSchema(s.items);
    if (s.required) out.required = s.required;
    return out;
}

function jsonInstruction(schema) {
    return 'Reply with valid JSON only: no markdown fences, no commentary before or after it.' +
        (schema ? `\nThe JSON must match this JSON Schema:\n${JSON.stringify(toJsonSchema(schema))}` : '');
}

const partsText = (parts) => (Array.isArray(parts) ? parts : []).map(p => (p && typeof p.text === 'string' ? p.text : '')).join('');
const hasMediaPart = (parts) => (Array.isArray(parts) ? parts : []).some(p => p && (p.inlineData || p.inline_data || p.fileData || p.file_data));

// A Gemini generateContent payload as an OpenAI chat request body (without "model").
function toChatRequest(payload) {
    const p = payload || {};
    const gen = p.generationConfig || {};
    const wantsJson = /json/i.test(String(gen.responseMimeType || '')) || !!gen.responseSchema;
    let hasMedia = false;
    const messages = [];
    for (const c of Array.isArray(p.contents) ? p.contents : []) {
        if (hasMediaPart(c && c.parts)) hasMedia = true;
        messages.push({ role: c && c.role === 'model' ? 'assistant' : 'user', content: partsText(c && c.parts) });
    }
    const sys = p.systemInstruction || p.system_instruction;
    const system = [sys && partsText(sys.parts), wantsJson && jsonInstruction(gen.responseSchema)].filter(Boolean).join('\n\n');
    if (system) messages.unshift({ role: 'system', content: system });
    const body = { messages };
    if (Number(gen.maxOutputTokens) > 0) body.max_tokens = Number(gen.maxOutputTokens);
    if (typeof gen.temperature === 'number') body.temperature = gen.temperature;
    return { body, wantsJson, hasMedia };
}

// message.content is a string, or (some gateways/models) a list of { type: 'text', text } parts.
function messageText(message) {
    const c = message && message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(x => (typeof x === 'string' ? x : (x && x.text) || '')).join('');
    return '';
}

const FINISH_REASONS = { stop: 'STOP', length: 'MAX_TOKENS', content_filter: 'SAFETY', tool_calls: 'STOP' };

const suffix = (key) => `…${String(key || '').slice(-4)}`;

function retryAfterMs(headers) {
    const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
    const sec = parseFloat(raw);
    return isFinite(sec) && sec >= 0 ? Math.ceil(sec * 1000) : null;
}

// An HTTP error answer as a result object. stop: another model won't help (key, credit, rate limit).
function errorResult(status, errBody, headers, key, model) {
    const e = (errBody && errBody.error) || {};
    const detail = String(typeof e === 'string' ? e : (e.message || '')).trim().replace(/\.+$/, '');
    const code = typeof e === 'object' ? (e.code || e.type || '') : '';
    const who = model ? `CodeCraft (${model})` : 'CodeCraft'; // no model: the model list
    if (status === 401 || (status === 403 && !/scope/i.test(`${code} ${detail}`))) {
        const message = `CodeCraft rejected the API key ${suffix(key)}${detail ? ` (${detail})` : ''}. Check it in Settings → API.`;
        return { stop: true, result: { success: false, status, code: 'PROVIDER_KEY', error: message, message } };
    }
    if (status === 403) {
        const message = `This CodeCraft key ${suffix(key)} is not allowed to use chat models (missing "inference" scope). Create a key with that scope in the CodeCraft dashboard.`;
        return { stop: true, result: { success: false, status, code: 'PROVIDER_KEY', error: message, message } };
    }
    if (status === 402) {
        const message = `CodeCraft key ${suffix(key)} is out of credit - top up at codecraftapi.com.`;
        return { stop: true, result: { success: false, status, code: 'PROVIDER_KEY', outOfCredit: true, error: message, message } };
    }
    if (status === 429) {
        const wait = retryAfterMs(headers);
        const ms = wait != null ? wait : 20000;
        const message = `CodeCraft rate limit reached${detail ? ` (${detail})` : ''} - free again in ${Math.max(1, Math.ceil(ms / 1000))}s.`;
        return { stop: true, result: { success: false, status: 429, error: 'RATE_LIMIT_EXCEEDED', isDailyQuota: false, retryAfterMs: ms, message } };
    }
    if (status === 404) {
        const message = `Model "${model}" is not available on CodeCraft any more. Pick another model in Settings → API.`;
        return { stop: false, result: { success: false, status: 404, error: message, message } };
    }
    if (status === 503 || status === 529 || /overloaded|unavailable|high demand/i.test(detail)) {
        const message = `${who} is busy${detail ? ` (${detail})` : ''}.`;
        return { stop: false, result: { success: false, status: 503, code: 'OVERLOADED', error: message, message } };
    }
    const message = `${who} answered HTTP ${status}${detail ? `: ${detail}` : ''}. Try again in a moment.`;
    return { stop: false, result: { success: false, status, error: message, message } };
}

function createCodeCraftClient({ fetch: fetchImpl, extractJsonValue, baseUrl = CODECRAFT_API_BASE, sleep } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('createCodeCraftClient needs a fetch function');
    const wait = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));

    // One HTTP call with its own timeout. The user's Stop (signal) aborts it as well; a timeout
    // comes back as { timedOut: true } instead of an exception.
    async function call(method, path, key, body, signal, timeoutMs) {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        if (signal) {
            if (signal.aborted) ctrl.abort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
        try {
            const res = await fetchImpl(`${baseUrl}${path}`, {
                method,
                headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: ctrl.signal
            });
            const text = await res.text();
            let json = null;
            try { json = JSON.parse(text); } catch (e) { }
            return { ok: res.ok, status: res.status, headers: res.headers, text, json };
        } catch (e) {
            if (signal && signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
            if (timedOut) return { timedOut: true };
            const cause = e && e.cause && (e.cause.code || e.cause.message);
            return { networkError: `${cause || (e && e.message) || 'network error'}` };
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    }

    // models: [main, backup]. preferBackup: ask the backup first (lines the main model left out).
    async function generate({ key, model, backupModel, payload, signal, timeoutMs = DEFAULT_TIMEOUT_MS, preferBackup = false }) {
        const req = toChatRequest(payload);
        if (req.hasMedia) {
            const message = 'CodeCraft is used for text only; audio goes to Google Gemini.';
            return { success: false, status: 400, error: message, message };
        }
        const models = (preferBackup ? [backupModel, model] : [model, backupModel])
            .map(m => String(m || '').trim()).filter((m, i, a) => m && a.indexOf(m) === i);
        if (!models.length) {
            const message = 'No CodeCraft model is chosen. Pick one in Settings → API.';
            return { success: false, status: 400, error: message, message };
        }

        let firstError = null;
        for (const m of models) {
            let body = { model: m, ...req.body };
            for (let attempt = 0; attempt < 2; attempt++) {
                const res = await call('POST', '/chat/completions', key, body, signal, timeoutMs);
                if (res.timedOut) {
                    const message = `CodeCraft (${m}) did not answer within ${Math.round(timeoutMs / 1000)}s.`;
                    firstError = firstError || { status: 503, code: 'OVERLOADED', error: message, message };
                    break; // next model
                }
                if (res.networkError) {
                    // A dead connection is not model-specific: don't cycle the models.
                    const message = `Cannot reach CodeCraft (${res.networkError}). Check your internet connection / VPN / firewall.`;
                    return { success: false, status: 503, code: 'NETWORK_ERROR', error: message, message };
                }
                if (res.ok) {
                    const choice = res.json && Array.isArray(res.json.choices) ? res.json.choices[0] : null;
                    const content = messageText(choice && choice.message);
                    const finishReason = FINISH_REASONS[choice && choice.finish_reason] || (choice && choice.finish_reason ? String(choice.finish_reason).toUpperCase() : 'STOP');
                    if (!content.trim()) {
                        const message = finishReason === 'SAFETY'
                            ? `CodeCraft (${m}) blocked this content.`
                            : `CodeCraft (${m}) returned an empty reply${finishReason === 'MAX_TOKENS' ? ' (it ran out of output tokens)' : ''}.`;
                        firstError = firstError || { status: finishReason === 'SAFETY' ? 422 : 502, error: message, message };
                        break;
                    }
                    let text = content;
                    if (req.wantsJson) {
                        const value = typeof extractJsonValue === 'function' ? extractJsonValue(content) : undefined;
                        if (value === undefined) {
                            const message = `CodeCraft (${m}) did not return the requested JSON. Reply began: ${content.slice(0, 160)}`;
                            firstError = firstError || { status: 502, error: message, message };
                            break;
                        }
                        text = JSON.stringify(value);
                    }
                    return {
                        success: true,
                        text,
                        // The shape executeGeminiGenerate returns; some callers read json.candidates.
                        json: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }] },
                        finishReason,
                        modelUsed: m,
                        fellBack: m !== models[0],
                        usage: res.json && res.json.usage
                    };
                }
                const err = errorResult(res.status, res.json, res.headers, key, m);
                if (err.stop) return err.result;
                // Some models refuse a parameter (a max_tokens over their own cap, or a temperature
                // on a reasoning model): ask once more with the bare request.
                if (res.status === 400 && attempt === 0 && (body.max_tokens !== undefined || body.temperature !== undefined)) {
                    body = { model: m, messages: req.body.messages };
                    continue;
                }
                if (res.status >= 500 && err.result.code !== 'OVERLOADED' && attempt === 0) {
                    await wait(1500);
                    continue;
                }
                firstError = firstError || err.result;
                break;
            }
        }
        return { success: false, ...(firstError || { status: 500, error: 'CodeCraft gave no answer.', message: 'CodeCraft gave no answer.' }) };
    }

    // The models this key can use, with context size and price per 1M tokens.
    async function listModels(key, signal) {
        key = String(key || '').trim();
        if (!key) return { success: false, status: 400, error: 'Enter your CodeCraft API key.' };
        const res = await call('GET', '/models', key, null, signal, 30000);
        if (res.timedOut) return { success: false, status: 504, error: 'CodeCraft did not answer in time. Try again.' };
        if (res.networkError) return { success: false, status: 503, error: `Cannot reach CodeCraft (${res.networkError}). Check your internet connection.` };
        if (!res.ok) {
            const r = errorResult(res.status, res.json, res.headers, key, '').result;
            return { success: false, status: r.status, code: r.code, error: r.message };
        }
        const data = res.json && Array.isArray(res.json.data) ? res.json.data : [];
        const per1M = (v) => (isFinite(parseFloat(v)) ? Math.round(parseFloat(v) * 1000 * 10000) / 10000 : null);
        const models = data
            .filter(m => m && m.id && !/embed/i.test(String(m.type || '')))
            .map(m => ({
                id: String(m.id),
                name: String(m.name || m.id),
                description: String(m.description || ''),
                contextWindow: Number(m.context_window || m.context_length) || null,
                capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(String) : [],
                inputPer1M: per1M(m.pricing && m.pricing.input_per_1k),
                outputPer1M: per1M(m.pricing && m.pricing.output_per_1k)
            }));
        return { success: true, models };
    }

    return { generate, listModels };
}

module.exports = { createCodeCraftClient, toChatRequest, toJsonSchema, CODECRAFT_API_BASE };
