import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { emptyDraft } from "../src/features/drafts/contracts/scope-document.ts";
import { captureInput, canonicalJson, sha256 } from "../src/features/proposals/domain/capture.ts";
import { inspectRun, type ApplicabilityRow } from "../src/features/proposals/server/applicability.ts";

const draftId = randomUUID();
const { capture, hash } = captureInput({ projectId: randomUUID(), draftId, documentRevision: 1, parentSnapshotId: null, document: emptyDraft().document, sources: [], model: "test-model" }, { key: randomUUID(), taskType: "PROPOSE_FLOW", prompt: "Generate flow", draftId, expectedDocumentRevision: 1, expectedParentSnapshotId: null, context: { selection: null, sources: [] } });
const result = { schemaVersion: 1 as const, kind: "proposal" as const, operations: [{ id: "flow", dependsOn: [], edit: { command: "CREATE_FLOW" as const, payload: { ref: "flow", title: "Checkout", purpose: "", classification: "USER_JOURNEY" as const, inclusion: "UNDECIDED" as const } } }], assumptions: [], citations: [] };
const base: ApplicabilityRow = { id: randomUUID(), task_type: "PROPOSE_FLOW", state: "SUCCEEDED", disposition: "AVAILABLE", cancel_requested_at: null, draft_id: draftId, expected_document_revision: 1, parent_snapshot_id: null, terminal_at: new Date(), capture, capture_hash: hash, result, result_hash: sha256(canonicalJson(result)), current_revision: 1, body_expired: false, sources_changed: false };
const project = { status: "ACTIVE" as const, currentDraftId: draftId, approvedSnapshotId: null };

test("hash-consistent malformed historical capture arrays and exact limits shape fail closed", () => {
  for (const malformed of [
    { ...capture, graph: { ...capture.graph, flows: { length: 0 } } },
    { ...capture, graph: { ...capture.graph, nodes: { length: 0 } } },
    { ...capture, graph: { ...capture.graph, edges: { length: 0 } } },
    { ...capture, limits: { resultBytes: 131072, operations: 100, maxGraphNodes: 20, maxGraphEdges: 40, promptCodePoints: 8000, applicableResults: 10 } },
  ]) {
    const stored = { ...malformed, graphHash: sha256(canonicalJson(malformed.graph)) };
    const view = inspectRun({ ...base, capture: stored as typeof capture, capture_hash: sha256(canonicalJson(stored)) }, project);
    assert.equal(view.capture, null); assert.equal(view.result, null); assert.equal(view.diff, null);
    assert.equal(view.applicability, "UNAVAILABLE"); assert.deepEqual(view.applicabilityReasons, ["INVALID_CAPTURE"]);
  }
});
