import assert from "node:assert/strict";
import test from "node:test";
import { anyDirty, defaultUi, dirtyCount, discardDrafts, dropProject, setDraft, setRightOpen, uiFor } from "../src/features/shell/ui/project-ui.ts";

test("an unknown or absent project reads the closed default", () => {
  assert.deepEqual(uiFor({}, "a"), { rightOpen: false, rightMounted: false, drafts: {} });
  assert.deepEqual(uiFor({}, undefined), defaultUi);
});

test("opening mounts the panel; closing hides it but keeps it mounted", () => {
  const opened = setRightOpen({}, "a", true);
  assert.deepEqual(uiFor(opened, "a"), { rightOpen: true, rightMounted: true, drafts: {} });
  assert.deepEqual(uiFor(setRightOpen(opened, "a", false), "a"), { rightOpen: false, rightMounted: true, drafts: {} });
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

test("discard clears only that project's drafts and keeps its panel; drop forgets the project", () => {
  let store = setRightOpen(setDraft({}, "a", "name", "x"), "a", true);
  store = setDraft(store, "b", "name", "y");
  const discarded = discardDrafts(store, "a");
  assert.equal(dirtyCount(discarded, "a"), 0);
  assert.equal(uiFor(discarded, "a").rightOpen, true);
  assert.equal(dirtyCount(discarded, "b"), 1);
  assert.deepEqual(uiFor(dropProject(store, "a"), "a"), defaultUi);
  assert.equal(anyDirty(dropProject(dropProject(store, "a"), "b")), false);
  assert.deepEqual(defaultUi, { rightOpen: false, rightMounted: false, drafts: {} }, "the shared default is never mutated");
});
