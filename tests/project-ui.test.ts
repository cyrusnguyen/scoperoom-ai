import assert from "node:assert/strict";
import test from "node:test";
import type { Changes } from "../src/features/drafts/contracts/changes.ts";
import { edit, type Saved } from "../src/features/studio/ui/buffers.ts";
import { emptyOutbox, type Outbox } from "../src/features/studio/ui/outbox.ts";
import type { DraftView } from "../src/features/drafts/contracts/scope-document.ts";
import { acknowledgeExternalWrite, admits, afterDraftRead, canApplyAgain, covers, requireDraftRevision } from "../src/features/studio/ui/studio-ui.ts";
import { type AiRequest, anyDirty, defaultUi, dirtyCount, discardDrafts, dropProject, setDraft, setRightOpen, setRightTab, uiFor, updateUi } from "../src/features/shell/ui/project-ui.ts";

const closed = { nativeImport: null, acknowledgedRevisions: {}, save: { state: "idle", message: "" }, refreshFailed: false, rightOpen: false, rightMounted: false, rightTab: "details" as const, ai: { instruction: "", action: "PROPOSE_FLOW" as const, selectedRunId: null, pendingRequest: null }, drafts: {}, buffers: {}, endpointBuffers: {}, positionBuffers: {}, outbox: emptyOutbox, request: null, flowId: null, selection: null, view: null };
const node: Saved = { kind: "NODE", id: "n1", version: 1, fields: { label: "Pay", description: "" } };

test("discard preserves an uncertain import's original per-project request; dropping access clears it", () => {
  const record = { actorId: "actor", projectId: "a", draftId: "original-draft", previewId: "preview", createKey: "create", discardKey: "discard", fingerprint: "a".repeat(64), previewHash: "b".repeat(64), attempt: { key: "apply", draftId: "original-draft", previewHash: "b".repeat(64) } };
  const nativeImport = { record, file: null, preview: null, state: "Applying" as const, message: "Unconfirmed" };
  const store = updateUi(updateUi({}, "a", () => ({ nativeImport })), "b", () => ({ flowId: "unrelated" }));
  const discarded = discardDrafts(store, "a");
  assert.equal(uiFor(discarded, "a").nativeImport, nativeImport);
  assert.deepEqual(uiFor(discarded, "a").nativeImport?.record.attempt, record.attempt);
  const dropped = dropProject(discarded, "a");
  assert.equal(uiFor(dropped, "a").nativeImport, null);
  assert.equal(uiFor(dropped, "b").flowId, "unrelated");
});

test("an unknown or absent project reads the closed default", () => {
  assert.deepEqual(uiFor({}, "a"), closed);
  assert.deepEqual(uiFor({}, undefined), defaultUi);
});

test("opening mounts the panel; closing hides it but keeps it mounted", () => {
  const opened = setRightOpen({}, "a", true);
  assert.deepEqual(uiFor(opened, "a"), { ...closed, rightOpen: true, rightMounted: true });
  assert.deepEqual(uiFor(setRightOpen(opened, "a", false), "a"), { ...closed, rightOpen: false, rightMounted: true });
  assert.equal(uiFor(setRightOpen({}, "a", false), "a").rightMounted, false);
});

test("AI prompt and uncertain request stay in per-project memory across panel close and project switches", () => {
  const pendingRequest = { kind: "start" as const, projectId: "a", draftId: "draft-a", key: "same-key", submittedText: "Original", body: { prompt: "Original" } };
  let store = updateUi({}, "a", () => ({ ai: { instruction: "Newer", action: "PROPOSE_FLOW", selectedRunId: null, pendingRequest } }));
  store = setRightTab(store, "a", "ai");
  store = setRightOpen(store, "a", false);
  store = setRightTab(store, "b", "ai");
  assert.equal(uiFor(store, "a").ai.instruction, "Newer");
  assert.equal(uiFor(store, "a").ai.pendingRequest, pendingRequest);
  assert.notEqual(uiFor(store, "b").ai.pendingRequest, pendingRequest);
});

