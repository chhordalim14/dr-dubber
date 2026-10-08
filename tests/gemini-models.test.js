// frontend/js/gemini-models.js: the one model list every picker is filled from.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'gemini-models.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');

function run() {
  const fakeSelect = () => ({ options: [], value: '', set innerHTML(v) { this.options = []; }, add(o) { this.options.push(o); } });
  const els = { 'setting-ai-model': fakeSelect(), 'dai-model-select': fakeSelect(), 'dai-trans-model-select': fakeSelect(), 'gemini-model-list': { innerHTML: '' } };
  const window = {};
  // value only "sticks" when an option has it, like a real <select>
  for (const id of ['setting-ai-model', 'dai-model-select', 'dai-trans-model-select']) {
    const sel = els[id]; let v = '';
    Object.defineProperty(sel, 'value', { get: () => v, set: (x) => { v = sel.options.some((o) => o.value === x) ? x : ''; } });
  }
  vm.runInNewContext(source, { window, document: { getElementById: (id) => els[id] || null }, Option: function (text, value) { this.text = text; this.value = value; } });
  return { window, els };
}

test('every select gets the same full list, 3.8 Flash first', () => {
  const { window, els } = run();
  const ids = Array.from(window.GEMINI_MODELS, (m) => m.id);
  assert.equal(ids.length, 14);
  for (const id of ['setting-ai-model', 'dai-model-select', 'dai-trans-model-select']) {
    assert.deepEqual(els[id].options.map((o) => o.value), ids);
    assert.equal(els[id].value, 'gemini-3.8-flash');
  }
});

test('the Settings dropdown shows every model, including 3.5 / 3.6 Flash', () => {
  const { window, els } = run();
  const shown = [...els['gemini-model-list'].innerHTML.matchAll(/data-model="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...shown].sort(), Array.from(window.GEMINI_MODELS, (m) => m.id).sort());
  assert.ok(shown.includes('gemini-3.5-flash') && shown.includes('gemini-3.6-flash'));
});

test('paid models are listed under the paid header', () => {
  const { els } = run();
  const list = els['gemini-model-list'].innerHTML;
  const paidAt = list.indexOf('Billing / Paid Tier');
  assert.ok(list.indexOf('data-model="gemini-3.1-pro-preview"') > paidAt);
  assert.ok(list.indexOf('data-model="gemini-3.5-flash"') < paidAt);
});

test('index.html keeps no copy of the list and loads the file before the pickers are wired', () => {
  assert.equal((html.match(/<option value="gemini-/g) || []).length, 0);
  assert.equal((html.match(/class="gemini-model-opt/g) || []).length, 0);
  const at = (f) => html.indexOf(`<script src="js/${f}"></script>`);
  assert.ok(at('gemini-models.js') > html.indexOf('id="setting-ai-model"'));
  assert.ok(at('gemini-models.js') < at('studio-main.js') && at('gemini-models.js') < at('dai-transcribe-studio.js'));
});
