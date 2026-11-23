import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PointCrawlPlugin from "./main";
import { ImagePickerModal, importIconImage, renderStyleEditor } from "./modals";
import { applyLineStyle, smoothD } from "./shared/drawing";
import { DEFAULT_LINE, DEFAULT_MAP_SETTINGS, DashStyle, LineStyle, MapSettings, NodeStyle, Visibility, uid } from "./shared/types";

export interface NodeDefaults extends NodeStyle { visibility: Visibility }
export interface CustomIcon { id: string; label: string; src: string; raw: boolean }

export interface PCSettings {
	nodeDefaults: NodeDefaults;
	lineDefaults: LineStyle;
	eraserSize: number;
	instantUpdates: boolean;
	customIcons: CustomIcon[];
	openOnClick: boolean;
	openIn: "current" | "tab" | "split";
	tileBudget: number;
	fogResolution: number;
	animateInEditor: boolean;
	editorFogOpacity: number;
	brushSize: number;
	brushSoftness: number;
	mapDefaults: MapSettings;
	github: { token: string; repo: string; branch: string; pagesUrl: string; publishSide: number; debounceSec: number };
	/** Remembered uploads so the (large) map image is only pushed when it changes. */
	published: Record<string, { imageKey: string; imageFile: string }>;
}

export const DEFAULT_SETTINGS: PCSettings = {
	nodeDefaults: { shape: "pin", color: "#c0392b", iconColor: "#1b1b1b", size: 1, halo: true, visibility: "auto" },
	lineDefaults: { ...DEFAULT_LINE },
	eraserSize: 0.02,
	instantUpdates: true,
	customIcons: [],
	openOnClick: true,
	openIn: "current",
	tileBudget: 192,
	fogResolution: 1024,
	animateInEditor: false,
	editorFogOpacity: 0.55,
	brushSize: 0.04,
	brushSoftness: 0.5,
	mapDefaults: JSON.parse(JSON.stringify(DEFAULT_MAP_SETTINGS)),
	github: { token: "", repo: "", branch: "pointcrawl-data", pagesUrl: "", publishSide: 4096, debounceSec: 1 },
	published: {},
};

const TABS: [string, string][] = [
	["general", "General"], ["nodes", "Nodes"], ["drawing", "Drawing"], ["fog", "Fog"], ["icons", "Icons"], ["performance", "Performance"], ["player", "Player site"],
];

export class PCSettingTab extends PluginSettingTab {
	private active = "general";
	private cleanup: (() => void) | null = null;
	constructor(app: App, private plugin: PointCrawlPlugin) { super(app, plugin); }

	hide() { this.cleanup?.(); this.cleanup = null; }

	display() {
		const root = this.containerEl;
		root.empty();
		root.addClass("pc-settings");
		const nav = root.createDiv({ cls: "pc-tabs", attr: { role: "tablist" } });
		const body = root.createDiv({ cls: "pc-tab-body" });
		const render = () => {
			this.cleanup?.(); this.cleanup = null;
			body.empty();
			nav.querySelectorAll("button").forEach((b) => b.toggleClass("is-active", b.dataset.tab === this.active));
			(this as any)["tab_" + this.active](body);
		};
		for (const [id, label] of TABS) {
			const b = nav.createEl("button", { text: label, cls: "pc-tab", attr: { "data-tab": id, role: "tab" } });
			b.addEventListener("click", () => { this.active = id; render(); });
		}
		render();
	}

	private get s() { return this.plugin.settings; }
	private save = () => void this.plugin.saveSettings();

	/* ----------------------------- General ----------------------------- */