for (const kind of ["start", "apply", "cancel", "discard"] as const) {
  test(`pending AI ${kind} alone protects unload across retained projects without becoming a draft edit`, () => {
    const body = Object.freeze({ draftId: "draft-a", expectedDocumentRevision: 3, selectedOperationIds: ["step"] });
    const pendingRequest: AiRequest = Object.freeze({ kind, projectId: "a", draftId: "draft-a", key: "original-key", body, submittedText: "Original", runId: "run-a" });
    let store = updateUi({}, "a", () => ({ ai: { instruction: "Newer instruction", action: "PROPOSE_FLOW", selectedRunId: "run-a", pendingRequest } }));
    assert.equal(dirtyCount(store, "a"), 0, "a receipt is not an unsaved draft edit");
    assert.equal(anyDirty(store), true, "an uncertain AI receipt must protect unload even with a clean Studio");
    store = setRightOpen(setRightTab(store, "a", "ai"), "a", false);
    store = setRightTab(store, "b", "ai");
    store = discardDrafts(setDraft(store, "a", "name", "Local edit"), "a");
    assert.equal(dirtyCount(store, "a"), 0);
    assert.equal(dirtyCount(store, "b"), 0);
    assert.equal(uiFor(store, "a").ai.pendingRequest, pendingRequest);
    assert.equal(uiFor(store, "a").ai.pendingRequest?.body, body);
    assert.equal(uiFor(store, "a").ai.pendingRequest?.key, "original-key");
    assert.equal(uiFor(store, "a").ai.instruction, "Newer instruction");
    assert.equal(anyDirty(store), true, "closing the panel and opening another project retain unload protection");
    const acknowledged = updateUi(store, "a", (ui) => ({ ai: { ...ui.ai, pendingRequest: null } }));
    assert.equal(anyDirty(acknowledged), false, "acknowledging the only pending receipt clears unload protection");
    const otherDirty = setDraft(acknowledged, "b", "name", "Still local");
    assert.equal(anyDirty(otherDirty), true, "ordinary unsaved edits still protect unload");
    assert.equal(dirtyCount(otherDirty, "b"), 1);
    assert.equal(anyDirty(dropProject(store, "a")), false, "dropping that project removes its pending state");
  });
}

test("drafts belong to one project, and undefined clears a draft", () => {
  let store = setDraft({}, "a", "name", "New name");
  store = setDraft(store, "b", "approver", "p1");
  assert.equal(dirtyCount(store, "a"), 1);
  assert.equal(dirtyCount(store, "b"), 1);
  assert.equal(dirtyCount(store, undefined), 0);
  store = setDraft(store, "a", "name", undefined);
  assert.equal(dirtyCount(store, "a"), 0);
  assert.equal(anyDirty(store), true);
});

test("Studio buffers count their dirty fields", () => {
  let store = updateUi({}, "a", (ui) => ({ buffers: edit(edit(ui.buffers, node, "label", "Pay now"), node, "description", "Card") }));
  assert.equal(dirtyCount(store, "a"), 2);
  store = updateUi(store, "a", (ui) => ({ buffers: edit(ui.buffers, node, "label", "Pay") }));
  store = updateUi(store, "a", (ui) => ({ buffers: edit(ui.buffers, node, "description", "") }));
  assert.equal(dirtyCount(store, "a"), 0, "typing back the saved values is clean again");
  assert.equal(anyDirty(store), false);
});

test("typed positions count for leave guards and explicit discard clears them", () => {
  const position: Saved = { kind: "NODE", id: "n1", version: 4, fields: { x: "10", y: "20" } };
  const store = updateUi({}, "a", (ui) => ({ ...ui, positionBuffers: edit({}, position, "x", "30") }));
  assert.equal(dirtyCount(store, "a"), 1);
  assert.equal(anyDirty(store), true);
  const discarded = discardDrafts(store, "a");
  assert.equal(anyDirty(discarded), false);
});

