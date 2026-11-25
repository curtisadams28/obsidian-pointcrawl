import { AbstractInputSuggest, App, FuzzySuggestModal, Menu, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type PointCrawlPlugin from "./main";
import { ICON_DATA } from "./icon-data";
import { ICON_INDEX } from "./shared/icon-index";
import { drawGlyph } from "./shared/mapcanvas";
import { UNITS, isPresetUnit, unitName } from "./shared/scale";
import { FONTS, textRenderer } from "./shared/text";
import { MapFile, MapScale, NodeStyle, PCNode, TextObj, Visibility } from "./shared/types";

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

/* ---------------------------- small helpers --------------------------- */

export class ConfirmModal extends Modal {
	constructor(app: App, private text: string, private yesLabel: string, private onYes: () => void) { super(app); }
	onOpen() {
		this.contentEl.createEl("p", { text: this.text });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.yesLabel).setWarning().onClick(() => { this.close(); this.onYes(); }));
	}
	onClose() { this.contentEl.empty(); }
}

export class ImagePickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onPick: (f: TFile) => void) {
		super(app);
		this.setPlaceholder("Choose an image from your vault…");
	}
	getItems() { return this.app.vault.getFiles().filter((f) => IMAGE_EXTS.includes(f.extension.toLowerCase()) || f.extension.toLowerCase() === "svg"); }
	getItemText(f: TFile) { return f.path; }
	onChooseItem(f: TFile) { this.onPick(f); }
}

class NoteSuggest extends AbstractInputSuggest<TFile> {
	constructor(app: App, private input: HTMLInputElement, private source: string) { super(app, input); }
	getSuggestions(q: string) {
		const s = q.toLowerCase();
		return this.app.vault.getMarkdownFiles().filter((f) => f.path.toLowerCase().includes(s)).slice(0, 40);
	}
	renderSuggestion(f: TFile, el: HTMLElement) { el.setText(f.path.replace(/\.md$/, "")); }
	selectSuggestion(f: TFile) {
		this.input.value = this.app.metadataCache.fileToLinktext(f, this.source);
		this.input.dispatchEvent(new Event("input"));
		this.close();
	}
}

/* ------------------------------ new map ------------------------------- */

export class NewMapModal extends Modal {
	private name = "";
	private image: TFile | null;
	constructor(app: App, private plugin: PointCrawlPlugin, image?: TFile, private folder?: TFolder) {
		super(app);
		this.image = image ?? null;
		this.name = image ? image.basename : "";
	}
	onOpen() {
		const el = this.contentEl;
		el.createEl("h3", { text: "New point crawl map" });
		if (this.folder) el.createEl("p", { cls: "setting-item-description", text: `Will be created in ${this.folder.path === "/" ? "the vault root" : this.folder.path}.` });
		let imgLabel!: HTMLElement;
		new Setting(el).setName("Name").addText((t) => { t.setValue(this.name).setPlaceholder("Region map").onChange((v) => (this.name = v)); window.setTimeout(() => t.inputEl.focus(), 30); });
		new Setting(el).setName("Map image").setDesc("Any image in your vault. Large images are fine.")
			.addButton((b) => b.setButtonText("Choose…").onClick(() => new ImagePickerModal(this.app, (f) => { this.image = f; if (!this.name) this.name = f.basename; imgLabel.setText(f.path); }).open()))
			.then((s) => { imgLabel = s.descEl.createDiv({ cls: "pc-picked", text: this.image?.path ?? "No image chosen" }); });
		new Setting(el)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Create").setCta().onClick(async () => {
				if (!this.image) return void new Notice("Choose a map image first.");
				const name = this.name.trim() || this.image.basename;
				this.close();
				await this.plugin.createMap(name, this.image, this.folder);
			}));
	}
	onClose() { this.contentEl.empty(); }
}

/* --------------------------- custom icon import ----------------------- */

