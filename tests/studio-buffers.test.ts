import assert from "node:assert/strict";
import test from "node:test";
import { acknowledge, changes, discard, edit, follow, isDirty, rebase, refuse, send, type Saved } from "../src/features/studio/ui/buffers.ts";

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

test("own saves that advance another record move its buffer only when nothing else changed it", () => {
  const flow: Saved = { kind: "FLOW", id: "f1", version: 7, fields: { title: "Checkout" } };
  const buffers = edit({}, flow, "title", "Checkout v2");
  assert.equal(follow(buffers, { f1: 8, n1: 4 })["FLOW:f1"]!.baseVersion, 8);
  assert.equal(follow(buffers, { f1: 9 })["FLOW:f1"]!.baseVersion, 7, "someone else also changed it: the next save must conflict");
  const inFlight = send(buffers, "FLOW:f1", "request-1");
  assert.equal(follow(inFlight, { f1: 8 })["FLOW:f1"]!.baseVersion, 7, "a buffer in flight is settled by its own acknowledgement");
});
