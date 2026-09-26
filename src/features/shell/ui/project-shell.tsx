"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiRead, type ApiResult } from "@/client/api";
import type { MyInvitation } from "@/features/projects/contracts/invitation";
import type { CreatedProject, ProjectBootstrap, ProjectLists } from "@/features/projects/contracts/project";
import { expiryLabel } from "@/features/projects/ui/format";
import ProjectDetails from "@/features/projects/ui/project-details";
import { resolveDock } from "./dock";
import NewProjectDialog from "./new-project-dialog";
import ProjectEditor, { NoProjectOpen, ProjectUnavailable } from "./project-editor";
import { dropProject, setRightOpen, uiFor, type UiStore } from "./project-ui";
import ProjectsSidebar, { LIST_TABS, type InviteRow, type ListTab } from "./projects-sidebar";
import RightPanel from "./right-panel";

type Prefs = { leftOpen: boolean; listTab: ListTab };
type Opened = { projectId: string; bootstrap?: ProjectBootstrap; missing?: boolean; error?: string };
type ShellDialog = { kind: "create" };

const prefsKey = "scoperoom_shell";

/** Presentation preferences only (UI00): nothing about a project is written to browser storage. */
function readPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    const value: unknown = typeof window === "undefined" ? null : JSON.parse(sessionStorage.getItem(prefsKey) ?? "null");
    if (value && typeof value === "object") saved = value as Partial<Prefs>;
  } catch { /* Storage is unavailable or holds something else: use the defaults. */ }
  return { leftOpen: saved.leftOpen !== false, listTab: LIST_TABS.includes(saved.listTab as ListTab) ? saved.listTab as ListTab : "owned" };
}

/** A 401 means the session ended: a full load of sign-in drops every private value held in memory. */
function sessionEnded(result: ApiResult<unknown>) {
  if (result.ok || result.status !== 401) return false;
  window.location.assign("/login");
  return true;
}

