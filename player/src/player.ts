import { maskFromDataURL } from "../../src/shared/fog.js";
import { IconStore } from "../../src/shared/icons.js";
import { LoadedImage, loadImage } from "../../src/shared/image.js";
import { LiveClient, topicFor } from "../../src/shared/live.js";
import { MapCanvas } from "../../src/shared/mapcanvas.js";
import { PyramidSource, TileSource } from "../../src/shared/tiles.js";
import { PublishedState } from "../../src/shared/types.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// An installed app opens at its start URL without the map in it, so remember the last map and go back to it.
const LAST = "pointcrawl-last";
let qs = location.search;
if (!qs) { try { const saved = localStorage.getItem(LAST); if (saved) { history.replaceState(null, "", location.pathname + saved); qs = saved; } } catch { /* storage blocked */ } }
const q = new URLSearchParams(qs);
const repo = q.get("r"), branch = q.get("b") || "pointcrawl-data", mapId = q.get("m");
const p2pEnabled = q.get("p") !== "0";
const pollMs = Math.max(1, Math.min(60, Number(q.get("poll")) || 2)) * 1000;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const maxSide = navigator.maxTouchPoints > 0 ? 4096 : 8192;

const stage = $("stage"), emptyEl = $("empty"), emptyTitle = $("emptyTitle"), emptyBody = $("emptyBody");
const chip = $("chip"), chipText = $("chipText");

/** Read the device's safe-area insets (notch, home bar) so on-canvas UI stays clear of them. */
function safeInsets() {
	const probe = document.createElement("div");
	probe.style.cssText = "position:fixed;visibility:hidden;padding:env(safe-area-inset-bottom,0px) 0 0 env(safe-area-inset-left,0px)";
	document.body.appendChild(probe);
	const cs = getComputedStyle(probe);
	const r = { x: 14 + (parseFloat(cs.paddingLeft) || 0), y: 14 + (parseFloat(cs.paddingTop) || 0) };
	probe.remove();
	return r;
}

function showEmpty(title: string, body: string) {
	emptyTitle.textContent = title; emptyBody.textContent = body;
	emptyEl.hidden = false;
}

if (!repo || !mapId || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
	chip.hidden = true;
	showEmpty("This link is incomplete", "Ask your GM to copy the player link again from Obsidian. It should contain the repository and map in the address.");
} else {
	try { localStorage.setItem(LAST, qs); } catch { /* storage blocked */ }
	start(repo, mapId);
}

if ("serviceWorker" in navigator) window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => undefined); });

