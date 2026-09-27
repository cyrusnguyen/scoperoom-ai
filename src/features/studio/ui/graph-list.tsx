"use client";

import { useState } from "react";
import { KIND_LABELS } from "./fields";
import { connectionsInOrder, matchesStep, stepName, stepsInOrder } from "./graph-view";
import { explain, useStudio } from "./studio-context";
import { toggleNode } from "./studio-ui";

/**
 * The ordered List (UI02 "Complete non-drag operation map"): search by name or id, checkboxes with a selected count
 * and Clear, and the flow's connections with Delete. Filtering never clears a hidden selection.
 */
export default function GraphList({ flowId, onDeleteSelected }: { flowId: string; onDeleteSelected?: () => void }) {
  const { draft, editable, busy, ui, update, run } = useStudio();
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const { document, layout } = draft;
  const steps = stepsInOrder(document, layout, flowId);
  const shown = steps.filter((node) => matchesStep(node, query));
  const selected = ui.selection?.kind === "NODES" ? ui.selection.ids : [];
  const connections = connectionsInOrder(document, layout, flowId);

  const deleteConnection = async (edgeId: string) => {
    const outcome = await run({ commandSchemaVersion: 1, command: "DELETE_EDGE", expectedDocumentRevision: draft.documentRevision, payload: { edgeId } });
    setMessage(outcome.ok ? "Connection deleted." : explain(outcome));
  };

  return <div className="graph-list">
    <div className="list-tools">
      <label className="sr-only" htmlFor="step-search">Find a step</label>
      <input id="step-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a step by name or ID" />
      <span className="muted" role="status">{selected.length} selected</span>
      {selected.length > 0 && <button type="button" className="button quiet small" onClick={() => update(() => ({ selection: null }))}>Clear</button>}
      {editable && onDeleteSelected && selected.length > 0 && <button type="button" className="button danger small" onClick={onDeleteSelected} disabled={busy}>Delete selected…</button>}
    </div>
    <h3 className="list-heading">Steps <span className="muted">{query ? `Showing ${shown.length} of ${steps.length}` : steps.length}</span></h3>
    {!steps.length ? <p className="muted">No steps yet.</p> : !shown.length ? <p className="muted">No steps match “{query}”.</p>
      : <ul className="step-list" aria-label="Steps">{shown.map((node) => {
        const name = stepName(document, node.id);
        const picked = selected.includes(node.id);
        return <li key={node.id} className="step-row" data-selected={picked || undefined}>
          <label className="step-check"><input type="checkbox" checked={picked} onChange={() => update((current) => ({ selection: toggleNode(current.selection, node.id) }))} aria-label={`Select ${name}`} /></label>
          <button type="button" className="step-open" onClick={() => update(() => ({ selection: { kind: "NODES", ids: [node.id] } }))} aria-current={picked && selected.length === 1 ? "true" : undefined}>
            <small>{KIND_LABELS[node.kind]}</small><strong>{name}</strong>{node.actorLabel && <span>{node.actorLabel}</span>}
          </button>
        </li>;
      })}</ul>}
    <h3 className="list-heading">Connections <span className="muted">{connections.length}</span></h3>
    {!connections.length ? <p className="muted">No connections yet.</p>
      : <ul className="step-list" aria-label="Connections">{connections.map((edge) => {
        const route = `${stepName(document, edge.fromId)} → ${stepName(document, edge.toId)}`;
        return <li key={edge.id} className="step-row" data-selected={(ui.selection?.kind === "EDGE" && ui.selection.id === edge.id) || undefined}>
          <button type="button" className="step-open" onClick={() => update(() => ({ selection: { kind: "EDGE", id: edge.id } }))}>
            <strong>{route}</strong>{edge.condition && <span>{edge.condition}</span>}
          </button>
          {editable && <button type="button" className="button quiet small" onClick={() => void deleteConnection(edge.id)} disabled={busy} aria-label={`Delete connection ${route}`}>Delete</button>}
        </li>;
      })}</ul>}
    <p className="muted" role="status" aria-live="polite">{message}</p>
  </div>;
}
