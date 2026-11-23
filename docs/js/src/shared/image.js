/** Read pixel dimensions from PNG / JPEG / WebP headers without decoding. */
export function readImageSize(buf) {
    const b = new Uint8Array(buf);
    const dv = new DataView(buf);
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50)
        return { w: dv.getUint32(16), h: dv.getUint32(20) };
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
        let i = 2;
        while (i + 9 < b.length) {
            if (b[i] !== 0xff) {
                i++;
                continue;
            }
            const m = b[i + 1];
            if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
                return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
            i += 2 + dv.getUint16(i + 2);
        }
        return null;
    }
    if (b.length > 30 && b[0] === 0x52 && b[8] === 0x57) { // RIFF....WEBP
        const t = String.fromCharCode(b[12], b[13], b[14], b[15]);
        if (t === "VP8X")
            return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
        if (t === "VP8L") {
            const v = dv.getUint32(21, true);
            return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
        }
        if (t === "VP8 ")
            return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
    }
    return null;
}
export async function loadImage(blob, buf, maxSide, minLevelSide = 1024) {
    let size = buf ? readImageSize(buf) : null;
    let first;
    let origW, origH;
    if (size && Math.max(size.w, size.h) > maxSide) {
        const k = maxSide / Math.max(size.w, size.h);
        origW = size.w;
        origH = size.h;
        first = await createImageBitmap(blob, { resizeWidth: Math.round(size.w * k), resizeHeight: Math.round(size.h * k), resizeQuality: "high" });
    }
    else {
        first = await createImageBitmap(blob);
        origW = first.width;
        origH = first.height;
        if (Math.max(first.width, first.height) > maxSide) { // unknown format, big
            const k = maxSide / Math.max(first.width, first.height);
            const small = await createImageBitmap(first, { resizeWidth: Math.round(first.width * k), resizeHeight: Math.round(first.height * k), resizeQuality: "high" });
            first.close();
            first = small;
        }
    }
    const levels = [{ src: first, w: first.width, h: first.height }];
    let prev = first;
    while (Math.max(prev.width, prev.height) / 2 >= minLevelSide) {
        const w = Math.round(prev.width / 2), h = Math.round(prev.height / 2);
        const next = await createImageBitmap(prev, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
        levels.push({ src: next, w, h });
        prev = next;
    }
    return { levels, w: first.width, h: first.height, origW, origH };
}
export function disposeImage(img) { img?.levels.forEach((l) => l.src.close()); }
