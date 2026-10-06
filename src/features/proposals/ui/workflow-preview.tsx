"use client";

import { useState } from "react";
import type { DraftView } from "@/features/drafts/contracts/scope-document";
import Dialog from "@/features/shell/ui/dialog";
import { ReadOnlyFlowCanvas } from "@/features/studio/ui/flow-canvas";
import { connectionsInOrder, flowsInOrder, stepsInOrder } from "@/features/studio/ui/graph-view";

function PreviewBody({ draft, flowId, view, setView }: { draft: DraftView; flowId: string; view: "canvas" | "list"; setView: (view: "canvas" | "list") => void }) {
  const steps = stepsInOrder(draft.document, draft.layout, flowId), edges = connectionsInOrder(draft.document, draft.layout, flowId);
  return <>
    <div className="segmented" role="group" aria-label="Preview view">
      <button type="button" aria-pressed={view === "canvas"} onClick={() => setView("canvas")}>Canvas</button>
      <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
    </div>
    {view === "canvas" ? <ReadOnlyFlowCanvas key={flowId} draft={draft} flowId={flowId} /> : <div className="proposal-preview-list">
      <h4>Steps</h4>
      <ul>{steps.map((node) => <li key={node.id}><strong>{node.label}</strong><span>{node.actorLabel || "No actor"}</span><p>{node.description || "No behaviour entered."}</p>{node.assumptionNotes.length > 0 && <p>Conditions and assumptions: {node.assumptionNotes.join(" · ")}</p>}</li>)}</ul>
      <h4>Connections</h4>
      {!edges.length ? <p className="muted">No connections yet.</p> : <ul>{edges.map((edge) => <li key={edge.id}><strong>{draft.document.nodes[edge.fromId]?.label} → {draft.document.nodes[edge.toId]?.label}</strong><span>{edge.condition || "No condition"}</span></li>)}</ul>}
    </div>}
  </>;
}

export function WorkflowPreview({ draft, narrow }: { draft: DraftView; narrow: boolean }) {
  const flows = flowsInOrder(draft.document);
  const [flowId, setFlowId] = useState(flows[0]?.id ?? "");
  const [view, setView] = useState<"canvas" | "list">(narrow ? "list" : "canvas");
  const [expanded, setExpanded] = useState(false);
  const selected = draft.document.flows[flowId] ? flowId : flows[0]?.id ?? "";
  if (!selected) return null;
  const body = <PreviewBody draft={draft} flowId={selected} view={view} setView={setView} />;
  return <section className="proposal-workflow-preview" aria-labelledby="proposal-workflow-heading" onKeyDown={(event) => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && ["s", "z", "y"].includes(event.key.toLowerCase())) event.preventDefault(); }}>
    <header><div><h3 id="proposal-workflow-heading">Full proposed workflow</h3><p className="muted">Preview · not saved</p></div><button type="button" className="button quiet small" onClick={() => setExpanded(true)}>Expand preview</button></header>
    <label>Preview flow<select value={selected} onChange={(event) => setFlowId(event.target.value)}>{flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.title}</option>)}</select></label>
    {body}
    {expanded && <Dialog title="Full proposed workflow" onClose={() => setExpanded(false)} footer={<button type="button" className="button primary" onClick={() => setExpanded(false)}>Close preview</button>}>
      <label>Preview flow<select value={selected} onChange={(event) => setFlowId(event.target.value)}>{flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.title}</option>)}</select></label>
      {body}
    </Dialog>}
  </section>;
}
