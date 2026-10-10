"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import { useReviewSyncReader, useSync } from "@/features/collaboration/ui/sync-context";
import { exportSaveBlocker } from "@/features/exports/ui/export-state";
import { useStudio } from "@/features/studio/ui/studio-context";
import { tabListKeyDown } from "@/features/shell/ui/right-panel";
import type { ProjectStatusView } from "@/features/projects/contracts/project";
import type { ReviewDetail, ReviewPage, ReviewPreview } from "../contracts/review";
import { joinReviewPage, previewMatches, reviewReceiptCovered, settleCoveredReview, type ReviewReceipt, type ReviewUi } from "./review-state";
import { useReviewWrite } from "./use-review-write";
import { candidateErrorText } from "./candidate-error-text";
import CandidateReader from "./candidate-reader";

const SECTIONS = ["current", "history"] as const;
export default function ReviewPanel({ ui, update, dirty, onTarget, onSharing, onAccessLost }: {
  ui: ReviewUi; update: (change: (ui: ReviewUi) => Partial<ReviewUi>) => void; dirty: () => boolean;
  onTarget: (id: string) => void; onSharing: () => void; onAccessLost: () => void;
}) {
  const studio = useStudio(), sync = useSync();
  const { fence } = sync;
  const projectId = studio.projectId;
  const [page, setPage] = useState<ReviewPage | null>(null), [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [preview, setPreview] = useState<ReviewPreview | null>(null), [previewBusy, setPreviewBusy] = useState(false);
  const [listError, setListError] = useState(""), [detailError, setDetailError] = useState("");
  const readError = listError || detailError;
  const [previewError, setPreviewError] = useState("");
  const mounted = useRef(true), listTicket = useRef(0), detailTicket = useRef(0);
  const detailSignature = useRef("");
  const current = useRef({ ui, dirty, status: sync.status, page, onAccessLost, update });
  useLayoutEffect(() => { current.current = { ui, dirty, status: sync.status, page, onAccessLost, update }; });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false;  }; }, []);
  const refresh = useCallback(async (cursor?: string, status?: ProjectStatusView, originFence?: () => boolean, receipt?: ReviewReceipt): Promise<boolean> => {
    const ticket = ++listTicket.current, live = originFence ?? fence();
    const expected = Math.max(status?.reviewsRevision ?? current.current.status.reviewsRevision, (receipt ?? current.current.ui.pending?.receipt)?.eventSequence ?? 0);
    const base = current.current.page;
    const result = await apiRead<ReviewPage>(`/api/projects/${projectId}/reviews${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!mounted.current || ticket !== listTicket.current || !live()) return false;
    if (sessionEnded(result)) return false;
    if (!result.ok) { setListError(result.message); if (result.status === 403 || result.status === 404) { setPage(null); setDetail(null); setPreview(null); current.current.onAccessLost(); } return false; }
    if (result.data.reviewsRevision < expected) { setListError("Saved reviews are still refreshing. Retry."); return false; }
    if (cursor && (!base || current.current.page !== base || result.data.reviewsRevision !== base.reviewsRevision)) return false;
    const next = cursor && base ? joinReviewPage(base, result.data, cursor) : result.data;
    current.current = { ...current.current, page: next };
    setPage(next); setListError("");
    return true;
  }, [projectId, fence]);
  useEffect(() => { queueMicrotask(() => { if (mounted.current) void refresh(); }); }, [refresh]);
  const readDetail = useCallback(async (id: string, live = fence(), receipt?: ReviewReceipt): Promise<boolean> => {
    const ticket = ++detailTicket.current;
    const floor = receipt ?? current.current.ui.pending?.receipt;
    const key = current.current.ui.pending?.key;
    const status = current.current.status;
    const signature = `${status.currentDraftId}:${status.documentRevision}:${status.layoutRevision}`;
    const result = await apiRead<ReviewDetail>(`/api/projects/${projectId}/reviews/${id}`);
    if (!mounted.current || !live() || ticket !== detailTicket.current || current.current.ui.selectedReviewId !== id) return false;
    const now = current.current.status;
    if (signature !== `${now.currentDraftId}:${now.documentRevision}:${now.layoutRevision}`) return false;
    if (sessionEnded(result)) return false;
    // A failed or below-floor read must retry on the next shared status cycle, even without draft drift.
    detailSignature.current = "";
    if (!result.ok) { setDetailError(result.message); setDetail(null); if (result.status === 403 || result.status === 404) { setPage(null); setPreview(null); current.current.onAccessLost(); } return false; }
    if (result.data.review.reviewId !== id || (floor?.reviewId === id && (!current.current.page || !reviewReceiptCovered(floor, current.current.page, result.data.review)))) { setDetailError("Saved candidate is still refreshing. Retry."); return false; }
    detailSignature.current = signature;
    setDetail(result.data); setDetailError("");
    const admittedPage = current.current.page;
    if (key && admittedPage) current.current.update(ui => settleCoveredReview(ui, key, admittedPage, result.data.review));
    return true;
  }, [projectId, fence]);
  useEffect(() => { if (ui.selectedReviewId) { const id = ui.selectedReviewId; queueMicrotask(() => { if (mounted.current) void readDetail(id); }); } }, [ui.selectedReviewId, readDetail]);
  const reconcile = useCallback(async (status: ProjectStatusView, live: () => boolean) => {
    current.current = { ...current.current, status };
    const listChanged = !current.current.page || current.current.page.reviewsRevision !== status.reviewsRevision;
    const signature = `${status.currentDraftId}:${status.documentRevision}:${status.layoutRevision}`;
    if (listChanged) await refresh(undefined, status, live);
    if (current.current.ui.selectedReviewId && (listChanged || signature !== detailSignature.current)) await readDetail(current.current.ui.selectedReviewId, live);
  }, [refresh, readDetail]);
  useReviewSyncReader(reconcile);
  const write = useReviewWrite(ui, update, () => current.current.dirty(), async receipt => {
    const ok = await refresh(undefined, undefined, undefined, receipt);
    return ok && await readDetail(receipt.reviewId, fence(), receipt);
  }, onAccessLost);
  async function prepare(saveFirst: boolean) {
    if (previewBusy || write.busy || ui.pending) return;
    const blocker = exportSaveBlocker(studio.ui, studio.dragging);
    if (blocker || studio.busy) { setPreviewError(blocker ?? "Wait for the current Studio write to finish."); return; }
    if (dirty()) { setPreviewError("Submit or discard your unsaved form fields and resolve pending writes before previewing saved scope."); return; }
    setPreviewBusy(true); setPreview(null); setPreviewError("");
    const live = fence();
    try {
      const saved = await studio.inspectSavedExport(saveFirst);
      if (!mounted.current || !live()) return;
      if (!saved.ok) { setPreviewError(saved.message); return; }
      if (current.current.dirty()) { setPreviewError("New unsaved fields appeared. Resolve them before previewing."); return; }
      const authority = await sync.beforeWrite();
      if (!mounted.current || !live() || authority.kind !== "current") return;
      const body = { expectedDocumentRevision: saved.result.documentRevision, expectedLayoutRevision: saved.result.layoutRevision, expectedParentSnapshotId: authority.status.approvedSnapshotId, expectedApprovalPolicyVersion: authority.status.approvalPolicyVersion };
      const result = await apiMutate<ReviewPreview>(`/api/projects/${studio.projectId}/drafts/${saved.result.id}/review-preview`, null, body);
      if (!mounted.current || !live()) return;
      if (sessionEnded(result)) return;
      if (result.ok) setPreview(result.data);
      else { setPreviewError(String(result.details?.reason ?? result.message)); if (result.status === 403 || result.status === 404) current.current.onAccessLost(); }
    } finally { if (mounted.current) setPreviewBusy(false); }
  }
  const canWrite = sync.status.status === "ACTIVE" && ["OWNER", "EDITOR"].includes(sync.status.role);
  const selected = detail?.review.reviewId === ui.selectedReviewId ? detail : null;
  const eligible = preview && previewMatches(preview, sync.status, studio.exportDirty || dirty());
  const document = studio.savedDraft.document;
  const select = (id: string | null) => { detailTicket.current++; setDetail(null); setDetailError(""); update(() => ({ selectedReviewId: id })); if (!id) requestAnimationFrame(() => window.document.getElementById(`review-row-${ui.selectedReviewId}`)?.focus()); };
  return <div className="specs-panel review-panel">
    <div className="specs-tabs" role="tablist" aria-label="Review sections">
      {SECTIONS.map((section, index) => <button key={section} type="button" role="tab"
        id={`review-tab-${section}`} aria-controls={`review-body-${section}`}
        aria-selected={ui.section === section} tabIndex={ui.section === section ? 0 : -1}
        data-active={ui.section === section} onClick={() => update(() => ({ section }))}
        onKeyDown={event => {
          event.stopPropagation();
          tabListKeyDown(event, SECTIONS, index, section => update(() => ({ section })));
        }}>{section === "current" ? "Current" : "History"}</button>)}
    </div>
    {ui.message && <p role={ui.pending ? "alert" : "status"}>
      {ui.message}
      {ui.pending && !write.busy && <button type="button" className="button small" onClick={() => void write.retry()}>
        {ui.pending.acknowledged ? "Refresh" : "Retry"}
      </button>}
    </p>}
    {write.busy && <p role="status">Saving review action…</p>}
    {readError && <p role="alert">{readError} <button type="button" className="button small" onClick={() => {
      void refresh();
      if (ui.selectedReviewId) void readDetail(ui.selectedReviewId);
    }}>Retry reviews</button></p>}
    <div id={`review-body-${ui.section}`} role="tabpanel" aria-labelledby={`review-tab-${ui.section}`}>
      {ui.section === "current" ? <>
        <h2>Review saved scope</h2>
        <p>Only saved work is captured. Another person’s unsent edits are not included.</p>
        <dl className="detail-facts">
          <dt>Saved revisions</dt><dd>Document {studio.savedDraft.documentRevision}, layout {studio.savedDraft.layoutRevision}</dd>
          <dt>Designated approver</dt><dd>{sync.status.designatedApproverId ?? "Not assigned"}</dd>
          <dt>Included flows</dt><dd>{Object.values(document.flows).filter(f => f.inclusion === "INCLUDED").length}</dd>
          <dt>Included requirements</dt><dd>{Object.values(document.requirements).filter(r => r.inclusion === "INCLUDED").length}</dd>
        </dl>
        <button type="button" className="button quiet small" onClick={onSharing}>Project sharing and approver</button>
        {sync.status.status === "ACTIVE" && <>
          <button type="button" className="button" disabled={previewBusy || write.busy || !!ui.pending}
            onClick={() => void prepare(false)}>Preview saved scope</button>
          {canWrite && studio.unsaved && <button type="button" className="button" disabled={previewBusy || write.busy || !!ui.pending}
            onClick={() => void prepare(true)}>Save Studio changes and preview</button>}
        </>}
        {!canWrite && <p>You can inspect saved scope and candidates. Freezing and withdrawal require an owner or editor.</p>}
        {previewBusy && <p role="status">Preparing saved preview…</p>}
        {previewError && <p role="alert">{previewError}</p>}
        {preview && <section aria-label="Saved candidate preview">
          <h3>Saved candidate preview</h3>
          <p>Document {preview.guards.expectedDocumentRevision}, layout {preview.guards.expectedLayoutRevision} · Approval policy {preview.guards.expectedApprovalPolicyVersion}</p>
          {preview.check.valid ? <p>Saved scope is ready to freeze.</p> : <>
            <p>Resolve these saved-scope checks, then preview again.</p>
            <ul>{preview.check.errors.map((error, index) => <li key={index}>
              {candidateErrorText[error.code]}
              {error.targetId && <button type="button" className="button quiet small"
                onClick={() => onTarget(error.targetId!)}>Inspect item</button>}
            </li>)}</ul>
            {preview.check.truncated && <p>More checks remain. Resolve these and preview again.</p>}
          </>}
          {!eligible && <p>Saved or local changes affected this preview. Preview saved scope again before freezing.</p>}
          {preview.openReviewId && <p>An open candidate already exists. <button type="button" className="button small" onClick={() => {
            update(() => ({ section: "history" }));
            select(preview.openReviewId);
          }}>Read open candidate</button></p>}
          {canWrite && <button type="button" className="button primary"
            disabled={!eligible || !preview.check.valid || !!preview.openReviewId || !!ui.pending || write.busy}
            onClick={() => void write.send(`drafts/${preview.draftId}/reviews`, { ...preview.guards }, "Freeze candidate", preview)}>Freeze candidate</button>}
        </section>}
      </> : ui.selectedReviewId ? <>
        <button type="button" className="button small" onClick={() => select(null)}>Back to history</button>
        {selected ? <>
          <CandidateReader key={selected.snapshot.id} detail={selected} />
          {canWrite && selected.review.state === "OPEN" && <form onSubmit={event => {
            event.preventDefault();
            void write.send(`reviews/${selected.review.reviewId}/withdraw`, {
              expectedReviewVersion: selected.review.reviewVersion, reason: ui.reason,
            }, "Withdraw candidate");
          }}>
            <label htmlFor="withdraw-reason">Withdrawal reason</label>
            <textarea id="withdraw-reason" value={ui.reason} onChange={event => update(() => ({ reason: event.target.value }))} required />
            <button type="submit" className="button danger"
              disabled={write.busy || !!ui.pending || !ui.reason.trim() || [...ui.reason].length > 4000}>Withdraw candidate</button>
          </form>}
        </> : !readError && <p role="status">Loading candidate…</p>}
      </> : <>
        <h2>Candidate history</h2>
        {!page && !readError && <p role="status">Loading reviews…</p>}
        {page && !page.items.length && <p>No frozen candidates yet.</p>}
        <ul className="review-history">{page?.items.map(review => <li key={review.reviewId}>
          <button id={`review-row-${review.reviewId}`} type="button" className="button quiet" onClick={() => select(review.reviewId)}>
            {review.state} · {review.createdAt}<span>{review.reviewId}</span>
          </button>
        </li>)}</ul>
        {page?.nextCursor && <button type="button" className="button small"
          onClick={() => void refresh(page.nextCursor!)}>More candidates</button>}
      </>}
    </div>
  </div>;
}
