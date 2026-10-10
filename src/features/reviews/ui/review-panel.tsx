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
import { approverLabel, reasonStatus } from "./review-format";
import ReviewDecision from "./review-decision";
import { useReviewWrite } from "./use-review-write";
import CandidateReader from "./candidate-reader";
import ApprovedMarkdown from "./approved-markdown";
import { savedPendingWork } from "./pending-work";
import ReviewCurrent from "./review-current";
import SavedComparison from "./review-comparison";
import ReviewHistory from "./review-history";
import { Icon } from "@/features/shell/ui/icon";

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
  const reasonValid = !reasonStatus(ui.reason).over;
  const decide = (decision: DecisionInput["decision"], label: string) => {
    if (!selected || !canDecide || !reasonValid || (decision !== "APPROVE" && !ui.reason.trim())) return;
    void write.send(`reviews/${selected.review.reviewId}/decision`, {
      decision, expectedReviewVersion: selected.review.reviewVersion, expectedReviewHash: selected.snapshot.reviewHash, reason: ui.reason,
    }, label, undefined, selected);
  };
  const eligible = preview && previewMatches(preview, sync.status, studio.exportDirty || dirty());
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
  return <div className="review-panel">
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
    {ui.message && <p className="review-callout" data-tone={ui.pending ? "pending" : undefined} role={ui.pending ? "alert" : "status"}>
      {ui.message}
      {ui.pending && !write.busy && <button type="button" className="button small" onClick={() => void write.retry()}>
        {ui.pending.acknowledged ? "Refresh" : "Retry"}
      </button>}
    </p>}
    {write.busy && <p role="status" className="review-intro">Saving review action…</p>}
    {readError && <p role="alert" className="review-callout" data-tone="rejected">{readError} <button type="button" className="button small" onClick={() => {
      void refresh();
      if (ui.selectedReviewId) void readDetail(ui.selectedReviewId);
      if (ui.selectedSnapshotId) void readPublishedSnapshot(ui.selectedSnapshotId);
    }}>Retry reviews</button></p>}
    <SavedComparison work={pendingWork} baselineSequence={sync.status.approvedSnapshotId ? sync.status.baselineSequence : null} baselineError={baselineError}
      unsent={studio.exportDirty || dirty()} onRetry={() => { void readCurrentBaseline(current.current.status, fence(), true); void sync.revalidate("manual"); }} />
    <div id={`review-body-${ui.section}`} role="tabpanel" aria-labelledby={`review-tab-${ui.section}`}>
      {ui.section === "current" ? <>
      <ReviewCurrent savedDraft={studio.savedDraft} approver={approverLabel(sync.status.designatedApproverId, sync.directory)}
        active={sync.status.status === "ACTIVE"} canWrite={canWrite} unsaved={studio.unsaved} previewBusy={previewBusy} writing={write.busy || !!ui.pending}
        previewError={previewError} preview={preview} eligible={Boolean(eligible)} onPreview={saveFirst => void prepare(saveFirst)}
        onSharing={onSharing} onTarget={onTarget} onReadOpen={reviewId => { update(() => ({ section: "history" })); select(reviewId); }}
        onFreeze={inspected => void write.send(`drafts/${inspected.draftId}/reviews`, { ...inspected.guards }, "Freeze candidate", inspected)} />
      </> : ui.selectedReviewId ? <>
        <button type="button" className="button quiet small review-back" onClick={() => select(null)}><Icon name="back" size={16} /><span>Back to history</span></button>
        {selected ? <>
          <CandidateReader key={selected.snapshot.id} detail={selected} />
          <ReviewDecision reason={ui.reason} onReason={reason => update(() => ({ reason }))} canDecide={Boolean(canDecide)}
            canWithdraw={canWrite && selected.review.state === "OPEN"} writing={write.busy || !!ui.pending} onDecide={decide}
            onWithdraw={() => void write.send(`reviews/${selected.review.reviewId}/withdraw`, {
              expectedReviewVersion: selected.review.reviewVersion, reason: ui.reason,
            }, "Withdraw candidate")} />
        </> : !readError && <p role="status">Loading candidate…</p>}
      </> : ui.selectedSnapshotId ? <>
        <button type="button" className="button quiet small review-back" onClick={() => selectSnapshot(null)}><Icon name="back" size={16} /><span>Back to history</span></button>
        {selectedPublishedSnapshot ? <><CandidateReader key={selectedPublishedSnapshot.snapshot.id} detail={selectedPublishedSnapshot} /><ApprovedMarkdown key={selectedPublishedSnapshot.snapshot.id} published={selectedPublishedSnapshot} onAccessLost={onAccessLost} /></> : !readError && <p role="status">Loading baseline…</p>}
      </> : <>
      <ReviewHistory snapshots={snapshotPage} reviews={page} loading={!page && !readError} onOpenSnapshot={selectSnapshot} onOpenReview={select}
        onMoreSnapshots={cursor => void refreshSnapshots(cursor)} onMoreReviews={cursor => void refresh(cursor)} />
      </>}
    </div>
  </div>;
}
