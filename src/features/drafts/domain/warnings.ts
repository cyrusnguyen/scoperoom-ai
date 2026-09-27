import type { ScopeDocument } from "../contracts/scope-document.ts";

// Draft checks (Data02 "Validation layers"): an exploratory flow saves with these; they never block a save.
// Formal readiness (Stage 08) adds the stricter rules for INCLUDED material.
export type GraphWarning = { code: "NO_START" | "NO_OUTCOME" | "UNCONNECTED_STEP" | "UNLABELLED_BRANCH"; targetId: string };

export function graphWarnings(document: ScopeDocument, flowId: string): GraphWarning[] {
  const nodes = Object.values(document.nodes).filter((node) => node.flowId === flowId).sort((a, b) => a.id.localeCompare(b.id));
  if (!nodes.length) return [];
  const edges = Object.values(document.edges).filter((edge) => edge.flowId === flowId).sort((a, b) => a.id.localeCompare(b.id));
  const warnings: GraphWarning[] = [];
  if (!nodes.some((node) => node.kind === "START")) warnings.push({ code: "NO_START", targetId: flowId });
  if (!nodes.some((node) => node.kind === "OUTCOME")) warnings.push({ code: "NO_OUTCOME", targetId: flowId });
  const connected = new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]));
  const starts = nodes.filter((node) => node.kind === "START");
  const reachable = new Set(starts.map((node) => node.id));
  for (const nodeId of reachable) {
    for (const edge of edges) if (edge.fromId === nodeId && !reachable.has(edge.toId)) reachable.add(edge.toId);
  }
  for (const node of nodes) if (!connected.has(node.id) || !reachable.has(node.id)) warnings.push({ code: "UNCONNECTED_STEP", targetId: node.id });
  for (const edge of edges) if (document.nodes[edge.fromId]?.kind === "DECISION" && !edge.condition.trim()) warnings.push({ code: "UNLABELLED_BRANCH", targetId: edge.id });
  return warnings;
}
