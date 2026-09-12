/**
 * Chroma Key Web Worker
 * High-performance, clean background removal with spill suppression (despill)
 * and smooth Hermite edge antialiasing.
 */

self.onmessage = (e) => {
  const data = e.data;
  if (!data) return;
  const bitmap = data.bitmap;
  if (!bitmap) return;

  const width = data.width;
  const height = data.height;
  if (!width || !height) {
    if (typeof bitmap.close === "function") bitmap.close();
    return;
  }

  const kr = data.kr !== undefined ? data.kr : 0;
  const kg = data.kg !== undefined ? data.kg : 255;
  const kb = data.kb !== undefined ? data.kb : 0;
  const tolerance = data.tolerance !== undefined ? data.tolerance : 80;
  const smoothing = data.smoothing !== undefined ? data.smoothing : 20;
  const spill = data.spill !== undefined ? data.spill : 80;
  const overlayId = data.overlayId;

  // Cache OffscreenCanvas instance per worker to avoid per-frame allocations
  if (!self._offscreen || self._offscreen.width !== width || self._offscreen.height !== height) {
    self._offscreen = new OffscreenCanvas(width, height);
    self._ctx = self._offscreen.getContext("2d", { willReadFrequently: true });
  }

  const ctx = self._ctx;
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === "function") bitmap.close();

  const imgData = ctx.getImageData(0, 0, width, height);
  const px = imgData.data;
  const len = px.length;

  const isGreenKey = (kg > kr * 1.15 && kg > kb * 1.15) || (kg >= 170 && kr < 110 && kb < 110);
  const isBlueKey = kb > kr * 1.15 && kb > kg * 1.15;
  const despillFactor = Math.min(1, Math.max(0, spill / 100));

  const tNorm = Math.min(1, Math.max(0, tolerance / 255));
  const cutoff = Math.max(1, Math.round(28 * (1 - tNorm) + 2));
  const feather = Math.max(1, Math.round(smoothing * 0.35));

  if (isGreenKey) {
    // ── Clean Green Screen Keying + Despill ──
    for (let i = 0; i < len; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const maxRB = r > b ? r : b;
      const greenDiff = g - maxRB;

      if (greenDiff >= cutoff + feather) {
        px[i + 3] = 0; // fully transparent background
      } else {
        if (greenDiff > cutoff) {
          const frac = (greenDiff - cutoff) / feather;
          px[i + 3] = Math.round((1 - frac * frac * (3 - 2 * frac)) * 255);
        }
        // Despill excess green on visible foreground & edges
        if (despillFactor > 0 && g > maxRB) {
          px[i + 1] = Math.round(g * (1 - despillFactor) + maxRB * despillFactor);
        }
      }
    }
  } else if (isBlueKey) {
    // ── Clean Blue Screen Keying + Despill ──
    for (let i = 0; i < len; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const maxRG = r > g ? r : g;
      const blueDiff = b - maxRG;

      if (blueDiff >= cutoff + feather) {
        px[i + 3] = 0;
      } else {
        if (blueDiff > cutoff) {
          const frac = (blueDiff - cutoff) / feather;
          px[i + 3] = Math.round((1 - frac * frac * (3 - 2 * frac)) * 255);
        }
        if (despillFactor > 0 && b > maxRG) {
          px[i + 2] = Math.round(b * (1 - despillFactor) + maxRG * despillFactor);
        }
      }
    }
  } else {
    // ── General Color Keying (YUV Chroma Distance) ──
    const ky = 0.299 * kr + 0.587 * kg + 0.114 * kb;
    const ku = -0.168736 * kr - 0.331264 * kg + 0.5 * kb;
    const kv = 0.5 * kr - 0.418688 * kg - 0.081312 * kb;
    const tolMapped = tolerance * 0.65;
    const smoMapped = Math.max(1, smoothing * 0.45);

    for (let i = 0; i < len; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const u = -0.168736 * r - 0.331264 * g + 0.5 * b;
      const v = 0.5 * r - 0.418688 * g - 0.081312 * b;

      const du = u - ku;
      const dv = v - kv;
      const dy = (y - ky) * 0.25;
      const dist = Math.sqrt(du * du + dv * dv + dy * dy);

      if (dist <= tolMapped) {
        px[i + 3] = 0;
      } else if (dist < tolMapped + smoMapped) {
        const frac = (dist - tolMapped) / smoMapped;
        px[i + 3] = Math.round(frac * frac * (3 - 2 * frac) * 255);
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  const resultBitmap = self._offscreen.transferToImageBitmap();
  self.postMessage({ bitmap: resultBitmap, overlayId }, [resultBitmap]);
};