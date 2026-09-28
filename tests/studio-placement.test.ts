import assert from "node:assert/strict";
import test from "node:test";
import type { DraftLayout } from "../src/features/drafts/contracts/draft-layout.ts";
import { canUndo, forgetMoves, moveChunks, moveTargets, recordDrop, settleMoves, studioDirtyCount, undoDrop, defaultStudioUi, type UnsavedMoves } from "../src/features/studio/ui/studio-ui.ts";

const layout: DraftLayout = { schemaVersion: 1, positions: { a: { x: 0, y: 0, version: 3 }, b: { x: 100, y: 0, version: 5 } }, directions: {} };
const clean = { unsavedMoves: {}, drops: [] };

test("a drag saves only steps that moved, rounded to whole pixels", () => {
  assert.deepEqual(moveTargets([{ id: "a", position: { x: 0.4, y: -0.2 } }, { id: "b", position: { x: 140.6, y: 20 } }, { id: "gone", position: { x: 1, y: 1 } }], layout), [{ nodeId: "b", x: 141, y: 20 }]);
});

test("a drag is measured from what is shown: an unsaved position, else the saved one", () => {
  const unsaved: UnsavedMoves = { a: { flowId: "f", x: 50, y: 50, expectedVersion: 3 } };
  assert.deepEqual(moveTargets([{ id: "a", position: { x: 50, y: 50 } }], layout, unsaved), [], "not moved from its unsaved spot");
  assert.deepEqual(moveTargets([{ id: "a", position: { x: 0, y: 0 } }], layout, unsaved), [{ nodeId: "a", x: 0, y: 0 }], "dragged back onto its saved spot");
});

test("undo is offered only while every moved step still has the version the move saved", () => {
  assert.equal(canUndo(null, layout), false);
  assert.equal(canUndo({ flowId: "f", items: [] }, layout), false);
  assert.equal(canUndo({ flowId: "f", items: [{ nodeId: "a", x: 9, y: 9, version: 3 }, { nodeId: "b", x: 9, y: 9, version: 5 }] }, layout), true);
  assert.equal(canUndo({ flowId: "f", items: [{ nodeId: "a", x: 9, y: 9, version: 3 }, { nodeId: "b", x: 9, y: 9, version: 4 }] }, layout), false, "someone moved b since");
  assert.equal(canUndo({ flowId: "f", items: [{ nodeId: "gone", x: 9, y: 9, version: 1 }] }, layout), false, "a deleted step cannot be undone");
});

test("a drop is kept locally; the expected version is the saved one at the step's first local move", () => {
  const first = recordDrop(clean, "f", [{ nodeId: "a", x: 10, y: 10 }], layout);
  assert.deepEqual(first.unsavedMoves, { a: { flowId: "f", x: 10, y: 10, expectedVersion: 3 } });
  // Someone else's save raised a's saved version; the later drag still expects the version it first moved from.
  const newer: DraftLayout = { ...layout, positions: { ...layout.positions, a: { x: 0, y: 0, version: 4 } } };
  const second = recordDrop(first, "f", [{ nodeId: "a", x: 20, y: 20 }, { nodeId: "b", x: 1, y: 1 }], newer);
  assert.deepEqual(second.unsavedMoves, { a: { flowId: "f", x: 20, y: 20, expectedVersion: 3 }, b: { flowId: "f", x: 1, y: 1, expectedVersion: 5 } });
  assert.equal(second.drops.length, 2);
  // Dropping a step back onto its saved position leaves nothing to save for it.
  assert.deepEqual(Object.keys(recordDrop(second, "f", [{ nodeId: "b", x: 100, y: 0 }], layout).unsavedMoves), ["a"]);
  assert.deepEqual(recordDrop(first, "f", [{ nodeId: "a", x: 0, y: 0 }], layout), clean, "fully saved again: no local undo left");
  assert.deepEqual(recordDrop(clean, "f", [{ nodeId: "gone", x: 1, y: 1 }], layout), clean, "a step without a saved position is ignored");
});

test("undo reverts only the most recent local drop, one drop at a time", () => {
  const one = recordDrop(clean, "f", [{ nodeId: "a", x: 10, y: 10 }], layout);
  const two = recordDrop(one, "f", [{ nodeId: "a", x: 20, y: 20 }, { nodeId: "b", x: 1, y: 1 }], layout);
  const undone = undoDrop(two);
  assert.deepEqual(undone.unsavedMoves, { a: { flowId: "f", x: 10, y: 10, expectedVersion: 3 } });
  assert.deepEqual(undoDrop(undone), clean);
  assert.deepEqual(undoDrop(clean), clean);
});

