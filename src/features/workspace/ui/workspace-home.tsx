"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import { useRouter } from "next/navigation";
import { rememberPanel, restorePanel } from "./panel-preferences";

type Workspace = { id: string; name: string; createdAt: string };
type WorkspaceHome = { displayName: string; canCreate: boolean; maxWorkspaces: number; ownedCount: number; workspaces: Workspace[] };
type ProjectSummary = { id: string; name: string; status: string; currentDraftId: string; createdAt: string };
type ProjectList = { workspace: { id: string; name: string; canCreateProject: boolean }; projects: ProjectSummary[] };
type ProjectBootstrap = { project: { id: string; workspaceId: string; name: string; status: string; role: "OWNER" }; draft: { id: string; schemaVersion: 3; documentRevision: number; layoutRevision: number } };
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
  const [home, setHome] = useState<WorkspaceHome | null>(null);
  const [message, setMessage] = useState("Loading workspaces...");
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [creating, setCreating] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [projectList, setProjectList] = useState<ProjectList | null>(null);
  const [projectMessage, setProjectMessage] = useState("");
  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [projectWorkspaceId, setProjectWorkspaceId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [projectCreating, setProjectCreating] = useState(false);
  const [projectUncertain, setProjectUncertain] = useState(false);
  const [project, setProject] = useState<ProjectBootstrap | null>(null);
  const [projectUnavailable, setProjectUnavailable] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [panelsReady, setPanelsReady] = useState(false);
  const selectedWorkspaceIdRef = useRef<string | null>(null);
  const leftCloseRef = useRef<HTMLButtonElement>(null);
  const leftShowRef = useRef<HTMLButtonElement>(null);
  const rightCloseRef = useRef<HTMLButtonElement>(null);
  const rightShowRef = useRef<HTMLButtonElement>(null);
  const leftWasOpen = useRef(true);
  const rightWasOpen = useRef(true);
  const setLeftPanel = (open: boolean) => { rememberPanel("left", open); setLeftOpen(open); };
  const setRightPanel = (open: boolean) => { rememberPanel("right", open); setRightOpen(open); };
  const setCurrentWorkspace = (workspaceId: string | null) => {
    selectedWorkspaceIdRef.current = workspaceId;
    setSelectedWorkspaceId(workspaceId);
    setProjectList(null);
    setProjectMessage("");
  };
  const selectWorkspace = (workspaceId: string) => {
    if (projectUncertain || selectedWorkspaceIdRef.current === workspaceId) return;
    setCurrentWorkspace(workspaceId);
    setProjectFormOpen(false);
    setProjectWorkspaceId(null);
  };
  const cancelProjectForm = () => {
    setProjectFormOpen(false);
    setProjectUncertain(false);
    setProjectKey("");
    setProjectWorkspaceId(null);
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
      const result = await fetch("/api/workspaces", { cache: "no-store" });
      if (!result.ok) {
        const problem = await errorMessage(result, "Workspace access is unavailable.");
        if (result.status === 401 || result.status === 403) { setFormOpen(false); setName(""); setKey(""); setUncertain(false); }
        throw new Error(problem);
      }
      const nextHome = await result.json() as WorkspaceHome;
      const currentWorkspaceId = selectedWorkspaceIdRef.current;
      const nextWorkspaceId = currentWorkspaceId && nextHome.workspaces.some((workspace) => workspace.id === currentWorkspaceId)
        ? currentWorkspaceId
        : nextHome.workspaces[0]?.id ?? null;
      setHome(nextHome);
      if (nextWorkspaceId !== currentWorkspaceId) setCurrentWorkspace(nextWorkspaceId);
      if (clearMessage) setMessage("");
      return true;
    } catch (error) {
      setHome(null); setProjectList(null); setProject(null); setProjectUnavailable(Boolean(projectId));
      setMessage(error instanceof Error ? error.message : "Workspace access is unavailable.");
      return false;
    }
  }, [projectId]);

  const refreshProjects = useCallback(async (workspaceId: string) => {
    const selected = () => selectedWorkspaceIdRef.current === workspaceId;
    try {
      const result = await fetch(`/api/workspaces/${workspaceId}/projects`, { cache: "no-store" });
      if (!result.ok) {
        const problem = await errorMessage(result, "Project access is unavailable.");
        if (selected()) {
          setProjectList(null);
          setProjectMessage(problem);
          if (result.status === 401 || result.status === 403) { setProject(null); setProjectUnavailable(Boolean(projectId)); }
        }
        return false;
      }
      const nextList = await result.json() as ProjectList;
      if (!selected()) return false;
      setProjectList(nextList);
      setProjectMessage("");
      return true;
    } catch (error) {
      if (selected()) {
        setProjectList(null);
        setProjectMessage(error instanceof Error ? error.message : "Project access is unavailable.");
      }
      return false;
    }
  }, [projectId]);

  const refreshBootstrap = useCallback(async (id: string) => {
    try {
      const result = await fetch(`/api/projects/${id}/bootstrap`, { cache: "no-store" });
      if (!result.ok) throw new Error("Project details are unavailable.");
      const nextProject = await result.json() as ProjectBootstrap;
      setProject(nextProject); setProjectUnavailable(false); setCurrentWorkspace(nextProject.project.workspaceId); setProjectMessage(""); return true;
    } catch {
      setProject(null); setProjectUnavailable(true); setProjectMessage("Project details are unavailable."); return false;
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => { void refresh(); }, 0); return () => window.clearTimeout(timer); }, [refresh]);
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    const timer = window.setTimeout(() => { void refreshProjects(selectedWorkspaceId); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshProjects, selectedWorkspaceId]);
  useEffect(() => {
    const timer = window.setTimeout(() => { if (projectId) void refreshBootstrap(projectId); else setProject(null); }, 0);
    return () => window.clearTimeout(timer);
  }, [projectId, refreshBootstrap]);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault(); const requestKey = key || crypto.randomUUID();
    setKey(requestKey); setCreating(true); setUncertain(false);
    try {
      const result = await fetch("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey }, body: JSON.stringify({ name }) });
      if (!result.ok) { setMessage(await errorMessage(result, "Workspace access is unavailable.")); setUncertain(result.status >= 500); if (result.status < 500) setKey(""); return; }
      const created = await result.json() as { replayed: boolean };
      setName(""); setKey(""); setFormOpen(false);
      const refreshed = await refresh(false); const confirmation = created.replayed ? "Workspace already created." : "Workspace created.";
      setMessage((current) => refreshed ? confirmation : `${confirmation} ${current}`);
    } catch { setMessage("We could not confirm workspace creation. Your name is ready to retry."); setUncertain(true); } finally { setCreating(false); }
  };

  const submitProject = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetWorkspaceId = projectWorkspaceId ?? selectedWorkspaceId;
    if (!targetWorkspaceId) return;
    setProjectWorkspaceId(targetWorkspaceId);
    const requestKey = projectKey || crypto.randomUUID();
    setProjectKey(requestKey); setProjectCreating(true); setProjectUncertain(false);
    try {
      const result = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey }, body: JSON.stringify({ workspaceId: targetWorkspaceId, name: projectName }) });
      if (!result.ok) { setProjectMessage(await errorMessage(result, "Project creation is unavailable.")); setProjectUncertain(result.status >= 500); if (result.status < 500) setProjectKey(""); return; }
      const created = await result.json() as { id: string };
      router.push(`/app/projects/${created.id}`);
    } catch { setProjectMessage("We could not confirm project creation. Your name is ready to retry."); setProjectUncertain(true); } finally { setProjectCreating(false); }
  };

  const selectedWorkspace = home?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const atLimit = Boolean(home && home.maxWorkspaces > 0 && home.ownedCount >= home.maxWorkspaces);
  const canCreateProject = Boolean(projectList?.workspace.canCreateProject);

  return (
    <>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <div className="workspace-shell">
        <header className="workspace-header">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
            <span>ScopeRoom<span className="brand-suffix"> / Studio</span></span>
          </div>
          <span className="workspace-title">{project?.project.name ?? "Blank workspace"}</span>
          <span className="preview-label">UI preview</span>
          <form action={signOut}><button className="signout-button" type="submit">Sign out</button></form>
        </header>

        <main id="main-content" tabIndex={-1} className="workspace-main" data-panels-ready={panelsReady} data-left-open={leftOpen} data-right-open={rightOpen}>
          <section className="canvas-column" aria-label="Canvas">
            <div className="canvas-toolbar">
              <div className="canvas-toolbar-start">
                {!leftOpen && <button ref={leftShowRef} className="panel-toggle" type="button" aria-label="Show left sidebar" aria-controls="workspace-sidebar" aria-expanded={false} title="Show workspace sidebar" onClick={() => setLeftPanel(true)}><PanelIcon side="left" /></button>}
                <div className="canvas-breadcrumb">
                  <span>{selectedWorkspace?.name ?? "Workspace"}</span>
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
                <p className="empty-help">Flow editing and saving arrive in a later stage. For now, this is your workspace foundation.</p>
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
              <span className="panel-kicker">WORKSPACE</span>
              <h2 id="guide-title">Your starting point</h2>
            </div>
            <div className="panel-body">
              <div className="workspace-list-heading">
                <h3>Workspaces</h3>
                <button className="text-button" type="button" onClick={() => void refresh()} disabled={creating}>Refresh workspaces</button>
              </div>
              <p className="workspace-greeting">Your available workspaces appear here.</p>
              {home?.workspaces.length ? (
                <ul className="workspace-list" aria-label="Your workspaces">
                  {home.workspaces.map((workspace) => <li key={workspace.id}><button className="workspace-row" type="button" aria-pressed={workspace.id === selectedWorkspaceId} onClick={() => selectWorkspace(workspace.id)} disabled={projectUncertain}>{workspace.name}</button></li>)}
                </ul>
              ) : home && <p className="workspace-empty">No workspaces yet.</p>}
              {home && <p className="workspace-capacity">{home.ownedCount} of {home.maxWorkspaces} owned workspaces</p>}
              {home?.canCreate && !formOpen && <button className="create-button" type="button" onClick={() => setFormOpen(true)}>Create workspace</button>}
              {home && formOpen && (home.canCreate || uncertain) && (
                <form className="workspace-form" onSubmit={submit}>
                  <label htmlFor="workspace-name">Workspace name</label>
                  <input id="workspace-name" value={name} onChange={(event) => setName(event.target.value)} disabled={creating || uncertain} required autoFocus />
                  <div className="workspace-form-actions">
                    <button className="create-button" type="submit" disabled={creating}>{creating ? "Creating..." : uncertain ? "Retry workspace creation" : "Create workspace"}</button>
                    <button className="text-button" type="button" onClick={() => setFormOpen(false)} disabled={creating}>Cancel</button>
                  </div>
                </form>
              )}
              {home && !home.canCreate && !atLimit && <p className="workspace-empty">Workspace creation is not available for this account.</p>}
              {atLimit && <p className="workspace-empty">Your workspace limit has been reached.</p>}
              <p className="workspace-message" role="status" aria-live="polite">{message}</p>

              {selectedWorkspace && (
                <section className="project-section" aria-labelledby="projects-title">
                  <div className="workspace-list-heading">
                    <h3 id="projects-title">Projects</h3>
                    <button className="text-button" type="button" onClick={() => void refreshProjects(selectedWorkspace.id)} disabled={projectCreating}>Refresh projects</button>
                  </div>
                  {projectList?.projects.length ? (
                    <ul className="project-list" aria-label={`${projectList.workspace.name} projects`}>
                      {projectList.projects.map((item) => <li key={item.id}><button className="project-row" type="button" onClick={() => router.push(`/app/projects/${item.id}`)}><strong>{item.name}</strong><span>{item.status === "ACTIVE" ? "Empty draft" : item.status}</span></button></li>)}
                    </ul>
                  ) : projectList && <p className="workspace-empty">No projects yet.</p>}
                  {canCreateProject && !projectFormOpen && <button className="create-button" type="button" onClick={() => { setProjectWorkspaceId(selectedWorkspace.id); setProjectFormOpen(true); }}>Create project</button>}
                  {projectFormOpen && (canCreateProject || projectUncertain) && (
                    <form className="workspace-form" onSubmit={submitProject}>
                      <label htmlFor="project-name">Project name</label>
                      <input id="project-name" value={projectName} onChange={(event) => setProjectName(event.target.value)} disabled={projectCreating || projectUncertain} required autoFocus />
                      <div className="workspace-form-actions">
                        <button className="create-button" type="submit" disabled={projectCreating}>{projectCreating ? "Creating..." : projectUncertain ? "Retry project creation" : "Create project"}</button>
                        <button className="text-button" type="button" onClick={cancelProjectForm} disabled={projectCreating}>Cancel</button>
                      </div>
                    </form>
                  )}
                  {projectMessage && <p className="workspace-message" role="status" aria-live="polite">{projectMessage}</p>}
                </section>
              )}
            </div>
            <div className="panel-foot">This workspace is a blank starting point.</div>
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
                <p>This project has an empty draft ready for a later editing stage.</p>
                <dl className="context-facts">
                  <div><dt>Role</dt><dd>Owner</dd></div>
                  <div><dt>Draft</dt><dd>Empty draft</dd></div>
                  <div><dt>Revision</dt><dd>{project.draft.documentRevision}</dd></div>
                </dl>
              </> : <>
                <div className="context-icon" aria-hidden="true">&#9633;</div>
                <h3>{projectUnavailable ? "Project details are unavailable." : "No project is connected yet."}</h3>
                <p>{projectUnavailable ? "Return to a workspace to open an available project." : "Project details, selected items, and review context will appear here as those features are added."}</p>
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