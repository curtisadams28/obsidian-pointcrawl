import { FogData, FogLook, FogStroke } from "./types.js";
import { makeCloudAlpha, TEX_SIZE } from "./noise.js";

/* ------------------------------------------------------------------ */
/* Mask: a low-res canvas whose alpha channel is "how foggy is this?"  */
/* ------------------------------------------------------------------ */

const spriteCache = new Map<number, HTMLCanvasElement>();
function brushSprite(hardness: number): HTMLCanvasElement {
	const key = Math.round(hardness * 20);
	let s = spriteCache.get(key);
	if (s) return s;
	s = document.createElement("canvas");
	s.width = s.height = 128;
	const g = s.getContext("2d")!;
	const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
	const h = Math.min(0.95, Math.max(0, key / 20));
	grad.addColorStop(0, "rgba(255,255,255,1)");
	grad.addColorStop(h, "rgba(255,255,255,1)");
	grad.addColorStop(1, "rgba(255,255,255,0)");
	g.fillStyle = grad;
	g.fillRect(0, 0, 128, 128);
	spriteCache.set(key, s);
	return s;
}

export class FogMask {
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	/** Image height / width. */
	aspect: number;
	private snap: ImageData | null = null;

	constructor(aspect: number, longSide = 1024) {
		this.aspect = aspect;
		this.canvas = document.createElement("canvas");
		const w = aspect >= 1 ? Math.round(longSide / aspect) : longSide;
		const h = aspect >= 1 ? longSide : Math.round(longSide * aspect);
		this.canvas.width = Math.max(2, w);
		this.canvas.height = Math.max(2, h);
		this.ctx = this.canvas.getContext("2d")!;
	}

	/** Clear and replay everything. */
	reset(fog: FogData) {
		this.snap = null;
		const { ctx, canvas } = this;
		ctx.globalCompositeOperation = "source-over";
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		if (fog.base === "fogged") {
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
		}
		for (const s of fog.strokes) this.applyStroke(s);
	}

	applyStroke(s: FogStroke) {
		const p = s.p;
		if (p.length < 2) return;
		this.stamp(s, p[0], p[1]);
		for (let i = 2; i < p.length; i += 2) this.segment(s, p[i - 2], p[i - 1], p[i], p[i + 1]);
	}

	/** Paint from (x0,y0) to (x1,y1), image-fraction coords. */
	segment(s: FogStroke, x0: number, y0: number, x1: number, y1: number) {
		const W = this.canvas.width, H = this.canvas.height;
		const rpx = s.r * W;
		const dx = (x1 - x0) * W, dy = (y1 - y0) * H;
		const dist = Math.hypot(dx, dy);
		const step = Math.max(0.75, rpx * 0.18);
		const n = Math.max(1, Math.ceil(dist / step));
		for (let i = 1; i <= n; i++) this.stamp(s, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
	}

	stamp(s: FogStroke, nx: number, ny: number) {
		this.snap = null;
		const { ctx, canvas } = this;
		const r = Math.max(0.5, s.r * canvas.width);
		ctx.globalCompositeOperation = s.m === 0 ? "destination-out" : "source-over";
		ctx.drawImage(brushSprite(s.h), nx * canvas.width - r, ny * canvas.height - r, r * 2, r * 2);
		ctx.globalCompositeOperation = "source-over";
	}

	/** Fog amount (0 = clear, 1 = fully fogged) at an image-fraction position. */
	alphaAt(nx: number, ny: number): number {
		const x = Math.min(this.canvas.width - 1, Math.max(0, Math.floor(nx * this.canvas.width)));
		const y = Math.min(this.canvas.height - 1, Math.max(0, Math.floor(ny * this.canvas.height)));
		// one read-back per change, not one per node
		const snap = (this.snap ??= this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height));
		return snap.data[(y * snap.width + x) * 4 + 3] / 255;
	}

	/** Downscaled PNG data URL for publishing. */
	toDataURL(maxSide = 512): string {
		const long = Math.max(this.canvas.width, this.canvas.height);
		const k = Math.min(1, maxSide / long);
		const c = document.createElement("canvas");
		c.width = Math.max(2, Math.round(this.canvas.width * k));
		c.height = Math.max(2, Math.round(this.canvas.height * k));
		const g = c.getContext("2d")!;
		g.imageSmoothingQuality = "high";
		g.drawImage(this.canvas, 0, 0, c.width, c.height);
		return c.toDataURL("image/png");
	}
}

/** Build a mask canvas from a published PNG (player site). */
export async function maskFromDataURL(url: string): Promise<HTMLCanvasElement> {
	const img = new Image();
	img.src = url;
	await img.decode();
	const c = document.createElement("canvas");
	c.width = img.naturalWidth; c.height = img.naturalHeight;
	c.getContext("2d")!.drawImage(img, 0, 0);
	return c;
}

/* ------------------------------------------------------------------ */
/* Renderer: drifting layered clouds, cut out by the mask               */
/* ------------------------------------------------------------------ */

export interface FogView { zoom: number; tx: number; ty: number; vw: number; vh: number }

function mix(hex: string, to: [number, number, number], t: number): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	const n = m ? parseInt(m[1], 16) : 0xaeb9c2;
	const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	return `rgb(${c.map((v, i) => Math.round(v + (to[i] - v) * t)).join(",")})`;
}

