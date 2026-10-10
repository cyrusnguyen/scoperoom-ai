import assert from "node:assert/strict";
import test from "node:test";
import { defaultReviewUi, reserveReview, settleReview, previewMatches, joinReviewPage } from "../src/features/reviews/ui/review-state.ts";
const attempt = { key: "one", method: "POST" as const, path: "reviews/r/withdraw", body: { expectedReviewVersion: 1, reason: "Submitted" }, label: "Withdraw candidate", acknowledged: false };
test("review reservation persists exact body across remount and blocks a second action", () => {
  const ui = reserveReview(defaultReviewUi, attempt)!;
  assert.equal(ui.pending, attempt);
  assert.equal(reserveReview(ui, { ...attempt, key: "two" }), null);
  assert.equal(settleReview(ui, "other", "saved", "Saved"), ui);
});
test("acknowledged refresh failure stays acknowledged and duplicate settlement preserves newer reason", () => {
  const ui = { ...reserveReview(defaultReviewUi, attempt)!, reason: "Newer input" };
  const ack = settleReview(ui, "one", "acknowledged", "Acknowledged");
  const failed = settleReview(ack, "one", "uncertain", "Unknown");
  assert.equal(failed.pending?.acknowledged, true);
  assert.match(failed.message, /acknowledged/);
  const saved = settleReview(failed, "one", "saved", "Saved");
  assert.equal(saved.reason, "Newer input");
  assert.equal(settleReview({ ...saved, reason: "Later" }, "one", "saved", "Saved").reason, "Later");
  assert.equal(settleReview({ ...ui, reason: "Submitted" }, "one", "saved", "Saved").reason, "");
});
test("preview requires original draft, all four guards and no dirty local changes", () => {
  const guards = { expectedDocumentRevision: 2, expectedLayoutRevision: 3, expectedParentSnapshotId: null, expectedApprovalPolicyVersion: 4 };
  const status = { currentDraftId: "d", documentRevision: 2, layoutRevision: 3, approvedSnapshotId: null, approvalPolicyVersion: 4 };
  assert.equal(previewMatches({ draftId: "d", guards }, status, false), true);
  for (const change of [{currentDraftId:"other"},{documentRevision:3},{layoutRevision:4},{approvedSnapshotId:"s"},{approvalPolicyVersion:5}]) assert.equal(previewMatches({ draftId: "d", guards }, { ...status, ...change }, false), false);
  assert.equal(previewMatches({ draftId: "d", guards }, status, true), false);
});
test("history pages join only the requested cursor and revision", () => {
  const first = { items: [], nextCursor: "a", reviewsRevision: 2 };
  const next = { items: [], nextCursor: null, reviewsRevision: 2 };
  assert.deepEqual(joinReviewPage(first, next, "a"), next);
  assert.equal(joinReviewPage(first, next, "b"), first);
  assert.equal(joinReviewPage(first, {...next,reviewsRevision:3}, "a"), first);
});

test("receipt coverage requires the exact review and both history and detail floors", async () => {
  const {reviewReceiptCovered}=await import("../src/features/reviews/ui/review-state.ts");
  const receipt={reviewId:"one",eventSequence:9},page={items:[],nextCursor:null,reviewsRevision:9};
  assert.equal(reviewReceiptCovered(receipt,page,{reviewId:"one",lastEventSequence:9}),true);
  assert.equal(reviewReceiptCovered(receipt,{...page,reviewsRevision:8},{reviewId:"one",lastEventSequence:9}),false);
  assert.equal(reviewReceiptCovered(receipt,page,{reviewId:"other",lastEventSequence:9}),false);
  assert.equal(reviewReceiptCovered(receipt,page,{reviewId:"one",lastEventSequence:8}),false);
});

test("competing covering reads settle only the exact trusted acknowledgement and retain newer reason",async()=>{
  const {settleCoveredReview}=await import("../src/features/reviews/ui/review-state.ts");
  const receipt={reviewId:"r",eventSequence:9},page={items:[],nextCursor:null,reviewsRevision:9},detail={reviewId:"r",lastEventSequence:9};
  const ui={...reserveReview(defaultReviewUi,{...attempt,acknowledged:true,receipt})!,reason:"Newer reason"};
  assert.equal(settleCoveredReview(ui,"wrong",page,detail),ui);
  assert.equal(settleCoveredReview(ui,"one",{...page,reviewsRevision:8},detail),ui);
  const settled=settleCoveredReview(ui,"one",page,detail);assert.equal(settled.pending,null);assert.equal(settled.reason,"Newer reason");
  assert.equal(settleCoveredReview({...ui,pending:{...attempt,acknowledged:true}},"one",page,detail).pending?.key,"one");
  assert.equal(settleCoveredReview({...ui,pending:{...attempt,acknowledged:false,receipt}},"one",page,detail).pending?.key,"one");
});
