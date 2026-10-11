import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVerifiedEmail, validateInvitationAcceptInput, validateInvitationIssueInput } from "../src/features/projects/contracts/invitation.ts";

const key = "k".repeat(16);
const token = "A".repeat(43);
const invitationId = "32d54e1d-68c7-4ccd-a4e6-812efa17df8e";

test("emails normalize exactly, without dot or plus collapsing", () => {
  assert.equal(normalizeVerifiedEmail("  First.Last+Tag@Example.TEST "), "first.last+tag@example.test");
});

test("acceptance takes exactly one of token or invitationId", () => {
  assert.deepEqual(validateInvitationAcceptInput({ token, key }), { token, key });
  assert.deepEqual(validateInvitationAcceptInput({ invitationId, key }), { invitationId, key });
  assert.throws(() => validateInvitationAcceptInput({ token, invitationId, key }), /INVALID_INPUT/);
  assert.throws(() => validateInvitationAcceptInput({ key }), /INVALID_INPUT/);
  assert.throws(() => validateInvitationAcceptInput({ invitationId: "nope", key }), /INVALID_INPUT/);
});

test("issuance accepts only invited roles and rejects extra fields", () => {
  assert.deepEqual(validateInvitationIssueInput({ verifiedEmail: "a@example.test", role: "EDITOR", key }), { verifiedEmail: "a@example.test", role: "EDITOR", key });
  assert.throws(() => validateInvitationIssueInput({ verifiedEmail: "a@example.test", role: "OWNER", key }), /INVALID_INPUT/);
  assert.throws(() => validateInvitationIssueInput({ verifiedEmail: "a@example.test", role: "EDITOR", key, workspaceId: invitationId }), /INVALID_INPUT/);
});

test("invitation email rejects NUL and malformed Unicode and keeps its UTF-16 bound", () => {
  for (const part of ["bad\u0000", "bad\ud800", "bad\udc00"])
    assert.throws(() => normalizeVerifiedEmail(part + "@example.test"), /INVALID_INPUT/);
  assert.equal(normalizeVerifiedEmail("😀".repeat(120) + "@example.test").length, 253);
  assert.throws(() => normalizeVerifiedEmail("😀".repeat(121) + "@example.test"), /INVALID_INPUT/);
});
