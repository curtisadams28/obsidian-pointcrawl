import { FogRenderer } from "./fog.js";
import { IconStore } from "./icons.js";
import { TileSource } from "./tiles.js";
import { applyLineStyle } from "./drawing.js";
import { FogLook, MapSettings, NodeStyle, RenderDrawing } from "./types.js";

export interface RenderNode { id: string; x: number; y: number; title: string; style: NodeStyle; dim?: boolean }

export interface PointerInfo {
	sx: number; sy: number; nx: number; ny: number;
	/** Map units: 1 = image width on both axes (what drawings use). */
	ux: number; uy: number;
	node: RenderNode | null;
	button: number; ctrl: boolean; shift: boolean; alt: boolean;
	spaceHeld: boolean;
}

export type CanvasSettings = Pick<MapSettings, "labelMode" | "labelSize" | "pinSize" | "nodeScaling">;

interface Box { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }

/* ----------------------------- glyphs -------------------------------- */

export function nodeBox(style: NodeStyle, x: number, y: number, s: number): Box {
	if (style.shape === "icon" && style.icon) {
		const h = s * 0.58;
		return { x0: x - h, y0: y - h, x1: x + h, y1: y + h, cx: x, cy: y };
	}
	const r = s * 0.4;
	return { x0: x - r, y0: y - 3 * r, x1: x + r, y1: y, cx: x, cy: y - 2 * r };
}

export function drawGlyph(ctx: CanvasRenderingContext2D, icons: IconStore, style: NodeStyle, x: number, y: number, s: number, dpr: number, alpha = 1, selected = false) {
	ctx.save();
	ctx.globalAlpha = alpha;
	const box = nodeBox(style, x, y, s);
	if (style.shape === "icon" && style.icon) {
		const px = s * 0.95;
		const req = Math.ceil(px * dpr);
		const t = icons.tinted(style.icon, style.color, req, style.halo);
		if (t) {
			const w = (t.width * px) / (Math.ceil(req / 8) * 8); // includes halo padding
			ctx.drawImage(t, x - w / 2, y - w / 2, w, w);
		}
		if (selected) { ctx.strokeStyle = "#4da3ff"; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.arc(x, y, s * 0.72, 0, Math.PI * 2); ctx.stroke(); }
		ctx.restore();
		return;
	}
	const r = s * 0.4, cx = box.cx, cy = box.cy;
	const p = new Path2D();
	p.moveTo(x, y);
	p.lineTo(cx + r * Math.cos(Math.PI / 6), cy + r * Math.sin(Math.PI / 6));
	p.arc(cx, cy, r, Math.PI / 6, (5 * Math.PI) / 6, true);
	p.closePath();
	ctx.shadowColor = "rgba(0,0,0,0.4)"; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1.5;
	ctx.fillStyle = style.color;
	ctx.fill(p);
	ctx.shadowColor = "transparent";
	ctx.lineJoin = "round";
	ctx.lineWidth = Math.max(1.2, s * 0.07);
	ctx.strokeStyle = "rgba(0,0,0,0.6)";
	ctx.stroke(p);
	if (style.icon) {
		ctx.fillStyle = "rgba(255,255,255,0.94)";
		ctx.beginPath(); ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2); ctx.fill();
		const px = r * 1.15;
		const t = icons.tinted(style.icon, style.iconColor || "#1b1b1b", Math.ceil(px * dpr), false);
		if (t) ctx.drawImage(t, cx - px / 2, cy - px / 2, px, px);
	} else {
		ctx.fillStyle = "rgba(255,255,255,0.92)";
		ctx.beginPath(); ctx.arc(cx, cy, r * 0.38, 0, Math.PI * 2); ctx.fill();
	}
	if (selected) { ctx.strokeStyle = "#4da3ff"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2); ctx.stroke(); }
	ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

/* ----------------------------- canvas -------------------------------- */

export class MapCanvas {
	readonly el: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private fogRenderer = new FogRenderer();
	private ro: ResizeObserver;
	private unsubIcons: () => void;
	private raf = 0;
	private t0 = performance.now();
	private lastDraw = 0;
	private dpr = 1;
	private vw = 1; private vh = 1;