export default function ProjectShell({ signOut, children }: { signOut: () => Promise<void>; children: ReactNode }) {
  const router = useRouter();
  const params = useParams();
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
  const shellRef = useRef<HTMLDivElement>(null);
  const focusShowProjects = useRef(false);
  const [width, setWidth] = useState<number | null>(null);
  const [prefs, setPrefs] = useState(readPrefs);
  const [lastOpened, setLastOpened] = useState<"left" | "right" | null>(null);
  const [lists, setLists] = useState<ProjectLists | null>(null);
  const [invites, setInvites] = useState<{ items: InviteRow[]; truncated: boolean } | null>(null);
  const [listsState, setListsState] = useState<"loading" | "ready" | "error">("loading");
  const [opened, setOpened] = useState<Opened | null>(null);
  const [store, setStore] = useState<UiStore>({});
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ShellDialog | null>(null);
  const [notice, setNotice] = useState({ text: "", error: false });
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);

  useEffect(() => {
    const element = shellRef.current;
    if (!element) return;
    // The observer's first callback reports the initial size; panels render only after a real measurement.
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem(prefsKey, JSON.stringify(prefs)); } catch { /* Preferences are optional. */ }
  }, [prefs]);

  const loadLists = useCallback(async () => {
    const [projects, mine] = await Promise.all([apiRead<ProjectLists>("/api/projects"), apiRead<{ items: MyInvitation[]; truncated: boolean }>("/api/invitations")]);
    if (sessionEnded(projects) || sessionEnded(mine)) return;
    if (!projects.ok || !mine.ok) { setListsState("error"); return; }
    const now = Date.now();
    setLists(projects.data);
    setInvites({ items: mine.data.items.map((invite) => ({ ...invite, expiry: expiryLabel(invite.expiresAt, now) })), truncated: mine.data.truncated });
    setListsState("ready");
  }, []);

  const loadProject = useCallback(async (id: string, signal?: AbortSignal) => {
    const result = await apiRead<ProjectBootstrap>(`/api/projects/${id}/bootstrap`, signal);
    if (signal?.aborted || sessionEnded(result)) return;
    if (result.ok) setOpened({ projectId: id, bootstrap: result.data });
    else if (result.status === 404) { setOpened({ projectId: id, missing: true }); setStore((previous) => dropProject(previous, id)); }
    else setOpened({ projectId: id, error: result.message });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadLists(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadLists]);
  useEffect(() => {
    if (!projectId) return;
    // Aborting cancels only this UI observation; responses are also matched to their project below.
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void loadProject(projectId, controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [projectId, loadProject]);

  const ui = uiFor(store, projectId);
  const dock = resolveDock(width ?? 0, { leftOpen: prefs.leftOpen, rightOpen: Boolean(projectId) && ui.rightOpen, lastOpened });
  const current = projectId && opened?.projectId === projectId ? opened : null;
  const bootstrap = current?.bootstrap;
  const capacity = lists?.capacity ?? null;
  const sidebarClosed = dock.left === "closed";

  useEffect(() => {
    // Hiding the sidebar removes its Hide button, so hand focus to the visible "Show projects" control.
    if (!focusShowProjects.current || !sidebarClosed) return;
    focusShowProjects.current = false;
    [...document.querySelectorAll<HTMLElement>('[aria-label="Show projects"]')].find((element) => element.getClientRects().length)?.focus();
  });

  function showProjects(listTab?: ListTab) {
    setPrefs((previous) => ({ leftOpen: true, listTab: listTab ?? previous.listTab }));
    setLastOpened("left");
  }
  function hideProjects() {
    focusShowProjects.current = true;
    setPrefs((previous) => ({ ...previous, leftOpen: false }));
  }
  function setPanel(open: boolean) {
    if (!projectId) return;
    setStore((previous) => setRightOpen(previous, projectId, open));
    if (open) setLastOpened("right");
    else requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-controls="right-panel"]')?.focus());
  }
  function navigate(id: string | null) {
    if (dock.left === "overlay") setPrefs((previous) => ({ ...previous, leftOpen: false }));
    if (projectId && dock.right === "overlay") setStore((previous) => setRightOpen(previous, projectId, false));
    setFocusTarget(id);
    router.push(id ? `/app/projects/${id}` : "/app");
  }
  function openProject(id: string) {
    if (id !== projectId) navigate(id);
  }
  async function created(project: CreatedProject) {
    setDialog(null);
    notify(`Created ${project.name}.`);
    await loadLists();
    navigate(project.id);
  }
  function projectChanged() {
    if (projectId) void loadProject(projectId);
    void loadLists();
  }

  const editor = !projectId
    ? <NoProjectOpen sidebarClosed={sidebarClosed} capacity={capacity} hasInvites={Boolean(invites?.items.length)} onShowProjects={() => showProjects()} onCreate={() => setDialog({ kind: "create" })} onViewInvites={() => showProjects("invites")} />
    : !current ? <div className="empty-state" aria-busy="true"><p>Loading project…</p></div>
    : bootstrap ? <ProjectEditor key={projectId} bootstrap={bootstrap} autoFocus={focusTarget === projectId} sidebarClosed={sidebarClosed} onShowProjects={() => showProjects()}
        panelOpen={dock.right !== "closed"} onTogglePanel={() => setPanel(dock.right === "closed")} />
    : <ProjectUnavailable missing={Boolean(current.missing)} message={current.error ?? ""} sidebarClosed={sidebarClosed} onShowProjects={() => showProjects()} onRetry={() => void loadProject(projectId)} />;

  const panel = projectId && bootstrap && ui.rightMounted
    ? <RightPanel key={projectId} mode={dock.right} onClose={() => setPanel(false)}><ProjectDetails bootstrap={bootstrap} onChanged={projectChanged} /></RightPanel>
    : null;

  return <div className="app-shell" ref={shellRef}>
    <a className="skip-link" href="#editor-main">Skip to editor</a>
    <div className="app-main">
      {width !== null && <>
        {dock.left === "overlay" && <div className="panel-scrim" aria-hidden="true" onClick={hideProjects} />}
        {dock.right === "overlay" && <div className="panel-scrim" aria-hidden="true" onClick={() => setPanel(false)} />}
        <div className="sidebar-slot" data-mode={dock.left}>
          <ProjectsSidebar lists={lists} invites={invites} state={listsState} onRetry={() => { setListsState("loading"); void loadLists(); }}
            tab={prefs.listTab} onTabChange={(listTab) => setPrefs((previous) => ({ ...previous, listTab }))} openProjectId={projectId} onOpenProject={openProject}
            hidden={sidebarClosed} overlay={dock.left === "overlay"} onHide={hideProjects} onNewProject={() => setDialog({ kind: "create" })} />
        </div>
        <main id="editor-main" tabIndex={-1} className="editor-slot" style={{ width: dock.editor }}>{editor}</main>
        {panel}
      </>}
    </div>
    <footer className="app-footer">
      <span className={notice.error ? "footer-error" : undefined} role={notice.error ? "alert" : "status"} aria-live="polite">{notice.text}</span>
      <form action={signOut}><button type="submit">Sign out</button></form>
    </footer>
    {children}
    {dialog?.kind === "create" && <NewProjectDialog onClose={() => setDialog(null)} onCreated={(project) => void created(project)} onRefused={() => void loadLists()} />}
  </div>;
}
