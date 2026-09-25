"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent, SubmitEvent } from "react";
import { usePathname } from "next/navigation";
import { rememberPanel, rememberPanelWidth, restorePanel, restorePanelWidth } from "./panel-preferences";
import ProjectShare from "@/features/projects/ui/project-share";
import ProjectManagement from "@/features/projects/ui/project-management";

type Workspace = { id: string; name: string; createdAt: string; status: "ACTIVE" | "ARCHIVED"; version: number; canManage: boolean };
type WorkspaceHome = { displayName: string; canCreate: boolean; maxWorkspaces: number; ownedCount: number; workspaces: Workspace[] };
type ProjectSummary = { id: string; name: string; status: string; currentDraftId: string; createdAt: string };
type ProjectList = { workspace: { id: string; name: string; canCreateProject: boolean }; projects: ProjectSummary[] };
type ProjectBootstrap = { project: { id: string; workspaceId: string; name: string; status: string; role: "OWNER" | "EDITOR" | "REVIEWER" | "VIEWER" }; draft: { id: string; schemaVersion: 3; documentRevision: number; layoutRevision: number } };
type ApiError = { error?: { code?: string; message?: string } };

async function errorMessage(response: Response, fallback: string) {
  try { return (await response.json() as ApiError).error?.message || fallback; } catch { return fallback; }
}

function PanelIcon({ side }: { side: "left" | "right" }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d={side === "left" ? "M8 3v18" : "M16 3v18"} /></svg>;
}
function CloseIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>; }
function RefreshIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.8-4L3 10" /><path d="M3 4v6h6" /><path d="M4 13a8 8 0 0 0 14.8 4L21 14" /><path d="M21 20v-6h-6" /></svg>; }

const panelLimits = { left: [260, 420], right: [280, 440] } as const;
function panelWidth(side: "left" | "right", value: number, other: number, otherOpen: boolean) {
  const [minimum, maximum] = panelLimits[side];
  return Math.round(Math.min(maximum, Math.max(minimum, Math.min(window.innerWidth - 488 - (otherOpen ? other + 8 : 0), value))));
}

