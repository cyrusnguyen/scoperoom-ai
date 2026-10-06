"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { flushSync } from "react-dom";
import { accountChanged, apiRead, SESSION_ENDED, sessionEnded } from "@/client/api";
import { clearImport, clearImportSessions } from "@/features/exchange/ui/import-recovery";
import type { Live } from "@/features/collaboration/ui/project-sync";
import { SyncProvider } from "@/features/collaboration/ui/sync-context";
import type { DraftView } from "@/features/drafts/contracts/scope-document";
import type { MyInvitation } from "@/features/projects/contracts/invitation";
import type { CreatedProject, ProjectBootstrap, ProjectLists } from "@/features/projects/contracts/project";
import { expiryLabel } from "@/features/projects/ui/format";
import ProjectDetails from "@/features/projects/ui/project-details";
import Inspector from "@/features/studio/ui/inspector";
import { StudioProvider } from "@/features/studio/ui/studio-context";
import { emptyOutbox, pendingCount } from "@/features/studio/ui/outbox";
import { admits, afterDraftRead, type StudioUi } from "@/features/studio/ui/studio-ui";
import Dialog, { CancelFocus } from "./dialog";
import { resolveDock } from "./dock";
import { Icon } from "./icon";
import LifecycleDialog, { type LifecycleKind } from "./lifecycle-dialog";
import NewProjectDialog from "./new-project-dialog";
import ProjectEditor, { NoProjectOpen, ProjectUnavailable } from "./project-editor";
import { currentAiRun, anyDirty, dirtyCount, discardDrafts, dropProject, setDraft, setRightOpen, setRightTab, uiFor, updateUi, type UiStore } from "./project-ui";
import ProjectsSidebar, { LIST_TABS, type InviteRow, type ListTab } from "./projects-sidebar";
import RightPanel from "./right-panel";
import AiActions from "@/features/proposals/ui/ai-actions";

type Prefs = { leftOpen: boolean; listTab: ListTab };
type Opened = { projectId: string; bootstrap?: ProjectBootstrap; missing?: boolean; error?: string };
type Target = { id: string; name: string };
type ShellDialog = { kind: "create" } | { kind: "switch"; target: string } | { kind: LifecycleKind; project: Target };

