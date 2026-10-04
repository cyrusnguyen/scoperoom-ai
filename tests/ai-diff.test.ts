import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { emptyDraft, parseDraftPair, LIMITS } from "../src/features/drafts/contracts/scope-document.ts";
import { appendImportedFlow } from "../src/features/exchange/domain/import-flow.ts";
import { parseFlowFile, serializeFlowFile } from "../src/features/exchange/domain/flow-file.ts";
import { nativeFlowFile } from "../src/features/exports/domain/flow-file.ts";
import { applyChanges } from "../src/features/drafts/domain/changes.ts";
import { MAX_VERSION } from "../src/features/drafts/contracts/strict.ts";
import { applyGraphCommand, applyGraphGroup, type Draft } from "../src/features/drafts/domain/graph.ts";
import { applyProposal, proposalDiff } from "../src/features/proposals/domain/proposal-diff.ts";
import { validateResult } from "../src/features/proposals/domain/validate-result.ts";
import { goodGenerate, proposal, resultFixture } from "./support/ai-results.ts";

const f = resultFixture();
function saved(): Draft {
  const draft = emptyDraft();
  draft.document = structuredClone(f.document);
  for (const flow of Object.values(draft.document.flows)) draft.layout.directions[flow.id] = "LR";
  for (const node of Object.values(draft.document.nodes)) draft.layout.positions[node.id] = { x: 300, y: 700, version: 8 };
  draft.layout.edgeSides[f.edges.e2] = { from: "bottom", to: "left" };
  return draft;
}
const updates = () => [f.ids.b, f.ids.c].map((nodeId, index) => ({ commandSchemaVersion: 1 as const, command: "UPDATE_NODE" as const, expectedEntityVersion: 3, payload: { nodeId, label: `changed${index}` } }));

test("group defers counters: two edits at MAX-1 succeed once while manual commands still overflow", () => {
  const draft = saved();
  draft.document.flows[f.flowId]!.version = MAX_VERSION - 1;
  draft.document.flows[f.flowId]!.behaviourVersion = MAX_VERSION - 1;
  const group = applyGraphGroup(draft, 7, updates(), randomUUID);
  assert.equal(group.document.flows[f.flowId]!.version, MAX_VERSION);
  assert.equal(group.document.flows[f.flowId]!.behaviourVersion, MAX_VERSION);
  assert.equal(group.document.nodes[f.ids.b]!.version, 4);
  const first = applyGraphCommand(draft, 7, updates()[0]!, randomUUID);
  assert.throws(() => applyGraphCommand(first, 8, updates()[1]!, randomUUID), /VERSION_EXHAUSTED/);
  draft.document.flows[f.flowId]!.version = MAX_VERSION;
  assert.throws(() => applyGraphGroup(draft, 7, updates(), randomUUID), /VERSION_EXHAUSTED/);
  assert.equal(draft.document.nodes[f.ids.b]!.label, "B");
});

test("persisted Generate diff is deterministic, capture-owned, unapproved and preserves inputs", () => {
  const capture = f.generate();
  const output = goodGenerate(f.sourceVersionId);
  (output.operations[0] as { edit: { payload: { inclusion: string } } }).edit.payload.inclusion = "INCLUDED";
  const result = validateResult(capture, JSON.parse(JSON.stringify(output)));
  const original = JSON.stringify({ capture, result });
  const diff = proposalDiff(capture, result, ["op4", "op3", "op2", "op1"]);
  assert.deepEqual(diff, proposalDiff(capture, result, ["op1", "op2", "op3", "op4"]));
  assert.equal(diff.createdIds.length, 4);
  assert.equal(diff.updatedIds.length, 0);
  assert.equal(JSON.stringify({ capture, result }), original);
  const applied = applyProposal(saved(), capture, result, ["op1", "op2", "op3", "op4"], randomUUID);
  const newFlow = applied.document.flows[applied.idMap.flow1!]!;
  assert.equal(newFlow.inclusion, "UNDECIDED");
  assert.equal(newFlow.confirmation, null);
  assert.equal(newFlow.version, 1);
  assert.equal(newFlow.behaviourVersion, 1);
  assert.equal(applied.actualCommands[0]!.command, "CREATE_FLOW");
  assert.equal((applied.actualCommands[0]!.payload as { inclusion: string }).inclusion, "UNDECIDED");
  for (const ref of ["n1", "n2"]) {
    const node = applied.document.nodes[applied.idMap[ref]!]!;
    assert.equal(node.origin, "AI_SUGGESTED");
    assert.equal(node.version, 1);
    assert.deepEqual(node.sourceRefs, result.kind === "proposal" ? result.citations : []);
    assert.deepEqual(node.assumptionNotes, ["Payment is online"]);
  }
  assert.deepEqual(applied.document.nodes[f.ids.a], saved().document.nodes[f.ids.a]);
  parseDraftPair(applied.document, applied.layout);
});

