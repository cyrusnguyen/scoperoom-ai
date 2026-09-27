import type { DraftLayout } from "../../drafts/contracts/draft-layout.ts";
import type { EdgeRecord, FlowRecord, NodeRecord, ScopeDocument } from "../../drafts/contracts/scope-document.ts";

// Read helpers shared by the canvas, the List and the inspector. They never change saved data.

/** Flows by title, then id, so the switcher's order does not depend on storage key order. */
export function flowsInOrder(document: ScopeDocument): FlowRecord[] {
  return Object.values(document.flows).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** Steps in reading order: top to bottom (left to right in an LR flow), then by name. This is navigation, not an execution order. */
export function stepsInOrder(document: ScopeDocument, layout: DraftLayout, flowId: string): NodeRecord[] {
  const across = layout.directions[flowId] === "LR";
  return Object.values(document.nodes).filter((node) => node.flowId === flowId).sort((a, b) => {
    const p = layout.positions[a.id]!, q = layout.positions[b.id]!;
    return (across ? p.x - q.x : p.y - q.y) || (across ? p.y - q.y : p.x - q.x) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
  });
}

/** A step's name for lists and pickers. Identical names in one flow are told apart by a short id. */
export function stepName(document: ScopeDocument, nodeId: string): string {
  const node = document.nodes[nodeId];
  if (!node) return "Removed step";
  const twins = Object.values(document.nodes).filter((other) => other.id !== node.id && other.flowId === node.flowId && other.label === node.label);
  if (!twins.length) return node.label;
  let length = 8;
  while (length < node.id.length && twins.some((other) => other.id.slice(0, length) === node.id.slice(0, length))) length++;
  return `${node.label} (${node.id.slice(0, length)})`;
}

/** Connections of one flow, ordered like their source steps, then target steps. */
export function connectionsInOrder(document: ScopeDocument, layout: DraftLayout, flowId: string): EdgeRecord[] {
  const rank = new Map(stepsInOrder(document, layout, flowId).map((node, index) => [node.id, index]));
  return Object.values(document.edges).filter((edge) => edge.flowId === flowId)
    .sort((a, b) => rank.get(a.fromId)! - rank.get(b.fromId)! || rank.get(a.toId)! - rank.get(b.toId)! || a.id.localeCompare(b.id));
}

export function neighbours(document: ScopeDocument, nodeId: string): { incoming: EdgeRecord[]; outgoing: EdgeRecord[] } {
  const edges = Object.values(document.edges);
  return { incoming: edges.filter((edge) => edge.toId === nodeId), outgoing: edges.filter((edge) => edge.fromId === nodeId) };
}

/** List search: a case-insensitive match on the name or the id. */
export function matchesStep(node: NodeRecord, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || node.label.toLocaleLowerCase().includes(needle) || node.id.includes(needle);
}

/** The flow the Studio shows: the remembered one while it exists, otherwise the first in order. */
export function currentFlow(document: ScopeDocument, flowId: string | null): FlowRecord | null {
  return (flowId ? document.flows[flowId] : undefined) ?? flowsInOrder(document)[0] ?? null;
}

/** The saved record a selection or buffer points at, or undefined once it has been removed. */
export function recordOf(document: ScopeDocument, kind: "FLOW" | "NODE" | "EDGE", id: string): FlowRecord | NodeRecord | EdgeRecord | undefined {
  return kind === "FLOW" ? document.flows[id] : kind === "NODE" ? document.nodes[id] : document.edges[id];
}
