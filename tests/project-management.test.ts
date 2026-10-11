import assert from "node:assert/strict";
import test from "node:test";
import { validateProjectSettingsInput, validateLeaveInput, validateProjectArchiveInput, validateProjectRestoreInput } from "../src/features/projects/contracts/management.ts";

const key = "k".repeat(16);

test("leave takes only an idempotency key", () => {
  assert.deepEqual(validateLeaveInput({ key }), { key });
  assert.throws(() => validateLeaveInput({ key, expectedMemberVersion: 1 }), /INVALID_INPUT/);
});

test("lifecycle inputs are strict", () => {
  assert.deepEqual(validateProjectArchiveInput({ expectedProjectVersion: 1, reason: " Done ", key }), { expectedProjectVersion: 1, reason: "Done", key });
  assert.throws(() => validateProjectRestoreInput({ expectedProjectVersion: 1, key, reason: "x" }), /INVALID_INPUT/);
});

test("project rename and archive reason reject NUL and malformed Unicode", () => {
  for (const value of ["Bad\u0000text", "Bad\ud800text", "Bad\udc00text"]) {
    assert.throws(() => validateProjectSettingsInput({ name: value, expectedSettingsVersion: 1, key }), /INVALID_INPUT/);
    assert.throws(() => validateProjectArchiveInput({ reason: value, expectedProjectVersion: 1, key }), /INVALID_INPUT/);
  }
});
