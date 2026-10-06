import assert from "node:assert/strict";
import test from "node:test";
import { emptyDraft, type DraftView } from "../src/features/drafts/contracts/scope-document.ts";
import type { ProjectStatusView } from "../src/features/projects/contracts/project.ts";
import type { RunView, ValidatedProposal } from "../src/features/proposals/contracts/tasks.ts";
import { projectProposalPreview, newApplyBlocker } from "../src/features/proposals/ui/preview-projection.ts";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

function fixture() {
  const firstFlow = id("1"), selected = id("2"), secondFlow = id("3"), contextual = id("4"), checkoutPeer = id("5"), savedEdge = id("6"), occupiedPreviewId = id("1");
  const draft = emptyDraft();
  draft.document.flows[firstFlow] = { id: firstFlow, version: 1, behaviourVersion: 1, title: "Checkout", purpose: "Pay", classification: "USER_JOURNEY", inclusion: "INCLUDED", confirmation: null, verificationMethod: null };
  draft.document.flows[secondFlow] = { id: secondFlow, version: 1, behaviourVersion: 1, title: "Fulfilment", purpose: "Pack", classification: "USER_JOURNEY", inclusion: "INCLUDED", confirmation: null, verificationMethod: null };
  draft.document.nodes[selected] = { id: selected, flowId: firstFlow, version: 1, behaviourVersion: 1, kind: "ACTION", label: "Pay", description: "", actorLabel: "Customer", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] };
  draft.document.nodes[checkoutPeer] = { id: checkoutPeer, flowId: firstFlow, version: 1, behaviourVersion: 1, kind: "ACTION", label: "Review order", description: "", actorLabel: "Staff", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] };
  draft.document.nodes[contextual] = { id: contextual, flowId: secondFlow, version: 1, behaviourVersion: 1, kind: "ACTION", label: "Pack order", description: "", actorLabel: "Warehouse", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] };
  draft.document.edges[savedEdge] = { id: savedEdge, flowId: firstFlow, version: 1, fromId: selected, toId: checkoutPeer, condition: "Captured order" , origin: "HUMAN", sourceRefs: [] };
  for (const nodeId of Object.keys(draft.document.nodes)) draft.layout.positions[nodeId] = { x: nodeId === contextual ? 700 : 10, y: 20, version: 1 };
  draft.layout.directions[firstFlow] = "TB";
  draft.layout.directions[secondFlow] = "LR";
  draft.layout.edgeSides[savedEdge] = { from: "right", to: "left" };
  const saved: DraftView = { id: id("9"), status: "EDITABLE", documentRevision: 4, layoutRevision: 8, ...draft };
  const result: ValidatedProposal = { schemaVersion: 1, kind: "proposal", operations: [
    { id: "retry", dependsOn: [], edit: { command: "ADD_NODE", payload: { ref: "retry", flowId: firstFlow, kind: "ACTION", label: "Retry payment", description: "", actorLabel: "Customer" } } },
    { id: "link", dependsOn: ["retry"], edit: { command: "ADD_EDGE", payload: { flowId: firstFlow, fromId: selected, toId: "retry", condition: "Failed" } } },
  ], assumptions: [], citations: [] };
  const { confirmation, verificationMethod, ...capturedFlow } = draft.document.flows[firstFlow]!;
  void confirmation; void verificationMethod;
  const capture = { schemaVersion: 1 as const, taskType: "REFINE_FLOW_SELECTION" as const, prompt: "Retry", promptHash: "", draftId: saved.id, documentRevision: 4, parentSnapshotId: null,
    selection: { flowId: firstFlow, nodeIds: [selected] }, graph: { flows: [capturedFlow], nodes: [{ ...draft.document.nodes[selected], readOnly: false }], edges: [], boundaryNodeIds: [] }, graphHash: "", sources: [], versions: { prompt: "test", resultSchema: 1, model: "test" }, limits: { maxInputTokens: 16_000, maxOutputTokens: 6_000, maxGraphNodes: 20, maxGraphEdges: 40, operations: 100, resultBytes: 128 * 1024 } };
  const run = { id: id("8"), state: "SUCCEEDED", disposition: "AVAILABLE", applicability: "APPLICABLE", result, resultHash: "a".repeat(64), capture, draftId: saved.id, documentRevision: 4, parentSnapshotId: null } as unknown as RunView;
  const status = { status: "ACTIVE", currentDraftId: saved.id, documentRevision: 4, layoutRevision: 8, approvedSnapshotId: null } as ProjectStatusView;
  return { saved, run, status, firstFlow, secondFlow, contextual, occupiedPreviewId, savedEdge };
}

