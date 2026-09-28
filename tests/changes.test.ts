import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CHANGE_COMMANDS, MAX_CHANGE_MOVES, parseChanges, parseChangesResult, type Changes } from "../src/features/drafts/contracts/changes.ts";
import { emptyDraft } from "../src/features/drafts/contracts/scope-document.ts";
import { applyChanges } from "../src/features/drafts/domain/changes.ts";
import { GraphError } from "../src/features/drafts/domain/graph.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const invalid = (raw: unknown) => assert.throws(() => parseChanges(raw), /INVALID_INPUT/);
const refused = (code: string, details: Record<string, unknown>) => (error: unknown) =>
  error instanceof GraphError && error.code === code && Object.entries(details).every(([key, value]) => error.details?.[key] === value);

const createFlow = (expectedDocumentRevision: number, proposedIds?: string[]) => ({
  commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision, payload: { title: "Flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" },
  ...(proposedIds ? { proposedIds } : {}),
});
const addNode = (expectedDocumentRevision: number, flowId: string, proposedIds: string[], kind = "ACTION") => ({
  commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision, payload: { flowId, kind, label: "Step", description: "", actorLabel: "" }, proposedIds,
});
const addEdge = (expectedDocumentRevision: number, flowId: string, fromId: string, toId: string, proposedIds: string[]) => ({
  commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision, payload: { flowId, fromId, toId, condition: "" }, proposedIds,
});
const updateNode = (expectedEntityVersion: number, nodeId: string, label: string) => ({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion, payload: { nodeId, label } });
const move = (flowId: string, nodeId: string, expectedPositionVersion: number, x: number, y: number) => ({ flowId, items: [{ nodeId, expectedPositionVersion, x, y }] });

const [flowId, start, next, edgeId] = [id(1), id(2), id(3), id(4)];
/** CREATE_FLOW + ADD_NODE×2 + ADD_EDGE + UPDATE_NODE on the created step, then a move of that step, against an empty draft at revision 1. */
const batch = (): Changes => parseChanges({
  commands: [createFlow(1, [flowId]), addNode(2, flowId, [start], "START"), addNode(3, flowId, [next]), addEdge(4, flowId, start, next, [edgeId]), updateNode(1, next, "Renamed")],
  moves: [move(flowId, next, 1, 400, 300)],
});

test("a batch parses commands with their proposed ids and moves grouped by flow", () => {
  const changes = batch();
  assert.equal(changes.commands.length, 5);
  assert.deepEqual(changes.commands[0]!.proposedIds, [flowId]);
  assert.deepEqual(changes.commands[4]!.proposedIds, [], "proposedIds is optional");
  assert.equal(changes.commands[4]!.command.command, "UPDATE_NODE");
  assert.deepEqual(changes.moves, [{ flowId, items: [{ nodeId: next, expectedPositionVersion: 1, x: 400, y: 300 }] }]);
  assert.deepEqual(parseChanges({ commands: [], moves: [move(flowId, next, 1, 0, 0)] }).commands, []);
});

test("a batch refuses empty, oversized, duplicated or malformed input", () => {
  invalid({ commands: [], moves: [] });
  invalid({ commands: [createFlow(1)] });
  invalid({ commands: [createFlow(1)], moves: [], extra: 1 });
  invalid({ commands: Array.from({ length: MAX_CHANGE_COMMANDS + 1 }, () => createFlow(1)), moves: [] });
  invalid({ commands: [], moves: [{ flowId, items: Array.from({ length: MAX_CHANGE_MOVES + 1 }, (_, n) => ({ nodeId: id(100 + n), expectedPositionVersion: 1, x: 0, y: 0 })) }] });
  invalid({ commands: [], moves: [move(flowId, next, 1, 0, 0), move(id(9), next, 1, 5, 5)] }); // one node, two moves
  invalid({ commands: [], moves: [move(flowId, next, 1, 0, 0), move(flowId, start, 1, 5, 5)] }); // one flow, two groups
  invalid({ commands: [], moves: [{ flowId, items: [] }] });
  invalid({ commands: [createFlow(1, ["not-a-uuid"])], moves: [] });
  invalid({ commands: [createFlow(1, [flowId, flowId])], moves: [] });
  invalid({ commands: [{ ...createFlow(1), key: id(5) }], moves: [] });
  // 200 moves across groups is the limit.
  const half = (flow: string, offset: number) => ({ flowId: flow, items: Array.from({ length: MAX_CHANGE_MOVES / 2 }, (_, n) => ({ nodeId: id(offset + n), expectedPositionVersion: 1, x: 0, y: 0 })) });
  assert.equal(parseChanges({ commands: [], moves: [half(flowId, 100), half(id(9), 400)] }).moves.length, 2);
});

