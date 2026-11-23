const f = (n) => String(Math.round(n * 1e5) / 1e5);
/** Smooth curve through points (Catmull-Rom converted to cubic Beziers), as SVG path data. */
export function smoothD(p) {
    const n = p.length / 2;
    if (n < 2)
        return "";
    let d = `M${f(p[0])} ${f(p[1])}`;
    if (n === 2)
        return d + `L${f(p[2])} ${f(p[3])}`;
    for (let i = 0; i < n - 1; i++) {
        const x1 = p[i * 2], y1 = p[i * 2 + 1], x2 = p[i * 2 + 2], y2 = p[i * 2 + 3];
        const x0 = i > 0 ? p[i * 2 - 2] : x1, y0 = i > 0 ? p[i * 2 - 1] : y1;
        const x3 = i < n - 2 ? p[i * 2 + 4] : x2, y3 = i < n - 2 ? p[i * 2 + 5] : y2;
        d += `C${f(x1 + (x2 - x0) / 6)} ${f(y1 + (y2 - y0) / 6)} ${f(x2 - (x3 - x1) / 6)} ${f(y2 - (y3 - y1) / 6)} ${f(x2)} ${f(y2)}`;
    }
    return d;
}
/** SVG path data for a pen path. */
export function penD(a, closed) {
    if (a.length < 2)
        return "";
    let d = `M${f(a[0].x)} ${f(a[0].y)}`;
    for (let i = 1; i < a.length; i++)
        d += `C${f(a[i - 1].ox)} ${f(a[i - 1].oy)} ${f(a[i].ix)} ${f(a[i].iy)} ${f(a[i].x)} ${f(a[i].y)}`;
    if (closed && a.length > 2) {
        const l = a[a.length - 1], s = a[0];
        d += `C${f(l.ox)} ${f(l.oy)} ${f(s.ix)} ${f(s.iy)} ${f(s.x)} ${f(s.y)}Z`;
    }
    return d;
}
/** Ramer-Douglas-Peucker on a flat [x,y,...] array. */
export function simplify(p, eps) {
    const n = p.length / 2;
    if (n < 3)
        return p.slice();
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1];
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
        let max = 0, idx = -1;
        for (let i = a + 1; i < b; i++) {
            const d = Math.abs((p[i * 2] - ax) * dy - (p[i * 2 + 1] - ay) * dx) / len;
            if (d > max) {
                max = d;
                idx = i;
            }
        }
        if (max > eps && idx > 0) {
            keep[idx] = 1;
            stack.push([a, idx], [idx, b]);
        }
    }
    const out = [];
    for (let i = 0; i < n; i++)
        if (keep[i])
            out.push(Math.round(p[i * 2] * 1e5) / 1e5, Math.round(p[i * 2 + 1] * 1e5) / 1e5);
    return out;
}
/**
 * Partial erase of a freehand stroke: removes the part inside the eraser circle.
 * Returns the remaining pieces, or null if the stroke wasn't touched.
 */
export function eraseFree(p, cx, cy, r) {
    const dense = [p[0], p[1]];
    for (let i = 2; i < p.length; i += 2) {
        const x0 = p[i - 2], y0 = p[i - 1], x1 = p[i], y1 = p[i + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (r * 0.4)));
        for (let s = 1; s <= steps; s++)
            dense.push(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
    }
    const pieces = [];
    let cur = [], hit = false;
    for (let i = 0; i < dense.length; i += 2) {
        if (Math.hypot(dense[i] - cx, dense[i + 1] - cy) < r) {
            hit = true;
            if (cur.length >= 4)
                pieces.push(cur);
            cur = [];
        }
        else
            cur.push(dense[i], dense[i + 1]);
    }
    if (!hit)
        return null;
    if (cur.length >= 4)
        pieces.push(cur);
    return pieces.map((pc) => simplify(pc, 0.0002));
}
export function dashArray(dash, w) {
    switch (dash) {
        case "dashed": return [3.2 * w, 2 * w];
        case "dotted": return [0.001 * w, 2.1 * w];
        case "dashdot": return [3.2 * w, 1.7 * w, 0.001 * w, 1.7 * w];
        default: return [];
    }
}
/** Apply stroke settings to a context whose transform maps map units to pixels. minWidth is one pixel in map units. */
export function applyLineStyle(ctx, st, minWidth) {
    const w = Math.max(st.width, minWidth);
    ctx.lineWidth = w;
    ctx.strokeStyle = st.color;
    ctx.lineCap = st.dash === "dashed" ? "butt" : "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(dashArray(st.dash, w));
}