	private tab_general(el: HTMLElement) {
		const s = this.s, md = s.mapDefaults;
		new Setting(el).setName("Linked notes").setHeading();
		new Setting(el).setName("Click a pin to open its note").setDesc("In View mode. In Edit mode, Ctrl/Cmd-click opens the note.")
			.addToggle((t) => t.setValue(s.openOnClick).onChange((v) => { s.openOnClick = v; this.save(); }));
		new Setting(el).setName("Open notes in")
			.addDropdown((d) => d.addOptions({ current: "Same tab", tab: "New tab", split: "Split pane" }).setValue(s.openIn).onChange((v) => { s.openIn = v as PCSettings["openIn"]; this.save(); }));

		new Setting(el).setName("New map defaults").setDesc("Copied into each map when it's created. Change a map's own values from its settings button.").setHeading();
		new Setting(el).setName("Labels").setDesc("When a node's heading is shown.")
			.addDropdown((d) => d.addOptions({ hover: "On hover", always: "Always" }).setValue(md.labelMode).onChange((v) => { md.labelMode = v as MapSettings["labelMode"]; this.save(); }));
		new Setting(el).setName("Label size")
			.addSlider((sl) => sl.setLimits(10, 24, 1).setValue(md.labelSize).setDynamicTooltip().onChange((v) => { md.labelSize = v; this.save(); }));
		new Setting(el).setName("Base pin size (px)")
			.addSlider((sl) => sl.setLimits(16, 64, 1).setValue(md.pinSize).setDynamicTooltip().onChange((v) => { md.pinSize = v; this.save(); }));
		new Setting(el).setName("Pins when zooming").setDesc("Fixed keeps pins the same size on screen; scale grows and shrinks them with the map.")
			.addDropdown((d) => d.addOptions({ fixed: "Fixed size", scale: "Scale with map" }).setValue(md.nodeScaling).onChange((v) => { md.nodeScaling = v as MapSettings["nodeScaling"]; this.save(); }));
	}

	/* ------------------------------ Nodes ------------------------------ */

	private tab_nodes(el: HTMLElement) {
		el.createEl("p", { cls: "setting-item-description", text: "How a new node looks when you add it. Existing nodes aren't changed." });
		const s = this.s;
		this.cleanup = renderStyleEditor(el, {
			plugin: this.plugin, style: s.nodeDefaults,
			visibility: { get: () => s.nodeDefaults.visibility, set: (v) => { s.nodeDefaults.visibility = v; this.save(); } },
			onChange: () => this.save(),
		});
	}

	/* ----------------------------- Drawing ----------------------------- */

	private tab_drawing(el: HTMLElement) {
		const s = this.s, ln = s.lineDefaults;
		el.createEl("p", { cls: "setting-item-description", text: "Starting style for the pen and freehand tools. You can change it any time from the toolbar." });
		const prev = el.createEl("canvas", { cls: "pc-line-preview" });
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		prev.width = 420 * dpr; prev.height = 70 * dpr; prev.style.width = "420px"; prev.style.height = "70px";
		const draw = () => {
			const g = prev.getContext("2d")!;
			g.setTransform(dpr, 0, 0, dpr, 0, 0);
			g.clearRect(0, 0, 420, 70);
			// preview in map units where 1 unit = 420px
			g.save(); g.scale(420, 420);
			applyLineStyle(g, ln, 0.0007);
			g.stroke(new Path2D(smoothD([0.04, 0.12, 0.2, 0.04, 0.34, 0.13, 0.5, 0.05, 0.66, 0.13, 0.82, 0.06, 0.96, 0.12])));
			g.restore();
		};
		draw();
		new Setting(el).setName("Colour").addColorPicker((c) => c.setValue(ln.color).onChange((v) => { ln.color = v; draw(); this.save(); }));
		new Setting(el).setName("Width").setDesc("Relative to the map, so lines look the same on any image size.")
			.addSlider((sl) => sl.setLimits(1, 20, 1).setValue(Math.round(ln.width / 0.0004)).setDynamicTooltip().onChange((v) => { ln.width = v * 0.0004; draw(); this.save(); }));
		new Setting(el).setName("Line style")
			.addDropdown((d) => d.addOptions({ solid: "Solid", dashed: "Dashed", dotted: "Dotted", dashdot: "Dash-dot" }).setValue(ln.dash).onChange((v) => { ln.dash = v as DashStyle; draw(); this.save(); }));
		new Setting(el).setName("Eraser size").setDesc("Percent of the map's width.")
			.addSlider((sl) => sl.setLimits(0.5, 10, 0.5).setValue(s.eraserSize * 100).setDynamicTooltip().onChange((v) => { s.eraserSize = v / 100; this.save(); }));
	}

	/* ------------------------------- Fog ------------------------------- */