/** Scale an image into a 128px square PNG. Single-colour icons become alpha masks so they can be tinted. */
export async function importIconImage(blob: Blob, tintable: boolean): Promise<string> {
	const url = URL.createObjectURL(blob);
	try {
		const img = new Image();
		img.src = url;
		await img.decode();
		const nw = img.naturalWidth || 128, nh = img.naturalHeight || 128;
		const k = Math.min(128 / nw, 128 / nh);
		const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
		const c = document.createElement("canvas");
		c.width = c.height = 128;
		const g = c.getContext("2d", { willReadFrequently: true })!;
		g.imageSmoothingQuality = "high";
		g.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
		if (tintable) {
			const data = g.getImageData(0, 0, 128, 128), d = data.data;
			let opaque = true;
			for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { opaque = false; break; }
			for (let i = 0; i < d.length; i += 4) {
				// no transparency: treat dark artwork on a light background as the shape
				if (opaque) d[i + 3] = 255 - Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
				d[i] = d[i + 1] = d[i + 2] = 0;
			}
			g.putImageData(data, 0, 0);
		}
		return c.toDataURL("image/png");
	} finally { URL.revokeObjectURL(url); }
}

/* ----------------------------- style editor --------------------------- */

export const toHex = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : "#000000");

/** A colour input with your palette beside it. (Palette colours are added and removed in the plugin settings.) */
export function colorField(parent: HTMLElement, pl: PointCrawlPlugin, value: string, onChange: (c: string) => void) {
	const wrap = parent.createDiv({ cls: "pc-colorfield" });
	const input = wrap.createEl("input", { type: "color" });
	input.value = toHex(value);
	const sw = wrap.createDiv({ cls: "pc-swatches pc-wrap" });
	const set = (c: string) => { input.value = toHex(c); onChange(input.value); };
	input.addEventListener("input", () => onChange(input.value));
	for (const c of pl.settings.palette) {
		const b = sw.createEl("button", { cls: "pc-swatch", attr: { "aria-label": c } });
		b.style.background = c;
		b.addEventListener("click", () => set(c));
	}
	return { set: (c: string) => { input.value = toHex(c); } };
}

/** A settings row with a colour picker and your palette beside it. */
export function colorSetting(el: HTMLElement, pl: PointCrawlPlugin, name: string, value: string, onChange: (c: string) => void, desc?: string): Setting {
	const s = new Setting(el).setName(name);
	if (desc) s.setDesc(desc);
	const sw = s.controlEl.createDiv({ cls: "pc-swatches pc-wrap pc-setting-swatches" });
	let comp: { setValue(v: string): unknown } | null = null;
	s.addColorPicker((c) => { comp = c; c.setValue(toHex(value)); c.onChange(onChange); });
	for (const c of pl.settings.palette) {
		const b = sw.createEl("button", { cls: "pc-swatch", attr: { "aria-label": c } });
		b.style.background = c;
		b.addEventListener("click", () => { comp?.setValue(c); onChange(c); });
	}
	return s;
}

/** Small popover listing your palette (used from the toolbar). */
export function openPalette(anchor: HTMLElement, pl: PointCrawlPlugin, current: () => string, onPick: (c: string) => void) {
	document.querySelectorAll(".pc-popover").forEach((e) => e.remove());
	const pop = document.body.createDiv({ cls: "pc-popover" });
	const r = anchor.getBoundingClientRect();
	pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 270)) + "px";
	pop.style.top = r.bottom + 6 + "px";
	pop.createDiv({ cls: "pc-pop-title", text: "Palette" });
	const row = pop.createDiv({ cls: "pc-swatches pc-wrap" });
	const cur = current().toLowerCase();
	for (const c of pl.settings.palette) {
		const b = row.createEl("button", { cls: "pc-swatch", attr: { "aria-label": c } });
		b.style.background = c;
		if (c.toLowerCase() === cur) b.addClass("is-current");
		b.addEventListener("click", () => { onPick(c); pop.remove(); });
	}
	pop.createDiv({ cls: "pc-val", text: "Edit your palette in Settings → General." });
	const close = (e: Event) => { if (!pop.contains(e.target as Node)) { pop.remove(); document.removeEventListener("pointerdown", close, true); } };
	window.setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
}

export interface StyleEditorOpts {
	plugin: PointCrawlPlugin;
	style: NodeStyle;
	visibility?: { get(): Visibility; set(v: Visibility): void };
	onChange?: () => void;
}