test("Improve preserves latest peer moves and sides when reconnecting and untouched evidence", () => {
  const capture = f.improve();
  const result = validateResult(capture, proposal([{ id: "reconnect", dependsOn: [], edit: { command: "RECONNECT_EDGE", payload: { edgeId: f.edges.e2, fromId: f.ids.b, toId: f.ids.d } } }]));
  const draft = saved();
  const applied = applyProposal(draft, capture, result, ["reconnect"], randomUUID);
  assert.deepEqual(applied.layout, draft.layout);
  assert.deepEqual(applied.document.nodes, draft.document.nodes);
  assert.equal(applied.document.edges[f.edges.e2]!.toId, f.ids.d);
  assert.equal(applied.document.edges[f.edges.e2]!.origin, "HUMAN");
  const actual = applied.actualCommands[0]!;
  if (actual.command !== "RECONNECT_EDGE") throw new Error("fixture");
  assert.deepEqual(actual.payload.expectedSides, draft.layout.edgeSides[f.edges.e2]);
  assert.equal(actual.payload.fromSide, "bottom");
  assert.equal(actual.payload.toSide, "left");
  actual.payload.expectedSides!.from = "top";
  assert.equal(draft.layout.edgeSides[f.edges.e2]!.from, "bottom");
  assert.equal(applied.layout.edgeSides[f.edges.e2]!.from, "bottom");
  assert.deepEqual(applied.changedIds.sort(), [f.flowId, f.edges.e2].sort());
  assert.deepEqual(applied.document.edges[f.edges.e1], draft.document.edges[f.edges.e1]);
});

test("clarification has no Apply and malformed historical data fails closed", () => {
  const capture = f.generate();
  assert.throws(() => applyProposal(saved(), capture, { schemaVersion: 1, kind: "clarification", message: "Which?" }, [], randomUUID), /INVALID_RESULT/);
  assert.throws(() => proposalDiff(capture, { ...goodGenerate(f.sourceVersionId), url: "https://invalid" } as never, ["op1"]), /INVALID_RESULT/);
});

test("saved source refs permit exact structural bounds and refuse invalid ranges/keys", () => {
  const draft = saved();
  const ref = { sourceVersionId: f.sourceVersionId, startLine: 1, endLine: 2, excerpt: "line one" };
  draft.document.nodes[f.ids.b]!.sourceRefs = [ref];
  draft.document.edges[f.edges.e2]!.sourceRefs = [ref];
  assert.deepEqual(parseDraftPair(draft.document, draft.layout).document.nodes[f.ids.b]!.sourceRefs, [ref]);
  for (const invalid of [{ ...ref, startLine: 0 }, { ...ref, endLine: 0 }, { ...ref, endLine: 1.5 }, { ...ref, excerpt: "x".repeat(2001) }, { ...ref, url: "x" }]) {
    draft.document.nodes[f.ids.b]!.sourceRefs = [invalid];
    assert.throws(() => parseDraftPair(draft.document, draft.layout), /INVALID_INPUT/);
  }
  draft.document.nodes[f.ids.b]!.sourceRefs = [ref, ref];
  assert.throws(() => parseDraftPair(draft.document, draft.layout), /INVALID_INPUT/);
});

test("generated saved assumptions fail closed above the saved note bound", () => {
  assert.throws(() => validateResult(f.generate(), { ...goodGenerate(f.sourceVersionId), assumptions: ["x".repeat(LIMITS.note + 1)] }), /INVALID_RESULT/);
});

test("manual batch still increments per effective command; grouped no-op and reverted edits do not increment", () => {
  const draft = saved();
  const commands = updates();
  const batch = applyChanges(draft, 7, { commands: commands.map(command => ({ command, proposedIds: [] })), moves: [] });
  assert.equal(batch.documentRevision, 9);
  assert.equal(batch.document.flows[f.flowId]!.version, 4);
  const group = applyGraphGroup(draft, 7, commands, randomUUID);
  assert.equal(group.document.flows[f.flowId]!.version, 3);
  const noChange = applyGraphGroup(draft, 7, [{ ...commands[0]!, payload: { nodeId: f.ids.b, label: "B" } }], randomUUID);
  assert.equal(noChange.documentChanged, false);
  assert.deepEqual(noChange.versions, {});
  const reverted = applyGraphGroup(draft, 7, [commands[0]!, { ...commands[0]!, payload: { nodeId: f.ids.b, label: "B" } }], randomUUID);
  assert.equal(reverted.documentChanged, false);
  assert.deepEqual(reverted.versions, {});
});

