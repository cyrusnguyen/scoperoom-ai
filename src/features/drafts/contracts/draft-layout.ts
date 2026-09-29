import type { NodeKind } from "./scope-document.ts";
import { invalid, keys, object, oneOf, version } from "./strict.ts";

// Saved layout (Data02 "Saved layout and position invariants"): the only geometry PostgreSQL stores.
// Selection, viewport, measured sizes and drag state never enter it.
export const DIRECTIONS = ["TB", "LR"] as const;
export type Direction = (typeof DIRECTIONS)[number];
export type SavedPosition = { x: number; y: number; version: number };
/** Which handle (of a node's four) a connection was drawn from and to (UI02 Task 13): geometry, saved in the layout. */
export const SIDES = ["top", "right", "bottom", "left"] as const;
export type Side = (typeof SIDES)[number];
export type DraftLayout = {
  schemaVersion: 1; positions: Record<string, SavedPosition>; directions: Record<string, Direction>;
  edgeSides: Record<string, { from: Side; to: Side }>;
};

export const COORDINATE_LIMIT = 100_000;
export const LAYOUT_BYTE_LIMIT = 256 * 1024;

/** Application-owned, client-safe step sizes (UI02): Dagre (server-only) and the canvas both read these, so a saved
 * arrangement always matches what is drawn. Browser measurements, fonts and label length never take part. */
export const STEP_SIZE: Record<NodeKind, { width: number; height: number }> = {
  START: { width: 120, height: 120 }, OUTCOME: { width: 120, height: 120 },
  ACTION: { width: 200, height: 88 }, DECISION: { width: 140, height: 140 }, DATA_STORE: { width: 120, height: 140 },
};

export function coordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > COORDINATE_LIMIT) invalid();
  return value;
}

/**
 * Every saved node has exactly one position and every flow exactly one direction; nothing else is allowed.
 * `edgeSides` is optional in storage (old drafts predate it) and parses as `{}` when absent; any present entry must
 * name a live edge and two valid sides.
 */
export function parseLayout(value: unknown, nodeIds: ReadonlySet<string>, flowIds: ReadonlySet<string>, edgeIds: ReadonlySet<string>): DraftLayout {
  const layout = object(value);
  keys(layout, ["schemaVersion", "positions", "directions"], ["edgeSides"]);
  if (layout.schemaVersion !== 1) invalid();
  const positions: Record<string, SavedPosition> = {};
  for (const [nodeId, entry] of Object.entries(object(layout.positions))) {
    if (!nodeIds.has(nodeId)) invalid();
    const position = object(entry);
    keys(position, ["x", "y", "version"]);
    positions[nodeId] = { x: coordinate(position.x), y: coordinate(position.y), version: version(position.version) };
  }
  const directions: Record<string, Direction> = {};
  for (const [flowId, entry] of Object.entries(object(layout.directions))) {
    if (!flowIds.has(flowId)) invalid();
    directions[flowId] = oneOf(entry, DIRECTIONS);
  }
  const edgeSides: Record<string, { from: Side; to: Side }> = {};
  if (Object.hasOwn(layout, "edgeSides")) {
    for (const [edgeId, entry] of Object.entries(object(layout.edgeSides))) {
      if (!edgeIds.has(edgeId)) invalid();
      const sides = object(entry);
      keys(sides, ["from", "to"]);
      edgeSides[edgeId] = { from: oneOf(sides.from, SIDES), to: oneOf(sides.to, SIDES) };
    }
  }
  if (Object.keys(positions).length !== nodeIds.size || Object.keys(directions).length !== flowIds.size) invalid();
  return { schemaVersion: 1, positions, directions, edgeSides };
}