/** Preview + compact controls + a flat, searchable icon list. Shared by the node dialog and the defaults page. */
export function renderStyleEditor(parent: HTMLElement, o: StyleEditorOpts): () => void {
	const st = o.style, pl = o.plugin;
	const root = parent.createDiv({ cls: "pc-se" });
	const top = root.createDiv({ cls: "pc-se-top" });
	const prev = top.createEl("canvas", { cls: "pc-preview" });
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	prev.width = 150 * dpr; prev.height = 120 * dpr; prev.style.width = "150px"; prev.style.height = "120px";
	const ctl = top.createDiv({ cls: "pc-se-controls" });
	const row = (label: string) => {
		const r = ctl.createDiv({ cls: "pc-row" });
		r.createSpan({ cls: "pc-row-label", text: label });
		return r.createDiv({ cls: "pc-row-ctl" });
	};

	const draw = () => {
		const g = prev.getContext("2d")!;
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, 150, 120);
		const icon = st.shape === "icon" && st.icon;
		drawGlyph(g, pl.icons, st, 75, icon ? 60 : 100, pl.pinBase() * st.size * 1.6, dpr);
	};
	const unsub = pl.icons.addListener(draw);

	// style segmented control
	const seg = row("Style").createDiv({ cls: "pc-seg" });
	const segBtns: Record<string, HTMLElement> = {};
	for (const [v, label] of [["pin", "Pin"], ["icon", "Icon only"]] as const) {
		const b = seg.createEl("button", { text: label });
		b.addEventListener("click", () => { st.shape = v; changed(); });
		segBtns[v] = b;
	}

	// colour
	colorField(row("Colour"), pl, st.color, (c) => { st.color = c; changed(); });

	// size
	const sizeCtl = row("Size");
	const size = sizeCtl.createEl("input", { type: "range", attr: { min: "0.5", max: "2.5", step: "0.05" } });
	size.value = String(st.size);
	const sizeVal = sizeCtl.createSpan({ cls: "pc-val", text: st.size.toFixed(2) + "×" });
	size.addEventListener("input", () => { st.size = +size.value; sizeVal.setText(st.size.toFixed(2) + "×"); changed(); });

	// icon colour (pins) / outline (icon only)
	const icRow = row("Icon colour");
	colorField(icRow, pl, st.iconColor, (c) => { st.iconColor = c; changed(); });
	const bgRow = row("Inner circle");
	const bgBox = bgRow.createEl("input", { type: "checkbox" });
	bgBox.checked = st.iconBg !== false;
	bgBox.addEventListener("change", () => { st.iconBg = bgBox.checked; changed(); });
	bgRow.createSpan({ cls: "pc-val", text: "White circle in the pin head (behind the icon)" });
	const haloRow = row("Outline");
	const halo = haloRow.createEl("input", { type: "checkbox" });
	halo.checked = st.halo;
	halo.addEventListener("change", () => { st.halo = halo.checked; changed(); });
	haloRow.createSpan({ cls: "pc-val", text: "Light/dark halo so icons stay readable" });

	if (o.visibility) {
		const vis = row("Players see it").createEl("select", { cls: "dropdown" });
		for (const [v, l] of [["auto", "Once its spot is revealed"], ["always", "Always"], ["gm", "Never (GM only)"]]) vis.createEl("option", { value: v, text: l });
		vis.value = o.visibility.get();
		vis.addEventListener("change", () => o.visibility!.set(vis.value as Visibility));
	}

	// flat icon list + search
	const picker = root.createDiv({ cls: "pc-icon-picker" });
	const search = picker.createEl("input", { type: "search", placeholder: "Search icons…", cls: "pc-icon-search" });
	const grid = picker.createDiv({ cls: "pc-icon-grid" });
	const cells = new Map<string, HTMLElement>();
	const items = [{ id: "", label: "No icon", src: "" }, ...pl.allIcons()];
	for (const it of items) {
		const c = grid.createEl("button", { cls: "pc-icon-cell", attr: { "aria-label": it.label, "data-q": (it.label + " " + it.id).toLowerCase() } });
		if (it.id) { const im = c.createEl("img", { attr: { src: it.src, alt: it.label } }); if (pl.isRawIcon(it.id)) im.addClass("is-raw"); } else c.setText("None");
		c.addEventListener("click", () => { st.icon = it.id || undefined; if (!st.icon && st.shape === "icon") st.shape = "pin"; changed(); });
		cells.set(it.id, c);
	}
	search.addEventListener("input", () => {
		const q = search.value.trim().toLowerCase();
		grid.querySelectorAll<HTMLElement>(".pc-icon-cell").forEach((c) => c.toggleClass("pc-hidden", !!q && !(c.dataset.q ?? "").includes(q)));
	});

	const changed = () => {
		segBtns.pin.toggleClass("is-active", st.shape === "pin");
		segBtns.icon.toggleClass("is-active", st.shape === "icon");
		icRow.parentElement!.toggleClass("pc-hidden", !(st.shape === "pin" && !!st.icon));
		bgRow.parentElement!.toggleClass("pc-hidden", st.shape !== "pin");
		haloRow.parentElement!.toggleClass("pc-hidden", !(st.shape === "icon" && !!st.icon));
		cells.forEach((c, id) => c.toggleClass("is-selected", id === (st.icon ?? "")));
		draw();
		o.onChange?.();
	};
	changed();
	return unsub;
}

