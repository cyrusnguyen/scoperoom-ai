"use client";

import { useState } from "react";
import { useSync } from "@/features/collaboration/ui/sync-context";
import { useStudio } from "@/features/studio/ui/studio-context";
import type { ProposalOperation, RunView } from "../contracts/tasks";
import { projectProposalPreview, newApplyBlocker } from "./preview-projection";
import { WorkflowPreview } from "./workflow-preview";

const noun = (operation: ProposalOperation) => operation.edit.command.replaceAll("_", " ").toLowerCase();
const fieldLabels: Record<string, string> = {
  title: "Name", purpose: "Purpose", classification: "Classification", inclusion: "Inclusion", label: "Step", description: "Behaviour",
  actorLabel: "Actor", kind: "Step type", assumptionNotes: "Conditions and assumptions", condition: "Condition", fromId: "From", toId: "To", flowId: "Flow",
};
const recordFields = ["title", "purpose", "classification", "inclusion", "label", "description", "actorLabel", "kind", "assumptionNotes", "condition", "fromId", "toId", "flowId"] as const;
function recordLabel(record: Record<string, unknown> | undefined, id: string) {
  return typeof record?.label === "string" ? record.label : typeof record?.title === "string" ? record.title : id;
}
function displayValue(key: string, value: unknown, records: Record<string, unknown>[]) {
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join(", ") : "None";
  if (typeof value === "string" && (key === "flowId" || key === "fromId" || key === "toId")) return recordLabel(records.find((record) => record.id === value), value);
  return typeof value === "string" || typeof value === "number" ? String(value) || "Empty" : "None";
}

