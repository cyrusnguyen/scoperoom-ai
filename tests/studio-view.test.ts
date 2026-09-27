import assert from "node:assert/strict";
import test from "node:test";
import { emptyDraft, type NodeRecord, type ScopeDocument } from "../src/features/drafts/contracts/scope-document.ts";
import type { DraftLayout } from "../src/features/drafts/contracts/draft-layout.ts";
import { graphWarnings } from "../src/features/drafts/domain/warnings.ts";
import { fieldErrors, nodeFields, updateCommand } from "../src/features/studio/ui/fields.ts";
import { connectionsInOrder, matchesStep, stepName, stepsInOrder } from "../src/features/studio/ui/graph-view.ts";
import { isNewer, selectEdge, selectNodes, toggleNode } from "../src/features/studio/ui/studio-ui.ts";

const flowId = "f0000000-0000-4000-8000-000000000000";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function draft(nodes: [label: string, kind: NodeRecord["kind"], x: number, y: number][], edges: [from: number, to: number, condition?: string][] = []) {
  const { document, layout } = emptyDraft() as { document: ScopeDocument; layout: DraftLayout };
  document.flows[flowId] = { id: flowId, version: 1, behaviourVersion: 1, title: "Flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED", confirmation: null, verificationMethod: null };
  layout.directions[flowId] = "TB";
  nodes.forEach(([label, kind, x, y], index) => {
    document.nodes[id(index + 1)] = { id: id(index + 1), flowId, version: 1, behaviourVersion: 1, kind, label, description: "", actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] };
    layout.positions[id(index + 1)] = { x, y, version: 1 };
  });
  edges.forEach(([from, to, condition = ""], index) => {
    document.edges[id(100 + index)] = { id: id(100 + index), flowId, version: 1, fromId: id(from), toId: id(to), condition, origin: "HUMAN", sourceRefs: [] };
  });
  return { document, layout };
}

test("draft checks describe an incomplete flow without blocking it", () => {
  assert.deepEqual(graphWarnings(draft([]).document, flowId), []);
  const { document } = draft([["Ask", "DECISION", 0, 0], ["Yes", "ACTION", 0, 160], ["Alone", "ACTION", 200, 0]], [[1, 2]]);
  assert.deepEqual(graphWarnings(document, flowId).map((warning) => warning.code), ["NO_START", "NO_OUTCOME", "UNCONNECTED_STEP", "UNCONNECTED_STEP", "UNCONNECTED_STEP", "UNLABELLED_BRANCH"]);
  const complete = draft([["Start", "START", 0, 0], ["Done", "OUTCOME", 0, 160]], [[1, 2]]);
  assert.deepEqual(graphWarnings(complete.document, flowId), []);
});

test("draft checks warn for branches disconnected from a start", () => {
  const { document } = draft([["Start", "START", 0, 0], ["Done", "OUTCOME", 0, 160], ["First orphan", "ACTION", 200, 0], ["Second orphan", "ACTION", 200, 160]], [[1, 2], [3, 4]]);
  assert.deepEqual(graphWarnings(document, flowId), [
    { code: "UNCONNECTED_STEP", targetId: id(3) },
    { code: "UNCONNECTED_STEP", targetId: id(4) },
  ]);
});

test("the List reads top to bottom, and identical names are told apart by id", () => {
  const { document, layout } = draft([["Pay", "ACTION", 0, 320], ["Pay", "ACTION", 0, 160], ["Browse", "START", 0, 0]], [[3, 2], [2, 1]]);
  assert.deepEqual(stepsInOrder(document, layout, flowId).map((node) => node.id), [id(3), id(2), id(1)]);
  assert.equal(stepName(document, id(1)), `Pay (${id(1)})`);
  assert.equal(stepName(document, id(3)), "Browse");
  assert.equal(stepName(document, id(99)), "Removed step");
  assert.deepEqual(connectionsInOrder(document, layout, flowId).map((edge) => edge.fromId), [id(3), id(2)]);
  assert.equal(matchesStep(document.nodes[id(3)]!, "brow"), true);
  assert.equal(matchesStep(document.nodes[id(3)]!, id(3).slice(-4)), true);
  assert.equal(matchesStep(document.nodes[id(3)]!, "pay"), false);
});

