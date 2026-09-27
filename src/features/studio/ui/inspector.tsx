"use client";

import { useState, type SubmitEvent } from "react";
import { COORDINATE_LIMIT } from "@/features/drafts/contracts/draft-layout";
import type { EdgeRecord, FlowRecord, NodeRecord } from "@/features/drafts/contracts/scope-document";
import { graphWarnings, type GraphWarning } from "@/features/drafts/domain/warnings";
import {
  bufferKey, changes, dirtyFields, discard, edit, rebase, refuse, send, type EntityBuffer, type EntityKind, type Fields, type Saved,
} from "./buffers";
import { edgeFields, FIELDS, fieldErrors, flowFields, KIND_LABELS, nodeFields, reconnectCommand, updateCommand } from "./fields";
import { neighbours, recordOf, stepName } from "./graph-view";
import { DeleteStepsDialog } from "./step-dialogs";
import { explain, formKeys, useCommandSubmit, useStudio } from "./studio-context";
import { studioDirtyCount } from "./studio-ui";

const NOUNS: Record<EntityKind, string> = { FLOW: "flow", NODE: "step", EDGE: "connection" };

function focusAfterRemoval() {
  requestAnimationFrame(() => (document.querySelector<HTMLElement>('#right-panel[aria-modal="true"] [role="tab"]')
    ?? document.getElementById("studio-flow-title"))?.focus());
}

