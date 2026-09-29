import type { DraftLayout, SavedPosition } from "../contracts/draft-layout.ts";
import type { MoveNodes } from "../contracts/positions.ts";
import { parseDraftPair } from "../contracts/scope-document.ts";
import { bump, GraphError, type Draft } from "./graph.ts";

// MOVE_NODES without Dagre, so the browser's optimistic replay (applyChanges) can reuse the exact server rule.

export type Placed = { layout: DraftLayout; positions: Record<string, SavedPosition>; changed: boolean };

export function checked(saved: Draft, layout: DraftLayout) {
  try { parseDraftPair(saved.document, layout); } catch { throw new Error("LAYOUT_INVARIANT"); }
}

/**
 * MOVE_NODES: each item names a live node of the flow at its expected position version; all move or none do.
 * `check: false` is for a batch that runs checkDraft once on its final draft.
 */
export function moveNodes(saved: Draft, command: MoveNodes, { check = true } = {}): Placed {
  for (const item of command.items) {
    const node = saved.document.nodes[item.nodeId];
    if (!node) throw new GraphError("POSITION_CONFLICT", { nodeId: item.nodeId, currentVersion: null }); // deleted: a late move never recreates it
    if (node.flowId !== command.flowId) throw new GraphError("INVALID_INPUT");
    const current = saved.layout.positions[item.nodeId]!;
    if (current.version !== item.expectedPositionVersion) throw new GraphError("POSITION_CONFLICT", { nodeId: item.nodeId, currentVersion: current.version });
  }
  const positions: Record<string, SavedPosition> = {};
  for (const item of command.items) {
    const current = saved.layout.positions[item.nodeId]!;
    if (current.x !== item.x || current.y !== item.y) positions[item.nodeId] = { x: item.x, y: item.y, version: bump(current.version) };
  }
  if (!Object.keys(positions).length) return { layout: saved.layout, positions, changed: false };
  const layout = { ...saved.layout, positions: { ...saved.layout.positions, ...positions } };
  if (check) checked(saved, layout);
  return { layout, positions, changed: true };
}
