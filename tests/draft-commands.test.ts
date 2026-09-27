import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandResult, parseGraphCommand } from "../src/features/drafts/contracts/commands.ts";

const flowId = "00000000-0000-4000-8000-000000000001";
const nodeId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";
const invalid = (raw: unknown) => assert.throws(() => parseGraphCommand(raw), /INVALID_INPUT/);

test("each command family parses to exactly the fields it names", () => {
  assert.deepEqual(parseGraphCommand({ commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 3, payload: { flowId, kind: "DECISION", label: "Paid?", description: "", actorLabel: "Cashier" } }), {
    commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: 3, payload: { flowId, kind: "DECISION", label: "Paid?", description: "", actorLabel: "Cashier" },
  });
  assert.deepEqual(parseGraphCommand({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 4, payload: { nodeId, label: "Confirm appointment" } }), {
    commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 4, payload: { nodeId, label: "Confirm appointment" },
  });
  const deleted = parseGraphCommand({ commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: 2, payload: { flowId, nodeIds: [nodeId], removeEdgeIds: [] } });
  assert.equal(deleted.command, "DELETE_NODES");
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
