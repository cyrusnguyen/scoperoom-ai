"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import { useRouter } from "next/navigation";
import { rememberPanel, restorePanel } from "./panel-preferences";
import ProjectShare from "@/features/projects/ui/project-share";
import ProjectManagement from "@/features/projects/ui/project-management";

type ProjectItem = { id: string; name: string; status: "ACTIVE" | "ARCHIVED"; role: "OWNER" | "EDITOR" | "REVIEWER" | "VIEWER"; ownerName: string };
type ProjectGroup = { items: ProjectItem[]; truncated: boolean };
type ProjectLists = { owned: ProjectGroup; shared: ProjectGroup; archived: ProjectGroup; capacity: { entitled: boolean; activeOwned: number; maxOwned: number; canCreate: boolean } };
type ProjectBootstrap = { project: { id: string; name: string; status: string; role: "OWNER" | "EDITOR" | "REVIEWER" | "VIEWER"; ownerId: string }; draft: { id: string; schemaVersion: 3; documentRevision: number; layoutRevision: number } };
type ApiError = { error?: { message?: string } };

async function errorMessage(response: Response, fallback: string) {
  try { return (await response.json() as ApiError).error?.message || fallback; } catch { return fallback; }
}

function PanelIcon({ side }: { side: "left" | "right" }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d={side === "left" ? "M8 3v18" : "M16 3v18"} /></svg>;
}
function CloseIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>; }

