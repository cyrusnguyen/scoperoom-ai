import assert from "node:assert/strict";
import test from "node:test";
import type { Changes } from "../src/features/drafts/contracts/changes.ts";
import { edit, type Saved } from "../src/features/studio/ui/buffers.ts";
import { emptyOutbox, type Outbox } from "../src/features/studio/ui/outbox.ts";
import type { DraftView } from "../src/features/drafts/contracts/scope-document.ts";
import { admits, afterDraftRead, canApplyAgain, covers, requireDraftRevision } from "../src/features/studio/ui/studio-ui.ts";
import { anyDirty, defaultUi, dirtyCount, discardDrafts, dropProject, setDraft, setRightOpen, uiFor, updateUi } from "../src/features/shell/ui/project-ui.ts";

const closed = { acknowledgedRevisions: {}, save: { state: "idle", message: "" }, refreshFailed: false, rightOpen: false, rightMounted: false, drafts: {}, buffers: {}, endpointBuffers: {}, outbox: emptyOutbox, request: null, flowId: null, selection: null, view: null };
const node: Saved = { kind: "NODE", id: "n1", version: 1, fields: { label: "Pay", description: "" } };

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