/* ------------------------------- node -------------------------------- */

export class NodeModal extends Modal {
	private draft: PCNode;
	private cleanup: (() => void) | null = null;
	constructor(app: App, private plugin: PointCrawlPlugin, node: PCNode, private sourcePath: string, private isNew: boolean,
		private onSave: (n: PCNode) => void, private onDelete?: () => void) {
		super(app);
		this.draft = JSON.parse(JSON.stringify(node));
	}

	private save = () => {
		const st = this.draft.style;
		if (st.shape === "icon" && !st.icon) return void new Notice("Pick an icon, or switch the style to Pin.");
		this.close();
		this.onSave(this.draft);
	};

	onOpen() {
		const el = this.contentEl, d = this.draft;
		this.modalEl.addClass("pc-node-modal");

		// Actions live in the header so they're always visible, however tall the dialog gets.
		const head = el.createDiv({ cls: "pc-modal-head" });
		head.createEl("h3", { text: this.isNew ? "Add node" : "Edit node" });
		const actions = head.createDiv({ cls: "pc-modal-actions" });
		if (!this.isNew && this.onDelete) actions.createEl("button", { text: "Delete", cls: "mod-warning" }).addEventListener("click", () => { this.close(); this.onDelete!(); });
		actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		actions.createEl("button", { text: this.isNew ? "Add" : "Save", cls: "mod-cta" }).addEventListener("click", this.save);

		const fields = el.createDiv({ cls: "pc-fields" });
		const title = fields.createEl("input", { type: "text", placeholder: "Heading (shown on hover)", cls: "pc-field" });
		title.value = d.title;
		title.addEventListener("input", () => (d.title = title.value));
		const link = fields.createEl("input", { type: "text", placeholder: "Linked note (search…)", cls: "pc-field" });
		link.value = d.link ?? "";
		link.addEventListener("input", () => (d.link = link.value.trim() || undefined));
		new NoteSuggest(this.app, link, this.sourcePath);
		for (const i of [title, link]) i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.save(); } });
		window.setTimeout(() => title.focus(), 30);

		this.cleanup = renderStyleEditor(el, { plugin: this.plugin, style: d.style, visibility: { get: () => d.visibility, set: (v) => (d.visibility = v) } });
		this.scope.register(["Mod"], "Enter", () => { this.save(); return false; });
	}

	onClose() { this.cleanup?.(); this.contentEl.empty(); }
}

/* ------------------------------ map scale ----------------------------- */

/** Unit + map width controls, shared by the map settings dialog and the plugin defaults. */
export function renderScaleControls(el: HTMLElement, sc: MapScale, onChange: () => void, extra?: (s: Setting) => void) {
	new Setting(el).setName("Show scale bar").setDesc("A distance bar in the corner that updates as you zoom. Players see it too.")
		.addToggle((t) => t.setValue(sc.show).onChange((v) => { sc.show = v; onChange(); }));
	let customRow!: Setting;
	let customText = isPresetUnit(sc.unit) ? "" : sc.unit;
	new Setting(el).setName("Unit").addDropdown((d) => {
		for (const u of UNITS) d.addOption(u.id, u.label);
		d.addOption("custom", "Custom…");
		d.setValue(isPresetUnit(sc.unit) ? sc.unit : "custom");
		d.onChange((v) => {
			sc.unit = v === "custom" ? customText || "units" : v;
			customRow.settingEl.toggleClass("pc-hidden", v !== "custom");
			onChange();
		});
	});
	customRow = new Setting(el).setName("Custom unit name").setDesc("For example “days of travel” or “hexes”.")
		.addText((t) => t.setPlaceholder("days of travel").setValue(customText).onChange((v) => { customText = v.trim(); sc.unit = customText || "units"; onChange(); }));
	customRow.settingEl.toggleClass("pc-hidden", isPresetUnit(sc.unit));
	const width = new Setting(el).setName("Map width").setDesc("How far the full width of the image is. Images come in all scales, so set this for each map, or use Calibrate with a distance you know.")
		.addText((t) => { t.inputEl.type = "number"; t.inputEl.min = "0"; t.setValue(String(sc.mapWidth)).onChange((v) => { const n = parseFloat(v); if (n > 0) { sc.mapWidth = n; onChange(); } }); });
	extra?.(width);
}

