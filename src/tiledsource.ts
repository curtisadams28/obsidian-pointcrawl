import { TileLevel, TileSource } from "./shared/tiles";
import { TileMeta, TileStore } from "./tilestore";

interface Pending { level: number; tx: number; ty: number; stamp: number }
const PIN_MAX_SIDE = 2048; // coarse levels stay in memory so there's always something to draw
const CONCURRENCY = 6;

export class TiledSource implements TileSource {
	readonly w: number;
	readonly h: number;
	readonly levels: TileLevel[];
	private built = new Set<number>();
	private cache = new Map<string, { bmp: ImageBitmap; used: number; level: number }>();
	private pending = new Map<string, Pending>();
	private inflight = new Set<string>();
	private missing = new Set<string>();
	private waiters: { level: number; res: () => void }[] = [];
	private frame = 0;
	private active = 0;
	private listener: (() => void) | null = null;
	private disposed = false;

	constructor(private store: TileStore, readonly meta: TileMeta, private maxTiles: number) {
		this.w = meta.w; this.h = meta.h;
		this.levels = [];
		for (let i = 0; i < meta.levels; i++) this.levels.push({ w: Math.max(1, Math.ceil(meta.w / 2 ** i)), h: Math.max(1, Math.ceil(meta.h / 2 ** i)), tile: meta.tile });
		meta.built.forEach((b) => this.built.add(b));
	}

	setBuilt(level: number) {
		this.built.add(level);
		this.waiters = this.waiters.filter((w) => { if (this.built.has(w.level)) { w.res(); return false; } return true; });
		this.listener?.();
	}
	whenBuilt(level: number) { return this.built.has(level) ? Promise.resolve() : new Promise<void>((res) => this.waiters.push({ level, res })); }

	isBuilt(level: number) { return this.built.has(level); }
	setUpdateListener(fn: (() => void) | null) { this.listener = fn; }
	beginFrame() { this.frame++; }

	peek(level: number, tx: number, ty: number) {
		const e = this.cache.get(`${level}/${tx}/${ty}`);
		if (!e) return null;
		e.used = this.frame;
		return e.bmp;
	}

	get(level: number, tx: number, ty: number) {
		const k = `${level}/${tx}/${ty}`;
		const e = this.cache.get(k);
		if (e) { e.used = this.frame; return e.bmp; }
		if (!this.built.has(level) || this.missing.has(k) || this.inflight.has(k)) return null;
		const p = this.pending.get(k);
		if (p) p.stamp = this.frame; else this.pending.set(k, { level, tx, ty, stamp: this.frame });
		return null;
	}

	endFrame() { this.pump(); this.evict(); }

	private pump() {
		if (this.disposed) return;
		while (this.active < CONCURRENCY && this.pending.size) {
			let bestK = "", best: Pending | null = null;
			for (const [k, p] of this.pending) {
				if (p.stamp < this.frame - 3) { this.pending.delete(k); continue; } // scrolled away
				if (!best || p.level > best.level || (p.level === best.level && p.stamp > best.stamp)) { best = p; bestK = k; }
			}
			if (!best) return;
			this.pending.delete(bestK);
			void this.load(bestK, best);
		}
	}

	private async load(k: string, p: Pending) {
		this.active++; this.inflight.add(k);
		try {
			const blob = await this.store.getTile(this.meta.key, p.level, p.tx, p.ty);
			if (!blob) { this.missing.add(k); return; }
			const bmp = await createImageBitmap(blob);
			if (this.disposed) { bmp.close(); return; }
			this.cache.set(k, { bmp, used: this.frame, level: p.level });
			this.listener?.();
		} catch { this.missing.add(k); } finally {
			this.active--; this.inflight.delete(k);
			this.pump();
		}
	}

	private evict() {
		if (this.cache.size <= this.maxTiles) return;
		const victims = [...this.cache.entries()]
			.filter(([, e]) => e.used < this.frame && Math.max(this.levels[e.level].w, this.levels[e.level].h) > PIN_MAX_SIDE)
			.sort((a, b) => a[1].used - b[1].used);
		for (const [k, e] of victims) {
			if (this.cache.size <= this.maxTiles) break;
			e.bmp.close(); this.cache.delete(k);
		}
	}

	/** Downscaled WebP of the whole map for the player site, assembled from the stored tiles. */
	async renderScaled(maxSide: number, quality = 0.86): Promise<Blob> {
		const scale = Math.min(1, maxSide / Math.max(this.w, this.h));
		const tw = Math.max(1, Math.round(this.w * scale)), th = Math.max(1, Math.round(this.h * scale));
		let L = 0;
		for (let i = this.levels.length - 1; i >= 0; i--) if (Math.max(this.levels[i].w, this.levels[i].h) >= Math.max(tw, th)) { L = i; break; }
		await this.whenBuilt(L);
		const lv = this.levels[L], T = lv.tile;
		const c = document.createElement("canvas");
		c.width = tw; c.height = th;
		const g = c.getContext("2d")!;
		g.imageSmoothingQuality = "high";
		for (let ty = 0; ty * T < lv.h; ty++) {
			for (let tx = 0; tx * T < lv.w; tx++) {
				const blob = await this.store.getTile(this.meta.key, L, tx, ty);
				if (!blob) throw new Error("Tile cache is incomplete. Reopen the map.");
				const bmp = await createImageBitmap(blob);
				const x0 = Math.floor((tx * T * tw) / lv.w), x1 = Math.ceil((Math.min((tx + 1) * T, lv.w) * tw) / lv.w);
				const y0 = Math.floor((ty * T * th) / lv.h), y1 = Math.ceil((Math.min((ty + 1) * T, lv.h) * th) / lv.h);
				g.drawImage(bmp, x0, y0, x1 - x0, y1 - y0);
				bmp.close();
			}
		}
		return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Image encode failed"))), "image/webp", quality));
	}

	dispose() {
		this.disposed = true;
		this.cache.forEach((e) => e.bmp.close());
		this.cache.clear(); this.pending.clear();
		this.listener = null;
	}
}
