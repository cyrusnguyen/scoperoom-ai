import assert from "node:assert/strict";
import test from "node:test";
import { STEP_SIZE } from "../src/features/drafts/contracts/draft-layout.ts";
import { dropTarget, parseShapePayload, SHAPE_DRAG_MIME } from "../src/features/studio/ui/studio-ui.ts";

test("the shape panel drag payload MIME is a stable custom type", () => {
  assert.equal(SHAPE_DRAG_MIME, "application/x-scoperoom-shape");
});

test("a valid shape payload parses to its kind, width and height", () => {
  assert.deepEqual(parseShapePayload(JSON.stringify({ kind: "DATA_STORE", width: 180, height: 110 })), { kind: "DATA_STORE", width: 180, height: 110 });
});

test("an unknown kind, malformed JSON or wrong-typed field is ignored", () => {
  assert.equal(parseShapePayload(JSON.stringify({ kind: "ROCKET", width: 1, height: 1 })), null);
  assert.equal(parseShapePayload("not json"), null);
  assert.equal(parseShapePayload(JSON.stringify({ kind: "START", width: "120", height: 120 })), null);
  assert.equal(parseShapePayload(JSON.stringify(null)), null);
  assert.equal(parseShapePayload(JSON.stringify("START")), null);
});

test("a drop point centres the step on the pointer and rounds to whole pixels", () => {
  assert.deepEqual(dropTarget({ x: 100.4, y: 200.6 }, STEP_SIZE.DATA_STORE), { x: 40, y: 131 });
});

test("a drop point rounds only after centring, matching a saved position", () => {
  const target = dropTarget({ x: 10.5, y: 10.5 }, { width: 21, height: 21 });
  assert.deepEqual(target, { x: 0, y: 0 });
});