test("native exchange excludes saved citation authority and imports a fresh unapproved copy", () => {
  const draft = saved();
  const sourceRef = { sourceVersionId: f.sourceVersionId, startLine: 1, endLine: 1, excerpt: "line one" };
  draft.document.nodes[f.ids.b]!.sourceRefs = [sourceRef];
  draft.document.edges[f.edges.e2]!.sourceRefs = [sourceRef];
  const file = nativeFlowFile({ ...draft, id: randomUUID(), status: "EDITABLE", documentRevision: 7, layoutRevision: 8 }, f.flowId, "2026-10-04T00:00:00.000Z");
  const serialized = serializeFlowFile(file);
  const text = new TextDecoder().decode(serialized);
  assert.equal(text.includes(f.sourceVersionId), false);
  assert.equal(text.includes("sourceRefs"), false);
  const parsed = parseFlowFile(serialized);
  const imported = appendImportedFlow(draft, parsed, parsed.positions!, randomUUID);
  for (const id of Object.values(imported.mapping.nodes)) {
    assert.deepEqual(imported.draft.document.nodes[id]!.sourceRefs, []);
    assert.equal(imported.draft.document.nodes[id]!.origin, "IMPORTED");
  }
  assert.deepEqual(imported.draft.document.nodes[f.ids.b], draft.document.nodes[f.ids.b]);
  assert.equal(imported.draft.document.flows[imported.mapping.flowId]!.inclusion, "UNDECIDED");
});

test("global assumptions remain attribution when Improve creates no new node", () => {
  const capture = f.improve();
  const result = validateResult(capture, proposal([{ id: "update", dependsOn: [], edit: { command: "UPDATE_NODE", payload: { nodeId: f.ids.b, label: "Updated" } } }], { assumptions: ["a".repeat(2_000)] }));
  const draft = saved();
  const applied = applyProposal(draft, capture, result, ["update"], randomUUID);
  assert.deepEqual(applied.document.nodes[f.ids.b]!.assumptionNotes, []);
  assert.deepEqual(applied.document.nodes[f.ids.c], draft.document.nodes[f.ids.c]);
});

test("deletion subset removes exactly its graph dependencies and malformed stored removals refuse", () => {
  const capture = f.improve();
  const result = validateResult(capture, proposal([
    { id: "delete", dependsOn: [], edit: { command: "DELETE_NODES", payload: { flowId: f.flowId, nodeIds: [f.ids.b], removeEdgeIds: [f.edges.e1, f.edges.e2] } } },
    { id: "update", dependsOn: [], edit: { command: "UPDATE_NODE", payload: { nodeId: f.ids.c, label: "Proposed only" } } },
  ]));
  const draft = saved();
  const applied = applyProposal(draft, capture, result, ["delete"], randomUUID);
  assert.equal(applied.document.nodes[f.ids.b], undefined);
  assert.equal(applied.document.edges[f.edges.e1], undefined);
  assert.equal(applied.document.edges[f.edges.e2], undefined);
  assert.deepEqual(applied.document.nodes[f.ids.c], draft.document.nodes[f.ids.c]);
  assert.deepEqual(applied.document.edges[f.edges.e3], draft.document.edges[f.edges.e3]);
  assert.deepEqual(applied.layout.positions[f.ids.c], draft.layout.positions[f.ids.c]);
  if (result.kind !== "proposal" || result.operations[0]!.edit.command !== "DELETE_NODES") throw new Error("fixture");
  result.operations[0]!.edit.payload.removeEdgeIds = [];
  assert.throws(() => applyProposal(draft, capture, result, ["delete"], randomUUID), /INVALID_RESULT/);
});

test("operation and local reference identity namespaces may overlap without losing UUID mappings", () => {
  const capture = f.generate();
  const output = goodGenerate(f.sourceVersionId);
  (output.operations[3] as { id: string }).id = "n1";
  const result = validateResult(capture, output);
  const applied = applyProposal(saved(), capture, result, ["op1", "op2", "op3", "n1"], randomUUID);
  assert.notEqual(applied.idMap.n1, applied.createdIdMap.n1);
  assert.ok(applied.document.nodes[applied.idMap.n1!]);
  assert.ok(applied.document.edges[applied.createdIdMap.n1!]);
});
