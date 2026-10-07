import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandResult, parseGraphCommand } from "../src/features/drafts/contracts/commands.ts";

const flowId = "00000000-0000-4000-8000-000000000001";
const nodeId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";
const invalid = (raw: unknown) => assert.throws(() => parseGraphCommand(raw), /INVALID_INPUT/);
const generatedId = (index: number) => "00000000-0000-4000-8000-" + String(index).padStart(12, "0");

test("each command family parses to exactly the fields it names", () => {
  const commands = [
    { commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: 1, payload: { title: "Payments", purpose: "Take payment", classification: "BUSINESS_PROCESS", inclusion: "INCLUDED" } },
    { commandSchemaVersion: 1, command: "UPDATE_FLOW", expectedEntityVersion: 2, payload: { flowId, title: "Payments" } },
    { commandSchemaVersion: 1, command: "DUPLICATE_FLOW", expectedDocumentRevision: 3, payload: { flowId } },
    { commandSchemaVersion: 1, command: "DELETE_FLOW", expectedDocumentRevision: 4, payload: { flowId, removeNodeIds: [nodeId], removeEdgeIds: [otherId] } },
    { commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 5, payload: { flowId, kind: "DECISION", label: "Paid?", description: "", actorLabel: "Cashier" } },
    { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 6, payload: { nodeId, label: "Confirm appointment" } },
    { commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: 7, payload: { flowId, nodeIds: [nodeId], removeEdgeIds: [otherId] } },
    { commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: 8, payload: { flowId, fromId: nodeId, toId: otherId, condition: "Payment succeeds" } },
    { commandSchemaVersion: 1, command: "UPDATE_EDGE", expectedEntityVersion: 9, payload: { edgeId: otherId, condition: "Payment succeeds" } },
    { commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: 10, payload: { edgeId: otherId, fromId: flowId, toId: nodeId } },
    { commandSchemaVersion: 1, command: "DELETE_EDGE", expectedDocumentRevision: 11, payload: { edgeId: otherId } },
  ];
  for (const command of commands) assert.deepEqual(parseGraphCommand(command), command);
});

test("ADD_EDGE and RECONNECT_EDGE accept optional sides, both or neither, and reject an unknown side", () => {
  const add = { commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: 1, payload: { flowId, fromId: nodeId, toId: otherId, condition: "", fromSide: "right", toSide: "left" } };
  assert.deepEqual(parseGraphCommand(add), add);
  const reconnect = { commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: 1, payload: { edgeId: otherId, fromId: flowId, toId: nodeId, fromSide: "top", toSide: "bottom" } };
  assert.deepEqual(parseGraphCommand(reconnect), reconnect);
  invalid({ ...add, payload: { ...add.payload, fromSide: "up" } });
  invalid({ ...add, payload: { flowId, fromId: nodeId, toId: otherId, condition: "", fromSide: "right" } });
  invalid({ ...add, payload: { flowId, fromId: nodeId, toId: otherId, condition: "", toSide: "left" } });
  invalid({ ...reconnect, payload: { edgeId: otherId, fromId: flowId, toId: nodeId, toSide: "bottom" } });
});

test("ADD_NODE and UPDATE_NODE accept the DATA_STORE kind and still reject an unknown one", () => {
  const add = { commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 1, payload: { flowId, kind: "DATA_STORE", label: "Orders table", description: "", actorLabel: "" } };
  assert.deepEqual(parseGraphCommand(add), add);
  const update = { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId, kind: "DATA_STORE" } };
  assert.deepEqual(parseGraphCommand(update), update);
  invalid({ ...add, payload: { ...add.payload, kind: "TABLE" } });
  invalid({ ...update, payload: { ...update.payload, kind: "TABLE" } });
});

test("guards are required and belong to the command family", () => {
  invalid({ commandSchemaVersion: 1, command: "ADD_NODE", payload: { flowId, kind: "ACTION", label: "Pay", description: "", actorLabel: "" } });
  invalid({ commandSchemaVersion: 1, command: "ADD_NODE", expectedEntityVersion: 1, payload: { flowId, kind: "ACTION", label: "Pay", description: "", actorLabel: "" } });
  invalid({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedDocumentRevision: 1, payload: { nodeId, label: "Pay" } });
  invalid({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 0, payload: { nodeId, label: "Pay" } });
});