export default function WorkspaceHome({ signOut, projectId }: { signOut: () => Promise<void>; projectId?: string }) {
  const pathname = usePathname();
  const routeProjectId = /^\/app\/projects\/([^/]+)$/.exec(pathname ?? "")?.[1] ?? projectId;
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
  const [workspaceBusy, setWorkspaceBusy] = useState<string | null>(null);
  const [workspaceRetry, setWorkspaceRetry] = useState<{ workspace: Workspace; action: "archive" | "restore"; key: string } | null>(null);
  const [workspaceConfirm, setWorkspaceConfirm] = useState<Workspace | null>(null);
  const [quotaDialogOpen, setQuotaDialogOpen] = useState(false);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [panelsReady, setPanelsReady] = useState(false);
  const [contextTab, setContextTab] = useState<"details" | "share">("details");
  const selectedWorkspaceIdRef = useRef<string | null>(null);
  const activeProjectRoute = useRef(projectId);
  const leftCloseRef = useRef<HTMLButtonElement>(null);
  const leftShowRef = useRef<HTMLButtonElement>(null);
  const quotaDialogRef = useRef<HTMLDialogElement>(null);
  const quotaWorkspaceRef = useRef<string | null>(null);
  const rightCloseRef = useRef<HTMLButtonElement>(null);
  const [leftWidth, setLeftWidth] = useState(270);
  const [rightWidth, setRightWidth] = useState(290);
  const [shareRequest, setShareRequest] = useState<{ projectId: string; token: number } | null>(null);
  const [renameRequest, setRenameRequest] = useState<{ projectId: string; token: number } | null>(null);
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
    setShareRequest(null);
    setRenameRequest(null);
    if (activeProjectRoute.current) {
      activeProjectRoute.current = undefined;
      setProject(null);
      setProjectUnavailable(false);
      window.history.pushState(null, "", "/");
    }
    setProjectFormOpen(false);
    setProjectWorkspaceId(null);
  };
  const cancelProjectForm = () => {
    setProjectFormOpen(false);
    setProjectUncertain(false);
    setProjectKey("");
    setProjectWorkspaceId(null);
  };  const openProject = (id: string) => {
    if (activeProjectRoute.current === id) return;
    activeProjectRoute.current = id;
    setProject(null);
    setProjectUnavailable(false);
    window.history.pushState(null, "", `/app/projects/${id}`);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const left = restorePanel("left"); const right = restorePanel("right");
      const nextLeft = restorePanelWidth("left", 270); const nextRight = restorePanelWidth("right", 290);
      leftWasOpen.current = left; rightWasOpen.current = right;
      setLeftOpen(left); setRightOpen(right); setLeftWidth(panelWidth("left", nextLeft, nextRight, right)); setRightWidth(panelWidth("right", nextRight, nextLeft, left)); setPanelsReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => { if (panelsReady && leftWasOpen.current !== leftOpen) { (leftOpen ? leftCloseRef : leftShowRef).current?.focus(); leftWasOpen.current = leftOpen; } }, [leftOpen, panelsReady]);
  useEffect(() => { if (panelsReady && rightWasOpen.current !== rightOpen) { (rightOpen ? rightCloseRef : rightShowRef).current?.focus(); rightWasOpen.current = rightOpen; } }, [rightOpen, panelsReady]);
  useEffect(() => {
    const dialog = quotaDialogRef.current;
    if (!dialog) return;
    if (quotaDialogOpen && !dialog.open) dialog.showModal();
    if (!quotaDialogOpen && dialog.open) dialog.close();
  }, [quotaDialogOpen]);

  useEffect(() => {
    const clampWidths = () => {
      if (window.innerWidth <= 1050) return;
      setLeftWidth((current) => panelWidth("left", current, rightWidth, rightOpen));
      setRightWidth((current) => panelWidth("right", current, leftWidth, leftOpen));
    };
    window.addEventListener("resize", clampWidths);
    return () => window.removeEventListener("resize", clampWidths);
  }, [leftOpen, leftWidth, rightOpen, rightWidth]);
  const resizePanel = (side: "left" | "right", value: number) => {
    if (window.innerWidth <= 1050) return;
    if (side === "left") setLeftWidth(() => { const next = panelWidth(side, value, rightWidth, rightOpen); rememberPanelWidth(side, next); return next; });
    else setRightWidth(() => { const next = panelWidth(side, value, leftWidth, leftOpen); rememberPanelWidth(side, next); return next; });
  };
  const resizeWithPointer = (side: "left" | "right", event: PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 1050) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizePanel(side, side === "left" ? event.clientX : window.innerWidth - event.clientX);
  };
  const resizeWithKey = (side: "left" | "right", key: string) => {
    const current = side === "left" ? leftWidth : rightWidth; const [minimum, maximum] = panelLimits[side];
    if (key === "Home") resizePanel(side, minimum); else if (key === "End") resizePanel(side, maximum); else if (key === "ArrowLeft") resizePanel(side, current + (side === "left" ? -16 : 16)); else if (key === "ArrowRight") resizePanel(side, current + (side === "left" ? 16 : -16));
  };

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
      if (activeProjectRoute.current !== id) return false;
      setProject(nextProject); setProjectUnavailable(false); setCurrentWorkspace(nextProject.project.workspaceId); setProjectMessage(""); return true;
    } catch {
      if (activeProjectRoute.current !== id) return false;
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
    activeProjectRoute.current = routeProjectId;
    const timer = window.setTimeout(() => {
      setShareRequest(null); setRenameRequest(null);
      if (routeProjectId) void refreshBootstrap(routeProjectId); else { setProject(null); setProjectUnavailable(false); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshBootstrap, routeProjectId]);
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
      setProjectName(""); setProjectKey(""); setProjectFormOpen(false); setProjectWorkspaceId(null);
      openProject(created.id);
    } catch { setProjectMessage("We could not confirm project creation. Your name is ready to retry."); setProjectUncertain(true); } finally { setProjectCreating(false); }
  };

  const transitionWorkspace = async (workspace: Workspace, action: "archive" | "restore", requestKey = crypto.randomUUID()) => {
    setWorkspaceBusy(workspace.id);
    setWorkspaceRetry(null);
    try {
      const result = await fetch(`/api/workspaces/${workspace.id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey }, body: JSON.stringify({ expectedVersion: workspace.version }) });
      if (!result.ok) {
        let problem: ApiError = {};
        try { problem = await result.json() as ApiError; } catch { /* Use the lifecycle fallback below. */ }
        const problemMessage = problem.error?.message || "Workspace changes are unavailable.";
        if (action === "restore" && result.status === 409 && problem.error?.code === "LIMIT_REACHED") {
          quotaWorkspaceRef.current = workspace.id;
          const refreshed = await refresh(false);
          if (refreshed) { setMessage(""); setQuotaDialogOpen(true); }
          else setMessage((current) => current ? `${problemMessage} ${current}` : problemMessage);
          return;
        }
        setMessage(problemMessage);
        if (result.status >= 500) setWorkspaceRetry({ workspace, action, key: requestKey });
        return;
      }
      const refreshed = await refresh(false);
      const confirmation = action === "archive" ? "Workspace archived." : "Workspace restored.";
      setMessage((current) => refreshed ? confirmation : `${confirmation} ${current}`);
    } catch {
      setWorkspaceRetry({ workspace, action, key: requestKey });
      setMessage("We could not confirm that workspace change. Retry uses the same request.");
    } finally { setWorkspaceBusy(null); }
  };
  const selectedWorkspace = home?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const atLimit = Boolean(home && home.maxWorkspaces > 0 && home.ownedCount >= home.maxWorkspaces);
  const canCreateProject = Boolean(projectList?.workspace.canCreateProject && selectedWorkspace?.status === "ACTIVE");
  const projectWorkspace = home?.workspaces.find((workspace) => workspace.id === project?.project.workspaceId);
  const canEditProject = project?.project.role === "OWNER" && project.project.status === "ACTIVE" && projectWorkspace?.status === "ACTIVE";
  const projectActionReason = project?.project.status === "ARCHIVED" ? "This project is archived, so sharing and renaming are unavailable." : projectWorkspace?.status === "ARCHIVED" ? "This workspace is archived, so sharing and renaming are unavailable until it is restored." : "Only a project owner can share or rename this project.";
  const openProjectAction = (action: "share" | "rename") => { if (!project) return; setRightPanel(true); setContextTab(action === "share" ? "share" : "details"); if (action === "share") setShareRequest((current) => ({ projectId: project.project.id, token: (current?.token ?? 0) + 1 })); else setRenameRequest((current) => ({ projectId: project.project.id, token: (current?.token ?? 0) + 1 })); };

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
          {canEditProject && <button className="header-share-button" type="button" onClick={() => openProjectAction("share")}>Share</button>}
          <form action={signOut}><button className="signout-button" type="submit">Sign out</button></form>
        </header>

        <main id="main-content" tabIndex={-1} className="workspace-main" data-panels-ready={panelsReady} data-left-open={leftOpen} data-right-open={rightOpen} style={{ "--left-panel-width": `${leftWidth}px`, "--right-panel-width": `${rightWidth}px` } as CSSProperties}>
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
                {!rightOpen && canEditProject && <div className="canvas-toolbar-actions"><button className="context-action" type="button" onClick={() => openProjectAction("share")}>Share project</button><button className="context-action" type="button" onClick={() => openProjectAction("rename")}>Rename project</button></div>}
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
                <button className="utility-button icon-button" type="button" aria-label="Refresh workspaces" title="Refresh workspaces" onClick={() => void refresh()} disabled={creating}><RefreshIcon /></button>
              </div>
              <p className="workspace-greeting">Your available workspaces appear here.</p>
              {home?.workspaces.length ? (
                <ul className="workspace-list" aria-label="Your workspaces">
                  {home.workspaces.map((workspace) => <li key={workspace.id}><div className="workspace-row-wrap"><button className="workspace-row" type="button" aria-pressed={workspace.id === selectedWorkspaceId} onClick={() => selectWorkspace(workspace.id)} disabled={projectUncertain}><span title={workspace.name}>{workspace.name}</span>{workspace.status === "ARCHIVED" && <span className="lifecycle-badge lifecycle-archived">Archived</span>}</button>{workspace.canManage && <div className="workspace-actions"><button className="utility-button workspace-lifecycle" type="button" aria-label={`${workspace.status === "ARCHIVED" ? "Restore" : "Archive"} workspace ${workspace.name}`} data-workspace-id={workspace.id} disabled={workspaceBusy === workspace.id || workspaceRetry?.workspace.id === workspace.id} onClick={() => workspace.status === "ARCHIVED" ? void transitionWorkspace(workspace, "restore") : setWorkspaceConfirm(workspace)}>{workspaceBusy === workspace.id ? "Saving..." : workspace.status === "ARCHIVED" ? "Restore workspace" : "Archive workspace"}</button></div>}</div></li>)}
                </ul>
              ) : home && <p className="workspace-empty">No workspaces yet.</p>}
              {workspaceConfirm && <div className="workspace-confirm"><p>Archiving this workspace frees a workspace place and makes its projects read-only.</p><button className="text-button" type="button" onClick={() => { const target = workspaceConfirm; setWorkspaceConfirm(null); void transitionWorkspace(target, "archive"); }} disabled={workspaceBusy === workspaceConfirm.id}>Confirm archive workspace</button><button className="text-button" type="button" onClick={() => setWorkspaceConfirm(null)} disabled={workspaceBusy === workspaceConfirm.id}>Cancel</button></div>}
              {home && <p className="workspace-capacity">{home.ownedCount} of {home.maxWorkspaces} workspace {home.maxWorkspaces === 1 ? "place" : "places"} used</p>}
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
              {workspaceRetry && <button className="text-button" type="button" onClick={() => void transitionWorkspace(workspaceRetry.workspace, workspaceRetry.action, workspaceRetry.key)} disabled={workspaceBusy === workspaceRetry.workspace.id}>Retry workspace change</button>}

              {selectedWorkspace && (
                <section className="project-section" aria-labelledby="projects-title">
                  <div className="workspace-list-heading">
                    <h3 id="projects-title">Projects</h3>
                    <button className="utility-button icon-button" type="button" aria-label="Refresh projects" title="Refresh projects" onClick={() => void refreshProjects(selectedWorkspace.id)} disabled={projectCreating}><RefreshIcon /></button>
                  </div>
                  {projectList?.projects.length ? (
                    <ul className="project-list" aria-label={`${projectList.workspace.name} projects`}>
                      {projectList.projects.map((item) => <li key={item.id}><button className="project-row" type="button" onClick={() => openProject(item.id)}><strong>{item.name}</strong><span>{item.status === "ACTIVE" ? "Empty draft" : item.status}</span></button></li>)}
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
          <div className="panel-resize panel-resize-right" role="separator" aria-label="Resize project details sidebar" aria-controls="workspace-context" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={440} aria-valuenow={rightWidth} tabIndex={0} hidden={!rightOpen} onPointerDown={(event) => resizeWithPointer("right", event)} onPointerMove={(event) => event.currentTarget.hasPointerCapture(event.pointerId) && resizeWithPointer("right", event)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); resizeWithKey("right", event.key); } }} />
          <div className="panel-resize panel-resize-left" role="separator" aria-label="Resize workspace sidebar" aria-controls="workspace-sidebar" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={420} aria-valuenow={leftWidth} tabIndex={0} hidden={!leftOpen} onPointerDown={(event) => resizeWithPointer("left", event)} onPointerMove={(event) => event.currentTarget.hasPointerCapture(event.pointerId) && resizeWithPointer("left", event)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); resizeWithKey("left", event.key); } }} />

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
                <div className="context-tabs" role="tablist" aria-label="Project context">
                  <button id="project-details-tab" className="context-tab" role="tab" type="button" aria-selected={contextTab === "details"} aria-controls="project-details-panel" tabIndex={contextTab === "details" ? 0 : -1} onClick={() => setContextTab("details")} onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); setContextTab("share"); } }}>Details</button>
                  <button id="project-share-tab" className="context-tab" role="tab" type="button" aria-selected={contextTab === "share"} aria-controls="project-share-panel" tabIndex={contextTab === "share" ? 0 : -1} onClick={() => setContextTab("share")} onKeyDown={(event) => { if (event.key === "ArrowLeft") { event.preventDefault(); setContextTab("details"); } }}>Share</button>
                </div>
                <div id="project-details-panel" role="tabpanel" aria-labelledby="project-details-tab" hidden={contextTab !== "details"}>
                  <ProjectManagement key={`management-${project.project.id}`} embedded projectId={project.project.id} role={project.project.role} projectName={project.project.name} projectStatus={project.project.status as "ACTIVE" | "ARCHIVED"} workspaceArchived={projectWorkspace?.status === "ARCHIVED"} openRequest={renameRequest?.projectId === project.project.id ? renameRequest.token : 0} onProjectChange={(next) => { setProject((current) => current && current.project.id === project.project.id ? { ...current, project: { ...current.project, ...next } } : current); if (next.name) setProjectList((current) => current ? { ...current, projects: current.projects.map((item) => item.id === project.project.id ? { ...item, name: next.name! } : item) } : current); }} />
                </div>
                <div id="project-share-panel" role="tabpanel" aria-labelledby="project-share-tab" hidden={contextTab !== "share"}>
                  {project.project.status === "ACTIVE" && projectWorkspace?.status === "ACTIVE" ? <ProjectShare key={`share-${project.project.id}`} embedded projectId={project.project.id} role={project.project.role} openRequest={shareRequest?.projectId === project.project.id ? shareRequest.token : 0} showTrigger={false} /> : <p className="context-action-note">{projectActionReason}</p>}
                </div>
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
      <dialog ref={quotaDialogRef} className="workspace-limit-dialog" aria-labelledby="workspace-limit-title" onCancel={() => { const id = quotaWorkspaceRef.current; if (id) window.setTimeout(() => document.querySelector<HTMLButtonElement>(`[data-workspace-id="${id}"]`)?.focus(), 0); }} onClose={() => { setQuotaDialogOpen(false); const id = quotaWorkspaceRef.current; if (id) window.setTimeout(() => document.querySelector<HTMLButtonElement>(`[data-workspace-id="${id}"]`)?.focus(), 0); }}>
        <h2 id="workspace-limit-title">Workspace limit reached</h2>
        <p>Archive or restore one of your active workspaces before trying again.</p>
        <form method="dialog"><button className="context-action" type="submit">Close</button></form>
      </dialog>
    </>
  );
}
