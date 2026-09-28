"use client";

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { flushSync } from "react-dom";
import { apiRead, sessionEnded } from "@/client/api";
import type { DraftView } from "@/features/drafts/contracts/scope-document";
import type { MyInvitation } from "@/features/projects/contracts/invitation";
import type { CreatedProject, ProjectBootstrap, ProjectLists } from "@/features/projects/contracts/project";
import { expiryLabel } from "@/features/projects/ui/format";
import ProjectDetails from "@/features/projects/ui/project-details";
import Inspector from "@/features/studio/ui/inspector";
import { StudioProvider } from "@/features/studio/ui/studio-context";
import { afterDraftRead, isNewer, type StudioUi } from "@/features/studio/ui/studio-ui";
import Dialog, { CancelFocus } from "./dialog";
import { resolveDock } from "./dock";
import LifecycleDialog, { type LifecycleKind } from "./lifecycle-dialog";
import NewProjectDialog from "./new-project-dialog";
import ProjectEditor, { NoProjectOpen, ProjectUnavailable } from "./project-editor";
import { anyDirty, dirtyCount, discardDrafts, dropProject, setDraft, setRightOpen, uiFor, updateUi, type UiStore } from "./project-ui";
import ProjectsSidebar, { LIST_TABS, type InviteRow, type ListTab } from "./projects-sidebar";
import RightPanel from "./right-panel";

type Prefs = { leftOpen: boolean; listTab: ListTab };
type Opened = { projectId: string; bootstrap?: ProjectBootstrap; missing?: boolean; error?: string };
type Target = { id: string; name: string };
type ShellDialog = { kind: "create" } | { kind: "switch"; target: string } | { kind: LifecycleKind; project: Target };

const prefsKey = "scoperoom_shell";
const doneVerb: Record<LifecycleKind, string> = { archive: "Archived", restore: "Restored", leave: "Left" };

/** Presentation preferences only (UI00): nothing about a project is written to browser storage. */
function readPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    const value: unknown = typeof window === "undefined" ? null : JSON.parse(sessionStorage.getItem(prefsKey) ?? "null");
    if (value && typeof value === "object") saved = value as Partial<Prefs>;
  } catch { /* Storage is unavailable or holds something else: use the defaults. */ }
  return { leftOpen: saved.leftOpen !== false, listTab: LIST_TABS.includes(saved.listTab as ListTab) ? saved.listTab as ListTab : "owned" };
}

/** A project re-read that raced a Studio save must not roll the draft back: keep whichever read is newer. */
function keepNewerDraft(bootstrap: ProjectBootstrap, previous: Opened | null): ProjectBootstrap {
  const kept = previous?.projectId === bootstrap.project.id ? previous.bootstrap?.draft : undefined;
  return kept && isNewer(kept, bootstrap.draft) ? { ...bootstrap, draft: kept } : bootstrap;
}

