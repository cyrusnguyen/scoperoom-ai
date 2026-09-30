"use client";

import { Fragment, useState, type KeyboardEvent } from "react";
import { graphWarnings } from "@/features/drafts/domain/warnings";
import { Icon } from "@/features/shell/ui/icon";
import { ArrangeDialog } from "./arrange-dialog";
import { INCLUSION_LABELS } from "./fields";
import FlowCanvas from "./flow-canvas";
import { FlowsDialog } from "./flows-dialog";
import GraphList from "./graph-list";
import { currentFlow, recordOf } from "./graph-view";
import { AddStepDialog, ConnectDialog, DeleteStepsDialog } from "./step-dialogs";
import { compareOutbox, describeAll, optimistic } from "./outbox";
import { ReadRecovery, staleCodes, useStudio } from "./studio-context";
import { canApplyAgain, stranded, studioDirtyCount, type SaveState, type StudioUi } from "./studio-ui";

type StudioDialog = "add" | "connect" | "delete" | "arrange" | null;

/** Delete and Backspace act on the graph only while focus is outside text controls and IME composition. */
function typing(event: KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  return event.nativeEvent.isComposing || target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** The centre of the editor: the open flow, its toolbox and status. */
export default function Studio() {
  const { draft, editable, busy, narrow, ui, update, inspect, run, saveChanges } = useStudio();
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<StudioDialog>(null);
  // Arrange stayed closed because a save is unresolved; its note goes once that save is resolved.
  const [arrangeBlocked, setArrangeBlocked] = useState(false);
  if (arrangeBlocked && !ui.outbox.sending) setArrangeBlocked(false);
  // Keep this mount stable when the first flow changes the centre from empty to populated.
  const creation = creating && <FlowsDialog key="new-flow" creating onClose={() => setCreating(false)} />;
  const flow = currentFlow(draft.document, ui.flowId);
  if (!flow) return <><NoFlows onCreate={() => setCreating(true)} />{creation}</>;

  const view = ui.view ?? (narrow ? "list" : "canvas");
  const selectedSteps = ui.selection?.kind === "NODES" ? ui.selection.ids : [];
  const stepCount = Object.values(draft.document.nodes).filter((node) => node.flowId === flow.id).length;
  const focusFlowTitle = () => requestAnimationFrame(() => document.getElementById("studio-flow-title")?.focus());
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.key !== "Delete" && event.key !== "Backspace") || typing(event) || !editable || dialog) return;
    const edge = ui.selection?.kind === "EDGE" ? draft.document.edges[ui.selection.id] : undefined;
    // A selected connection goes at once: it is undoable until saved. Steps are confirmed first (they take connections).
    if (edge) {
      event.preventDefault();
      void run({ commandSchemaVersion: 1, command: "DELETE_EDGE", expectedDocumentRevision: draft.documentRevision, payload: { edgeId: edge.id } })
        .then((outcome) => { if (outcome.ok) update(() => ({ selection: null })); });
      return;
    }
    if (!selectedSteps.length) return;
    event.preventDefault();
    setDialog("delete");
  };
  const showFlowDetails = () => { update(() => ({ selection: { kind: "FLOW", id: flow.id } })); inspect(); };
  // Arrange works from the saved draft, so unsaved changes are saved first; if they cannot be, it does not open.
  const arrange = async () => {
    const saved = await saveChanges();
    setArrangeBlocked(!saved);
    if (saved) setDialog("arrange");
  };

  return <><section className="studio" aria-labelledby="studio-flow-title" onKeyDown={onKeyDown}>
    <div className="studio-toolbar">
      <h2 id="studio-flow-title" className="studio-flow-title" tabIndex={-1} title={flow.title}>{flow.title}</h2>
      <span className="badge" data-inclusion={flow.inclusion}>{INCLUSION_LABELS[flow.inclusion]}</span>
      <span className="editor-spacer" />
      <div className="segmented" role="group" aria-label="Studio view">
        <button type="button" aria-pressed={view === "canvas"} onClick={() => update(() => ({ view: "canvas" }))}><Icon name="flow" size={14} />Canvas</button>
        <button type="button" aria-pressed={view === "list"} onClick={() => update(() => ({ view: "list" }))}><Icon name="list" size={14} />List</button>
      </div>
      {editable && <>
        <button type="button" className="button small" onClick={() => setDialog("add")}><Icon name="plus" size={14} />Add step</button>
        <button type="button" className="button small" onClick={() => setDialog("connect")} disabled={!stepCount}><Icon name="link" size={14} />Connect</button>
        <button type="button" className="button quiet small" onClick={() => void arrange()} disabled={busy || !stepCount}><Icon name="grid" size={14} />Arrange</button>
      </>}
      <button type="button" className="button quiet small" onClick={showFlowDetails}>Flow details</button>
    </div>
    <div className="studio-stage">
      {view === "canvas" ? <FlowCanvas flowId={flow.id} /> : <GraphList flowId={flow.id} onDeleteSelected={() => setDialog("delete")} />}
    </div>
    <SaveNote />
    {arrangeBlocked && <div className="save-note" role="alert">
      <span>Arrange didn’t open because your changes aren’t saved yet.</span>
    </div>}
    <StudioStatus flowId={flow.id} />
    {editable && dialog === "add" && <AddStepDialog flowId={flow.id} onClose={() => setDialog(null)} onAdded={(nodeId) => { setDialog(null); update(() => ({ selection: { kind: "NODES", ids: [nodeId] } })); }} />}
    {editable && dialog === "connect" && <ConnectDialog flowId={flow.id} from={selectedSteps.length === 1 ? selectedSteps[0] : undefined} onClose={() => setDialog(null)} />}
    {editable && dialog === "arrange" && <ArrangeDialog flowId={flow.id} onClose={() => setDialog(null)} />}
    {editable && dialog === "delete" && <DeleteStepsDialog flowId={flow.id} nodeIds={selectedSteps} onClose={() => setDialog(null)}
      onDeleted={() => { setDialog(null); update(() => ({ selection: null })); focusFlowTitle(); }} />}
  </section>{creation}</>;
}