	source: TileSource | null = null;
	private dims: { w: number; h: number } | null = null;
	private get image() { return this.dims; }
	zoom = 1; tx = 0; ty = 0; fitZoom = 1;
	maxZoom = 4;

	nodes: RenderNode[] = [];
	drawings: RenderDrawing[] = [];
	selectedDrawingId: string | null = null;
	/** CSS cursor for the active tool (null = normal pointer). */
	toolCursor: string | null = null;
	/** Extra drawing in map units after the map and nodes (tool previews). */
	drawOverlay?: (ctx: CanvasRenderingContext2D, t: { tx: number; ty: number; s: number }) => void;
	onPointerMove?: (p: PointerInfo) => void;
	private paths = new Map<string, { d: string; p: Path2D }>();
	private scratch = document.createElement("canvas").getContext("2d")!;
	selectedId: string | null = null;
	hoverId: string | null = null;
	/** Label kept visible regardless of hover (used for tap-to-reveal on touch screens). */
	pinnedId: string | null = null;
	settings: CanvasSettings = { labelMode: "hover", labelSize: 14, pinSize: 30, nodeScaling: "fixed" };
	fogMask: HTMLCanvasElement | null = null;
	fogLook: FogLook = { color: "#aeb9c2", density: 1, animate: true, speed: 1 };
	fogOpacity = 1;
	/** Brush radius as a fraction of image width; shows a ring under the pointer. */
	brush: { r: number } | null = null;
	spaceHeld = false;
	fontFamily = "system-ui, sans-serif";

	onPointerDown?: (p: PointerInfo) => boolean;
	onToolMove?: (p: PointerInfo) => void;
	onToolUp?: (p: PointerInfo) => void;
	onClick?: (p: PointerInfo) => void;
	onDblClick?: (p: PointerInfo) => void;
	onContext?: (p: PointerInfo, ev: MouseEvent) => void;

	private pointers = new Map<number, { x: number; y: number }>();
	private pointer: { sx: number; sy: number } | null = null;
	private drag: { kind: "pan" | "tool" | "pinch"; x: number; y: number; moved: boolean; button: number; dist?: number } | null = null;

	constructor(private host: HTMLElement, private icons: IconStore) {
		this.el = document.createElement("canvas");
		this.el.className = "pc-canvas";
		host.appendChild(this.el);
		this.el.style.touchAction = "none";
		this.el.style.display = "block";
		this.ctx = this.el.getContext("2d")!;
		this.unsubIcons = this.icons.addListener(() => this.requestDraw());
		this.ro = new ResizeObserver(() => this.resize());
		this.ro.observe(host);
		const e = this.el;
		e.addEventListener("pointerdown", this.pdown);
		e.addEventListener("pointermove", this.pmove);
		e.addEventListener("pointerup", this.pup);
		e.addEventListener("pointercancel", this.pup);
		e.addEventListener("pointerleave", this.pleave);
		e.addEventListener("wheel", this.wheel, { passive: false });
		e.addEventListener("dblclick", (ev) => this.onDblClick?.(this.info(ev)));
		e.addEventListener("contextmenu", (ev) => { ev.preventDefault(); this.onContext?.(this.info(ev), ev); });
		this.resize();
	}

	destroy() {
		this.ro.disconnect();
		this.unsubIcons();
		cancelAnimationFrame(this.raf);
		this.el.remove();
	}

	/* ------------------------------ view ------------------------------ */

	/** The canvas never owns the source; whoever created it disposes it. */
	setSource(src: TileSource | null) {
		this.source?.setUpdateListener(null);
		this.source = src;
		this.dims = src ? { w: src.w, h: src.h } : null;
		src?.setUpdateListener(() => this.requestDraw());
		this.fit();
	}