export class CalibrateModal extends Modal {
	private done = false;
	constructor(app: App, private unit: string, private onApply: (distance: number) => void, private onCancel: () => void) { super(app); }
	onOpen() {
		const el = this.contentEl;
		el.createEl("h3", { text: "Set the scale" });
		el.createEl("p", { text: `How far apart are the two points you measured, in ${unitName(this.unit)}?` });
		const input = el.createEl("input", { type: "number", attr: { min: "0", step: "any", placeholder: "e.g. 24" } });
		input.addClass("pc-field");
		const apply = () => {
			const n = parseFloat(input.value);
			if (!(n > 0)) return void new Notice("Enter a distance greater than zero.");
			this.done = true; this.close(); this.onApply(n);
		};
		input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } });
		window.setTimeout(() => input.focus(), 30);
		new Setting(el)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Set scale").setCta().onClick(apply));
	}
	onClose() { this.contentEl.empty(); if (!this.done) this.onCancel(); }
}

/* -------------------------------- text -------------------------------- */

export class TextModal extends Modal {
	private t: TextObj;
	constructor(app: App, private plugin: PointCrawlPlugin, t: TextObj, private isNew: boolean, private onSave: (t: TextObj) => void, private onDelete?: () => void) {
		super(app);
		this.t = JSON.parse(JSON.stringify(t));
	}

	private save = () => { if (!this.t.text.trim()) return void new Notice("Type some text first."); this.close(); this.onSave(this.t); };

