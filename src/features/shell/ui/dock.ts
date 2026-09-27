// Pure docking resolver for the two side panels (UI00 "Docking"; Atlas Projects contract §4).
export type PanelMode = "closed" | "docked" | "overlay";
export type DockResult = { left: PanelMode; right: PanelMode; editor: number };
export type DockInput = { leftOpen: boolean; rightOpen: boolean; lastOpened: "left" | "right" | null; leftW?: number; rightW?: number; min?: number };

export function resolveDock(W: number, o: DockInput): DockResult {
  const leftW = o.leftW ?? 300, rightW = o.rightW ?? 360, min = o.min ?? 560;
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