const prefsKey = "scoperoom_shell";
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  // Synchronous copy of `opened`: the admission gate must see a draft adopted in the same event.
  const openedRef = useRef<Opened | null>(null);
  // A 401 anywhere ends the session: what the shell holds is cleared before the page is replaced, and late responses install nothing.
  const [ended, setEnded] = useState<"session" | "account" | null>(null);
  // The account this page opened with (from the first bootstrap): a status or bootstrap for another one is an account change.
  const viewerRef = useRef<string | null>(null);
  const endedRef = useRef(false);
  const install = useCallback((next: Opened) => { if (!endedRef.current) { openedRef.current = next; setOpened(next); } }, []);
  const [store, setStore] = useState<UiStore>({});
  const latestStore = useRef(store);
  const restoredRunProject = useRef<string | null>(null);
  useLayoutEffect(() => { latestStore.current = store; }, [store]);
  const saveChangesRef = useRef<(() => Promise<boolean>) | null>(null);
  const opening = useRef(false);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ShellDialog | null>(null);
  const [notice, setNotice] = useState({ text: "", error: false });
  const notify = useCallback((text: string, error = false) => setNotice({ text, error }), []);

  useEffect(() => {
    const end = (event: Event) => flushSync(() => {
      clearImportSessions();
      endedRef.current = true; openedRef.current = null;
      setEnded((event as CustomEvent<"session" | "account">).detail === "account" ? "account" : "session"); setStore({}); setOpened(null); setLists(null); setInvites(null); setDialog(null);
    });
    window.addEventListener(SESSION_ENDED, end);
    return () => window.removeEventListener(SESSION_ENDED, end);
  }, []);
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
    if (sessionEnded(projects) || sessionEnded(mine) || endedRef.current) return;
    if (!projects.ok || !mine.ok) { setListsState("error"); return; }
    const now = Date.now();
    setLists(projects.data);
    setInvites({ items: mine.data.items.map((invite) => ({ ...invite, expiry: expiryLabel(invite.expiresAt, now) })), truncated: mine.data.truncated });
    setListsState("ready");
  }, []);

  // `fence` (the sync controller) drops a response its generation has since replaced, and is the only caller allowed to
  // install a different draft than the one shown: a replaced draft. Any other read of another draft is a stale one.
  const loadProject = useCallback(async (id: string, signal?: AbortSignal, fence?: () => boolean) => {
    const result = await apiRead<ProjectBootstrap>(`/api/projects/${id}/bootstrap`, signal);
    if (signal?.aborted || sessionEnded(result) || endedRef.current || (fence && !fence())) return;
    // An unsignaled caller (Retry, projectChanged) can resolve after the user opened a different project.
    if (id !== projectIdRef.current) return;
    if (result.ok && viewerRef.current && result.data.status.viewerId !== viewerRef.current) { accountChanged(); return; }
    if (result.ok) {
      viewerRef.current = result.data.status.viewerId;
      // A re-read that raced a save or another read must not roll the draft back or below a receipt floor: the shown
      // draft stays and the floor is left alone. With no draft shown yet the read is installed and the floor stays
      // unless it covers it.
      const previous = openedRef.current;
      const shown = previous?.projectId === id ? previous.bootstrap?.draft : undefined;
      const admitted = !shown || (fence && shown.id !== result.data.draft.id) || admits(uiFor(latestStore.current, id), shown, result.data.draft);
      install({ projectId: id, bootstrap: admitted ? result.data : { ...result.data, draft: shown } });
      if (admitted) setStore((current) => updateUi(current, id, (ui) => afterDraftRead(ui, result.data.draft)));
    }
    else if (result.status === 403 || result.status === 404) {
      if (viewerRef.current) clearImport({ actorId: viewerRef.current, projectId: id });
      install(result.status === 404 ? { projectId: id, missing: true } : { projectId: id, error: result.message });
      setStore((previous) => result.status === 404 ? dropProject(previous, id) : updateUi(previous, id, () => ({ nativeImport: null })));
    }
    // A background read (polling, Details) that fails transiently keeps what is shown: unmounting would stop the polling
    // that retries it. The unavailable view's own Retry has nothing shown, and 403 or 404 always show their recovery.
    else if (result.uncertain && openedRef.current?.projectId === id && openedRef.current.bootstrap) return;
    else install({ projectId: id, error: result.message });
  }, [install]);

  // The Studio's saved draft lives with the bootstrap; a read replaces it only through the admission gate. True when installed.
  const adoptDraft = useCallback((view: DraftView) => {
    const previous = openedRef.current;
    if (!previous?.bootstrap || !admits(uiFor(latestStore.current, previous.projectId), previous.bootstrap.draft, view)) return false;
    install({ ...previous, bootstrap: { ...previous.bootstrap, draft: view } });
    return true;
  }, [install]);
  // What the sync controller compares each status with: the role, lifecycle and draft adopted right now.
  const liveOf = useCallback((id: string): Live | null => {
    const shown = openedRef.current;
    const adopted = shown?.projectId === id ? shown.bootstrap : undefined;
    return adopted ? { role: adopted.project.role, status: adopted.project.status, draftId: adopted.draft.id, documentRevision: adopted.draft.documentRevision, layoutRevision: adopted.draft.layoutRevision } : null;
  }, []);
  const updateStudio = useCallback((change: (ui: StudioUi) => Partial<StudioUi>) => {
    // A late response for a project that was dropped or whose session ended must not bring its state back.
    const shown = openedRef.current;
    if (endedRef.current || (shown?.projectId === projectId && shown?.missing)) return;
    if (projectId) setStore((previous) => updateUi(previous, projectId, change));
  }, [projectId]);

  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);

  // A validated run query is an explicit deep link: open the AI tab before its detail reader mounts.
  // This also seeds the selection before the history's default-first selection can run.
  useEffect(() => {
    if (!projectId || restoredRunProject.current === projectId) return;
    restoredRunProject.current = projectId;
    const runId = new URLSearchParams(window.location.search).get("run");
    if (!runId || !runIdPattern.test(runId)) return;
    requestAnimationFrame(() => {
      if (projectIdRef.current !== projectId) return;
      setStore((previous) => updateUi(previous, projectId, (current) => ({
        rightOpen: true, rightMounted: true, rightTab: "ai", ai: { ...current.ai, selectedRunId: currentAiRun(current.ai, runId) },
      })));
      setLastOpened("right");
    });
  }, [projectId]);
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
  function openRightTab(tab: "details" | "ai") {
    if (!projectId) return;
    setStore((previous) => setRightTab(previous, projectId, tab));
    setLastOpened("right");
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
    // One switch at a time: a second click while the first saves must not leave a stale guard dialog behind.
    if (id === projectId || opening.current) return;
    opening.current = true;
    try {
      let allSaved = false;
      // Unsaved changes are saved first. Once all are acknowledged they no longer need resolving (the store has not
      // re-rendered yet); typed but unapplied text still does.
      if (projectId && pendingCount(ui.outbox)) allSaved = await saveChangesRef.current?.() ?? false;
      const remaining = projectId && allSaved
        ? updateUi(latestStore.current, projectId, () => ({ outbox: emptyOutbox }))
        : latestStore.current;
      // Browser history may have moved on while the save ran: the guard belongs to the project still open.
      if (projectIdRef.current !== projectId) return;
      // Switching projects resolves unsaved edits first (UI00): Stay, or an explicit Discard, never silent.
      if (dirtyCount(remaining, projectId) > 0) { setDialog({ kind: "switch", target: id }); return; }
      navigate(id);
    } finally { opening.current = false; }
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

  if (ended) return <div className="app-shell"><main id="editor-main" className="editor-slot"><div className="empty-state" role="alert"><p>{ended === "account" ? "Your account changed. Reloading…" : "Your session ended. Taking you to sign in…"}</p></div></main></div>;

  const restoreNote = capacity && !capacity.canCreate ? (capacity.entitled ? `${capacity.activeOwned}/${capacity.maxOwned} active` : "Restoring isn’t enabled for this account") : undefined;
  const lifecycleDialog = dialog && dialog.kind !== "create" && dialog.kind !== "switch" ? dialog : null;
  const switchTarget = dialog?.kind === "switch" ? dialog.target : null;

  const editor = navigating ? <div className="empty-state" aria-busy="true"><p>Loading project…</p></div>
    : !projectId
    ? <NoProjectOpen autoFocus={focusTarget === ""} sidebarClosed={sidebarClosed} capacity={capacity} hasInvites={Boolean(invites?.items.length)} onShowProjects={() => showProjects()} onCreate={() => setDialog({ kind: "create" })} onViewInvites={() => showProjects("invites")} />
    : !current ? <div className="empty-state" aria-busy="true"><p>Loading project…</p></div>
    : bootstrap ? <ProjectEditor key={projectId} bootstrap={bootstrap} autoFocus={focusTarget === projectId} sidebarClosed={sidebarClosed} onShowProjects={() => showProjects()}
        panelOpen={dock.right !== "closed"} activeTab={ui.rightTab} onOpenDetails={() => openRightTab("details")} onOpenAI={() => openRightTab("ai")}
        restoreNote={restoreNote} onRestore={() => setDialog({ kind: "restore", project: { id: projectId, name: bootstrap.project.name } })} />
    : <ProjectUnavailable missing={Boolean(current.missing)} message={current.error ?? ""} sidebarClosed={sidebarClosed} onShowProjects={() => showProjects()} onRetry={() => void loadProject(projectId)} />;

  // With a Studio selection the Details tab inspects it; "← Project" clears the selection and returns to project details.
  const panel = projectId && bootstrap && ui.rightMounted
    ? <RightPanel key={projectId} mode={dock.right} tab={ui.rightTab} onTabChange={(tab) => openRightTab(tab)} onClose={() => setPanel(false)}>
      {ui.rightTab === "ai" ? dock.right !== "closed" ? <AiActions ui={ui.ai} update={(change) => setStore((previous) => updateUi(previous, projectId, (current) => ({ ai: change(current.ai) })))} /> : null
        : ui.selection ? <Inspector onBack={() => { updateStudio(() => ({ selection: null })); requestAnimationFrame(() => document.getElementById("right-tab-details")?.focus()); }} />
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
          ? <SyncProvider key={projectId} projectId={projectId} initial={bootstrap.status} live={() => liveOf(projectId)} bootstrap={(fence) => loadProject(projectId, undefined, fence)}>
            <StudioProvider key={projectId} projectId={projectId} draft={bootstrap.draft} role={bootstrap.project.role} archived={bootstrap.project.status === "ARCHIVED"}
              narrow={dock.editor < 640} ui={ui} update={updateStudio} adopt={adoptDraft} onAccessChanged={projectChanged} onInspect={() => openRightTab("details")} saveRef={saveChangesRef}>
              {main}{panel}
            </StudioProvider>
          </SyncProvider>
          : <>{main}{panel}</>}
      </>}
    </div>
    <footer className="app-footer">
      <span className={notice.error ? "footer-error" : undefined} role={notice.error ? "alert" : "status"} aria-live="polite">{notice.text}</span>
      <form action={signOut} onSubmit={clearImportSessions}><button type="submit" className="button quiet small sign-out-button"><Icon name="signOut" size={15} /><span>Sign out</span></button></form>
    </footer>
    {children}
    {dialog?.kind === "create" && <NewProjectDialog onClose={() => closeDialog()} onCreated={(project) => void created(project)} onRefused={() => void loadLists()} />}
    {switchTarget && <Dialog title={`Unsaved changes in ${bootstrap?.project.name ?? "this project"}`} onClose={() => setDialog(null)} footer={<>
      <CancelFocus label="Stay" onClick={() => setDialog(null)} />
      <button type="button" className="button danger" disabled={Boolean(ui.request)} onClick={() => { if (projectId) setStore((previous) => discardDrafts(previous, projectId)); setDialog(null); navigate(switchTarget); }}>Discard changes</button>
    </>}><p>{dirtyCount(store, projectId)} {ui.outbox.sending?.state === "uncertain" ? "unsaved edit(s) or unconfirmed change(s)." : pendingCount(ui.outbox) ? "unsaved change(s)." : "unsaved field(s)."}</p>{ui.outbox.sending?.state === "uncertain" && <p>The unconfirmed save will still be available to retry when you return. Discard only removes local edits; it cannot cancel a change already sent.</p>}</Dialog>}
    {lifecycleDialog && <LifecycleDialog key={`${lifecycleDialog.kind}-${lifecycleDialog.project.id}`} kind={lifecycleDialog.kind} project={lifecycleDialog.project} viewer={() => viewerRef.current}
      onClose={() => closeDialog(lifecycleDialog.project.id)} onDone={() => void finishLifecycle(lifecycleDialog.kind, lifecycleDialog.project)} />}
  </div>;
}
