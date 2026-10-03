"use client";

import { useEffect, useRef } from "react";
import type { ProjectBootstrap, ProjectCapacity } from "@/features/projects/contracts/project";
import { roleLabel } from "@/features/projects/ui/format";
import { FlowSwitcher } from "@/features/studio/ui/flows-dialog";
import { currentFlow } from "@/features/studio/ui/graph-view";
import Studio from "@/features/studio/ui/studio";
import { useStudio } from "@/features/studio/ui/studio-context";
import { Icon } from "./icon";

/**
 * Saves every unsaved change now instead of at the next autosave (editors only). Enabled whenever something is unsaved
 * and nothing is in flight; an unconfirmed save is retried with its key, a refused one waits for the person's choice.
 */
function SaveChanges() {
  const { editable, unsaved, busy, ui, saveChanges } = useStudio();
  if (!editable) return null;
  return <button type="button" className="button small" title="Save all changes" disabled={!unsaved || busy || ui.outbox.sending?.state === "refused"} onClick={() => void saveChanges()}>
    <Icon name="check" size={14} /><span>Save</span>
  </button>;
}

function ShowProjects({ onClick }: { onClick: () => void }) {
  return <button type="button" className="button quiet small" onClick={onClick} aria-label="Show projects" aria-expanded={false} aria-controls="projects-nav"><Icon name="panel" /></button>;
}

/** Keyed by project id in the shell: switching projects unmounts this project's editor state. Renders inside the StudioProvider. */
export default function ProjectEditor({ bootstrap, autoFocus, sidebarClosed, onShowProjects, panelOpen, onTogglePanel, restoreNote, onRestore }: {
  bootstrap: ProjectBootstrap; autoFocus: boolean; sidebarClosed: boolean; onShowProjects: () => void; panelOpen: boolean; onTogglePanel: () => void;
  restoreNote?: string; onRestore: () => void;
}) {
  const { project } = bootstrap;
  const { draft, ui, update } = useStudio();
  const toggleInspector = () => {
    if (!panelOpen && !ui.selection) {
      const flow = currentFlow(draft.document, ui.flowId);
      if (flow) update(() => ({ selection: { kind: "FLOW", id: flow.id } }));
    }
    onTogglePanel();
  };
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (autoFocus) titleRef.current?.focus(); }, [autoFocus]);
  const archived = project.status === "ARCHIVED";
  return <div className="project-editor" id="project-editor">
    <header className="editor-header">
      {sidebarClosed && <ShowProjects onClick={onShowProjects} />}
      <h1 ref={titleRef} className="editor-title" tabIndex={-1} title={project.name}>{project.name}</h1>
      {project.role !== "OWNER" && <span className="badge">{roleLabel(project.role)}</span>}
      <FlowSwitcher />
      <span className="editor-spacer" />
      <SaveChanges />
      <button type="button" className="button small editor-toggle" aria-pressed={panelOpen} aria-controls="right-panel" onClick={toggleInspector}><Icon name="details" size={14} /><span>Inspect</span></button>
    </header>
    {archived && <div className="editor-banner">
      <span><Icon name="lock" size={14} />Archived · read-only</span>
      {project.role === "OWNER" && <span className="editor-banner-actions">
        <button type="button" className="button small" onClick={onRestore} disabled={Boolean(restoreNote)} aria-describedby={restoreNote ? "restore-note" : undefined}>Restore…</button>
        {restoreNote && <small id="restore-note" className="editor-banner-note">{restoreNote}</small>}
      </span>}
    </div>}
    <div className="editor-body"><Studio /></div>
  </div>;
}

export function NoProjectOpen({ autoFocus, sidebarClosed, capacity, hasInvites, onShowProjects, onCreate, onViewInvites }: {
  autoFocus: boolean; sidebarClosed: boolean; capacity: ProjectCapacity | null; hasInvites: boolean; onShowProjects: () => void; onCreate: () => void; onViewInvites: () => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (autoFocus) titleRef.current?.focus(); }, [autoFocus]);
  return <div className="empty-state">
    <h1 ref={titleRef} tabIndex={-1}>No project open</h1>
    {/* Empty states name an authorized next action only (UI00). */}
    <p>{capacity?.entitled ? "Choose a project or create one." : "Choose a project."}</p>
    <div className="view-actions">
      {sidebarClosed && <button type="button" className="button" onClick={onShowProjects} aria-label="Show projects" aria-expanded={false} aria-controls="projects-nav">Show projects</button>}
      {capacity?.canCreate && <button type="button" className="button primary" onClick={onCreate}>New project</button>}
    </div>
    {capacity && !capacity.entitled && hasInvites && <button type="button" className="text-link" onClick={onViewInvites}>View invitations</button>}
  </div>;
}

export function ProjectUnavailable({ missing, message, sidebarClosed, onShowProjects, onRetry }: {
  missing: boolean; message: string; sidebarClosed: boolean; onShowProjects: () => void; onRetry: () => void;
}) {
  return <div className="empty-state">
    <h1 tabIndex={-1}>{missing ? "Project unavailable" : "Project couldn’t load"}</h1>
    <p>{missing ? "It may have been removed, or your access changed." : message}</p>
    <div className="view-actions">
      {sidebarClosed && <button type="button" className="button" onClick={onShowProjects} aria-label="Show projects" aria-expanded={false} aria-controls="projects-nav">Show projects</button>}
      {!missing && <button type="button" className="button" onClick={onRetry}>Retry</button>}
    </div>
  </div>;
}
