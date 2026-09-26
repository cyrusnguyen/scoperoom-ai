import assert from "node:assert/strict";
import test from "node:test";
import { validateLeaveInput, validateProjectArchiveInput, validateProjectRestoreInput } from "../src/features/projects/contracts/management.ts";

const key = "k".repeat(16);

test("leave takes only an idempotency key", () => {
  assert.deepEqual(validateLeaveInput({ key }), { key });
  assert.throws(() => validateLeaveInput({ key, expectedMemberVersion: 1 }), /INVALID_INPUT/);
});

test("lifecycle inputs are strict", () => {
  assert.deepEqual(validateProjectArchiveInput({ expectedProjectVersion: 1, reason: " Done ", key }), { expectedProjectVersion: 1, reason: "Done", key });
  assert.throws(() => validateProjectRestoreInput({ expectedProjectVersion: 1, key, reason: "x" }), /INVALID_INPUT/);
});
