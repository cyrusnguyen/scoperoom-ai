import { emptyDraft, type DraftView, type EdgeRecord, type NodeRecord } from "../../src/features/drafts/contracts/scope-document.ts";
import type { CandidateInput } from "../../src/features/reviews/contracts/review.ts";
import { ids, NOW, requirement } from "./scope-fixtures.ts";
export { ids, NOW, requirement } from "./scope-fixtures.ts";

export const reviewIds = {
  draft: "20000000-0000-4000-8000-000000000001", outcome: "20000000-0000-4000-8000-000000000002",
  edge: "20000000-0000-4000-8000-000000000003", action: "20000000-0000-4000-8000-000000000004",
  edge2: "20000000-0000-4000-8000-000000000005", source: "20000000-0000-4000-8000-000000000006",
};
export const stamp = () => ({ behaviourVersion: 1, actorId: ids.actor, confirmedAt: NOW });

/** Requirements can stand alone: no graph, scenario or verification text is needed. */
export function candidateFixture(): CandidateInput {
  const pair = emptyDraft();
  pair.document.requirements[ids.req] = requirement({ inclusion: "INCLUDED", confirmation: stamp() });
  const draft: DraftView = { ...pair, id: reviewIds.draft, status: "EDITABLE", documentRevision: 1, layoutRevision: 1 };
  return { draft, evidence: [], baseline: null };
}

export function addNode(draft: DraftView, nodeId: string, kind: NodeRecord["kind"]) {
  draft.document.nodes[nodeId] = { id: nodeId, flowId: ids.flow, version: 1, behaviourVersion: 1, kind, label: kind, description: "", actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] };
  draft.layout.positions[nodeId] = { x: 0, y: 0, version: 1 };
}
export function addEdge(draft: DraftView, edgeId: string, fromId: string, toId: string, condition = "") {
  const edge: EdgeRecord = { id: edgeId, flowId: ids.flow, version: 1, fromId, toId, condition, origin: "HUMAN", sourceRefs: [] };
  draft.document.edges[edgeId] = edge;
}
export function addFlow(draft: DraftView) {
  draft.document.flows[ids.flow] = { id: ids.flow, version: 1, behaviourVersion: 1, title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED", confirmation: stamp(), verificationMethod: null };
  draft.layout.directions[ids.flow] = "TB";
  addNode(draft, ids.node, "START");
  addNode(draft, reviewIds.outcome, "OUTCOME");
  addEdge(draft, reviewIds.edge, ids.node, reviewIds.outcome);
}

export function publishedFixture(): import("../../src/features/reviews/contracts/review.ts").PublishedSnapshot {
  const { draft } = candidateFixture();
  const snapshot = {
    canonicalizationVersion: 1 as const, schemaVersion: 3 as const,
    projectId: "30000000-0000-4000-8000-000000000001", projectName: "Card checkout", sourceDraftId: draft.id,
    capturedDocumentRevision: 1, capturedLayoutRevision: 1, documentJson: draft.document, layoutJson: draft.layout,
    evidenceManifest: [], policySnapshot: { designatedApproverId: ids.actor, approvalPolicyVersion: 2 },
    parentSnapshotId: null, agreementIntent: "INCLUDED_SCOPE" as const, requestResolution: null,
    id: "30000000-0000-4000-8000-000000000002", contentHash: "a".repeat(64), reviewHash: "b".repeat(64), createdBy: ids.actor, createdAt: NOW,
  };
  const reviewId = "30000000-0000-4000-8000-000000000003";
  return { snapshot, reviewId, publicationSequence: 1, publishedAt: NOW, decision: {
    id: "30000000-0000-4000-8000-000000000004", projectId: snapshot.projectId, reviewId, actorId: ids.actor, actorDisplayName: "Named reviewer", actorRole: "REVIEWER",
    decision: "APPROVE", comment: null, reviewedHash: snapshot.reviewHash, createdAt: NOW,
  } };
}
