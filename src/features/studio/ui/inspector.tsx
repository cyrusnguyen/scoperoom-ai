"use client";

import { useState, type SubmitEvent } from "react";
import { Icon } from "@/features/shell/ui/icon";
import { COORDINATE_LIMIT } from "@/features/drafts/contracts/draft-layout";
import type { EdgeRecord, FlowRecord, NodeRecord } from "@/features/drafts/contracts/scope-document";
import { graphWarnings, type GraphWarning } from "@/features/drafts/domain/warnings";
import {
  bufferKey, changedElsewhere, changes, dirtyFields, discard, edit, rebase, refuse, type EntityBuffer, type EntityKind, type Fields, type Saved,
} from "./buffers";
import { endpointGuard, FIELDS, fieldErrors, KIND_LABELS, reconnectCommand, savedOf, updateCommand } from "./fields";
import { neighbours, recordOf, stepName } from "./graph-view";
import { DeleteStepsDialog } from "./step-dialogs";
import { explain, formKeys, useCommandSubmit, useStudio } from "./studio-context";
import { canApplyAgain, studioDirtyCount } from "./studio-ui";
import { confirmationCurrent, linkState } from "@/features/scope/domain/scope";

import type { SpecsUi } from "@/features/shell/ui/project-ui";
import { useSpecsWrite } from "@/features/scope/ui/use-specs-write";

const NOUNS: Record<EntityKind, string> = { FLOW: "flow", NODE: "step", EDGE: "connection" };

function focusAfterRemoval() {
  requestAnimationFrame(() => (document.querySelector<HTMLElement>('#right-panel[aria-modal="true"] [role="tab"]')
    ?? document.getElementById("studio-flow-title"))?.focus());
}

/** Everything the person typed, as text they can copy out. */
function typedText(kind: EntityKind, values: Fields) {
  return FIELDS[kind].filter((spec) => values[spec.name] !== undefined).map((spec) => `${spec.label}: ${values[spec.name]}`).join("\n");
}

/**
 * The right panel's Details tab while something in the Studio is selected (UI02 "Canvas, library and inspector").
 * "← Project" returns to the project details. Typed values live in the shell's per-project buffers, so they survive
 * closing the panel, switching selection and every refetch.
 */
export default function Inspector({ onBack, onOpenRequirement, specs, updateSpecs }: { onBack: () => void; onOpenRequirement?: (id: string) => void; specs: SpecsUi; updateSpecs: (change: (ui: SpecsUi) => Partial<SpecsUi>) => void }) {
  const { draft, ui } = useStudio();
  const selection = ui.selection;
  if (!selection) return null;
  const back = <button type="button" className="button quiet small inspector-back" aria-label="Back to project" onClick={onBack}><Icon name="back" size={16} /><span>Project</span></button>;
  if (selection.kind === "NODES" && selection.ids.length > 1) return <>{back}<ManySteps ids={selection.ids} /></>;
  const kind: EntityKind = selection.kind === "NODES" ? "NODE" : selection.kind;
  const id = selection.kind === "NODES" ? selection.ids[0]! : selection.id;
  const record = recordOf(draft.document, kind, id);
  if (!record) return <>{back}<Removed kind={kind} id={id} /></>;
  return <>
    {back}
    <EntityEditor key={bufferKey(kind, id)} kind={kind} saved={savedOf(kind, record)} />
    {kind === "NODE" && <StepContext key={id} node={record as NodeRecord} onOpenRequirement={onOpenRequirement} />}
    {kind === "EDGE" && <Endpoints key={id} edge={record as EdgeRecord} />}
    {kind === "FLOW" && <><FlowConfirmation flow={record as FlowRecord} specs={specs} updateSpecs={updateSpecs} /><DraftChecks flowId={id} /></>}
  </>;
}