	private resize() {
		const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
		this.dpr = Math.min(window.devicePixelRatio || 1, 2);
		const hadFit = Math.abs(this.zoom - this.fitZoom) < 1e-6;
		this.vw = w; this.vh = h;
		this.el.width = Math.round(w * this.dpr); this.el.height = Math.round(h * this.dpr);
		this.el.style.width = w + "px"; this.el.style.height = h + "px";
		if (this.image) { this.computeFit(); if (hadFit) this.fit(); else this.clamp(); }
		this.requestDraw();
	}

	private computeFit() {
		if (!this.image) return;
		this.fitZoom = Math.min(this.vw / this.image.w, this.vh / this.image.h) * 0.96;
		this.maxZoom = Math.max(4, this.fitZoom * 3);
	}

	fit() {
		if (!this.image) { this.requestDraw(); return; }
		this.computeFit();
		this.zoom = this.fitZoom;
		this.tx = (this.vw - this.image.w * this.zoom) / 2;
		this.ty = (this.vh - this.image.h * this.zoom) / 2;
		this.requestDraw();
	}

	zoomBy(f: number) { this.zoomAt(this.vw / 2, this.vh / 2, f); }

	private zoomAt(sx: number, sy: number, f: number) {
		const nz = Math.min(this.maxZoom, Math.max(this.fitZoom * 0.5, this.zoom * f));
		const k = nz / this.zoom;
		this.tx = sx - (sx - this.tx) * k;
		this.ty = sy - (sy - this.ty) * k;
		this.zoom = nz;
		this.clamp();
		this.requestDraw();
	}

	private clamp() {
		if (!this.image) return;
		const keep = 120;
		const mw = this.image.w * this.zoom, mh = this.image.h * this.zoom;
		this.tx = Math.min(this.vw - keep, Math.max(keep - mw, this.tx));
		this.ty = Math.min(this.vh - keep, Math.max(keep - mh, this.ty));
	}

	toNorm(sx: number, sy: number) {
		const im = this.image;
		if (!im) return { nx: 0, ny: 0 };
		return { nx: (sx - this.tx) / (im.w * this.zoom), ny: (sy - this.ty) / (im.h * this.zoom) };
	}

	/* ----------------------------- input ------------------------------ */

	private info(e: MouseEvent): PointerInfo {
		const r = this.el.getBoundingClientRect();
		const sx = e.clientX - r.left, sy = e.clientY - r.top;
		const { nx, ny } = this.toNorm(sx, sy);
		return { sx, sy, nx, ny, ux: nx, uy: ny * (this.dims ? this.dims.h / this.dims.w : 1), node: this.hitTest(sx, sy), button: e.button, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey, spaceHeld: this.spaceHeld };
	}

	private pdown = (e: PointerEvent) => {
		this.el.setPointerCapture(e.pointerId);
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (this.pointers.size === 2) {
			if (this.drag?.kind === "tool") this.onToolUp?.(this.info(e));
			const [a, b] = [...this.pointers.values()];
			this.drag = { kind: "pinch", x: 0, y: 0, moved: true, button: 0, dist: Math.hypot(a.x - b.x, a.y - b.y) };
			return;
		}
		const info = this.info(e);
		if (e.button === 1) e.preventDefault();
		const claim = e.button === 0 && !info.spaceHeld && !!this.onPointerDown?.(info);
		this.drag = { kind: claim ? "tool" : "pan", x: e.clientX, y: e.clientY, moved: false, button: e.button };
		if (e.button === 2) this.drag = null;
		this.requestDraw();
	};

	private pmove = (e: PointerEvent) => {
		const r = this.el.getBoundingClientRect();
		this.pointer = { sx: e.clientX - r.left, sy: e.clientY - r.top };
		const prev = this.pointers.get(e.pointerId);
		if (prev) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		const d = this.drag;
		if (d?.kind === "pinch" && this.pointers.size >= 2) {
			const [a, b] = [...this.pointers.values()];
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
			if (d.dist) this.zoomAt(cx, cy, dist / d.dist);
			d.dist = dist;
		} else if (d?.kind === "pan" && prev) {
			if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
			if (d.moved) {
				this.tx += e.clientX - prev.x; this.ty += e.clientY - prev.y;
				this.clamp();
			}
		} else if (d?.kind === "tool") {
			d.moved = true;
			this.onToolMove?.(this.info(e));
		} else {
			const hit = this.hitTest(this.pointer.sx, this.pointer.sy);
			this.hoverId = hit ? hit.id : null;
			this.onPointerMove?.(this.info(e));
		}
		this.updateCursor();
		this.requestDraw();
	};

