"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { apiMutate, sessionEnded } from "@/client/api";
import { useSync } from "@/features/collaboration/ui/sync-context";
import { useStudio } from "@/features/studio/ui/studio-context";
import { studioDirtyCount } from "@/features/studio/ui/studio-ui";
import type { FreezeResult, ReviewPreview, WithdrawResult } from "../contracts/review";
import { previewMatches, reserveReview, settleReview, type ReviewReceipt, type ReviewRequestAttempt, type ReviewUi } from "./review-state";

export function useReviewWrite(ui: ReviewUi, update: (change: (ui: ReviewUi) => Partial<ReviewUi>) => void, dirty: () => boolean, refresh: (receipt: ReviewReceipt) => Promise<boolean>, accessLost: () => void) {
  const { beforeWrite, fence, invalidate, revalidate, status } = useSync();
  const studio = useStudio();
  const latest = useRef({ studio, status, dirty, ui });
  useLayoutEffect(() => { latest.current = { studio, status, dirty, ui }; });
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const settle = (request: ReviewRequestAttempt, outcome: "saved" | "acknowledged" | "uncertain" | "refused", message: string) => update(current => settleReview(current, request.key, outcome, message));
  function retain(request: ReviewRequestAttempt, receipt?: ReviewReceipt) {
    update(current => current.pending?.key === request.key ? {
      ...settleReview(current, request.key, "acknowledged", `${request.label} was acknowledged. Refresh saved changes to finish.`),
      pending: { ...current.pending, acknowledged: true, ...(receipt ? { receipt } : {}) },
      ...(receipt ? { selectedReviewId: receipt.reviewId, section: "history" } : {}),
    } : {});
  }
  async function acknowledged(request: ReviewRequestAttempt, receipt?: ReviewReceipt) {
    retain(request, receipt);
    // A response-less acknowledgement still needs exact receipt recovery; an unrelated history read proves nothing.
    if (receipt && await refresh(receipt)) settle(request, "saved", `${request.label}: saved.`);
  }
  async function run(request: ReviewRequestAttempt, retry: boolean, preview?: ReviewPreview) {
    if (sending.current) return;
    sending.current = true; setBusy(true);
    let release: (() => void) | null = null;
    try {
      const authority = await beforeWrite();
      if (authority.kind !== "current") { settle(request, retry ? "uncertain" : "refused", "Could not check current access. Retry after refresh."); return; }
      const live = fence(authority.generation);
      if (!live()) { settle(request, retry ? "uncertain" : "refused", "The project changed. Nothing was sent."); return; }
      if (!retry && (authority.status.status !== "ACTIVE" || !["OWNER", "EDITOR"].includes(authority.status.role) || latest.current.dirty() || latest.current.studio.busy || studioDirtyCount(latest.current.studio.ui) > 0)) { settle(request, "refused", "Resolve unsaved fields or writes before starting a review action. This project must be editable."); return; }
      if (!retry && preview) {
        if (!previewMatches(preview, authority.status, latest.current.studio.exportDirty)) { settle(request, "refused", "Saved changes affected this preview. Preview saved scope again."); return; }
        let receipt: FreezeResult | undefined;
        const result = await studio.writeDraft<FreezeResult>(request.path, saved => {
          if (latest.current.dirty() || studioDirtyCount(latest.current.studio.ui) > 0 || !previewMatches(preview, { ...latest.current.status, currentDraftId: saved.id, documentRevision: saved.documentRevision, layoutRevision: saved.layoutRevision }, false)) return null;
          return request.body;
        }, request.key, { saveFirst: false, onAcknowledged: data => { receipt = data; retain(request, data); } });
        if (result.ok) await acknowledged(request, result.result);
        else if (result.acknowledged || receipt) await acknowledged(request, receipt);
        else settle(request, result.uncertain ? "uncertain" : "refused", result.uncertain ? `We couldn’t confirm ${request.label}. Retry sends the same request.` : result.message);
        return;
      }
      if (!retry) {
        release = latest.current.studio.reserveWrite(request.key);
        if (!release) { settle(request, "refused", "Another project write is in progress. Try again after it finishes."); return; }
      }
      // An existing request recovers its receipt with current read access, even after downgrade or draft replacement.
      const result = await apiMutate<FreezeResult | WithdrawResult>(`/api/projects/${studio.projectId}/${request.path}`, request.key, request.body, request.method);
      if (!live()) { if (result.ok) settle(request, "acknowledged", `${request.label} was acknowledged. Refresh saved changes to finish.`); else settle(request, result.uncertain || result.status === 401 ? "uncertain" : "refused", `We couldn’t confirm ${request.label}. Retry sends the same request.`); return; }
      if (sessionEnded(result)) return;
      if (result.ok) { await acknowledged(request, result.data); void revalidate("manual"); }
      else if (result.uncertain) { invalidate(); settle(request, "uncertain", `We couldn’t confirm ${request.label}. Retry sends the same request.`); }
      else { settle(request, "refused", String(result.details?.reason ?? result.message)); if (result.status === 403 || result.status === 404) accessLost(); else void revalidate("manual"); }
    } finally { release?.(); sending.current = false; setBusy(false); }
  }
  function send(path: string, body: Record<string, unknown>, label: string, preview?: ReviewPreview) {
    if (ui.pending || sending.current) return;
    const request: ReviewRequestAttempt = { key: crypto.randomUUID(), method: "POST", path, body, label, acknowledged: false };
    update(current => reserveReview(current, request) ?? {});
    return run(request, false, preview);
  }
  return { busy, send, retry: () => ui.pending ? run(ui.pending, true) : undefined };
}
