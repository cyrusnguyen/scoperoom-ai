"use client";
import type { PendingWork } from "./pending-work";
import type { ReviewTone } from "./review-format";

export type SavedComparisonProps = { work: PendingWork; baselineSequence: number | null; baselineError: string; unsent: boolean; onRetry: () => void };

const toneOf = (work: PendingWork): ReviewTone =>
  work.kind === "unavailable" ? "pending" : work.kind === "unapproved" ? "closed" : work.semantic ? "pending" : "approved";

/** The saved draft against the current approved baseline; unsent local work is reported separately and never as approved. */
export default function SavedComparison({ work, baselineSequence, baselineError, unsent, onRetry }: SavedComparisonProps) {
  return <section className="review-card" aria-label="Saved work against current baseline">
    <div className="review-card-header">
      <h3>Saved work against current baseline</h3>
      {baselineSequence !== null && <span className="badge review-state" data-tone="approved">Baseline {baselineSequence}</span>}
    </div>
    <div className="review-callout" data-tone={toneOf(work)}>
      {work.kind === "unavailable" ? <p role="status">Saved comparison is unavailable or still refreshing. {baselineError}
        <button type="button" className="button quiet small" onClick={onRetry}>Retry saved comparison</button></p>
        : work.kind === "unapproved" ? <p>No approved baseline yet. Saved scope is not approved.</p>
        : <>
          <p>{work.semantic ? "Saved included scope has changes pending approval." : "Saved included scope matches the current approved baseline."}</p>
          {work.layout && <p>Saved layout has unapproved presentation changes.</p>}
        </>}
    </div>
    {unsent && <p className="review-intro">Unsent edits and typed fields are separate from this saved comparison and are not approved.</p>}
  </section>;
}
