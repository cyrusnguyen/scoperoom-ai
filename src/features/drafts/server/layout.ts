import { Graph, layout as dagreLayout, type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import { COORDINATE_LIMIT, STEP_SIZE, type Direction, type SavedPosition } from "../contracts/draft-layout.ts";
import type { ScopeDocument } from "../contracts/scope-document.ts";
import { bump, byId, GraphError, type Draft } from "../domain/graph.ts";
import { checked, type Placed } from "../domain/moves.ts";

export { moveNodes, type Placed } from "../domain/moves.ts";

// Saved geometry (Data02 "Saved layout and position invariants", "Exact arrangement preview"). Moves and arrangements
// change position versions and the layout only; they never touch the document or any behaviour version.

/** Identifies the complete geometry contract below: library version, fixed sizes, spacing and rounding. */
export const ALGORITHM_VERSION = "dagre-3.1.1/fixed-sizes-v1";

/** Deterministic Dagre arrangement of one flow from saved content only: id-sorted input, fixed sizes, integer top-left corners. */
export function arrange(document: ScopeDocument, flowId: string, direction: Direction): Record<string, { x: number; y: number }> {
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
  graph.setGraph({ rankdir: direction, ranksep: 90, nodesep: 65, marginx: 40, marginy: 40 });
  graph.setDefaultEdgeLabel(() => ({}));
  const nodes = Object.values(document.nodes).filter((node) => node.flowId === flowId).sort(byId);
  for (const node of nodes) graph.setNode(node.id, { ...STEP_SIZE[node.kind] });
  for (const edge of Object.values(document.edges).filter((edge) => edge.flowId === flowId).sort(byId)) graph.setEdge(edge.fromId, edge.toId, { minlen: 1 }, edge.id);
  dagreLayout(graph);
  return Object.fromEntries(nodes.map((node) => {
    const placed = graph.node(node.id);
    return [node.id, { x: Math.round(placed.x! - placed.width / 2), y: Math.round(placed.y! - placed.height / 2) }];
  }));
}

/** The canonical preview identity the arrangement hash covers (Data02): positions sorted by node id. */
export function arrangementCanonical(context: { projectId: string; draftId: string; flowId: string; documentRevision: number; layoutRevision: number; direction: Direction },
  positions: Record<string, { x: number; y: number }>): string {
  const { projectId, draftId, flowId, documentRevision, layoutRevision, direction } = context;
  return JSON.stringify({
    canonicalizationVersion: 1, projectId, draftId, flowId, documentRevision, layoutRevision, direction, algorithmVersion: ALGORITHM_VERSION,
    positions: Object.keys(positions).sort().map((nodeId) => [nodeId, positions[nodeId]!.x, positions[nodeId]!.y]),
  });
}

/** Saves an arrangement: only effectively moved nodes get a new position version; a direction change alone still counts. */
export function applyArrangement(saved: Draft, flowId: string, direction: Direction, arranged: Record<string, { x: number; y: number }>): Placed {
  const positions: Record<string, SavedPosition> = {};
  for (const [nodeId, target] of Object.entries(arranged)) {
    if (Math.abs(target.x) > COORDINATE_LIMIT || Math.abs(target.y) > COORDINATE_LIMIT) throw new GraphError("LIMIT_EXCEEDED");
    const current = saved.layout.positions[nodeId]!;
    if (current.x !== target.x || current.y !== target.y) positions[nodeId] = { ...target, version: bump(current.version) };
  }
  const turned = saved.layout.directions[flowId] !== direction;
  if (!turned && !Object.keys(positions).length) return { layout: saved.layout, positions, changed: false };
  const layout = { ...saved.layout, positions: { ...saved.layout.positions, ...positions }, directions: { ...saved.layout.directions, [flowId]: direction } };
  checked(saved, layout);
  return { layout, positions, changed: true };
}
