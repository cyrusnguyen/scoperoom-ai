import assert from "node:assert/strict";
import test from "node:test";
import { expiryLabel, roleLabel } from "../src/features/projects/ui/format.ts";

test("role labels are sentence case", () => {
  assert.equal(roleLabel("OWNER"), "Owner");
  assert.equal(roleLabel("REVIEWER"), "Reviewer");
});

test("an invitation inside 24 hours says Expires today; a later one shows its date", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  assert.deepEqual(expiryLabel("2026-10-11T11:00:00Z", now), { text: "Expires today", soon: true });
  // Noon UTC keeps the calendar day the same in every zone from UTC-11 to UTC+11.
  assert.deepEqual(expiryLabel("2026-10-15T12:00:00Z", now), { text: "Expires Oct 15", soon: false });
});
