/** Loads the black-on-transparent icon pack and serves tinted copies (cached). */
export class IconStore {
	private imgs = new Map<string, HTMLImageElement>();
	private tints = new Map<string, HTMLCanvasElement>();
	private custom = new Map<string, { src: string; raw: boolean }>();
	private boxes = new Map<string, { x: number; y: number; w: number; h: number }>();
	private listeners = new Set<() => void>();
	addListener(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

	constructor(private resolve: (id: string) => string | undefined) {}

	/** Custom icons: `raw` keeps their own colours instead of tinting. */
	register(id: string, src: string, raw: boolean) {
		this.custom.set(id, { src, raw });
		this.imgs.delete(id); this.boxes.delete(id); this.tints.clear();
		this.listeners.forEach((f) => f());
	}
	unregister(id: string) { this.custom.delete(id); this.imgs.delete(id); this.boxes.delete(id); this.tints.clear(); }

	private image(id: string): HTMLImageElement | null {
		let img = this.imgs.get(id);
		if (!img) {
			const src = this.custom.get(id)?.src ?? this.resolve(id);
			if (!src) return null;
			img = new Image();
			img.onload = () => { this.tints.clear(); this.listeners.forEach((f) => f()); };
			img.src = src;
			this.imgs.set(id, img);
		}
		return img.complete && img.naturalWidth ? img : null;
	}

	/** Bounding box of the drawn pixels, so artwork fills the node instead of the padded frame. */
	private bbox(id: string, img: HTMLImageElement) {
		let b = this.boxes.get(id);
		if (b) return b;
		const w = img.naturalWidth, h = img.naturalHeight;
		const c = document.createElement("canvas");
		c.width = w; c.height = h;
		const g = c.getContext("2d", { willReadFrequently: true })!;
		g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, w, h).data;
		let x0 = w, y0 = h, x1 = 0, y1 = 0;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			if (d[(y * w + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
		}
		if (x1 < x0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
		b = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
		this.boxes.set(id, b);
		return b;
	}

	/** A square canvas (px + halo padding) with the icon tinted `color`. */
	tinted(id: string, color: string, px: number, halo: boolean): HTMLCanvasElement | null {
		px = Math.max(8, Math.ceil(px / 8) * 8);
		const key = `${id}|${color}|${px}|${halo}`;
		let c = this.tints.get(key);
		if (c) return c;
		const img = this.image(id);
		if (!img) return null;
		const pad = halo ? 3 : 0;
		const bb = this.bbox(id, img);
		const k = px / Math.max(bb.w, bb.h);
		const dw = bb.w * k, dh = bb.h * k, ox = (px - dw) / 2, oy = (px - dh) / 2;
		const sil = document.createElement("canvas");
		sil.width = sil.height = px;
		const sg = sil.getContext("2d")!;
		sg.imageSmoothingQuality = "high";
		sg.drawImage(img, bb.x, bb.y, bb.w, bb.h, ox, oy, dw, dh);
		if (this.custom.get(id)?.raw) { this.tints.set(key, sil); return sil; } // keeps original colours
		sg.globalCompositeOperation = "source-in";
		sg.fillStyle = color;
		sg.fillRect(0, 0, px, px);
		c = document.createElement("canvas");
		c.width = c.height = px + pad * 2;
		const g = c.getContext("2d")!;
		if (halo) {
			const hs = document.createElement("canvas");
			hs.width = hs.height = px;
			const hg = hs.getContext("2d")!;
			hg.drawImage(img, bb.x, bb.y, bb.w, bb.h, ox, oy, dw, dh);
			hg.globalCompositeOperation = "source-in";
			hg.fillStyle = luminance(color) > 0.5 ? "#000000" : "#ffffff";
			hg.fillRect(0, 0, px, px);
			g.globalAlpha = 0.85;
			for (let i = 0; i < 12; i++) {
				const a = (i / 12) * Math.PI * 2;
				g.drawImage(hs, pad + Math.cos(a) * 2.2, pad + Math.sin(a) * 2.2);
			}
			g.globalAlpha = 1;
		}
		g.drawImage(sil, pad, pad);
		this.tints.set(key, c);
		return c;
	}
}

export function luminance(hex: string): number {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return 0;
	const n = parseInt(m[1], 16);
	return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
