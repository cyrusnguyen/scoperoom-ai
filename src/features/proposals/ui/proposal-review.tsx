"use client";

import { useState } from "react";
import type { ProposalOperation, RunView } from "../contracts/tasks";

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

export function ProposalReview({ run, pendingApply, busy, canWrite, blockedByPending, onApply }: {
  run: RunView; pendingApply: { key: string; body: Record<string, unknown>; runId?: string } | null; busy: boolean; canWrite: boolean; blockedByPending: boolean;
  onApply: (request: { key: string; body: Record<string, unknown>; runId: string }) => void;
}) {
  const operations = run.result?.kind === "proposal" ? run.result.operations : [];
  const [selected, setSelected] = useState<string[]>([]);
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const missingSet = new Set<string>();
  const includeDependencies = (id: string) => { for (const dependency of byId.get(id)?.dependsOn ?? []) if (!selected.includes(dependency) && !missingSet.has(dependency)) { missingSet.add(dependency); includeDependencies(dependency); } };
  selected.forEach(includeDependencies);
  const missing = [...missingSet];
  const canApply = canWrite && !blockedByPending && run.applicability === "APPLICABLE" && operations.length > 0 && selected.length > 0 && missing.length === 0 && run.resultHash !== null && !busy;
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const apply = () => {
    if (!canApply || !run.resultHash) return;
    onApply({ runId: run.id, key: crypto.randomUUID(), body: {
      draftId: run.draftId, expectedDocumentRevision: run.documentRevision, expectedParentSnapshotId: run.parentSnapshotId,
      resultHash: run.resultHash, selectedOperationIds: selected,
    } });
  };
  const retry = () => pendingApply && onApply({ runId: run.id, key: pendingApply.key, body: pendingApply.body });
  const sourceNames = new Map(run.capture?.sources.map((source) => [source.sourceVersionId, source.title]) ?? []);

  return <section className="detail-section proposal-review" aria-labelledby="proposal-heading">
    <h2 id="proposal-heading">Proposal review</h2>
    {run.disposition === "EXPIRED" && <p className="inline-note" role="status">This result has expired. Its history remains, but the proposal body is no longer available.</p>}
    {run.state === "FAILED" && <p className="inline-note" role="status">The provider could not complete this run{run.failureCode ? ` (${run.failureCode.toLowerCase().replaceAll("_", " ")})` : ""}. Manual editing remains available.</p>}
    {!run.result && run.disposition !== "EXPIRED" && <p className="muted">No proposal is available for this run.</p>}
    {run.result?.kind === "clarification" && <p>{run.result.message}</p>}
    {run.result?.kind === "proposal" && <>
      <p className="muted">Select one dependency-complete group. Applying any subset consumes this run; remaining suggestions need a new action.</p>
      {operations.map((operation) => <label className="proposal-operation" key={operation.id}>
        <input type="checkbox" checked={selected.includes(operation.id)} onChange={() => toggle(operation.id)} disabled={!canWrite || run.applicability !== "APPLICABLE" || Boolean(pendingApply)} />
        <span>{noun(operation)} <small>({operation.id})</small></span>
      </label>)}
      {missing.length > 0 && <p className="field-error" role="alert">Also select required operations: {missing.join(", ")}.</p>}
      {run.diff && <div className="proposal-diff" aria-label="Before and after changes">
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
      {run.result.assumptions.length > 0 && <><h3>Assumptions</h3><ul>{run.result.assumptions.map((item, i) => <li key={`${i}-${item}`}>{item}</li>)}</ul></>}
      {run.result.citations.length > 0 && <><h3>Source citations</h3><ul>{run.result.citations.map((source) => <li key={`${source.sourceVersionId}-${source.startLine}-${source.endLine}`}>
        {sourceNames.get(source.sourceVersionId) ?? source.sourceVersionId}, lines {source.startLine}–{source.endLine}: “{source.excerpt}” <small>({source.sourceVersionId})</small>
      </li>)}</ul></>}
      {run.applicability !== "APPLICABLE" && <p className="inline-note" role="status">This result is inspectable but can’t be applied: {run.applicabilityReasons.map((reason) => reason.toLowerCase().replaceAll("_", " ")).join(", ") || "it is no longer current"}.</p>}
      {blockedByPending && <p className="inline-note" role="status">Resolve the pending AI request before changing this proposal.</p>}
      {!pendingApply && <button type="button" className="button primary" onClick={apply} disabled={!canApply}>Apply selected changes</button>}
    </>}
    {pendingApply && <button type="button" className="button primary" onClick={retry} disabled={busy}>Retry Apply with the same selection</button>}
    <p className="muted">AI suggestions change the current draft only. Applying does not approve or publish them.</p>
  </section>;
}
