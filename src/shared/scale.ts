import { MapScale } from "./types.js";

interface UnitDef { id: string; label: string; short: string; sub?: { short: string; factor: number } }

/** `sub` is used automatically when a distance gets small (for example miles drop to feet). */
export const UNITS: UnitDef[] = [
	{ id: "miles", label: "Miles", short: "mi", sub: { short: "ft", factor: 5280 } },
	{ id: "km", label: "Kilometres", short: "km", sub: { short: "m", factor: 1000 } },
	{ id: "leagues", label: "Leagues", short: "leagues" },
	{ id: "feet", label: "Feet", short: "ft" },
	{ id: "yards", label: "Yards", short: "yd" },
	{ id: "metres", label: "Metres", short: "m" },
];

const def = (unit: string) => UNITS.find((u) => u.id === unit);
export const isPresetUnit = (unit: string) => !!def(unit);
export const unitName = (unit: string) => def(unit)?.label.toLowerCase() ?? unit;
export const unitShort = (unit: string) => def(unit)?.short ?? unit;

function fmt(n: number): string {
	const a = Math.abs(n);
	return String(Number(n.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2)));
}

/** `u` is a length in map units (1 = image width). */
export function formatDistance(u: number, sc: MapScale): string {
	const v = u * sc.mapWidth;
	const d = def(sc.unit);
	if (d?.sub && v < 0.5) return `${fmt(v * d.sub.factor)} ${d.sub.short}`;
	return `${fmt(v)} ${unitShort(sc.unit)}`;
}

/** A round-numbered scale bar. `perPx` = real distance (in sc.unit) per screen pixel. */
export function niceBar(sc: MapScale, perPx: number, targetPx = 110): { px: number; label: string } {
	let per = perPx, short = unitShort(sc.unit);
	const d = def(sc.unit);
	if (d?.sub && perPx * targetPx < 0.5) { per = perPx * d.sub.factor; short = d.sub.short; }
	const v = per * targetPx;
	const p = Math.pow(10, Math.floor(Math.log10(v)));
	const m = v / p;
	const nice = (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
	return { px: nice / per, label: `${fmt(nice)} ${short}` };
}
