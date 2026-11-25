import { DashStyle, Drawing, LineStyle, PenAnchor } from "./types.js";

const f = (n: number) => String(Math.round(n * 1e5) / 1e5);

/** Smooth curve through points (Catmull-Rom converted to cubic Beziers), as SVG path data. */
export function smoothD(p: number[]): string {
	const n = p.length / 2;
	if (n < 2) return "";
	let d = `M${f(p[0])} ${f(p[1])}`;
	if (n === 2) return d + `L${f(p[2])} ${f(p[3])}`;
	for (let i = 0; i < n - 1; i++) {
		const x1 = p[i * 2], y1 = p[i * 2 + 1], x2 = p[i * 2 + 2], y2 = p[i * 2 + 3];
		const x0 = i > 0 ? p[i * 2 - 2] : x1, y0 = i > 0 ? p[i * 2 - 1] : y1;
		const x3 = i < n - 2 ? p[i * 2 + 4] : x2, y3 = i < n - 2 ? p[i * 2 + 5] : y2;
		d += `C${f(x1 + (x2 - x0) / 6)} ${f(y1 + (y2 - y0) / 6)} ${f(x2 - (x3 - x1) / 6)} ${f(y2 - (y3 - y1) / 6)} ${f(x2)} ${f(y2)}`;
	}
	return d;
}

/** SVG path data for a pen path. */
export function penD(a: PenAnchor[], closed: boolean): string {
	if (a.length < 2) return "";
	let d = `M${f(a[0].x)} ${f(a[0].y)}`;
	for (let i = 1; i < a.length; i++) d += `C${f(a[i - 1].ox)} ${f(a[i - 1].oy)} ${f(a[i].ix)} ${f(a[i].iy)} ${f(a[i].x)} ${f(a[i].y)}`;
	if (closed && a.length > 2) {
		const l = a[a.length - 1], s = a[0];
		d += `C${f(l.ox)} ${f(l.oy)} ${f(s.ix)} ${f(s.iy)} ${f(s.x)} ${f(s.y)}Z`;
	}
	return d;
}

/** Ramer-Douglas-Peucker on a flat [x,y,...] array. */
export function simplify(p: number[], eps: number): number[] {
	const n = p.length / 2;
	if (n < 3) return p.slice();
	const keep = new Uint8Array(n);
	keep[0] = keep[n - 1] = 1;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1];
		const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
		let max = 0, idx = -1;
		for (let i = a + 1; i < b; i++) {
			const d = Math.abs((p[i * 2] - ax) * dy - (p[i * 2 + 1] - ay) * dx) / len;
			if (d > max) { max = d; idx = i; }
		}
		if (max > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
	}
	const out: number[] = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(Math.round(p[i * 2] * 1e5) / 1e5, Math.round(p[i * 2 + 1] * 1e5) / 1e5);
	return out;
}

/**
 * Partial erase of a freehand stroke: removes the part inside the eraser circle.
 * Returns the remaining pieces, or null if the stroke wasn't touched.
 */
export function eraseFree(p: number[], cx: number, cy: number, r: number): number[][] | null {
	const dense: number[] = [p[0], p[1]];
	for (let i = 2; i < p.length; i += 2) {
		const x0 = p[i - 2], y0 = p[i - 1], x1 = p[i], y1 = p[i + 1];
		const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (r * 0.4)));
		for (let s = 1; s <= steps; s++) dense.push(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps);
	}
	const pieces: number[][] = [];
	let cur: number[] = [], hit = false;
	for (let i = 0; i < dense.length; i += 2) {
		if (Math.hypot(dense[i] - cx, dense[i + 1] - cy) < r) {
			hit = true;
			if (cur.length >= 4) pieces.push(cur);
			cur = [];
		} else cur.push(dense[i], dense[i + 1]);
	}
	if (!hit) return null;
	if (cur.length >= 4) pieces.push(cur);
	return pieces.map((pc) => simplify(pc, 0.0002));
}

export function dashArray(dash: DashStyle, w: number): number[] {
	switch (dash) {
		case "dashed": return [3.2 * w, 2 * w];
		case "dotted": return [0.001 * w, 2.1 * w];
		case "dashdot": return [3.2 * w, 1.7 * w, 0.001 * w, 1.7 * w];
		default: return [];
	}
}

/** Apply stroke settings to a context whose transform maps map units to pixels. minWidth is one pixel in map units. */
export function applyLineStyle(ctx: CanvasRenderingContext2D, st: LineStyle, minWidth: number) {
	const w = Math.max(st.width, minWidth);
	ctx.lineWidth = w;
	ctx.strokeStyle = st.color;
	ctx.lineCap = st.dash === "dashed" ? "butt" : "round";
	ctx.lineJoin = "round";
	ctx.setLineDash(dashArray(st.dash, w));
}

/* ------------------------- editing existing lines ------------------------- */

export interface Near { seg: number; t: number; x: number; y: number; dist: number }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function cubic(a: PenAnchor, b: PenAnchor, t: number): [number, number] {
	const u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
	return [w0 * a.x + w1 * a.ox + w2 * b.ix + w3 * b.x, w0 * a.y + w1 * a.oy + w2 * b.iy + w3 * b.y];
}
const segCount = (n: number, closed: boolean) => (closed && n > 2 ? n : n - 1);

