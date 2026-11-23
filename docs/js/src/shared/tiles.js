import { disposeImage } from "./image.js";
/** Whole-image levels (one tile per level). Used by the player page, where the published image is already small. */
export class PyramidSource {
    constructor(img) {
        this.img = img;
        this.w = img.w;
        this.h = img.h;
        this.levels = img.levels.map((l) => ({ w: l.w, h: l.h, tile: Math.max(l.w, l.h) }));
    }
    isBuilt() { return true; }
    beginFrame() { }
    endFrame() { }
    get(level, tx, ty) { return tx === 0 && ty === 0 ? this.img.levels[level]?.src ?? null : null; }
    peek(level, tx, ty) { return this.get(level, tx, ty); }
    setUpdateListener() { }
    dispose() { disposeImage(this.img); }
}