let baseTextures: { dark: HTMLCanvasElement; a: HTMLCanvasElement; b: HTMLCanvasElement } | null = null;

export class FogRenderer {
	private buf = document.createElement("canvas");
	private alphaBuf = document.createElement("canvas");
	private bctx = this.buf.getContext("2d")!;
	private tinted = new Map<string, HTMLCanvasElement>();
	private patterns = new Map<string, CanvasPattern>();

	private textures() {
		if (!baseTextures) {
			baseTextures = {
				dark: makeCloudAlpha(11, 3, 5, 0.40, 0.70, 1.2),
				a: makeCloudAlpha(23, 3, 6, 0.38, 0.66, 1.0),
				b: makeCloudAlpha(37, 4, 6, 0.40, 0.68, 0.9),
			};
		}
		return baseTextures;
	}

	private pattern(name: "dark" | "a" | "b", color: string): CanvasPattern {
		const key = name + color;
		let p = this.patterns.get(key);
		if (p) return p;
		let t = this.tinted.get(key);
		if (!t) {
			const src = this.textures()[name];
			t = document.createElement("canvas");
			t.width = t.height = TEX_SIZE;
			const g = t.getContext("2d")!;
			g.drawImage(src, 0, 0);
			g.globalCompositeOperation = "source-in";
			g.fillStyle = color;
			g.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
			this.tinted.set(key, t);
		}
		p = this.bctx.createPattern(t, "repeat")!;
		this.patterns.set(key, p);
		return p;
	}

	/** True if the fog needs to keep re-rendering over time. */
	get animated() { return this._animated; }
	private _animated = false;

	draw(ctx: CanvasRenderingContext2D, mask: HTMLCanvasElement, v: FogView, W: number, H: number, look: FogLook, opacity: number, timeSec: number, fillOutside = false) {
		this._animated = look.animate;
		const q = 0.5;
		const bw = Math.max(2, Math.ceil(v.vw * q)), bh = Math.max(2, Math.ceil(v.vh * q));
		if (this.buf.width !== bw || this.buf.height !== bh) { this.buf.width = bw; this.buf.height = bh; }
		const b = this.bctx;
		b.imageSmoothingQuality = "high";
		b.setTransform(1, 0, 0, 1, 0, 0);
		b.globalCompositeOperation = "source-over";
		b.globalAlpha = 1;
		b.fillStyle = mix(look.color, [150, 160, 172], 0.12);
		b.fillRect(0, 0, bw, bh);

		const light = mix(look.color, [255, 255, 255], 0.65);
		const shade = mix(look.color, [40, 52, 70], 0.55);
		const maxD = Math.max(W, H);
		const speed = look.animate ? look.speed * maxD * 0.006 : 0;
		const layers = [
			{ n: "dark" as const, c: shade, tile: 0.95, a: 0.38, vx: 0.6, vy: 0.25 },
			{ n: "a" as const, c: light, tile: 0.6, a: 0.85, vx: -1.0, vy: 0.3 },
			{ n: "b" as const, c: light, tile: 0.34, a: 0.6, vx: 0.8, vy: -0.5 },
		];
		for (const L of layers) {
			const s = (L.tile * maxD) / TEX_SIZE;
			const dx = speed * L.vx * timeSec, dy = speed * L.vy * timeSec;
			b.setTransform(v.zoom * q, 0, 0, v.zoom * q, v.tx * q, v.ty * q);
			b.translate(dx, dy);
			b.scale(s, s);
			b.globalAlpha = L.a;
			b.fillStyle = this.pattern(L.n, L.c);
			const x0 = (-v.tx / v.zoom - dx) / s, y0 = (-v.ty / v.zoom - dy) / s;
			const x1 = ((v.vw - v.tx) / v.zoom - dx) / s, y1 = ((v.vh - v.ty) / v.zoom - dy) / s;
			b.fillRect(x0, y0, x1 - x0, y1 - y0);
		}

		b.setTransform(1, 0, 0, 1, 0, 0);
		b.globalAlpha = 1;
		const mx = v.tx * q, my = v.ty * q, mw = W * v.zoom * q, mh = H * v.zoom * q;
		b.globalCompositeOperation = "destination-in";
		if (fillOutside) {
			// alpha = the mask over the map, fully opaque everywhere else, so fog covers the whole screen
			const a = this.alphaBuf;
			if (a.width !== bw || a.height !== bh) { a.width = bw; a.height = bh; }
			const g = a.getContext("2d")!;
			g.setTransform(1, 0, 0, 1, 0, 0);
			g.globalCompositeOperation = "source-over";
			g.imageSmoothingQuality = "high";
			g.clearRect(0, 0, bw, bh);
			g.drawImage(mask, mx, my, mw, mh);
			// fill everything outside the map, adding (not blending) so the edge pixels don't leave a hairline
			g.save();
			g.beginPath(); g.rect(0, 0, bw, bh); g.rect(mx, my, mw, mh);
			g.clip("evenodd");
			g.globalCompositeOperation = "lighter";
			g.fillStyle = "#fff";
			g.fillRect(0, 0, bw, bh);
			g.restore();
			b.drawImage(a, 0, 0);
		} else {
			b.drawImage(mask, mx, my, mw, mh);
		}
		b.globalCompositeOperation = "source-over";

		ctx.save();
		ctx.globalAlpha = opacity;
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(this.buf, 0, 0, v.vw, v.vh);
		ctx.restore();
	}
}