function savedOf(kind: EntityKind, record: FlowRecord | NodeRecord | EdgeRecord): Saved {
  const fields = kind === "FLOW" ? flowFields(record as FlowRecord) : kind === "NODE" ? nodeFields(record as NodeRecord) : edgeFields(record as EdgeRecord);
  return { kind, id: record.id, version: record.version, fields };
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
export default function Inspector({ onBack }: { onBack: () => void }) {
  const { draft, ui } = useStudio();
  const selection = ui.selection;
  if (!selection) return null;
  const back = <button type="button" className="text-link inspector-back" onClick={onBack}>← Project</button>;
  if (selection.kind === "NODES" && selection.ids.length > 1) return <>{back}<ManySteps ids={selection.ids} /></>;
  const kind: EntityKind = selection.kind === "NODES" ? "NODE" : selection.kind;
  const id = selection.kind === "NODES" ? selection.ids[0]! : selection.id;
  const record = recordOf(draft.document, kind, id);
  if (!record) return <>{back}<Removed kind={kind} id={id} /></>;
  return <>
    {back}
    <EntityEditor key={bufferKey(kind, id)} kind={kind} saved={savedOf(kind, record)} />
    {kind === "NODE" && <StepContext key={id} node={record as NodeRecord} />}
    {kind === "EDGE" && <Endpoints key={id} edge={record as EdgeRecord} />}
    {kind === "FLOW" && <DraftChecks flowId={id} />}
  </>;
}

function EntityEditor({ kind, saved }: { kind: EntityKind; saved: Saved }) {
  const { editable, busy, ui, update, run, refreshFailed } = useStudio();
  const key = bufferKey(kind, saved.id);
  const buffer = ui.buffers[key];
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
      {buffer && <RetainedText text={typedText(kind, changes(buffer))} pending={Boolean(buffer.sent)}
        onDiscard={() => update((current) => ({ buffers: discard(current.buffers, key) }))} />}
    </section>;
  }

  const submit = async (target: EntityBuffer, retrying: boolean) => {
    if (!editable || busy || (target.conflict && !retrying)) return;
    const fields = retrying ? target.sent! : changes(target);
    const found = fieldErrors(kind, fields);
    setErrors(found);
    if (Object.keys(found).length) { document.getElementById(`inspect-${Object.keys(found)[0]}`)?.focus(); return; }
    const requestKey = retrying ? target.key! : crypto.randomUUID();
    if (!retrying) update((current) => ({ buffers: send(current.buffers, key, requestKey) }));
    setMessage("");
    const outcome = await run(updateCommand(kind, saved.id, target.baseVersion, fields), requestKey);
    if (outcome.ok) {
      setMessage("Saved.");
    } else if (!outcome.uncertain) {
      update((current) => ({ buffers: refuse(current.buffers, key, outcome.code === "STALE_ENTITY_VERSION") }));
      setMessage(outcome.code === "STALE_ENTITY_VERSION" ? "" : explain(outcome));
    }
  };
  const onSave = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (buffer && !busy && !buffer.conflict && editable) void submit(buffer, buffer.sent !== null);
  };
  const saveMine = () => {
    if (busy || !editable || refreshFailed) return;
    const rebased = rebase(ui.buffers, saved)[key];
    update((current) => ({ buffers: rebase(current.buffers, saved) }));
    if (rebased && !busy) void submit(rebased, false);
    else setMessage("Your text already matches the saved value.");
  };
  const copyMine = async () => {
    try { await navigator.clipboard.writeText(typedText(kind, values)); setMessage("Copied your edit."); } catch { setMessage("Copy failed. Select the text in the fields instead."); }
  };
  const keepSaved = () => { update((current) => ({ buffers: discard(current.buffers, key) })); setErrors({}); setMessage(""); };

  const dirty = buffer ? dirtyFields(buffer) : [];
  return <section className="detail-section" aria-labelledby="inspector-heading">
    <h3 id="inspector-heading">{heading}</h3>
    {buffer?.conflict && <div className="inline-note" role="alert">
      <p>Someone else saved this {NOUNS[kind]} first. Your text is kept; nothing was overwritten.</p>
      <dl className="conflict-list">{dirty.map((field) => {
        const label = FIELDS[kind].find((spec) => spec.name === field)?.label ?? field;
        return <div key={field}>
          <dt>{label}</dt>
          <dd><span className="muted">Saved value</span>{saved.fields[field] || "(empty)"}</dd>
          <dd><span className="muted">Your edit</span>{buffer.values[field] || "(empty)"}</dd>
          <dd><span className="muted">Before your edit</span>{buffer.original[field] || "(empty)"}</dd>
        </div>;
      })}</dl>
      <div className="view-actions">
        <button type="button" className="button primary small" onClick={saveMine} disabled={busy || refreshFailed}>Save my edit</button>
        <button type="button" className="button small" onClick={keepSaved} disabled={busy || refreshFailed}>Keep saved value</button>
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
        <button type="submit" className="button primary small" disabled={busy || !buffer || buffer.conflict}>{buffer?.sent ? "Save again" : "Save"}</button>
        {buffer && !buffer.conflict && <button type="button" className="button quiet small" onClick={keepSaved} disabled={busy || buffer.sent !== null}>Discard local changes</button>}
      </div>
      <p className="muted" role="status" aria-live="polite">{buffer?.sent && !busy ? "We couldn’t confirm this save. Save again repeats the same request." : message === "Saved." && studioDirtyCount(ui) ? "Unsaved changes" : message}</p>
    </form>
  </section>;
}

function StepContext({ node }: { node: NodeRecord }) {
  const { draft, editable, busy, update } = useStudio();
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
    {editable && draft.layout.positions[node.id] && <PositionForm key={`${node.id}:${draft.layout.positions[node.id]!.version}`} node={node} />}
    {editable && <button type="button" className="button danger small" onClick={() => setDeleting(true)} disabled={busy}>Delete step…</button>}
    {editable && deleting && <DeleteStepsDialog flowId={node.flowId} nodeIds={[node.id]} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); update(() => ({ selection: null })); focusAfterRemoval(); }} />}
  </section>;
}

