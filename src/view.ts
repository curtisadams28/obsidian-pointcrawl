import { Menu, Notice, TFile, TextFileView, WorkspaceLeaf, requestUrl, setIcon } from "obsidian";
import type PointCrawlPlugin from "./main";
import { PublishQueue, playerUrl, textToBase64, toBase64 } from "./github";
import { CalibrateModal, ConfirmModal, ImagePickerModal, MapSettingsModal, NodeModal } from "./modals";
import { FogMask } from "./shared/fog";
import { LiveHost, topicFor } from "./shared/live";
import { unitShort } from "./shared/scale";
import { MapCanvas, PointerInfo, RenderNode } from "./shared/mapcanvas";
import { BUILD_VERSION, TILE_SIZE, buildTiles } from "./tilebuilder";
import { TiledSource } from "./tiledsource";
import { TileMeta } from "./tilestore";
import { applyLineStyle, eraseFree, penD, simplify, smoothD } from "./shared/drawing";
import { DEFAULT_SCALE, DEFAULT_FOG_LOOK, DEFAULT_MAP_SETTINGS, DashStyle, Drawing, FogStroke, LineStyle, MapFile, PCNode, PenAnchor, PublishedState, uid } from "./shared/types";

export const VIEW_TYPE = "pointcrawl-map";
type Mode = "edit" | "view" | "player";
type Tool = "select" | "pen" | "free" | "erase" | "reveal" | "hide";
const FOG_TOOLS: Tool[] = ["reveal", "hide"];
const LINE_UNIT = 0.0004; // width slider step, as a fraction of image width

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", avif: "image/avif" };
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function normalizeMap(raw: any, plugin: PointCrawlPlugin): MapFile {
	const d = plugin.settings.mapDefaults;
	return {
		version: 1,
		id: raw.id || uid(),
		name: raw.name || "Map",
		image: raw.image || "",
		nodes: Array.isArray(raw.nodes) ? raw.nodes : [],
		drawings: Array.isArray(raw.drawings) ? raw.drawings : [],
		fog: { enabled: raw.fog?.enabled ?? true, base: raw.fog?.base ?? "fogged", strokes: Array.isArray(raw.fog?.strokes) ? raw.fog.strokes : [] },
		settings: { ...DEFAULT_MAP_SETTINGS, ...d, ...(raw.settings ?? {}), fogLook: { ...DEFAULT_FOG_LOOK, ...d.fogLook, ...(raw.settings?.fogLook ?? {}) }, scale: { ...DEFAULT_SCALE, ...d.scale, ...(raw.settings?.scale ?? {}) } },
	};
}

export class PointCrawlView extends TextFileView {
	private map: MapFile | null = null;
	private canvas: MapCanvas | null = null;
	private mask: FogMask | null = null;
	private source: TiledSource | null = null;
	private sourceKey = "";
	private loadToken = 0;
	private buildAbort: { aborted: boolean } | null = null;

	private mode: Mode = "edit";
	private tool: Tool = "select";
	private brushSize: number;
	private brushSoft: number;
	private live = false;
	private host: LiveHost | null = null;
	private lineStyle: LineStyle;
	private eraserSize: number;
	private drawUndo: string[] = [];
	private selDrawing: string | null = null;
	private free: number[] | null = null;
	private erasing = false;
	private eraseSnap = false;
	private pen: { anchors: PenAnchor[]; dragging: boolean; hover: [number, number] | null } | null = null;
	private lineCtl!: { color: HTMLInputElement; width: HTMLInputElement; dash: HTMLSelectElement };

	private stroke: FogStroke | null = null;
	private lastPt: [number, number] = [0, 0];
	private dragNode: { id: string; ox: number; oy: number; moved: boolean } | null = null;
	private selectedId: string | null = null;

	private queue: PublishQueue;
	private el!: { toolbar: HTMLElement; stage: HTMLElement; overlay: HTMLElement; status: HTMLElement; peers: HTMLElement; buttons: Record<string, HTMLElement>; groups: Record<string, HTMLElement> };

	constructor(leaf: WorkspaceLeaf, private plugin: PointCrawlPlugin) {
		super(leaf);
		this.brushSize = plugin.settings.brushSize;
		this.brushSoft = plugin.settings.brushSoftness;
		this.lineStyle = { ...plugin.settings.lineDefaults };
		this.eraserSize = plugin.settings.eraserSize;
		this.queue = new PublishQueue(() => this.publishJob(), (msg, err) => this.setStatus(msg, err));
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return this.file?.basename ?? "Point crawl map"; }
	getIcon() { return "map-pin"; }

	/* ------------------------------ file io ----------------------------- */

	getViewData() { return this.map ? JSON.stringify(this.map) : this.data; }
	clear() { this.map = null; this.selectedId = null; }

	setViewData(data: string, _clear: boolean) {
		this.data = data;
		try {
			const raw = data.trim() ? JSON.parse(data) : {};
			this.map = normalizeMap(raw, this.plugin);
		} catch {
			this.map = null;
			this.showOverlay("This file isn't valid point crawl JSON.");
			return;
		}
		void this.initMap();
	}

	/* ------------------------------ lifecycle --------------------------- */

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("pc-view");
		root.tabIndex = 0;
		const toolbar = root.createDiv({ cls: "pc-toolbar" });
		const stage = root.createDiv({ cls: "pc-stage" });
		const overlay = stage.createDiv({ cls: "pc-overlay pc-hidden" });
		this.el = { toolbar, stage, overlay, status: null as any, peers: null as any, buttons: {}, groups: {} };
		this.buildToolbar();

