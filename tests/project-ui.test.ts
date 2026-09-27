import assert from "node:assert/strict";
import test from "node:test";
import { edit, send, type Saved } from "../src/features/studio/ui/buffers.ts";
import { anyDirty, defaultUi, dirtyCount, discardDrafts, dropProject, setDraft, setRightOpen, uiFor, updateUi } from "../src/features/shell/ui/project-ui.ts";

const closed = { rightOpen: false, rightMounted: false, drafts: {}, buffers: {}, endpointBuffers: {}, flowId: null, selection: null, view: null };
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

test("Studio buffers count their dirty fields; an unconfirmed save still counts once", () => {
  let store = updateUi({}, "a", (ui) => ({ buffers: edit(edit(ui.buffers, node, "label", "Pay now"), node, "description", "Card") }));
  assert.equal(dirtyCount(store, "a"), 2);
  store = updateUi(store, "a", (ui) => ({ buffers: edit(ui.buffers, node, "label", "Pay") }));
  store = updateUi(store, "a", (ui) => ({ buffers: edit(ui.buffers, node, "description", "") }));
  assert.equal(dirtyCount(store, "a"), 0, "typing back the saved values is clean again");
  store = updateUi(store, "a", (ui) => ({ buffers: send(edit(ui.buffers, node, "label", "Sent"), "NODE:n1", "key-1") }));
  store = updateUi(store, "a", (ui) => ({ buffers: edit(ui.buffers, node, "label", "Pay") }));
  assert.equal(dirtyCount(store, "a"), 1, "a save in flight is not clean until acknowledged");
  assert.equal(anyDirty(store), true);
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