function NoFlows({ onCreate }: { onCreate: () => void }) {
  const { archived, editable } = useStudio();
  return <div className="empty-state">
    {archived ? <h2>This archived project has no flows.</h2> : <>
      <h2>No flows yet</h2>
      {editable ? <>
        <p>Create a flow to map a journey or process. Requirements and approval can come later.</p>
        <div className="view-actions"><button type="button" className="button primary" onClick={onCreate}>New flow</button></div>
      </> : <p>Only the owner and editors can add flows.</p>}
    </>}
    <SaveNote />
    <div className="studio-status"><RemovedRecovery /><ReadRecovery /><NoFlowsStatus /></div>
  </div>;
}

/** Without a flow (a deleted last flow may still be saving), the save status still shows. */
function NoFlowsStatus() {
  const { ui, save, refreshFailed } = useStudio();
  return <SaveStatus ui={ui} save={save} refreshFailed={refreshFailed} />;
}

/** A removed item's local input remains reachable even after the last flow disappears. */
function RemovedRecovery() {
  const { draft, ui, update, inspect } = useStudio();
  const orphan = [...Object.values(ui.buffers), ...Object.values(ui.endpointBuffers)].find((buffer) => !recordOf(draft.document, buffer.kind, buffer.id));
  if (!orphan) return null;
  const review = () => {
    update(() => ({ selection: orphan.kind === "NODE" ? { kind: "NODES", ids: [orphan.id] } : { kind: orphan.kind, id: orphan.id } }));
    inspect();
  };
  return <button type="button" className="button quiet small" onClick={review}>Unsaved text for a removed item</button>;
}

/**
 * The save's recovery note (Task 14b): an unconfirmed save retries with its own key; a refused one keeps every unsaved
 * change on screen until the person applies them again on the newer draft or discards them; a replay that had to leave
 * changes out lists them (their typed text included), so nothing is dropped silently.
 */
