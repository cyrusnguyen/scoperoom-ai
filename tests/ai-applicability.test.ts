import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { emptyDraft } from "../src/features/drafts/contracts/scope-document.ts";
import { captureInput, canonicalJson, sha256 } from "../src/features/proposals/domain/capture.ts";
import { resultFixture } from "./support/ai-results.ts";
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

test("stored source identities and text stay strict even when their capture hash matches", () => {
  const captured = resultFixture().generate();
  // An explicit older version and an untrimmed historical title remain exact captured evidence.
  captured.sources[0]!.expectedCurrentVersionId = randomUUID();
  captured.sources[0]!.title = "  Historical notes  ";
  const row: ApplicabilityRow = { ...base, draft_id: captured.draftId, expected_document_revision: captured.documentRevision,
    current_revision: captured.documentRevision, capture: captured, capture_hash: sha256(canonicalJson(captured)) };
  const context = { ...project, currentDraftId: captured.draftId };
  assert.equal(inspectRun(row, context).applicability, "APPLICABLE");
  assert.deepEqual(inspectRun(row, context).capture, captured);
  for (const change of [
    { sourceId: "not-a-uuid" }, { sourceVersionId: "not-a-uuid" }, { expectedCurrentVersionId: "not-a-uuid" },
    { title: { unexpected: "value" } }, { title: "" }, { title: "x".repeat(121) }, { text: "" },
  ]) {
    const malformed = structuredClone(captured);
    Object.assign(malformed.sources[0]!, change);
    // Preserve all derived source statistics as well as the outer hash, so shape alone must refuse it.
    const source = malformed.sources[0]!;
    source.contentHash = sha256(source.text); source.codePointCount = [...source.text].length; source.utf8ByteCount = Buffer.byteLength(source.text);
    const view = inspectRun({ ...row, capture: malformed, capture_hash: sha256(canonicalJson(malformed)) }, context);
    assert.equal(view.capture, null, JSON.stringify(change)); assert.equal(view.result, null); assert.equal(view.diff, null);
    assert.equal(view.applicability, "UNAVAILABLE"); assert.deepEqual(view.applicabilityReasons, ["INVALID_CAPTURE"]);
  }
});