export function ProposalReview({ run, pendingApply, busy, canWrite, blockedByPending, onApply, inspection = false, authorityConfirmed = true }: {
  run: RunView; pendingApply: { key: string; body: Record<string, unknown>; runId?: string } | null; busy: boolean; canWrite: boolean; blockedByPending: boolean;
  authorityConfirmed?: boolean; inspection?: boolean; onApply: (request: { key: string; body: Record<string, unknown>; runId: string }) => void;
}) {
  const studio = useStudio();
  const { status, failures } = useSync();
  const operations = run.result?.kind === "proposal" ? run.result.operations : [];
  const preview = projectProposalPreview(studio.savedDraft, status, run, inspection);
  const [localSelection, setSelected] = useState<string[]>([]);
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const pendingSelection = pendingApply?.body.selectedOperationIds;
  const selected = pendingApply
    ? Array.isArray(pendingSelection) ? pendingSelection.filter((id): id is string => typeof id === "string" && byId.has(id)) : []
    : localSelection;
  const missingSet = new Set<string>();
  const includeDependencies = (id: string) => { for (const dependency of byId.get(id)?.dependsOn ?? []) if (!selected.includes(dependency) && !missingSet.has(dependency)) { missingSet.add(dependency); includeDependencies(dependency); } };
  selected.forEach(includeDependencies);
  const missing = [...missingSet];
  const blocker = newApplyBlocker({ canWrite, editable: studio.editable, authorityConfirmed: authorityConfirmed && !failures, busy: studio.busy || busy, dirty: studio.exportDirty, blockedByPending, preview: Boolean(preview) });
  const canApply = !inspection && !blocker && !pendingApply && run.applicability === "APPLICABLE" && operations.length > 0 && run.resultHash !== null;
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const apply = (selectedOperationIds: string[]) => {
    if (!canApply || !run.resultHash) return;
    onApply({ runId: run.id, key: crypto.randomUUID(), body: {
      draftId: run.draftId, expectedDocumentRevision: run.documentRevision, expectedParentSnapshotId: run.parentSnapshotId,
      resultHash: run.resultHash, selectedOperationIds,
    } });
  };
  const retry = () => pendingApply && onApply({ runId: run.id, key: pendingApply.key, body: pendingApply.body });
  const sourceNames = new Map(run.capture?.sources.map((source) => [source.sourceVersionId, source.title]) ?? []);

  const records = [
    ...(run.capture ? [...run.capture.graph.flows, ...run.capture.graph.nodes, ...run.capture.graph.edges] : []),
    ...operations.flatMap(({ edit }) => edit.command === "CREATE_FLOW" || edit.command === "ADD_NODE" ? [{ ...edit.payload, id: edit.payload.ref }] : []),
  ] as unknown as Record<string, unknown>[];
  const label = (id: string) => recordLabel(records.find((record) => record.id === id), id);
  const edgeLabel = (id: string) => {
    const edge = run.capture?.graph.edges.find((record) => record.id === id);
    return edge ? `${label(edge.fromId)} → ${label(edge.toId)}${edge.condition ? ` (${edge.condition})` : ""}` : id;
  };
  const target = ({ edit }: ProposalOperation) => {
    switch (edit.command) {
      case "CREATE_FLOW": return edit.payload.title;
      case "ADD_NODE": return `${edit.payload.label} (in ${label(edit.payload.flowId)})`;
      case "UPDATE_NODE": return label(edit.payload.nodeId);
      case "DELETE_NODES": return edit.payload.nodeIds.map(label).join(", ");
      case "ADD_EDGE": return `${label(edit.payload.fromId)} → ${label(edit.payload.toId)}`;
      case "UPDATE_EDGE": case "RECONNECT_EDGE": case "DELETE_EDGE": return edgeLabel(edit.payload.edgeId);
    }
  };
  const fields = ({ edit }: ProposalOperation) => recordFields.filter((field) => field in edit.payload).map((field) => {
    // Inclusion is reset by Apply; only name the field here, with its actual value in the full context.
    if (field === "inclusion") return fieldLabels[field];
    return `${fieldLabels[field]}: ${displayValue(field, (edit.payload as unknown as Record<string, unknown>)[field], records)}`;
  }).join(" · ");

  return <section className="detail-section proposal-review" aria-labelledby="proposal-heading">
    <h2 id="proposal-heading">Proposal review</h2>
    {run.disposition === "EXPIRED" && <p className="inline-note" role="status">This result has expired. Its history remains, but the proposal body is no longer available.</p>}
    {run.state === "FAILED" && <p className="inline-note" role="status">The provider could not complete this run{run.failureCode ? ` (${run.failureCode.toLowerCase().replaceAll("_", " ")})` : ""}. Manual editing remains available.</p>}
    {!run.result && run.disposition !== "EXPIRED" && <p className="muted">No proposal is available for this run.</p>}
    {run.result?.kind === "clarification" && <p>{run.result.message}</p>}
    {run.result?.kind === "proposal" && <>
      {inspection ? <p className="inline-note">Capture-only history inspection.</p> : preview ? <WorkflowPreview draft={preview} narrow={studio.narrow} /> : <p className="inline-note" role="status">Full preview is unavailable because this saved draft no longer matches the captured proposal. Capture-only details remain below.</p>}
      {run.diff && <p>{run.diff.createdIds.length} added · {run.diff.updatedIds.length} updated · {run.diff.retiredIds.length} removed</p>}
      {run.result.assumptions.length > 0 && <><h3>Assumptions</h3><ul>{run.result.assumptions.map((item, i) => <li key={`${i}-${item}`}>{item}</li>)}</ul></>}
      {run.result.citations.length > 0 && <><h3>Source citations</h3><ul>{run.result.citations.map((source) => <li key={`${source.sourceVersionId}-${source.startLine}-${source.endLine}`}>
        {sourceNames.get(source.sourceVersionId) ?? source.sourceVersionId}, lines {source.startLine}–{source.endLine}: “{source.excerpt}” <small>({source.sourceVersionId})</small>
      </li>)}</ul></>}
      {!inspection && blocker && (preview || !blocker.startsWith("Full preview")) && <p className="inline-note" role="status">{blocker}</p>}
      {run.applicability !== "APPLICABLE" && <p className="inline-note" role="status">This result is inspectable but can’t be applied: {run.applicabilityReasons.map(reason => reason.toLowerCase().replaceAll("_", " ")).join(", ") || "it is no longer current"}.</p>}
      {!inspection && <>
      <p className="muted">Apply all uses every proposed change. Choosing a subset also consumes this proposal; the full preview always shows all proposed changes.</p>
      {!pendingApply && <button type="button" className="button primary" onClick={() => apply(operations.map(operation => operation.id))} disabled={!canApply}>Apply all changes</button>}
      <details className="proposal-subset"><summary>Choose individual changes</summary>
      <p className="muted">{selected.length} of {operations.length} operations selected for Apply. Unchecked operations are context only.</p>
      {operations.map((operation) => <label className="proposal-operation" key={operation.id}>
        <input type="checkbox" checked={selected.includes(operation.id)} onChange={() => toggle(operation.id)} disabled={!canWrite || run.applicability !== "APPLICABLE" || Boolean(pendingApply)} />
        <span><strong>{noun(operation)}: {target(operation)}</strong>
          {fields(operation) && <><br /><small>{fields(operation)}</small></>}
          <br /><small>{selected.includes(operation.id) ? "Selected for Apply" : "Context only, not selected for Apply"} · Operation {operation.id}</small>
        </span>
      </label>)}
      {missing.length > 0 && <p className="field-error" role="alert">Also select required operations: {missing.join(", ")}.</p>}
      {!pendingApply && <button type="button" className="button quiet" onClick={() => apply(selected)} disabled={!canApply || !selected.length || missing.length > 0}>Apply selected changes ({selected.length})</button>}
      </details></>}
      <details className="proposal-change-details"><summary>Change details</summary>
      {run.diff && <div className="proposal-diff" aria-label="Full proposal before and after changes">
        <h3>Full proposal context</h3>
        <p className="muted">This before/after list includes all suggestions, including unchecked operations. These are capture-only change details, not a complete historical saved workflow.</p>
        <p>{run.diff.createdIds.length} added · {run.diff.updatedIds.length} updated · {run.diff.retiredIds.length} removed</p>
        {[...run.diff.createdIds.map((id) => ["Added", id] as const), ...run.diff.updatedIds.map((id) => ["Updated", id] as const), ...run.diff.retiredIds.map((id) => ["Removed", id] as const)].map(([kind, id]) => {
          const before = [...run.diff!.before.flows, ...run.diff!.before.nodes, ...run.diff!.before.edges].find((item) => item.id === id);
          const after = [...run.diff!.after.flows, ...run.diff!.after.nodes, ...run.diff!.after.edges].find((item) => item.id === id);
          const beforeRecord = before as unknown as Record<string, unknown> | undefined;
          const afterRecord = after as unknown as Record<string, unknown> | undefined;
          const records = [...run.diff!.after.flows, ...run.diff!.after.nodes, ...run.diff!.after.edges] as unknown as Record<string, unknown>[];
          const changed = recordFields.filter((field) => JSON.stringify(beforeRecord?.[field]) !== JSON.stringify(afterRecord?.[field]));
          return <details key={`${kind}-${id}`}><summary>{kind}: {recordLabel(afterRecord ?? beforeRecord, id)}</summary>
            {changed.length > 0 && <dl className="proposal-fields">{changed.map((field) => <div key={field}><dt>{fieldLabels[field] ?? field}</dt><dd><span className="proposal-before">{beforeRecord ? displayValue(field, beforeRecord[field], records) : "Not present"}</span><span aria-hidden="true"> → </span><span className="proposal-after">{afterRecord ? displayValue(field, afterRecord[field], records) : "Removed"}</span></dd></div>)}</dl>}
            <details className="proposal-audit"><summary>Captured identifiers and revisions</summary><dl><div><dt>Record id</dt><dd>{id}</dd></div><div><dt>Before</dt><dd>{beforeRecord ? `version ${String(beforeRecord.version)}, behaviour revision ${String(beforeRecord.behaviourVersion)}` : "Not present"}</dd></div><div><dt>After</dt><dd>{afterRecord ? `version ${String(afterRecord.version)}, behaviour revision ${String(afterRecord.behaviourVersion)}` : "Removed"}</dd></div></dl></details>
          </details>;
        })}
      </div>}
      </details>
    </>}
    {!inspection && pendingApply && <button type="button" className="button primary" onClick={retry} disabled={busy}>Retry Apply with the same selection</button>}
    <p className="muted">AI suggestions change the current draft only. Applying does not approve or publish them.</p>
  </section>;
}
