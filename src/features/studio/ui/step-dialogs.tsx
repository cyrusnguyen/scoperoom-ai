"use client";

import { useState, type SubmitEvent } from "react";
import { MAX_DELETE_NODES } from "@/features/drafts/contracts/commands";
import { NODE_KINDS, type NodeKind } from "@/features/drafts/contracts/scope-document";
import { dependencyPlan } from "@/features/drafts/domain/graph";
import Dialog, { CancelFocus } from "@/features/shell/ui/dialog";
import { fieldErrors, KIND_LABELS } from "./fields";
import { stepName, stepsInOrder } from "./graph-view";
import { explain, formKeys, useCommandSubmit, useStudio } from "./studio-context";

function focusFirst(prefix: string, errors: Record<string, string>) {
  const first = Object.keys(errors)[0];
  if (first) document.getElementById(`${prefix}-${first}`)?.focus();
}

type AddValues = { kind: string; label: string; actorLabel: string; description: string };
type ConnectValues = { fromId: string; toId: string; condition: string };

/** Add one step at the shown document revision: it appears at once and is saved with the next save. */
export function AddStepDialog({ flowId, onClose, onAdded }: { flowId: string; onClose: () => void; onAdded: (nodeId: string) => void }) {
  const { draft, editable } = useStudio();
  const submitCommand = useCommandSubmit();
  const first = !Object.values(draft.document.nodes).some((node) => node.flowId === flowId);
  const [values, setValues] = useState<AddValues>({ kind: first ? "START" : "ACTION", label: "", actorLabel: "", description: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const change = (field: keyof AddValues, value: string) => setValues((current) => ({ ...current, [field]: value }));
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editable) return;
    const found = fieldErrors("NODE", values);
    setErrors(found);
    if (Object.keys(found).length) { focusFirst("add-step", found); return; }
    const { kind, label, actorLabel, description } = values;
    const outcome = await submitCommand({ commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: draft.documentRevision,
      payload: { flowId, kind: kind as NodeKind, label, actorLabel, description } });
    if (outcome.ok) onAdded(outcome.result.createdIds[0]!);
    else setMessage(explain(outcome));
  };
  return <Dialog title="Add step" onClose={onClose} footer={<>
    <button type="button" className="button quiet" onClick={onClose}>Cancel</button>
    <button type="submit" form="add-step-form" className="button primary" disabled={!editable}>Add step</button>
  </>}>
    <form id="add-step-form" onSubmit={submit} onKeyDown={formKeys} noValidate>
      <div className="field">
        <label htmlFor="add-step-kind">Shape</label>
        <select id="add-step-kind" value={values.kind} onChange={(event) => change("kind", event.target.value)}>{NODE_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}</select>
      </div>
      <div className="field">
        <label htmlFor="add-step-label">Name</label>
        <input id="add-step-label" value={values.label} onChange={(event) => change("label", event.target.value)} aria-invalid={Boolean(errors.label)} aria-describedby={errors.label ? "add-step-label-error" : undefined} />
        {errors.label && <small id="add-step-label-error" className="field-error">{errors.label}</small>}
      </div>
      <div className="field">
        <label htmlFor="add-step-actorLabel">Actor</label>
        <input id="add-step-actorLabel" value={values.actorLabel} onChange={(event) => change("actorLabel", event.target.value)} aria-invalid={Boolean(errors.actorLabel)} aria-describedby={errors.actorLabel ? "add-step-actorLabel-error" : undefined} />
        {errors.actorLabel && <small id="add-step-actorLabel-error" className="field-error">{errors.actorLabel}</small>}
      </div>
      <div className="field">
        <label htmlFor="add-step-description">Description</label>
        <textarea id="add-step-description" rows={3} value={values.description} onChange={(event) => change("description", event.target.value)} aria-invalid={Boolean(errors.description)} aria-describedby={errors.description ? "add-step-description-error" : undefined} />
        {errors.description && <small id="add-step-description-error" className="field-error">{errors.description}</small>}
      </div>
      {message && <p className="error-message" role="alert">{message}</p>}
    </form>
  </Dialog>;
}

