import { Menu, Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { ICON_DATA } from "./icon-data";
import { ICON_INDEX } from "./shared/icon-index";
import { FONTS_CSS_URL } from "./shared/text";
import { GitHub } from "./github";
import { IMAGE_EXTS, NewMapModal } from "./modals";
import { CustomIcon, DEFAULT_PALETTE, DEFAULT_SETTINGS, PCSettings, PCSettingTab } from "./settings";
import { IconStore } from "./shared/icons";
import { MapFile, uid } from "./shared/types";
import { TileStore } from "./tilestore";
import { PointCrawlView, VIEW_TYPE } from "./view";

export default class PointCrawlPlugin extends Plugin {
	settings!: PCSettings;
	tileStore = new TileStore();
	icons = new IconStore((id) => ICON_DATA[id]);
	github = new GitHub(() => this.settings.github as any);

	async onload() {
		await this.loadSettings();
		this.registerView(VIEW_TYPE, (leaf) => new PointCrawlView(leaf, this));
		this.registerExtensions(["pointcrawl"], VIEW_TYPE);
		this.addSettingTab(new PCSettingTab(this.app, this));

		this.addRibbonIcon("map-pin", "New point crawl map", () => new NewMapModal(this.app, this).open());
		this.addCommand({ id: "new-map", name: "New point crawl map", callback: () => new NewMapModal(this.app, this).open() });

		const withView = (fn: (v: PointCrawlView) => void) => (checking: boolean) => {
			const v = this.app.workspace.getActiveViewOfType(PointCrawlView);
			if (!v) return false;
			if (!checking) fn(v);
			return true;
		};
		this.addCommand({ id: "publish", name: "Publish map to player site", checkCallback: withView((v) => void v.publishNow()) });
		this.addCommand({ id: "toggle-live", name: "Toggle live updates to player site", checkCallback: withView((v) => v.toggleLive()) });
		this.addCommand({ id: "copy-link", name: "Copy player link", checkCallback: withView((v) => v.copyLink()) });

		this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file) => {
			if (file instanceof TFolder) {
				menu.addItem((i) => i.setTitle("New point crawl map").setIcon("map-pin").onClick(() => new NewMapModal(this.app, this, undefined, file).open()));
			} else if (file instanceof TFile && IMAGE_EXTS.includes(file.extension.toLowerCase())) {
				menu.addItem((i) => i.setTitle("Create point crawl map").setIcon("map-pin").onClick(() => new NewMapModal(this.app, this, file, file.parent ?? undefined).open()));
			}
		}));
		this.registerCustomIcons();

		// web fonts for the text tool
		const link = document.head.createEl("link", { attr: { rel: "stylesheet", href: FONTS_CSS_URL, id: "pointcrawl-fonts" } });
		this.register(() => link.remove());
	}

	/* ----------------------------- palette ----------------------------- */

	async addPaletteColor(c: string) {
		c = c.toLowerCase();
		if (!/^#[0-9a-f]{6}$/.test(c) || this.settings.palette.includes(c)) return;
		this.settings.palette = [...this.settings.palette, c].slice(-36);
		await this.saveSettings();
	}
	async removePaletteColor(c: string) { this.settings.palette = this.settings.palette.filter((x) => x !== c); await this.saveSettings(); }

	/* ------------------------------ icons ------------------------------ */

	private registerCustomIcons() { for (const c of this.settings.customIcons) this.icons.register(c.id, c.src, c.raw); }
	/** Custom icons first, then the bundled pack. */
	allIcons(): { id: string; label: string; src: string }[] {
		return [...this.settings.customIcons.map((c) => ({ id: c.id, label: c.label, src: c.src })), ...ICON_INDEX.map((i) => ({ id: i.id, label: i.label, src: ICON_DATA[i.id] }))];
	}
	isRawIcon(id: string) { return !!this.settings.customIcons.find((c) => c.id === id)?.raw; }
	async addCustomIcon(c: CustomIcon) { this.settings.customIcons.push(c); this.icons.register(c.id, c.src, c.raw); await this.saveSettings(); }
	async removeCustomIcon(id: string) { this.settings.customIcons = this.settings.customIcons.filter((c) => c.id !== id); this.icons.unregister(id); await this.saveSettings(); }

	/** Base pin size used for previews. */
	pinBase() { return this.settings.mapDefaults.pinSize; }

	async createMap(name: string, image: TFile, folder?: TFolder) {
		const parent = folder ?? this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? image.path);
		const dir = parent.path === "/" ? "" : parent.path + "/";
		let path = normalizePath(`${dir}${name}.pointcrawl`), i = 1;
		while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${dir}${name} ${++i}.pointcrawl`);
		const d = this.settings.mapDefaults;
		const map: MapFile = {
			version: 1, id: uid(), name, image: image.path, nodes: [], drawings: [], texts: [],
			fog: { enabled: true, base: "fogged", strokes: [] },
			settings: JSON.parse(JSON.stringify(d)),
		};
		const file = await this.app.vault.create(path, JSON.stringify(map));
		await this.app.workspace.getLeaf(true).openFile(file);
		new Notice("Map created. Double-click the map to add nodes.");
	}

	async loadSettings() {
		const saved = (await this.loadData()) ?? {};
		// older versions stored node defaults as separate fields
		const legacy = { color: saved.nodeColor, iconColor: saved.nodeIconColor, size: saved.nodeSize, halo: saved.nodeHalo };
		for (const k of Object.keys(legacy) as (keyof typeof legacy)[]) if (legacy[k] === undefined) delete legacy[k];
		this.settings = {
			...DEFAULT_SETTINGS, ...saved,
			nodeDefaults: { ...DEFAULT_SETTINGS.nodeDefaults, ...legacy, ...(saved.nodeDefaults ?? {}) },
			lineDefaults: { ...DEFAULT_SETTINGS.lineDefaults, ...(saved.lineDefaults ?? {}) },
			customIcons: saved.customIcons ?? [],
			// first run of this version: start from the default palette, keeping anything already saved
			palette: saved.paletteSeeded ? (Array.isArray(saved.palette) ? saved.palette : []) : [...new Set([...DEFAULT_PALETTE, ...(Array.isArray(saved.palette) ? saved.palette : [])])],
			paletteSeeded: true,
			textDefaults: { ...DEFAULT_SETTINGS.textDefaults, ...(saved.textDefaults ?? {}) },
			mapDefaults: { ...DEFAULT_SETTINGS.mapDefaults, ...(saved.mapDefaults ?? {}), fogLook: { ...DEFAULT_SETTINGS.mapDefaults.fogLook, ...(saved.mapDefaults?.fogLook ?? {}) }, scale: { ...DEFAULT_SETTINGS.mapDefaults.scale, ...(saved.mapDefaults?.scale ?? {}) } },
			github: { ...DEFAULT_SETTINGS.github, ...(saved.github ?? {}) },
			published: saved.published ?? {},
		};
	}
	async saveSettings() { await this.saveData(this.settings); }
}
