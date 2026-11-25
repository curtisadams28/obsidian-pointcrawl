export const DEFAULT_STYLE = {
    shape: "pin",
    color: "#c0392b",
    iconColor: "#1b1b1b",
    size: 1,
    halo: true,
    iconBg: true,
};
export const DEFAULT_LINE = { color: "#5a3b1f", width: 0.0016, dash: "solid" };
export const DEFAULT_FOG_LOOK = {
    color: "#aeb9c2",
    density: 0.97,
    animate: true,
    speed: 1,
};
export const DEFAULT_SCALE = { mapWidth: 100, unit: "miles", show: true };
export const DEFAULT_MAP_SETTINGS = {
    labelMode: "hover",
    labelSize: 14,
    pinSize: 30,
    nodeScaling: "fixed",
    hideNodesInFog: true,
    fogLook: { ...DEFAULT_FOG_LOOK },
    scale: { ...DEFAULT_SCALE },
};
export function uid() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}
