import { invalid, keys, object, oneOf, version } from "./strict.ts";

// Saved layout (Data02 "Saved layout and position invariants"): the only geometry PostgreSQL stores.
// Selection, viewport, measured sizes and drag state never enter it.
export const DIRECTIONS = ["TB", "LR"] as const;
export type Direction = (typeof DIRECTIONS)[number];
export type SavedPosition = { x: number; y: number; version: number };
export type DraftLayout = { schemaVersion: 1; positions: Record<string, SavedPosition>; directions: Record<string, Direction> };

export const COORDINATE_LIMIT = 100_000;
export const LAYOUT_BYTE_LIMIT = 256 * 1024;

export function coordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > COORDINATE_LIMIT) invalid();
  return value;
}

/** Every saved node has exactly one position and every flow exactly one direction; nothing else is allowed. */
export function parseLayout(value: unknown, nodeIds: ReadonlySet<string>, flowIds: ReadonlySet<string>): DraftLayout {
  const layout = object(value);
  keys(layout, ["schemaVersion", "positions", "directions"]);
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
  if (Object.keys(positions).length !== nodeIds.size || Object.keys(directions).length !== flowIds.size) invalid();
  return { schemaVersion: 1, positions, directions };
}