	private pup = (e: PointerEvent) => {
		this.pointers.delete(e.pointerId);
		const d = this.drag;
		if (!d) return;
		if (d.kind === "pinch") { if (this.pointers.size < 2) this.drag = null; return; }
		const info = this.info(e);
		if (d.kind === "tool") this.onToolUp?.(info);
		else if (!d.moved && d.button === 0 && e.type === "pointerup") this.onClick?.(info);
		this.drag = null;
		this.requestDraw();
	};

	private pleave = () => { this.pointer = null; this.hoverId = null; this.requestDraw(); };

	private wheel = (e: WheelEvent) => {
		e.preventDefault();
		const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
		const r = this.el.getBoundingClientRect();
		this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)));
	};

	get unitScale() { return this.zoom * (this.dims?.w ?? 1); }

	updateCursor() {
		this.el.style.cursor = this.brush ? "none" : this.toolCursor ?? (this.hoverId ? "pointer" : "default");
	}

	private pathFor(d: RenderDrawing): Path2D {
		let c = this.paths.get(d.id);
		if (!c || c.d !== d.d) { c = { d: d.d, p: new Path2D(d.d) }; this.paths.set(d.id, c); }
		return c.p;
	}

	/** True if map-unit point (ux,uy) is within `r` (map units) of the drawing's stroke. */
	hitDrawing(d: RenderDrawing, ux: number, uy: number, r: number): boolean {
		const g = this.scratch;
		g.setTransform(1, 0, 0, 1, 0, 0);
		g.setLineDash([]);
		g.lineWidth = d.style.width + r * 2;
		g.lineCap = "round"; g.lineJoin = "round";
		return g.isPointInStroke(this.pathFor(d), ux, uy);
	}

	private drawDrawings() {
		if (!this.drawings.length || !this.image) return;
		const ctx = this.ctx, s = this.unitScale;
		ctx.save();
		ctx.translate(this.tx, this.ty);
		ctx.scale(s, s);
		for (const d of this.drawings) {
			const p = this.pathFor(d);
			if (d.id === this.selectedDrawingId) {
				ctx.setLineDash([]); ctx.lineCap = "round"; ctx.lineJoin = "round";
				ctx.lineWidth = Math.max(d.style.width, 1 / s) + 7 / s;
				ctx.strokeStyle = "rgba(77,163,255,0.45)";
				ctx.stroke(p);
			}
			applyLineStyle(ctx, d.style, 1 / s);
			ctx.stroke(p);
		}
		ctx.restore();
	}

	/* ---------------------------- layout/hit -------------------------- */

	private nodeSize(base: number, mult: number) {
		const f = this.settings.nodeScaling === "scale" ? Math.min(3, Math.max(0.35, this.zoom / this.fitZoom)) : 1;
		return base * mult * f;
	}

	private ordered(): RenderNode[] {
		const arr = [...this.nodes].sort((a, b) => a.y - b.y);
		const lift = (id: string | null) => { if (!id) return; const i = arr.findIndex((n) => n.id === id); if (i >= 0) arr.push(arr.splice(i, 1)[0]); };
		lift(this.hoverId); lift(this.selectedId);
		return arr;
	}

	private layout(n: RenderNode) {
		const im = this.image!;
		const sx = this.tx + n.x * im.w * this.zoom, sy = this.ty + n.y * im.h * this.zoom;
		const s = this.nodeSize(this.settings.pinSize, n.style.size);
		return { sx, sy, s, box: nodeBox(n.style, sx, sy, s) };
	}

	hitTest(px: number, py: number): RenderNode | null {
		if (!this.image) return null;
		const arr = this.ordered();
		for (let i = arr.length - 1; i >= 0; i--) {
			const { box } = this.layout(arr[i]);
			const pad = 4;
			if (px >= box.x0 - pad && px <= box.x1 + pad && py >= box.y0 - pad && py <= box.y1 + pad) return arr[i];
		}
		return null;
	}

	/* ------------------------------ draw ------------------------------ */

	requestDraw() {
		if (!this.raf) this.raf = requestAnimationFrame(this.frame);
	}

	private get animating() {
		return !!this.fogMask && this.fogLook.animate && this.fogOpacity > 0 && !document.hidden && this.el.isConnected;
	}

	private frame = (ts: number) => {
		this.raf = 0;
		if (this.animating && ts - this.lastDraw < 38) { this.requestDraw(); return; }
		this.lastDraw = ts;
		this.draw((ts - this.t0) / 1000);
		if (this.animating) this.requestDraw();
	};

	private draw(t: number) {
		const ctx = this.ctx, im = this.image;
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.clearRect(0, 0, this.vw, this.vh);
		if (!im) return;

		this.drawTiles();
		this.drawDrawings();

		if (this.fogMask && this.fogOpacity > 0) {
			this.fogRenderer.draw(ctx, this.fogMask, { zoom: this.zoom, tx: this.tx, ty: this.ty, vw: this.vw, vh: this.vh }, im.w, im.h, this.fogLook, this.fogOpacity, t);
		}

		const arr = this.ordered();
		for (const n of arr) {
			const { sx, sy, s } = this.layout(n);
			if (sx < -80 || sy < -80 || sx > this.vw + 80 || sy > this.vh + 80) continue;
			drawGlyph(ctx, this.icons, n.style, sx, sy, s, this.dpr, n.dim ? 0.5 : 1, n.id === this.selectedId);
		}
		if (this.drawOverlay) { ctx.save(); this.drawOverlay(ctx, { tx: this.tx, ty: this.ty, s: this.unitScale }); ctx.restore(); }
		const showAll = this.settings.labelMode === "always";
		for (const n of arr) {
			if (!n.title || (!showAll && n.id !== this.hoverId && n.id !== this.pinnedId)) continue;
			const { sx, s, box } = this.layout(n);
			if (sx < -200 || sx > this.vw + 200) continue;
			this.drawLabel(n.title, sx, box.y0, box.y1, s);
		}

		if (this.brush && this.pointer) {
			const r = this.brush.r * im.w * this.zoom;
			ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,0.55)";
			ctx.beginPath(); ctx.arc(this.pointer.sx, this.pointer.sy, r, 0, Math.PI * 2); ctx.stroke();
			ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.stroke();
		}
	}

	/* --------------------------- tiled image --------------------------- */

	/** Nearest built level to `want`, preferring coarser ones. */
	private pickLevel(want: number): number {
		const src = this.source!, n = src.levels.length;
		for (let d = 0; d < n; d++) {
			if (want + d < n && src.isBuilt(want + d)) return want + d;
			if (want - d >= 0 && src.isBuilt(want - d)) return want - d;
		}
		return want;
	}

	private drawTiles() {
		const src = this.source, ctx = this.ctx;
		if (!src) return;
		const W = src.w, H = src.h, zoom = this.zoom, n = src.levels.length;
		src.beginFrame();
		const vx0 = Math.max(0, -this.tx / zoom), vy0 = Math.max(0, -this.ty / zoom);
		const vx1 = Math.min(W, (this.vw - this.tx) / zoom), vy1 = Math.min(H, (this.vh - this.ty) / zoom);
		if (vx1 > vx0 && vy1 > vy0) {
			const ideal = Math.floor(Math.log2(1 / (zoom * this.dpr)));
			const L = this.pickLevel(Math.min(n - 1, Math.max(0, ideal)));
			const lv = src.levels[L];
			const fx = W / lv.w, fy = H / lv.h, T = lv.tile;
			const cols = Math.ceil(lv.w / T), rows = Math.ceil(lv.h / T);
			const tx0 = Math.max(0, Math.floor(vx0 / (T * fx))), tx1 = Math.min(cols - 1, Math.floor((vx1 - 1e-6) / (T * fx)));
			const ty0 = Math.max(0, Math.floor(vy0 / (T * fy))), ty1 = Math.min(rows - 1, Math.floor((vy1 - 1e-6) / (T * fy)));
			ctx.save();
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = "medium";
			for (let ty = ty0; ty <= ty1; ty++) {
				for (let tx = tx0; tx <= tx1; tx++) {
					const wx0 = Math.max(vx0, tx * T * fx), wx1 = Math.min(vx1, Math.min((tx + 1) * T, lv.w) * fx);
					const wy0 = Math.max(vy0, ty * T * fy), wy1 = Math.min(vy1, Math.min((ty + 1) * T, lv.h) * fy);
					const bmp = src.get(L, tx, ty);
					if (bmp) { this.blit(bmp, L, tx, ty, wx0, wy0, wx1, wy1); continue; }
					// not loaded yet: show the nearest coarser tile that is
					for (let k = 1; L + k < n; k++) {
						const a = src.peek(L + k, tx >> k, ty >> k);
						if (a) { this.blit(a, L + k, tx >> k, ty >> k, wx0, wy0, wx1, wy1); break; }
					}
				}
			}
			ctx.restore();
			// warm the ring of tiles just outside the view so panning doesn't pop
			for (let ty = Math.max(0, ty0 - 1); ty <= Math.min(rows - 1, ty1 + 1); ty++)
				for (let tx = Math.max(0, tx0 - 1); tx <= Math.min(cols - 1, tx1 + 1); tx++)
					if (tx < tx0 || tx > tx1 || ty < ty0 || ty > ty1) src.get(L, tx, ty);
		}
		src.endFrame();
	}

	/** Draw the part of a tile covering world rect (wx0..wx1, wy0..wy1) in device pixels. */
	private blit(bmp: CanvasImageSource, level: number, tx: number, ty: number, wx0: number, wy0: number, wx1: number, wy1: number) {
		const src = this.source!, lv = src.levels[level];
		const fx = src.w / lv.w, fy = src.h / lv.h, T = lv.tile;
		const bw = (bmp as ImageBitmap).width, bh = (bmp as ImageBitmap).height;
		let sx = wx0 / fx - tx * T, sy = wy0 / fy - ty * T;
		let sw = (wx1 - wx0) / fx, sh = (wy1 - wy0) / fy;
		sx = Math.max(0, sx); sy = Math.max(0, sy);
		sw = Math.min(sw, bw - sx); sh = Math.min(sh, bh - sy);
		if (sw <= 0 || sh <= 0) return;
		const d = this.dpr;
		const dx0 = Math.floor((this.tx + wx0 * this.zoom) * d), dx1 = Math.ceil((this.tx + wx1 * this.zoom) * d);
		const dy0 = Math.floor((this.ty + wy0 * this.zoom) * d), dy1 = Math.ceil((this.ty + wy1 * this.zoom) * d);
		this.ctx.drawImage(bmp, sx, sy, sw, sh, dx0, dy0, dx1 - dx0, dy1 - dy0);
	}

	private drawLabel(text: string, cx: number, top: number, bottom: number, s: number) {
		const ctx = this.ctx;
		const fs = this.settings.labelSize;
		ctx.font = `600 ${fs}px ${this.fontFamily}`;
		const w = ctx.measureText(text).width + 18, h = fs + 12;
		let x = Math.min(this.vw - w - 4, Math.max(4, cx - w / 2));
		let y = top - h - 7;
		if (y < 4) y = bottom + 7;
		ctx.save();
		ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
		ctx.fillStyle = "rgba(20,24,30,0.93)";
		roundRect(ctx, x, y, w, h, 7); ctx.fill();
		ctx.shadowColor = "transparent";
		ctx.strokeStyle = "rgba(255,255,255,0.16)"; ctx.lineWidth = 1; ctx.stroke();
		ctx.fillStyle = "#f3f1ec"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
		ctx.fillText(text, x + 9, y + h / 2 + 0.5);
		ctx.restore();
		void s;
	}
}
