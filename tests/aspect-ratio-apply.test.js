// Aspect Ratio "Apply" / "Apply to All Tabs": the real applyARToProject of frontend/js/studio-main.js.
// A tab whose shape changes gets its zoom/position/crop reset (that framing was made for the old
// shape and left black bars, so every tab needed Reset by hand); a tab already at that AR keeps it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'studio-main.js'), 'utf8');
const a = src.indexOf('      const sameAR = ');
const b = src.indexOf('      function openModal()', a);
const block = a > 0 && b > a ? src.slice(a, b) : null;

function load() {
  const resets = [];
  const api = new Function('resetVideoFraming', `${block}\nreturn { applyARToProject };`)(() => resets.push('active'));
  return { ...api, resets };
}

const zoomed = (ar) => ({
  customAspectRatio: ar,
  videoZoom: 1.6, videoPan: { x: 30, y: -20 }, videoScaleX: 1.2, videoScaleY: 1, cropConfig: { x: 5, y: 5, w: 90, h: 90 },
});
const AR_916 = { w: 1080, h: 1920, fit: 'crop' };
const AR_11 = { w: 1080, h: 1080, fit: 'crop' };

test('the aspect ratio code is found in studio-main.js', () => {
  assert.ok(block, 'applyARToProject block not found - update the markers in this test');
});

test('a background tab that changes shape gets the full picture again', () => {
  const { applyARToProject, resets } = load();
  const p = zoomed(AR_11);
  applyARToProject(p, AR_916, false);
  assert.deepEqual(p.customAspectRatio, AR_916);
  assert.equal(p.videoZoom, 1);
  assert.deepEqual(p.videoPan, { x: 0, y: 0 });
  assert.equal(p.videoScaleX, 1);
  assert.deepEqual(p.cropConfig, { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(resets, []);
});

test('the open tab that changes shape is reset through the live view', () => {
  const { applyARToProject, resets } = load();
  applyARToProject(zoomed(null), AR_916, true);
  assert.deepEqual(resets, ['active']);
});

test('a tab already at this aspect ratio keeps its own framing', () => {
  const { applyARToProject, resets } = load();
  const p = zoomed({ ...AR_916 });
  applyARToProject(p, { ...AR_916 }, false);
  applyARToProject(zoomed({ ...AR_916 }), { ...AR_916 }, true);
  assert.equal(p.videoZoom, 1.6);
  assert.deepEqual(p.videoPan, { x: 30, y: -20 });
  assert.deepEqual(resets, []);
});

test('a different fit mode or going back to Original counts as a new shape', () => {
  const { applyARToProject } = load();
  const p = zoomed({ ...AR_916 });
  applyARToProject(p, { ...AR_916, fit: 'pad' }, false);
  assert.equal(p.videoZoom, 1);
  const q = zoomed({ ...AR_916 });
  applyARToProject(q, null, false);
  assert.equal(q.customAspectRatio, null);
  assert.equal(q.videoZoom, 1);
});

test('the AR object is copied, not shared between tabs', () => {
  const { applyARToProject } = load();
  const ar = { ...AR_916 };
  const p = zoomed(null);
  applyARToProject(p, ar, false);
  ar.fit = 'stretch';
  assert.equal(p.customAspectRatio.fit, 'crop');
});
