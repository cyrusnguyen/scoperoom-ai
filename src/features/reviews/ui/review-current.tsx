"use client";
import type { DraftView } from "@/features/drafts/contracts/scope-document";
import { Icon } from "@/features/shell/ui/icon";
import type { ReviewPreview } from "../contracts/review";
import { candidateErrorText } from "./candidate-error-text";

export type ReviewCurrentProps = {
  savedDraft: DraftView; approver: string; active: boolean; canWrite: boolean; unsaved: boolean;
  previewBusy: boolean; writing: boolean; previewError: string; preview: ReviewPreview | null; eligible: boolean;
  onPreview: (saveFirst: boolean) => void; onSharing: () => void; onTarget: (id: string) => void;
  onReadOpen: (reviewId: string) => void; onFreeze: (preview: ReviewPreview) => void;
};

const includedCount = (records: Record<string, { inclusion: string }>) => Object.values(records).filter(record => record.inclusion === "INCLUDED").length;

/** Current: the saved pair a freeze would capture, its bounded checks and the freeze action. */
export default function ReviewCurrent(props: ReviewCurrentProps) {
  const { savedDraft, preview } = props;
  const busy = props.previewBusy || props.writing;
  return <>
    <header className="review-heading">
      <span className="review-mark"><Icon name="check" size={20} /></span>
      <div><h2>Review saved scope</h2><p className="review-intro">Only saved work is captured. Another person’s unsent edits are not included.</p></div>
    </header>
    <section className="review-card" aria-label="Saved scope summary">
      <dl className="review-facts">
        <dt>Saved revisions</dt><dd>Document {savedDraft.documentRevision}, layout {savedDraft.layoutRevision}</dd>
        <dt>Designated approver</dt><dd>{props.approver}</dd>
        <dt>Included flows</dt><dd>{includedCount(savedDraft.document.flows)}</dd>
        <dt>Included requirements</dt><dd>{includedCount(savedDraft.document.requirements)}</dd>
      </dl>
      <div className="review-actions">
        {props.active && <button type="button" className="button" disabled={busy} onClick={() => props.onPreview(false)}>Preview saved scope</button>}
        {props.active && props.canWrite && props.unsaved && <button type="button" className="button" disabled={busy} onClick={() => props.onPreview(true)}>Save Studio changes and preview</button>}
        <button type="button" className="button quiet small" onClick={props.onSharing}>Project sharing and approver</button>
      </div>
      {!props.canWrite && <p className="review-intro">You can inspect saved scope and candidates. Freezing and withdrawal require an owner or editor.</p>}
    </section>
    {props.previewBusy && <p role="status" className="review-callout">Preparing saved preview…</p>}
    {props.previewError && <p role="alert" className="review-callout" data-tone="rejected">{props.previewError}</p>}
    {preview && <PreviewCard {...props} preview={preview} />}
  </>;
}

function PreviewCard({ preview, eligible, canWrite, writing, onTarget, onReadOpen, onFreeze }: ReviewCurrentProps & { preview: ReviewPreview }) {
  const { check, guards } = preview;
  return <section className="review-card" aria-label="Saved candidate preview">
    <div className="review-card-header">
      <h3>Saved candidate preview</h3>
      <span className="badge review-state" data-tone={check.valid ? "open" : "pending"}>{check.valid ? "Ready" : "Needs attention"}</span>
    </div>
    <p className="review-intro">Document {guards.expectedDocumentRevision}, layout {guards.expectedLayoutRevision} · Approval policy {guards.expectedApprovalPolicyVersion}</p>
    {check.valid ? <p>Saved scope is ready to freeze.</p> : <>
      <p>Resolve these saved-scope checks, then preview again.</p>
      <ul className="review-checks">{check.errors.map((error, index) => <li key={index}>
        <span>{candidateErrorText[error.code]}</span>
        {error.targetId && <button type="button" className="button quiet small" onClick={() => onTarget(error.targetId!)}>Inspect item</button>}
      </li>)}</ul>
      {check.truncated && <p className="review-intro">More checks remain. Resolve these and preview again.</p>}
    </>}
    {!eligible && <p className="review-callout" data-tone="pending">Saved or local changes affected this preview. Preview saved scope again before freezing.</p>}
    {preview.openReviewId && <p className="review-callout" data-tone="open">An open candidate already exists. <button type="button" className="button small" onClick={() => onReadOpen(preview.openReviewId!)}>Read open candidate</button></p>}
    {canWrite && <div className="review-actions">
      <button type="button" className="button primary" disabled={!eligible || !check.valid || !!preview.openReviewId || writing} onClick={() => onFreeze(preview)}>Freeze candidate</button>
    </div>}
  </section>;
}