function FlowConfirmation({ flow, specs, updateSpecs }: { flow: FlowRecord; specs: SpecsUi; updateSpecs: (change: (ui: SpecsUi) => Partial<SpecsUi>) => void }) {
  const { draft, editable } = useStudio();
  const write = useSpecsWrite(specs, updateSpecs);
  const current = confirmationCurrent(flow);
  const confirm = () => {
    // This is the record the person inspected, captured before save-first or an authority refresh.
    const inspectedVersion = flow.version;
    void write.sendDraft(`drafts/${draft.id}/commands`, (saved) => {
      if (saved.document.flows[flow.id]?.version !== inspectedVersion) return null;
      return { commandSchemaVersion: 1, command: "CONFIRM_FLOW", expectedEntityVersion: inspectedVersion, payload: { flowId: flow.id } };
    }, "Confirm flow");
  };
  const pendingFlow = specs.pending?.body?.command === "CONFIRM_FLOW" && (specs.pending.body.payload as Record<string, unknown> | undefined)?.flowId === flow.id;
  return <section className="detail-section" aria-labelledby="inspector-confirmation">
    <h3 id="inspector-confirmation">Confirmation</h3>
    <p className="muted">{current ? "Confirmed: current wording." : flow.confirmation ? "Needs confirmation: flow meaning changed." : "Unconfirmed."}</p>
    {editable && <button type="button" className="button small" disabled={current || write.busy || Boolean(specs.pending)} onClick={confirm}>Confirm flow</button>}
    {specs.message && (!specs.pending || pendingFlow) && <p role={specs.pending || !specs.message.endsWith(": saved.") ? "alert" : "status"}>{specs.message}
      {pendingFlow && !write.busy && <button type="button" className="button small" onClick={() => void write.retry()}>{specs.pending?.acknowledged ? "Refresh" : "Retry"}</button>}
    </p>}
  </section>;
}