function SaveNote() {
  const { ui, draft, editable, busy, savedDraft, saveChanges, applyAgain, discardChanges, dismissDropped, keepTheirs, skipped, unsaved } = useStudio();
  const { sending } = ui.outbox;
  const dropped = [...ui.outbox.dropped, ...skipped];
  const list = (items: string[]) => <ul className="plain-list save-note-list">{items.map((text, index) => <li key={index}>{text}</li>)}</ul>;
  if (sending?.state === "uncertain") return <div className="save-note" role="alert">
    <span>We couldn’t confirm your changes. Retry sends the same request.</span>
    <span className="view-actions"><button type="button" className="button primary small" onClick={() => void saveChanges()} disabled={busy}>Retry</button></span>
  </div>;
  if (!editable && unsaved) return <div className="save-note" role="alert">
    <span>{stranded(ui.outbox, savedDraft.id) ? "This project’s draft was replaced, so your unsaved changes can’t be saved to it. They’re listed here for copying:" : "This draft is read-only now, so your unsaved changes can’t be saved. They’re listed here for copying:"}</span>
    {list(describeAll(ui.outbox, optimistic(ui.outbox, savedDraft, ui.acknowledgedRevisions[savedDraft.id]).document))}
    <span className="view-actions"><button type="button" className="button quiet small" onClick={discardChanges} disabled={busy}>Discard my changes</button></span>
  </div>;
  if (sending?.state === "refused") {
    // Never resubmit over someone else's newer value unseen (UI02): each overlap is compared first, 03.2-style.
    const conflicts = compareOutbox(ui.outbox, savedDraft, draft.document);
    return <div className="save-note" role="alert">
    <span>{staleCodes.has(sending.code ?? "") ? "Someone else changed this draft first, so your changes weren’t saved." : `${sending.message ?? ""} Your changes weren’t saved.`} They’re still shown here.</span>
    {conflicts.length > 0 && <>
      <span>They also changed what you edited. Compare, then keep theirs or apply yours:</span>
      <dl className="conflict-list save-note-list">{conflicts.map((conflict, index) => <div key={index}>
        <dt>{conflict.label}</dt>
        {conflict.rows.map((row) => <Fragment key={row.field}>
          <dd><span className="muted">Saved value</span>{row.theirs}</dd>
          <dd><span className="muted">Your edit</span>{row.mine}</dd>
          <dd><span className="muted">Before your edit</span>{row.before}</dd>
        </Fragment>)}
        <dd><button type="button" className="button quiet small" onClick={() => keepTheirs(conflict.target)} disabled={busy}>Keep theirs</button></dd>
      </div>)}</dl>
    </>}
    <span className="view-actions">
      <button type="button" className="button primary small" onClick={() => void applyAgain()} disabled={busy || !canApplyAgain(ui, savedDraft)}>Apply my changes again</button>
      <button type="button" className="button quiet small" onClick={discardChanges} disabled={busy}>Discard my changes</button>
    </span>
  </div>;
  }
  if (dropped.length) return <div className="save-note" role="alert">
    <span>These changes no longer applied, so they were left out:</span>
    {list(dropped)}
    <span className="view-actions"><button type="button" className="button quiet small" onClick={dismissDropped}>Dismiss</button></span>
  </div>;
  return null;
}

/** One status line for every change (UI02, Task 14b): "Unsaved changes" → "Saving…" → "All changes saved". */
function StudioStatus({ flowId }: { flowId: string }) {
  const { draft, ui, update, save, refreshFailed, inspect, canUndo, canRedo, undo, redo } = useStudio();
  const steps = Object.values(draft.document.nodes).filter((node) => node.flowId === flowId).length;
  const connections = Object.values(draft.document.edges).filter((edge) => edge.flowId === flowId).length;
  const checks = graphWarnings(draft.document, flowId).length;
  return <div className="studio-status">
    <span>{steps} {steps === 1 ? "step" : "steps"} · {connections} {connections === 1 ? "connection" : "connections"}</span>
    <button type="button" className="button quiet small" onClick={() => { update(() => ({ selection: { kind: "FLOW", id: flowId } })); inspect(); }}>
      {checks ? `${checks} draft ${checks === 1 ? "check" : "checks"}` : "No draft checks"}
    </button>
    <RemovedRecovery />
    {canUndo && <button type="button" className="button quiet small" onClick={undo} title="Undo the last unsaved change"><Icon name="undo" size={14} />Undo</button>}
    {canRedo && <button type="button" className="button quiet small" onClick={redo} title="Redo the change you undid">Redo</button>}
    <span className="editor-spacer" />
    <ReadRecovery />
    <SaveStatus ui={ui} save={save} refreshFailed={refreshFailed} />
  </div>;
}

function SaveStatus({ ui, save, refreshFailed }: { ui: StudioUi; save: SaveState; refreshFailed: boolean }) {
  const state = ui.outbox.sending?.state;
  const text = state === "sending" ? "Saving…" : state === "uncertain" ? "We couldn’t confirm your changes." : state === "refused" ? "Your changes weren’t saved."
    : save.state === "failed" && save.message ? save.message : studioDirtyCount(ui) ? "Unsaved changes" : save.state === "saved" && !refreshFailed ? "All changes saved" : "";
  return <span className={state === "uncertain" || state === "refused" || save.state === "failed" ? "status-error" : "muted"} role="status" aria-live="polite">{text}</span>;
}
