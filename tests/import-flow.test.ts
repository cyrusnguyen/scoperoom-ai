import assert from "node:assert/strict";
import test from "node:test";
import type { FlowFileV1 } from "../src/features/exchange/contracts/flow-file.ts";
import { emptyDraft, LIMITS, parseDraftPair } from "../src/features/drafts/contracts/scope-document.ts";
import { GraphError, type Draft } from "../src/features/drafts/domain/graph.ts";
import { largeDraft } from "./support/large-draft.ts";
import { appendImportedFlow } from "../src/features/exchange/domain/import-flow.ts";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

function ids(start = 1) {
  let next = start;
  return () => id(next++);
}

function savedDraft(): Draft {
  const { document, layout } = emptyDraft();
  const flowId = id(100);
  const nodeId = id(101);
  document.flows[flowId] = {
    id: flowId, version: 3, behaviourVersion: 3, title: "Saved", purpose: "Already here",
    classification: "USER_JOURNEY", inclusion: "INCLUDED", confirmation: null, verificationMethod: null,
  };
  document.nodes[nodeId] = {
    id: nodeId, flowId, version: 2, behaviourVersion: 2, kind: "ACTION", label: "Existing", description: "",
    actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [],
  };
  layout.directions[flowId] = "TB";
  layout.positions[nodeId] = { x: 25, y: 50, version: 7 };
  return parseDraftPair(document, layout);
}

function file({ incomplete = false }: { incomplete?: boolean } = {}): FlowFileV1 {
  const nodes = [
    { id: "n1", kind: "ACTION" as const, label: "Choose", description: "Select an option", actorLabel: null, assumptionNotes: ["Assume access"] },
    { id: "n2", kind: "OUTCOME" as const, label: "Done", description: "", actorLabel: "Customer", assumptionNotes: [] },
  ];
  return {
    format: "scoperoom-flow", formatVersion: 1, exportedAt: "2026-10-01T00:00:00Z", producerVersion: "1.6",
    flow: { title: "Imported", purpose: "New copy", classification: "BUSINESS_PROCESS", direction: "LR" },
    nodes: incomplete ? nodes.slice(0, 1) : nodes,
    edges: incomplete ? [] : [{ id: "e1", fromId: "n1", toId: "n2", condition: null }],
    positions: incomplete ? [{ nodeId: "n1", x: -10, y: 20 }] : [{ nodeId: "n1", x: -10, y: 20 }, { nodeId: "n2", x: 300, y: 20 }],
    edgeSides: incomplete ? [] : [{ edgeId: "e1", from: "right", to: "left" }],
    origin: { kind: "SNAPSHOT", documentRevision: 4, layoutRevision: 6, sourceInclusion: "INCLUDED" },
    viewport: { x: 1, y: 2, zoom: 3 }, linkHints: [{ nodeId: "n1", requirementId: "REQ-1", requirementTitle: "Ignored" }],
  };
}

test("append_resets_trust_and_preserves_existing_pair", () => {
  const saved = savedDraft();
  const before = structuredClone(saved);
  const imported = file();

  const result = appendImportedFlow(saved, imported, imported.positions!, ids());

  const oldNodeId = id(101);
  assert.deepEqual(result.draft.document.flows[id(100)], before.document.flows[id(100)]);
  assert.deepEqual(result.draft.document.nodes[oldNodeId], before.document.nodes[oldNodeId]);
  assert.deepEqual(result.draft.layout.positions[oldNodeId], before.layout.positions[oldNodeId]);
  assert.equal(result.draft.document.flows[result.mapping.flowId]!.inclusion, "UNDECIDED");
  assert.equal(result.draft.document.nodes[result.mapping.nodes.n1!]!.origin, "IMPORTED");
  assert.deepEqual(result.draft.document.nodes[result.mapping.nodes.n1!]!.sourceRefs, []);
  assert.equal(result.draft.document.nodes[result.mapping.nodes.n1!]!.actorLabel, "");
  assert.equal(result.draft.document.edges[result.mapping.edges.e1!]!.condition, "");
});

