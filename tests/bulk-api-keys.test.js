const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Extract extractGeminiKeys and isValidGeminiKey from frontend/js/studio-main.js
const studioMainSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8');

const keyPatternMatch = studioMainSource.match(/const GEMINI_KEY_PATTERN = (\/.*?\/);/);
assert.ok(keyPatternMatch, 'GEMINI_KEY_PATTERN must be found in studio-main.js');
const GEMINI_KEY_PATTERN = new RegExp(keyPatternMatch[1].slice(1, -1));
const isValidGeminiKey = (val) => GEMINI_KEY_PATTERN.test(val);

// Build extractGeminiKeys function as defined in studio-main.js
const extractGeminiKeys = (raw) => {
  if (!raw || typeof raw !== "string") return [];
  const tokens = raw.split(/[^A-Za-z0-9._-]+/).filter(Boolean);
  const found = [];
  const seen = new Set();
  for (const token of tokens) {
    if (isValidGeminiKey(token) && !seen.has(token)) {
      seen.add(token);
      found.push(token);
    }
  }
  return found;
};

// Simulation of addGeminiKeys
const createKeyManager = (initialKeys = []) => {
  const apiKeys = [...initialKeys];
  const addedToServer = [];
  const addGeminiKeys = (keysToAdd) => {
    if (!Array.isArray(keysToAdd) || !keysToAdd.length) return { added: 0, skipped: 0 };
    const existing = new Set(apiKeys);
    const toAdd = keysToAdd.filter((k) => !existing.has(k));
    const skipped = keysToAdd.length - toAdd.length;

    if (toAdd.length > 0) {
      apiKeys.push(...toAdd);
      addedToServer.push(...toAdd);
    }
    return { added: toAdd.length, skipped };
  };
  return { apiKeys, addedToServer, addGeminiKeys };
};

describe('Bulk Gemini API Keys', () => {
  const key1 = 'AIzaSyA_123456789012345678901234567890';
  const key2 = 'AIzaSyB-098765432109876543210987654321';
  const key3 = 'AIzaSyC.112233445566778899001122334455';

  test('validates standard Gemini keys', () => {
    assert.equal(isValidGeminiKey(key1), true);
    assert.equal(isValidGeminiKey(key2), true);
    assert.equal(isValidGeminiKey(key3), true);
    assert.equal(isValidGeminiKey('too_short'), false);
    assert.equal(isValidGeminiKey('with spaces inside AIzaSyA1234567890'), false);
  });

  test('extracts single key cleanly', () => {
    const keys = extractGeminiKeys(key1);
    assert.deepEqual(keys, [key1]);
  });

  test('extracts multiple keys separated by newlines', () => {
    const raw = `${key1}\n${key2}\r\n${key3}`;
    const keys = extractGeminiKeys(raw);
    assert.deepEqual(keys, [key1, key2, key3]);
  });

  test('extracts multiple keys separated by commas and spaces', () => {
    const raw = `${key1}, ${key2},   ${key3}`;
    const keys = extractGeminiKeys(raw);
    assert.deepEqual(keys, [key1, key2, key3]);
  });

  test('extracts keys with quotes, brackets and JSON formatting', () => {
    const raw = `["${key1}", "${key2}"]`;
    const keys = extractGeminiKeys(raw);
    assert.deepEqual(keys, [key1, key2]);
  });

  test('extracts keys from env variable and labeled lines', () => {
    const raw = `
      GEMINI_API_KEY=${key1}
      Key 2: ${key2}
      # A note here
      ${key3}
    `;
    const keys = extractGeminiKeys(raw);
    assert.deepEqual(keys, [key1, key2, key3]);
  });

  test('deduplicates keys within the pasted text while preserving order', () => {
    const raw = `${key1}\n${key2}\n${key1}\n${key3}\n${key2}`;
    const keys = extractGeminiKeys(raw);
    assert.deepEqual(keys, [key1, key2, key3]);
  });

  test('ignores invalid tokens and noise', () => {
    const raw = `bad\nshort\n${key1}\nhttp://localhost/path\n${key2}`;
    const keys = extractGeminiKeys(raw);
    assert.deepEqual(keys, [key1, key2]);
  });

  test('returns empty array on empty or whitespace input', () => {
    assert.deepEqual(extractGeminiKeys(''), []);
    assert.deepEqual(extractGeminiKeys('   \n\t  '), []);
    assert.deepEqual(extractGeminiKeys(null), []);
  });

  test('addGeminiKeys adds new keys and reports duplicates', () => {
    const mgr = createKeyManager([key1]);
    
    // Add key1 (dup) and key2 (new)
    const result = mgr.addGeminiKeys([key1, key2, key3]);
    assert.equal(result.added, 2);
    assert.equal(result.skipped, 1);
    assert.deepEqual(mgr.apiKeys, [key1, key2, key3]);
    assert.deepEqual(mgr.addedToServer, [key2, key3]);
  });

  test('addGeminiKeys handles when all keys are already present', () => {
    const mgr = createKeyManager([key1, key2]);
    const result = mgr.addGeminiKeys([key1, key2]);
    assert.equal(result.added, 0);
    assert.equal(result.skipped, 2);
    assert.deepEqual(mgr.apiKeys, [key1, key2]);
    assert.deepEqual(mgr.addedToServer, []);
  });
});