/** Add one connection using keyboard-accessible source and target pickers. */
export function ConnectDialog({ flowId, from, onClose }: { flowId: string; from?: string; onClose: () => void }) {
  const { draft, editable } = useStudio();
  const submitCommand = useCommandSubmit();
  const steps = stepsInOrder(draft.document, draft.layout, flowId);
  const initialFrom = from && draft.document.nodes[from]?.flowId === flowId ? from : steps[0]?.id ?? "";
  const initial: ConnectValues = { fromId: initialFrom, toId: steps.find((node) => node.id !== initialFrom)?.id ?? initialFrom, condition: "" };
  const [values, setValues] = useState(initial);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const change = (field: keyof ConnectValues, value: string) => setValues((current) => ({ ...current, [field]: value }));
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editable) return;
    const found = fieldErrors("EDGE", { condition: values.condition });
    setError(found.condition ?? "");
    if (found.condition) { document.getElementById("connect-condition")?.focus(); return; }
    const { fromId, toId, condition } = values;
    const outcome = await submitCommand({ commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: draft.documentRevision, payload: { flowId, fromId, toId, condition } });
    if (outcome.ok) onClose();
    else setMessage(explain(outcome));
  };
  const picker = (id: string, label: string, value: string, field: "fromId" | "toId") => <div className="field">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={value} onChange={(event) => change(field, event.target.value)}>
      {steps.map((node) => <option key={node.id} value={node.id}>{stepName(draft.document, node.id)}</option>)}
    </select>
  </div>;
  return <Dialog title="Connect steps" onClose={onClose} footer={<>
    <button type="button" className="button quiet" onClick={onClose}>Cancel</button>
    <button type="submit" form="connect-form" className="button primary" disabled={!editable || !values.fromId || !values.toId}>Connect</button>
  </>}>
    <form id="connect-form" onSubmit={submit} onKeyDown={formKeys} noValidate>
      {picker("connect-from", "From", values.fromId, "fromId")}
      {picker("connect-to", "To", values.toId, "toId")}
      <div className="field">
        <label htmlFor="connect-condition">Condition</label>
        <input id="connect-condition" value={values.condition} onChange={(event) => change("condition", event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "connect-condition-error" : "connect-condition-hint"} />
        {error ? <small id="connect-condition-error" className="field-error">{error}</small> : <small id="connect-condition-hint" className="muted">Optional. Name the branch when it leaves a decision.</small>}
      </div>
      {message && <p className="error-message" role="alert">{message}</p>}
    </form>
  </Dialog>;
}

/** Confirm exactly the steps and incident connections in the current draft. */
export function DeleteStepsDialog({ flowId, nodeIds, onClose, onDeleted }: { flowId: string; nodeIds: string[]; onClose: () => void; onDeleted: () => void }) {
  const { draft, editable } = useStudio();
  const submitCommand = useCommandSubmit();
  const [message, setMessage] = useState("");
  const existing = nodeIds.filter((id) => draft.document.nodes[id]?.flowId === flowId);
  const plan = dependencyPlan(draft.document, flowId, existing);
  const tooMany = plan.nodeIds.length > MAX_DELETE_NODES;
  const confirm = async () => {
    if (!editable || !plan.nodeIds.length || tooMany) return;
    const outcome = await submitCommand({ commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: draft.documentRevision,
      payload: { flowId, nodeIds: plan.nodeIds, removeEdgeIds: plan.edgeIds } });
    if (outcome.ok) onDeleted();
    else setMessage(outcome.code === "STALE_DOCUMENT_REVISION" ? "The flow changed. Review what will be removed, then delete again." : explain(outcome));
  };
  const count = plan.nodeIds.length;
  return <Dialog title={count === 1 ? "Delete step" : `Delete ${count} steps`} onClose={onClose} footer={<>
    <CancelFocus label="Cancel" onClick={onClose} />
    {count > 0 && <button type="button" className="button danger" onClick={() => void confirm()} disabled={!editable || tooMany}>Delete</button>}
  </>}>
    {!count ? <p>These steps were already removed.</p> : <>
      <ul className="plain-list">{plan.nodeIds.map((id) => <li key={id}>{stepName(draft.document, id)}</li>)}</ul>
      {plan.edgeIds.length
        ? <><p>{plan.edgeIds.length === 1 ? "This also removes 1 connection:" : `This also removes ${plan.edgeIds.length} connections:`}</p>
          <ul className="plain-list">{plan.edgeIds.map((id) => { const edge = draft.document.edges[id]!; return <li key={id}>{stepName(draft.document, edge.fromId)} {"\u2192"} {stepName(draft.document, edge.toId)}</li>; })}</ul></>
        : <p className="muted">No connections are affected.</p>}
      {tooMany && <p className="error-message" role="alert">Delete up to {MAX_DELETE_NODES} steps at a time.</p>}
    </>}
    {message && <p className="error-message" role="alert">{message}</p>}
  </Dialog>;
}
