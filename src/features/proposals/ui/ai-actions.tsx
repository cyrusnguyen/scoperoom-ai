"use client";

import "./ai.css";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiMutate, apiRead, sessionEnded } from "@/client/api";
import { useAiSyncReader, useSync } from "@/features/collaboration/ui/sync-context";
import type { ProjectUi } from "@/features/shell/ui/project-ui";
import { useStudio } from "@/features/studio/ui/studio-context";
import { createRunResources } from "./run-resources";
import { RunCard } from "./run-card";
import { RunHistory } from "./run-history";
import { acknowledgedInstruction, retryStartRequest } from "./ai-submit";
import type { RunPage, RunView, TaskKind } from "../contracts/tasks";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function AiActions({ ui, update }: { ui: ProjectUi["ai"]; update: (change: (current: ProjectUi["ai"]) => ProjectUi["ai"]) => void }) {
  const studio = useStudio();
  const { revalidate, setActiveJobVisible, beforeWrite, fence, status } = useSync();
  const [pageState, setPageState] = useState({ page: { runs: [], nextCursor: null } as RunPage, version: 0 });
  const page = pageState.page;
  const [run, setRun] = useState<RunView | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const actionFlight = useRef(false);
  const pageFlight = useRef<string | null>(null);
  const mounted = useRef(true);
  const uiRef = useRef(ui);
  const studioRef = useRef(studio);
  useLayoutEffect(() => { uiRef.current = ui; studioRef.current = studio; }, [ui, studio]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const adoptPage = useCallback((next: RunPage) => setPageState((current) => ({ page: next, version: current.version + 1 })), []);
  const resources = useMemo(() => createRunResources({ projectId: studio.projectId, apiRead, adoptPage, adoptRun: setRun }), [studio.projectId, adoptPage]);
  const selectedSummary = page.runs.find((item) => item.id === ui.selectedRunId);
  const canWrite = status.status === "ACTIVE" && (status.role === "OWNER" || status.role === "EDITOR");
  const activeJobVisible = Boolean(run && !isTerminal(run.state));

  useAiSyncReader(useCallback((status, fence) => resources.reconcile(status, fence), [resources]));
  useEffect(() => {
    resources.selectRun(ui.selectedRunId);
    const frame = requestAnimationFrame(() => void revalidate("focus"));
    return () => cancelAnimationFrame(frame);
  }, [resources, ui.selectedRunId, revalidate]);
  useEffect(() => {
    setActiveJobVisible(activeJobVisible);
    return () => setActiveJobVisible(false);
  }, [activeJobVisible, setActiveJobVisible]);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("run");
    if (requested && RUN_ID.test(requested) && requested !== ui.selectedRunId) update((current) => ({ ...current, selectedRunId: requested }));
  // Initial URL restoration is project-keyed; later selection changes use the component state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    if (ui.selectedRunId) search.set("run", ui.selectedRunId); else search.delete("run");
    const query = search.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, [ui.selectedRunId]);
  useEffect(() => {
    if (page.runs.length && !ui.selectedRunId) update((current) => ({ ...current, selectedRunId: page.runs[0]!.id }));
  }, [page.runs, ui.selectedRunId, update]);

  const chooseRun = (id: string | null) => update((current) => ({ ...current, selectedRunId: id }));
  const start = async (retry = false) => {
    if (actionFlight.current) return;
    const invocationFence = fence();
    const stillCurrent = () => mounted.current && invocationFence();
    const intent = uiRef.current;
    const selectionIntent = studioRef.current.ui.selection;
    actionFlight.current = true;
    setBusy(true);
    try {
    if (intent.pendingRequest && !retry) { setMessage("Resolve the pending AI request before starting another run."); return; }
    const candidate = intent.pendingRequest?.kind === "start" ? intent.pendingRequest : null;
    const pending = retry ? retryStartRequest(candidate, studio.projectId, studio.savedDraft.id) : null;
    if (retry && !pending) { setMessage("The original request belongs to a different project or draft. Review it before starting again."); return; }
    if (pending?.kind !== "start" && !studio.editable) { setMessage("This project is read-only. You can inspect its AI history."); return; }
    if (pending?.kind !== "start" && !ui.instruction.trim()) { setMessage("Add an instruction before generating or improving."); return; }
    if (intent.action === "REFINE_FLOW_SELECTION" && !pending && (!studioRef.current.ui.selection || studioRef.current.ui.selection.kind !== "NODES" || !studioRef.current.ui.selection.ids.length)) {
      setMessage("Select one or more steps in the flow before choosing Improve selection."); return;
    }
    if (!pending) {
      const authority = await beforeWrite();
      if (!stillCurrent()) return;
      if (authority.kind !== "current" || authority.status.status !== "ACTIVE" || !["OWNER", "EDITOR"].includes(authority.status.role)) { setMessage("This project is read-only or its access could not be confirmed."); return; }
      const currentStudio = studioRef.current;
      if (currentStudio.ui.buffers && Object.keys(currentStudio.ui.buffers).length || Object.keys(currentStudio.ui.endpointBuffers).length || Object.keys(currentStudio.ui.positionBuffers).length) {
        setMessage("Resolve the unsaved fields in Details by saving them or choosing Discard before capturing this action."); return;
      }
      if (!await currentStudio.saveChanges()) { if (stillCurrent()) setMessage("Your Studio changes could not be saved. Resolve them before capturing this action."); return; }
      if (!stillCurrent()) return;
      const currentUi = uiRef.current;
      if (currentUi.action !== intent.action) { setMessage("The action changed while saving. Review it and submit again."); return; }
      const latestStudio = studioRef.current;
      const saved = await latestStudio.inspectSavedExport(true);
      if (!stillCurrent()) { setMessage("The project changed while preparing this action. Review it and try again."); return; }
      if (!saved.ok) { setMessage(saved.message || "Save or resolve the pending Studio edits before continuing."); return; }
      const captureAuthority = await beforeWrite();
      if (!stillCurrent()) return;
      if (captureAuthority.kind !== "current" || captureAuthority.status.status !== "ACTIVE" || !["OWNER", "EDITOR"].includes(captureAuthority.status.role)
        || captureAuthority.status.currentDraftId !== saved.result.id || captureAuthority.status.documentRevision !== saved.result.documentRevision) {
        setMessage("The saved draft or access changed while preparing this action. Review it and try again."); return;
      }
      const latestSelection = latestStudio.ui.selection;
      if (intent.action === "REFINE_FLOW_SELECTION" && (!latestSelection || latestSelection.kind !== "NODES" || JSON.stringify(latestSelection.ids) !== JSON.stringify(selectionIntent?.kind === "NODES" ? selectionIntent.ids : []))) {
        setMessage("The selected steps changed while saving. Review the selection and submit again."); return;
      }
      const selection = intent.action === "REFINE_FLOW_SELECTION" && latestSelection?.kind === "NODES"
        ? { flowId: saved.result.document.nodes[latestSelection.ids[0]!]?.flowId ?? "", nodeIds: latestSelection.ids.filter((id) => Boolean(saved.result.document.nodes[id])) }
        : null;
      if (intent.action === "REFINE_FLOW_SELECTION" && (!selection?.flowId || !selection.nodeIds.length || selection.nodeIds.some((id) => saved.result.document.nodes[id]?.flowId !== selection.flowId))) {
        setMessage("Your saved selection changed. Select the steps again before improving them."); return;
      }
      const body = {
        taskType: intent.action,
        prompt: intent.instruction,
        draftId: saved.result.id,
        expectedDocumentRevision: saved.result.documentRevision,
        expectedParentSnapshotId: captureAuthority.status.approvedSnapshotId,
        context: { selection, sources: [] },
      };
      const submittedText = intent.instruction;
      const request = { kind: "start" as const, projectId: studio.projectId, draftId: saved.result.id, key: crypto.randomUUID(), body, submittedText };
      update((current) => ({ ...current, pendingRequest: request }));
      await send(request, false, stillCurrent);
      return;
    }
    await send(pending, true, stillCurrent);
    } finally { actionFlight.current = false; setBusy(false); }
  };

  const send = async (request: NonNullable<ProjectUi["ai"]["pendingRequest"]>, retry: boolean, stillCurrent: () => boolean) => {
    const authority = await beforeWrite();
    if (!stillCurrent()) return;
    if (authority.kind !== "current") { setMessage("Could not confirm current project access. Retry when ScopeRoom is available."); return; }
    if (!retry && (authority.status.status !== "ACTIVE" || !["OWNER", "EDITOR"].includes(authority.status.role))) { setMessage("This project is read-only now. Your instruction is still here."); return; }
    if (request.projectId !== studio.projectId || request.draftId !== request.body.draftId) return;
    if (!retry && (authority.status.currentDraftId !== request.draftId
      || authority.status.documentRevision !== request.body.expectedDocumentRevision
      || authority.status.approvedSnapshotId !== request.body.expectedParentSnapshotId)) {
      update((current) => ({ ...current, pendingRequest: null })); setMessage("The saved draft or baseline changed. Review the context and start again."); return;
    }
    setMessage("");
    const result = await apiMutate<{ runId: string; state: "QUEUED"; aiRevision: number }>(`/api/projects/${request.projectId}/ai-runs`, request.key, request.body);
    if (!stillCurrent()) return;
    if (sessionEnded(result)) return;
    if (result.ok) {
      update((current) => ({ ...current, pendingRequest: null, selectedRunId: result.data.runId,
        ...(request.kind === "start" ? { instruction: acknowledgedInstruction(current.instruction, request.submittedText) } : {}) }));
      setMessage("Run queued.");
      await revalidate("focus");
    } else if (result.uncertain) {
      update((current) => ({ ...current, pendingRequest: request }));
      setMessage("We couldn’t confirm this request. Retry uses the same saved input and key.");
    } else {
      update((current) => ({ ...current, pendingRequest: null }));
      setMessage(result.message || "The AI request was refused. Your instruction is still here.");
      if (result.status === 401 || result.status === 403 || result.status === 404) await revalidate("focus");
    }
  };

  const runControl = async (kind: "cancel" | "discard", selected: RunView, retry = false) => {
    if (actionFlight.current) return;
    const invocationFence = fence();
    const stillCurrent = () => mounted.current && invocationFence();
    const existing = ui.pendingRequest;
    if (existing && (!retry || existing.kind !== kind || existing.runId !== selected.id)) { setMessage("Resolve the pending AI request before starting another action."); return; }
    const request = existing && retry ? existing : {
      kind, projectId: studio.projectId, draftId: selected.draftId, runId: selected.id, key: crypto.randomUUID(),
      body: kind === "discard" ? { expectedResultHash: selected.resultHash } : {},
    };
    if (request.projectId !== studio.projectId || request.draftId !== selected.draftId) return;
    update((current) => ({ ...current, pendingRequest: request }));
    actionFlight.current = true; setBusy(true);
    try {
      const authority = await beforeWrite();
      if (!stillCurrent()) return;
      if (authority.kind !== "current") { setMessage("Could not confirm current project access."); return; }
      const result = await apiMutate<unknown>(`/api/projects/${request.projectId}/ai-runs/${request.runId}/${kind}`, request.key, request.body);
      if (!stillCurrent()) return;
      if (sessionEnded(result)) return;
      if (result.ok) {
        update((current) => ({ ...current, pendingRequest: null }));
        setMessage(kind === "cancel" ? "Cancellation requested. The provider may still be finishing; usage is not refunded here." : "Run discarded. Its saved history remains available.");
        await revalidate("focus");
      } else if (result.uncertain) setMessage(`We couldn’t confirm ${kind}. Retry uses the same key.`);
      else {
        update((current) => ({ ...current, pendingRequest: null }));
        setMessage(result.message || `This run could not be ${kind === "cancel" ? "cancelled" : "discarded"}.`);
        await revalidate("focus");
      }
    } finally { actionFlight.current = false; setBusy(false); }
  };

  const regenerate = (selected: RunView) => {
    if (!selected.capture) { setMessage("The captured input has expired. Enter a new instruction for another run."); return; }
    if (ui.pendingRequest) { setMessage("Resolve the pending AI request before regenerating."); return; }
    update((current) => ({ ...current, action: selected.taskType, instruction: selected.capture!.prompt }));
    setMessage("Review the instruction and current selection, then submit to capture a fresh saved context.");
    requestAnimationFrame(() => document.getElementById("ai-instruction")?.focus());
  };

  return <div className="ai-panel">
    <section className="detail-section ai-action" aria-labelledby="ai-action-heading">
      <h2 id="ai-action-heading">AI actions</h2>
      <label htmlFor="ai-action">Action</label>
      <select id="ai-action" value={ui.action} onChange={(event) => { const action = event.target.value as TaskKind; update((current) => ({ ...current, action })); setMessage(""); }} disabled={busy || Boolean(ui.pendingRequest)}>
        <option value="PROPOSE_FLOW">Generate a flow</option>
        <option value="REFINE_FLOW_SELECTION">Improve selected steps</option>
      </select>
      {ui.action === "REFINE_FLOW_SELECTION" && <p className="muted">Selection: {studio.ui.selection?.kind === "NODES" ? studio.ui.selection.ids.map((id) => studio.draft.document.nodes[id]?.label ?? id).join(", ") : "none"}. Only these steps and their incident connections are in scope.</p>}
      <label htmlFor="ai-instruction">Instruction</label>
      <textarea id="ai-instruction" rows={5} maxLength={16000} value={ui.instruction} onChange={(event) => update((current) => ({ ...current, instruction: event.target.value }))} placeholder={ui.action === "PROPOSE_FLOW" ? "Describe the flow to create…" : "Describe how these steps should improve…"} />
      {ui.pendingRequest?.kind === "start" ? <div className="view-actions"><button className="button primary small" type="button" onClick={() => void start(true)} disabled={busy}>Retry this request</button></div>
        : <button type="button" className="button primary" onClick={() => void start()} disabled={busy || Boolean(ui.pendingRequest) || !studio.editable}>{busy ? "Working…" : ui.action === "PROPOSE_FLOW" ? "Generate" : "Improve selection"}</button>}
      <p className="ai-message" role={message.includes("refused") || message.includes("could not") ? "alert" : "status"} aria-live="polite">{message}</p>
      <p className="muted">The saved draft, current baseline, action and selected flow or steps are sent. Run instructions and results are shared with current project members. Source management is not available in this stage; requests include no sources.</p>
    </section>
    {run ? <RunCard run={run} summary={selectedSummary} busy={busy} canWrite={canWrite} blockedByPending={Boolean(ui.pendingRequest && ui.pendingRequest.kind !== "apply" || ui.pendingRequest?.kind === "apply" && ui.pendingRequest.runId !== run.id)} pendingApply={ui.pendingRequest?.kind === "apply" && ui.pendingRequest.runId === run.id ? ui.pendingRequest : null}
      pendingControl={ui.pendingRequest && (ui.pendingRequest.kind === "cancel" || ui.pendingRequest.kind === "discard") && ui.pendingRequest.runId === run.id ? ui.pendingRequest : null}
      onCancel={() => void runControl("cancel", run)} onDiscard={() => void runControl("discard", run)} onApply={(request) => void retryApply(request)} onRegenerate={() => regenerate(run)}
      onRetryControl={() => void runControl(ui.pendingRequest?.kind === "cancel" ? "cancel" : "discard", run, true)} /> : <section className="detail-section"><h2>Selected run</h2><p className="muted">Choose a saved run from history or submit an action.</p></section>}
    <RunHistory runs={page.runs} selectedId={ui.selectedRunId} nextCursor={page.nextCursor} loading={loadingMore} onSelect={chooseRun} onMore={() => void loadMore()} />
  </div>;

  async function loadMore() {
    const cursor = pageState.page.nextCursor;
    if (!cursor || pageFlight.current === cursor) return;
    pageFlight.current = cursor;
    setLoadingMore(true);
    const version = pageState.version;
    const invocationFence = fence();
    const stillCurrent = () => mounted.current && invocationFence();
    const projectId = studio.projectId;
    try {
      const result = await apiRead<RunPage>(`/api/projects/${projectId}/ai-runs?cursor=${encodeURIComponent(cursor)}`);
      if (!stillCurrent()) return;
      if (sessionEnded(result)) return;
      if (!result.ok) { setMessage(result.message); return; }
      setPageState((current) => {
        if (current.version !== version || current.page.nextCursor !== cursor) return current;
        const seen = new Set(current.page.runs.map((item) => item.id));
        const next = { runs: [...current.page.runs, ...result.data.runs.filter((item) => !seen.has(item.id))], nextCursor: result.data.nextCursor };
        return { page: next, version: current.version + 1 };
      });
    } finally {
      if (pageFlight.current === cursor) { pageFlight.current = null; if (mounted.current) setLoadingMore(false); }
    }
  }

  async function retryApply(request: { key: string; body: Record<string, unknown>; runId: string }) {
    if (actionFlight.current) return;
    const invocationFence = fence();
    const stillCurrent = () => mounted.current && invocationFence();
    actionFlight.current = true; setBusy(true);
    try {
    const pending = uiRef.current.pendingRequest;
    if (pending && pending.kind !== "apply") { setMessage("Resolve the pending AI request before applying this proposal."); return; }
    if (pending?.kind === "apply" && pending.runId !== request.runId) { setMessage("Retry or resolve the pending Apply for the selected run before applying another proposal."); return; }
    const exact = pending?.kind === "apply" ? pending : { kind: "apply" as const, projectId: studio.projectId, draftId: String(request.body.draftId), runId: request.runId, key: request.key, body: request.body };
    const retry = pending?.kind === "apply";
    update((current) => ({ ...current, pendingRequest: exact }));
    if (!exact.runId || exact.projectId !== studio.projectId) return;
    const input = exact.body as { draftId: string; expectedDocumentRevision: number; expectedParentSnapshotId: string | null; resultHash: string; selectedOperationIds: string[] };
    const outcome = await studio.applyAiRun(exact.runId, input, exact.key, retry);
    if (!stillCurrent()) return;
    if (outcome.ok && !outcome.result.currentDraft) {
      update((current) => ({ ...current, pendingRequest: null }));
      setMessage("This saved Apply belongs to the previous draft. The current draft was left unchanged.");
    } else if (outcome.ok) {
      if (outcome.result.adopted) {
        update((current) => ({ ...current, pendingRequest: null }));
        setMessage("Selected changes applied to the draft. They are not approved.");
      } else setMessage("Apply was acknowledged. The saved draft has not caught up yet; Retry checks the same application.");
    } else if (outcome.uncertain) {
      setMessage("We couldn’t confirm Apply. Retry will use the same selection, input and key.");
    } else {
      update((current) => ({ ...current, pendingRequest: null }));
      setMessage(outcome.message || "This proposal could not be applied. It remains available for review.");
      await revalidate("focus");
    }
    } finally { actionFlight.current = false; setBusy(false); }
  }
}

function isTerminal(state: RunView["state"]) { return ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(state); }