test("projects every saved flow and avoids occupied temporary ids", () => {
  const { saved, run, status, firstFlow, secondFlow, contextual, occupiedPreviewId, savedEdge } = fixture();
  const original = structuredClone(saved);
  const preview = projectProposalPreview(saved, status, run);
  assert.ok(preview);
  assert.equal(preview.document.flows[secondFlow]?.title, "Fulfilment");
  assert.equal(preview.document.nodes[contextual]?.label, "Pack order");
  assert.equal(preview.layout.positions[contextual]?.x, 700);
  assert.equal(preview.layout.directions[secondFlow], "LR");
  assert.deepEqual(preview.layout.edgeSides[savedEdge], { from: "right", to: "left" });
  assert.equal(preview.document.nodes[occupiedPreviewId], undefined, "a temporary node id cannot collide with a saved flow id");
  assert.equal(preview.document.nodes[Object.keys(preview.document.nodes).find((nodeId) => preview.document.nodes[nodeId]?.label === "Retry payment")!]?.flowId, firstFlow);
  assert.deepEqual(saved, original, "projection does not mutate the saved draft");
  const newerLayout = structuredClone(saved);
  newerLayout.layoutRevision = 9;
  newerLayout.layout.positions[contextual]!.x = 900;
  assert.equal(projectProposalPreview(newerLayout, status, run)?.layout.positions[contextual]?.x, 900, "layout-only reads remain eligible and recompute the projection");
});

test("refuses a full preview when the saved semantic authority changed", () => {
  const { saved, run, status } = fixture();
  assert.equal(projectProposalPreview(saved, { ...status, documentRevision: 5 }, run), null);
  assert.equal(projectProposalPreview(saved, { ...status, layoutRevision: 9 }, run), null, "a saved read behind the status layout would preview stale positions");
  assert.equal(projectProposalPreview(saved, status, { ...run, capture: { ...run.capture!, draftId: id("7") } }), null);
  assert.equal(projectProposalPreview(saved, status, { ...run, applicability: "STALE" }), null);
  assert.equal(projectProposalPreview(saved, status, { ...run, disposition: "APPLIED" }), null);
});

test("historical inspection refuses full projection even if the current saved capture still matches", () => {
  const {saved,status,run}=fixture();
  const inspect=projectProposalPreview;
  assert.equal(inspect(saved,status,run,true),null);
});

test("new Apply guards fail closed for dirty, busy, unconfirmed and incoherent saved previews", async () => {
  const guard=newApplyBlocker;
  const base={canWrite:true,editable:true,authorityConfirmed:true,busy:false,dirty:false,blockedByPending:false,preview:true};
  assert.equal(guard?.(base),'');
  for(const change of [{dirty:true},{busy:true},{authorityConfirmed:false},{preview:false},{blockedByPending:true},{canWrite:false},{editable:false}])assert.ok(guard?.({...base,...change}));
});

test("temporary preview IDs skip retired UUIDs as well as occupied saved graph IDs", () => {
  const {saved,status,run}=fixture();const retired=id('7');saved.document.retiredEntityIds=[retired];
  const original=structuredClone(saved);const preview=projectProposalPreview(saved,status,run);
  assert.ok(preview,'an otherwise applicable proposal must remain previewable with retired IDs');
  const createdNode=Object.values(preview.document.nodes).find(node=>node.label==='Retry payment');assert.ok(createdNode);assert.equal(createdNode.id,id('8'));
  assert.equal(preview.document.nodes[retired],undefined);assert.equal(preview.document.edges[retired],undefined);
  assert.deepEqual(preview.document.retiredEntityIds,[retired]);assert.deepEqual(saved,original,'saved input remains unchanged');
});
