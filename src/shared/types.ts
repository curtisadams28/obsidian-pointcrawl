export type Shape = "pin" | "icon";
export type Visibility = "auto" | "always" | "gm";

export interface NodeStyle {
	shape: Shape;
	/** Icon id from the bundled icon pack (e.g. "castle-02"). Optional for pins. */
	icon?: string;
	color: string;
	iconColor: string;
	/** Multiplier on the map's base pin size. */
	size: number;
	/** Light/dark outline around icon-only nodes so they read on busy maps. */
	halo: boolean;
}

export interface PCNode {
	id: string;
	/** Position as a fraction (0-1) of image width / height. */
	x: number;
	y: number;
	title: string;
	/** Linked note (linkpath, e.g. "Locations/Old Mill"). */
	link?: string;
	style: NodeStyle;
	/** auto = shown to players once its spot is revealed. */
	visibility: Visibility;
}

export interface FogLook {
	color: string;
	/** How opaque fog is for players (0.4 - 1). */
	density: number;
	animate: boolean;
	/** 0.2 - 3 */
	speed: number;
}

export interface FogStroke {
	/** 0 = reveal, 1 = re-fog */
	m: 0 | 1;
	/** Radius as a fraction of image width. */
	r: number;
	/** Hardness 0-0.95 (0 = very soft edge). */
	h: number;
	/** Flat [x0,y0,x1,y1,...] in image-fraction coordinates. */
	p: number[];
}

export interface FogData {
	enabled: boolean;
	base: "fogged" | "clear";
	strokes: FogStroke[];
}

export interface MapSettings {
	labelMode: "hover" | "always";
	labelSize: number;
	pinSize: number;
	nodeScaling: "fixed" | "scale";
	hideNodesInFog: boolean;
	fogLook: FogLook;
}

export type DashStyle = "solid" | "dashed" | "dotted" | "dashdot";

export interface LineStyle {
	color: string;
	/** Stroke width as a fraction of the image width. */
	width: number;
	dash: DashStyle;
}

/** Bezier anchor with absolute control points (ix,iy = incoming handle, ox,oy = outgoing). Equal to x,y for a corner. */
export interface PenAnchor { x: number; y: number; ix: number; iy: number; ox: number; oy: number }

/**
 * A vector line. All coordinates are in "map units": 1 unit = the image's width, on both axes,
 * so strokes stay uniform. `d` is plain SVG path data in those units and is what gets rendered.
 */
export interface Drawing {
	id: string;
	kind: "free" | "pen";
	style: LineStyle;
	pts?: number[];
	anchors?: PenAnchor[];
	closed?: boolean;
	d: string;
}
export type RenderDrawing = Pick<Drawing, "id" | "style" | "d">;

export interface MapFile {
	version: 1;
	id: string;
	name: string;
	/** Vault path of the map image. */
	image: string;
	nodes: PCNode[];
	drawings: Drawing[];
	fog: FogData;
	settings: MapSettings;
}

/** What gets pushed to the player site. Never contains links or GM-only nodes. */
export interface PublishedState {
	v: 1;
	rev: number;
	name: string;
	image: { file: string; w: number; h: number };
	nodes: { id: string; x: number; y: number; title: string; style: NodeStyle }[];
	drawings?: RenderDrawing[];
	/** Custom icons used by the nodes above (built-in icons ship with the player page). */
	customIcons?: Record<string, { src: string; raw: boolean }>;
	/** PNG data URL, alpha = fog amount. null when fog is disabled. */
	fogMask: string | null;
	settings: Pick<MapSettings, "labelMode" | "labelSize" | "pinSize" | "nodeScaling" | "fogLook">;
}

export const DEFAULT_STYLE: NodeStyle = {
	shape: "pin",
	color: "#c0392b",
	iconColor: "#1b1b1b",
	size: 1,
	halo: true,
};

export const DEFAULT_LINE: LineStyle = { color: "#5a3b1f", width: 0.0016, dash: "solid" };

export const DEFAULT_FOG_LOOK: FogLook = {
	color: "#aeb9c2",
	density: 0.97,
	animate: true,
	speed: 1,
};

export const DEFAULT_MAP_SETTINGS: MapSettings = {
	labelMode: "hover",
	labelSize: 14,
	pinSize: 30,
	nodeScaling: "fixed",
	hideNodesInFog: true,
	fogLook: { ...DEFAULT_FOG_LOOK },
};

export function uid(): string {
	return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
