"use client";

import { useState, type KeyboardEvent } from "react";
import { graphWarnings } from "@/features/drafts/domain/warnings";
import { Icon } from "@/features/shell/ui/icon";
import { INCLUSION_LABELS } from "./fields";
import FlowCanvas from "./flow-canvas";
import { FlowsDialog } from "./flows-dialog";
import GraphList from "./graph-list";
import { currentFlow, recordOf } from "./graph-view";
import { AddStepDialog, ConnectDialog, DeleteStepsDialog } from "./step-dialogs";
import { CommandRecovery, useStudio } from "./studio-context";
import { studioDirtyCount } from "./studio-ui";

type StudioDialog = "add" | "connect" | "delete" | null;

/** Delete and Backspace act on the graph only while focus is outside text controls and IME composition. */
function typing(event: KeyboardEvent<HTMLElement>) {
  const target = event.target as HTMLElement;
  return event.nativeEvent.isComposing || target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/** The centre of the editor: the open flow, its toolbox and status. */
export default function Studio() {
  const { draft, editable, busy, narrow, ui, update, inspect } = useStudio();
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<StudioDialog>(null);
  // Keep this mount stable when the first flow changes the centre from empty to populated.
  const creation = creating && <FlowsDialog key="new-flow" creating onClose={() => setCreating(false)} />;
  const flow = currentFlow(draft.document, ui.flowId);
  if (!flow) return <><NoFlows onCreate={() => setCreating(true)} />{creation}</>;

  const view = ui.view ?? (narrow ? "list" : "canvas");
  const selectedSteps = ui.selection?.kind === "NODES" ? ui.selection.ids : [];
  const stepCount = Object.values(draft.document.nodes).filter((node) => node.flowId === flow.id).length;
  const focusFlowTitle = () => requestAnimationFrame(() => document.getElementById("studio-flow-title")?.focus());
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.key !== "Delete" && event.key !== "Backspace") || typing(event) || !editable || busy || !selectedSteps.length || dialog) return;
    event.preventDefault();
    setDialog("delete");
  };
  const showFlowDetails = () => { update(() => ({ selection: { kind: "FLOW", id: flow.id } })); inspect(); };

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
        <button type="button" className="button small" onClick={() => setDialog("add")} disabled={busy}><Icon name="plus" size={14} />Add step</button>
        <button type="button" className="button small" onClick={() => setDialog("connect")} disabled={busy || !stepCount}><Icon name="link" size={14} />Connect</button>
      </>}
      <button type="button" className="button quiet small" onClick={showFlowDetails}>Flow details</button>
    </div>
    <div className="studio-stage">
      {view === "canvas" ? <FlowCanvas flowId={flow.id} /> : <GraphList flowId={flow.id} onDeleteSelected={() => setDialog("delete")} />}
    </div>
    <StudioStatus flowId={flow.id} />
    {editable && dialog === "add" && <AddStepDialog flowId={flow.id} onClose={() => setDialog(null)} onAdded={(nodeId) => { setDialog(null); update(() => ({ selection: { kind: "NODES", ids: [nodeId] } })); }} />}
    {editable && dialog === "connect" && <ConnectDialog flowId={flow.id} from={selectedSteps.length === 1 ? selectedSteps[0] : undefined} onClose={() => setDialog(null)} />}
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
    <div className="studio-status"><RemovedRecovery /><CommandRecovery /></div>
  </div>;
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

function StudioStatus({ flowId }: { flowId: string }) {
  const { draft, ui, update, save, refreshFailed, inspect } = useStudio();
  const steps = Object.values(draft.document.nodes).filter((node) => node.flowId === flowId).length;
  const connections = Object.values(draft.document.edges).filter((edge) => edge.flowId === flowId).length;
  const checks = graphWarnings(draft.document, flowId).length;
  const saveText = save.state === "saving" ? "Saving…" : save.state === "failed" ? save.message
    : studioDirtyCount(ui) ? "Unsaved changes" : save.state === "saved" && !refreshFailed ? "All changes saved" : "";
  return <div className="studio-status">
    <span>{steps} {steps === 1 ? "step" : "steps"} · {connections} {connections === 1 ? "connection" : "connections"}</span>
    <button type="button" className="button quiet small" onClick={() => { update(() => ({ selection: { kind: "FLOW", id: flowId } })); inspect(); }}>
      {checks ? `${checks} draft ${checks === 1 ? "check" : "checks"}` : "No draft checks"}
    </button>
    <RemovedRecovery />
    <span className="editor-spacer" />
    <CommandRecovery />
    <span className={save.state === "failed" ? "status-error" : "muted"} role="status" aria-live="polite">{saveText}</span>
  </div>;
}
