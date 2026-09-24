import assert from "node:assert/strict";
import test from "node:test";

import { validateProjectCreateInput } from "../src/features/projects/contracts/project.ts";

test("project input normalizes an NFC name and retains a valid workspace key", () => {
  assert.deepEqual(
    validateProjectCreateInput({ workspaceId: "32d54e1d-68c7-4ccd-a4e6-812efa17df8e", name: "  Plan\u0301ning  ", key: "k".repeat(16) }),
    { workspaceId: "32d54e1d-68c7-4ccd-a4e6-812efa17df8e", name: "Plańning", key: "k".repeat(16) },
  );
});

test("project input rejects invalid workspace identifiers, names, and keys", () => {
  const valid = { workspaceId: "32d54e1d-68c7-4ccd-a4e6-812efa17df8e", name: "Project", key: "k".repeat(16) };
  assert.throws(() => validateProjectCreateInput({ ...valid, workspaceId: "not-a-uuid" }), /INVALID_INPUT/);
  assert.throws(() => validateProjectCreateInput({ ...valid, name: "   " }), /INVALID_INPUT/);
  assert.throws(() => validateProjectCreateInput({ ...valid, name: "😀".repeat(121) }), /INVALID_INPUT/);
  assert.throws(() => validateProjectCreateInput({ ...valid, key: "k".repeat(15) }), /INVALID_INPUT/);
  assert.throws(() => validateProjectCreateInput({ ...valid, key: "bad key with spaces" }), /INVALID_INPUT/);
});