	onOpen() {
		const el = this.contentEl, t = this.t;
		this.modalEl.addClass("pc-node-modal");
		const head = el.createDiv({ cls: "pc-modal-head" });
		head.createEl("h3", { text: this.isNew ? "Add text" : "Edit text" });
		const actions = head.createDiv({ cls: "pc-modal-actions" });
		if (!this.isNew && this.onDelete) actions.createEl("button", { text: "Delete", cls: "mod-warning" }).addEventListener("click", () => { this.close(); this.onDelete!(); });
		actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		actions.createEl("button", { text: this.isNew ? "Add" : "Save", cls: "mod-cta" }).addEventListener("click", this.save);

		const ta = el.createEl("textarea", { cls: "pc-field pc-textarea", attr: { rows: "2", placeholder: "Text (Enter for a new line)" } });
		ta.value = t.text;
		window.setTimeout(() => { ta.focus(); ta.select(); }, 30);
		const prev = el.createEl("canvas", { cls: "pc-preview pc-text-preview" });
		const dpr = Math.min(2, window.devicePixelRatio || 1), PW = 560, PH = 120;
		prev.width = PW * dpr; prev.height = PH * dpr; prev.style.width = "100%"; prev.style.maxWidth = PW + "px"; prev.style.height = PH + "px";
		const draw = () => {
			const g = prev.getContext("2d")!;
			g.setTransform(dpr, 0, 0, dpr, 0, 0);
			g.clearRect(0, 0, PW, PH);
			const b = textRenderer.layout(t).box;
			const pad = 0.5 + t.outW + t.outBlur + (t.shadow ? t.shBlur + 0.2 : 0);
			const em = Math.min((PW - 20) / (b.x1 - b.x0 + 2 * pad), (PH - 10) / (b.y1 - b.y0 + 2 * pad), 90);
			const sp = textRenderer.sprite(t, em * dpr);
			if (!sp) return;
			const f = em / sp.ppe;
			g.drawImage(sp.canvas, PW / 2 - sp.ax * f - ((b.x0 + b.x1) / 2) * em, PH / 2 - sp.ay * f - ((b.y0 + b.y1) / 2) * em, sp.canvas.width * f, sp.canvas.height * f);
		};
		const unsub = textRenderer.onChange(draw);
		this.cleanup = unsub;
		const upd = () => { draw(); refreshVis(); };
		ta.addEventListener("input", () => { t.text = ta.value; upd(); });
		ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.save(); } });

		const rows = el.createDiv({ cls: "pc-se-controls pc-text-rows" });
		const row = (label: string) => { const r = rows.createDiv({ cls: "pc-row" }); r.createSpan({ cls: "pc-row-label", text: label }); return { wrap: r, ctl: r.createDiv({ cls: "pc-row-ctl" }) }; };
		const slider = (c: HTMLElement, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
			const i = c.createEl("input", { type: "range", attr: { min: String(min), max: String(max), step: String(step) } });
			i.value = String(get());
			const val = c.createSpan({ cls: "pc-val", text: fmt(get()) });
			i.addEventListener("input", () => { set(+i.value); val.setText(fmt(+i.value)); upd(); });
		};
		const pct = (v: number) => (v * 100).toFixed(0) + "%";

		// font
		const fr = row("Font");
		const sel = fr.ctl.createEl("select", { cls: "dropdown" });
		for (const f of FONTS) sel.createEl("option", { value: f.css, text: f.label });
		sel.createEl("option", { value: "__custom", text: "Installed font…" });
		const known = FONTS.some((f) => f.css === t.font);
		sel.value = known ? t.font : "__custom";
		const custom = fr.ctl.createEl("input", { type: "text", placeholder: "Font name, e.g. Papyrus", cls: "pc-field-sm" });
		custom.value = known ? "" : t.font.replace(/^"([^"]+)".*$/, "$1");
		sel.addEventListener("change", () => { if (sel.value !== "__custom") t.font = sel.value; else if (custom.value.trim()) t.font = `"${custom.value.trim()}", sans-serif`; upd(); });
		custom.addEventListener("input", () => { if (custom.value.trim()) { t.font = `"${custom.value.trim()}", sans-serif`; sel.value = "__custom"; upd(); } });
		const style = row("Style").ctl;
		for (const [key, label] of [["bold", "B"], ["italic", "I"]] as const) {
			const b = style.createEl("button", { text: label, cls: "pc-toggle", attr: { "aria-label": key } });
			b.toggleClass("is-active", t[key]);
			if (key === "bold") b.style.fontWeight = "700"; else b.style.fontStyle = "italic";
			b.addEventListener("click", () => { t[key] = !t[key]; b.toggleClass("is-active", t[key]); upd(); });
		}
		colorField(row("Colour").ctl, this.plugin, t.color, (c) => { t.color = c; upd(); });
		slider(row("Size").ctl, 0.008, 0.2, 0.002, () => t.size, (v) => (t.size = v), (v) => pct(v / 0.03));
		slider(row("Arc").ctl, -360, 360, 5, () => t.arc, (v) => (t.arc = v), (v) => (v === 0 ? "Straight" : `${v}°`));

		// outline
		slider(row("Outline").ctl, 0, 0.3, 0.01, () => t.outW, (v) => (t.outW = v), (v) => (v === 0 ? "Off" : pct(v)));
		const o1 = row("Outline colour"); colorField(o1.ctl, this.plugin, t.outColor, (c) => { t.outColor = c; upd(); });
		const o2 = row("Outline blur"); slider(o2.ctl, 0, 0.5, 0.01, () => t.outBlur, (v) => (t.outBlur = v), (v) => (v === 0 ? "Sharp" : pct(v)));

		// shadow
		const sh = row("Drop shadow").ctl;
		const shOn = sh.createEl("input", { type: "checkbox" });
		shOn.checked = t.shadow;
		shOn.addEventListener("change", () => { t.shadow = shOn.checked; upd(); });
		const s1 = row("Shadow colour"); colorField(s1.ctl, this.plugin, t.shColor, (c) => { t.shColor = c; upd(); });
		const s2 = row("Shadow opacity"); slider(s2.ctl, 0.05, 1, 0.05, () => t.shOpacity, (v) => (t.shOpacity = v), pct);
		const s3 = row("Shadow blur"); slider(s3.ctl, 0, 0.6, 0.01, () => t.shBlur, (v) => (t.shBlur = v), pct);
		const s4 = row("Shadow X"); slider(s4.ctl, -0.4, 0.4, 0.01, () => t.shDx, (v) => (t.shDx = v), pct);
		const s5 = row("Shadow Y"); slider(s5.ctl, -0.4, 0.4, 0.01, () => t.shDy, (v) => (t.shDy = v), pct);
		const refreshVis = () => {
			for (const r of [o1, o2]) r.wrap.toggleClass("pc-hidden", t.outW === 0);
			for (const r of [s1, s2, s3, s4, s5]) r.wrap.toggleClass("pc-hidden", !t.shadow);
		};
		refreshVis();
		draw();
		this.scope.register(["Mod"], "Enter", () => { this.save(); return false; });
	}

	private cleanup: (() => void) | null = null;
	onClose() { this.cleanup?.(); this.contentEl.empty(); }
}