test("updateUi merges a change computed from the current state", () => {
  const store = updateUi(updateUi({}, "a", () => ({ flowId: "f1" })), "a", (ui) => ({ selection: { kind: "FLOW", id: ui.flowId! } }));
  assert.deepEqual(uiFor(store, "a").selection, { kind: "FLOW", id: "f1" });
  assert.equal(uiFor(store, "a").flowId, "f1");
});

test("discard clears only that project's drafts and buffers and keeps its panel; drop forgets the project", () => {
  let store = setRightOpen(setDraft({}, "a", "name", "x"), "a", true);
  store = updateUi(store, "a", (ui) => ({ buffers: edit(ui.buffers, node, "label", "Typed") }));
  store = setDraft(store, "b", "name", "y");
  const discarded = discardDrafts(store, "a");
  assert.equal(dirtyCount(discarded, "a"), 0);
  assert.deepEqual(uiFor(discarded, "a").buffers, {});
  assert.equal(uiFor(discarded, "a").rightOpen, true);
  assert.equal(dirtyCount(discarded, "b"), 1);
  assert.deepEqual(uiFor(dropProject(store, "a"), "a"), defaultUi);
  assert.equal(anyDirty(dropProject(dropProject(store, "a"), "b")), false);
  assert.deepEqual(defaultUi, closed, "the shared default is never mutated");
});

test("endpoint choices count as unsaved and discard clears only their project", () => {
  const saved: Saved = { kind: "EDGE", id: "e1", version: 1, fields: { fromId: "a", toId: "b" } };
  let store = updateUi({}, "a", () => ({ endpointBuffers: edit({}, saved, "toId", "c") }));
  store = updateUi(store, "b", () => ({ endpointBuffers: edit({}, saved, "toId", "d") }));
  assert.equal(dirtyCount(store, "a"), 1);
  assert.equal(anyDirty(store), true);
  const discarded = discardDrafts(store, "a");
  assert.equal(dirtyCount(discarded, "a"), 0);
  assert.deepEqual(uiFor(discarded, "a").endpointBuffers, {});
  assert.equal(dirtyCount(discarded, "b"), 1);
});

test("reads must cover both acknowledged revision floors and clear only the qualifying draft", () => {
  let floors = requireDraftRevision({}, { draftId: "d1", documentRevision: 5, layoutRevision: 7 });
  floors = requireDraftRevision(floors, { draftId: "d1", documentRevision: 4, layoutRevision: 6 });
  floors = requireDraftRevision(floors, { draftId: "d2", documentRevision: 3, layoutRevision: 2 });
  assert.deepEqual(floors.d1, { documentRevision: 5, layoutRevision: 7 }, "replayed older receipts never lower either floor");
  const ui = { ...defaultUi, acknowledgedRevisions: floors, refreshFailed: true };
  for (const view of [{ id: "d1", documentRevision: 4, layoutRevision: 7 }, { id: "d1", documentRevision: 5, layoutRevision: 6 }]) {
    assert.deepEqual(afterDraftRead(ui, view), { acknowledgedRevisions: floors, refreshFailed: true });
  }
  const read = afterDraftRead(ui, { id: "d1", documentRevision: 5, layoutRevision: 7 });
  assert.equal(read.refreshFailed, false);
  assert.deepEqual(read.acknowledgedRevisions, { d2: floors.d2 });
  assert.deepEqual(ui.acknowledgedRevisions, floors, "the original per-project state is immutable");
});

test("a replayed Apply receipt pins its original draft without raising the replacement draft floor", () => {
  const floors = {
    oldDraft: { documentRevision: 4, layoutRevision: 2 },
    currentDraft: { documentRevision: 8, layoutRevision: 5 },
  };
  const receipt = { draftId: "oldDraft", documentRevision: 9, layoutRevision: 7 };
  const ack = acknowledgeExternalWrite("currentDraft", floors, receipt);
  assert.equal(ack.currentDraft, false);
  assert.deepEqual(ack.currentFloor, floors.currentDraft);
  assert.deepEqual(ack.acknowledgedRevisions, {
    oldDraft: { documentRevision: 9, layoutRevision: 7 },
    currentDraft: floors.currentDraft,
  });
});

