import { TextObj } from "./types.js";

export interface FontDef { label: string; css: string; web?: string }

/** System stacks plus a few web fonts (loaded from Google Fonts by the plugin and the player page). */
export const FONTS: FontDef[] = [
	{ label: "Serif", css: 'Georgia, "Times New Roman", serif' },
	{ label: "Sans-serif", css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
	{ label: "Monospace", css: 'ui-monospace, Menlo, Consolas, monospace' },
	{ label: "Cinzel", css: '"Cinzel", serif', web: "Cinzel" },
	{ label: "Cinzel Decorative", css: '"Cinzel Decorative", serif', web: "Cinzel Decorative" },
	{ label: "IM Fell English", css: '"IM Fell English", serif', web: "IM Fell English" },
	{ label: "MedievalSharp", css: '"MedievalSharp", serif', web: "MedievalSharp" },
	{ label: "Uncial Antiqua", css: '"Uncial Antiqua", serif', web: "Uncial Antiqua" },
	{ label: "Almendra", css: '"Almendra", serif', web: "Almendra" },
	{ label: "Pirata One", css: '"Pirata One", serif', web: "Pirata One" },
	{ label: "Metamorphous", css: '"Metamorphous", serif', web: "Metamorphous" },
	{ label: "Caudex", css: '"Caudex", serif', web: "Caudex" },
	{ label: "Spectral", css: '"Spectral", serif', web: "Spectral" },
];

export const FONTS_CSS_URL = "https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&family=Cinzel+Decorative:wght@400;700&family=IM+Fell+English:ital@0;1&family=MedievalSharp&family=Uncial+Antiqua&family=Almendra:ital,wght@0,400;0,700;1,400&family=Pirata+One&family=Metamorphous&family=Caudex:ital,wght@0,400;0,700;1,400&family=Spectral:ital,wght@0,400;0,700;1,400&display=swap";

export type TextStyle = Omit<TextObj, "id" | "x" | "y" | "rot" | "text">;
export const DEFAULT_TEXT_STYLE: TextStyle = {
	size: 0.03, font: FONTS[0].css, bold: false, italic: false, color: "#2b2118", arc: 0,
	outW: 0.08, outColor: "#f4ead2", outBlur: 0,
	shadow: false, shColor: "#000000", shOpacity: 0.55, shBlur: 0.12, shDx: 0.05, shDy: 0.08,
};

export const fontString = (t: Pick<TextObj, "font" | "bold" | "italic">, px: number) => `${t.italic ? "italic " : ""}${t.bold ? "700 " : "400 "}${px}px ${t.font}`;

function rgba(hex: string, a: number) {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	const n = m ? parseInt(m[1], 16) : 0;
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* --------------------------------- layout --------------------------------- */

export interface Layout {
	lines?: { text: string; y: number }[];
	glyphs?: { ch: string; x: number; y: number; rot: number }[];
	/** Em units, relative to the anchor (the middle of the text). */
	box: { x0: number; y0: number; x1: number; y1: number };
}

const LINE_H = 1.2;
const measureCtx = document.createElement("canvas").getContext("2d")!;

function computeLayout(t: TextObj): Layout {
	measureCtx.font = fontString(t, 100);
	const m = (s: string) => measureCtx.measureText(s).width / 100;
	if (Math.abs(t.arc) < 1) {
		const ls = (t.text || " ").split("\n");
		const lines = ls.map((text, i) => ({ text, y: (i - (ls.length - 1) / 2) * LINE_H }));
		const w = Math.max(0.2, ...ls.map(m));
		return { lines, box: { x0: -w / 2, x1: w / 2, y0: -ls.length * LINE_H / 2, y1: ls.length * LINE_H / 2 } };
	}
	const chars = Array.from((t.text || " ").replace(/\n/g, " "));
	const cum = [0];
	for (let i = 0; i < chars.length; i++) cum.push(m(chars.slice(0, i + 1).join("")));
	const W = Math.max(0.2, cum[chars.length]);
	const th = (Math.abs(t.arc) * Math.PI) / 180, R = W / th, up = t.arc > 0;
	const glyphs: NonNullable<Layout["glyphs"]> = [];
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	chars.forEach((ch, i) => {
		const s = (cum[i] + cum[i + 1]) / 2 - W / 2, phi = s / R;
		const x = R * Math.sin(phi), y = (up ? 1 : -1) * (R - R * Math.cos(phi)), rot = up ? phi : -phi;
		glyphs.push({ ch, x, y, rot });
		const hw = (cum[i + 1] - cum[i]) / 2, hh = LINE_H / 2, c = Math.cos(rot), sn = Math.sin(rot);
		for (const [cx, cy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
			const px = x + cx * c - cy * sn, py = y + cx * sn + cy * c;
			x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
		}
	});
	return { glyphs, box: { x0, y0, x1, y1 } };
}

/* -------------------------------- rendering -------------------------------- */

export interface Sprite { canvas: HTMLCanvasElement; ax: number; ay: number; ppe: number }

function paint(g: CanvasRenderingContext2D, t: TextObj, lay: Layout, ppe: number, ox: number, oy: number, mode: "fill" | "stroke") {
	g.font = fontString(t, ppe);
	g.textAlign = "center"; g.textBaseline = "middle";
	const one = (s: string, x: number, y: number, rot: number) => {
		g.save();
		g.translate(ox + x * ppe, oy + y * ppe);
		if (rot) g.rotate(rot);
		if (mode === "fill") g.fillText(s, 0, 0); else g.strokeText(s, 0, 0);
		g.restore();
	};
	if (lay.glyphs) lay.glyphs.forEach((gl) => one(gl.ch, gl.x, gl.y, gl.rot));
	else lay.lines!.forEach((l) => one(l.text, 0, l.y, 0));
}

export class TextRenderer {
	private lay = new Map<string, Layout>();
	private spr = new Map<string, Sprite>();
	private loading = new Set<string>();
	private listeners = new Set<() => void>();

	onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
	private notify() { this.listeners.forEach((f) => f()); }
	private clear() { this.lay.clear(); this.spr.clear(); this.notify(); }

	layout(t: TextObj): Layout {
		this.ensureFont(t);
		const k = `${t.font}|${+t.bold}${+t.italic}|${t.arc}|${t.text}`;
		let l = this.lay.get(k);
		if (!l) { l = computeLayout(t); this.lay.set(k, l); if (this.lay.size > 300) this.lay.delete(this.lay.keys().next().value!); }
		return l;
	}

	private ensureFont(t: TextObj) {
		const fd = FONTS.find((f) => f.css === t.font);
		if (!fd?.web || typeof document === "undefined" || !document.fonts) return;
		const spec = fontString(t, 16);
		if (this.loading.has(spec)) return;
		this.loading.add(spec);
		const attempt = (n: number) => document.fonts.load(spec, "Ag").then((faces) => {
			if (faces.length === 0 && n < 3) setTimeout(() => attempt(n + 1), 2000); // stylesheet may not have arrived yet
			else this.clear();
		}).catch(() => undefined);
		attempt(0);
	}

	/** A cached bitmap of the text at about `pxPerEm` device pixels per em. */
	sprite(t: TextObj, pxPerEm: number): Sprite | null {
		const lay = this.layout(t), b = lay.box;
		const padEm = (t.outW > 0 ? t.outW + t.outBlur * 1.5 : 0) + (t.shadow ? Math.hypot(t.shDx, t.shDy) + t.shBlur * 1.5 : 0) + 0.2;
		const wEm = b.x1 - b.x0 + 2 * padEm, hEm = b.y1 - b.y0 + 2 * padEm;
		let ppe = Math.pow(2, Math.ceil(Math.log2(Math.max(4, pxPerEm)) * 2) / 2);
		ppe = Math.min(ppe, 3072 / Math.max(wEm, hEm));
		const key = [t.text, t.font, +t.bold, +t.italic, t.color, t.arc, t.outW, t.outColor, t.outBlur, +t.shadow, t.shColor, t.shOpacity, t.shBlur, t.shDx, t.shDy, ppe.toFixed(1)].join("|");
		let s = this.spr.get(key);
		if (s) return s;
		const W = Math.max(2, Math.ceil(wEm * ppe)), H = Math.max(2, Math.ceil(hEm * ppe));
		const ax = (-b.x0 + padEm) * ppe, ay = (-b.y0 + padEm) * ppe;
		const c = document.createElement("canvas");
		c.width = W; c.height = H;
		const g = c.getContext("2d")!;
		const OFF = W + 400; // draw shapes off-canvas so only their (blurred / offset) shadow lands on it
		const strokeSetup = (ctx: CanvasRenderingContext2D) => { ctx.lineWidth = 2 * t.outW * ppe; ctx.lineJoin = "round"; ctx.miterLimit = 2; };

		if (t.shadow) {
			const sil = document.createElement("canvas");
			sil.width = W; sil.height = H;
			const sg = sil.getContext("2d")!;
			sg.fillStyle = sg.strokeStyle = "#000";
			if (t.outW > 0) { strokeSetup(sg); paint(sg, t, lay, ppe, ax, ay, "stroke"); }
			paint(sg, t, lay, ppe, ax, ay, "fill");
			g.save();
			g.shadowColor = rgba(t.shColor, t.shOpacity);
			g.shadowBlur = t.shBlur * ppe;
			g.shadowOffsetX = OFF + t.shDx * ppe; g.shadowOffsetY = t.shDy * ppe;
			g.drawImage(sil, -OFF, 0);
			g.restore();
		}
		if (t.outW > 0) {
			strokeSetup(g);
			g.strokeStyle = t.outColor;
			if (t.outBlur > 0) {
				g.save();
				g.shadowColor = t.outColor; g.shadowBlur = t.outBlur * ppe; g.shadowOffsetX = OFF;
				g.translate(-OFF, 0);
				paint(g, t, lay, ppe, ax, ay, "stroke");
				paint(g, t, lay, ppe, ax, ay, "stroke"); // twice, for a denser glow
				g.restore();
			} else paint(g, t, lay, ppe, ax, ay, "stroke");
		}
		g.fillStyle = t.color;
		paint(g, t, lay, ppe, ax, ay, "fill");

		s = { canvas: c, ax, ay, ppe };
		this.spr.set(key, s);
		if (this.spr.size > 80) this.spr.delete(this.spr.keys().next().value!);
		return s;
	}
}

export const textRenderer = new TextRenderer();

/* ------------------------------- geometry (map units) ------------------------------- */

/** The four corners of the text box in map units, after rotation. */
export function textCorners(t: TextObj): [number, number][] {
	const b = textRenderer.layout(t).box, c = Math.cos(t.rot), s = Math.sin(t.rot);
	return ([[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]] as [number, number][]).map(([x, y]) => [t.x + (x * c - y * s) * t.size, t.y + (x * s + y * c) * t.size]);
}

export function textHit(t: TextObj, ux: number, uy: number, pad = 0): boolean {
	const b = textRenderer.layout(t).box, c = Math.cos(-t.rot), s = Math.sin(-t.rot);
	const dx = ux - t.x, dy = uy - t.y;
	const lx = (dx * c - dy * s) / t.size, ly = (dx * s + dy * c) / t.size, p = pad / t.size;
	return lx >= b.x0 - p && lx <= b.x1 + p && ly >= b.y0 - p && ly <= b.y1 + p;
}