/* ---------------------------- map settings ---------------------------- */

export class MapSettingsModal extends Modal {
	constructor(app: App, private plugin: PointCrawlPlugin, private map: MapFile, private onChange: (reloadImage: boolean) => void, private onCalibrate: () => void) { super(app); }

	onOpen() {
		const el = this.contentEl, m = this.map, s = m.settings;
		el.createEl("h3", { text: "Map settings" });
		const apply = () => this.onChange(false);

		new Setting(el).setName("Name").setDesc("Shown to players.").addText((t) => t.setValue(m.name).onChange((v) => { m.name = v; apply(); }));
		new Setting(el).setName("Map image").setDesc(m.image)
			.addButton((b) => b.setButtonText("Change…").onClick(() => new ImagePickerModal(this.app, (f) => { m.image = f.path; this.onChange(true); this.close(); }).open()));

		new Setting(el).setName("Nodes").setHeading();
		new Setting(el).setName("Labels").addDropdown((d) => d.addOptions({ hover: "On hover", always: "Always" }).setValue(s.labelMode).onChange((v) => { s.labelMode = v as typeof s.labelMode; apply(); }));
		new Setting(el).setName("Label size")
			.addSlider((sl) => sl.setLimits(10, 24, 1).setValue(s.labelSize).setDynamicTooltip().onChange((v) => { s.labelSize = v; apply(); }));
		new Setting(el).setName("Base pin size (px)")
			.addSlider((sl) => sl.setLimits(16, 64, 1).setValue(s.pinSize).setDynamicTooltip().onChange((v) => { s.pinSize = v; apply(); }));
		new Setting(el).setName("Pins when zooming").addDropdown((d) => d.addOptions({ fixed: "Fixed size", scale: "Scale with map" }).setValue(s.nodeScaling).onChange((v) => { s.nodeScaling = v as typeof s.nodeScaling; apply(); }));

		new Setting(el).setName("Scale").setHeading();
		renderScaleControls(el, s.scale, apply, (w) => w.addButton((b) => b.setButtonText("Calibrate with ruler…").onClick(() => { this.close(); this.onCalibrate(); })));

		new Setting(el).setName("Fog of war").setHeading();
		new Setting(el).setName("Use fog").addToggle((t) => t.setValue(m.fog.enabled).onChange((v) => { m.fog.enabled = v; apply(); }));
		new Setting(el).setName("Hide nodes under fog from players").setDesc("Nodes set to Always or GM only ignore this.")
			.addToggle((t) => t.setValue(s.hideNodesInFog).onChange((v) => { s.hideNodesInFog = v; apply(); }));
		colorSetting(el, this.plugin, "Fog colour", s.fogLook.color, (v) => { s.fogLook.color = v; apply(); });
		new Setting(el).setName("Density for players").setDesc("1 fully hides the map under fog.")
			.addSlider((sl) => sl.setLimits(0.4, 1, 0.01).setValue(s.fogLook.density).setDynamicTooltip().onChange((v) => { s.fogLook.density = v; apply(); }));
		new Setting(el).setName("Animate fog").addToggle((t) => t.setValue(s.fogLook.animate).onChange((v) => { s.fogLook.animate = v; apply(); }));
		new Setting(el).setName("Drift speed")
			.addSlider((sl) => sl.setLimits(0.2, 3, 0.1).setValue(s.fogLook.speed).setDynamicTooltip().onChange((v) => { s.fogLook.speed = v; apply(); }));

		new Setting(el).addButton((b) => b.setButtonText("Done").setCta().onClick(() => this.close()));
	}
	onClose() { this.contentEl.empty(); }
}

export { ICON_DATA, ICON_INDEX };
