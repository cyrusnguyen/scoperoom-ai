import type { ProjectStatusView } from "../../projects/contracts/project.ts";
import type { ReviewDetail, ReviewPage, ReviewPreview, SnapshotPage } from "../contracts/review.ts";
export type ReviewReceipt = { reviewId: string; eventSequence: number };
export type ReviewRequestAttempt = { key: string; method: "POST"; path: string; body: Record<string, unknown>; label: string; acknowledged: boolean; receipt?: ReviewReceipt };
export type ReviewUi = { section: "current" | "history"; selectedReviewId: string | null; selectedSnapshotId: string | null; pending: ReviewRequestAttempt | null; reason: string; message: string };
export const defaultReviewUi: ReviewUi = { section: "current", selectedReviewId: null, selectedSnapshotId: null, pending: null, reason: "", message: "" };
export const reserveReview = (ui: ReviewUi, pending: ReviewRequestAttempt): ReviewUi | null => ui.pending ? null : { ...ui, pending, message: "" };
export function settleReview(ui: ReviewUi, key: string, outcome: "saved" | "acknowledged" | "uncertain" | "refused", message: string): ReviewUi {
  if (ui.pending?.key !== key) return ui;
  if (outcome === "acknowledged") return { ...ui, pending: { ...ui.pending, acknowledged: true }, message };
  if (outcome === "uncertain") return { ...ui, message: ui.pending.acknowledged ? `${ui.pending.label} was acknowledged. Refresh saved changes to finish.` : message };
  return { ...ui, pending: null, message, reason: outcome === "saved" && ui.reason === ui.pending.body.reason ? "" : ui.reason };
}
export function previewMatches(preview: Pick<ReviewPreview, "draftId" | "guards">, status: Pick<ProjectStatusView, "currentDraftId" | "documentRevision" | "layoutRevision" | "approvedSnapshotId" | "approvalPolicyVersion">, dirty: boolean): boolean {
  const g = preview.guards;
  return !dirty && preview.draftId === status.currentDraftId && g.expectedDocumentRevision === status.documentRevision && g.expectedLayoutRevision === status.layoutRevision && g.expectedParentSnapshotId === status.approvedSnapshotId && g.expectedApprovalPolicyVersion === status.approvalPolicyVersion;
}
export function joinReviewPage(current: ReviewPage, incoming: ReviewPage, cursor: string): ReviewPage {
  return current.nextCursor === cursor && current.reviewsRevision === incoming.reviewsRevision ? { ...incoming, items: [...current.items, ...incoming.items.filter(item => !current.items.some(old => old.reviewId === item.reviewId))] } : current;
}

export const reviewReceiptCovered = (receipt: ReviewReceipt, page: ReviewPage, detail: { reviewId: string; lastEventSequence: number }): boolean => page.reviewsRevision >= receipt.eventSequence && detail.reviewId === receipt.reviewId && detail.lastEventSequence >= receipt.eventSequence;

/** A competing reader may finish first; only this exact stored acknowledged receipt can settle. */
export function settleCoveredReview(ui: ReviewUi, key: string, page: ReviewPage, detail: { reviewId: string; lastEventSequence: number }): ReviewUi {
  const request = ui.pending;
  return request?.key === key && request.acknowledged && request.receipt && reviewReceiptCovered(request.receipt, page, detail)
    ? settleReview(ui, key, "saved", `${request.label}: saved.`) : ui;
}

export function canDecideReview(detail: { review: Pick<ReviewDetail["review"], "state">; snapshot: { policySnapshot: ReviewDetail["snapshot"]["policySnapshot"] }; draftChanges: Pick<ReviewDetail["draftChanges"], "replaced"> }, status: Pick<ProjectStatusView, "status" | "role" | "viewerId" | "designatedApproverId" | "approvalPolicyVersion">): boolean {
  return status.status === "ACTIVE" && ["OWNER", "EDITOR", "REVIEWER"].includes(status.role)
    && detail.review.state === "OPEN" && !detail.draftChanges.replaced
    && status.viewerId === status.designatedApproverId && status.viewerId === detail.snapshot.policySnapshot.designatedApproverId
    && status.approvalPolicyVersion === detail.snapshot.policySnapshot.approvalPolicyVersion;
}

export function joinSnapshotPage(current: SnapshotPage, incoming: SnapshotPage, cursor: string): SnapshotPage {
  return current.nextCursor === cursor && current.baselineSequence === incoming.baselineSequence ? { ...incoming, items: [...current.items, ...incoming.items.filter(item => !current.items.some(old => old.snapshotId === item.snapshotId))] } : current;
}
