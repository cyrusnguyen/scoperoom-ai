import assert from "node:assert/strict";
import test from "node:test";

import { validateInvitationAcceptInput, validateInvitationIssueInput, validateInvitationRevokeInput } from "../src/features/projects/contracts/invitation.ts";

test("invitation input canonicalizes its verified email and role", () => {
  assert.deepEqual(
    validateInvitationIssueInput({ verifiedEmail: "  Member@Example.Test ", role: "EDITOR", key: "i".repeat(16) }),
    { verifiedEmail: "member@example.test", role: "EDITOR", key: "i".repeat(16) },
  );
});

test("invitation inputs reject unsafe email, role, token, key, and version values", () => {
  assert.throws(() => validateInvitationIssueInput({ verifiedEmail: "wrong", role: "EDITOR", key: "i".repeat(16) }), /INVALID_INPUT/);
  assert.throws(() => validateInvitationIssueInput({ verifiedEmail: `${"a".repeat(244)}@example.test`, role: "EDITOR", key: "i".repeat(16) }), /INVALID_INPUT/);
  assert.throws(() => validateInvitationIssueInput({ verifiedEmail: "member@example.test", role: "OWNER", key: "i".repeat(16) }), /INVALID_INPUT/);
  assert.throws(() => validateInvitationAcceptInput({ token: "short", key: "i".repeat(16) }), /INVALID_INPUT/);
  assert.throws(() => validateInvitationAcceptInput({ token: "t".repeat(43), key: "bad key" }), /INVALID_INPUT/);
  assert.throws(() => validateInvitationRevokeInput({ expectedVersion: 0, key: "i".repeat(16) }), /INVALID_INPUT/);
});
