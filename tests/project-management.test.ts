import assert from "node:assert/strict";
import test from "node:test";

import { validateApprovalPolicyInput, validateMemberChangeInput, validateMemberRemovalInput, validateProjectArchiveInput, validateProjectSettingsInput } from "../src/features/projects/contracts/management.ts";

test("project-management inputs normalize names and preserve independent expected versions", () => {
  assert.deepEqual(validateProjectSettingsInput({ name: "  Plan\u0301ning  ", expectedSettingsVersion: 3, key: "s".repeat(16) }), {
    name: "Plańning", expectedSettingsVersion: 3, key: "s".repeat(16),
  });
  assert.deepEqual(validateMemberChangeInput({ role: "REVIEWER", expectedMemberVersion: 2, key: "m".repeat(16) }), {
    role: "REVIEWER", expectedMemberVersion: 2, key: "m".repeat(16),
  });
  assert.deepEqual(validateMemberRemovalInput({ expectedMemberVersion: 2, key: "d".repeat(16) }), { expectedMemberVersion: 2, key: "d".repeat(16) });
  assert.deepEqual(validateApprovalPolicyInput({ designatedApproverId: null, expectedApprovalPolicyVersion: 5, key: "a".repeat(16) }), {
    designatedApproverId: null, expectedApprovalPolicyVersion: 5, key: "a".repeat(16),
  });
  assert.deepEqual(validateProjectArchiveInput({ expectedProjectVersion: 4, reason: "  Finished  ", key: "r".repeat(16) }), {
    expectedProjectVersion: 4, reason: "Finished", key: "r".repeat(16),
  });
});

test("project-management inputs reject owner grants, malformed keys, and stale-value shapes", () => {
  assert.throws(() => validateMemberChangeInput({ role: "OWNER", expectedMemberVersion: 2, key: "m".repeat(16) }), /INVALID_INPUT/);
  assert.throws(() => validateMemberRemovalInput({ expectedMemberVersion: 0, key: "d".repeat(16) }), /INVALID_INPUT/);
  assert.throws(() => validateProjectArchiveInput({ expectedProjectVersion: 1, reason: "   ", key: "r".repeat(16) }), /INVALID_INPUT/);
  assert.throws(() => validateProjectSettingsInput({ name: "", expectedSettingsVersion: 1, key: "s".repeat(16) }), /INVALID_INPUT/);
  assert.throws(() => validateApprovalPolicyInput({ designatedApproverId: "not-a-uuid", expectedApprovalPolicyVersion: 1, key: "a".repeat(16) }), /INVALID_INPUT/);
  assert.throws(() => validateProjectArchiveInput({ expectedProjectVersion: 0, reason: "", key: "short" }), /INVALID_INPUT/);
});
