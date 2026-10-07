import type { ScopeDocument } from "../../drafts/contracts/scope-document.ts";

// Deterministic plain-text design evidence from one saved flow (Data01 "Graph promotion"). Stable order: steps by label then id,
// connections by endpoint labels then id. Line breaks inside a field become spaces so every record keeps one line.
const oneLine = (value: string) => value.replace(/\r\n?|\n/g, " ");
const order = (a: [string, string], b: [string, string]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

export function graphExtract(document: ScopeDocument, flowId: string): string {
  const flow = document.flows[flowId];
  if (!flow) throw new Error("INVALID_INPUT");
  const nodes = Object.values(document.nodes).filter((node) => node.flowId === flowId)
    .sort((a, b) => order([a.label, a.id], [b.label, b.id]));
  const label = (nodeId: string) => oneLine(document.nodes[nodeId]!.label);
  const edges = Object.values(document.edges).filter((edge) => edge.flowId === flowId)
    .sort((a, b) => order([`${label(a.fromId)}\u0000${label(a.toId)}`, a.id], [`${label(b.fromId)}\u0000${label(b.toId)}`, b.id]));
  const lines = [`Flow: ${oneLine(flow.title)}`];
  if (flow.purpose) lines.push(`Purpose: ${oneLine(flow.purpose)}`);
  lines.push("Steps:");
  for (const node of nodes) {
    lines.push(`- ${node.kind} ${oneLine(node.label)}${node.actorLabel ? ` (actor: ${oneLine(node.actorLabel)})` : ""}`);
    if (node.description) lines.push(`  ${oneLine(node.description)}`);
  }
  lines.push("Connections:");
  for (const edge of edges) lines.push(`- ${label(edge.fromId)} -> ${label(edge.toId)}${edge.condition ? ` [${oneLine(edge.condition)}]` : ""}`);
  return lines.join("\n");
}