test("strict payloads: unknown fields, empty updates, forged counters and other schema versions fail", () => {
  invalid({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId } });
  invalid({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId, label: "Pay", version: 9 } });
  invalid({ commandSchemaVersion: 1, command: "UPDATE_FLOW", expectedEntityVersion: 1, payload: { flowId, confirmation: null } });
  invalid({ commandSchemaVersion: 2, command: "DELETE_EDGE", expectedDocumentRevision: 1, payload: { edgeId: nodeId } });
  invalid({ commandSchemaVersion: 1, command: "REPLACE_DOCUMENT", expectedDocumentRevision: 1, payload: {} });
  invalid({ commandSchemaVersion: 1, command: "DELETE_EDGE", expectedDocumentRevision: 1, payload: { edgeId: nodeId }, extra: 1 });
});

test("ids are lowercase UUIDs; id lists are distinct and bounded", () => {
  invalid({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: "00000000-0000-4000-8000-0000000000AB", label: "Pay" } });
  invalid({ commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: 1, payload: { flowId, nodeIds: [], removeEdgeIds: [] } });
  invalid({ commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: 1, payload: { flowId, nodeIds: [nodeId, nodeId], removeEdgeIds: [] } });
  const many = Array.from({ length: 21 }, (_, index) => `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`);
  invalid({ commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: 1, payload: { flowId, nodeIds: many, removeEdgeIds: [] } });
});

test("text limits count code points, and labels and titles cannot be blank", () => {
  const add = (label: string) => ({ commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 1, payload: { flowId, kind: "ACTION", label, description: "", actorLabel: "" } });
  assert.equal(parseGraphCommand(add("ệ".repeat(160))).command, "ADD_NODE");
  assert.equal(parseGraphCommand(add(String.fromCodePoint(0x1f600).repeat(160))).command, "ADD_NODE");
  invalid(add("x".repeat(161)));
  invalid(add(" \n "));
  invalid({ commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: 1, payload: { flowId, fromId: nodeId, toId: otherId, condition: "c".repeat(241) } });
  invalid({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId, assumptionNotes: Array.from({ length: 21 }, () => "note") } });
});

test("a stored result replays only when it has the result shape", () => {
  const result = { draftId: flowId, documentRevision: 2, layoutRevision: 2, eventSequence: 5, createdIds: [nodeId], versions: { [flowId]: 3 }, retiredIds: [] };
  assert.deepEqual(parseCommandResult(result), result);
  assert.throws(() => parseCommandResult({ ...result, documentJson: {} }), /INVALID_INPUT/);
  assert.throws(() => parseCommandResult({ ...result, versions: { [flowId]: 0 } }), /INVALID_INPUT/);
});

test("a stored result rejects more versions than active records", () => {
  // 5 flows + 200 steps + 400 connections + 150 requirements + 400 trace links.
  const versions = Object.fromEntries(Array.from({ length: 1155 }, (_, index) => [generatedId(index), 1]));
  const result = { draftId: flowId, documentRevision: 1, layoutRevision: 1, eventSequence: 0, createdIds: [], versions, retiredIds: [] };
  assert.deepEqual(parseCommandResult(result), result);
  assert.throws(() => parseCommandResult({ ...result, versions: { ...versions, [generatedId(1155)]: 1 } }), /INVALID_INPUT/);
});

test("a stored result rejects values larger than the safe receipt limit", () => {
  const ids = Array.from({ length: 605 }, (_, index) => generatedId(index));
  const versions = Object.fromEntries(ids.map((entry) => [entry, 1]));
  assert.throws(() => parseCommandResult({ draftId: flowId, documentRevision: 1, layoutRevision: 1, eventSequence: 0, createdIds: ids, versions, retiredIds: ids }), /INVALID_INPUT/);
});

test("text rejects a null character before a command reaches persistence", () => {
  invalid({ commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 1, payload: { flowId, kind: "ACTION", label: "Cannot\u0000store", description: "", actorLabel: "" } });
});
