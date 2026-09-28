"use client";

import { useState, type SubmitEvent } from "react";
import { flushSync } from "react-dom";
import type { GraphCommand } from "@/features/drafts/contracts/commands";
import { CLASSIFICATIONS, INCLUSIONS, LIMITS, type Classification, type Inclusion } from "@/features/drafts/contracts/scope-document";
import { dependencyPlan } from "@/features/drafts/domain/graph";
import Dialog from "@/features/shell/ui/dialog";
import { Icon } from "@/features/shell/ui/icon";
import { CLASSIFICATION_LABELS, fieldErrors, INCLUSION_LABELS } from "./fields";
import { currentFlow, flowsInOrder } from "./graph-view";
import { explain, formKeys, useCommandSubmit, useStudio } from "./studio-context";

/** Header control naming the open flow; it opens the Flows dialog. Hidden until the project has a flow. */
export function FlowSwitcher() {
  const { draft, ui } = useStudio();
  const flow = currentFlow(draft.document, ui.flowId);
  return flow ? <FlowSwitcherControl title={flow.title} /> : null;
}

function FlowSwitcherControl({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="button quiet small flow-switch" onClick={() => setOpen(true)} aria-haspopup="dialog" title={title}>
      <Icon name="flow" size={13} /><span>{title}</span><Icon name="chevron" size={12} />
    </button>
    {open && <FlowsDialog onClose={() => setOpen(false)} />}
  </>;
}

type Mode = "list" | "create" | "delete";
type FlowValues = { title: string; classification: string; inclusion: string };

/**
 * The flow menu (UI02): open, create, duplicate and delete flows, with a local inclusion filter. Flows stay exploratory
 * until someone marks them included; no requirement or approver is needed first. Creating, duplicating and deleting
 * are local changes like any other; opening another flow saves unsaved changes first (Task 14b).
 */
export function FlowsDialog({ onClose, creating = false }: { onClose: () => void; creating?: boolean }) {
  const { draft, editable, ui, update, saveChanges } = useStudio();
  const submitCommand = useCommandSubmit();
  const [mode, setMode] = useState<Mode>(creating ? "create" : "list");
  const [filter, setFilter] = useState<"ALL" | Inclusion>("ALL");
  const [values, setValues] = useState<FlowValues>({ title: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" });
  const [titleError, setTitleError] = useState("");
  const [message, setMessage] = useState("");
  // While the save before a switch runs, the form is read-only: text typed then would be lost when the dialog closes.
  const [saving, setSaving] = useState(false);
  const { document } = draft;
  const flows = flowsInOrder(document);
  const current = currentFlow(document, ui.flowId);
  const shown = flows.filter((flow) => filter === "ALL" || flow.inclusion === filter);
  const full = flows.length >= LIMITS.flows;
  const duplicateTooLong = Boolean(current && [...`Copy of ${current.title}`].length > LIMITS.title);
  const counts = (flowId: string) => Object.values(document.nodes).filter((node) => node.flowId === flowId).length;
  const open = async (flowId: string | null) => {
    // Unsaved changes are saved before another flow opens; if they cannot be, this flow stays open with them. After a
    // deleted flow (null) the view falls back to another flow of the same draft.
    setSaving(true);
    const saved = !flowId || flowId === current?.id || await saveChanges();
    setSaving(false);
    if (!saved) {
      setMessage("Your changes aren’t saved yet, so this flow stays open. Resolve them in the Studio, then switch.");
      return;
    }
    // Commit the destination and native dialog close before focusing outside its modal focus trap.
    flushSync(() => {
      update(() => ({ flowId, selection: null }));
      onClose();
    });
    requestAnimationFrame(() => (window.document.getElementById("studio-flow-title") ?? window.document.querySelector<HTMLElement>("#editor-main h1"))?.focus());
  };
  const send = async (command: GraphCommand) => {
    const outcome = await submitCommand(command);
    if (!outcome.ok) {
      setMessage(command.command === "DELETE_FLOW" && outcome.code === "STALE_DOCUMENT_REVISION"
        ? "The flow changed. Review what will be removed, then delete again." : explain(outcome));
      return;
    }
    setMessage("");
    await open(command.command === "DELETE_FLOW" ? null : outcome.result.createdIds[0]!);
  };
  const create = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editable || saving) return;
    const error = fieldErrors("FLOW", { title: values.title }).title ?? "";
    setTitleError(error);
    if (error) { window.document.getElementById("new-flow-title")?.focus(); return; }
    await send({
      commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: draft.documentRevision,
      payload: { title: values.title, purpose: "", classification: values.classification as Classification, inclusion: values.inclusion as Inclusion },
    });
  };
  const duplicate = async () => {
    if (!current || !editable || duplicateTooLong) return;
    await send({ commandSchemaVersion: 1, command: "DUPLICATE_FLOW", expectedDocumentRevision: draft.documentRevision, payload: { flowId: current.id } });
  };
  const remove = async () => {
    if (!current || !editable) return;
    const plan = dependencyPlan(document, current.id);
    await send({ commandSchemaVersion: 1, command: "DELETE_FLOW", expectedDocumentRevision: draft.documentRevision, payload: { flowId: current.id, removeNodeIds: plan.nodeIds, removeEdgeIds: plan.edgeIds } });
  };

  if (editable && mode === "create") {
    return <Dialog title="New flow" onClose={onClose} footer={<>
      <button type="button" className="button quiet" onClick={() => (flows.length ? setMode("list") : onClose())}>Cancel</button>
      <button type="submit" form="new-flow-form" className="button primary" disabled={full || saving}>{saving ? "Saving…" : "Create flow"}</button>
    </>}>
      <form id="new-flow-form" onSubmit={create} onKeyDown={formKeys} noValidate>
        <div className="field">
          <label htmlFor="new-flow-title">Title</label>
          <input id="new-flow-title" readOnly={saving} value={values.title} onChange={(event) => setValues({ ...values, title: event.target.value })} aria-invalid={Boolean(titleError)} aria-describedby={titleError ? "new-flow-title-error" : undefined} />
          {titleError && <small id="new-flow-title-error" className="field-error">{titleError}</small>}
        </div>
        <div className="field">
          <label htmlFor="new-flow-type">Type</label>
          <select id="new-flow-type" disabled={saving} value={values.classification} onChange={(event) => setValues({ ...values, classification: event.target.value })}>
            {CLASSIFICATIONS.map((value) => <option key={value} value={value}>{CLASSIFICATION_LABELS[value]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="new-flow-scope">Scope</label>
          <select id="new-flow-scope" disabled={saving} value={values.inclusion} onChange={(event) => setValues({ ...values, inclusion: event.target.value })}>
            {INCLUSIONS.map((value) => <option key={value} value={value}>{INCLUSION_LABELS[value]}</option>)}
          </select>
        </div>
        {full && <p className="muted">A project can have up to {LIMITS.flows} flows.</p>}
        {message && <p className="error-message" role="alert">{message}</p>}
      </form>
    </Dialog>;
  }

  if (editable && mode === "delete" && current) {
    const plan = dependencyPlan(document, current.id);
    return <Dialog title={`Delete ${current.title}?`} onClose={() => setMode("list")} footer={<>
      <button type="button" className="button quiet" onClick={() => setMode("list")}>Cancel</button>
      <button type="button" className="button danger" onClick={() => void remove()}>Delete flow</button>
    </>}>
      <p>This removes the flow, its {plan.nodeIds.length} {plan.nodeIds.length === 1 ? "step" : "steps"} and {plan.edgeIds.length} {plan.edgeIds.length === 1 ? "connection" : "connections"} from the draft.</p>
      {message && <p className="error-message" role="alert">{message}</p>}
    </Dialog>;
  }

  return <Dialog title="Flows" onClose={onClose} footer={<button type="button" className="button quiet" onClick={onClose}>Close</button>}>
    <div className="form-row">
      <label htmlFor="flow-filter">Show</label>
      <select id="flow-filter" value={filter} onChange={(event) => setFilter(event.target.value as "ALL" | Inclusion)}>
        <option value="ALL">All flows</option>
        {INCLUSIONS.map((value) => <option key={value} value={value}>{INCLUSION_LABELS[value]}</option>)}
      </select>
    </div>
    <p className="muted">{flows.length} of {LIMITS.flows} flows{filter === "ALL" ? "" : ` · showing ${shown.length}`}</p>
    <ul className="item-list">{shown.map((flow) => <li key={flow.id}>
      <button type="button" className="item-row" aria-current={flow.id === current?.id ? "true" : undefined} onClick={() => void open(flow.id)} disabled={saving}>
        <span><strong>{flow.title}</strong><small>{counts(flow.id)} {counts(flow.id) === 1 ? "step" : "steps"} · {INCLUSION_LABELS[flow.inclusion]}</small></span>
        {flow.id === current?.id && <Icon name="check" size={14} />}
      </button>
    </li>)}</ul>
    {editable && <>
      <div className="view-actions">
        <button type="button" className="button small" onClick={() => setMode("create")} disabled={full}>New flow</button>
        {current && <button type="button" className="button small" onClick={() => void duplicate()} disabled={full || duplicateTooLong}>Duplicate {current.title}</button>}
        {current && <button type="button" className="button danger small" onClick={() => setMode("delete")}>Delete {current.title}…</button>}
      </div>
      <p className="muted">A duplicate gets new identities, keeps its steps, connections and positions, and starts unconfirmed.{full ? ` A project can have up to ${LIMITS.flows} flows.` : duplicateTooLong ? ` This flow title cannot be duplicated because "Copy of " would exceed the ${LIMITS.title}-character limit.` : ""}</p>
    </>}
    {message && <p className="error-message" role="alert">{message}</p>}
  </Dialog>;
}
