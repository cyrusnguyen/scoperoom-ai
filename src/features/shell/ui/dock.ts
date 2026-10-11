// Pure docking resolver for the two side panels (UI00 "Docking"; Atlas Projects contract §4).
export type PanelMode = "closed" | "docked" | "overlay";
export type DockResult = { left: PanelMode; right: PanelMode; editor: number };
export type DockInput = { leftOpen: boolean; rightOpen: boolean; lastOpened: "left" | "right" | null; leftW?: number; rightW?: number; min?: number };
export type PanelSide = "left" | "right";
export type PanelWidths = Record<PanelSide, number>;

/** Resizable side panel limits; `initial` matches --sidebar-width and --rpanel-width in tokens.css. */
export const PANEL_WIDTHS: Record<PanelSide, { initial: number; min: number; max: number }> = {
  left: { initial: 300, min: 220, max: 480 },
  right: { initial: 360, min: 320, max: 720 },
};
export const EDITOR_MIN = 560;

/** Clamps a panel width to its limits and, given the window and the other docked panel, keeps the editor at least min(W, 560) wide. */
export function clampPanelWidth(side: PanelSide, requested: number, room?: { W: number; other: number }): number {
  const { min, max } = PANEL_WIDTHS[side];
  const fit = room ? room.W - Math.min(room.W, EDITOR_MIN) - room.other : max;
  return Math.round(Math.max(min, Math.min(max, fit, Number.isFinite(requested) ? requested : PANEL_WIDTHS[side].initial)));
}

/** Reads stored widths defensively: anything missing or invalid falls back to the initial width. */
export function parsePanelWidths(value: unknown): PanelWidths {
  const saved = value && typeof value === "object" ? value as Partial<Record<PanelSide, unknown>> : {};
  const pick = (side: PanelSide) => typeof saved[side] === "number" ? clampPanelWidth(side, saved[side]) : PANEL_WIDTHS[side].initial;
  return { left: pick("left"), right: pick("right") };
}

export function resolveDock(W: number, o: DockInput): DockResult {
  const leftW = o.leftW ?? PANEL_WIDTHS.left.initial, rightW = o.rightW ?? PANEL_WIDTHS.right.initial, min = o.min ?? EDITOR_MIN;
  const floor = Math.min(W, min);
  // A panel that can't dock stays open as a focus-trapped overlay only if it was the one most
  // recently opened; otherwise it closes. This also covers first load (lastOpened is null) and a
  // docked→overlay resize collision, without writing state back from the width observer.
  function resolve(open: boolean, used: number, width: number, key: "left" | "right"): PanelMode {
    if (!open) return "closed";
    if (W - used - width >= floor) return "docked";
    return o.lastOpened === key ? "overlay" : "closed";
  }
  const right = resolve(o.rightOpen, 0, rightW, "right");
  const used = right === "docked" ? rightW : 0;
  const left = resolve(o.leftOpen, used, leftW, "left");
  const editor = W - (left === "docked" ? leftW : 0) - (right === "docked" ? rightW : 0);
  return { left, right, editor };
}
