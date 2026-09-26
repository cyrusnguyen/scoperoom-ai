import assert from "node:assert/strict";
import test from "node:test";
import { validateProjectCreateInput } from "../src/features/projects/contracts/project.ts";

test("project creation input normalizes the name and keeps the key", () => {
  assert.deepEqual(validateProjectCreateInput({ name: "  Plańning  ", key: "k".repeat(16) }), { name: "Plańning", key: "k".repeat(16) });
});

test("project creation input rejects unknown fields, bad names and bad keys", () => {
  const valid = { name: "Project", key: "k".repeat(16) };
  assert.throws(() => validateProjectCreateInput({ ...valid, workspaceId: "32d54e1d-68c7-4ccd-a4e6-812efa17df8e" }), /INVALID_INPUT/);
  assert.throws(() => validateProjectCreateInput({ ...valid, name: "   " }), /INVALID_INPUT/);
  assert.throws(() => validateProjectCreateInput({ ...valid, name: "😀".repeat(121) }), /INVALID_INPUT/);
  assert.throws(() => validateProjectCreateInput({ ...valid, key: "k".repeat(15) }), /INVALID_INPUT/);
  assert.throws(() => validateProjectCreateInput(null), /INVALID_INPUT/);
});