/** The keyboard way to move a step: the same MOVE_NODES save as a drag, one step at a time. */
function PositionForm({ node }: { node: NodeRecord }) {
  const { draft, busy, attempt, moveSteps } = useStudio();
  const saved = draft.layout.positions[node.id]!;
  const [x, setX] = useState(String(saved.x));
  const [y, setY] = useState(String(saved.y));
  const [error, setError] = useState("");
  const blocked = busy || Boolean(attempt);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = [x, y].map((value) => (value.trim() ? Number(value) : Number.NaN));
    if (next.some((value) => !Number.isFinite(value) || Math.abs(value) > COORDINATE_LIMIT)) { setError(`Enter numbers from -${COORDINATE_LIMIT} to ${COORDINATE_LIMIT}.`); return; }
    setError("");
    if (!blocked) void moveSteps(node.flowId, [{ nodeId: node.id, x: next[0]!, y: next[1]! }]);
  };
  return <form className="position-form" onSubmit={submit} onKeyDown={formKeys} noValidate aria-labelledby="inspector-position">
    <h4 id="inspector-position" className="sr-only">Position</h4>
    <label htmlFor="position-x">X</label>
    <input id="position-x" inputMode="decimal" value={x} onChange={(event) => setX(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "position-error" : undefined} />
    <label htmlFor="position-y">Y</label>
    <input id="position-y" inputMode="decimal" value={y} onChange={(event) => setY(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "position-error" : undefined} />
    <button type="submit" className="button small" disabled={blocked}>Move</button>
    {error && <small id="position-error" className="field-error" role="alert">{error}</small>}
  </form>;
}

function ManySteps({ ids }: { ids: string[] }) {
  const { draft, editable, busy, update } = useStudio();
  const [deleting, setDeleting] = useState(false);
  const present = ids.filter((id) => draft.document.nodes[id]);
  const flowId = present.length ? draft.document.nodes[present[0]!]!.flowId : "";
  return <section className="detail-section" aria-labelledby="inspector-many">
    <h3 id="inspector-many">{present.length} steps selected</h3>
    <ul className="plain-list">{present.map((id) => <li key={id}>{stepName(draft.document, id)}</li>)}</ul>
    <div className="view-actions">
      <button type="button" className="button quiet small" onClick={() => update(() => ({ selection: null }))}>Clear selection</button>
      {editable && present.length > 0 && <button type="button" className="button danger small" onClick={() => setDeleting(true)} disabled={busy}>Delete {present.length} steps…</button>}
    </div>
    {editable && deleting && <DeleteStepsDialog flowId={flowId} nodeIds={present} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); update(() => ({ selection: null })); focusAfterRemoval(); }} />}
  </section>;
}

