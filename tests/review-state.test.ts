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

test("decision eligibility binds current and captured actor without inspecting newer draft revisions", async () => {
  const { canDecideReview } = await import("../src/features/reviews/ui/review-state.ts");
  const detail = { review: { state: "OPEN" as const }, snapshot: { policySnapshot: { designatedApproverId: "actor", approvalPolicyVersion: 2 } }, draftChanges: { replaced: false } };
  const status = { viewerId: "actor", designatedApproverId: "actor", role: "REVIEWER" as const, status: "ACTIVE" as const, approvalPolicyVersion: 2 };
  assert.equal(canDecideReview(detail, status), true);
  for (const change of [{ viewerId: "other" }, { designatedApproverId: "other" }, { role: "VIEWER" }, { status: "ARCHIVED" }, { approvalPolicyVersion: 3 }] as const) assert.equal(canDecideReview(detail, { ...status, ...change }), false);
  assert.equal(canDecideReview({ ...detail, review: { state: "APPROVED" } }, status), false);
  assert.equal(canDecideReview({ ...detail, draftChanges: { replaced: true } }, status), false);
});

test("decision exact request recovery preserves newer input and a refusal preserves submitted input", () => {
  const pending = { ...attempt, path: "reviews/r/decision", body: { decision: "REQUEST_CHANGES", expectedReviewVersion: 1, expectedReviewHash: "a".repeat(64), reason: "Submitted" }, label: "Request changes" };
  const ui = reserveReview({ ...defaultReviewUi, reason: "Submitted" }, pending)!;
  const unknown = settleReview(ui, pending.key, "uncertain", "Retry");
  assert.equal(unknown.pending, pending);
  assert.equal(settleReview(ui, pending.key, "refused", "Not permitted").reason, "Submitted");
  assert.equal(settleReview({ ...unknown, reason: "Newer text" }, pending.key, "saved", "Saved").reason, "Newer text");
});


test("baseline page joins retain exact history identity and reject a changed publication sequence", async () => {
  const {joinSnapshotPage}=await import("../src/features/reviews/ui/review-state.ts");
  const item={snapshotId:"old",reviewId:"r",publicationSequence:1,publishedAt:"time",publishedBy:"actor",reviewHash:"hash"};
  const first={items:[item],nextCursor:"next",baselineSequence:2};
  const next={items:[item,{...item,snapshotId:"older"}],nextCursor:null,baselineSequence:2};
  assert.deepEqual(joinSnapshotPage(first,next,"next").items,[item,next.items[1]]);
  assert.equal(joinSnapshotPage(first,next,"wrong"),first);
  assert.equal(joinSnapshotPage(first,{...next,baselineSequence:3},"next"),first);
  const ui={...defaultReviewUi,selectedSnapshotId:"old"};
  assert.equal(settleReview(ui,"unrelated","saved","Saved").selectedSnapshotId,"old");
});