export default function WorkspaceHome({ signOut, projectId }: { signOut: () => Promise<void>; projectId?: string }) {
  const router = useRouter();
  const [message, setMessage] = useState("Loading projects...");
  const [lists, setLists] = useState<ProjectLists | null>(null);
  const [projectMessage, setProjectMessage] = useState("");
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [projectCreating, setProjectCreating] = useState(false);
  const [projectUncertain, setProjectUncertain] = useState(false);
  const [project, setProject] = useState<ProjectBootstrap | null>(null);
  const [projectUnavailable, setProjectUnavailable] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [panelsReady, setPanelsReady] = useState(false);
  const leftCloseRef = useRef<HTMLButtonElement>(null);
  const leftShowRef = useRef<HTMLButtonElement>(null);
  const rightCloseRef = useRef<HTMLButtonElement>(null);
  const rightShowRef = useRef<HTMLButtonElement>(null);
  const leftWasOpen = useRef(true);
  const rightWasOpen = useRef(true);
  const setLeftPanel = (open: boolean) => { rememberPanel("left", open); setLeftOpen(open); };
  const setRightPanel = (open: boolean) => { rememberPanel("right", open); setRightOpen(open); };
  const cancelProjectForm = () => {
    setProjectFormOpen(false);
    setProjectUncertain(false);
    setProjectKey("");
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const left = restorePanel("left"); const right = restorePanel("right");
      leftWasOpen.current = left; rightWasOpen.current = right;
      setLeftOpen(left); setRightOpen(right); setPanelsReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => { if (panelsReady && leftWasOpen.current !== leftOpen) { (leftOpen ? leftCloseRef : leftShowRef).current?.focus(); leftWasOpen.current = leftOpen; } }, [leftOpen, panelsReady]);
  useEffect(() => { if (panelsReady && rightWasOpen.current !== rightOpen) { (rightOpen ? rightCloseRef : rightShowRef).current?.focus(); rightWasOpen.current = rightOpen; } }, [rightOpen, panelsReady]);

  const refresh = useCallback(async (clearMessage = true) => {
    try {
      const result = await fetch("/api/projects", { cache: "no-store" });
      if (!result.ok) throw new Error(await errorMessage(result, "Project access is unavailable."));
      setLists(await result.json() as ProjectLists);
      if (clearMessage) setMessage("");
      return true;
    } catch (error) {
      setLists(null); setProject(null); setProjectUnavailable(Boolean(projectId));
      setMessage(error instanceof Error ? error.message : "Project access is unavailable.");
      return false;
    }
  }, [projectId]);

  const refreshBootstrap = useCallback(async (id: string) => {
    try {
      const result = await fetch(`/api/projects/${id}/bootstrap`, { cache: "no-store" });
      if (!result.ok) throw new Error("Project details are unavailable.");
      const nextProject = await result.json() as ProjectBootstrap;
      setProject(nextProject); setProjectUnavailable(false); setProjectMessage(""); return true;
    } catch {
      setProject(null); setProjectUnavailable(true); setProjectMessage("Project details are unavailable."); return false;
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void refresh(); }, 0); return () => window.clearTimeout(timer); }, [refresh]);
  useEffect(() => {
    const timer = window.setTimeout(() => { if (projectId) void refreshBootstrap(projectId); else setProject(null); }, 0);
    return () => window.clearTimeout(timer);
  }, [projectId, refreshBootstrap]);

  const submitProject = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestKey = projectKey || crypto.randomUUID();
    setProjectKey(requestKey); setProjectCreating(true); setProjectUncertain(false);
    try {
      const result = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey }, body: JSON.stringify({ name: projectName }) });
      if (!result.ok) { setProjectMessage(await errorMessage(result, "Project creation is unavailable.")); setProjectUncertain(result.status >= 500); if (result.status < 500) setProjectKey(""); return; }
      const created = await result.json() as { id: string };
      router.push(`/app/projects/${created.id}`);
    } catch { setProjectMessage("We could not confirm project creation. Your name is ready to retry."); setProjectUncertain(true); } finally { setProjectCreating(false); }
  };

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <div className="workspace-shell">
        <header className="workspace-header">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
            <span>ScopeRoom<span className="brand-suffix"> / Studio</span></span>
          </div>
          <span className="workspace-title">{project?.project.name ?? "ScopeRoom"}</span>
          <span className="preview-label">UI preview</span>
          <form action={signOut}><button className="signout-button" type="submit">Sign out</button></form>
        </header>

        <main id="main-content" tabIndex={-1} className="workspace-main" data-panels-ready={panelsReady} data-left-open={leftOpen} data-right-open={rightOpen}>
          <section className="canvas-column" aria-label="Canvas">
            <div className="canvas-toolbar">
              <div className="canvas-toolbar-start">
                {!leftOpen && <button ref={leftShowRef} className="panel-toggle" type="button" aria-label="Show left sidebar" aria-controls="workspace-sidebar" aria-expanded={false} title="Show workspace sidebar" onClick={() => setLeftPanel(true)}><PanelIcon side="left" /></button>}
                <div className="canvas-breadcrumb">
                  <span>Projects</span>
                  <span aria-hidden="true">/</span>
                  <strong>{project?.project.name ?? "Canvas"}</strong>
                </div>
              </div>
              <div className="canvas-toolbar-end">
                <span className="canvas-view-label"><span className="view-dot" />Canvas view</span>
                {!rightOpen && <button ref={rightShowRef} className="panel-toggle" type="button" aria-label="Show right sidebar" aria-controls="workspace-context" aria-expanded={false} title="Show project context" onClick={() => setRightPanel(true)}><PanelIcon side="right" /></button>}
              </div>
            </div>
            <div className="canvas-stage">
              <div className="canvas-empty">
                <div className="empty-icon" aria-hidden="true"><span /><span /><span /></div>
                <span className="empty-kicker">{project ? "EMPTY DRAFT" : "A FRESH START"}</span>
                <h1>{project ? "Project canvas" : "Blank canvas"}</h1>
                <p>{project ? "This project has an empty saved draft." : "Nothing has been added to this canvas yet."}</p>
                <p className="empty-help">Flow editing and saving arrive in a later stage.</p>
              </div>
            </div>
            <div className="canvas-status">
              <span className="canvas-status-state"><span className="status-dot" />{project ? "Empty draft" : "No content yet"}</span>
              <span>0 steps / 0 connections</span>
            </div>
          </section>

          <aside id="workspace-sidebar" className="workspace-sidebar" aria-labelledby="guide-title" hidden={!leftOpen}>
            <div className="panel-heading">
              <button ref={leftCloseRef} className="panel-close panel-close-right" type="button" aria-label="Hide left sidebar" aria-controls="workspace-sidebar" aria-expanded={true} title="Close workspace sidebar" onClick={() => setLeftPanel(false)}><CloseIcon /></button>
              <span className="panel-kicker">PROJECTS</span><h2 id="guide-title">Your projects</h2>
            </div>
            <div className="panel-body">
              <div className="workspace-list-heading">
                <h3 id="projects-title">Projects</h3>
                <button className="text-button" type="button" onClick={() => void refresh()} disabled={projectCreating}>Refresh projects</button>
              </div>
              {lists && (["owned", "shared", "archived"] as const).map((group) => lists[group].items.length > 0 && (
                <section key={group} className="project-section" aria-label={{ owned: "Owned projects", shared: "Shared with me", archived: "Archived projects" }[group]}>
                  <h4>{{ owned: "Owned", shared: "Shared", archived: "Archived" }[group]}</h4>
                  <ul className="project-list">
                    {lists[group].items.map((item) => <li key={item.id}><button className="project-row" type="button" onClick={() => router.push(`/app/projects/${item.id}`)}><strong>{item.name}</strong><span>{group === "owned" ? "Owner" : `${item.ownerName} · ${item.role[0] + item.role.slice(1).toLowerCase()}`}</span></button></li>)}
                  </ul>
                  {lists[group].truncated && <p className="workspace-empty">Showing the first 100.</p>}
                </section>
              ))}
              {lists && !lists.owned.items.length && !lists.shared.items.length && !lists.archived.items.length && <p className="workspace-empty">No projects yet.</p>}
              {lists?.capacity.entitled && <p className="workspace-capacity">{lists.capacity.activeOwned} of {lists.capacity.maxOwned} active projects</p>}
              {lists?.capacity.canCreate && !projectFormOpen && <button className="create-button" type="button" onClick={() => setProjectFormOpen(true)}>Create project</button>}
              {projectFormOpen && (lists?.capacity.canCreate || projectUncertain) && (
                <form className="workspace-form" onSubmit={submitProject}>
                  <label htmlFor="project-name">Project name</label>
                  <input id="project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} disabled={projectCreating || projectUncertain} required autoFocus />
                  <div className="workspace-form-actions">
                    <button className="create-button" type="submit" disabled={projectCreating}>{projectCreating ? "Creating..." : projectUncertain ? "Retry project creation" : "Create project"}</button>
                    <button className="text-button" type="button" onClick={cancelProjectForm} disabled={projectCreating}>Cancel</button>
                  </div>
                </form>
              )}
              {lists && !lists.capacity.entitled && <p className="workspace-empty">Creating projects isn&apos;t enabled for this account.</p>}
              {lists?.capacity.entitled && !lists.capacity.canCreate && <p className="workspace-empty">You&apos;ve reached your active project limit.</p>}
              <p className="workspace-message" role="status" aria-live="polite">{message || projectMessage}</p>
            </div>
            <div className="panel-foot">Projects you own or were invited to.</div>
          </aside>

          <aside id="workspace-context" className="workspace-context" aria-labelledby="context-title" hidden={!rightOpen}>
            <div className="panel-heading">
              <button ref={rightCloseRef} className="panel-close panel-close-left" type="button" aria-label="Hide right sidebar" aria-controls="workspace-context" aria-expanded={true} title="Close project context" onClick={() => setRightPanel(false)}><CloseIcon /></button>
              <span className="panel-kicker">CONTEXT</span>
              <h2 id="context-title">Project details</h2>
            </div>
            <div className="context-body">
              {project ? <>
                <div className="context-icon" aria-hidden="true">&#9633;</div>
                <h3>{project.project.name}</h3>
                <p>{project.project.status === "ARCHIVED" ? "This project is archived and remains available for reading." : "This project has an empty draft ready for a later editing stage."}</p>
                <dl className="context-facts">
                  <div><dt>Role</dt><dd>{project.project.role[0] + project.project.role.slice(1).toLowerCase()}</dd></div>
                  <div><dt>Draft</dt><dd>Empty draft</dd></div>
                  <div><dt>Revision</dt><dd>{project.draft.documentRevision}</dd></div>
                </dl>
                {project.project.status === "ACTIVE" && <ProjectShare key={`share-${project.project.id}`} projectId={project.project.id} role={project.project.role} />}
                <ProjectManagement key={`management-${project.project.id}`} projectId={project.project.id} role={project.project.role} projectName={project.project.name} projectStatus={project.project.status as "ACTIVE" | "ARCHIVED"} onProjectChange={(next) => setProject((current) => current && current.project.id === project.project.id ? { ...current, project: { ...current.project, ...next } } : current)} />
              </> : <>
                <div className="context-icon" aria-hidden="true">&#9633;</div>
                <h3>{projectUnavailable ? "Project details are unavailable." : "No project is connected yet."}</h3>
                <p>{projectUnavailable ? "Choose an available project from the list." : "Project details, selected items, and review context will appear here as those features are added."}</p>
                <dl className="context-facts">
                  <div><dt>Canvas</dt><dd>Empty</dd></div>
                  <div><dt>Project</dt><dd>Not connected</dd></div>
                  <div><dt>Storage</dt><dd>Not enabled</dd></div>
                </dl>
              </>}
            </div>
          </aside>
        </main>
      </div>
    </>
  );
}
