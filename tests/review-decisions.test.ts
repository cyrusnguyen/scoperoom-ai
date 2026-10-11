import assert from "node:assert/strict";
import test from "node:test";
import { parseDecision, parseDecisionResult, parseReviewDecision } from "../src/features/reviews/contracts/review.ts";

const HASH = "a".repeat(64);
const UUID = "11111111-1111-4111-8111-111111111111";
const input = { decision: "APPROVE", expectedReviewVersion: 1, expectedReviewHash: HASH };
const result = {
  reviewId: UUID, decisionId: UUID, reviewVersion: 2, state: "APPROVED", publicationSequence: 1,
  publishedAt: "2026-10-10T00:00:00.000Z", approvedSnapshotId: UUID, baselineSequence: 1,
  draftId: UUID, documentRevision: 3, layoutRevision: 4, eventSequence: 5,
};

test("negative decisions require a nonblank reason bounded by Unicode code points", () => {
  for (const decision of ["REQUEST_CHANGES", "REJECT"]) {
    for (const reason of [undefined, "", "  \n\t", "\u00a0\u2003", "😀".repeat(4001)])
      assert.throws(() => parseDecision({ ...input, decision, ...(reason === undefined ? {} : { reason }) }), /INVALID_INPUT/);
    assert.equal(parseDecision({ ...input, decision, reason: "😀".repeat(4000) }).reason, "😀".repeat(4000));
    assert.equal(parseDecision({ ...input, decision, reason: " Preserve exact reason \n" }).reason, " Preserve exact reason \n");
  }
});

test("approval permits absent or empty reason and still validates supplied text", () => {
  assert.deepEqual(parseDecision(input), input);
  assert.deepEqual(parseDecision({ ...input, reason: "" }), { ...input, reason: "" });
  for (const reason of [null, 12, "😀".repeat(4001), "\ud800", "\u0000"])
    assert.throws(() => parseDecision({ ...input, reason }), /INVALID_INPUT/);
});

test("decision requests reject injected authority, unknown keys and invalid guards", () => {
  for (const value of [null, [], Object.create(null), {}, { ...input, decision: "WITHDRAW" },
    ...["actorId", "projectId", "reviewId", "payload", "comment", "replayed"].map(key => ({ ...input, [key]: UUID })),
    ...[0, -1, 1.5, "1", 2147483648, NaN].map(expectedReviewVersion => ({ ...input, expectedReviewVersion })),
    ...[HASH.toUpperCase(), "a".repeat(63), "a".repeat(65), "g".repeat(64), null].map(expectedReviewHash => ({ ...input, expectedReviewHash }))])
    assert.throws(() => parseDecision(value), /INVALID_INPUT/);
});

test("decision records retain exact attribution and reject invalid UUID, hash and comments", () => {
  const row = { id: UUID, projectId: UUID, reviewId: UUID, actorId: UUID, actorDisplayName: "Named actor", actorRole: "REVIEWER", decision: "REJECT", comment: "Reason", reviewedHash: HASH, createdAt: result.publishedAt };
  assert.deepEqual(parseReviewDecision(row), row);
  assert.deepEqual(parseReviewDecision({ ...row, decision: "APPROVE", comment: null }), { ...row, decision: "APPROVE", comment: null });
  for (const key of ["id", "projectId", "reviewId", "actorId"])
    assert.throws(() => parseReviewDecision({ ...row, [key]: "invalid" }), /INVALID_INPUT/);
  for (const change of [{ comment: null }, { comment: "  " }, { reviewedHash: HASH.toUpperCase() }, { createdAt: "invalid" }, { reason: "injected" }])
    assert.throws(() => parseReviewDecision({ ...row, ...change }), /INVALID_INPUT/);
});

test("decision receipts validate publication consistency and keep replay in the envelope", () => {
  assert.deepEqual(parseDecisionResult(result), result);
  for (const state of ["CHANGES_REQUESTED", "REJECTED"])
    assert.deepEqual(parseDecisionResult({ ...result, state, publicationSequence: null, publishedAt: null }), { ...result, state, publicationSequence: null, publishedAt: null });
  assert.deepEqual(parseDecisionResult({ ...result, state: "REJECTED", publicationSequence: null, publishedAt: null, approvedSnapshotId: null, baselineSequence: 0 }), { ...result, state: "REJECTED", publicationSequence: null, publishedAt: null, approvedSnapshotId: null, baselineSequence: 0 });
  for (const change of [{ replayed: true }, { snapshotId: UUID }, { draftId: "invalid" }, { state: "OPEN" }, { reviewVersion: 0 }, { eventSequence: -1 }, { baselineSequence: 0 }, { approvedSnapshotId: null }, { publicationSequence: null }, { publishedAt: null }, { publicationSequence: 2 }, { state: "REJECTED" }])
    assert.throws(() => parseDecisionResult({ ...result, ...change }), /INVALID_INPUT/);
});

test("decision attribution is captured as a strict nullable pair for legacy records", () => {
  const row = { id: UUID, projectId: UUID, reviewId: UUID, actorId: UUID, actorDisplayName: "Named actor", actorRole: "OWNER", decision: "APPROVE", comment: null, reviewedHash: HASH, createdAt: result.publishedAt };
  assert.deepEqual(parseReviewDecision(row), row);
  const legacy = { ...row, actorDisplayName: null, actorRole: null };
  assert.deepEqual(parseReviewDecision(legacy), legacy);
  for (const change of [{ actorDisplayName: null }, { actorRole: null }, { actorRole: "VIEWER" }, { actorDisplayName: "" }, { actorDisplayName: "x".repeat(121) }, { actorDisplayName: "\ud800" }])
    assert.throws(() => parseReviewDecision({ ...row, ...change }), /INVALID_INPUT/);
});