		this.canvas = new MapCanvas(stage, this.plugin.icons);
		this.canvas.fontFamily = getComputedStyle(root).fontFamily || "system-ui, sans-serif";
		this.bindCanvas(this.canvas);
		stage.appendChild(overlay);

		root.addEventListener("keydown", this.onKeyDown);
		root.addEventListener("keyup", this.onKeyUp);
		this.registerDomEvent(window, "blur", () => { if (this.canvas) this.canvas.spaceHeld = false; });
		this.registerEvent(this.app.vault.on("rename", (f, old) => {
			if (this.map && old === this.map.image) { this.map.image = f.path; this.requestSave(); }
		}));
		this.syncUI();
		if (this.map) void this.initMap();
	}

	async onClose() {
		this.queue.cancel();
		this.stopHost();
		this.canvas?.destroy();
		this.canvas = null;
		this.buildAbort && (this.buildAbort.aborted = true);
		this.source?.dispose();
		this.source = null; this.sourceKey = "";
	}

	/* ------------------------------ loading ----------------------------- */

	private showOverlay(text: string, action?: { label: string; fn: () => void }) {
		const o = this.el?.overlay;
		if (!o) return;
		o.empty();
		o.removeClass("pc-hidden");
		o.createDiv({ text });
		if (action) o.createEl("button", { text: action.label, cls: "mod-cta" }).addEventListener("click", action.fn);
	}
	private hideOverlay() { this.el?.overlay.addClass("pc-hidden"); }

	private resolveImage(): TFile | null {
		if (!this.map) return null;
		const direct = this.app.vault.getAbstractFileByPath(this.map.image);
		if (direct instanceof TFile) return direct;
		const viaLink = this.app.metadataCache.getFirstLinkpathDest(this.map.image, this.file?.path ?? "");
		return viaLink ?? null;
	}

	private async initMap() {
		const map = this.map;
		if (!map || !this.canvas) return;
		const token = ++this.loadToken;
		const imgFile = this.resolveImage();
		if (!imgFile) {
			this.showOverlay(`Map image not found: ${map.image || "(none set)"}`, { label: "Choose image", fn: () => new ImagePickerModal(this.app, (f) => { map.image = f.path; this.requestSave(); void this.initMap(); }).open() });
			return;
		}
		const key = `${imgFile.path}|${imgFile.stat.mtime}|${imgFile.stat.size}|t${TILE_SIZE}v${BUILD_VERSION}`;
		if (key !== this.sourceKey) {
			if (this.buildAbort) this.buildAbort.aborted = true;
			this.source?.dispose(); this.source = null;
			this.canvas.setSource(null);
			this.sourceKey = key;
			const store = this.plugin.tileStore;
			await store.ready();
			let meta = await store.getMeta(key);
			if (meta && !meta.complete) { await store.deleteKey(key); meta = null; }
			await store.deleteStale(imgFile.path, key);
			if (token !== this.loadToken) return;
			if (meta) this.attach(new TiledSource(store, meta, this.plugin.settings.tileBudget));
			else if (!(await this.buildTiles(imgFile, key, token))) return;
		}
		this.afterSource();
	}

	/** First open of an image: cut it into tiles. Returns false if it failed or was superseded. */
	private async buildTiles(imgFile: TFile, key: string, token: number): Promise<boolean> {
		const store = this.plugin.tileStore;
		this.showOverlay("Preparing map… large images take a little while the first time. After that it opens instantly.");
		let bin: ArrayBuffer;
		try { bin = await this.app.vault.readBinary(imgFile); } catch (e) { this.sourceKey = ""; this.showOverlay(`Couldn't read the image: ${(e as Error).message}`); return false; }
		const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", avif: "image/avif" } as Record<string, string>)[imgFile.extension.toLowerCase()] ?? "image/png";
		const signal = { aborted: false };
		this.buildAbort = signal;
		let opened!: (ok: boolean) => void;
		const readyP = new Promise<boolean>((r) => (opened = r));
		const status = (t: string, f: number) => {
			if (token !== this.loadToken) return;
			const pct = Math.round(f * 100);
			this.setStatus(f >= 1 ? t : `${t} ${pct}%`, false);
			if (!this.el.overlay.hasClass("pc-hidden")) this.showOverlay(`${t} ${f > 0 ? pct + "%" : ""}`);
		};
		buildTiles(new Blob([bin], { type: mime }), bin, store, key, imgFile.path, {
			signal,
			onStatus: status,
			onReady: (meta: TileMeta) => {
				if (signal.aborted || token !== this.loadToken) return opened(false);
				const src = new TiledSource(store, meta, this.plugin.settings.tileBudget);
				this.attach(src);
				opened(true);
			},
			onLevel: (i) => this.source?.setBuilt(i),
		}).then(() => { if (token === this.loadToken) window.setTimeout(() => this.setStatus("", false), 2500); })
			.catch((e: Error) => {
				if (e.name === "AbortError") return opened(false);
				if (this.sourceKey === key) this.sourceKey = "";
				this.showOverlay(`Couldn't prepare the image: ${e.message}`);
				opened(false);
			});
		return readyP;
	}

	private attach(src: TiledSource) {
		this.source = src;
		this.canvas?.setSource(src);
	}

	private afterSource() {
		const map = this.map, src = this.source;
		if (!map || !src) return;
		this.mask = new FogMask(src.h / src.w, this.plugin.settings.fogResolution);
		this.mask.reset(map.fog);
		this.hideOverlay();
		this.syncUI();
		this.refresh();
	}

	/* ------------------------------ render state ------------------------- */

	private playerVisible(n: PCNode): boolean {
		if (n.visibility === "gm") return false;
		if (n.visibility === "always") return true;
		const m = this.map!;
		if (!m.fog.enabled || !m.settings.hideNodesInFog || !this.mask) return true;
		return this.mask.alphaAt(n.x, n.y) < 0.4;
	}

	private renderNodes(): RenderNode[] {
		const m = this.map!;
		const out: RenderNode[] = [];
		for (const n of m.nodes) {
			const vis = this.playerVisible(n);
			if (this.mode === "player" && !vis) continue;
			out.push({ id: n.id, x: n.x, y: n.y, title: n.title, style: n.style, dim: this.mode !== "player" && !vis });
		}
		return out;
	}

	/** Push everything the canvas needs. Cheap enough to call after any change. */
	private refresh() {
		const c = this.canvas, m = this.map;
		if (!c || !m) return;
		const edit = this.mode === "edit";
		c.settings = { labelMode: m.settings.labelMode, labelSize: m.settings.labelSize, pinSize: m.settings.pinSize, nodeScaling: m.settings.nodeScaling };
		c.fogMask = m.fog.enabled && this.mask ? this.mask.canvas : null;
		c.fogLook = { ...m.settings.fogLook, animate: m.settings.fogLook.animate && (this.mode === "player" || this.plugin.settings.animateInEditor) };
		c.fogOpacity = this.mode === "player" ? m.settings.fogLook.density : this.plugin.settings.editorFogOpacity;
		c.brush = edit && FOG_TOOLS.includes(this.tool) ? { r: this.brushSize } : edit && this.tool === "erase" ? { r: this.eraserSize } : null;
		c.toolCursor = edit && (this.tool === "pen" || this.tool === "free") ? "crosshair" : null;
		c.scale = m.settings.scale;
		c.fogOutside = this.mode === "player";
		c.drawings = m.drawings;
		c.selectedDrawingId = edit ? this.selDrawing : null;
		c.drawOverlay = edit ? this.drawToolOverlay : undefined;
		c.nodes = this.renderNodes();
		c.selectedId = edit ? this.selectedId : null;
		c.updateCursor();
		c.requestDraw();
	}

	private changed(opts: { image?: boolean } = {}) {
		this.requestSave();
		if (opts.image) void this.initMap(); else this.refresh();
		if (this.live) { this.host?.broadcastSoon(); this.queue.schedule(this.plugin.settings.github.debounceSec * 1000); }
	}

	/* ------------------------------ toolbar ------------------------------ */

	private btn(group: string, id: string, icon: string, label: string, fn: () => void): HTMLElement {
		const parent = (this.el.groups[group] ??= this.el.toolbar.createDiv({ cls: `pc-group pc-group-${group}` }));
		const b = parent.createDiv({ cls: "clickable-icon pc-btn", attr: { "aria-label": label, "data-tooltip-position": "bottom" } });
		setIcon(b, icon);
		b.addEventListener("click", fn);
		this.el.buttons[id] = b;
		return b;
	}

	private slider(group: string, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void) {
		const parent = (this.el.groups[group] ??= this.el.toolbar.createDiv({ cls: `pc-group pc-group-${group}` }));
		const wrap = parent.createDiv({ cls: "pc-slider", attr: { "aria-label": label, "data-tooltip-position": "bottom" } });
		wrap.createSpan({ text: label });
		const inp = wrap.createEl("input", { type: "range", attr: { min: String(min), max: String(max), step: String(step) } });
		inp.value = String(get());
		inp.addEventListener("input", () => set(+inp.value));
		return inp;
	}

	private buildToolbar() {
		this.btn("mode", "edit", "pencil", "Edit", () => this.setMode("edit"));
		this.btn("mode", "view", "eye", "View (click pins to open notes)", () => this.setMode("view"));
		this.btn("mode", "player", "users", "Preview what players see", () => this.setMode("player"));

		this.btn("tools", "select", "mouse-pointer-2", "Select. Drag nodes to move them; double-click or right-click the map to add one", () => this.setTool("select"));
		this.btn("tools", "pen", "pen-tool", "Pen: click for corners, click-drag for curves. Enter or double-click to finish, click the first point to close", () => this.setTool("pen"));
		this.btn("tools", "free", "brush", "Freehand line", () => this.setTool("free"));
		this.btn("tools", "erase", "eraser", "Eraser for lines", () => this.setTool("erase"));
		this.btn("fogtools", "reveal", "cloud-off", "Reveal fog", () => this.setTool("reveal"));
		this.btn("fogtools", "hide", "cloud-fog", "Add fog back", () => this.setTool("hide"));

		// line style (pen / freehand / selected line)
		const lg = (this.el.groups["line"] = this.el.toolbar.createDiv({ cls: "pc-group pc-group-line" }));
		const color = lg.createEl("input", { type: "color", cls: "pc-color", attr: { "aria-label": "Line colour" } });
		color.addEventListener("input", () => this.setLine({ color: color.value }));
		const wrap = lg.createDiv({ cls: "pc-slider", attr: { "aria-label": "Line width" } });
		wrap.createSpan({ text: "Width" });
		const width = wrap.createEl("input", { type: "range", attr: { min: "1", max: "20", step: "1" } });
		width.addEventListener("input", () => this.setLine({ width: +width.value * LINE_UNIT }));
		const dash = lg.createEl("select", { cls: "dropdown", attr: { "aria-label": "Line style" } });
		for (const [v, l] of [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"], ["dashdot", "Dash-dot"]]) dash.createEl("option", { value: v, text: l });
		dash.addEventListener("change", () => this.setLine({ dash: dash.value as DashStyle }));
		this.lineCtl = { color, width, dash };

		this.slider("eraser", "Eraser", 0.004, 0.08, 0.002, () => this.eraserSize, (v) => { this.eraserSize = v; this.refresh(); });

		this.slider("brush", "Size", 0.005, 0.15, 0.0025, () => this.brushSize, (v) => { this.brushSize = v; this.refresh(); });
		this.slider("brush", "Softness", 0, 1, 0.05, () => this.brushSoft, (v) => { this.brushSoft = v; });
		this.btn("brush", "fogall", "cloud", "Cover the whole map in fog", () => this.confirmFog("fogged"));
		this.btn("brush", "clearall", "sun", "Clear all fog", () => this.confirmFog("clear"));

		this.btn("undo", "undo", "undo-2", "Undo (Ctrl/Cmd+Z)", () => this.undo());

		const right = (this.el.groups["right"] = this.el.toolbar.createDiv({ cls: "pc-group pc-group-right" }));
		this.el.peers = right.createSpan({ cls: "pc-peers pc-hidden" });
		this.el.status = right.createSpan({ cls: "pc-status" });
		this.btn("right", "link", "link", "Copy player link", () => this.copyLink());
		this.btn("right", "publish", "cloud-upload", "Publish to player site now", async () => { if (await this.queue.run()) new Notice("Player site updated."); });
		this.btn("right", "live", "radio", "Live updates to player site", () => this.toggleLive());
		this.btn("right", "ruler", "ruler", "Ruler: drag to measure, Shift+drag to add a leg, Esc to clear", () => this.setRuler(!this.canvas?.rulerActive));
		this.btn("right", "fit", "maximize", "Fit map to window", () => this.canvas?.fit());
		this.btn("right", "settings", "settings", "Map settings", () => this.openMapSettings());
	}

	private activeLine(): LineStyle {
		return this.map?.drawings.find((d) => d.id === this.selDrawing)?.style ?? this.lineStyle;
	}

	private setLine(p: Partial<LineStyle>) {
		Object.assign(this.lineStyle, p);
		const sel = this.map?.drawings.find((d) => d.id === this.selDrawing);
		if (sel && this.tool === "select") { this.pushUndo(); Object.assign(sel.style, p); this.changed(); } else this.canvas?.requestDraw();
	}

	private syncUI() {
		const b = this.el?.buttons, g = this.el?.groups;
		if (!b) return;
		for (const k of ["edit", "view", "player"]) b[k].toggleClass("is-active", this.mode === k);
		for (const k of ["select", "pen", "free", "erase", "reveal", "hide"]) b[k].toggleClass("is-active", this.tool === k);
		b["live"].toggleClass("is-active", this.live);
		b["ruler"].toggleClass("is-active", !!this.canvas?.rulerActive);
		const edit = this.mode === "edit";
		const fogOn = !!this.map?.fog.enabled;
		const fogTool = FOG_TOOLS.includes(this.tool);
		g["tools"].toggleClass("pc-hidden", !edit);
		g["fogtools"].toggleClass("pc-hidden", !(edit && fogOn));
		g["line"].toggleClass("pc-hidden", !(edit && (this.tool === "pen" || this.tool === "free" || (this.tool === "select" && !!this.selDrawing))));
		g["eraser"].toggleClass("pc-hidden", !(edit && this.tool === "erase"));
		g["brush"].toggleClass("pc-hidden", !(edit && fogOn && fogTool));
		g["undo"].toggleClass("pc-hidden", !edit);
		const ln = this.activeLine();
		this.lineCtl.color.value = ln.color;
		this.lineCtl.width.value = String(Math.max(1, Math.round(ln.width / LINE_UNIT)));
		this.lineCtl.dash.value = ln.dash;
	}

	private setMode(m: Mode) {
		this.finishPen();
		this.mode = m;
		if (m !== "edit") { this.tool = "select"; this.selectedId = null; this.selDrawing = null; }
		this.syncUI(); this.refresh();
	}
	private setTool(t: Tool) {
		this.finishPen();
		if (this.canvas?.rulerActive) this.setRuler(false);
		this.tool = t;
		if (t !== "select") { this.selectedId = null; this.selDrawing = null; }
		this.syncUI(); this.refresh();
	}

	private setStatus(msg: string, err: boolean) {
		const s = this.el?.status;
		if (!s) return;
		s.setText(msg);
		s.toggleClass("is-error", err);
		s.setAttr("aria-label", msg);
		if (err) new Notice(`Point Crawl: ${msg}`, 8000);
	}

	/* ------------------------------ canvas events ------------------------ */

	private findNode(id: string) { return this.map?.nodes.find((n) => n.id === id); }

	private bindCanvas(c: MapCanvas) {
		c.el.addEventListener("pointerdown", () => this.contentEl.focus({ preventScroll: true }));

		c.onRulerDone = (len) => this.onRulerDone(len);

		c.onPointerDown = (p) => {
			if (this.mode !== "edit" || !this.map) return false;
			switch (this.tool) {
				case "select": {
					if (!p.node) return false;
					if (p.ctrl) { this.openNote(p.node.id, true); return true; }
					this.selectedId = p.node.id; this.selDrawing = null;
					const n = this.findNode(p.node.id)!;
					this.dragNode = { id: n.id, ox: n.x - p.nx, oy: n.y - p.ny, moved: false };
					this.syncUI(); this.refresh();
					return true;
				}
				case "free": this.free = [p.ux, p.uy]; return true;
				case "pen": this.penDown(p); return true;
				case "erase": this.erasing = true; this.eraseSnap = false; this.eraseAt(p); return true;
				default: this.beginStroke(p); return true;
			}
		};

		c.onToolMove = (p) => {
			if (this.dragNode) {
				const n = this.findNode(this.dragNode.id);
				if (!n) return;
				n.x = clamp01(p.nx + this.dragNode.ox); n.y = clamp01(p.ny + this.dragNode.oy);
				this.dragNode.moved = true;
				const rn = c.nodes.find((x) => x.id === n.id);
				if (rn) { rn.x = n.x; rn.y = n.y; }
				c.requestDraw();
			} else if (this.stroke) this.extendStroke(p);
			else if (this.free) this.extendFree(p);
			else if (this.pen?.dragging) this.penDrag(p);
			else if (this.erasing) this.eraseAt(p);
		};

		c.onToolUp = () => {
			if (this.dragNode) { const moved = this.dragNode.moved; this.dragNode = null; if (moved) this.changed(); }
			if (this.stroke) this.endStroke();
			if (this.free) this.endFree();
			if (this.pen) this.pen.dragging = false;
			if (this.erasing) { this.erasing = false; if (this.eraseSnap) this.changed(); }
		};

		c.onPointerMove = (p) => {
			if (this.pen && this.mode === "edit") { this.pen.hover = [p.ux, p.uy]; c.requestDraw(); }
		};

		c.onClick = (p) => {
			if (p.node) {
				if (this.mode !== "edit" && this.plugin.settings.openOnClick) this.openNote(p.node.id, p.ctrl);
				else if (this.mode === "edit") { this.selectedId = p.node.id; this.selDrawing = null; this.syncUI(); this.refresh(); }
				return;
			}
			if (this.mode !== "edit" || this.tool !== "select") return;
			const hit = this.drawingAt(p.ux, p.uy);
			this.selDrawing = hit?.id ?? null;
			this.selectedId = null;
			this.syncUI(); this.refresh();
		};

		c.onDblClick = (p) => {
			if (this.mode !== "edit" || !this.map) return;
			if (this.tool === "pen" && this.pen) {
				const a = this.pen.anchors;
				if (a.length > 1) { // the double-click's second click added a duplicate anchor
					const l = a[a.length - 1], q = a[a.length - 2];
					if (Math.hypot(l.x - q.x, l.y - q.y) * c.unitScale < 6) a.pop();
				}
				this.finishPen();
				return;
			}
			if (this.tool !== "select") return;
			if (p.node) this.editNode(p.node.id);
			else if (p.nx >= 0 && p.nx <= 1 && p.ny >= 0 && p.ny <= 1) this.addNode(p.nx, p.ny);
		};

		c.onContext = (p, ev) => {
			if (this.mode !== "edit" || !this.map) return;
			if (this.pen) { this.finishPen(); return; }
			const menu = new Menu();
			if (p.node) {
				const id = p.node.id;
				menu.addItem((i) => i.setTitle("Edit node").setIcon("pencil").onClick(() => this.editNode(id)));
				if (this.findNode(id)?.link) menu.addItem((i) => i.setTitle("Open linked note").setIcon("file-text").onClick(() => this.openNote(id, false)));
				menu.addItem((i) => i.setTitle("Duplicate").setIcon("copy").onClick(() => this.duplicateNode(id)));
				menu.addSeparator();
				menu.addItem((i) => i.setTitle("Delete").setIcon("trash").onClick(() => this.deleteNode(id)));
			} else {
				const inside = p.nx >= 0 && p.nx <= 1 && p.ny >= 0 && p.ny <= 1;
				if (inside) menu.addItem((i) => i.setTitle("Add node here").setIcon("map-pin").onClick(() => this.addNode(p.nx, p.ny)));
				const dr = this.drawingAt(p.ux, p.uy);
				if (dr) menu.addItem((i) => i.setTitle("Delete line").setIcon("trash").onClick(() => this.deleteDrawing(dr.id)));
				if (!inside && !dr) return;
			}
			menu.showAtMouseEvent(ev);
		};
	}

	private onKeyDown = (e: KeyboardEvent) => {
		const t = e.target as HTMLElement;
		if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
		const edit = this.mode === "edit";
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && edit) { e.preventDefault(); this.undo(); return; }
		if (e.key === " " && this.canvas) { this.canvas.spaceHeld = true; e.preventDefault(); }
		else if (e.key === "Enter" && this.pen) { e.preventDefault(); this.finishPen(); }
		else if (e.key === "Escape") {
			if (this.canvas?.rulerActive) { if (this.canvas.hasRuler) this.canvas.clearRuler(); else this.setRuler(false); return; }
			if (this.pen) { this.pen = null; this.canvas?.requestDraw(); } else { this.selectedId = null; this.selDrawing = null; this.syncUI(); this.refresh(); }
		}
		else if ((e.key === "Delete" || e.key === "Backspace") && edit) {
			e.preventDefault();
			if (this.pen) { this.pen.anchors.pop(); if (!this.pen.anchors.length) this.pen = null; this.canvas?.requestDraw(); }
			else if (this.selectedId) this.deleteNode(this.selectedId);
			else if (this.selDrawing) this.deleteDrawing(this.selDrawing);
		}
		else if ((e.key === "[" || e.key === "]") && (FOG_TOOLS.includes(this.tool) || this.tool === "erase")) {
			const k = e.key === "]" ? 1.15 : 1 / 1.15;
			if (this.tool === "erase") this.eraserSize = Math.min(0.08, Math.max(0.004, this.eraserSize * k));
			else this.brushSize = Math.min(0.15, Math.max(0.005, this.brushSize * k));
			const grp = this.el.groups[this.tool === "erase" ? "eraser" : "brush"].querySelector<HTMLInputElement>("input[type=range]");
			if (grp) grp.value = String(this.tool === "erase" ? this.eraserSize : this.brushSize);
			this.refresh();
		}
	};
	private onKeyUp = (e: KeyboardEvent) => { if (e.key === " " && this.canvas) this.canvas.spaceHeld = false; };

	/* ------------------------------ drawings ----------------------------- */

	private pushUndo() {
		if (!this.map) return;
		this.drawUndo.push(JSON.stringify(this.map.drawings));
		if (this.drawUndo.length > 40) this.drawUndo.shift();
	}

	private undo() {
		if (FOG_TOOLS.includes(this.tool)) return this.undoStroke();
		const snap = this.drawUndo.pop();
		if (!snap || !this.map) return void new Notice("Nothing to undo.");
		this.map.drawings = JSON.parse(snap);
		this.selDrawing = null;
		this.pen = null;
		this.syncUI();
		this.changed();
	}

	private drawingAt(ux: number, uy: number): Drawing | null {
		const c = this.canvas, m = this.map;
		if (!c || !m) return null;
		const r = 6 / c.unitScale;
		for (let i = m.drawings.length - 1; i >= 0; i--) if (c.hitDrawing(m.drawings[i], ux, uy, r)) return m.drawings[i];
		return null;
	}

	private deleteDrawing(id: string) {
		if (!this.map) return;
		this.pushUndo();
		this.map.drawings = this.map.drawings.filter((d) => d.id !== id);
		if (this.selDrawing === id) this.selDrawing = null;
		this.syncUI();
		this.changed();
	}

	private addDrawing(d: Drawing) {
		this.pushUndo();
		this.map!.drawings.push(d);
		this.changed();
	}

	/* freehand */
	private extendFree(p: PointerInfo) {
		const f = this.free;
		if (!f || !this.canvas) return;
		if (Math.hypot(p.ux - f[f.length - 2], p.uy - f[f.length - 1]) < 3 / this.canvas.unitScale) return;
		f.push(p.ux, p.uy);
		this.canvas.requestDraw();
	}

	private endFree() {
		const f = this.free;
		this.free = null;
		if (!f || f.length < 4) { this.canvas?.requestDraw(); return; }
		const pts = simplify(f, 0.00025);
		this.addDrawing({ id: uid(), kind: "free", style: { ...this.lineStyle }, pts, d: smoothD(pts) });
	}

	/* eraser: freehand lines are trimmed, pen lines are removed whole */
	private eraseAt(p: PointerInfo) {
		const m = this.map, c = this.canvas;
		if (!m || !c) return;
		const r = this.eraserSize;
		let touched = false;
		const out: Drawing[] = [];
		for (const d of m.drawings) {
			if (d.kind === "free" && d.pts) {
				const pieces = eraseFree(d.pts, p.ux, p.uy, r);
				if (!pieces) { out.push(d); continue; }
				if (!touched && !this.eraseSnap) { this.pushUndo(); this.eraseSnap = true; }
				touched = true;
				for (const pc of pieces) out.push({ ...d, id: uid(), pts: pc, d: smoothD(pc) });
			} else if (c.hitDrawing(d, p.ux, p.uy, r)) {
				if (!touched && !this.eraseSnap) { this.pushUndo(); this.eraseSnap = true; }
				touched = true;
			} else out.push(d);
		}
		if (touched) { m.drawings = out; c.drawings = out; c.requestDraw(); }
	}

	/* pen: click = corner, click-drag = curve handles */
	private penDown(p: PointerInfo) {
		const c = this.canvas!;
		if (!this.pen) this.pen = { anchors: [], dragging: false, hover: null };
		const a = this.pen.anchors;
		if (a.length >= 2 && Math.hypot(p.ux - a[0].x, p.uy - a[0].y) * c.unitScale < 10) { this.finishPen(true); return; }
		a.push({ x: p.ux, y: p.uy, ix: p.ux, iy: p.uy, ox: p.ux, oy: p.uy });
		this.pen.dragging = true;
		c.requestDraw();
	}

	private penDrag(p: PointerInfo) {
		const pen = this.pen, c = this.canvas;
		if (!pen || !c) return;
		const a = pen.anchors[pen.anchors.length - 1];
		if (Math.hypot(p.ux - a.x, p.uy - a.y) * c.unitScale < 4) return; // still a corner
		a.ox = p.ux; a.oy = p.uy;
		a.ix = 2 * a.x - p.ux; a.iy = 2 * a.y - p.uy;
		c.requestDraw();
	}

	private finishPen(close = false) {
		const pen = this.pen;
		if (!pen) return;
		this.pen = null;
		const a = pen.anchors;
		if (a.length >= 2 && this.map) {
			const closed = close && a.length > 2;
			this.addDrawing({ id: uid(), kind: "pen", style: { ...this.lineStyle }, anchors: a, closed, d: penD(a, closed) });
		} else this.canvas?.requestDraw();
	}

	/** Live previews: the freehand stroke, and the pen path with anchors and handles. */
	private drawToolOverlay = (ctx: CanvasRenderingContext2D, t: { tx: number; ty: number; s: number }) => {
		ctx.translate(t.tx, t.ty);
		ctx.scale(t.s, t.s);
		const px = 1 / t.s;
		if (this.free && this.free.length >= 4) {
			applyLineStyle(ctx, this.lineStyle, px);
			ctx.stroke(new Path2D(smoothD(this.free)));
		}
		const pen = this.pen;
		if (!pen || !pen.anchors.length) return;
		const a = pen.anchors;
		applyLineStyle(ctx, this.lineStyle, px);
		if (a.length > 1) ctx.stroke(new Path2D(penD(a, false)));
		if (pen.hover && !pen.dragging) {
			const l = a[a.length - 1];
			ctx.save();
			ctx.globalAlpha = 0.5;
			ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.bezierCurveTo(l.ox, l.oy, pen.hover[0], pen.hover[1], pen.hover[0], pen.hover[1]); ctx.stroke();
			ctx.restore();
		}
		ctx.setLineDash([]);
		ctx.lineWidth = 1.3 * px;
		a.forEach((n, i) => {
			ctx.strokeStyle = "#4da3ff"; ctx.fillStyle = "#4da3ff";
			for (const [hx, hy] of [[n.ix, n.iy], [n.ox, n.oy]]) {
				if (Math.hypot(hx - n.x, hy - n.y) < 1e-9) continue;
				ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(hx, hy); ctx.stroke();
				ctx.beginPath(); ctx.arc(hx, hy, 3 * px, 0, Math.PI * 2); ctx.fill();
			}
			ctx.fillStyle = i === 0 && a.length >= 2 ? "#4da3ff" : "#fff";
			ctx.beginPath(); ctx.rect(n.x - 4 * px, n.y - 4 * px, 8 * px, 8 * px); ctx.fill(); ctx.stroke();
		});
	};

	/* ------------------------------ nodes -------------------------------- */

	private newNodeStyle() {
		const { visibility: _v, ...style } = this.plugin.settings.nodeDefaults;
		return { ...style };
	}

	private addNode(nx: number, ny: number) {
		const node: PCNode = { id: uid(), x: round4(nx), y: round4(ny), title: "", style: this.newNodeStyle(), visibility: this.plugin.settings.nodeDefaults.visibility };
		new NodeModal(this.app, this.plugin, node, this.file?.path ?? "", true, (n) => {
			this.map!.nodes.push(n); this.selectedId = n.id; this.changed();
		}).open();
	}

	private editNode(id: string) {
		const node = this.findNode(id);
		if (!node) return;
		new NodeModal(this.app, this.plugin, node, this.file?.path ?? "", false, (n) => {
			Object.assign(node, n); this.changed();
		}, () => this.deleteNode(id)).open();
	}

	private duplicateNode(id: string) {
		const n = this.findNode(id);
		if (!n) return;
		const copy: PCNode = JSON.parse(JSON.stringify(n));
		copy.id = uid(); copy.x = clamp01(n.x + 0.012); copy.y = clamp01(n.y + 0.012);
		this.map!.nodes.push(copy); this.selectedId = copy.id; this.changed();
	}

	private deleteNode(id: string) {
		if (!this.map) return;
		this.map.nodes = this.map.nodes.filter((n) => n.id !== id);
		if (this.selectedId === id) this.selectedId = null;
		this.changed();
	}

	private openNote(id: string, newTab: boolean) {
		const link = this.findNode(id)?.link?.trim();
		if (!link) { new Notice("This node has no linked note. Double-click it in Edit mode to add one."); return; }
		const target = link.replace(/^\[\[|\]\]$/g, "").split("|")[0];
		const where = newTab ? "tab" : this.plugin.settings.openIn;
		void this.app.workspace.openLinkText(target, this.file?.path ?? "", where === "current" ? false : where);
	}

	/* ------------------------------ fog ---------------------------------- */

	private beginStroke(p: PointerInfo) {
		if (!this.mask || !this.map?.fog.enabled) return;
		this.stroke = { m: this.tool === "reveal" ? 0 : 1, r: round4(this.brushSize), h: Math.round((1 - this.brushSoft * 0.95) * 100) / 100, p: [round4(p.nx), round4(p.ny)] };
		this.lastPt = [p.nx, p.ny];
		this.mask.stamp(this.stroke, p.nx, p.ny);
		this.canvas?.requestDraw();
	}

	private extendStroke(p: PointerInfo) {
		const s = this.stroke, mask = this.mask;
		if (!s || !mask) return;
		const dx = p.nx - this.lastPt[0], dy = (p.ny - this.lastPt[1]) * mask.aspect;
		if (Math.hypot(dx, dy) < s.r * 0.15) return;
		mask.segment(s, this.lastPt[0], this.lastPt[1], p.nx, p.ny);
		s.p.push(round4(p.nx), round4(p.ny));
		this.lastPt = [p.nx, p.ny];
		this.canvas?.requestDraw();
	}

	private endStroke() {
		if (this.stroke && this.map) { this.map.fog.strokes.push(this.stroke); }
		this.stroke = null;
		this.changed();
	}

	private undoStroke() {
		const m = this.map;
		if (!m || !this.mask || !m.fog.strokes.length) return void new Notice("Nothing to undo.");
		m.fog.strokes.pop();
		this.mask.reset(m.fog);
		this.changed();
	}

	private confirmFog(base: "fogged" | "clear") {
		const m = this.map;
		if (!m) return;
		new ConfirmModal(this.app, base === "fogged" ? "Cover the whole map in fog? This discards everything you've revealed." : "Clear all fog? Players will see the whole map.", base === "fogged" ? "Fog everything" : "Clear fog", () => {
			m.fog.base = base; m.fog.strokes = [];
			this.mask?.reset(m.fog);
			this.changed();
		}).open();
	}

	/* ------------------------------ ruler & scale ------------------------ */

	private calibrating = false;

	private setRuler(on: boolean) {
		if (on) this.finishPen();
		if (!on) this.calibrating = false;
		this.canvas?.setRulerActive(on);
		this.syncUI();
	}

	private startCalibrate() {
		this.calibrating = true;
		this.setRuler(true);
		this.calibrating = true;
		new Notice("Drag a line between two points on the map whose real distance you know.", 8000);
	}

	private onRulerDone(len: number) {
		if (!this.calibrating || !this.map) return;
		this.calibrating = false;
		const sc = this.map.settings.scale;
		new CalibrateModal(this.app, sc.unit, (dist) => { sc.mapWidth = Math.round((dist / len) * 100) / 100; this.setRuler(false); this.changed(); new Notice(`Scale set: the map is ${sc.mapWidth} ${unitShort(sc.unit)} wide.`); }, () => this.setRuler(false)).open();
	}

	/* ------------------------------ settings ----------------------------- */

	private openMapSettings() {
		if (!this.map) return;
		new MapSettingsModal(this.app, this.plugin, this.map, (reload) => { this.syncUI(); this.setDisplayName(); this.changed({ image: reload }); }, () => this.startCalibrate()).open();
	}
	private setDisplayName() { /* tab title follows the file name; map name is shown to players */ }

	/* ------------------------------ publishing --------------------------- */

	linkForPlayers(): string | null {
		const bad = this.plugin.github.configured();
		if (bad || !this.map) { new Notice(bad ?? "No map loaded."); return null; }
		return playerUrl(this.plugin.settings.github, this.map.id, this.plugin.settings.instantUpdates);
	}

	copyLink() {
		const url = this.linkForPlayers();
		if (url) navigator.clipboard.writeText(url).then(() => new Notice("Player link copied."));
	}

	toggleLive() {
		const bad = this.plugin.github.configured();
		if (bad) return void new Notice(bad);
		this.live = !this.live;
		this.syncUI();
		if (this.live) { new Notice("Live updates on. Publishing now…"); this.startHost(); void this.queue.run(); }
		else { this.queue.cancel(); this.stopHost(); this.setStatus("Live updates off", false); }
	}

	/* Direct connections to players: instant updates, with GitHub as the fallback. */
	private startHost() {
		const m = this.map;
		if (!m || this.host || !this.plugin.settings.instantUpdates || typeof RTCPeerConnection === "undefined") return;
		this.host = new LiveHost({
			topic: topicFor(m.id),
			getState: () => this.liveState(),
			post: async (url, body) => { await requestUrl({ url, method: "POST", body, contentType: "text/plain", throw: false }); },
			onPeers: (n) => this.setPeers(n),
		});
		this.host.start();
	}

	private stopHost() {
		this.host?.stop();
		this.host = null;
		this.setPeers(0);
	}

	private setPeers(n: number) {
		const el = this.el?.peers;
		if (!el) return;
		el.toggleClass("pc-hidden", !this.host);
		el.setText(`⚡ ${n}`);
		el.setAttr("aria-label", `${n} player${n === 1 ? "" : "s"} connected directly (instant updates)`);
	}

	private liveState(): string | null {
		const m = this.map;
		const rec = m && this.plugin.settings.published[m.id];
		if (!m || !rec || !this.source || !this.mask) return null;
		return JSON.stringify(this.buildState(rec.imageFile));
	}

	async publishNow() { if (await this.queue.run()) new Notice("Player site updated."); }

	private buildState(file: string): PublishedState {
		const m = this.map!, im = this.source!;
		const visible = m.nodes.filter((n) => this.playerVisible(n));
		const used = new Set(visible.map((n) => n.style.icon));
		const customIcons: Record<string, { src: string; raw: boolean }> = {};
		for (const c of this.plugin.settings.customIcons) if (used.has(c.id)) customIcons[c.id] = { src: c.src, raw: c.raw };
		return {
			v: 1,
			rev: Date.now(),
			name: m.name,
			image: { file, w: im.w, h: im.h },
			nodes: visible.map((n) => ({ id: n.id, x: n.x, y: n.y, title: n.title, style: n.style })),
			drawings: m.drawings.map((d) => ({ id: d.id, style: d.style, d: d.d })),
			customIcons,
			fogMask: m.fog.enabled && this.mask ? this.mask.toDataURL(512) : null,
			settings: { labelMode: m.settings.labelMode, labelSize: m.settings.labelSize, pinSize: m.settings.pinSize, nodeScaling: m.settings.nodeScaling, fogLook: m.settings.fogLook, scale: m.settings.scale },
		};
	}

	private async publishJob() {
		const bad = this.plugin.github.configured();
		if (bad) throw new Error(bad);
		const m = this.map, im = this.source, imgFile = this.resolveImage();
		if (!m || !im || !imgFile) throw new Error("Map isn't loaded yet.");
		this.setStatus("Waiting for map tiles…", false);
		const gh = this.plugin.settings.github;
		await this.plugin.github.ensureBranch();

		const key = `${imgFile.path}|${imgFile.stat.mtime}|${imgFile.stat.size}|${gh.publishSide}`;
		let rec = this.plugin.settings.published[m.id];
		if (!rec || rec.imageKey !== key) {
			this.setStatus("Uploading map image…", false);
			const blob = await im.renderScaled(gh.publishSide);
			const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg";
			let h = 0; for (const ch of key) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
			const file = `map-${(h >>> 0).toString(36)}.${ext}`;
			await this.plugin.github.put(`maps/${m.id}/${file}`, toBase64(await blob.arrayBuffer()), "Upload map image");
			rec = { imageKey: key, imageFile: file };
			this.plugin.settings.published[m.id] = rec;
			await this.plugin.saveSettings();
		}
		await this.plugin.github.put(`maps/${m.id}/state.json`, textToBase64(JSON.stringify(this.buildState(rec.imageFile))), "Update map state");
		this.host?.broadcastSoon(0); // first publish: players already connected get the map now
	}
}