export default function ProjectShell({ signOut, children }: { signOut: () => Promise<void>; children: ReactNode }) {
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const params = useParams();
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
  const shellRef = useRef<HTMLDivElement>(null);
  const focusShowProjects = useRef(false);
  // Tracks the open project outside render so an unsignaled manual reload (Retry, or a Details rename/
  // archive) that resolves after the user has already switched projects cannot clobber the new project's
  // loaded state (constraint: late responses never render in the next project).
  const projectIdRef = useRef(projectId);
  const [width, setWidth] = useState<number | null>(null);
  const [prefs, setPrefs] = useState(readPrefs);
  const [lastOpened, setLastOpened] = useState<"left" | "right" | null>(null);
  const [lists, setLists] = useState<ProjectLists | null>(null);
  const [invites, setInvites] = useState<{ items: InviteRow[]; truncated: boolean } | null>(null);
  const [listsState, setListsState] = useState<"loading" | "ready" | "error">("loading");
  const [opened, setOpened] = useState<Opened | null>(null);
  const [store, setStore] = useState<UiStore>({});
  const savePositionsRef = useRef<(() => Promise<boolean>) | null>(null);
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
    // An unsignaled caller (Retry, projectChanged) can resolve after the user opened a different project.
    if (id !== projectIdRef.current) return;
    if (result.ok) {
      setOpened((previous) => ({ projectId: id, bootstrap: keepNewerDraft(result.data, previous) }));
      setStore((previous) => updateUi(previous, id, (current) => afterDraftRead(current, result.data.draft)));
    }
    else if (result.status === 404) { setOpened({ projectId: id, missing: true }); setStore((previous) => dropProject(previous, id)); }
    else setOpened({ projectId: id, error: result.message });
  }, []);

  // The Studio's saved draft lives with the bootstrap; a read replaces it only when neither revision goes backwards.
  const adoptDraft = useCallback((view: DraftView) => {
    setOpened((previous) => previous?.bootstrap && isNewer(view, previous.bootstrap.draft) ? { ...previous, bootstrap: { ...previous.bootstrap, draft: view } } : previous);
  }, []);
  const updateStudio = useCallback((change: (ui: StudioUi) => Partial<StudioUi>) => {
    if (projectId) setStore((previous) => updateUi(previous, projectId, change));
  }, [projectId]);

  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);
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

  const unsaved = anyDirty(store);
  useEffect(() => {
    // Reload or close with unsaved Details values asks first; nothing unsaved is written to browser storage.
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

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
    setFocusTarget(id ?? ""); // "" focuses the "No project open" heading
    // A pending transition hides the previous project's controls (e.g. Inspect) immediately: the target
    // route re-runs a server auth check (force-dynamic), so useParams only catches up once that resolves.
    startNavigation(() => router.push(id ? `/app/projects/${id}` : "/app"));
  }
  async function openProject(id: string) {
    if (id === projectId) return;
    let remaining = store;
    // Moved steps are saved first. Once all are acknowledged they no longer need resolving (the store has not re-rendered yet).
    if (projectId && Object.keys(ui.unsavedMoves).length && await savePositionsRef.current?.()) {
      remaining = updateUi(store, projectId, () => ({ unsavedMoves: {}, drops: [], attempt: null }));
    }
    // Switching projects resolves unsaved edits first (UI00): Stay, or an explicit Discard, never silent.
    if (dirtyCount(remaining, projectId) > 0) { setDialog({ kind: "switch", target: id }); return; }
    navigate(id);
  }
  async function created(project: CreatedProject) {
    setDialog(null);
    notify(`Created ${project.name}.`);
    await loadLists();
    navigate(project.id);
  }
  async function finishLifecycle(kind: LifecycleKind, target: Target) {
    // Close now, not at the next render, so the dialog has handed focus back before it moves on below.
    flushSync(() => setDialog(null));
    notify(`${doneVerb[kind]} ${target.name}.`);
    const leavingOpen = kind === "leave" && target.id === projectId;
    if (kind === "leave") {
      setStore((previous) => dropProject(previous, target.id));
      if (leavingOpen) navigate(null);
    } else {
      // Archive hides metadata forms. Studio input remains available in its read-only copy/discard recovery.
      if (kind === "archive") setStore((previous) => updateUi(previous, target.id, () => ({ drafts: {} })));
      if (target.id === projectId) void loadProject(target.id);
    }
    // Every lifecycle change removes its opener (the row, "Archive project…", the banner's Restore), so focus a stable
    // place instead of <body>: an open overlay's selected tab, else the editor heading. Leaving the open project
    // focuses "No project open" once it renders.
    if (!leavingOpen) {
      const overlay = document.querySelector<HTMLElement>('[aria-modal="true"]:not([hidden])');
      (overlay ? overlay.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') : document.querySelector<HTMLElement>("#editor-main h1"))?.focus();
    }
    await loadLists();
  }
  function closeDialog(targetId?: string) {
    // A cancelled lifecycle change (e.g. after a CONFLICT) or an uncertain create may still have changed the lists,
    // and the open project's status (drafts are left alone).
    setDialog(null);
    if (targetId && targetId === projectId) void loadProject(targetId);
    void loadLists();
  }
  function projectChanged() {
    if (projectId) void loadProject(projectId);
    void loadLists();
  }

  const restoreNote = capacity && !capacity.canCreate ? (capacity.entitled ? `${capacity.activeOwned}/${capacity.maxOwned} active` : "Restoring isn’t enabled for this account") : undefined;
  const lifecycleDialog = dialog && dialog.kind !== "create" && dialog.kind !== "switch" ? dialog : null;
  const switchTarget = dialog?.kind === "switch" ? dialog.target : null;

  const editor = navigating ? <div className="empty-state" aria-busy="true"><p>Loading project…</p></div>
    : !projectId
    ? <NoProjectOpen autoFocus={focusTarget === ""} sidebarClosed={sidebarClosed} capacity={capacity} hasInvites={Boolean(invites?.items.length)} onShowProjects={() => showProjects()} onCreate={() => setDialog({ kind: "create" })} onViewInvites={() => showProjects("invites")} />
    : !current ? <div className="empty-state" aria-busy="true"><p>Loading project…</p></div>
    : bootstrap ? <ProjectEditor key={projectId} bootstrap={bootstrap} autoFocus={focusTarget === projectId} sidebarClosed={sidebarClosed} onShowProjects={() => showProjects()}
        panelOpen={dock.right !== "closed"} onTogglePanel={() => setPanel(dock.right === "closed")}
        restoreNote={restoreNote} onRestore={() => setDialog({ kind: "restore", project: { id: projectId, name: bootstrap.project.name } })} />
    : <ProjectUnavailable missing={Boolean(current.missing)} message={current.error ?? ""} sidebarClosed={sidebarClosed} onShowProjects={() => showProjects()} onRetry={() => void loadProject(projectId)} />;

  // With a Studio selection the Details tab inspects it; "← Project" clears the selection and returns to project details.
  const panel = projectId && bootstrap && ui.rightMounted
    ? <RightPanel key={projectId} mode={dock.right} onClose={() => setPanel(false)}>
      {ui.selection ? <Inspector onBack={() => { updateStudio(() => ({ selection: null })); requestAnimationFrame(() => document.getElementById("right-tab-details")?.focus()); }} />
        : <ProjectDetails bootstrap={bootstrap} drafts={ui.drafts} setDraft={(key, value) => setStore((previous) => setDraft(previous, projectId, key, value))}
          onChanged={projectChanged} onLifecycle={(kind) => setDialog({ kind, project: { id: projectId, name: bootstrap.project.name } })} />}
    </RightPanel>
    : null;

  const main = <main id="editor-main" tabIndex={-1} className="editor-slot" style={{ width: dock.editor }}>{editor}</main>;

  return <div className="app-shell" ref={shellRef}>
    <a className="skip-link" href="#editor-main">Skip to editor</a>
    <div className="app-main">
      {width !== null && <>
        {dock.left === "overlay" && <div className="panel-scrim" aria-hidden="true" onClick={hideProjects} />}
        {dock.right === "overlay" && <div className="panel-scrim" aria-hidden="true" onClick={() => setPanel(false)} />}
        <div className="sidebar-slot" data-mode={dock.left}>
          <ProjectsSidebar lists={lists} invites={invites} state={listsState} onRetry={() => { setListsState("loading"); void loadLists(); }}
            tab={prefs.listTab} onTabChange={(listTab) => setPrefs((previous) => ({ ...previous, listTab }))} openProjectId={projectId} onOpenProject={(id) => void openProject(id)}
            hidden={sidebarClosed} overlay={dock.left === "overlay"} onHide={hideProjects} onNewProject={() => setDialog({ kind: "create" })}
            onAction={(kind, item) => setDialog({ kind, project: { id: item.id, name: item.name } })}
            onInviteSettled={(text, error) => { notify(text, error); void loadLists(); }} />
        </div>
        {projectId && bootstrap
          ? <StudioProvider key={projectId} projectId={projectId} draft={bootstrap.draft} role={bootstrap.project.role} archived={bootstrap.project.status === "ARCHIVED"}
              narrow={dock.editor < 640} ui={ui} update={updateStudio} adopt={adoptDraft} onAccessChanged={projectChanged} onInspect={() => setPanel(true)} saveRef={savePositionsRef}>
              {main}{panel}
            </StudioProvider>
          : <>{main}{panel}</>}
      </>}
    </div>
    <footer className="app-footer">
      <span className={notice.error ? "footer-error" : undefined} role={notice.error ? "alert" : "status"} aria-live="polite">{notice.text}</span>
      <form action={signOut}><button type="submit">Sign out</button></form>
    </footer>
    {children}
    {dialog?.kind === "create" && <NewProjectDialog onClose={() => closeDialog()} onCreated={(project) => void created(project)} onRefused={() => void loadLists()} />}
    {switchTarget && <Dialog title={`Unsaved changes in ${bootstrap?.project.name ?? "this project"}`} onClose={() => setDialog(null)} footer={<>
      <CancelFocus label="Stay" onClick={() => setDialog(null)} />
      <button type="button" className="button danger" disabled={ui.pending?.inFlight || Boolean(ui.placing)} onClick={() => { if (projectId) setStore((previous) => discardDrafts(previous, projectId)); setDialog(null); navigate(switchTarget); }}>Discard changes</button>
    </>}><p>{dirtyCount(store, projectId)} {ui.pending || ui.attempt ? "unsaved edit(s) or unconfirmed change(s)." : Object.keys(ui.unsavedMoves).length ? "unsaved change(s), including moved steps." : "unsaved field(s)."}</p>{ui.pending && <p>The unconfirmed change will still be available to retry when you return. Discard only removes local edits; it cannot cancel a change already sent.</p>}</Dialog>}
    {lifecycleDialog && <LifecycleDialog key={`${lifecycleDialog.kind}-${lifecycleDialog.project.id}`} kind={lifecycleDialog.kind} project={lifecycleDialog.project}
      onClose={() => closeDialog(lifecycleDialog.project.id)} onDone={() => void finishLifecycle(lifecycleDialog.kind, lifecycleDialog.project)} />}
  </div>;
}
