import assert from "node:assert/strict";
import { test } from "node:test";
import { selectOperations } from "../src/features/proposals/domain/select-operations.ts";
import { validateResult } from "../src/features/proposals/domain/validate-result.ts";
import { goodGenerate, resultFixture } from "./support/ai-results.ts";

const f = resultFixture();
const result = validateResult(f.generate(), goodGenerate(f.sourceVersionId));
if (result.kind !== "proposal") throw new Error("fixture");
const operations = result.operations;

test("selection requires the whole dependency closure and returns stable topological order", () => {
  assert.throws(() => selectOperations(operations, ["op4"]), /DEPENDENCY/);
  assert.deepEqual(selectOperations([...operations].reverse(), ["op4", "op3", "op2", "op1"]).map(x => x.id), ["op1", "op2", "op3", "op4"]);
  assert.deepEqual(selectOperations(operations, []), []);
  assert.throws(() => selectOperations(operations, ["unknown"]), /DEPENDENCY/);
  assert.throws(() => selectOperations(operations, ["op1", "op1"]), /DEPENDENCY/);
});

test("application derives creation dependencies without altering stored dependsOn", () => {
  const copy = structuredClone(operations).map(op => ({ ...op, dependsOn: [] }));
  assert.throws(() => selectOperations(copy, ["op4"]), /DEPENDENCY/);
  assert.deepEqual(selectOperations(copy, copy.map(x => x.id)).map(x => x.id), ["op1", "op2", "op3", "op4"]);
  assert.deepEqual(copy.map(x => x.dependsOn), [[], [], [], []]);
});

test("malformed stored dependencies fail even outside selection", () => {
  assert.throws(() => selectOperations([...operations, operations[0]!], []), /DEPENDENCY/);
  assert.throws(() => selectOperations([{ ...operations[0]!, dependsOn: ["ghost"] }], []), /DEPENDENCY/);
  assert.throws(() => selectOperations([{ ...operations[0]!, dependsOn: ["op2"] }, operations[1]!], []), /DEPENDENCY/);
});