	private tab_fog(el: HTMLElement) {
		const s = this.s, md = s.mapDefaults;
		new Setting(el).setName("New map defaults").setHeading();
		new Setting(el).setName("Hide nodes under fog from players").addToggle((t) => t.setValue(md.hideNodesInFog).onChange((v) => { md.hideNodesInFog = v; this.save(); }));
		new Setting(el).setName("Fog colour").addColorPicker((c) => c.setValue(md.fogLook.color).onChange((v) => { md.fogLook.color = v; this.save(); }));
		new Setting(el).setName("Density for players").setDesc("1 fully hides the map under fog.")
			.addSlider((sl) => sl.setLimits(0.4, 1, 0.01).setValue(md.fogLook.density).setDynamicTooltip().onChange((v) => { md.fogLook.density = v; this.save(); }));
		new Setting(el).setName("Animate fog").addToggle((t) => t.setValue(md.fogLook.animate).onChange((v) => { md.fogLook.animate = v; this.save(); }));

		new Setting(el).setName("While editing").setHeading();
		new Setting(el).setName("Fog opacity in your view").setDesc("Lower values let you see the map beneath the fog. Players always see the density above.")
			.addSlider((sl) => sl.setLimits(0.1, 1, 0.05).setValue(s.editorFogOpacity).setDynamicTooltip().onChange((v) => { s.editorFogOpacity = v; this.save(); }));
		new Setting(el).setName("Default brush size").setDesc("Percent of the map's width.")
			.addSlider((sl) => sl.setLimits(0.5, 15, 0.5).setValue(s.brushSize * 100).setDynamicTooltip().onChange((v) => { s.brushSize = v / 100; this.save(); }));
		new Setting(el).setName("Default brush softness")
			.addSlider((sl) => sl.setLimits(0, 1, 0.05).setValue(s.brushSoftness).setDynamicTooltip().onChange((v) => { s.brushSoftness = v; this.save(); }));
	}

	/* ------------------------------ Icons ------------------------------ */

	private tab_icons(el: HTMLElement) {
		const s = this.s;
		el.createEl("p", { cls: "setting-item-description", text: "Add your own icons. They appear in the node icon list and are sent to the player site when a published node uses them." });
		let tint = true;
		new Setting(el).setName("Single-colour icon").setDesc("On: the icon is tinted with the node's colour (works best with dark artwork on white or transparent). Off: keeps its own colours.")
			.addToggle((t) => t.setValue(true).onChange((v) => (tint = v)));
		const list = el.createDiv({ cls: "pc-custom-list" });

		const addBlob = async (blob: Blob, name: string) => {
			try {
				const src = await importIconImage(blob, tint);
				await this.plugin.addCustomIcon({ id: "custom-" + uid(), label: name.replace(/\.[^.]+$/, ""), src, raw: !tint });
			} catch (e) { new Notice(`Couldn't import ${name}: ${(e as Error).message}`); }
		};
		const renderList = () => {
			list.empty();
			if (!s.customIcons.length) list.createDiv({ cls: "setting-item-description", text: "No custom icons yet." });
			for (const ic of s.customIcons) {
				const row = list.createDiv({ cls: "pc-custom-row" });
				const th = row.createDiv({ cls: "pc-custom-thumb" });
				const im = th.createEl("img", { attr: { src: ic.src } });
				if (ic.raw) im.addClass("is-raw");
				const name = row.createEl("input", { type: "text" });
				name.value = ic.label;
				name.addEventListener("change", () => { ic.label = name.value.trim() || ic.label; this.save(); });
				row.createSpan({ cls: "pc-val", text: ic.raw ? "Full colour" : "Tinted" });
				const del = row.createEl("button", { text: "Remove", cls: "mod-warning" });
				del.addEventListener("click", async () => { await this.plugin.removeCustomIcon(ic.id); renderList(); });
			}
		};
		renderList();

		new Setting(el).setName("Add icons")
			.addButton((b) => b.setButtonText("From computer…").setCta().onClick(() => {
				const inp = createEl("input", { type: "file", attr: { accept: "image/*,.svg", multiple: "true" } }) as HTMLInputElement;
				inp.onchange = async () => { for (const f of Array.from(inp.files ?? [])) await addBlob(f, f.name); renderList(); };
				inp.click();
			}))
			.addButton((b) => b.setButtonText("From vault…").onClick(() => new ImagePickerModal(this.app, async (f) => {
				await addBlob(new Blob([await this.app.vault.readBinary(f)], { type: f.extension === "svg" ? "image/svg+xml" : "image/" + f.extension.replace("jpg", "jpeg") }), f.name);
				renderList();
			}).open()));
	}

	/* --------------------------- Performance --------------------------- */

