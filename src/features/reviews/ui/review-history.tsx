"use client";
import type { ReviewPage, SnapshotPage } from "../contracts/review";
import { ReviewStateBadge } from "./review-badges";
import { formatUtc } from "./review-format";

export type ReviewHistoryProps = {
  snapshots: SnapshotPage | null; reviews: ReviewPage | null; loading: boolean;
  onOpenSnapshot: (snapshotId: string) => void; onOpenReview: (reviewId: string) => void;
  onMoreSnapshots: (cursor: string) => void; onMoreReviews: (cursor: string) => void;
};

/** History: approved baselines, newest publication first, then every frozen candidate with its outcome. */
export default function ReviewHistory({ snapshots, reviews, loading, onOpenSnapshot, onOpenReview, onMoreSnapshots, onMoreReviews }: ReviewHistoryProps) {
  return <>
    <section className="review-history" aria-labelledby="review-baselines-heading">
      <div className="review-section-heading">
        <h2 id="review-baselines-heading">Approved baselines</h2>
        {snapshots && <span className="review-count">{snapshots.items.length}{snapshots.nextCursor ? "+" : ""}<span className="sr-only">{snapshots.nextCursor ? " loaded, more available" : " in total"}</span></span>}
      </div>
      {snapshots && !snapshots.items.length && <p className="review-empty">No approved baselines yet.</p>}
      {snapshots && snapshots.items.length > 0 && <ul className="review-list">{snapshots.items.map(item => <li key={item.snapshotId}>
        <button id={`snapshot-row-${item.snapshotId}`} type="button" className="review-row" onClick={() => onOpenSnapshot(item.snapshotId)}>
          <span className="review-row-title">Baseline {item.publicationSequence}</span>
          <ReviewStateBadge state="APPROVED" />
          <time dateTime={item.publishedAt}>Published {formatUtc(item.publishedAt)}</time>
          <span className="review-id">{item.snapshotId}</span>
        </button>
      </li>)}</ul>}
      {snapshots?.nextCursor && <button type="button" className="button small" onClick={() => onMoreSnapshots(snapshots.nextCursor!)}>More baselines</button>}
    </section>
    <section className="review-history" aria-labelledby="review-candidates-heading">
      <div className="review-section-heading">
        <h2 id="review-candidates-heading">Candidate history</h2>
        {reviews && <span className="review-count">{reviews.items.length}{reviews.nextCursor ? "+" : ""}<span className="sr-only">{reviews.nextCursor ? " loaded, more available" : " in total"}</span></span>}
      </div>
      {loading && <p role="status" className="review-intro">Loading reviews…</p>}
      {reviews && !reviews.items.length && <p className="review-empty">No frozen candidates yet.</p>}
      {reviews && reviews.items.length > 0 && <ul className="review-list">{reviews.items.map(item => <li key={item.reviewId}>
        <button id={`review-row-${item.reviewId}`} type="button" className="review-row" onClick={() => onOpenReview(item.reviewId)}>
          <span className="review-row-title">Candidate</span>
          <ReviewStateBadge state={item.state} />
          <time dateTime={item.createdAt}>Frozen {formatUtc(item.createdAt)}</time>
          <span className="review-id">{item.reviewId}</span>
        </button>
      </li>)}</ul>}
      {reviews?.nextCursor && <button type="button" className="button small" onClick={() => onMoreReviews(reviews.nextCursor!)}>More candidates</button>}
    </section>
  </>;
}