function EntityEditor({ kind, saved }: { kind: EntityKind; saved: Saved }) {
  const { editable, ui, update, run, savedDraft, frozen, saveChanges } = useStudio();
  // Conflict actions wait for a readable saved draft that covers the acknowledged floor.
  const refreshFailed = !canApplyAgain(ui, savedDraft);
  const key = bufferKey(kind, saved.id);
  const buffer = ui.buffers[key];
  // "Changed by someone else": the adopted saved record moved on from what this text was typed against. The text is untouched.
  const adopted = recordOf(savedDraft.document, kind, saved.id);
  const frozenBase = frozen && ui.outbox.base ? recordOf(ui.outbox.base.document, kind, saved.id) : undefined;
  const elsewhere = Boolean(buffer && changedElsewhere(buffer, saved.version, frozen ? adopted?.version : undefined, frozenBase?.version));
  const theirs = adopted ? savedOf(kind, adopted).fields : saved.fields;
  const values = buffer ? { ...saved.fields, ...changes(buffer) } : saved.fields;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const heading = kind === "NODE" ? KIND_LABELS[saved.fields.kind as keyof typeof KIND_LABELS] : kind === "FLOW" ? "Flow" : "Connection";

  if (!editable) {
    return <section className="detail-section" aria-labelledby="inspector-heading">
      <h3 id="inspector-heading">{heading}</h3>
      <dl className="inspector-facts">{FIELDS[kind].map((spec) => <div key={spec.name}>
        <dt>{spec.label}</dt>
        <dd>{(spec.options?.find(([value]) => value === saved.fields[spec.name])?.[1] ?? saved.fields[spec.name]) || "—"}</dd>
      </div>)}</dl>
      {buffer && <RetainedText text={typedText(kind, changes(buffer))}
        onDiscard={() => update((current) => ({ buffers: discard(current.buffers, key) }))} />}
    </section>;
  }

  // Save applies this record's edits (queued with the rest of the unsaved changes) and then saves them all at once.
  const submit = async (target: EntityBuffer, chosen = false) => {
    if (!editable || target.conflict || (elsewhere && !chosen)) return;
    const fields = changes(target);
    const found = fieldErrors(kind, fields);
    setErrors(found);
    if (Object.keys(found).length) { document.getElementById(`inspect-${Object.keys(found)[0]}`)?.focus(); return; }
    setMessage("");
    const outcome = await run(updateCommand(kind, saved.id, target.baseVersion, fields));
    if (!outcome.ok) {
      update((current) => ({ buffers: refuse(current.buffers, key, outcome.code === "STALE_ENTITY_VERSION") }));
      setMessage(outcome.code === "STALE_ENTITY_VERSION" ? "" : explain(outcome));
      return;
    }
    // The text now lives in the queued command; the buffer is clean. "Saved." only after the acknowledgement.
    update((current) => ({ buffers: discard(current.buffers, key) }));
    if (await saveChanges()) setMessage("Saved.");
  };
  const onSave = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (buffer && !buffer.conflict && editable) void submit(buffer);
  };
  const saveMine = () => {
    if (!editable || refreshFailed) return;
    const rebased = rebase(ui.buffers, saved)[key];
    update((current) => ({ buffers: rebase(current.buffers, saved) }));
    if (rebased) void submit(rebased, true);
    else setMessage("Your text already matches the saved value.");
  };
  const copyMine = async () => {
    try { await navigator.clipboard.writeText(typedText(kind, values)); setMessage("Copied your edit."); } catch { setMessage("Copy failed. Select the text in the fields instead."); }
  };
  const keepSaved = () => { update((current) => ({ buffers: discard(current.buffers, key) })); setErrors({}); setMessage(""); };

  const dirty = buffer ? dirtyFields(buffer) : [];
  return <section className="detail-section" aria-labelledby="inspector-heading">
    <h3 id="inspector-heading">{heading}</h3>
    {buffer && (buffer.conflict || elsewhere) && <div className="inline-note" role={elsewhere ? "status" : "alert"}>
      <p>{elsewhere ? <><strong>Changed by someone else.</strong> Your text is kept; nothing was overwritten.</> : `Someone else saved this ${NOUNS[kind]} first. Your text is kept; nothing was overwritten.`}</p>
      {!refreshFailed && <dl className="conflict-list">{dirty.map((field) => {
        const label = FIELDS[kind].find((spec) => spec.name === field)?.label ?? field;
        return <div key={field}>
          <dt>{label}</dt>
          <dd><span className="muted">Saved value</span>{(elsewhere ? theirs : saved.fields)[field] || "(empty)"}</dd>
          <dd><span className="muted">Your edit</span>{buffer.values[field] || "(empty)"}</dd>
          <dd><span className="muted">Before your edit</span>{buffer.original[field] || "(empty)"}</dd>
        </div>;
      })}</dl>}
      <div className="view-actions">
        <button type="button" className="button primary small" onClick={saveMine} disabled={refreshFailed}>Save my edit</button>
        <button type="button" className="button small" onClick={keepSaved} disabled={refreshFailed}>Keep saved value</button>
        <button type="button" className="button quiet small" onClick={() => void copyMine()}>Copy my edit</button>
      </div>
    </div>}
    <form onSubmit={onSave} onKeyDown={formKeys} noValidate>
      {FIELDS[kind].map((spec) => {
        const id = `inspect-${spec.name}`;
        const error = errors[spec.name];
        const described = [error ? `${id}-error` : "", spec.hint ? `${id}-hint` : ""].filter(Boolean).join(" ") || undefined;
        const change = (value: string) => update((current) => ({ buffers: edit(current.buffers, saved, spec.name, value) }));
        return <div className="field" key={spec.name}>
          <label htmlFor={id}>{spec.label}</label>
          {spec.options
            ? <select id={id} value={values[spec.name]} onChange={(event) => change(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={described}>{spec.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            : spec.multiline
              ? <textarea id={id} rows={spec.name === "description" || spec.name === "purpose" ? 4 : 3} value={values[spec.name]} onChange={(event) => change(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={described} />
              : <input id={id} value={values[spec.name]} onChange={(event) => change(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={described} />}
          {spec.hint && <small id={`${id}-hint`} className="muted">{spec.hint}</small>}
          {error && <small id={`${id}-error`} className="field-error">{error}</small>}
        </div>;
      })}
      <div className="view-actions">
        <button type="submit" className="button primary small" disabled={!buffer || buffer.conflict || elsewhere}>Save</button>
        {buffer && !buffer.conflict && !elsewhere && <button type="button" className="button quiet small" onClick={keepSaved}>Discard local changes</button>}
      </div>
      <p className="muted" role="status" aria-live="polite">{message === "Saved." && studioDirtyCount(ui) ? "Unsaved changes" : message}</p>
    </form>
  </section>;
}

function StepContext({ node, onOpenRequirement }: { node: NodeRecord; onOpenRequirement?: (id: string) => void }) {
  const { draft, editable, update, ui } = useStudio();
  const [deleting, setDeleting] = useState(false);
  const { incoming, outgoing } = neighbours(draft.document, node.id);
  const link = (nodeId: string, label: string) => <button type="button" className="text-link" onClick={() => update(() => ({ selection: { kind: "NODES", ids: [nodeId] } }))}>{label}</button>;
  return <section className="detail-section" aria-labelledby="inspector-links">
    <h3 id="inspector-links">Connections</h3>
    {!incoming.length && !outgoing.length && <p className="muted">Not connected yet.</p>}
    <ul className="plain-list">
      {incoming.map((edge) => <li key={edge.id}>From {link(edge.fromId, stepName(draft.document, edge.fromId))}{edge.condition && <span className="muted"> · {edge.condition}</span>}</li>)}
      {outgoing.map((edge) => <li key={edge.id}>To {link(edge.toId, stepName(draft.document, edge.toId))}{edge.condition && <span className="muted"> · {edge.condition}</span>}</li>)}
    </ul>
    <section className="detail-section" aria-labelledby="inspector-requirements">
      <h4 id="inspector-requirements">Requirements</h4>
      {Object.values(draft.document.traceLinks).filter((entry) => entry.nodeId === node.id).length
        ? <ul className="plain-list">{Object.values(draft.document.traceLinks).filter((entry) => entry.nodeId === node.id).map((entry) => {
          const requirement = draft.document.requirements[entry.requirementId];
          if (!requirement) return null;
          const state = linkState(draft.document, entry);
          const label = state === "CURRENT" ? "Reviewed" : state === "PROPOSED" ? "Proposed" : entry.reviewedRequirementBehaviourVersion !== requirement.behaviourVersion ? "Needs review: requirement changed" : "Needs review: step changed";
          return <li key={entry.id}><button type="button" className="text-link" onClick={() => onOpenRequirement?.(requirement.id)}>{requirement.displayId} {requirement.title}</button> <span className="specs-badge">{label}</span></li>;
        })}</ul>
        : <p className="muted">No linked requirements.</p>}
    </section>
    {editable && draft.layout.positions[node.id] && <PositionForm key={node.id} node={node} />}
    {!editable && ui.positionBuffers[bufferKey("NODE", node.id)] && <RetainedText label="Your unsaved position" text={positionText(ui.positionBuffers[bufferKey("NODE", node.id)]!.values)}
      onDiscard={() => update((current) => ({ positionBuffers: discard(current.positionBuffers, bufferKey("NODE", node.id)) }))} />}
    {editable && <button type="button" className="button danger small" onClick={() => setDeleting(true)}>Delete step…</button>}
    {editable && deleting && <DeleteStepsDialog flowId={node.flowId} nodeIds={[node.id]} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); update(() => ({ selection: null })); focusAfterRemoval(); }} />}
  </section>;
}

/** The keyboard way to move a step: a local move like a drop, saved at once with every other unsaved change. */
function PositionForm({ node }: { node: NodeRecord }) {
  const { draft, savedDraft, frozen, ui, update, moveSteps } = useStudio();
  const position = draft.layout.positions[node.id]!;
  const saved: Saved = { kind: "NODE", id: node.id, version: position.version, fields: { x: String(position.x), y: String(position.y) } };
  const key = bufferKey("NODE", node.id);
  const buffer = ui.positionBuffers[key];
  const values = buffer?.values ?? saved.fields;
  const adopted = savedDraft.layout.positions[node.id];
  const frozenBase = frozen ? ui.outbox.base?.layout.positions[node.id] : undefined;
  const changed = Boolean(buffer && changedElsewhere(buffer, position.version, frozen ? adopted?.version : undefined, frozenBase?.version));
  const theirs = frozen && adopted ? { x: String(adopted.x), y: String(adopted.y) } : saved.fields;
  const resolvable = !frozen && canApplyAgain(ui, savedDraft);
  const [error, setError] = useState("");
  const apply = (reviewed = false) => {
    if (changed && (!reviewed || !resolvable)) return;
    const next = [values.x!, values.y!].map((value) => (value.trim() ? Number(value) : Number.NaN));
    if (next.some((value) => !Number.isFinite(value) || Math.abs(value) > COORDINATE_LIMIT)) { setError(`Enter numbers from -${COORDINATE_LIMIT} to ${COORDINATE_LIMIT}.`); return; }
    setError("");
    // Queue the reviewed pair synchronously before any status/write await. Batch construction reads its
    // position version from the outbox base; advance() preserves that guard once the move is queued.
    update((current) => ({ positionBuffers: discard(current.positionBuffers, key) }));
    void moveSteps(node.flowId, [{ nodeId: node.id, x: next[0]!, y: next[1]! }], { save: true });
  };
  const submit = (event: SubmitEvent<HTMLFormElement>) => { event.preventDefault(); apply(); };
  const change = (field: string, value: string) => update((current) => ({ positionBuffers: edit(current.positionBuffers, saved, field, value) }));
  const keepSaved = () => { update((current) => ({ positionBuffers: discard(current.positionBuffers, key) })); setError(""); };
  return <form className="position-form" onSubmit={submit} onKeyDown={formKeys} noValidate aria-labelledby="inspector-position">
    <h4 id="inspector-position" className="sr-only">Position</h4>
    {changed && buffer && <div className="inline-note" role="status">
      <p><strong>Position changed.</strong> Your coordinates are kept. Review them before moving.</p>
      <dl className="conflict-list">
        <div><dt>Saved position</dt><dd>({theirs.x}, {theirs.y})</dd></div>
        <div><dt>Your position</dt><dd>({values.x}, {values.y})</dd></div>
        <div><dt>Before your edit</dt><dd>({buffer.original.x}, {buffer.original.y})</dd></div>
      </dl>
      <div className="view-actions">
        <button type="button" className="button small" onClick={() => apply(true)} disabled={!resolvable}>Move my edit</button>
        <button type="button" className="button quiet small" onClick={keepSaved}>Keep saved position</button>
      </div>
    </div>}
    <label htmlFor="position-x">X</label>
    <input id="position-x" inputMode="decimal" value={values.x} onChange={(event) => change("x", event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "position-error" : undefined} />
    <label htmlFor="position-y">Y</label>
    <input id="position-y" inputMode="decimal" value={values.y} onChange={(event) => change("y", event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "position-error" : undefined} />
    <button type="submit" className="button small" disabled={changed}>Move</button>
    {buffer && !changed && <button type="button" className="button quiet small" onClick={keepSaved}>Discard coordinate changes</button>}
    {error && <small id="position-error" className="field-error" role="alert">{error}</small>}
  </form>;
}

function ManySteps({ ids }: { ids: string[] }) {
  const { draft, editable, update } = useStudio();
  const [deleting, setDeleting] = useState(false);
  const present = ids.filter((id) => draft.document.nodes[id]);
  const flowId = present.length ? draft.document.nodes[present[0]!]!.flowId : "";
  return <section className="detail-section" aria-labelledby="inspector-many">
    <h3 id="inspector-many">{present.length} steps selected</h3>
    <ul className="plain-list">{present.map((id) => <li key={id}>{stepName(draft.document, id)}</li>)}</ul>
    <div className="view-actions">
      <button type="button" className="button quiet small" onClick={() => update(() => ({ selection: null }))}>Clear selection</button>
      {editable && present.length > 0 && <button type="button" className="button danger small" onClick={() => setDeleting(true)}>Delete {present.length} steps…</button>}
    </div>
    {editable && deleting && <DeleteStepsDialog flowId={flowId} nodeIds={present} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); update(() => ({ selection: null })); focusAfterRemoval(); }} />}
  </section>;
}

/** Reconnect guards the document revision (topology), so it is a separate action from editing the condition text. */
function Endpoints({ edge }: { edge: EdgeRecord }) {
  const { draft, editable, ui, update, savedDraft } = useStudio();
  const refreshFailed = !canApplyAgain(ui, savedDraft); // as the field editor: conflict actions wait for a readable draft that covers the floor
  const submitCommand = useCommandSubmit();
  const key = bufferKey("EDGE", edge.id);
  const saved: Saved = { kind: "EDGE", id: edge.id, version: draft.documentRevision, fields: { fromId: edge.fromId, toId: edge.toId } };
  const buffer = ui.endpointBuffers[key];
  const values = buffer?.values ?? saved.fields;
  const [message, setMessage] = useState("");
  const steps = Object.values(draft.document.nodes).filter((node) => node.flowId === edge.flowId);
  const submit = async (target: EntityBuffer) => {
    if (!editable || target.conflict) return;
    const guard = endpointGuard(target, edge, draft.documentRevision);
    if (guard === null) { update((current) => ({ endpointBuffers: refuse(current.endpointBuffers, key, true) })); setMessage(""); return; }
    const outcome = await submitCommand(reconnectCommand(edge.id, guard, target.values));
    if (outcome.ok) update((current) => ({ endpointBuffers: discard(current.endpointBuffers, key) }));
    else update((current) => ({ endpointBuffers: refuse(current.endpointBuffers, key, outcome.code === "STALE_DOCUMENT_REVISION") }));
    setMessage(outcome.ok ? "Connection moved." : outcome.code === "STALE_DOCUMENT_REVISION" ? "" : explain(outcome));
  };
  const reconnect = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (buffer) void submit(buffer);
  };
  const keepSaved = () => { update((current) => ({ endpointBuffers: discard(current.endpointBuffers, key) })); setMessage(""); };
  const applyMine = () => {
    if (!buffer?.conflict || !editable || refreshFailed || saved.version <= buffer.baseVersion) return;
    // This deliberate action is the only rebase. Keep the whole chosen pair, including its unchanged endpoint.
    if (buffer.values.fromId === saved.fields.fromId && buffer.values.toId === saved.fields.toId) { keepSaved(); return; }
    const target = { ...buffer, baseVersion: saved.version, original: saved.fields, conflict: false };
    update((current) => ({ endpointBuffers: { ...current.endpointBuffers, [key]: target } }));
    void submit(target);
  };
  const copyMine = async () => {
    try { await navigator.clipboard.writeText(endpointText(values)); setMessage("Copied your connection."); }
    catch { setMessage("Copy failed. Select the connection text instead."); }
  };
  const remove = async () => {
    if (!editable) return;
    const outcome = await submitCommand({ commandSchemaVersion: 1, command: "DELETE_EDGE", expectedDocumentRevision: draft.documentRevision, payload: { edgeId: edge.id } });
    if (outcome.ok) { update(() => ({ selection: null })); focusAfterRemoval(); }
    else setMessage(explain(outcome));
  };
  if (!editable) return <section className="detail-section">
    <p>{stepName(draft.document, edge.fromId)} {"\u2192"} {stepName(draft.document, edge.toId)}</p>
    {buffer && <RetainedText label="Your unsaved endpoint choices" text={endpointText(changes(buffer))}
      onDiscard={() => update((current) => ({ endpointBuffers: discard(current.endpointBuffers, key) }))} />}
  </section>;
  const picker = (field: string, label: string) => <div className="field">
    <label htmlFor={`reconnect-${field}`}>{label}</label>
    <select id={`reconnect-${field}`} value={values[field]} onChange={(event) => { const value = event.target.value; update((current) => ({ endpointBuffers: edit(current.endpointBuffers, saved, field, value) })); }}>
      {steps.map((node) => <option key={node.id} value={node.id}>{stepName(draft.document, node.id)}</option>)}
    </select>
  </div>;
  return <section className="detail-section" aria-labelledby="inspector-ends">
    <h3 id="inspector-ends">Endpoints</h3>
    {buffer?.conflict && <div className="inline-note" role="alert">
      <p>The flow changed while you were working. Your connection is kept; nothing was overwritten.</p>
      {!refreshFailed && <dl className="conflict-list">{[
        { label: "Saved connection", fields: saved.fields }, { label: "Your connection", fields: buffer.values }, { label: "Before your edit", fields: buffer.original },
      ].map(({ label, fields }) => <div key={label}><dt>{label}</dt><dd>{stepName(draft.document, fields.fromId!)} {"\u2192"} {stepName(draft.document, fields.toId!)}</dd></div>)}</dl>}
      <div className="view-actions">
        <button type="button" className="button primary small" onClick={applyMine} disabled={refreshFailed || saved.version <= buffer.baseVersion}>Apply my connection</button>
        <button type="button" className="button small" onClick={keepSaved} disabled={refreshFailed}>Keep saved connection</button>
        <button type="button" className="button quiet small" onClick={() => void copyMine()}>Copy my connection</button>
      </div>
    </div>}
    <form onSubmit={reconnect} onKeyDown={formKeys}>
      {picker("fromId", "From")}
      {picker("toId", "To")}
      <div className="view-actions">
        <button type="submit" className="button small" disabled={!buffer || buffer.conflict}>Reconnect</button>
        {buffer && !buffer.conflict && <button type="button" className="button quiet small" onClick={keepSaved}>Discard endpoint changes</button>}
        <button type="button" className="button danger small" onClick={() => void remove()}>Delete connection</button>
      </div>
    </form>
    <p className="muted" role="status" aria-live="polite">{buffer && message === "Connection moved." ? "Connection moved; newer endpoint choices aren’t applied yet." : message || (buffer ? "Unsaved endpoint choices" : "")}</p>
  </section>;
}

function DraftChecks({ flowId }: { flowId: string }) {
  const { draft, update } = useStudio();
  const warnings = graphWarnings(draft.document, flowId);
  const describe = (warning: GraphWarning) => {
    const select = (kind: "NODES" | "EDGE", id: string) => update(() => ({ selection: kind === "NODES" ? { kind, ids: [id] } : { kind, id } }));
    if (warning.code === "NO_START") return "No start step yet.";
    if (warning.code === "NO_OUTCOME") return "No outcome step yet.";
    if (warning.code === "UNCONNECTED_STEP") return <><button type="button" className="text-link" onClick={() => select("NODES", warning.targetId)}>{stepName(draft.document, warning.targetId)}</button> isn&rsquo;t connected to a start.</>;
    const edge = draft.document.edges[warning.targetId]!;
    return <>A <button type="button" className="text-link" onClick={() => select("EDGE", edge.id)}>branch from {stepName(draft.document, edge.fromId)}</button> has no condition.</>;
  };
  return <section className="detail-section" aria-labelledby="inspector-checks">
    <h3 id="inspector-checks">Draft checks</h3>
    {warnings.length ? <ul className="plain-list">{warnings.map((warning) => <li key={`${warning.code}:${warning.targetId}`}>{describe(warning)}</li>)}</ul> : <p className="muted">No draft checks.</p>}
    <p className="muted">Draft checks never block saving; an exploratory flow can stay incomplete.</p>
  </section>;
}

function endpointText(values: Fields) {
  return [["fromId", "From step"], ["toId", "To step"]].filter(([field]) => values[field] !== undefined)
    .map(([field, label]) => `${label}: ${values[field]}`).join("\n");
}

function positionText(values: Fields) { return `X: ${values.x}\nY: ${values.y}`; }

function RetainedText({ text, onDiscard, label = "Your unsaved text" }: { text: string; onDiscard: () => void; label?: string }) {
  const [message, setMessage] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setMessage("Copied your text."); } catch { setMessage("Copy failed. Select the text instead."); }
  };
  return <div className="inline-note">
    <p>Your unsaved input is kept for copying. It cannot be saved here.</p>
    <textarea aria-label={label} readOnly rows={4} value={text} />
    <div className="view-actions">
      <button type="button" className="button small" onClick={() => void copy()}>Copy</button>
      <button type="button" className="button quiet small" onClick={onDiscard}>Discard</button>
    </div>
    <p className="muted" role="status" aria-live="polite">{message}</p>
  </div>;
}

/** Removed items retain isolated local input for copying, never a recreation action. */
function Removed({ kind, id }: { kind: EntityKind; id: string }) {
  const { ui, update } = useStudio();
  const key = bufferKey(kind, id);
  const buffer = ui.buffers[key];
  const endpoints = ui.endpointBuffers[key];
  const position = ui.positionBuffers[key];
  const text = [buffer ? typedText(kind, changes(buffer)) : "", endpoints ? endpointText(changes(endpoints)) : "", position ? positionText(position.values) : ""].filter(Boolean).join("\n");
  return <section className="detail-section" aria-labelledby="inspector-removed">
    <h3 id="inspector-removed">This {NOUNS[kind]} was removed</h3>
    {buffer || endpoints || position ? <RetainedText text={text}
      onDiscard={() => update((current) => ({ buffers: discard(current.buffers, key), endpointBuffers: discard(current.endpointBuffers, key), positionBuffers: discard(current.positionBuffers, key), selection: null }))} />
      : <p className="muted">Choose another item, or go back to the project.</p>}
  </section>;
}
