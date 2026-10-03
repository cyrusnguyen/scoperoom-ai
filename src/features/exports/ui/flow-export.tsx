"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { apiMutate, sessionEnded } from "@/client/api";
import { useSync } from "@/features/collaboration/ui/sync-context";
import type { DraftView } from "@/features/drafts/contracts/scope-document";
import { serializeFlowFile } from "@/features/exchange/domain/flow-file";
import Dialog, { CancelFocus } from "@/features/shell/ui/dialog";
import { useStudio } from "@/features/studio/ui/studio-context";
import { covers } from "@/features/studio/ui/studio-ui";
import type { PreparedFlow } from "../contracts/flow-export";

/** One inspected saved pair is pinned until the person explicitly inspects a newer one. */
export function NativeExportDialog({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const { projectId, savedDraft, ui, exportDirty, inspectSavedExport } = useStudio();
  const { beforeWrite, fence, invalidate, revalidate } = useSync();
  const [shown, setShown] = useState<DraftView | null>(savedDraft);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const mounted = useRef(true), working = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = () => { mounted.current = false; onClose(); };
  const flow = shown?.document.flows[flowId];
  const inspect = async (saveFirst: boolean) => {
    if (working.current) return;
    working.current = true; setLoading(true); setMessage("");
    try {
      const result = await inspectSavedExport(saveFirst);
      if (!mounted.current) return;
      if (result.ok) { setShown(result.result); setMessage("Review this saved state, then choose Export saved state."); }
      else setMessage(result.message);
    } finally { working.current = false; if (mounted.current) setLoading(false); }
  };
  const prepare = async () => {
    if (!shown || !flow || working.current || !covers(shown, ui.acknowledgedRevisions[shown.id])) return;
    working.current = true; setLoading(true); setMessage("");
    const invocation = fence(), current = () => mounted.current && invocation();
    try {
      const authority = await beforeWrite();
      if (!current()) return;
      if (authority.kind !== "current") { setMessage("We could not confirm your current access. Try again after access is checked."); return; }
      const admitted = fence(authority.generation);
      if (!admitted() || authority.status.currentDraftId !== shown.id) { setShown(null); setMessage("The draft changed. Inspect the current saved state before exporting."); return; }
      const result = await apiMutate<PreparedFlow>(`/api/projects/${projectId}/drafts/${shown.id}/flows/${flowId}/export`, null, {
        format: "native", includeLinkHints: false, expectedDocumentRevision: shown.documentRevision, expectedLayoutRevision: shown.layoutRevision,
      });
      // Check before session-ended navigation as well as before creating a private download.
      if (!current() || !admitted()) return;
      if (sessionEnded(result)) return;
      if (!result.ok) {
        if (result.code === "EXPORT_REVISION_CHANGED") {
          setShown(null);
          const fresh = await inspectSavedExport(false);
          if (!current() || !admitted()) return;
          if (fresh.ok) setShown(fresh.result);
          setMessage(fresh.ok ? "The saved revisions changed. Review the newly inspected saved state, then explicitly retry Export saved state." : fresh.message);
        } else {
          if (result.uncertain) invalidate();
          if (["FORBIDDEN", "NOT_FOUND", "DRAFT_REPLACED"].includes(result.code)) { setShown(null); await revalidate("manual"); }
          if (current()) setMessage(result.message);
        }
        return;
      }
      // Access or identity may have changed during preparation. Use the same shared status owner before disclosure.
      const checked = await revalidate("manual");
      if (!current() || !admitted()) return;
      if (checked.kind !== "current") {
        if (checked.kind === "denied") setShown(null);
        setMessage("We could not confirm your current access. Retry Export saved state after access is checked."); return;
      }
      if (checked.status.currentDraftId !== shown.id) { setShown(null); setMessage("The draft changed. Reopen Export for the current saved state."); return; }
      const bytes = serializeFlowFile(result.data.file);
      const blob = new Blob([new Uint8Array(bytes)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a"); link.href = url; link.download = result.data.filename;
        document.body.append(link); link.click(); link.remove();
      } finally { window.setTimeout(() => URL.revokeObjectURL(url), 0); }
      setMessage("Native file downloaded from the disclosed saved revisions.");
    } catch { if (current()) setMessage("The download could not be prepared. Retry Export saved state."); }
    finally { working.current = false; if (mounted.current) setLoading(false); }
  };
  return <Dialog title="Export flow" onClose={close} footer={<>
    <CancelFocus label="Cancel" onClick={close} />
    <button type="button" className="button" disabled={loading} onClick={() => void inspect(true)}>Save and inspect saved state</button>
    <button type="button" className="button primary" disabled={loading || !flow || !shown || !covers(shown, ui.acknowledgedRevisions[shown.id])} onClick={() => void prepare()}>Export saved state</button>
  </>}>
    {flow && shown ? <>
      <p><strong>{flow.title}</strong></p>
      <p>Saved draft. Document revision {shown.documentRevision}, layout revision {shown.layoutRevision}.</p>
      <p>{Object.values(shown.document.nodes).filter(node => node.flowId === flowId).length} saved steps. Native JSON preserves supported graph text, positions, direction and connection sides.</p>
    </> : <p>This flow is unavailable in the inspected saved draft. Save a new flow first, or reopen Export from a saved flow.</p>}
    {exportDirty && <p role="status">You have unsaved text, pending movement, queued or unconfirmed changes. Export saved state excludes them. Save and inspect waits for completed queued edits; unsubmitted fields must be submitted or discarded in the Studio.</p>}
    <p>Labels and descriptions may contain confidential information. This file excludes evidence and excerpts, messages, tokens, memberships, approval objects, private links and internal properties. Importing it creates a new unapproved copy with fresh identities.</p>
    <button type="button" className="button quiet small" disabled={loading} onClick={() => void inspect(false)}>Inspect current saved state</button>
    <span role="status">{loading ? "Preparing saved state…" : ""}</span>
    {message && <p role="alert">{message}</p>}
  </Dialog>;
}
