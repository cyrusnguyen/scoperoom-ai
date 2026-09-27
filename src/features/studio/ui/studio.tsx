"use client";

import { useState } from "react";
import { graphWarnings } from "@/features/drafts/domain/warnings";
import { Icon } from "@/features/shell/ui/icon";
import { INCLUSION_LABELS } from "./fields";
import FlowCanvas from "./flow-canvas";
import { FlowsDialog } from "./flows-dialog";
import GraphList from "./graph-list";
import { currentFlow, recordOf } from "./graph-view";
import { CommandRecovery, useStudio } from "./studio-context";

/** The centre of the editor: the open flow as a canvas or an ordered List, and its status. The toolbox arrives next. */
export default function Studio() {
  const { draft, narrow, ui, update, inspect } = useStudio();
  const flow = currentFlow(draft.document, ui.flowId);
  if (!flow) return <NoFlows />;

  const view = ui.view ?? (narrow ? "list" : "canvas");
  const showFlowDetails = () => { update(() => ({ selection: { kind: "FLOW", id: flow.id } })); inspect(); };

  return <section className="studio" aria-labelledby="studio-flow-title">
    <div className="studio-toolbar">
      <h2 id="studio-flow-title" className="studio-flow-title" tabIndex={-1} title={flow.title}>{flow.title}</h2>
      <span className="badge" data-inclusion={flow.inclusion}>{INCLUSION_LABELS[flow.inclusion]}</span>
      <span className="editor-spacer" />
      <div className="segmented" role="group" aria-label="Studio view">
        <button type="button" aria-pressed={view === "canvas"} onClick={() => update(() => ({ view: "canvas" }))}><Icon name="flow" size={14} />Canvas</button>
        <button type="button" aria-pressed={view === "list"} onClick={() => update(() => ({ view: "list" }))}><Icon name="list" size={14} />List</button>
      </div>
      <button type="button" className="button quiet small" onClick={showFlowDetails}>Flow details</button>
    </div>
    <div className="studio-stage">
      {view === "canvas" ? <FlowCanvas flowId={flow.id} /> : <GraphList flowId={flow.id} />}
    </div>
    <StudioStatus flowId={flow.id} />
  </section>;
}

function NoFlows() {
  const { archived, editable } = useStudio();
  const [creating, setCreating] = useState(false);
  if (archived) return <div className="empty-state"><h2>This archived project has no flows.</h2></div>;
  return <div className="empty-state">
    <h2>No flows yet</h2>
    {editable ? <>
      <p>Create a flow to map a journey or process. Requirements and approval can come later.</p>
      <div className="view-actions"><button type="button" className="button primary" onClick={() => setCreating(true)}>New flow</button></div>
    </> : <p>Only the owner and editors can add flows.</p>}
    <CommandRecovery />
    {creating && <FlowsDialog creating onClose={() => setCreating(false)} />}
  </div>;
}

function StudioStatus({ flowId }: { flowId: string }) {
  const { draft, ui, update, save, refreshFailed, inspect } = useStudio();
  const steps = Object.values(draft.document.nodes).filter((node) => node.flowId === flowId).length;
  const connections = Object.values(draft.document.edges).filter((edge) => edge.flowId === flowId).length;
  const checks = graphWarnings(draft.document, flowId).length;
  const orphan = Object.values(ui.buffers).find((buffer) => !recordOf(draft.document, buffer.kind, buffer.id));
  const review = () => {
    if (!orphan) return;
    update(() => ({ selection: orphan.kind === "NODE" ? { kind: "NODES", ids: [orphan.id] } : { kind: orphan.kind, id: orphan.id } }));
    inspect();
  };
  const saveText = save.state === "saving" ? "Saving…" : save.state === "saved" ? (refreshFailed ? "" : "All changes saved") : save.state === "failed" ? save.message : "";
  return <div className="studio-status">
    <span>{steps} {steps === 1 ? "step" : "steps"} · {connections} {connections === 1 ? "connection" : "connections"}</span>
    <button type="button" className="button quiet small" onClick={() => { update(() => ({ selection: { kind: "FLOW", id: flowId } })); inspect(); }}>
      {checks ? `${checks} draft ${checks === 1 ? "check" : "checks"}` : "No draft checks"}
    </button>
    {orphan && <button type="button" className="button quiet small" onClick={review}>Unsaved text for a removed item</button>}
    <span className="editor-spacer" />
    <CommandRecovery />
    <span className={save.state === "failed" ? "status-error" : "muted"} role="status" aria-live="polite">{saveText}</span>
  </div>;
}
