import assert from "node:assert/strict";
import test from "node:test";
import type { DraftLayout } from "../src/features/drafts/contracts/draft-layout.ts";
import { canUndo, moveTargets } from "../src/features/studio/ui/studio-ui.ts";

const layout: DraftLayout = { schemaVersion: 1, positions: { a: { x: 0, y: 0, version: 3 }, b: { x: 100, y: 0, version: 5 } }, directions: {} };

test("a drag saves only steps that moved, rounded to whole pixels", () => {
  assert.deepEqual(moveTargets([{ id: "a", position: { x: 0.4, y: -0.2 } }, { id: "b", position: { x: 140.6, y: 20 } }, { id: "gone", position: { x: 1, y: 1 } }], layout), [{ nodeId: "b", x: 141, y: 20 }]);
});

test("undo is offered only while every moved step still has the version the move saved", () => {
  assert.equal(canUndo(null, layout), false);
  assert.equal(canUndo({ flowId: "f", items: [] }, layout), false);
  assert.equal(canUndo({ flowId: "f", items: [{ nodeId: "a", x: 9, y: 9, version: 3 }, { nodeId: "b", x: 9, y: 9, version: 5 }] }, layout), true);
  assert.equal(canUndo({ flowId: "f", items: [{ nodeId: "a", x: 9, y: 9, version: 3 }, { nodeId: "b", x: 9, y: 9, version: 4 }] }, layout), false, "someone moved b since");
  assert.equal(canUndo({ flowId: "f", items: [{ nodeId: "gone", x: 9, y: 9, version: 1 }] }, layout), false, "a deleted step cannot be undone");
});
