import assert from "node:assert/strict";
import test from "node:test";
import { inlinePlan } from "../src/features/studio/ui/fields.ts";
import { changes, discard, edit, editFields, follow, isDirty, rebase, refuse, type Saved } from "../src/features/studio/ui/buffers.ts";

const node: Saved = { kind: "NODE", id: "n1", version: 3, fields: { label: "Pay", description: "" } };
const key = "NODE:n1";

test("the first edit captures the saved version and values; typing the saved value back removes the buffer", () => {
  const buffers = edit({}, node, "label", "Pay now");
  assert.deepEqual(buffers[key], { kind: "NODE", id: "n1", baseVersion: 3, original: node.fields, values: { label: "Pay now", description: "" }, conflict: false });
  assert.deepEqual(changes(buffers[key]!), { label: "Pay now" });
  assert.deepEqual(edit(buffers, node, "label", "Pay"), {});
});

test("a refused apply keeps the typed values; a conflict stays until it is resolved", () => {
  const typed = edit({}, node, "label", "Mine");
  const refused = refuse(typed, key, false);
  assert.deepEqual([refused[key]!.values.label, refused[key]!.conflict], ["Mine", false]);
  const conflicted = refuse(typed, key, true);
  assert.equal(isDirty(conflicted[key]!), true);
  const rebased = rebase(conflicted, { ...node, version: 5, fields: { label: "Theirs", description: "" } });
  assert.deepEqual([rebased[key]!.baseVersion, rebased[key]!.original.label, rebased[key]!.values.label, rebased[key]!.conflict], [5, "Theirs", "Mine", false]);
  assert.deepEqual(rebase(refuse(edit({}, node, "label", "Same"), key, true), { ...node, version: 5, fields: { label: "Same", description: "" } }), {});
  assert.deepEqual(discard(conflicted, key), {});
});

test("rebasing refreshes clean fields from the latest record while retaining the local edit", () => {
  const original: Saved = { kind: "NODE", id: "n1", version: 3, fields: { label: "A", description: "old" } };
  const buffers = rebase(edit({}, original, "label", "Mine"), { ...original, version: 4, fields: { label: "Theirs", description: "new" } });
  assert.deepEqual(changes(buffers[key]!), { label: "Mine" });
  assert.deepEqual(buffers[key]!.values, { label: "Mine", description: "new" });
});

test("own changes that advance another record move its buffer only when nothing else changed it", () => {
  const flow: Saved = { kind: "FLOW", id: "f1", version: 7, fields: { title: "Checkout" } };
  const buffers = edit({}, flow, "title", "Checkout v2");
  assert.equal(follow(buffers, { f1: 8, n1: 4 })["FLOW:f1"]!.baseVersion, 8);
  assert.equal(follow(buffers, { f1: 9 })["FLOW:f1"]!.baseVersion, 7, "someone else also changed it: the next save must conflict");
  const conflicted = refuse(buffers, "FLOW:f1", true);
  assert.equal(follow(conflicted, { f1: 8 })["FLOW:f1"]!.baseVersion, 7, "a conflict needs explicit review even after our next save");
});


test("an endpoint pair changes atomically without dropping its captured revision between fields", () => {
  const original: Saved = { kind: "EDGE", id: "e1", version: 7, fields: { fromId: "a", toId: "b" } };
  const latest: Saved = { ...original, version: 8, fields: { fromId: "remote", toId: "b" } };
  const first = edit({}, original, "fromId", "mine");
  const next = editFields(first, latest, { fromId: "a", toId: "new-target" });
  assert.equal(next["EDGE:e1"]!.baseVersion, 7);
  assert.deepEqual(next["EDGE:e1"]!.original, original.fields);
  assert.deepEqual(next["EDGE:e1"]!.values, { fromId: "a", toId: "new-target" });
});

// Inline canvas editors (Task 8) apply the inspector's shared buffer like its Save does (queued locally, Task 14b), and
// only for what was typed in the editor itself (`opened` is the text it showed when it opened).
const full: Saved = { kind: "NODE", id: "n1", version: 3, fields: { label: "Pay", kind: "ACTION", actorLabel: "", description: "", assumptionNotes: "" } };

test("closing an inline editor sends nothing unless its own field changed while it was open", () => {
  assert.deepEqual(inlinePlan(undefined, "NODE", "label", "Pay"), { kind: "unchanged" });
  assert.deepEqual(inlinePlan(edit({}, full, "description", "typed in the inspector")[key], "NODE", "label", "Pay"), { kind: "unchanged" });
  assert.deepEqual(inlinePlan(edit({}, full, "label", "Pay now")[key], "NODE", "label", "Pay"), { kind: "send", fields: { label: "Pay now" } });
  // Opened on unsaved inspector text and closed without typing: nothing is sent, not even the inspector's fields.
  const inspector = editFields({}, full, { label: "From inspector", description: "Half-written" });
  assert.deepEqual(inlinePlan(inspector[key], "NODE", "label", "From inspector"), { kind: "unchanged" });
  assert.deepEqual(inlinePlan(edit({}, full, "label", "x".repeat(161))[key], "NODE", "label", "x".repeat(161)), { kind: "unchanged" }, "invalid inspector text is not touched either");
});

test("an inline edit never sends other unsaved fields: they go to the inspector for a deliberate Save", () => {
  const both = editFields({}, full, { label: "Pay now", description: "Card only" });
  assert.deepEqual(inlinePlan(both[key], "NODE", "label", "Pay"), { kind: "review" });
  const badOther = editFields({}, full, { label: "Pay now", actorLabel: "x".repeat(101) });
  assert.deepEqual(inlinePlan(badOther[key], "NODE", "label", "Pay"), { kind: "review" });
  assert.deepEqual(inlinePlan(refuse(edit({}, full, "label", "Mine"), key, true)[key], "NODE", "label", "Pay"), { kind: "review" }, "a conflict is reviewed");
});

test("an empty or over-limit inline label is refused without touching the buffer; an empty connection label clears it", () => {
  const empty = edit({}, node, "label", "  ");
  assert.deepEqual(inlinePlan(empty[key], "NODE", "label", "Pay"), { kind: "refused", message: "Enter a name." });
  assert.deepEqual(inlinePlan(edit({}, node, "label", "\u{1F600}".repeat(161))[key], "NODE", "label", "Pay"), { kind: "refused", message: "Name can be up to 160 characters (now 161)." });
  // The plan is pure: the typed text stays in the buffer for the editor and the inspector.
  assert.equal(empty[key]!.values.label, "  ");
  const edge: Saved = { kind: "EDGE", id: "e1", version: 2, fields: { condition: "Paid" } };
  assert.deepEqual(inlinePlan(edit({}, edge, "condition", "")["EDGE:e1"], "EDGE", "condition", "Paid"), { kind: "send", fields: { condition: "" } });
  assert.equal(inlinePlan(edit({}, edge, "condition", "y".repeat(241))["EDGE:e1"], "EDGE", "condition", "Paid").kind, "refused");
});
