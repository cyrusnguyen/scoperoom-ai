import assert from "node:assert/strict";
import test from "node:test";

import { validateWorkspaceCreateInput } from "../src/features/workspaces/contracts/workspace.ts";

test("workspace input rejects blank names and names longer than 120 code points", () => {
  assert.throws(() => validateWorkspaceCreateInput({ name: "   ", key: "a".repeat(16) }), /INVALID_INPUT/);
  assert.throws(() => validateWorkspaceCreateInput({ name: "😀".repeat(121), key: "a".repeat(16) }), /INVALID_INPUT/);
});

test("workspace input normalizes its name and preserves an opaque idempotency key", () => {
  assert.deepEqual(
    validateWorkspaceCreateInput({ name: "  Plan\u0301ning  ", key: "k".repeat(16) }),
    { name: "Plańning", key: "k".repeat(16) },
  );
});

test("workspace input accepts only 16 to 128 character keys", () => {
  assert.throws(() => validateWorkspaceCreateInput({ name: "Workspace", key: "k".repeat(15) }), /INVALID_INPUT/);
  assert.throws(() => validateWorkspaceCreateInput({ name: "Workspace", key: "k".repeat(129) }), /INVALID_INPUT/);
  assert.deepEqual(validateWorkspaceCreateInput({ name: "Workspace", key: "k".repeat(128) }), { name: "Workspace", key: "k".repeat(128) });
});
