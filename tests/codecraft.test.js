// backend/lib/codecraft.js against a fake CodeCraft server: the Gemini-style payload goes out as
// an OpenAI chat request, and answers / errors come back in executeGeminiGenerate's shape.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createCodeCraftClient, toChatRequest, toJsonSchema } = require('../backend/lib/codecraft');

// Loose JSON reader standing in for server.js's extractJsonValue.
const extractJsonValue = (raw) => {
  const s = String(raw || '').replace(/```(?:json)?/g, '').trim();
  try { return JSON.parse(s); } catch (e) { return undefined; }
};

function fakeServer(answers) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const a = typeof answers === 'function' ? answers(calls.length - 1, calls[calls.length - 1]) : answers[calls.length - 1];
    if (a instanceof Error) throw a;
    const headers = new Map(Object.entries(a.headers || {}));
    return { ok: a.status >= 200 && a.status < 300, status: a.status, headers: { get: (k) => headers.get(k.toLowerCase()) ?? null }, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };
  return { fetch, calls };
}

const chat = (content, finish = 'stop') => ({ status: 200, body: { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } });
const client = (server) => createCodeCraftClient({ fetch: server.fetch, extractJsonValue, sleep: async () => { } });

const SCHEMA = { type: 'ARRAY', items: { type: 'OBJECT', properties: { i: { type: 'INTEGER' }, text: { type: 'STRING' } }, required: ['i', 'text'], propertyOrdering: ['i', 'text'] } };
const jsonPayload = { contents: [{ role: 'user', parts: [{ text: 'Translate these lines' }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, maxOutputTokens: 32768, temperature: 0 } };
const textPayload = { contents: [{ role: 'user', parts: [{ text: 'Shorten this line' }] }] };

describe('toChatRequest', () => {
  test('a JSON request becomes a system instruction with the schema, plus the limits', () => {
    const { body, wantsJson, hasMedia } = toChatRequest(jsonPayload);
    assert.equal(wantsJson, true);
    assert.equal(hasMedia, false);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /valid JSON only/);
    assert.match(body.messages[0].content, /"type":"array"/);
    assert.deepEqual(body.messages[1], { role: 'user', content: 'Translate these lines' });
    assert.equal(body.max_tokens, 32768);
    assert.equal(body.temperature, 0);
    assert.equal(body.response_format, undefined, 'json_object mode cannot return a top-level array');
  });

  test('audio parts are flagged (CodeCraft is text only)', () => {
    const { hasMedia } = toChatRequest({ contents: [{ role: 'user', parts: [{ text: 'x' }, { inlineData: { mimeType: 'audio/mp3', data: 'AAA' } }] }] });
    assert.equal(hasMedia, true);
  });

  test('toJsonSchema lowercases types and drops Gemini-only fields', () => {
    assert.deepEqual(toJsonSchema(SCHEMA), { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, text: { type: 'string' } }, required: ['i', 'text'] } });
  });
});

describe('generate', () => {
  test('sends a Bearer chat request and returns clean JSON in the Gemini result shape', async () => {
    const server = fakeServer([chat('```json\n[{"i":0,"text":"សួស្តី"}]\n```')]);
    const r = await client(server).generate({ key: 'cc_abc', model: 'gemini-3.7-flash', payload: jsonPayload });
    assert.equal(server.calls[0].url, 'https://codecraftapi.com/v1/chat/completions');
    assert.equal(server.calls[0].opts.headers.Authorization, 'Bearer cc_abc');
    assert.equal(server.calls[0].body.model, 'gemini-3.7-flash');
    assert.equal(r.success, true);
    assert.equal(r.text, '[{"i":0,"text":"សួស្តី"}]');
    assert.equal(r.json.candidates[0].content.parts[0].text, r.text);
    assert.equal(r.finishReason, 'STOP');
    assert.equal(r.modelUsed, 'gemini-3.7-flash');
    assert.equal(r.fellBack, false);
  });

  test('plain text replies come back as they are', async () => {
    const r = await client(fakeServer([chat('ខ្លី')])).generate({ key: 'cc_abc', model: 'm1', payload: textPayload });
    assert.equal(r.success, true);
    assert.equal(r.text, 'ខ្លី');
  });

  test('a cut-off reply is reported as MAX_TOKENS', async () => {
    const r = await client(fakeServer([chat('[{"i":0,"text":"a"}]', 'length')])).generate({ key: 'cc_abc', model: 'm1', payload: jsonPayload });
    assert.equal(r.finishReason, 'MAX_TOKENS');
  });

  test('the backup model answers when the main model is gone, busy or returns no JSON', async () => {
    for (const fail of [{ status: 404, body: { error: { message: 'model not found' } } }, { status: 503, body: { error: { message: 'overloaded' } } }, chat('Sorry, I cannot do that.')]) {
      const server = fakeServer([fail, chat('[{"i":0,"text":"ok"}]')]);
      const r = await client(server).generate({ key: 'cc_abc', model: 'main', backupModel: 'backup', payload: jsonPayload });
      assert.equal(r.success, true);
      assert.deepEqual(server.calls.map(c => c.body.model), ['main', 'backup']);
      assert.equal(r.modelUsed, 'backup');
      assert.equal(r.fellBack, true);
    }
  });

  test('preferBackup asks the backup model first', async () => {
    const server = fakeServer([chat('[]')]);
    await client(server).generate({ key: 'cc_abc', model: 'main', backupModel: 'backup', payload: jsonPayload, preferBackup: true });
    assert.equal(server.calls[0].body.model, 'backup');
  });

  test('a 400 is retried once without max_tokens / temperature', async () => {
    const server = fakeServer([{ status: 400, body: { error: { message: 'max_tokens too large' } } }, chat('[]')]);
    const r = await client(server).generate({ key: 'cc_abc', model: 'main', payload: jsonPayload });
    assert.equal(r.success, true);
    assert.equal(server.calls[1].body.max_tokens, undefined);
    assert.equal(server.calls[1].body.temperature, undefined);
    assert.equal(server.calls[1].body.model, 'main');
  });

  test('401 and 402 stop at once as PROVIDER_KEY (the Gemini keys take over), without asking the backup', async () => {
    for (const status of [401, 402]) {
      const server = fakeServer([{ status, body: { error: { message: 'nope' } } }]);
      const r = await client(server).generate({ key: 'cc_abc', model: 'main', backupModel: 'backup', payload: textPayload });
      assert.equal(r.success, false);
      assert.equal(r.code, 'PROVIDER_KEY');
      assert.equal(server.calls.length, 1);
      if (status === 402) assert.match(r.message, /out of credit/);
    }
  });

  test('429 is a rate limit with the Retry-After wait', async () => {
    const r = await client(fakeServer([{ status: 429, headers: { 'retry-after': '7' }, body: { error: { message: 'Rate limit exceeded' } } }]))
      .generate({ key: 'cc_abc', model: 'main', payload: textPayload });
    assert.equal(r.error, 'RATE_LIMIT_EXCEEDED');
    assert.equal(r.status, 429);
    assert.equal(r.retryAfterMs, 7000);
    assert.equal(r.isDailyQuota, false);
  });

  test('a dead connection is a NETWORK_ERROR and does not cycle the models', async () => {
    const server = fakeServer([Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })]);
    const r = await client(server).generate({ key: 'cc_abc', model: 'main', backupModel: 'backup', payload: textPayload });
    assert.equal(r.code, 'NETWORK_ERROR');
    assert.match(r.message, /ENOTFOUND/);
    assert.equal(server.calls.length, 1);
  });

  test('audio is refused without a request', async () => {
    const server = fakeServer([]);
    const r = await client(server).generate({ key: 'cc_abc', model: 'main', payload: { contents: [{ parts: [{ inlineData: { data: 'x' } }] }] } });
    assert.equal(r.success, false);
    assert.equal(server.calls.length, 0);
  });

  test('the user\'s Stop aborts the request', async () => {
    const ctrl = new AbortController();
    const fetch = (url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const p = createCodeCraftClient({ fetch, extractJsonValue }).generate({ key: 'cc_abc', model: 'main', payload: textPayload, signal: ctrl.signal });
    ctrl.abort();
    await assert.rejects(p, { name: 'AbortError' });
  });

  test('no answer in time counts as busy and moves to the backup model', async () => {
    let n = 0;
    const fetch = (url, opts) => (n++ === 0
      ? new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))))
      : Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(chat('fine').body) }));
    const r = await createCodeCraftClient({ fetch, extractJsonValue }).generate({ key: 'cc_abc', model: 'slow', backupModel: 'fast', payload: textPayload, timeoutMs: 20 });
    assert.equal(r.success, true);
    assert.equal(r.modelUsed, 'fast');
  });
});

describe('listModels', () => {
  test('maps context and price per 1K tokens to per 1M, and skips embedding models', async () => {
    const server = fakeServer([{ status: 200, body: { object: 'list', data: [
      { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', type: 'chat', context_window: 1000000, capabilities: ['streaming'], pricing: { input_per_1k: 0.00124, output_per_1k: 0.00124 } },
      { id: 'text-embed-3', type: 'embedding', pricing: { input_per_1k: 0.00001 } }
    ] } }]);
    const out = await client(server).listModels('cc_abc');
    assert.equal(server.calls[0].url, 'https://codecraftapi.com/v1/models');
    assert.equal(server.calls[0].opts.method, 'GET');
    assert.equal(out.success, true);
    assert.deepEqual(out.models, [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', description: '', contextWindow: 1000000, capabilities: ['streaming'], inputPer1M: 1.24, outputPer1M: 1.24 }]);
  });

  test('a rejected key says so', async () => {
    const out = await client(fakeServer([{ status: 401, body: { error: { message: 'Missing or invalid API key.', type: 'authentication_error', code: 'invalid_api_key' } } }])).listModels('cc_bad1');
    assert.equal(out.success, false);
    assert.equal(out.status, 401);
    assert.match(out.error, /rejected the API key …bad1/);
  });

  test('no key: no request', async () => {
    const server = fakeServer([]);
    const out = await client(server).listModels('  ');
    assert.equal(out.success, false);
    assert.equal(server.calls.length, 0);
  });
});
