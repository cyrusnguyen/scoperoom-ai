"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import { useReviewSyncReader, useSync } from "@/features/collaboration/ui/sync-context";
import { exportSaveBlocker } from "@/features/exports/ui/export-state";
import { useStudio } from "@/features/studio/ui/studio-context";
import { tabListKeyDown } from "@/features/shell/ui/right-panel";
import type { ProjectStatusView } from "@/features/projects/contracts/project";
import type { PublishedSnapshot, SnapshotPage, DecisionInput, ReviewDetail, ReviewPage, ReviewPreview } from "../contracts/review";
import { canDecideReview, joinSnapshotPage, joinReviewPage, previewMatches, reviewReceiptCovered, settleCoveredReview, type ReviewReceipt, type ReviewUi } from "./review-state";
import { useReviewWrite } from "./use-review-write";
import { candidateErrorText } from "./candidate-error-text";
import CandidateReader from "./candidate-reader";
import ApprovedMarkdown from "./approved-markdown";
import { savedPendingWork } from "./pending-work";

const SECTIONS = ["current", "history"] as const;
export default function ReviewPanel({ ui, update, dirty, onTarget, onSharing, onAccessLost }: {
  ui: ReviewUi; update: (change: (ui: ReviewUi) => Partial<ReviewUi>) => void; dirty: () => boolean;
  onTarget: (id: string) => void; onSharing: () => void; onAccessLost: () => void;
}) {
  const studio = useStudio(), sync = useSync();
  const { fence } = sync;
  const projectId = studio.projectId;
  const [page, setPage] = useState<ReviewPage | null>(null), [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [snapshotPage, setSnapshotPage] = useState<SnapshotPage | null>(null), [publishedSnapshot, setPublishedSnapshot] = useState<PublishedSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState("");
  const [currentBaseline, setCurrentBaseline] = useState<PublishedSnapshot | null>(null), [baselineError, setBaselineError] = useState("");
  const baselineTicket = useRef(0), baselineSignature = useRef("");
  const snapshotListTicket = useRef(0), snapshotDetailTicket = useRef(0);
  const [preview, setPreview] = useState<ReviewPreview | null>(null), [previewBusy, setPreviewBusy] = useState(false);
  const [listError, setListError] = useState(""), [detailError, setDetailError] = useState("");
  const readError = listError || detailError || snapshotError;
  const [previewError, setPreviewError] = useState("");
  const mounted = useRef(true), listTicket = useRef(0), detailTicket = useRef(0);
  const detailSignature = useRef("");
  const snapshotSignature = useRef("");
  const current = useRef({ ui, dirty, status: sync.status, page, snapshotPage, onAccessLost, update });
  useLayoutEffect(() => { current.current = { ui, dirty, status: sync.status, page, snapshotPage, onAccessLost, update }; });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false;  }; }, []);
  const refreshSnapshots = useCallback(async (cursor?: string, live = fence()) => {
    const ticket = ++snapshotListTicket.current, base = current.current.snapshotPage;
    const result = await apiRead<SnapshotPage>(`/api/projects/${projectId}/snapshots${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!mounted.current || !live() || ticket !== snapshotListTicket.current || sessionEnded(result)) return false;
    if (!result.ok) { setSnapshotError(result.message); if (result.status === 403 || result.status === 404) { setSnapshotPage(null); setPublishedSnapshot(null); current.current.onAccessLost(); } return false; }
    if (result.data.baselineSequence < current.current.status.baselineSequence) { setSnapshotError("Saved baselines are still refreshing. Retry."); return false; }
    if (cursor && (!base || current.current.snapshotPage !== base || result.data.baselineSequence !== base.baselineSequence)) return false;
    const next = cursor && base ? joinSnapshotPage(base, result.data, cursor) : result.data;
    current.current = { ...current.current, snapshotPage: next };
    setSnapshotPage(next); setSnapshotError(""); return true;
  }, [projectId, fence]);
  const readPublishedSnapshot = useCallback(async (id: string, live = fence()) => {
    const ticket = ++snapshotDetailTicket.current;
    const result = await apiRead<PublishedSnapshot>(`/api/projects/${projectId}/snapshots/${id}`);
    if (!mounted.current || !live() || ticket !== snapshotDetailTicket.current || current.current.ui.selectedSnapshotId !== id || sessionEnded(result)) return;
    snapshotSignature.current = "";
    if (!result.ok) { setSnapshotError(result.message); setPublishedSnapshot(null); if (result.status === 403 || result.status === 404) current.current.onAccessLost(); return; }
    if (result.data.snapshot.id !== id) { setSnapshotError("Saved baseline is still refreshing. Retry."); return; }
    snapshotSignature.current = id;
    setPublishedSnapshot(result.data); setSnapshotError("");
  }, [projectId, fence]);
  useEffect(() => { if (ui.selectedSnapshotId) { const id = ui.selectedSnapshotId; queueMicrotask(() => { if (mounted.current) void readPublishedSnapshot(id); }); } }, [ui.selectedSnapshotId, readPublishedSnapshot]);
  const readCurrentBaseline = useCallback(async (status: ProjectStatusView, live = fence(), force = false) => {
    const id = status.approvedSnapshotId, signature = `${id}:${status.baselineSequence}`;
    if (!force && baselineSignature.current === signature) return;
    const ticket = ++baselineTicket.current;
    if (!id) { baselineSignature.current = signature; setCurrentBaseline(null); setBaselineError(""); return; }
    const result = await apiRead<PublishedSnapshot>(`/api/projects/${projectId}/snapshots/${id}`);
    const now = current.current.status;
    if (!mounted.current || !live() || ticket !== baselineTicket.current || signature !== `${now.approvedSnapshotId}:${now.baselineSequence}` || sessionEnded(result)) return;
    baselineSignature.current = "";
    if (!result.ok) { setBaselineError(result.message); if (result.status === 403 || result.status === 404) { setCurrentBaseline(null); current.current.onAccessLost(); } return; }
    if (result.data.snapshot.id !== id || result.data.publicationSequence !== status.baselineSequence) { setBaselineError("Current approved baseline is still refreshing."); return; }
    baselineSignature.current = signature; setCurrentBaseline(result.data); setBaselineError("");
  }, [projectId, fence]);
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
    if (!cursor) await Promise.all([refreshSnapshots(undefined, live), readCurrentBaseline(status ?? current.current.status, live)]);
    return true;
  }, [projectId, fence, refreshSnapshots, readCurrentBaseline]);
  useEffect(() => { queueMicrotask(() => { if (mounted.current) void refresh(); }); }, [refresh]);
  const readDetail = useCallback(async (id: string, live = fence(), receipt?: ReviewReceipt): Promise<boolean> => {
    // An off-selection receipt proves recovery without taking ownership of the visible reader.
    const ticket = receipt && current.current.ui.selectedReviewId !== id ? null : ++detailTicket.current;
    const floor = receipt ?? current.current.ui.pending?.receipt;
    const key = current.current.ui.pending?.key;
    const status = current.current.status;
    const signature = `${status.currentDraftId}:${status.documentRevision}:${status.layoutRevision}`;
    const result = await apiRead<ReviewDetail>(`/api/projects/${projectId}/reviews/${id}`);
    if (!mounted.current || !live()) return false;
    const presents = ticket !== null && ticket === detailTicket.current && current.current.ui.selectedReviewId === id;
    if (!presents && receipt?.reviewId !== id) return false;
    const now = current.current.status;
    if (signature !== `${now.currentDraftId}:${now.documentRevision}:${now.layoutRevision}`) return false;
    if (sessionEnded(result)) return false;
    // A failed or below-floor read must retry on the next shared status cycle, even without draft drift.
    if (presents) detailSignature.current = "";
    if (!result.ok) { if (presents) { setDetailError(result.message); setDetail(null); } if (result.status === 403 || result.status === 404) { setPage(null); setPreview(null); current.current.onAccessLost(); } return false; }
    if (result.data.review.reviewId !== id || (floor?.reviewId === id && (!current.current.page || !reviewReceiptCovered(floor, current.current.page, result.data.review)))) { if (presents) setDetailError("Saved candidate is still refreshing. Retry."); return false; }
    if (presents) { detailSignature.current = signature; setDetail(result.data); setDetailError(""); }
    const admittedPage = current.current.page;
    if (key && admittedPage) current.current.update(ui => settleCoveredReview(ui, key, admittedPage, result.data.review));
    return true;
  }, [projectId, fence]);
  useEffect(() => { if (ui.selectedReviewId) { const id = ui.selectedReviewId; queueMicrotask(() => { if (mounted.current) void readDetail(id); }); } }, [ui.selectedReviewId, readDetail]);
  const reconcile = useCallback(async (status: ProjectStatusView, live: () => boolean) => {
    current.current = { ...current.current, status };
    const listChanged = !current.current.page || current.current.page.reviewsRevision !== status.reviewsRevision || !current.current.snapshotPage || current.current.snapshotPage.baselineSequence !== status.baselineSequence;
    const signature = `${status.currentDraftId}:${status.documentRevision}:${status.layoutRevision}`;
    if (listChanged) await refresh(undefined, status, live);
    else await readCurrentBaseline(status, live);
    if (current.current.ui.selectedReviewId && (listChanged || signature !== detailSignature.current)) await readDetail(current.current.ui.selectedReviewId, live);
    if (current.current.ui.selectedSnapshotId && (listChanged || snapshotSignature.current !== current.current.ui.selectedSnapshotId)) await readPublishedSnapshot(current.current.ui.selectedSnapshotId, live);
  }, [refresh, readDetail, readPublishedSnapshot, readCurrentBaseline]);
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
  const selectedPublishedSnapshot = !ui.selectedReviewId && publishedSnapshot?.snapshot.id === ui.selectedSnapshotId ? publishedSnapshot : null;
  const canDecide = selected && canDecideReview(selected, sync.status);
  const reasonValid = [...ui.reason].length <= 4000;
  const decide = (decision: DecisionInput["decision"], label: string) => {
    if (!selected || !canDecide || !reasonValid || (decision !== "APPROVE" && !ui.reason.trim())) return;
    void write.send(`reviews/${selected.review.reviewId}/decision`, {
      decision, expectedReviewVersion: selected.review.reviewVersion, expectedReviewHash: selected.snapshot.reviewHash, reason: ui.reason,
    }, label, undefined, selected);
  };
  const eligible = preview && previewMatches(preview, sync.status, studio.exportDirty || dirty());
  const document = studio.savedDraft.document;
  const { currentDraftId, documentRevision, layoutRevision, approvedSnapshotId, baselineSequence } = sync.status;
  const comparisonFloor = studio.ui.acknowledgedRevisions[studio.savedDraft.id];
  const comparisonAvailable = !sync.failures && !studio.readFailures && !studio.refreshFailed && !baselineError;
  const pendingWork = useMemo(() => savedPendingWork(studio.savedDraft, currentBaseline,
    { currentDraftId, documentRevision, layoutRevision, approvedSnapshotId, baselineSequence }, comparisonFloor, comparisonAvailable),
  [studio.savedDraft, currentBaseline, currentDraftId, documentRevision, layoutRevision, approvedSnapshotId, baselineSequence, comparisonFloor, comparisonAvailable]);
  const select = (id: string | null) => { detailTicket.current++; setDetail(null); setDetailError(""); update(() => ({ selectedReviewId: id, selectedSnapshotId: null })); if (!id) requestAnimationFrame(() => window.document.getElementById(`review-row-${ui.selectedReviewId}`)?.focus()); };
  const selectSnapshot = (id: string | null) => {
    snapshotDetailTicket.current++; setPublishedSnapshot(null); setSnapshotError("");
    update(() => ({ selectedSnapshotId: id, selectedReviewId: null }));
    if (!id) requestAnimationFrame(() => window.document.getElementById(`snapshot-row-${ui.selectedSnapshotId}`)?.focus());
  };
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
      if (ui.selectedSnapshotId) void readPublishedSnapshot(ui.selectedSnapshotId);
    }}>Retry reviews</button></p>}
    <section aria-label="Saved work against current baseline">
      <h3>Saved work against current baseline</h3>
      {sync.status.approvedSnapshotId && <p>Baseline {sync.status.baselineSequence}</p>}
      {pendingWork.kind === "unavailable" ? <p role="status">Saved comparison is unavailable or still refreshing. {baselineError}
        <button type="button" className="button quiet small" onClick={() => { void readCurrentBaseline(current.current.status, fence(), true); void sync.revalidate("manual"); }}>Retry saved comparison</button>
      </p> : pendingWork.kind === "unapproved" ? <p>No approved baseline yet. Saved scope is not approved.</p> : <>
        <p>{pendingWork.semantic ? "Saved included scope has changes pending approval." : "Saved included scope matches the current approved baseline."}</p>
        {pendingWork.layout && <p>Saved layout has unapproved presentation changes.</p>}
      </>}
      {(studio.exportDirty || dirty()) && <p>Unsent edits and typed fields are separate from this saved comparison and are not approved.</p>}
    </section>
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
          {canDecide && <section aria-label="Decide frozen candidate">
            <h3>Decide this exact candidate</h3>
            <p>Approval publishes the included scope above and keeps newer draft work. Request changes or rejection closes this candidate without publication.</p>
            <label htmlFor="decision-reason">Reason</label>
            <textarea id="decision-reason" value={ui.reason} onChange={event => update(() => ({ reason: event.target.value }))} aria-describedby="decision-reason-help" />
            <p id="decision-reason-help">Required for request changes, rejection{canWrite ? " and withdrawal" : ""}. Optional for approval. Up to 4,000 characters.</p>
            <button type="button" className="button primary" disabled={write.busy || !!ui.pending || !reasonValid}
              onClick={() => decide("APPROVE", "Approve candidate")}>Approve candidate</button>
            <button type="button" className="button" disabled={write.busy || !!ui.pending || !reasonValid || !ui.reason.trim()}
              onClick={() => decide("REQUEST_CHANGES", "Request changes")}>Request changes</button>
            <button type="button" className="button danger" disabled={write.busy || !!ui.pending || !reasonValid || !ui.reason.trim()}
              onClick={() => decide("REJECT", "Reject candidate")}>Reject candidate</button>
          </section>}
          {canWrite && selected.review.state === "OPEN" && <form onSubmit={event => {
            event.preventDefault();
            void write.send(`reviews/${selected.review.reviewId}/withdraw`, {
              expectedReviewVersion: selected.review.reviewVersion, reason: ui.reason,
            }, "Withdraw candidate");
          }}>
            {!canDecide && <><label htmlFor="withdraw-reason">Withdrawal reason</label>
            <textarea id="withdraw-reason" value={ui.reason} onChange={event => update(() => ({ reason: event.target.value }))} required /></>}
            <button type="submit" className="button danger"
              disabled={write.busy || !!ui.pending || !ui.reason.trim() || [...ui.reason].length > 4000}>Withdraw candidate</button>
          </form>}
        </> : !readError && <p role="status">Loading candidate…</p>}
      </> : ui.selectedSnapshotId ? <>
        <button type="button" className="button small" onClick={() => selectSnapshot(null)}>Back to history</button>
        {selectedPublishedSnapshot ? <><CandidateReader key={selectedPublishedSnapshot.snapshot.id} detail={selectedPublishedSnapshot} /><ApprovedMarkdown key={selectedPublishedSnapshot.snapshot.id} published={selectedPublishedSnapshot} onAccessLost={onAccessLost} /></> : !readError && <p role="status">Loading baseline…</p>}
      </> : <>
        <h2>Approved baselines</h2>
        {snapshotPage && !snapshotPage.items.length && <p>No approved baselines yet.</p>}
        <ul className="review-history">{snapshotPage?.items.map(snapshot => <li key={snapshot.snapshotId}>
          <button id={`snapshot-row-${snapshot.snapshotId}`} type="button" className="button quiet" onClick={() => selectSnapshot(snapshot.snapshotId)}>
            Baseline {snapshot.publicationSequence} · {snapshot.publishedAt}<span>{snapshot.snapshotId}</span>
          </button>
        </li>)}</ul>
        {snapshotPage?.nextCursor && <button type="button" className="button small" onClick={() => void refreshSnapshots(snapshotPage.nextCursor!)}>More baselines</button>}
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