/** Reconnect guards the document revision (topology), so it is a separate action from editing the condition text. */
function Endpoints({ edge }: { edge: EdgeRecord }) {
  const { draft, editable, busy, ui, update, refreshFailed } = useStudio();
  const submitCommand = useCommandSubmit();
  const key = bufferKey("EDGE", edge.id);
  const saved: Saved = { kind: "EDGE", id: edge.id, version: draft.documentRevision, fields: { fromId: edge.fromId, toId: edge.toId } };
  const buffer = ui.endpointBuffers[key];
  const values = buffer?.values ?? saved.fields;
  const [message, setMessage] = useState("");
  const steps = Object.values(draft.document.nodes).filter((node) => node.flowId === edge.flowId);
  const submit = async (target: EntityBuffer) => {
    if (busy || !editable || target.conflict) return;
    const requestKey = target.key ?? crypto.randomUUID();
    if (!target.sent) update((current) => ({ endpointBuffers: send(current.endpointBuffers, key, requestKey) }));
    const fields = target.sent ? { ...target.original, ...target.sent } : target.values;
    const outcome = await submitCommand(reconnectCommand(edge.id, target.baseVersion, fields), requestKey);
    if (!outcome.ok && !outcome.uncertain) update((current) => ({ endpointBuffers: refuse(current.endpointBuffers, key, outcome.code === "STALE_DOCUMENT_REVISION") }));
    setMessage(outcome.ok ? "Connection moved." : outcome.uncertain || outcome.code === "STALE_DOCUMENT_REVISION" ? "" : explain(outcome));
  };
  const reconnect = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (buffer) void submit(buffer);
  };
  const keepSaved = () => { update((current) => ({ endpointBuffers: discard(current.endpointBuffers, key) })); setMessage(""); };
  const applyMine = () => {
    if (!buffer?.conflict || busy || !editable || refreshFailed || saved.version <= buffer.baseVersion) return;
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
    if (busy || !editable) return;
    const outcome = await submitCommand({ commandSchemaVersion: 1, command: "DELETE_EDGE", expectedDocumentRevision: draft.documentRevision, payload: { edgeId: edge.id } });
    if (outcome.ok) { update(() => ({ selection: null })); focusAfterRemoval(); }
    else setMessage(explain(outcome));
  };
  if (!editable) return <section className="detail-section">
    <p>{stepName(draft.document, edge.fromId)} {"\u2192"} {stepName(draft.document, edge.toId)}</p>
    {buffer && <RetainedText label="Your unsaved endpoint choices" text={endpointText(changes(buffer))} pending={Boolean(buffer.sent)}
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
      <dl className="conflict-list">{[
        { label: "Saved connection", fields: saved.fields }, { label: "Your connection", fields: buffer.values }, { label: "Before your edit", fields: buffer.original },
      ].map(({ label, fields }) => <div key={label}><dt>{label}</dt><dd>{stepName(draft.document, fields.fromId!)} {"\u2192"} {stepName(draft.document, fields.toId!)}</dd></div>)}</dl>
      <div className="view-actions">
        <button type="button" className="button primary small" onClick={applyMine} disabled={busy || refreshFailed || saved.version <= buffer.baseVersion}>Apply my connection</button>
        <button type="button" className="button small" onClick={keepSaved} disabled={busy}>Keep saved connection</button>
        <button type="button" className="button quiet small" onClick={() => void copyMine()}>Copy my connection</button>
      </div>
    </div>}
    <form onSubmit={reconnect} onKeyDown={formKeys}>
      {picker("fromId", "From")}
      {picker("toId", "To")}
      <div className="view-actions">
        <button type="submit" className="button small" disabled={busy || !buffer || buffer.conflict}>{buffer?.sent ? "Retry reconnect" : "Reconnect"}</button>
        {buffer && !buffer.conflict && <button type="button" className="button quiet small" disabled={busy || Boolean(buffer.sent)} onClick={keepSaved}>Discard endpoint changes</button>}
        <button type="button" className="button danger small" onClick={() => void remove()} disabled={busy}>Delete connection</button>
      </div>
    </form>
    <p className="muted" role="status" aria-live="polite">{buffer?.sent && !busy ? "Unconfirmed endpoint change. Retry reconnect repeats the same request." : buffer && message === "Connection moved." ? "Connection saved; newer endpoint choices remain unsaved." : message || (buffer ? "Unsaved endpoint choices" : "")}</p>
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

function RetainedText({ text, onDiscard, pending = false, label = "Your unsaved text" }: { text: string; onDiscard: () => void; pending?: boolean; label?: string }) {
  const { busy } = useStudio();
  const [message, setMessage] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setMessage("Copied your text."); } catch { setMessage("Copy failed. Select the text instead."); }
  };
  return <div className="inline-note">
    <p>Your unsaved input is kept for copying. It cannot be saved here.</p>
    <textarea aria-label={label} readOnly rows={4} value={text} />
    <div className="view-actions">
      <button type="button" className="button small" onClick={() => void copy()}>Copy</button>
      <button type="button" className="button quiet small" disabled={busy || pending} onClick={onDiscard}>Discard</button>
    </div>
    {pending && <p className="muted">Retry the unconfirmed change before discarding.</p>}
    <p className="muted" role="status" aria-live="polite">{message}</p>
  </div>;
}

/** Removed items retain isolated local input for copying, never a recreation action. */
function Removed({ kind, id }: { kind: EntityKind; id: string }) {
  const { ui, update } = useStudio();
  const key = bufferKey(kind, id);
  const buffer = ui.buffers[key];
  const endpoints = ui.endpointBuffers[key];
  const text = [buffer ? typedText(kind, changes(buffer)) : "", endpoints ? endpointText(changes(endpoints)) : ""].filter(Boolean).join("\n");
  return <section className="detail-section" aria-labelledby="inspector-removed">
    <h3 id="inspector-removed">This {NOUNS[kind]} was removed</h3>
    {buffer || endpoints ? <RetainedText text={text} pending={Boolean(buffer?.sent || endpoints?.sent)}
      onDiscard={() => update((current) => ({ buffers: discard(current.buffers, key), endpointBuffers: discard(current.endpointBuffers, key), selection: null }))} />
      : <p className="muted">Choose another item, or go back to the project.</p>}
  </section>;
}
