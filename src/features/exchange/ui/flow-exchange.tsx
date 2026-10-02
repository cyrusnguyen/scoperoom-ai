"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiMutate, apiRead, sessionEnded, type ApiResult } from "@/client/api";
import { useSync } from "@/features/collaboration/ui/sync-context";
import Dialog from "@/features/shell/ui/dialog";
import { useStudio } from "@/features/studio/ui/studio-context";
import { covers, requireDraftRevision } from "@/features/studio/ui/studio-ui";
import type { ImportPreviewView } from "../contracts/import";
import { clearImport, importStorageKey, parseImportRecord, persistImport, type ImportRecord, type NativeImportState } from "./import-recovery";
import { ImportPreview } from "./import-preview";

const denied = new Set(["NOT_FOUND", "DENIED", "UNAUTHENTICATED"]);
const stale = new Set(["DRAFT_REPLACED", "IMPORT_STALE", "IMPORT_PAYLOAD_MISMATCH"]);
const fingerprint = async (file: File) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export function NativeImportDialog({ onClose }: { onClose: () => void }) {
  const { projectId, savedDraft, editable, narrow, ui, update, busy, importFlow, reload } = useStudio();
  const { status, beforeWrite, revalidate, fence } = useSync();
  const actorId = status.viewerId;
  const projectScope = projectId.toLowerCase();
  const [selected, setSelected] = useState<File | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [view, setView] = useState<"canvas" | "list">(narrow ? "list" : "canvas");
  const [restored] = useState(() => {
    try { return parseImportRecord(sessionStorage.getItem(importStorageKey(actorId, projectId)), actorId, projectId); } catch { return null; }
  });
  const mounted = useRef(true);
  const latest = useRef(ui.nativeImport);
  useLayoutEffect(() => { latest.current = ui.nativeImport; }, [ui.nativeImport]);
  const local = ui.nativeImport;
  const locked = Boolean(local?.record.attempt) && local?.state !== "Applied";
  const blocked = working || busy || locked;
  // A draft replacement keeps this modal mounted. Release its local latch, but never adopt an obsolete response.
  const canAdopt = (current: () => boolean) => {
    if (!mounted.current) return false;
    if (current()) return true;
    setWorking(false); return false;
  };
  const setLocal = (next: NativeImportState) => { latest.current = next; persistImport(next.record); update(() => ({ nativeImport: next })); };
  const lost = (text: string) => {
    if (latest.current) clearImport(latest.current.record);
    latest.current = null; setSelected(null); setMessage(text);
    const input = document.getElementById("native-import-file") as HTMLInputElement | null;
    if (input) input.value = "";
    update(() => ({ nativeImport: null }));
  };
  const accept = (preview: ImportPreviewView, record: ImportRecord, file: File | null) => {
    if (preview.id !== record.previewId || preview.projectId.toLowerCase() !== projectScope || preview.draftId !== record.draftId || (record.previewHash && record.previewHash !== preview.previewHash)) { lost("Access lost. The recovered preview does not match this import."); return; }
    const nextRecord = { ...record, previewHash: preview.previewHash };
    if (preview.state === "EXPIRED" || preview.state === "DISCARDED") delete nextRecord.attempt;
    const state = preview.state === "APPLIED" ? "Applied" : preview.state === "EXPIRED" ? "Expired" : preview.state === "DISCARDED" || preview.draftId !== savedDraft.id ? "Stale" : record.attempt ? "Applying" : "Ready";
    setLocal({ record: nextRecord, preview, file, state, message: record.attempt && state === "Applying" ? "We couldn’t confirm the import. Retry the same request or recover its status." : preview.state === "DISCARDED" ? "This preview was discarded." : "" });
    if (preview.result) {
      update((value) => ({ acknowledgedRevisions: requireDraftRevision(value.acknowledgedRevisions, preview.result!) }));
    }
  };
  const recover = async (record = latest.current?.record ?? restored, file = latest.current?.file ?? null) => {
    if (!record || working) return;
    const current = fence(); setWorking(true);
    const result = await apiRead<ImportPreviewView>(`/api/projects/${projectId}/flow-imports/${record.previewId}`);
    if (!canAdopt(current)) return;
    setWorking(false);
    if (sessionEnded(result)) return;
    if (result.ok) { accept(result.data, record, file); if (result.data.result && result.data.result.draftId === savedDraft.id) await reload(current); return; }
    // An unknown upload can legitimately have no row yet. GET cannot distinguish it from denied preview access.
    if (result.code === "NOT_FOUND" && !record.previewHash) {
      const authority = await revalidate("manual");
      if (!canAdopt(current)) return;
      if (authority.kind === "denied") { lost("Access lost. This protected preview has been cleared."); return; }
      setLocal({ record, file, preview: null, state: "Validating", message: "Upload not confirmed. Retry status, or select the same file to retry the original upload." }); return;
    }
    if (denied.has(result.code)) { lost("Access lost. This protected preview has been cleared."); return; }
    setMessage(result.message);
  };
  const recovery = useRef(recover);
  useLayoutEffect(() => { recovery.current = recover; });
  useEffect(() => {
    mounted.current = true;
    if (!latest.current && restored) {
      const next: NativeImportState = { record: restored, file: null, preview: null, state: restored.attempt ? "Applying" : "Validating", message: "Recovering the original import…" };
      latest.current = next; update(() => ({ nativeImport: next }));
    }
    const timer = window.setTimeout(() => { if (latest.current) void recovery.current(latest.current.record); }, 0);
    return () => { mounted.current = false; window.clearTimeout(timer); };
  }, [restored, update]);

  const upload = async (fresh: boolean) => {
    if (working || busy || locked || !editable) return;
    const file = selected ?? local?.file;
    if (!file) { setMessage("Select the same native flow file again. File contents are kept only in memory."); return; }
    if (file.size > 1_048_576) { setMessage("Invalid: native files must be at most 1 MiB."); return; }
    const current = fence(); setWorking(true); setMessage("");
    const digest = await fingerprint(file);
    if (!canAdopt(current)) return;
    const previous = latest.current;
    if (!fresh && previous && !previous.record.previewHash && previous.record.fingerprint !== digest) { setWorking(false); setMessage("Select the same file to recover the original upload, or explicitly start a new inspection."); return; }
    const record: ImportRecord = !fresh && previous && !previous.record.previewHash ? previous.record : { actorId, projectId: projectScope, draftId: savedDraft.id, previewId: crypto.randomUUID(), createKey: crypto.randomUUID(), discardKey: crypto.randomUUID(), fingerprint: digest };
    setLocal({ record, file, preview: null, state: "Validating", message: "" });
    const authority = await beforeWrite();
    if (!canAdopt(current)) return;
    if (authority.kind !== "current" || !fence(authority.generation)() || authority.status.currentDraftId !== record.draftId || authority.status.status !== "ACTIVE" || !["OWNER", "EDITOR"].includes(authority.status.role)) { setWorking(false); setLocal({ record, file, preview: null, state: "Stale", message: "This target is no longer editable. Resolve access or inspect again for the current draft." }); return; }
    let result: ApiResult<ImportPreviewView>;
    try {
      const response = await fetch(`/api/projects/${projectId}/flow-imports/preview?draftId=${record.draftId}&previewId=${record.previewId}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": record.createKey }, body: file });
      const body = await response.json().catch(() => null);
      result = response.ok && body !== null ? { ok: true, data: body } : { ok: false, code: body?.error?.code ?? "UNAVAILABLE", message: body?.error?.message ?? "Unable to confirm file inspection. Recover status or retry the original file.", status: response.status, uncertain: response.ok || response.status >= 500 };
    } catch { result = { ok: false, code: "NETWORK", message: "Upload not confirmed. Retry status or the same file and original upload.", status: 0, uncertain: true }; }
    if (!canAdopt(current)) return;
    setWorking(false);
    if (sessionEnded(result)) return;
    if (result.ok) { accept(result.data, record, file); return; }
    if (denied.has(result.code) || result.code === "FORBIDDEN") { lost("Access lost. This protected preview has been cleared."); return; }
    setLocal({ record, file, preview: null, state: result.uncertain ? "Validating" : "Invalid", message: result.code === "UNSUPPORTED_FLOW_FORMAT" ? "Unsupported format. Select a version 1 .scoperoom-flow.json file." : result.message });
  };
  const apply = async () => {
    const original = latest.current;
    if (!original?.record.previewHash || working || busy || original.state === "Applied") return;
    setWorking(true); setMessage("");
    const current = fence();
    const attempt = original.record.attempt ?? { key: crypto.randomUUID(), draftId: original.record.draftId, previewHash: original.record.previewHash };
    const outcome = await importFlow(original.record.previewId, { draftId: attempt.draftId, previewHash: attempt.previewHash }, attempt.key);
    if (!canAdopt(current)) return;
    setWorking(false);
    if (outcome.ok) {
      const record = { ...original.record, attempt };
      setLocal({ ...original, record, state: "Applied", preview: original.preview ? { ...original.preview, state: "APPLIED", result: outcome.result } : { id: record.previewId, projectId, draftId: record.draftId, previewHash: record.previewHash!, expectedDocumentRevision: 0, expiresAt: "", state: "APPLIED", result: outcome.result, file: null, positions: null, fidelityReport: null }, message: "" }); return;
    }
    if (denied.has(outcome.code) || outcome.code === "FORBIDDEN" && !outcome.uncertain && status.role !== "OWNER" && status.role !== "EDITOR") { lost("Access lost. This protected preview has been cleared. Your safe local Studio edits remain available for copy or discard."); return; }
    if (outcome.uncertain) { setLocal({ ...original, record: { ...original.record, attempt }, state: "Applying", message: "We couldn’t confirm the import. Retry the same request or recover its status." }); return; }
    const { attempt: ignored, ...record } = original.record; void ignored;
    setLocal({ ...original, record, state: outcome.code === "IMPORT_EXPIRED" ? "Expired" : stale.has(outcome.code) ? "Stale" : original.preview ? "Ready" : "Invalid", message: outcome.message });
  };
  const discard = async () => {
    const original = latest.current;
    if (!original || blocked || original.state === "Applied") return;
    setWorking(true); const current = fence();
    const result = await apiMutate<ImportPreviewView>(`/api/projects/${projectId}/flow-imports/${original.record.previewId}/discard`, original.record.discardKey);
    if (!canAdopt(current)) return;
    setWorking(false); if (sessionEnded(result)) return;
    if (result.ok && result.data.state === "APPLIED") { accept(result.data, original.record, original.file); return; }
    if (result.ok) { clearImport(original.record); update(() => ({ nativeImport: null })); onClose(); }
    else if (denied.has(result.code)) lost("Access lost. This protected preview has been cleared.");
    else setMessage(result.message);
  };
  const result = local?.preview?.result;
  const sameDraft = result?.draftId === savedDraft.id && result?.draftId === status.currentDraftId;
  const covering = Boolean(result && sameDraft && covers(savedDraft, result));
  const available = Boolean(result && covering && savedDraft.document.flows[result.flowId]);
  // Success navigates only from a saved, same-draft covering read. Historical missing results stay explained.
  useEffect(() => {
    if (!available || working || !result) return;
    if (local) clearImport(local.record);
    update(() => ({ flowId: result.flowId, selection: null, nativeImport: null }));
    onClose(); requestAnimationFrame(() => document.getElementById("studio-flow-title")?.focus());
  }, [available, working, result, local, update, onClose]);
  return <Dialog title="Import flow" onClose={blocked ? () => {} : onClose} footer={<>
    <button type="button" className="button quiet" disabled={blocked} onClick={onClose}>Cancel</button>
    {local?.state === "Applied" ? <>
      <button type="button" className="button" disabled={working} onClick={() => void recover()}>Refresh saved changes</button>
      {(!sameDraft || covering && !available) && <button type="button" className="button quiet" disabled={working} onClick={() => { clearImport(local.record); latest.current = null; update(() => ({ nativeImport: null })); setSelected(null); setMessage(""); const input = document.getElementById("native-import-file") as HTMLInputElement; input.value = ""; }}>Start another import</button>}
    </> : <>
      <button type="button" className="button" disabled={blocked || !editable || !selected && !local?.file} onClick={() => void upload(Boolean(local?.record.previewHash))}>{local?.record.previewHash ? "Inspect again" : "Inspect file"}</button>
      {local && !local.record.previewHash && <button type="button" className="button quiet" disabled={blocked || !editable || !selected && !local.file} onClick={() => void upload(true)}>Start new inspection</button>}
      {local && <button type="button" className="button quiet" disabled={working || busy} onClick={() => void recover()}>Recover import status</button>}
      {local && <button type="button" className="button quiet" disabled={blocked} onClick={() => void discard()}>Discard preview</button>}
      {local?.record.previewHash && <button type="button" className="button primary" disabled={working || busy || !locked && (!editable || local.state !== "Ready" || local.record.draftId !== savedDraft.id)} onClick={() => void apply()}>{working || busy ? "Applying…" : locked ? "Retry import" : "Create unapproved copy"}</button>}
    </>}
  </>}>
    <div className="field"><label htmlFor="native-import-file">Native flow file</label><input id="native-import-file" type="file" accept=".json,.scoperoom-flow.json" disabled={blocked || !editable} onChange={(event) => { setSelected(event.target.files?.[0] ?? null); setMessage(""); }} /></div>
    <p>Inspect a version 1 .scoperoom-flow.json file before creating an independent copy. File contents stay in memory; reload recovers only the original preview identity.</p>
    {!editable && <p>This project is read-only. You can recover an existing applied import; new copies are disabled.</p>}
    <p role="status">{message.startsWith("Access lost") ? "Access lost" : message.startsWith("Invalid:") ? "Invalid" : local?.state ?? "Select a file"}</p>
    {local && <p className="muted">Target draft: {local.record.draftId}{local.preview?.expiresAt && <> · Expires: <time dateTime={local.preview.expiresAt}>{new Date(local.preview.expiresAt).toLocaleString()}</time></>}</p>}
    {local?.preview?.fidelityReport && <>
      <p>{local.preview.fidelityReport.nodeCount} steps · {local.preview.fidelityReport.edgeCount} connections</p>
      <p>{local.preview.fidelityReport.geometry === "SUPPLIED" ? "Supplied geometry is preserved with new identities." : "Geometry was omitted. A deterministic automatic layout will be used."}</p>
      <p>Trust reset: inclusion UNDECIDED (exploratory), origin IMPORTED, no confirmation. Approvals, memberships, evidence and live requirement links are not imported.</p>
      {local.preview.file?.origin.kind === "SNAPSHOT" && <p>Snapshot provenance is informational. Its inclusion or approval does not authorize this copy.</p>}
      {local.preview.fidelityReport.omittedLinkHintCount > 0 && <p>{local.preview.fidelityReport.omittedLinkHintCount} link hints ignored; no live relationships are created.</p>}
      <div className="segmented" role="group" aria-label="Import preview view"><button type="button" aria-pressed={view === "canvas"} onClick={() => setView("canvas")}>Graph preview</button><button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List alternative</button></div>
      <ImportPreview preview={local.preview} view={view} />
    </>}
    {local?.state === "Applied" && <p role="status">{!sameDraft ? "This import was saved to the original draft. Its historical flow is unavailable in the current draft." : !covering ? "Import saved. Refreshing saved changes…" : !available ? "Import saved. The created flow has since been deleted and is unavailable." : "Import saved."}</p>}
    {local?.state === "Stale" && <p>Inspect again explicitly to target the current draft. If file contents were cleared, select the same file again.</p>}
    {local?.state === "Expired" && <p>This preview expired. Select the same file again if needed, then inspect again explicitly.</p>}
    {(local?.message || message) && <p className="error-message" role="alert">{message || local?.message}</p>}
  </Dialog>;
}