	private tab_performance(el: HTMLElement) {
		const s = this.s;
		new Setting(el).setName("Tile memory").setDesc("How many 512 px map tiles stay decoded in memory (about 1 MB each). Higher uses more RAM but redraws less while panning. Reopen the map after changing.")
			.addDropdown((d) => d.addOptions({ "96": "Low (~100 MB)", "192": "Normal (~200 MB)", "384": "High (~400 MB)" }).setValue(String(s.tileBudget)).onChange((v) => { s.tileBudget = +v; this.save(); }));
		new Setting(el).setName("Tile cache").setDesc("Large maps are cut into tiles the first time they open and cached on this device. Clearing only means the next open rebuilds them.")
			.addButton((b) => b.setButtonText("Clear cache").onClick(async () => { await this.plugin.tileStore.ready(); await this.plugin.tileStore.clearAll(); new Notice("Tile cache cleared. Open maps rebuild when reopened."); }));
		new Setting(el).setName("Fog detail").setDesc("Resolution of the fog mask. Reopen the map after changing.")
			.addDropdown((d) => d.addOptions({ "768": "Low", "1024": "Normal", "2048": "High" }).setValue(String(s.fogResolution)).onChange((v) => { s.fogResolution = +v; this.save(); }));
		new Setting(el).setName("Animate fog while editing").setDesc("Players always see the animation. Off saves a lot of GPU on big maps.")
			.addToggle((t) => t.setValue(s.animateInEditor).onChange((v) => { s.animateInEditor = v; this.save(); }));
	}

	/* --------------------------- Player site --------------------------- */

	private tab_player(el: HTMLElement) {
		const g = this.s.github;
		el.createEl("p", {
			cls: "setting-item-description",
			text: "Maps are pushed to a data branch in your repo; the player page (the docs folder of this plugin, hosted on GitHub Pages) polls that branch. Create a fine-grained personal access token with Contents: read and write on just that repo. The token is stored unencrypted in this plugin's data.json inside your vault, so don't sync that folder anywhere public.",
		});
		new Setting(el).setName("Access token").addText((t) => { t.inputEl.type = "password"; t.setPlaceholder("github_pat_…").setValue(g.token).onChange((v) => { g.token = v.trim(); this.save(); }); });
		new Setting(el).setName("Repository").setDesc("owner/name. The repo must be public and have at least one commit.")
			.addText((t) => t.setPlaceholder("yourname/pointcrawl-player").setValue(g.repo).onChange((v) => { g.repo = v.trim(); this.save(); }));
		new Setting(el).setName("Data branch").setDesc("Created automatically. Keeps live updates out of your main history.")
			.addText((t) => t.setValue(g.branch).onChange((v) => { g.branch = v.trim() || "pointcrawl-data"; this.save(); }));
		new Setting(el).setName("Player page URL").setDesc("Leave blank to use https://owner.github.io/name/")
			.addText((t) => t.setPlaceholder("https://yourname.github.io/pointcrawl-player/").setValue(g.pagesUrl).onChange((v) => { g.pagesUrl = v.trim(); this.save(); }));
		new Setting(el).setName("Instant updates (peer-to-peer)").setDesc("While Live is on, players' browsers connect directly to Obsidian so changes arrive in well under a second. Uses the free public ntfy.sh service to set up the connection and Google/Cloudflare STUN to find a route, and nothing else leaves your machine that way. Players whose network blocks it automatically keep the 2-second GitHub updates. Copy the player link again after changing this.")
			.addToggle((t) => t.setValue(this.s.instantUpdates).onChange((v) => { this.s.instantUpdates = v; this.save(); }));
		new Setting(el).setName("Published map resolution").setDesc("The map is re-encoded as WebP at this size for players. Your original stays private.")
			.addDropdown((d) => d.addOptions({ "2048": "2048 px", "3072": "3072 px", "4096": "4096 px", "6144": "6144 px" }).setValue(String(g.publishSide)).onChange((v) => { g.publishSide = +v; this.save(); }));
		new Setting(el).setName("Live update delay").setDesc("Seconds to wait after your last change before pushing. Lower is snappier. Rapid edits are batched into one push, and GitHub allows roughly 500 writes an hour, so low values are fine for normal play.")
			.addSlider((sl) => sl.setLimits(0.5, 10, 0.5).setValue(g.debounceSec).setDynamicTooltip().onChange((v) => { g.debounceSec = v; this.save(); }));
		new Setting(el).setName("Test connection").addButton((b) => b.setButtonText("Test").onClick(async () => {
			b.setDisabled(true);
			try { new Notice(await this.plugin.github.test(), 6000); } catch (e) { new Notice(String((e as Error).message), 8000); }
			b.setDisabled(false);
		}));
	}
}
