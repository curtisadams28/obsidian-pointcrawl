import { readImageSize } from "./shared/image";
import { TileMeta, TileStore } from "./tilestore";

export const TILE_SIZE = 512;
export const BUILD_VERSION = 1;
const OVERVIEW_MAX = 2048;
const QUALITY = 0.92;

export const levelDims = (W: number, H: number, i: number) => ({ w: Math.max(1, Math.ceil(W / 2 ** i)), h: Math.max(1, Math.ceil(H / 2 ** i)) });
export function levelCount(W: number, H: number, T: number) { let n = 1; while (Math.ceil(Math.max(W, H) / 2 ** (n - 1)) > T) n++; return n; }

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const toBlob = (c: HTMLCanvasElement, mime: string) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Tile encode failed"))), mime, QUALITY));

async function pickMime(): Promise<string> {
	const c = document.createElement("canvas"); c.width = c.height = 2;
	const b = await new Promise<Blob | null>((r) => c.toBlob(r, "image/webp", 0.9));
	return b && b.type === "image/webp" ? "image/webp" : "image/jpeg";
}

/** Decode once. If the full image won't fit in memory, fall back to progressively smaller decodes. */
async function decode(blob: Blob, buf: ArrayBuffer): Promise<ImageBitmap> {
	try { return await createImageBitmap(blob); } catch (e) {
		const sz = readImageSize(buf);
		if (!sz) throw e;
		for (const cap of [12288, 8192, 6144, 4096]) {
			if (Math.max(sz.w, sz.h) <= cap) continue;
			const k = cap / Math.max(sz.w, sz.h);
			try { return await createImageBitmap(blob, { resizeWidth: Math.round(sz.w * k), resizeHeight: Math.round(sz.h * k), resizeQuality: "high" }); } catch { /* try smaller */ }
		}
		throw e;
	}
}

export interface BuildOptions {
	signal: { aborted: boolean };
	onStatus: (text: string, fraction: number) => void;
	/** Coarse levels are done: the map can be opened and used while detail levels keep building. */
	onReady: (meta: TileMeta) => void;
	onLevel: (level: number) => void;
}

export async function buildTiles(blob: Blob, buf: ArrayBuffer, store: TileStore, key: string, path: string, o: BuildOptions): Promise<TileMeta> {
	const T = TILE_SIZE;
	const mime = await pickMime();
	o.onStatus("Decoding image…", 0);
	await tick();
	const full = await decode(blob, buf);
	const W = full.width, H = full.height, n = levelCount(W, H, T);
	const meta: TileMeta = { key, path, w: W, h: H, tile: T, levels: n, built: [], complete: false, mime };
	await store.putMeta(meta);

	let total = 0, done = 0;
	for (let i = 0; i < n; i++) { const d = levelDims(W, H, i); total += Math.ceil(d.w / T) * Math.ceil(d.h / T); }

	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d")!;
	const check = () => { if (o.signal.aborted) throw new DOMException("aborted", "AbortError"); };
	const resize = (b: ImageBitmap, i: number) => { const d = levelDims(W, H, i); return createImageBitmap(b, { resizeWidth: d.w, resizeHeight: d.h, resizeQuality: "high" }); };

	async function tileLevel(bmp: ImageBitmap, i: number) {
		const d = levelDims(W, H, i);
		for (let ty = 0; ty * T < d.h; ty++) {
			for (let tx = 0; tx * T < d.w; tx++) {
				check();
				const tw = Math.min(T, d.w - tx * T), th = Math.min(T, d.h - ty * T);
				canvas.width = tw; canvas.height = th;
				ctx.drawImage(bmp, tx * T, ty * T, tw, th, 0, 0, tw, th);
				await store.putTile(key, i, tx, ty, await toBlob(canvas, mime));
				done++;
				if (done % 6 === 0) { o.onStatus("Building tiles…", done / total); await tick(); }
			}
		}
		meta.built.push(i);
		await store.putMeta(meta);
		o.onLevel(i);
	}

	const open: ImageBitmap[] = [];
	try {
		// Phase A: overview levels first, so the map is usable almost immediately.
		let ov = 0;
		while (ov < n - 1 && Math.max(levelDims(W, H, ov).w, levelDims(W, H, ov).h) > OVERVIEW_MAX) ov++;
		let cur = ov === 0 ? full : await resize(full, ov);
		if (cur !== full) open.push(cur);
		for (let i = ov; i < n; i++) {
			if (i > ov) { const nx = await resize(cur, i); if (cur !== full) { cur.close(); open.splice(open.indexOf(cur), 1); } cur = nx; open.push(cur); }
			await tileLevel(cur, i);
		}
		if (cur !== full) { cur.close(); open.splice(open.indexOf(cur), 1); }
		o.onReady(meta);

		// Phase B: detail levels, finest first.
		if (ov > 0) {
			await tileLevel(full, 0);
			let prev = full;
			for (let i = 1; i < ov; i++) {
				const b = await resize(prev, i);
				if (prev !== full) { prev.close(); open.splice(open.indexOf(prev), 1); }
				prev = b; open.push(b);
				await tileLevel(b, i);
			}
			if (prev !== full) { prev.close(); open.splice(open.indexOf(prev), 1); }
		}
		meta.complete = true;
		await store.putMeta(meta);
		o.onStatus("Map ready", 1);
		return meta;
	} finally {
		open.forEach((b) => b.close());
		full.close();
	}
}