test("a batch applies in order with each command's own guard, the proposed ids and moves after commands", () => {
  const applied = applyChanges(emptyDraft(), 1, batch());
  assert.deepEqual(applied.createdIds, [flowId, start, next, edgeId]);
  assert.equal(applied.documentRevision, 6, "one revision per effective command");
  assert.equal(applied.layoutChanged, true);
  assert.deepEqual(Object.keys(applied.document.nodes).sort(), [start, next]);
  assert.equal(applied.document.nodes[next]!.label, "Renamed");
  assert.equal(applied.document.edges[edgeId]!.fromId, start);
  assert.deepEqual(applied.positions, { [next]: { x: 400, y: 300, version: 2 } }, "a created step is at position version 1 before its move");
  assert.deepEqual(applied.layout.positions[next], { x: 400, y: 300, version: 2 });
  assert.equal(applied.versions[next], 2);
  assert.equal(applied.versions[flowId], applied.document.flows[flowId]!.version);
  assert.deepEqual(applied.saved.map((entry) => [entry.applied.createdIds.length, entry.documentRevision]), [[1, 2], [1, 3], [1, 4], [1, 5], [0, 6]]);
  assert.deepEqual(applied.moved, [{ flowId, positions: { [next]: { x: 400, y: 300, version: 2 } } }]);
});

test("no-op commands and unmoved steps keep every counter", () => {
  const base = applyChanges(emptyDraft(), 1, parseChanges({ commands: [createFlow(1, [flowId]), addNode(2, flowId, [start], "START")], moves: [] }));
  const again = applyChanges(base, 3, parseChanges({ commands: [updateNode(1, start, "Step")], moves: [move(flowId, start, 1, 0, 0)] }));
  assert.equal(again.documentRevision, 3);
  assert.equal(again.layoutChanged, false);
  assert.deepEqual([again.saved, again.moved, again.positions, again.versions], [[], [], {}, {}]);
});

test("the first stale guard refuses the whole batch and names its index", () => {
  const stale = parseChanges({ commands: [createFlow(1, [flowId]), addNode(1, flowId, [start])], moves: [] });
  assert.throws(() => applyChanges(emptyDraft(), 1, stale), refused("STALE_DOCUMENT_REVISION", { part: "commands", index: 1, documentRevision: 2 }));
  const entity = parseChanges({ commands: [createFlow(1, [flowId]), addNode(2, flowId, [start]), updateNode(2, start, "Late")], moves: [] });
  assert.throws(() => applyChanges(emptyDraft(), 1, entity), refused("STALE_ENTITY_VERSION", { part: "commands", index: 2, entityId: start, currentVersion: 1 }));
  const moved = parseChanges({ commands: [createFlow(1, [flowId]), addNode(2, flowId, [start])], moves: [move(flowId, start, 2, 9, 9)] });
  assert.throws(() => applyChanges(emptyDraft(), 1, moved), refused("POSITION_CONFLICT", { part: "moves", index: 0, nodeId: start, currentVersion: 1 }));
});

test("proposed ids must be unused, unique in the batch and exactly as many as the command creates", () => {
  const base = applyChanges(emptyDraft(), 1, parseChanges({ commands: [createFlow(1, [flowId])], moves: [] }));
  const cases: Array<[string, unknown[]]> = [
    ["missing", [addNode(2, flowId, [])]],
    ["too many", [addNode(2, flowId, [start, next])]],
    ["on an update", [{ commandSchemaVersion: 1, command: "UPDATE_FLOW", expectedEntityVersion: 1, payload: { flowId, title: "New" }, proposedIds: [start] }]],
    ["already in the draft", [addNode(2, flowId, [flowId])]],
    ["reused in the batch", [addNode(2, flowId, [start]), addNode(3, flowId, [start])]],
  ];
  for (const [name, commands] of cases) {
    const index = commands.length - 1;
    assert.throws(() => applyChanges(base, 2, parseChanges({ commands, moves: [] })), refused("INVALID_INPUT", { part: "commands", index }), name);
  }
  // A retired id is used too.
  const deleted = applyChanges(base, 2, parseChanges({ commands: [addNode(2, flowId, [start]), { commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: 3, payload: { flowId, nodeIds: [start], removeEdgeIds: [] } }], moves: [] }));
  assert.throws(() => applyChanges(deleted, 4, parseChanges({ commands: [addNode(4, flowId, [start])], moves: [] })), refused("INVALID_INPUT", { index: 0 }));
});

test("a stored batch result round-trips and a malformed one is refused", () => {
  const result = { draftId: id(7), documentRevision: 6, layoutRevision: 4, eventSequence: 12, createdIds: [flowId, start], versions: { [flowId]: 3 }, positions: { [start]: { x: 1, y: 2, version: 2 } } };
  assert.deepEqual(parseChangesResult(result), result);
  assert.throws(() => parseChangesResult({ ...result, retiredIds: [] }), /INVALID_INPUT/);
  assert.throws(() => parseChangesResult({ ...result, eventSequence: -1 }), /INVALID_INPUT/);
});
