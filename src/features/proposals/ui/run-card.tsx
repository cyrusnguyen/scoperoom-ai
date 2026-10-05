"use client";

import type { RunSummary, RunView } from "../contracts/tasks";
import { ProposalReview } from "./proposal-review";

const stateText: Record<RunView["state"], string> = {
  QUEUED: "Queued", RUNNING: "Running", VALIDATING: "Validating", SUCCEEDED: "Succeeded", FAILED: "Failed", CANCELLED: "Cancelled", TIMED_OUT: "Timed out",
};
const active = (state: RunView["state"]) => ["QUEUED", "RUNNING", "VALIDATING"].includes(state);
const tokens = (value: number | null) => value === null ? "Unknown" : value.toLocaleString();

export function RunCard({ run, summary, busy, canWrite, blockedByPending, pendingApply, pendingControl, onCancel, onDiscard, onApply, onRegenerate, onRetryControl }: {
  run: RunView; summary?: RunSummary; busy: boolean; canWrite: boolean; blockedByPending: boolean; pendingApply: { key: string; body: Record<string, unknown>; runId?: string } | null;
  pendingControl: { kind: string } | null; onCancel: () => void; onDiscard: () => void; onApply: (request: { key: string; body: Record<string, unknown>; runId: string }) => void;
  onRegenerate: () => void; onRetryControl: () => void;
}) {
  const capture = run.capture;
  const selected = capture?.selection;
  const flow = selected ? capture?.graph.flows.find((item) => item.id === selected.flowId) : null;
  const nodeLabels = selected ? selected.nodeIds.map((id) => capture?.graph.nodes.find((node) => node.id === id)?.label ?? id) : [];
  return <article className="detail-section run-card" aria-labelledby="run-card-heading">
    <header className="run-card-header"><h2 id="run-card-heading">Current run</h2><span className="run-state" data-state={run.state}>{stateText[run.state]}</span></header>
    {run.cancelRequestedAt && active(run.state) && <p className="inline-note" role="status">Cancellation requested. The provider may still be finishing, and usage is not refunded here.</p>}
    <dl className="ai-run-facts">
      <div><dt>Action</dt><dd>{run.taskType === "PROPOSE_FLOW" ? "Generate a flow" : "Improve selected steps"}</dd></div>
      <div><dt>Captured draft</dt><dd>{run.draftId} · document revision {run.documentRevision} · baseline {run.parentSnapshotId ?? "none"}</dd></div>
      {selected && <div><dt>Captured selection</dt><dd>{flow?.title ?? selected.flowId}: {nodeLabels.join(", ")}</dd></div>}
      <div><dt>Included sources</dt><dd>{capture?.sources.length ? capture.sources.map((source) => `${source.title} (${source.sourceVersionId})`).join(", ") : "None"}</dd></div>
      <div><dt>Token usage</dt><dd>Input {tokens(run.usage.inputTokens)} · output {tokens(run.usage.outputTokens)}</dd></div>
      {run.expiresAt && <div><dt>Result retention</dt><dd>Until {new Date(run.expiresAt).toLocaleString()}</dd></div>}
    </dl>
    {capture && <details className="ai-capture"><summary>Exact captured instruction and context</summary><p>{capture.prompt}</p>
      <dl><div><dt>Draft and document revision</dt><dd>{capture.draftId} · {capture.documentRevision}</dd></div><div><dt>Baseline</dt><dd>{capture.parentSnapshotId ?? "None"}</dd></div>
        <div><dt>Selection ids</dt><dd>{capture.selection ? `${capture.selection.flowId}: ${capture.selection.nodeIds.join(", ")}` : "None"}</dd></div>
        <div><dt>Source version ids</dt><dd>{capture.sources.length ? capture.sources.map((source) => source.sourceVersionId).join(", ") : "None"}</dd></div>
      </dl>
    </details>}
    {summary?.flowId && <p className="muted">Flow id {summary.flowId}</p>}
    <p className="muted">Request id {run.id}</p>
    {pendingControl && <button type="button" className="button quiet small" onClick={onRetryControl} disabled={busy || !canWrite}>Retry {pendingControl.kind}</button>}
    {canWrite && active(run.state) && !run.cancelRequestedAt && !pendingControl?.kind.includes("cancel") && <button type="button" className="button quiet small" disabled={busy || blockedByPending} onClick={onCancel}>Cancel run…</button>}
    {canWrite && run.state === "SUCCEEDED" && run.disposition === "AVAILABLE" && run.resultHash && !pendingControl?.kind.includes("discard") && <button type="button" className="button quiet small" disabled={busy || blockedByPending} onClick={onDiscard}>Discard proposal</button>}
    {canWrite && run.capture && <button type="button" className="button quiet small" disabled={busy || blockedByPending || Boolean(pendingApply || pendingControl)} onClick={onRegenerate}>{run.applicability === "STALE" ? "Improve again with a fresh capture" : "Regenerate with a fresh capture"}</button>}
    {!canWrite && <p className="muted" role="status">Read-only history. Apply and run controls are available to project editors in an active project.</p>}
    <ProposalReview key={run.id} run={run} pendingApply={pendingApply} busy={busy} canWrite={canWrite} blockedByPending={blockedByPending} onApply={onApply} />
  </article>;
}
