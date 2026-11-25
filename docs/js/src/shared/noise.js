/** Tileable fractal value-noise "cloud" textures used to give fog its look. */
function mulberry32(a) {
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export const TEX_SIZE = 768;
/** White texture whose alpha channel is tileable cloud noise. */
export function makeCloudAlpha(seed, baseFreq, octaves, lo, hi, gamma) {
    const size = TEX_SIZE;
    const rnd = mulberry32(seed);
    const lat = [];
    const freqs = [];
    for (let o = 0; o < octaves; o++) {
        const f = baseFreq * (1 << o);
        const a = new Float32Array(f * f);
        for (let i = 0; i < a.length; i++)
            a[i] = rnd();
        lat.push(a);
        freqs.push(f);
    }
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(size, size);
    const d = img.data;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            let v = 0, amp = 1, norm = 0;
            for (let o = 0; o < octaves; o++) {
                const f = freqs[o], L = lat[o];
                const u = (x / size) * f, w = (y / size) * f;
                const x0 = Math.floor(u), y0 = Math.floor(w);
                let fx = u - x0, fy = w - y0;
                fx = fx * fx * (3 - 2 * fx);
                fy = fy * fy * (3 - 2 * fy);
                const xa = x0 % f, xb = (x0 + 1) % f, ya = y0 % f, yb = (y0 + 1) % f;
                const top = L[ya * f + xa] * (1 - fx) + L[ya * f + xb] * fx;
                const bot = L[yb * f + xa] * (1 - fx) + L[yb * f + xb] * fx;
                v += amp * (top * (1 - fy) + bot * fy);
                norm += amp;
                amp *= 0.5;
            }
            v /= norm;
            let t = (v - lo) / (hi - lo);
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            t = Math.pow(t, gamma);
            const i = (y * size + x) * 4;
            d[i] = d[i + 1] = d[i + 2] = 255;
            d[i + 3] = Math.round(t * 255);
        }
    }
    ctx.putImageData(img, 0, 0);
    return c;
}
