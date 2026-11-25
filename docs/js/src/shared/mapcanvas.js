import { FogRenderer } from "./fog.js";
import { applyLineStyle } from "./drawing.js";
import { formatDistance, niceBar } from "./scale.js";
import { textHit, textRenderer } from "./text.js";
import { DEFAULT_SCALE } from "./types.js";
/* ----------------------------- glyphs -------------------------------- */
export function nodeBox(style, x, y, s) {
    if (style.shape === "icon" && style.icon) {
        const h = s * 0.58;
        return { x0: x - h, y0: y - h, x1: x + h, y1: y + h, cx: x, cy: y };
    }
    const r = s * 0.4;
    return { x0: x - r, y0: y - 3 * r, x1: x + r, y1: y, cx: x, cy: y - 2 * r };
}
export function drawGlyph(ctx, icons, style, x, y, s, dpr, alpha = 1, selected = false) {
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
        if (selected) {
            ctx.strokeStyle = "#4da3ff";
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.arc(x, y, s * 0.72, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
        return;
    }
    const r = s * 0.4, cx = box.cx, cy = box.cy;
    const p = new Path2D();
    p.moveTo(x, y);
    p.lineTo(cx + r * Math.cos(Math.PI / 6), cy + r * Math.sin(Math.PI / 6));
    p.arc(cx, cy, r, Math.PI / 6, (5 * Math.PI) / 6, true);
    p.closePath();
    ctx.shadowColor = "rgba(0,0,0,0.4)";
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 1.5;
    ctx.fillStyle = style.color;
    ctx.fill(p);
    ctx.shadowColor = "transparent";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.2, s * 0.07);
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.stroke(p);
    if (style.icon) {
        const bg = style.iconBg !== false;
        if (bg) {
            ctx.fillStyle = "rgba(255,255,255,0.94)";
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
            ctx.fill();
        }
        const px = bg ? r * 1.15 : r * 1.5; // without the disc the icon can use the whole head
        const t = icons.tinted(style.icon, style.iconColor || "#1b1b1b", Math.ceil(px * dpr), false);
        if (t)
            ctx.drawImage(t, cx - px / 2, cy - px / 2, px, px);
    }
    else if (style.iconBg !== false) {
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.38, 0, Math.PI * 2);
        ctx.fill();
    }
    if (selected) {
        ctx.strokeStyle = "#4da3ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
/* ----------------------------- canvas -------------------------------- */
export class MapCanvas {
    get image() { return this.dims; }
    constructor(host, icons) {
        this.host = host;
        this.icons = icons;
        this.fogRenderer = new FogRenderer();
        this.raf = 0;
        this.t0 = performance.now();
        this.lastDraw = 0;
        this.dpr = 1;
        this.vw = 1;
        this.vh = 1;
        this.source = null;
        this.dims = null;
        this.zoom = 1;
        this.tx = 0;
        this.ty = 0;
        this.fitZoom = 1;
        this.maxZoom = 4;
        this.nodes = [];
        this.drawings = [];
        this.texts = [];
        this.selectedDrawingId = null;
        /** CSS cursor for the active tool (null = normal pointer). */
        this.toolCursor = null;
        this.paths = new Map();
        this.scratch = document.createElement("canvas").getContext("2d");
        this.selectedId = null;
        this.hoverId = null;
        /** Label kept visible regardless of hover (used for tap-to-reveal on touch screens). */
        this.pinnedId = null;
        this.settings = { labelMode: "hover", labelSize: 14, pinSize: 30, nodeScaling: "fixed" };
        this.fogMask = null;
        this.fogLook = { color: "#aeb9c2", density: 1, animate: true, speed: 1 };
        this.fogOpacity = 1;
        /** Brush radius as a fraction of image width; shows a ring under the pointer. */
        this.brush = null;
        this.spaceHeld = false;
        this.fontFamily = "system-ui, sans-serif";
        this.pointers = new Map();
        this.pointer = null;
        this.drag = null;
        this.panGrab = false;
        this.samples = [];
        this.flingRaf = 0;
        this.avgColor = null;
        this.lastPointerType = "mouse";
        /** Map scale (for the scale bar and the ruler). */
        this.scale = { ...DEFAULT_SCALE };
        /** Cover everything outside the map with fog too (player view). */
        this.fogOutside = false;
        /** Distance in px from the left / bottom edge for the scale bar. */
        this.scaleInset = { x: 14, y: 14 };
        this.rulerActive = false;
        this.ruler = null;
        this.pdown = (e) => {
            try {
                this.el.setPointerCapture(e.pointerId);
            }
            catch { /* pointer already gone */ }
            this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (this.pointers.size === 2) {
                if (this.drag?.kind === "tool")
                    this.onToolUp?.(this.info(e));
                if (this.ruler)
                    this.ruler.dragging = false;
                const [a, b] = [...this.pointers.values()];
                this.drag = { kind: "pinch", x: 0, y: 0, moved: true, button: 0, dist: Math.hypot(a.x - b.x, a.y - b.y) };
                return;
            }
            this.lastPointerType = e.pointerType;
            this.stopFling();
            this.samples = [];
            // Ctrl+click is a right click on macOS
            const button = e.button === 0 && e.ctrlKey && /Mac/.test(navigator.platform) ? 2 : e.button;
            const info = this.info(e, button);
            if (button === 1 || button === 2)
                e.preventDefault();
            if (button === 0 && !info.spaceHeld && this.rulerActive) {
                this.rulerDown(info);
                this.drag = { kind: "ruler", x: e.clientX, y: e.clientY, moved: false, button };
                this.requestDraw();
                return;
            }
            const claim = button === 0 && !info.spaceHeld && !!this.onPointerDown?.(info);
            // right / middle button, or Space + left, pans with whichever tool is selected
            this.drag = { kind: claim ? "tool" : "pan", x: e.clientX, y: e.clientY, moved: false, button, grab: button !== 0 || info.spaceHeld };
            this.requestDraw();
        };
        this.pmove = (e) => {
            const r = this.el.getBoundingClientRect();
            this.pointer = { sx: e.clientX - r.left, sy: e.clientY - r.top };
            const prev = this.pointers.get(e.pointerId);
            if (prev)
                this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const d = this.drag;
            if (d?.kind === "pinch" && this.pointers.size >= 2) {
                const [a, b] = [...this.pointers.values()];
                const dist = Math.hypot(a.x - b.x, a.y - b.y);
                const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
                if (d.dist)
                    this.zoomAt(cx, cy, dist / d.dist);
                d.dist = dist;
            }
            else if (d?.kind === "pan" && prev) {
                if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4)
                    d.moved = true;
                if (d.moved) {
                    this.tx += e.clientX - prev.x;
                    this.ty += e.clientY - prev.y;
                    this.clamp();
                    if (d.grab)
                        this.panGrab = true;
                    this.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
                    if (this.samples.length > 8)
                        this.samples.shift();
                }
            }
            else if (d?.kind === "ruler") {
                if (this.ruler)
                    this.ruler.cursor = [this.info(e).ux, this.info(e).uy];
            }
            else if (d?.kind === "tool") {
                d.moved = true;
                this.onToolMove?.(this.info(e));
            }
            else {
                const hit = this.hitTest(this.pointer.sx, this.pointer.sy);
                this.hoverId = hit ? hit.id : null;
                this.onPointerMove?.(this.info(e));
            }
            this.updateCursor();
            this.requestDraw();
        };
        this.pup = (e) => {
            this.pointers.delete(e.pointerId);
            const d = this.drag;
            if (!d)
                return;
            if (d.kind === "pinch") {
                if (this.pointers.size < 2)
                    this.drag = null;
                return;
            }
            const info = this.info(e, d.button);
            if (d.kind === "tool")
                this.onToolUp?.(info);
            else if (d.kind === "ruler")
                this.rulerUp();
            else if (d.kind === "pan" && d.moved && e.type === "pointerup" && e.pointerType !== "mouse")
                this.fling(e.timeStamp);
            else if (!d.moved && e.type === "pointerup") {
                if (d.button === 0)
                    this.onClick?.(info);
                else if (d.button === 2)
                    this.onContext?.(info, e); // a plain right click, not a drag
            }
            this.drag = null;
            this.panGrab = false;
            this.updateCursor();
            this.requestDraw();
        };
        this.pleave = () => { this.pointer = null; this.hoverId = null; this.requestDraw(); };
        this.wheel = (e) => {
            e.preventDefault();
            const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
            const r = this.el.getBoundingClientRect();
            this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)));
        };
        this.frame = (ts) => {
            this.raf = 0;
            if (this.animating && ts - this.lastDraw < 38) {
                this.requestDraw();
                return;
            }
            this.lastDraw = ts;
            this.draw((ts - this.t0) / 1000);
            if (this.animating)
                this.requestDraw();
        };
        this.el = document.createElement("canvas");
        this.el.className = "pc-canvas";
        host.appendChild(this.el);
        this.el.style.touchAction = "none";
        this.el.style.display = "block";
        this.ctx = this.el.getContext("2d");
        this.unsubIcons = this.icons.addListener(() => this.requestDraw());
        this.unsubText = textRenderer.onChange(() => this.requestDraw());
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
        // Mouse: the menu is opened on release, and only if the right button wasn't dragged (see pup).
        // Touch / pen long-press has no button release to wait for, so it opens straight away.
        e.addEventListener("contextmenu", (ev) => { ev.preventDefault(); if (this.lastPointerType !== "mouse")
            this.onContext?.(this.info(ev), ev); });
        this.resize();
    }
    destroy() {
        this.ro.disconnect();
        this.unsubIcons();
        this.unsubText();
        this.stopFling();
        cancelAnimationFrame(this.raf);
        this.el.remove();
    }
    /* ------------------------------ view ------------------------------ */
    /** The canvas never owns the source; whoever created it disposes it. */
    setSource(src) {
        this.source?.setUpdateListener(null);
        this.source = src;
        this.avgColor = null;
        this.dims = src ? { w: src.w, h: src.h } : null;
        src?.setUpdateListener(() => this.requestDraw());
        this.fit();
    }
    resize() {
        const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        const hadFit = Math.abs(this.zoom - this.fitZoom) < 1e-6;
        this.vw = w;
        this.vh = h;
        this.el.width = Math.round(w * this.dpr);
        this.el.height = Math.round(h * this.dpr);
        this.el.style.width = w + "px";
        this.el.style.height = h + "px";
        if (this.image) {
            this.computeFit();
            if (hadFit)
                this.fit();
            else
                this.clamp();
        }
        this.draw((performance.now() - this.t0) / 1000);
        this.requestDraw();
    }
    computeFit() {
        if (!this.image)
            return;
        this.fitZoom = Math.min(this.vw / this.image.w, this.vh / this.image.h) * 0.96;
        this.maxZoom = Math.max(4, this.fitZoom * 3);
    }
    fit() {
        this.stopFling();
        if (!this.image) {
            this.requestDraw();
            return;
        }
        this.computeFit();
        this.zoom = this.fitZoom;
        this.tx = (this.vw - this.image.w * this.zoom) / 2;
        this.ty = (this.vh - this.image.h * this.zoom) / 2;
        this.requestDraw();
    }
    zoomBy(f) { this.zoomAt(this.vw / 2, this.vh / 2, f); }
    zoomAt(sx, sy, f) {
        this.stopFling();
        const nz = Math.min(this.maxZoom, Math.max(this.fitZoom * 0.5, this.zoom * f));
        const k = nz / this.zoom;
        this.tx = sx - (sx - this.tx) * k;
        this.ty = sy - (sy - this.ty) * k;
        this.zoom = nz;
        this.clamp();
        this.requestDraw();
    }
    clamp() {
        if (!this.image)
            return;
        const keep = 120;
        const mw = this.image.w * this.zoom, mh = this.image.h * this.zoom;
        this.tx = Math.min(this.vw - keep, Math.max(keep - mw, this.tx));
        this.ty = Math.min(this.vh - keep, Math.max(keep - mh, this.ty));
    }
    toNorm(sx, sy) {
        const im = this.image;
        if (!im)
            return { nx: 0, ny: 0 };
        return { nx: (sx - this.tx) / (im.w * this.zoom), ny: (sy - this.ty) / (im.h * this.zoom) };
    }
    /* ----------------------------- input ------------------------------ */
    info(e, button = e.button) {
        const r = this.el.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        const { nx, ny } = this.toNorm(sx, sy);
        return { sx, sy, nx, ny, ux: nx, uy: ny * (this.dims ? this.dims.h / this.dims.w : 1), node: this.hitTest(sx, sy), button, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey, spaceHeld: this.spaceHeld };
    }
    /* ------------------------- touch momentum ------------------------- */
    stopFling() { if (this.flingRaf) {
        cancelAnimationFrame(this.flingRaf);
        this.flingRaf = 0;
    } }
    /** Keep gliding after a touch swipe, slowing down smoothly. Faster swipes travel further. */
    fling(now) {
        const s = this.samples.filter((p) => now - p.t < 100);
        this.samples = [];
        if (s.length < 2)
            return;
        const a = s[0], b = s[s.length - 1], dt = b.t - a.t;
        if (dt < 1 || now - b.t > 60)
            return; // finger paused before lifting
        const cap = 6;
        let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt; // px per ms
        const sp = Math.hypot(vx, vy);
        if (sp < 0.12)
            return;
        if (sp > cap) {
            vx *= cap / sp;
            vy *= cap / sp;
        }
        const tau = 380; // ms; distance travelled = velocity x tau
        let last = performance.now();
        const step = (t) => {
            const dtm = Math.min(48, t - last);
            last = t;
            const k = Math.exp(-dtm / tau), dx = vx * tau * (1 - k), dy = vy * tau * (1 - k);
            vx *= k;
            vy *= k;
            const ox = this.tx + dx, oy = this.ty + dy;
            this.tx = ox;
            this.ty = oy;
            this.clamp();
            if (this.tx !== ox)
                vx = 0; // hit the edge
            if (this.ty !== oy)
                vy = 0;
            this.requestDraw();
            this.flingRaf = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
        };
        this.flingRaf = requestAnimationFrame(step);
    }
    /** Topmost text under a point (map units), if any. */
    hitText(ux, uy, pad = 0) {
        for (let i = this.texts.length - 1; i >= 0; i--)
            if (textHit(this.texts[i], ux, uy, pad))
                return this.texts[i];
        return null;
    }
    drawTexts() {
        if (!this.texts.length || !this.image)
            return;
        const ctx = this.ctx, s = this.unitScale;
        for (const t of this.texts) {
            const lay = textRenderer.layout(t);
            const sx = this.tx + t.x * s, sy = this.ty + t.y * s, em = t.size * s; // css px per em
            const r = Math.max(lay.box.x1 - lay.box.x0, lay.box.y1 - lay.box.y0) * em;
            if (sx < -r || sy < -r || sx > this.vw + r || sy > this.vh + r || em * 0.3 < 1)
                continue;
            const spr = textRenderer.sprite(t, em * this.dpr);
            if (!spr)
                continue;
            const f = (em * this.dpr) / spr.ppe / this.dpr;
            ctx.save();
            ctx.translate(sx, sy);
            if (t.rot)
                ctx.rotate(t.rot);
            ctx.scale(f, f);
            ctx.drawImage(spr.canvas, -spr.ax, -spr.ay);
            ctx.restore();
        }
    }
    get unitScale() { return this.zoom * (this.dims?.w ?? 1); }
    updateCursor() {
        this.el.style.cursor = this.panGrab ? "grabbing" : this.rulerActive ? "crosshair" : this.brush ? "none" : this.toolCursor ?? (this.hoverId ? "pointer" : "default");
    }
    pathFor(d) {
        let c = this.paths.get(d.id);
        if (!c || c.d !== d.d) {
            c = { d: d.d, p: new Path2D(d.d) };
            this.paths.set(d.id, c);
        }
        return c.p;
    }
    /** True if map-unit point (ux,uy) is within `r` (map units) of the drawing's stroke. */
    hitDrawing(d, ux, uy, r) {
        const g = this.scratch;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.setLineDash([]);
        g.lineWidth = d.style.width + r * 2;
        g.lineCap = "round";
        g.lineJoin = "round";
        return g.isPointInStroke(this.pathFor(d), ux, uy);
    }
    drawDrawings() {
        if (!this.drawings.length || !this.image)
            return;
        const ctx = this.ctx, s = this.unitScale;
        ctx.save();
        ctx.translate(this.tx, this.ty);
        ctx.scale(s, s);
        for (const d of this.drawings) {
            const p = this.pathFor(d);
            if (d.id === this.selectedDrawingId) {
                ctx.setLineDash([]);
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
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
    nodeSize(base, mult) {
        const f = this.settings.nodeScaling === "scale" ? Math.min(3, Math.max(0.35, this.zoom / this.fitZoom)) : 1;
        return base * mult * f;
    }
    ordered() {
        const arr = [...this.nodes].sort((a, b) => a.y - b.y);
        const lift = (id) => { if (!id)
            return; const i = arr.findIndex((n) => n.id === id); if (i >= 0)
            arr.push(arr.splice(i, 1)[0]); };
        lift(this.hoverId);
        lift(this.selectedId);
        return arr;
    }
    layout(n) {
        const im = this.image;
        const sx = this.tx + n.x * im.w * this.zoom, sy = this.ty + n.y * im.h * this.zoom;
        const s = this.nodeSize(this.settings.pinSize, n.style.size);
        return { sx, sy, s, box: nodeBox(n.style, sx, sy, s) };
    }
    hitTest(px, py) {
        if (!this.image)
            return null;
        const arr = this.ordered();
        for (let i = arr.length - 1; i >= 0; i--) {
            const { box } = this.layout(arr[i]);
            const pad = 4;
            if (px >= box.x0 - pad && px <= box.x1 + pad && py >= box.y0 - pad && py <= box.y1 + pad)
                return arr[i];
        }
        return null;
    }
    /* ------------------------------ draw ------------------------------ */
    requestDraw() {
        if (!this.raf)
            this.raf = requestAnimationFrame(this.frame);
    }
    get animating() {
        return !!this.fogMask && this.fogLook.animate && this.fogOpacity > 0 && !document.hidden && this.el.isConnected;
    }
    draw(t) {
        const ctx = this.ctx, im = this.image;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, this.vw, this.vh);
        if (!im)
            return;
        if (this.fogOutside && this.fogMask)
            this.fillOutsideTint();
        this.drawTiles();
        this.drawDrawings();
        this.drawTexts();
        if (this.fogMask && this.fogOpacity > 0) {
            this.fogRenderer.draw(ctx, this.fogMask, { zoom: this.zoom, tx: this.tx, ty: this.ty, vw: this.vw, vh: this.vh }, im.w, im.h, this.fogLook, this.fogOpacity, t, this.fogOutside);
        }
        const arr = this.ordered();
        for (const n of arr) {
            const { sx, sy, s } = this.layout(n);
            if (sx < -80 || sy < -80 || sx > this.vw + 80 || sy > this.vh + 80)
                continue;
            drawGlyph(ctx, this.icons, n.style, sx, sy, s, this.dpr, n.dim ? 0.5 : 1, n.id === this.selectedId);
        }
        if (this.drawOverlay) {
            ctx.save();
            this.drawOverlay(ctx, { tx: this.tx, ty: this.ty, s: this.unitScale });
            ctx.restore();
        }
        const showAll = this.settings.labelMode === "always";
        for (const n of arr) {
            if (!n.title || (!showAll && n.id !== this.hoverId && n.id !== this.pinnedId))
                continue;
            const { sx, s, box } = this.layout(n);
            if (sx < -200 || sx > this.vw + 200)
                continue;
            this.drawLabel(n.title, sx, box.y0, box.y1, s);
        }
        if (this.brush && this.pointer && !this.panGrab && !this.rulerActive) {
            const r = this.brush.r * im.w * this.zoom;
            ctx.lineWidth = 3;
            ctx.strokeStyle = "rgba(0,0,0,0.55)";
            ctx.beginPath();
            ctx.arc(this.pointer.sx, this.pointer.sy, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "rgba(255,255,255,0.9)";
            ctx.stroke();
        }
        this.drawRuler(ctx);
        this.drawScaleBar(ctx);
    }
    /* ------------------------------- ruler ------------------------------ */
    get hasRuler() { return !!this.ruler; }
    setRulerActive(on) {
        this.rulerActive = on;
        if (!on)
            this.ruler = null;
        this.updateCursor();
        this.requestDraw();
    }
    clearRuler() { this.ruler = null; this.requestDraw(); }
    /** Press-drag-release measures a line. Shift+drag continues from the end of the last one. */
    rulerDown(p) {
        const r = this.ruler;
        if (p.shift && r && r.pts.length >= 4) {
            r.dragging = true;
            r.base = r.pts.length - 2;
            r.cursor = [p.ux, p.uy];
            return;
        }
        this.ruler = { pts: [p.ux, p.uy], cursor: [p.ux, p.uy], dragging: true, base: 0 };
    }
    rulerUp() {
        const r = this.ruler;
        if (!r)
            return;
        r.dragging = false;
        const from = [r.pts[r.base], r.pts[r.base + 1]];
        if (!r.cursor || Math.hypot(r.cursor[0] - from[0], r.cursor[1] - from[1]) * this.unitScale < 5) {
            if (r.pts.length < 4)
                this.ruler = null; // a plain click clears it
            r.cursor = null;
            return;
        }
        r.pts.push(r.cursor[0], r.cursor[1]);
        r.cursor = null;
        let total = 0;
        for (let i = 2; i < r.pts.length; i += 2)
            total += Math.hypot(r.pts[i] - r.pts[i - 2], r.pts[i + 1] - r.pts[i - 1]);
        this.onRulerDone?.(total);
    }
    pill(ctx, text, cx, cy, fs) {
        ctx.font = `600 ${fs}px ${this.fontFamily}`;
        const w = ctx.measureText(text).width + 14, h = fs + 9;
        const x = Math.min(this.vw - w - 4, Math.max(4, cx - w / 2)), y = Math.min(this.vh - h - 4, Math.max(4, cy - h / 2));
        ctx.save();
        ctx.fillStyle = "rgba(20,24,30,0.92)";
        roundRect(ctx, x, y, w, h, 6);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "#f3f1ec";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
        ctx.restore();
    }
    drawRuler(ctx) {
        const r = this.ruler;
        if (!r || !this.image)
            return;
        const pts = r.dragging && r.cursor ? [...r.pts, r.cursor[0], r.cursor[1]] : r.pts;
        if (pts.length < 4)
            return;
        const s = this.unitScale, X = (i) => this.tx + pts[i] * s, Y = (i) => this.ty + pts[i + 1] * s;
        ctx.save();
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(X(0), Y(0));
        for (let i = 2; i < pts.length; i += 2)
            ctx.lineTo(X(i), Y(i));
        ctx.setLineDash([]);
        ctx.lineWidth = 5;
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.stroke();
        ctx.setLineDash([9, 6]);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.setLineDash([]);
        for (let i = 0; i < pts.length; i += 2) {
            ctx.beginPath();
            ctx.arc(X(i), Y(i), 4.5, 0, Math.PI * 2);
            ctx.fillStyle = "#fff";
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "rgba(0,0,0,0.7)";
            ctx.stroke();
        }
        ctx.restore();
        let total = 0;
        const segs = (pts.length - 2) / 2;
        for (let i = 2; i < pts.length; i += 2) {
            const len = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
            total += len;
            if (segs > 1)
                this.pill(ctx, formatDistance(len, this.scale), (X(i) + X(i - 2)) / 2, (Y(i) + Y(i - 2)) / 2, 11);
        }
        const last = pts.length - 2;
        this.pill(ctx, (segs > 1 ? "Total " : "") + formatDistance(total, this.scale), X(last) + 4, Y(last) - 22, 13);
    }
    /* ----------------------------- scale bar ---------------------------- */
    drawScaleBar(ctx) {
        const sc = this.scale;
        if (!this.image || !sc || !sc.show || !(sc.mapWidth > 0))
            return;
        const { px, label } = niceBar(sc, sc.mapWidth / this.unitScale);
        const w = px + 20, h = 36;
        const x = this.scaleInset.x, y = this.vh - this.scaleInset.y - h;
        ctx.save();
        ctx.fillStyle = "rgba(14,19,23,0.72)";
        roundRect(ctx, x, y, w, h, 7);
        ctx.fill();
        ctx.font = `600 12px ${this.fontFamily}`;
        ctx.fillStyle = "#f3f1ec";
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        ctx.fillText(label, x + 10, y + 15);
        const bx = x + 10, by = y + 22;
        ctx.fillStyle = "#f3f1ec";
        ctx.fillRect(bx, by, px / 2, 5);
        ctx.fillStyle = "#6c747c";
        ctx.fillRect(bx + px / 2, by, px / 2, 5);
        ctx.strokeStyle = "#f3f1ec";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(bx, by, px, 5);
        ctx.restore();
    }
    /**
     * With fog covering the whole screen, a little of what is under it shows through. Tint the area outside
     * the map with the map's average colour so the map's edge doesn't show up as a faint rectangle.
     */
    fillOutsideTint() {
        const src = this.source;
        if (!src)
            return;
        if (!this.avgColor) {
            const L = src.levels.length - 1;
            const t = src.peek(L, 0, 0) ?? src.get(L, 0, 0);
            if (!t)
                return;
            const mid = document.createElement("canvas");
            mid.width = mid.height = 16;
            const g = mid.getContext("2d", { willReadFrequently: true });
            g.imageSmoothingQuality = "high";
            g.drawImage(t, 0, 0, 16, 16);
            const one = document.createElement("canvas");
            one.width = one.height = 1;
            const g1 = one.getContext("2d", { willReadFrequently: true });
            g1.drawImage(mid, 0, 0, 1, 1);
            const d = g1.getImageData(0, 0, 1, 1).data;
            this.avgColor = `rgb(${d[0]},${d[1]},${d[2]})`;
        }
        this.ctx.fillStyle = this.avgColor;
        this.ctx.fillRect(0, 0, this.vw, this.vh);
    }
    /* --------------------------- tiled image --------------------------- */
    /** Nearest built level to `want`, preferring coarser ones. */
    pickLevel(want) {
        const src = this.source, n = src.levels.length;
        for (let d = 0; d < n; d++) {
            if (want + d < n && src.isBuilt(want + d))
                return want + d;
            if (want - d >= 0 && src.isBuilt(want - d))
                return want - d;
        }
        return want;
    }
    drawTiles() {
        const src = this.source, ctx = this.ctx;
        if (!src)
            return;
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
                    if (bmp) {
                        this.blit(bmp, L, tx, ty, wx0, wy0, wx1, wy1);
                        continue;
                    }
                    // not loaded yet: show the nearest coarser tile that is
                    for (let k = 1; L + k < n; k++) {
                        const a = src.peek(L + k, tx >> k, ty >> k);
                        if (a) {
                            this.blit(a, L + k, tx >> k, ty >> k, wx0, wy0, wx1, wy1);
                            break;
                        }
                    }
                }
            }
            ctx.restore();
            // warm the ring of tiles just outside the view so panning doesn't pop
            for (let ty = Math.max(0, ty0 - 1); ty <= Math.min(rows - 1, ty1 + 1); ty++)
                for (let tx = Math.max(0, tx0 - 1); tx <= Math.min(cols - 1, tx1 + 1); tx++)
                    if (tx < tx0 || tx > tx1 || ty < ty0 || ty > ty1)
                        src.get(L, tx, ty);
        }
        src.endFrame();
    }
    /** Draw the part of a tile covering world rect (wx0..wx1, wy0..wy1) in device pixels. */
    blit(bmp, level, tx, ty, wx0, wy0, wx1, wy1) {
        const src = this.source, lv = src.levels[level];
        const fx = src.w / lv.w, fy = src.h / lv.h, T = lv.tile;
        const bw = bmp.width, bh = bmp.height;
        let sx = wx0 / fx - tx * T, sy = wy0 / fy - ty * T;
        let sw = (wx1 - wx0) / fx, sh = (wy1 - wy0) / fy;
        sx = Math.max(0, sx);
        sy = Math.max(0, sy);
        sw = Math.min(sw, bw - sx);
        sh = Math.min(sh, bh - sy);
        if (sw <= 0 || sh <= 0)
            return;
        const d = this.dpr;
        const dx0 = Math.floor((this.tx + wx0 * this.zoom) * d), dx1 = Math.ceil((this.tx + wx1 * this.zoom) * d);
        const dy0 = Math.floor((this.ty + wy0 * this.zoom) * d), dy1 = Math.ceil((this.ty + wy1 * this.zoom) * d);
        this.ctx.drawImage(bmp, sx, sy, sw, sh, dx0, dy0, dx1 - dx0, dy1 - dy0);
    }
    drawLabel(text, cx, top, bottom, s) {
        const ctx = this.ctx;
        const fs = this.settings.labelSize;
        ctx.font = `600 ${fs}px ${this.fontFamily}`;
        const w = ctx.measureText(text).width + 18, h = fs + 12;
        let x = Math.min(this.vw - w - 4, Math.max(4, cx - w / 2));
        let y = top - h - 7;
        if (y < 4)
            y = bottom + 7;
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.35)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle = "rgba(20,24,30,0.93)";
        roundRect(ctx, x, y, w, h, 7);
        ctx.fill();
        ctx.shadowColor = "transparent";
        ctx.strokeStyle = "rgba(255,255,255,0.16)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "#f3f1ec";
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.fillText(text, x + 9, y + h / 2 + 0.5);
        ctx.restore();
        void s;
    }
}
