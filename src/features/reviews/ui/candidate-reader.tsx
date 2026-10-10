"use client";
import { roleLabel } from "@/features/projects/ui/format";
import type { PublishedSnapshot, ReviewDetail } from "../contracts/review";
import CandidateScope from "./candidate-scope";
import { ReviewStateBadge } from "./review-badges";
import { decisionState, formatUtc } from "./review-format";

const TITLES: Partial<Record<string, string>> = { APPROVED: "Approved candidate", CHANGES_REQUESTED: "Candidate - changes requested", REJECTED: "Candidate - rejected" };

/** One immutable candidate or published baseline: identity, human decision, then the captured scope and evidence. */
export default function CandidateReader({ detail }: { detail: ReviewDetail | PublishedSnapshot }) {
  const { snapshot: s, decision } = detail;
  const published = "publicationSequence" in detail ? detail : null;
  const review = "review" in detail ? detail.review : null;
  const draftChanges = "draftChanges" in detail ? detail.draftChanges : null;
  const state = published ? "APPROVED" : review?.state ?? "OPEN";
  const title = published ? `Approved baseline ${published.publicationSequence}` : TITLES[state] ?? "Candidate - not approved";
  const publicationSequence = published?.publicationSequence ?? review?.publicationSequence ?? null;
  const publishedAt = published?.publishedAt ?? review?.publishedAt ?? null;
  return <article className="candidate-reader" aria-label={published ? "Published baseline" : "Frozen candidate"}>
    <header className="review-card-header"><h2>{title}</h2><ReviewStateBadge state={state} /></header>
    <section className="review-card" aria-label="Captured identity">
      <dl className="review-facts">
        <dt>Captured project name</dt><dd>{s.projectName}</dd>
        <dt>{published ? "Snapshot" : "Candidate"}</dt><dd className="review-id">{s.id}</dd>
        <dt>Review</dt><dd className="review-id">{published?.reviewId ?? review?.reviewId}</dd>
        <dt>Captured</dt><dd><time dateTime={s.createdAt}>{formatUtc(s.createdAt)}</time></dd>
        <dt>Saved revisions</dt><dd>Document {s.capturedDocumentRevision}, layout {s.capturedLayoutRevision}</dd>
        <dt>Parent baseline</dt><dd className="review-id">{s.parentSnapshotId ?? "None"}</dd>
      </dl>
      <details className="review-technical">
        <summary>Integrity and approval policy</summary>
        <dl className="review-facts">
          <dt>Review hash</dt><dd className="review-id">{s.reviewHash}</dd>
          <dt>Content hash</dt><dd className="review-id">{s.contentHash}</dd>
          <dt>Captured approver ID</dt><dd className="review-id">{s.policySnapshot.designatedApproverId}</dd>
          <dt>Approval policy</dt><dd>Version {s.policySnapshot.approvalPolicyVersion}</dd>
        </dl>
      </details>
    </section>
    {draftChanges && (draftChanges.contentChanged || draftChanges.layoutChanged || draftChanges.replaced) && <p className="review-callout" data-tone="pending">The current draft {draftChanges.replaced ? "has been replaced" : "has newer saved changes"}. This captured candidate is unchanged.</p>}
    {decision && <section className="review-card" aria-label="Human decision">
      <div className="review-card-header"><h3>Human decision</h3><ReviewStateBadge state={decisionState(decision.decision)} /></div>
      <dl className="review-facts">
        <dt>Actor</dt><dd>{decision.actorDisplayName ?? "Not captured"}</dd>
        <dt>Actor role</dt><dd>{decision.actorRole ? roleLabel(decision.actorRole) : "Not captured"}</dd>
        {decision.decision === "APPROVE" && decision.actorRole === "OWNER" && <><dt>Approval type</dt><dd>Self/internal approval</dd></>}
        <dt>Decided</dt><dd><time dateTime={decision.createdAt}>{formatUtc(decision.createdAt)}</time></dd>
        {publicationSequence != null && <><dt>Published baseline</dt><dd>{publicationSequence}</dd></>}
        {publishedAt && <><dt>Published</dt><dd><time dateTime={publishedAt}>{formatUtc(publishedAt)}</time></dd></>}
        <dt>Actor ID</dt><dd className="review-id">{decision.actorId}</dd>
        <dt>Reviewed hash</dt><dd className="review-id">{decision.reviewedHash}</dd>
      </dl>
      {decision.comment && <p className="review-callout">Decision reason: {decision.comment}</p>}
    </section>}
    {!decision && review?.reason && <p className="review-callout" data-tone="closed">Closed reason: {review.reason}</p>}
    <CandidateScope snapshot={s} approved={Boolean(published || review?.state === "APPROVED")} />
  </article>;
}