test("maps_all_endpoints_positions_and_sides", () => {
  const imported = file();

  const result = appendImportedFlow(savedDraft(), imported, imported.positions!, ids());

  assert.deepEqual(result.mapping, { flowId: id(1), nodes: { n1: id(2), n2: id(3) }, edges: { e1: id(4) } });
  assert.deepEqual(result.draft.document.edges[id(4)], {
    id: id(4), flowId: id(1), version: 1, fromId: id(2), toId: id(3), condition: "", origin: "IMPORTED", sourceRefs: [],
  });
  assert.deepEqual(result.draft.layout.positions[id(2)], { x: -10, y: 20, version: 1 });
  assert.deepEqual(result.draft.layout.positions[id(3)], { x: 300, y: 20, version: 1 });
  assert.equal(result.draft.layout.directions[id(1)], "LR");
  assert.deepEqual(result.draft.layout.edgeSides[id(4)], { from: "right", to: "left" });
});

test("rejects_capacity_and_id_collision", () => {
  const atCapacity = savedDraft();
  for (let index = 0; index < LIMITS.flows - 1; index += 1) {
    const flowId = id(200 + index);
    atCapacity.document.flows[flowId] = {
      id: flowId, version: 1, behaviourVersion: 1, title: `Flow ${index}`, purpose: "",
      classification: "USER_JOURNEY", inclusion: "UNDECIDED", confirmation: null, verificationMethod: null,
    };
    atCapacity.layout.directions[flowId] = "TB";
  }
  const imported = file();
  assert.throws(() => appendImportedFlow(atCapacity, imported, imported.positions!, ids()), (error: unknown) => error instanceof GraphError && error.code === "LIMIT_EXCEEDED");

  const colliding = savedDraft();
  colliding.document.retiredEntityIds = [id(1)];
  const before = structuredClone(colliding);
  assert.throws(() => appendImportedFlow(colliding, imported, imported.positions!, ids()), /ID_COLLISION/);
  assert.deepEqual(colliding, before);
});

test("accepts_peer_edits_without_revision_guard", () => {
  const saved = savedDraft();
  const oldNodeId = id(101);
  saved.document.nodes[oldNodeId] = { ...saved.document.nodes[oldNodeId]!, label: "Peer rename" };
  saved.layout.positions[oldNodeId] = { x: 75, y: 125, version: 8 };
  const imported = file({ incomplete: true });

  const result = appendImportedFlow(saved, imported, imported.positions!, ids());

  assert.equal(result.draft.document.nodes[oldNodeId]!.label, "Peer rename");
  assert.deepEqual(result.draft.layout.positions[oldNodeId], { x: 75, y: 125, version: 8 });
  assert.equal(result.draft.document.nodes[result.mapping.nodes.n1!]!.kind, "ACTION");
  assert.equal(Object.keys(result.mapping.edges).length, 0);
});

test("rejects_oversized_result", () => {
  const source = largeDraft();
  const removedFlowId = Object.keys(source.document.flows).at(-1)!;
  const document = structuredClone(source.document);
  const layout = structuredClone(source.layout);
  delete document.flows[removedFlowId];
  delete layout.directions[removedFlowId];
  for (const node of Object.values(document.nodes)) if (node.flowId === removedFlowId) {
    delete document.nodes[node.id];
    delete layout.positions[node.id];
  }
  for (const edge of Object.values(document.edges)) if (edge.flowId === removedFlowId) delete document.edges[edge.id];
  const saved = parseDraftPair(document, layout);
  const nodes = Array.from({ length: 40 }, (_, index) => ({
    id: `n${index}`, kind: "ACTION" as const, label: "Long", description: "x".repeat(LIMITS.longText), actorLabel: null,
    assumptionNotes: Array.from({ length: LIMITS.notes }, () => "x".repeat(LIMITS.note)),
  }));
  const imported: FlowFileV1 = {
    ...file({ incomplete: true }), nodes, edges: [], positions: nodes.map((node, index) => ({ nodeId: node.id, x: index, y: index })), edgeSides: [],
  };

  assert.throws(() => appendImportedFlow(saved, imported, imported.positions!, ids(10_000)), (error: unknown) => error instanceof GraphError && error.code === "LIMIT_EXCEEDED");
});
