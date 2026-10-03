import type { DraftView } from "../../drafts/contracts/scope-document.ts";
import type { FlowFileV1 } from "../../exchange/contracts/flow-file.ts";

export function exportFilename(title: string): string {
  // 50 Unicode code points plus the extension fit the portable 255-byte filename bound.
  const stem = [...title.normalize("NFC").replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, "_").trim()].slice(0, 50).join("").replace(/[. ]+$/u, "");
  const safe = !stem || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(stem) ? "flow" : stem;
  return `${safe}.scoperoom-flow.json`;
}

/** Project/draft/entity identities and trust metadata never enter the portable native file. */
export function nativeFlowFile(draft: DraftView, flowId: string, exportedAt: string): FlowFileV1 {
  const flow = draft.document.flows[flowId]!;
  const nodes = Object.values(draft.document.nodes).filter(node => node.flowId === flowId);
  const edges = Object.values(draft.document.edges).filter(edge => edge.flowId === flowId);
  const nodeIds = new Map(nodes.map((node, index) => [node.id, `n${index + 1}`]));
  return {
    format: "scoperoom-flow", formatVersion: 1, exportedAt, producerVersion: "1.6",
    flow: { title: flow.title, purpose: flow.purpose, classification: flow.classification, direction: draft.layout.directions[flowId]! },
    nodes: nodes.map(node => ({ id: nodeIds.get(node.id)!, kind: node.kind, label: node.label, description: node.description, actorLabel: node.actorLabel || null, assumptionNotes: [...node.assumptionNotes] })),
    edges: edges.map((edge, index) => ({ id: `e${index + 1}`, fromId: nodeIds.get(edge.fromId)!, toId: nodeIds.get(edge.toId)!, condition: edge.condition || null })),
    origin: { kind: "DRAFT", documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision },
    positions: nodes.map(node => ({ nodeId: nodeIds.get(node.id)!, x: draft.layout.positions[node.id]!.x, y: draft.layout.positions[node.id]!.y })),
    edgeSides: edges.flatMap((edge, index) => { const sides = draft.layout.edgeSides[edge.id]; return sides ? [{ edgeId: `e${index + 1}`, from: sides.from, to: sides.to }] : []; }),
  };
}
