import { LoadedImage, disposeImage } from "./image.js";

export interface TileLevel { w: number; h: number; tile: number }

/**
 * A map image as a pyramid of tiles. Level 0 is full resolution; each level up is half the size.
 * "World" coordinates are level-0 pixels.
 */
export interface TileSource {
	readonly w: number;
	readonly h: number;
	readonly levels: TileLevel[];
	isBuilt(level: number): boolean;
	beginFrame(): void;
	/** Returns the tile if it's in memory, otherwise null and (maybe) schedules a load. */
	get(level: number, tx: number, ty: number): CanvasImageSource | null;
	/** Like get() but never schedules a load. */
	peek(level: number, tx: number, ty: number): CanvasImageSource | null;
	endFrame(): void;
	setUpdateListener(fn: (() => void) | null): void;
	dispose(): void;
}

/** Whole-image levels (one tile per level). Used by the player page, where the published image is already small. */
export class PyramidSource implements TileSource {
	readonly w: number;
	readonly h: number;
	readonly levels: TileLevel[];
	constructor(private img: LoadedImage) {
		this.w = img.w; this.h = img.h;
		this.levels = img.levels.map((l) => ({ w: l.w, h: l.h, tile: Math.max(l.w, l.h) }));
	}
	isBuilt() { return true; }
	beginFrame() {}
	endFrame() {}
	get(level: number, tx: number, ty: number) { return tx === 0 && ty === 0 ? this.img.levels[level]?.src ?? null : null; }
	peek(level: number, tx: number, ty: number) { return this.get(level, tx, ty); }
	setUpdateListener() {}
	dispose() { disposeImage(this.img); }
}
