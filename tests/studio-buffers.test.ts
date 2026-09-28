import assert from "node:assert/strict";
import test from "node:test";
import { inlinePlan } from "../src/features/studio/ui/fields.ts";
import { acknowledge, changes, discard, edit, editFields, follow, isDirty, rebase, refuse, send, type Saved } from "../src/features/studio/ui/buffers.ts";

const node: Saved = { kind: "NODE", id: "n1", version: 3, fields: { label: "Pay", description: "" } };
const key = "NODE:n1";

test("the first edit captures the saved version and values; typing the saved value back removes the buffer", () => {
  const buffers = edit({}, node, "label", "Pay now");
  assert.deepEqual(buffers[key], { kind: "NODE", id: "n1", baseVersion: 3, original: node.fields, values: { label: "Pay now", description: "" }, sent: null, key: null, conflict: false });
  assert.deepEqual(changes(buffers[key]!), { label: "Pay now" });
  assert.deepEqual(edit(buffers, node, "label", "Pay"), {});
});

test("an acknowledgement clears only what was sent; text typed while the save was in flight stays dirty", () => {
  let buffers = send(edit({}, node, "label", "Pay now"), key, "request-1");
  assert.deepEqual([buffers[key]!.sent, buffers[key]!.key], [{ label: "Pay now" }, "request-1"]);
  buffers = edit(buffers, node, "label", "Pay now, please");
  buffers = acknowledge(buffers, key, 4);
  const buffer = buffers[key]!;
  assert.deepEqual([buffer.baseVersion, buffer.original.label, buffer.values.label, buffer.sent], [4, "Pay now", "Pay now, please", null]);
  assert.deepEqual(changes(buffer), { label: "Pay now, please" });
  assert.deepEqual(acknowledge(send(buffers, key, "request-2"), key, 5), {}, "acknowledging the rest leaves nothing dirty");
});

test("a refused save keeps the typed values; a conflict stays until it is resolved", () => {
  const sent = send(edit({}, node, "label", "Mine"), key, "request-1");
  const refused = refuse(sent, key, false);
  assert.deepEqual([refused[key]!.sent, refused[key]!.values.label, refused[key]!.conflict], [null, "Mine", false]);
  const conflicted = refuse(sent, key, true);
  assert.equal(isDirty(conflicted[key]!), true);
  const rebased = rebase(conflicted, { ...node, version: 5, fields: { label: "Theirs", description: "" } });
  assert.deepEqual([rebased[key]!.baseVersion, rebased[key]!.original.label, rebased[key]!.values.label, rebased[key]!.conflict], [5, "Theirs", "Mine", false]);
  assert.deepEqual(rebase(refuse(send(edit({}, node, "label", "Same"), key, "r"), key, true), { ...node, version: 5, fields: { label: "Same", description: "" } }), {});
  assert.deepEqual(discard(conflicted, key), {});
});

test("rebasing refreshes clean fields from the latest record while retaining the local edit", () => {
  const original: Saved = { kind: "NODE", id: "n1", version: 3, fields: { label: "A", description: "old" } };
  const buffers = rebase(edit({}, original, "label", "Mine"), { ...original, version: 4, fields: { label: "Theirs", description: "new" } });
  assert.deepEqual(changes(buffers[key]!), { label: "Mine" });
  assert.deepEqual(buffers[key]!.values, { label: "Mine", description: "new" });
});

test("an uncertain retry preserves its original fields and key while later typing remains local", () => {
  let buffers = send(edit({}, node, "label", "First"), key, "key-1");
  buffers = edit(buffers, node, "label", "Second");
  const retried = send(buffers, key, "key-1");
  assert.deepEqual([retried[key]!.sent, retried[key]!.key, retried[key]!.values.label], [{ label: "First" }, "key-1", "Second"]);
  assert.strictEqual(send(retried, key, "key-2"), retried, "a different key waits for acknowledgement or refusal");
});

test("own saves that advance another record move its buffer only when nothing else changed it", () => {
  const flow: Saved = { kind: "FLOW", id: "f1", version: 7, fields: { title: "Checkout" } };
  const buffers = edit({}, flow, "title", "Checkout v2");
  assert.equal(follow(buffers, { f1: 8, n1: 4 })["FLOW:f1"]!.baseVersion, 8);
  assert.equal(follow(buffers, { f1: 9 })["FLOW:f1"]!.baseVersion, 7, "someone else also changed it: the next save must conflict");
  const inFlight = send(buffers, "FLOW:f1", "request-1");
  assert.equal(follow(inFlight, { f1: 8 })["FLOW:f1"]!.baseVersion, 7, "a buffer in flight is settled by its own acknowledgement");
  const conflicted = refuse(send(buffers, "FLOW:f1", "request-2"), "FLOW:f1", true);
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

// Inline canvas editors (Task 8) close through the inspector's own Save on the same shared buffer.
test("closing an inline editor sends nothing unless its own field changed", () => {
  const full: Saved = { kind: "NODE", id: "n1", version: 3, fields: { label: "Pay", kind: "ACTION", actorLabel: "", description: "", assumptionNotes: "" } };
  assert.deepEqual(inlinePlan(undefined, "NODE", "label"), { kind: "unchanged" });
  assert.deepEqual(inlinePlan(edit({}, full, "description", "typed in the inspector")[key], "NODE", "label"), { kind: "unchanged" });
  assert.deepEqual(inlinePlan(edit({}, full, "label", "Pay now")[key], "NODE", "label"), { kind: "send", fields: { label: "Pay now" }, retrying: false });
});

test("an inline save sends the whole buffer like Save, retries an unconfirmed request with its sent fields, and leaves conflicts to review", () => {
  const full: Saved = { kind: "NODE", id: "n1", version: 3, fields: { label: "Pay", kind: "ACTION", actorLabel: "", description: "", assumptionNotes: "" } };
  const both = editFields({}, full, { label: "Pay now", description: "Card only" });
  assert.deepEqual(inlinePlan(both[key], "NODE", "label"), { kind: "send", fields: { label: "Pay now", description: "Card only" }, retrying: false });
  const unconfirmed = edit(send(edit({}, full, "label", "First"), key, "k1"), full, "label", "Second");
  assert.deepEqual(inlinePlan(unconfirmed[key], "NODE", "label"), { kind: "send", fields: { label: "First" }, retrying: true });
  assert.deepEqual(inlinePlan(refuse(send(edit({}, full, "label", "Mine"), key, "k1"), key, true)[key], "NODE", "label"), { kind: "review" });
  const badOther = editFields({}, full, { label: "Pay now", actorLabel: "x".repeat(101) });
  assert.deepEqual(inlinePlan(badOther[key], "NODE", "label"), { kind: "review" }, "another invalid field is fixed in the inspector");
});

test("an empty or over-limit inline label is refused locally; an empty connection label clears it", () => {
  assert.deepEqual(inlinePlan(edit({}, node, "label", "  ")[key], "NODE", "label"), { kind: "refused", message: "Enter a name." });
  assert.deepEqual(inlinePlan(edit({}, node, "label", "\u{1F600}".repeat(161))[key], "NODE", "label"), { kind: "refused", message: "Name can be up to 160 characters (now 161)." });
  const edge: Saved = { kind: "EDGE", id: "e1", version: 2, fields: { condition: "Paid" } };
  assert.deepEqual(inlinePlan(edit({}, edge, "condition", "")["EDGE:e1"], "EDGE", "condition"), { kind: "send", fields: { condition: "" }, retrying: false });
  assert.equal(inlinePlan(edit({}, edge, "condition", "y".repeat(241))["EDGE:e1"], "EDGE", "condition").kind, "refused");
});