test("one admission predicate: a read must be current, not older than the adopted draft, and cover the floor", () => {
  const draft = (documentRevision: number, layoutRevision: number, draftId = "d1") => ({ id: draftId, documentRevision, layoutRevision }) as DraftView;
  const ui = { ...defaultUi, acknowledgedRevisions: requireDraftRevision({}, { draftId: "d1", documentRevision: 6, layoutRevision: 3 }) };
  const adopted = draft(5, 3);
  assert.equal(admits(ui, adopted, draft(5, 3)), false, "below the document floor");
  assert.equal(admits(ui, adopted, draft(6, 2)), false, "below the layout floor");
  assert.equal(admits(ui, adopted, draft(6, 3)), true);
  assert.equal(admits(ui, adopted, draft(7, 3, "d2")), false, "another draft is never admitted");
  assert.equal(admits(ui, draft(8, 3), draft(6, 3)), false, "older than the adopted draft");
  assert.equal(admits(defaultUi, adopted, draft(5, 3)), true, "no floor: any not-older read");
  assert.equal(covers(draft(5, 3), undefined), true);
  // Only an admitted read clears the floor.
  assert.deepEqual(afterDraftRead(ui, draft(6, 3)).acknowledgedRevisions, {});
});

test("Apply my changes again waits for a readable saved draft that covers the acknowledged floor", () => {
  const draft = (documentRevision: number) => ({ id: "d1", documentRevision, layoutRevision: 3 }) as DraftView;
  const ui = { ...defaultUi, acknowledgedRevisions: requireDraftRevision({}, { draftId: "d1", documentRevision: 6, layoutRevision: 3 }) };
  assert.equal(canApplyAgain(ui, draft(5)), false, "shown saved draft is below the floor: rebasing would hide the acknowledged edit");
  assert.equal(canApplyAgain(ui, draft(6)), true);
  assert.equal(canApplyAgain({ ...ui, refreshFailed: true }, draft(6)), false, "a failed read keeps conflict actions disabled");
  assert.equal(canApplyAgain(defaultUi, draft(5)), true);
});

const deleteEdge = { commandSchemaVersion: 1, command: "DELETE_EDGE", expectedDocumentRevision: 3, payload: { edgeId: "e1" } } as const;
const batch: Changes = { commands: [{ command: deleteEdge, proposedIds: [] }], moves: [] };
const withSave = (state: "waiting" | "sending" | "uncertain" | "refused"): Outbox => ({
  ...emptyOutbox, entries: [{ kind: "drop", flowId: "f", items: [{ nodeId: "n1", x: 1, y: 2 }] }], sending: { draftId: "d1", key: "receipt-1", batches: [batch], state },
});

test("unsaved changes guard navigation; discard drops them and a refused save, never one that may have committed", () => {
  const failed = { state: "failed", message: "Your changes weren’t saved." } as const;
  for (const state of ["waiting", "refused"] as const) {
    const store = updateUi({}, "a", () => ({ outbox: withSave(state), save: failed }));
    assert.equal(dirtyCount(store, "a"), 2);
    assert.equal(anyDirty(store), true);
    const discarded = uiFor(discardDrafts(store, "a"), "a");
    assert.deepEqual([discarded.outbox, discarded.save], [emptyOutbox, { state: "idle", message: "" }]);
  }
  for (const state of ["sending", "uncertain"] as const) {
    const store = setDraft(updateUi({}, "a", () => ({ outbox: withSave(state), save: failed })), "a", "name", "Local text");
    const discarded = uiFor(discardDrafts(store, "a"), "a");
    assert.deepEqual(discarded.drafts, {});
    assert.deepEqual(discarded.outbox.entries, [], "local changes behind it go");
    assert.equal(discarded.outbox.sending?.key, "receipt-1", "the batch stays retryable with its key");
    assert.deepEqual(discarded.save, failed);
    assert.equal(dirtyCount(discardDrafts(store, "a"), "a"), 1);
  }
});