function start(repo: string, mapId: string) {
	const base = `https://raw.githubusercontent.com/${repo}/${branch}/maps/${mapId}/`;
	const icons = new IconStore((id) => `icons/${id}.png`);
	const canvas = new MapCanvas(stage, icons);
	canvas.fontFamily = '"Atkinson Hyperlegible", system-ui, sans-serif';
	canvas.maxZoom = 6;
	canvas.fogOutside = true; // fog covers the whole screen, not just the map image
	canvas.scaleInset = safeInsets();
	canvas.onClick = (p) => { canvas.pinnedId = p.node && canvas.pinnedId !== p.node.id ? p.node.id : null; canvas.requestDraw(); };

	$("zin").onclick = () => canvas.zoomBy(1.4);
	$("zout").onclick = () => canvas.zoomBy(1 / 1.4);
	$("zfit").onclick = () => canvas.fit();
	const rulerBtn = $("zruler");
	rulerBtn.onclick = () => {
		const on = !canvas.rulerActive;
		canvas.setRulerActive(on);
		rulerBtn.setAttribute("aria-pressed", String(on));
	};
	window.addEventListener("keydown", (e) => {
		if (e.key !== "Escape" || !canvas.rulerActive) return;
		if (canvas.hasRuler) canvas.clearRuler();
		else { canvas.setRulerActive(false); rulerBtn.setAttribute("aria-pressed", "false"); }
	});

	let source: TileSource | null = null;
	let lastRev = -1, imageFile = "", lastOk = 0, failures = 0, haveMap = false;

	// The notice only shows when something is wrong; a healthy connection shows nothing.
	let p2p = false, slowPoll = false, trouble = "";
	const paintChip = () => {
		const msg = trouble || (slowPoll && !p2p ? "Delayed updates" : "");
		chip.hidden = !msg;
		chip.dataset.kind = trouble ? "error" : "stale";
		chipText.textContent = msg;
	};

	// state arrives from two places (direct connection, GitHub polling); apply them one at a time, newest wins
	let chain: Promise<void> = Promise.resolve();
	const submit = (st: PublishedState) => {
		const run = chain.then(() => (st.rev > lastRev ? apply(st) : undefined));
		chain = run.catch(() => undefined);
		return run;
	};

	// GitHub's raw host caches files for 5+ minutes, so live state comes from the API (never cached,
	// and "not modified" replies are free against the rate limit). Raw is only a slow fallback.
	const apiBase = `https://api.github.com/repos/${repo}/contents/maps/${mapId}/`;
	const apiHeaders = { Accept: "application/vnd.github.raw+json" };
	let limitedUntil = 0;

	async function loadState(): Promise<{ status: "ok" | "none"; st?: PublishedState; slow: boolean }> {
		if (Date.now() >= limitedUntil) {
			const res = await fetch(`${apiBase}state.json?ref=${encodeURIComponent(branch)}`, { cache: "no-cache", headers: apiHeaders });
			if (res.status === 404) return { status: "none", slow: false };
			if (res.status === 403 || res.status === 429) {
				const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
				limitedUntil = Math.min(reset > Date.now() ? reset : Date.now() + 5 * 60000, Date.now() + 10 * 60000);
			} else if (!res.ok) throw new Error(String(res.status));
			else return { status: "ok", st: (await res.json()) as PublishedState, slow: false };
		}
		const res = await fetch(`${base}state.json?t=${Date.now()}`, { cache: "no-store" });
		if (res.status === 404) return { status: "none", slow: true };
		if (!res.ok) throw new Error(String(res.status));
		return { status: "ok", st: (await res.json()) as PublishedState, slow: true };
	}

	async function loadImageFile(file: string): Promise<LoadedImage> {
		let res = await fetch(base + file);
		if (!res.ok) res = await fetch(`${apiBase}${file}?ref=${encodeURIComponent(branch)}`, { headers: apiHeaders });
		if (!res.ok) throw new Error(`Map image ${res.status}`);
		const buf = await res.arrayBuffer();
		return loadImage(new Blob([buf], { type: res.headers.get("content-type") || "image/webp" }), buf, maxSide);
	}

	async function apply(st: PublishedState) {
		if (st.image.file !== imageFile) {
			if (!haveMap) showEmpty("Unrolling the map…", "Downloading a large image. This can take a few seconds.");
			const img = await loadImageFile(st.image.file);
			const next = new PyramidSource(img);
			canvas.setSource(next);
			source?.dispose();
			source = next;
			imageFile = st.image.file;
		}
		const look = { ...st.settings.fogLook, animate: st.settings.fogLook.animate && !reduceMotion };
		canvas.fogMask = st.fogMask ? await maskFromDataURL(st.fogMask) : null;
		canvas.fogLook = look;
		canvas.fogOpacity = look.density;
		canvas.settings = { labelMode: st.settings.labelMode, labelSize: st.settings.labelSize, pinSize: st.settings.pinSize, nodeScaling: st.settings.nodeScaling };
		if (st.settings.scale) canvas.scale = st.settings.scale;
		for (const [id, c] of Object.entries(st.customIcons ?? {})) icons.register(id, c.src, c.raw);
		canvas.drawings = st.drawings ?? [];
		canvas.texts = st.texts ?? [];
		canvas.nodes = st.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, title: n.title, style: n.style }));
		if (canvas.pinnedId && !st.nodes.some((n) => n.id === canvas.pinnedId)) canvas.pinnedId = null;
		canvas.requestDraw();
		document.title = st.name ? `${st.name} · Point crawl` : "Point crawl";
		emptyEl.hidden = true;
		haveMap = true;
		lastRev = st.rev;
	}

	async function tick() {
		let slow = false;
		try {
			const r = await loadState();
			slow = r.slow;
			if (r.status === "none") {
				if (!haveMap) showEmpty("Waiting for the GM", "No map has been shared yet. This page will update by itself the moment one is.");
			} else if (r.st) await submit(r.st);
			failures = 0; lastOk = Date.now();
			slowPoll = slow; trouble = "";
			paintChip();
		} catch {
			failures++;
			trouble = haveMap ? "Connection lost. Reconnecting…" : "Can't reach the map";
			paintChip();
			if (!haveMap && failures > 2) showEmpty("Can't reach the map", "Check your connection, or ask the GM to confirm the player link and that the repository is public.");
		}
		const wait = p2p ? 20000 : document.hidden ? 15000 : slow ? Math.max(pollMs, 5000) : pollMs * Math.min(4, 1 + Math.floor(failures / 3));
		setTimeout(tick, wait);
	}

	document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastOk > pollMs) void tick(); });
	showEmpty("Connecting…", "");
	void tick();

	// instant updates straight from the GM's Obsidian; polling above stays as the fallback
	if (p2pEnabled && typeof RTCPeerConnection !== "undefined") {
		new LiveClient({
			topic: topicFor(mapId),
			onState: (json) => { try { void submit(JSON.parse(json) as PublishedState).catch(() => undefined); } catch { /* ignore bad frame */ } },
			onStatus: (on) => { p2p = on; paintChip(); },
		}).start();
	}
}
