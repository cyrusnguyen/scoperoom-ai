import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_STATES } from "../src/features/reviews/contracts/review.ts";
import { approverLabel, formatUtc, reviewStateLabel, reviewStateTone } from "../src/features/reviews/ui/review-format.ts";

const approver = "10000000-0000-4000-8000-000000000005";
const directory = [
  { profileId: approver, displayName: "Riya Patel", role: "REVIEWER" as const },
  { profileId: "10000000-0000-4000-8000-000000000001", displayName: "Owner", role: "OWNER" as const },
];

test("every review state has a readable label and one tone", () => {
  assert.deepEqual(REVIEW_STATES.map(state => [state, reviewStateLabel(state), reviewStateTone(state)]), [
    ["OPEN", "Open", "open"], ["APPROVED", "Approved", "approved"], ["CHANGES_REQUESTED", "Changes requested", "pending"],
    ["REJECTED", "Rejected", "rejected"], ["WITHDRAWN", "Withdrawn", "closed"], ["SUPERSEDED", "Superseded", "closed"], ["STALE", "Stale", "closed"],
  ]);
});

test("stored instants render as fixed UTC text and unparseable input is shown as stored", () => {
  assert.equal(formatUtc("2026-10-07T09:05:00.000Z"), "7 Oct 2026, 09:05 UTC");
  assert.equal(formatUtc("2026-12-31T23:59:59.999Z"), "31 Dec 2026, 23:59 UTC");
  assert.equal(formatUtc("not a date"), "not a date");
});

test("designated approver shows name and role, and an unknown or unassigned approver never shows undefined", () => {
  assert.equal(approverLabel(approver, directory), "Riya Patel · Reviewer");
  assert.equal(approverLabel(null, directory), "Not assigned");
  assert.equal(approverLabel(approver, null), `Member ${approver}`);
  assert.equal(approverLabel(approver, directory.slice(1)), `Member ${approver}`);
});