test("a flush sends one flow at a time in chunks of at most 20, skipping steps no longer in the document", () => {
  const positions: DraftLayout["positions"] = {};
  const nodes: Record<string, { flowId: string }> = {};
  const unsaved: UnsavedMoves = {};
  for (let index = 0; index < 23; index += 1) {
    const id = `n${index}`;
    positions[id] = { x: 0, y: 0, version: 1 + index };
    nodes[id] = { flowId: index < 22 ? "f" : "g" };
    unsaved[id] = { flowId: nodes[id]!.flowId, x: index, y: index, expectedVersion: 1 + index };
  }
  unsaved.deleted = { flowId: "f", x: 1, y: 1, expectedVersion: 1 };
  const chunks = moveChunks(unsaved, { schemaVersion: 1, positions, directions: {} }, nodes);
  assert.deepEqual(chunks.map((chunk) => [chunk.flowId, chunk.items.length]), [["f", 20], ["f", 2], ["g", 1]]);
  assert.deepEqual(chunks[0]!.items[3], { nodeId: "n3", expectedPositionVersion: 4, x: 3, y: 3 });
  assert.equal(chunks.flatMap((chunk) => chunk.items).some((item) => item.nodeId === "deleted"), false);
  assert.deepEqual(moveChunks({}, layout, {}), []);
});

test("an acknowledged chunk leaves unsaved moves; a step moved again since keeps its newer spot at the saved version", () => {
  let moves = recordDrop(clean, "f", [{ nodeId: "a", x: 10, y: 10 }, { nodeId: "b", x: 7, y: 7 }], layout);
  moves = recordDrop(moves, "f", [{ nodeId: "b", x: 8, y: 8 }], layout);
  const settled = settleMoves(moves, [{ nodeId: "a", expectedPositionVersion: 3, x: 10, y: 10 }, { nodeId: "b", expectedPositionVersion: 5, x: 7, y: 7 }], { a: { x: 10, y: 10, version: 4 }, b: { x: 7, y: 7, version: 6 } });
  assert.deepEqual(settled.unsavedMoves, { b: { flowId: "f", x: 8, y: 8, expectedVersion: 6 } });
  assert.deepEqual(settled.drops.flatMap((drop) => drop.items.map((item) => item.nodeId)), ["b", "b"], "undo never reverts a saved step");
  // All-or-nothing: a sent item missing from the receipt (it was already there) is saved too.
  assert.deepEqual(settleMoves(recordDrop(clean, "f", [{ nodeId: "a", x: 10, y: 10 }], layout), [{ nodeId: "a", expectedPositionVersion: 3, x: 10, y: 10 }], {}), clean);
});

test("forgetting steps (deleted, or the person kept the saved positions) drops their unsaved moves and undo history", () => {
  const moves = recordDrop(clean, "f", [{ nodeId: "a", x: 10, y: 10 }, { nodeId: "b", x: 7, y: 7 }], layout);
  const kept = forgetMoves(moves, ["a"]);
  assert.deepEqual(Object.keys(kept.unsavedMoves), ["b"]);
  assert.deepEqual(kept.drops, [{ flowId: "f", items: [{ nodeId: "b", prior: null }] }]);
  assert.deepEqual(forgetMoves(kept, ["b"]), clean);
});

test("the leave guard counts unsaved moves and an unresolved move not already counted", () => {
  const moves = recordDrop(clean, "f", [{ nodeId: "a", x: 10, y: 10 }, { nodeId: "b", x: 7, y: 7 }], layout);
  assert.equal(studioDirtyCount({ ...defaultStudioUi, ...moves }), 2);
  const command = { mode: "MOVE_NODES" as const, flowId: "f", items: [{ nodeId: "a", expectedPositionVersion: 3, x: 10, y: 10 }] };
  const attempt = { draftId: "d", flowId: "f", command, key: "k", before: { a: { x: 0, y: 0 } }, undo: false, state: "uncertain" as const };
  assert.equal(studioDirtyCount({ ...defaultStudioUi, ...moves, attempt }), 2, "its steps are already unsaved moves");
  assert.equal(studioDirtyCount({ ...defaultStudioUi, attempt: { ...attempt, undo: true } }), 1, "an unconfirmed undo still counts");
});
