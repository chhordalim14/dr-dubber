// frontend/js/text-ai.js helpers: what the CodeCraft model picker in Settings → API shows.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../frontend/js/text-ai.js');

describe('formatMeta', () => {
  test('context and price per 1M tokens, as in the picker', () => {
    assert.equal(T.formatMeta({ contextWindow: 1000000, inputPer1M: 1.24, outputPer1M: 1.24 }), '1.0M context · $1.24 / $1.24 per 1M tokens');
    assert.equal(T.formatMeta({ contextWindow: 128000, inputPer1M: 0.115, outputPer1M: 0.23 }), '128K context · $0.12 / $0.23 per 1M tokens');
  });
  test('free, tiny prices and missing fields', () => {
    assert.equal(T.formatMeta({ contextWindow: 32000, inputPer1M: 0, outputPer1M: 0 }), '32K context · Free');
    assert.equal(T.formatMeta({ inputPer1M: 0.0012, outputPer1M: 0.0024 }), '$0.0012 / $0.0024 per 1M tokens');
    assert.equal(T.formatMeta({ contextWindow: null, inputPer1M: null, outputPer1M: null }), '');
  });
});

describe('pickDefaultModel', () => {
  test('the newest Gemini Flash, not Lite', () => {
    const models = [{ id: 'claude-opus-4.8' }, { id: 'gemini-3.5-flash' }, { id: 'gemini-3.8-flash-lite' }, { id: 'gemini-3.7-flash' }];
    assert.equal(T.pickDefaultModel(models), 'gemini-3.7-flash');
  });
  test('no Gemini: the first model; nothing: empty', () => {
    assert.equal(T.pickDefaultModel([{ id: 'deepseek-v4-pro' }, { id: 'qwen3.8-27b' }]), 'deepseek-v4-pro');
    assert.equal(T.pickDefaultModel([]), '');
  });
});

describe('modelFamily / groupModels', () => {
  test('makers by id or name', () => {
    assert.equal(T.modelFamily({ id: 'gemini-3.7-flash' }).name, 'Google');
    assert.equal(T.modelFamily({ id: 'gemma-2-2b' }).letter, 'G');
    assert.equal(T.modelFamily({ id: 'claude-opus-4.8' }).name, 'Anthropic');
    assert.equal(T.modelFamily({ id: 'x', name: 'Claude Fable 5' }).name, 'Anthropic');
    assert.equal(T.modelFamily({ id: 'gpt-5.6-luna' }).name, 'OpenAI');
    assert.equal(T.modelFamily({ id: 'DeepSeek-V4-Flash-0731' }).name, 'DeepSeek');
    assert.equal(T.modelFamily({ id: 'seed-2.1-turbo' }).name, 'ByteDance');
    const other = T.modelFamily({ id: 'zeta-7b' });
    assert.equal(other.name, 'Other');
    assert.equal(other.letter, 'Z');
  });
  test('Google first, the rest in maker order', () => {
    const groups = T.groupModels([{ id: 'qwen3.8-27b' }, { id: 'claude-opus-4.8' }, { id: 'zeta' }, { id: 'gemini-3.7-flash' }]);
    assert.deepEqual(groups.map(([name]) => name), ['Google', 'Anthropic', 'Qwen', 'Other']);
  });
});

test('maskKey shows only the start and the last 4 characters', () => {
  assert.equal(T.maskKey('cc_abcdefghijklmnopju8F'), 'cc_••••••ju8F');
  assert.equal(T.maskKey(''), '');
});
