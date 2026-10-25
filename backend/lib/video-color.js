// The Color Studio's grade (brightness/contrast/saturation/hue/sharpness, as the editor's sliders
// and Drama LUTs set them) as FFmpeg filters that match the editor's preview.
//
// The preview grades with CSS filters: brightness() and contrast() scale the picture (black
// stays black). FFmpeg's eq=brightness adds to every pixel instead, so "K-Drama Glow"
// (brightness 110) exported black at 31 instead of 16 - grey hair, a flat, washed-out picture
// that looked less HD than the source. Brightness and contrast are therefore one lutyuv here,
// done the CSS way on limited-range YUV (black 16, middle grey 125.5, chroma around 128):
//   brightness B: luma (Y - 16) * B + 16, chroma (C - 128) * B + 128
//   contrast   C: luma (Y - 125.5) * C + 125.5, chroma (C - 128) * C + 128
// clipped to video range (luma 16-235, chroma 16-240) as CSS clips RGB to 0-255.
// Measured on a real frame against the preview's CSS grade: 0.994 SSIM, black stays 16 (eq: 0.969, black 31).
const num = (v, fallback) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
};

function buildColorFilters(ca = {}) {
    const b = num(ca.brightness, 100) / 100;
    const c = num(ca.contrast, 100) / 100;
    const s = num(ca.saturation, 100) / 100;
    const hue = num(ca.hue, 0);
    const sharpness = num(ca.sharpness, 0);
    const filters = [];
    if (Math.abs(b - 1) > 0.001 || Math.abs(c - 1) > 0.001) {
        const B = b.toFixed(3), C = c.toFixed(3), BC = (b * c).toFixed(4);
        const chroma = `'clip(128+(val-128)*${BC},16,240)'`;
        filters.push(`lutyuv=y='clip(125.5+(16+(val-16)*${B}-125.5)*${C},16,235)':u=${chroma}:v=${chroma}`);
    }
    if (Math.abs(s - 1) > 0.001) filters.push(`eq=saturation=${s.toFixed(2)}`);
    if (Math.abs(hue) > 0.01) filters.push(`hue=h=${hue.toFixed(1)}`);
    if (sharpness > 0.01) {
        const lumaAmount = Math.min(2.5, Math.max(0.1, (sharpness / 100) * 2.5)).toFixed(2);
        filters.push(`unsharp=5:5:${lumaAmount}:5:5:0.0`);
    }
    return filters;
}

module.exports = { buildColorFilters };