export function nearestOnPen(a: PenAnchor[], closed: boolean, ux: number, uy: number): Near | null {
	const n = a.length;
	if (n < 2) return null;
	let seg = 0, t = 0, x = 0, y = 0, dist = Infinity;
	for (let s = 0; s < segCount(n, closed); s++) {
		const A = a[s], B = a[(s + 1) % n];
		for (let k = 0; k <= 24; k++) {
			const [px, py] = cubic(A, B, k / 24), d = Math.hypot(px - ux, py - uy);
			if (d < dist) { dist = d; seg = s; t = k / 24; x = px; y = py; }
		}
	}
	// refine around the best sample
	const A = a[seg], B = a[(seg + 1) % n], t0 = t;
	for (let k = -12; k <= 12; k++) {
		const tt = t0 + k / 288;
		if (tt < 0 || tt > 1) continue;
		const [px, py] = cubic(A, B, tt), d = Math.hypot(px - ux, py - uy);
		if (d < dist) { dist = d; t = tt; x = px; y = py; }
	}
	return { seg, t, x, y, dist };
}

/** Insert an anchor on segment `seg` at parameter `t`, keeping the curve's shape. Returns its index. */
export function splitPen(a: PenAnchor[], closed: boolean, seg: number, t: number): number {
	const n = a.length, A = a[seg], B = a[(seg + 1) % n];
	const q0x = lerp(A.x, A.ox, t), q0y = lerp(A.y, A.oy, t);
	const q1x = lerp(A.ox, B.ix, t), q1y = lerp(A.oy, B.iy, t);
	const q2x = lerp(B.ix, B.x, t), q2y = lerp(B.iy, B.y, t);
	const r0x = lerp(q0x, q1x, t), r0y = lerp(q0y, q1y, t), r1x = lerp(q1x, q2x, t), r1y = lerp(q1y, q2y, t);
	const sx = lerp(r0x, r1x, t), sy = lerp(r0y, r1y, t);
	A.ox = q0x; A.oy = q0y; B.ix = q2x; B.iy = q2y;
	a.splice(seg + 1, 0, { x: sx, y: sy, ix: r0x, iy: r0y, ox: r1x, oy: r1y });
	void closed;
	return seg + 1;
}

export function nearestOnPoly(p: number[], ux: number, uy: number): Near | null {
	let best: Near | null = null;
	for (let i = 0; i + 3 < p.length; i += 2) {
		const x0 = p[i], y0 = p[i + 1], dx = p[i + 2] - x0, dy = p[i + 3] - y0, l2 = dx * dx + dy * dy || 1e-12;
		const t = Math.max(0, Math.min(1, ((ux - x0) * dx + (uy - y0) * dy) / l2));
		const x = x0 + dx * t, y = y0 + dy * t, d = Math.hypot(x - ux, y - uy);
		if (!best || d < best.dist) best = { seg: i / 2, t, x, y, dist: d };
	}
	return best;
}

export function nearestOnDrawing(d: Drawing, ux: number, uy: number): Near | null {
	return d.kind === "pen" && d.anchors ? nearestOnPen(d.anchors, !!d.closed, ux, uy) : d.pts ? nearestOnPoly(d.pts, ux, uy) : null;
}

export function rebuildD(d: Drawing) {
	if (d.kind === "pen" && d.anchors) d.d = penD(d.anchors, !!d.closed);
	else if (d.pts) d.d = smoothD(d.pts);
}

export function translateDrawing(d: Drawing, dx: number, dy: number) {
	if (d.anchors) for (const a of d.anchors) { a.x += dx; a.ix += dx; a.ox += dx; a.y += dy; a.iy += dy; a.oy += dy; }
	if (d.pts) for (let i = 0; i < d.pts.length; i += 2) { d.pts[i] += dx; d.pts[i + 1] += dy; }
	rebuildD(d);
}

export function moveAnchor(d: Drawing, idx: number, dx: number, dy: number) {
	if (d.anchors) { const a = d.anchors[idx]; a.x += dx; a.ix += dx; a.ox += dx; a.y += dy; a.iy += dy; a.oy += dy; }
	else if (d.pts) { d.pts[idx * 2] += dx; d.pts[idx * 2 + 1] += dy; }
	rebuildD(d);
}

/** Drag one bezier handle. The opposite handle follows (keeping its own length) unless `independent`. */
export function dragHandle(d: Drawing, idx: number, which: "in" | "out", ux: number, uy: number, independent: boolean) {
	const a = d.anchors?.[idx];
	if (!a) return;
	const [hx, hy, ox, oy] = which === "out" ? (["ox", "oy", "ix", "iy"] as const) : (["ix", "iy", "ox", "oy"] as const);
	a[hx] = ux; a[hy] = uy;
	const ol = Math.hypot(a[ox] - a.x, a[oy] - a.y), dl = Math.hypot(ux - a.x, uy - a.y);
	if (!independent && ol > 1e-9 && dl > 1e-9) { a[ox] = a.x - ((ux - a.x) / dl) * ol; a[oy] = a.y - ((uy - a.y) / dl) * ol; }
	rebuildD(d);
}

/** Remove a point. Returns false if the line would be left with too few points (the caller should delete it). */
export function deleteAnchor(d: Drawing, idx: number): boolean {
	if (d.anchors) { if (d.anchors.length <= 2) return false; d.anchors.splice(idx, 1); if (d.anchors.length < 3) d.closed = false; }
	else if (d.pts) { if (d.pts.length <= 4) return false; d.pts.splice(idx * 2, 2); }
	rebuildD(d);
	return true;
}

/** Add a point on the line nearest to (ux,uy). Returns the new point's index, or -1 if it isn't close enough. */
export function addPointNear(d: Drawing, ux: number, uy: number, maxDist: number): number {
	const n = nearestOnDrawing(d, ux, uy);
	if (!n || n.dist > maxDist) return -1;
	let idx: number;
	if (d.anchors) idx = splitPen(d.anchors, !!d.closed, n.seg, n.t);
	else { d.pts!.splice((n.seg + 1) * 2, 0, n.x, n.y); idx = n.seg + 1; }
	rebuildD(d);
	return idx;
}
