"use client";

import { useEffect, useRef } from "react";
import type { ProjectBootstrap, ProjectCapacity } from "@/features/projects/contracts/project";
import { roleLabel } from "@/features/projects/ui/format";
import { Icon } from "./icon";

function ShowProjects({ onClick }: { onClick: () => void }) {
  return <button type="button" className="button quiet small" onClick={onClick} aria-label="Show projects" aria-expanded={false} aria-controls="projects-nav"><Icon name="panel" /></button>;
}

/** Keyed by project id in the shell: switching projects unmounts this project's editor state. */
export default function ProjectEditor({ bootstrap, autoFocus, sidebarClosed, onShowProjects, panelOpen, onTogglePanel }: {
  bootstrap: ProjectBootstrap; autoFocus: boolean; sidebarClosed: boolean; onShowProjects: () => void; panelOpen: boolean; onTogglePanel: () => void;
}) {
  const { project } = bootstrap;
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (autoFocus) titleRef.current?.focus(); }, [autoFocus]);
  const archived = project.status === "ARCHIVED";
  return <div className="project-editor" id="project-editor">
    <header className="editor-header">
      {sidebarClosed && <ShowProjects onClick={onShowProjects} />}
      <h1 ref={titleRef} className="editor-title" tabIndex={-1} title={project.name}>{project.name}</h1>
      {project.role !== "OWNER" && <span className="badge">{roleLabel(project.role)}</span>}
      <span className="editor-spacer" />
      <button type="button" className="button small editor-toggle" aria-pressed={panelOpen} aria-controls="right-panel" onClick={onTogglePanel}><Icon name="details" size={14} /><span>Inspect</span></button>
    </header>
    {archived && <div className="editor-banner"><span><Icon name="lock" size={14} />Archived · read-only</span></div>}
    <div className="editor-body">
      <div className="empty-state">
        {archived ? <h2>This archived project has no flows.</h2> : <><h2>No flows yet</h2><p>This project has an empty draft. Flow editing isn&rsquo;t available yet.</p></>}
      </div>
    </div>
  </div>;
}

export function NoProjectOpen({ sidebarClosed, capacity, hasInvites, onShowProjects, onCreate, onViewInvites }: {
  sidebarClosed: boolean; capacity: ProjectCapacity | null; hasInvites: boolean; onShowProjects: () => void; onCreate: () => void; onViewInvites: () => void;
}) {
  return <div className="empty-state">
    <h1 tabIndex={-1}>No project open</h1>
    <p>Choose a project or create one.</p>
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