test("the List uses a longer ID only when an eight-character duplicate would collide", () => {
  const samePrefix = draft([["Pay", "ACTION", 0, 0], ["Pay", "ACTION", 0, 160]]).document;
  assert.equal(stepName(samePrefix, id(1)), `Pay (${id(1)})`);
  const differentPrefix = draft([["Pay", "ACTION", 0, 0], ["Pay", "ACTION", 0, 160]]).document;
  const secondId = "a0000000-0000-4000-8000-000000000002";
  differentPrefix.nodes[secondId] = { ...differentPrefix.nodes[id(2)]!, id: secondId };
  delete differentPrefix.nodes[id(2)];
  assert.equal(stepName(differentPrefix, id(1)), "Pay (00000000)");
});

test("the List reads LR flows left to right and breaks equal positions by name", () => {
  const { document, layout } = draft([["Zebra", "ACTION", 100, 100], ["Alpha", "ACTION", 100, 100], ["Later", "ACTION", 200, 0]]);
  layout.directions[flowId] = "LR";
  assert.deepEqual(stepsInOrder(document, layout, flowId).map((node) => node.label), ["Alpha", "Zebra", "Later"]);
});

test("canvas select changes fold into one selection; edge and flow selections survive unrelated unselects", () => {
  let selection = selectNodes(null, [{ id: "a", selected: true }]);
  selection = selectNodes(selection, [{ id: "b", selected: true }]);
  assert.deepEqual(selection, { kind: "NODES", ids: ["a", "b"] });
  selection = selectNodes(selection, [{ id: "a", selected: false }, { id: "b", selected: false }, { id: "c", selected: true }]);
  assert.deepEqual(selection, { kind: "NODES", ids: ["c"] });
  assert.deepEqual(selectEdge(selectNodes(selection, [{ id: "c", selected: false }]), [{ id: "e", selected: true }]), { kind: "EDGE", id: "e" });
  assert.deepEqual(selectNodes(selectEdge(selection, [{ id: "e", selected: true }]), [{ id: "c", selected: false }]), { kind: "EDGE", id: "e" });
  assert.deepEqual(selectNodes({ kind: "FLOW", id: "f" }, [{ id: "c", selected: false }]), { kind: "FLOW", id: "f" });
  assert.equal(selectEdge({ kind: "EDGE", id: "e" }, [{ id: "e", selected: false }]), null);
  assert.deepEqual(toggleNode(toggleNode(null, "a"), "b"), { kind: "NODES", ids: ["a", "b"] });
  assert.equal(toggleNode({ kind: "NODES", ids: ["a"] }, "a"), null);
});

test("a later read wins; a late, older response for the same draft is dropped", () => {
  const view = { id: "d", status: "EDITABLE" as const, documentRevision: 4, layoutRevision: 3, ...emptyDraft() };
  assert.equal(isNewer({ ...view, documentRevision: 5 }, view), true);
  assert.equal(isNewer({ ...view, layoutRevision: 2 }, view), false);
  assert.equal(isNewer({ ...view, id: "other", documentRevision: 9 }, view), false);
});

test("inspector fields validate on Save by code points and build a guarded update", () => {
  const node = draft([["Pay", "ACTION", 0, 0]]).document.nodes[id(1)]!;
  assert.deepEqual(nodeFields(node), { label: "Pay", kind: "ACTION", actorLabel: "", description: "", assumptionNotes: "" });
  assert.deepEqual(fieldErrors("NODE", { label: " ", actorLabel: "x".repeat(101) }), { label: "Enter a name.", actorLabel: "Actor can be up to 100 characters (now 101)." });
  assert.deepEqual(fieldErrors("NODE", { label: "\u{1ec7}".repeat(160) }), {});
  assert.deepEqual(fieldErrors("NODE", { label: "🚀".repeat(160) }), {});
  assert.deepEqual(fieldErrors("NODE", { label: "bad\u0000text", description: "bad\ud800text" }), { label: "Enter valid text.", description: "Enter valid text." });
  assert.deepEqual(fieldErrors("NODE", { assumptionNotes: Array.from({ length: 21 }, () => "note").join("\n") }), { assumptionNotes: "Keep it to 20 assumptions." });
  assert.deepEqual(updateCommand("NODE", id(1), 3, { label: "Pay now", assumptionNotes: " one \n\n two " }), {
    commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 3, payload: { nodeId: id(1), label: "Pay now", assumptionNotes: ["one", "two"] },
  });
  assert.deepEqual(updateCommand("EDGE", id(9), 2, { condition: "Paid" }), { commandSchemaVersion: 1, command: "UPDATE_EDGE", expectedEntityVersion: 2, payload: { edgeId: id(9), condition: "Paid" } });
  assert.throws(() => updateCommand("EDGE", id(9), 2, {}), /Missing edge condition/);
});
