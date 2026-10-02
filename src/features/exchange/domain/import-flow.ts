import { LIMITS } from "../../drafts/contracts/scope-document.ts";
import { checkDraft, GraphError, type Draft } from "../../drafts/domain/graph.ts";
import type { FlowFileV1 } from "../contracts/flow-file.ts";
import type { ImportMapping } from "../contracts/import.ts";

/** Appends one parsed native flow as an independent, unapproved copy. */
export function appendImportedFlow(
  saved: Draft,
  file: FlowFileV1,
  positions: NonNullable<FlowFileV1["positions"]>,
  newId: () => string,
): { draft: Draft; mapping: ImportMapping } {
  if (
    Object.keys(saved.document.flows).length >= LIMITS.flows
    || Object.keys(saved.document.nodes).length + file.nodes.length > LIMITS.nodes
    || Object.keys(saved.document.edges).length + file.edges.length > LIMITS.edges
  ) throw new GraphError("LIMIT_EXCEEDED");

  const draft = structuredClone(saved);
  const used = new Set([
    ...Object.keys(draft.document.flows),
    ...Object.keys(draft.document.nodes),
    ...Object.keys(draft.document.edges),
    ...draft.document.retiredEntityIds,
  ]);
  const allocate = () => {
    const value = newId();
    if (used.has(value)) throw new Error("ID_COLLISION");
    used.add(value);
    return value;
  };

  const flowId = allocate();
  const nodes = Object.fromEntries(file.nodes.map((node) => [node.id, allocate()]));
  const edges = Object.fromEntries(file.edges.map((edge) => [edge.id, allocate()]));
  const mapping = { flowId, nodes, edges };
  const filePositions = new Map(positions.map((position) => [position.nodeId, position]));

  draft.document.flows[flowId] = {
    id: flowId, version: 1, behaviourVersion: 1, title: file.flow.title, purpose: file.flow.purpose,
    classification: file.flow.classification, inclusion: "UNDECIDED", confirmation: null, verificationMethod: null,
  };
  draft.layout.directions[flowId] = file.flow.direction;
  for (const node of file.nodes) {
    const nodeId = nodes[node.id]!;
    const position = filePositions.get(node.id)!;
    draft.document.nodes[nodeId] = {
      id: nodeId, flowId, version: 1, behaviourVersion: 1, kind: node.kind, label: node.label, description: node.description,
      actorLabel: node.actorLabel ?? "", origin: "IMPORTED", sourceRefs: [], assumptionNotes: node.assumptionNotes,
    };
    draft.layout.positions[nodeId] = { x: position.x, y: position.y, version: 1 };
  }
  for (const edge of file.edges) {
    const edgeId = edges[edge.id]!;
    draft.document.edges[edgeId] = {
      id: edgeId, flowId, version: 1, fromId: nodes[edge.fromId]!, toId: nodes[edge.toId]!,
      condition: edge.condition ?? "", origin: "IMPORTED", sourceRefs: [],
    };
  }
  for (const sides of file.edgeSides ?? []) draft.layout.edgeSides[edges[sides.edgeId]!] = { from: sides.from, to: sides.to };

  checkDraft(draft);
  return { draft, mapping };
}
