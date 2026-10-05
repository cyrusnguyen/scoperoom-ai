import type { ProjectStatusView } from "../../projects/contracts/project.ts";

// One status controller per visible project (Stage 04.2). Pure: every effect it has on the world comes through the
// injected seams below, so a fake clock and fake visibility can drive it in node tests.
export type ReconcileReason = "poll" | "focus" | "reconnect" | "before-save" | "manual" | "hint" | "subscribed";
/** What the window reports: a return (focus, reconnect) revalidates; going hidden or blurred only invalidates: polling is paused or a sign-in in another window may follow, and the next write revalidates. */
export type VisibilityEvent = ReconcileReason | "hidden" | "blur";
export type AuthorityResult = { kind: "current"; generation: number; status: ProjectStatusView } | { kind: "unavailable" } | { kind: "denied" };
export type StatusRead = { ok: true; data: ProjectStatusView } | { ok: false; status: number };
/** What the shell has adopted right now: the status is compared with this, so an own save's read costs no extra read. */
export type Live = { role: ProjectStatusView["role"]; status: ProjectStatusView["status"]; draftId: string; documentRevision: number; layoutRevision: number };
export type SyncState = { status: ProjectStatusView; failures: number };
/** replace: another draft is current. project: role or lifecycle changed. read: same draft, newer revisions. */
export type Plan = "none" | "read" | "project" | "replace";
/** An optional project resource reader. It owns its own cursor and only adopts while this fence remains current. */
export type ReconcileResources = (status: ProjectStatusView, fence: () => boolean) => Promise<void>;

export type SyncOptions = {
  /** The bootstrap's status: the authority every consumer starts from. */
  initial: ProjectStatusView;
  fetchStatus: () => Promise<StatusRead>;
  random: () => number;
  /** Returns its canceller. */
  setTimer: (run: () => void, ms: number) => () => void;
  /** `listen` reports focus, `online`, a tab becoming visible again (as "focus" or "reconnect") and a tab becoming hidden; it returns its remover. */
  visibility: { hidden: () => boolean; listen: (on: (event: VisibilityEvent) => void) => () => void };
  /** A status for another account than the one the page opened with: the shell tears down and navigates. The controller stops first. */
  accountChanged: () => void;
  /** The current status response proves the session ended. The controller stops first, so a late response cannot navigate. */
  sessionEnded: () => void;
  live: () => Live | null;
  /** One coherent D read through the shell's admission gate. Must check `fence()` right before adopting. */
  readDraft: (fence: () => boolean) => Promise<unknown>;
  /** A fresh bootstrap (replaced draft, role or lifecycle change, access loss). Must check `fence()` right before adopting. */
  bootstrap: (fence: () => boolean) => Promise<unknown>;
  /** Latest status and consecutive failure count, when either changed. */
  publish: (state: SyncState) => void;
  /** Project resources whose cursors are independent from the saved draft. Failed reads retry on the next successful status cycle. */
  reconcileResources?: ReconcileResources;
};

export type ProjectSync = {
  start: () => void;
  dispose: () => void;
  /** Concurrent callers share one request that starts after the call. */
  revalidate: (reason: ReconcileReason) => Promise<AuthorityResult>;
  /** Resolves at once while authority is current; after `invalidate()` or a failed read it waits for one revalidation. */
  beforeWrite: () => Promise<AuthorityResult>;
  invalidate: () => void;
  /** Realtime is delayed: the poll runs on the 5 s base instead of 10 s (never a second timer; hints are hints, the poll is the guarantee). */
  setDegraded: (on: boolean) => void;
  /** A visible nonterminal job uses the existing poll timer at the 2 s base. */
  setActiveJobVisible: (on: boolean) => void;
  /** A check that generation `at` (default: the current one; an authority result carries its own) is still current: call it right before adopting anything. */
  fence: (at?: number) => () => boolean;
};

export function statusDelay(failures: number, random: number, degraded = false, activeJobVisible = false): number {
  const base = activeJobVisible ? 2_000 : degraded ? 5_000 : 10_000;
  const backedOff = Math.min(30_000, base * 2 ** Math.min(failures, 2));
  return Math.round(Math.min(30_000, backedOff * (0.9 + Math.max(0, Math.min(1, random)) * 0.2)));
}

/** The one decision: only draft counters ahead of the adopted draft fetch D; eventSequence and metadata fetch nothing. */
export function plan(live: Live, next: ProjectStatusView): Plan {
  if (next.currentDraftId !== live.draftId) return "replace";
  if (next.role !== live.role || next.status !== live.status) return "project";
  return next.documentRevision > live.documentRevision || next.layoutRevision > live.layoutRevision ? "read" : "none";
}

const unavailable: AuthorityResult = { kind: "unavailable" };

export function createProjectSync(o: SyncOptions): ProjectSync {
  let generation = 0, session = 0, started = false, stopped = false, failures = 0, invalid = false, invalidations = 0, degraded = false, activeJobVisible = false;
  // What the request in flight started with: one that saw every invalidation covers a later beforeWrite; a window event is covered only by another window event's or a write's request.
  let runSeen = -1, runReason: ReconcileReason = "poll";
  let last = o.initial, shown = "";
  let cancelTimer: (() => void) | null = null, unlisten: (() => void) | null = null;
  let running: Promise<AuthorityResult> | null = null, queued: Promise<AuthorityResult> | null = null;

  const fenceFor = (at: number) => () => started && at === generation;
  const publish = () => {
    const key = JSON.stringify([last, failures]);
    if (key !== shown) { shown = key; o.publish({ status: last, failures }); }
  };
  function schedule() {
    cancelTimer?.();
    cancelTimer = started && !stopped ? o.setTimer(() => { cancelTimer = null; void revalidate("poll"); }, statusDelay(failures, o.random(), degraded, activeJobVisible)) : null;
  }

  async function run(): Promise<AuthorityResult> {
    let at = generation;
    const seen = invalidations;
    const read = await o.fetchStatus().catch((): StatusRead => ({ ok: false, status: 0 }));
    if (!fenceFor(at)()) return unavailable; // a late response after dispose or a newer generation adopts nothing
    if (!read.ok) {
      if (read.status === 401) { stopped = true; generation++; o.sessionEnded(); return unavailable; }
      failures++; invalid = true;
      const denied = read.status === 403 || read.status === 404;
      publish(); schedule();
      // Nothing is adopted: the shell's own bootstrap read shows the unavailable-project recovery.
      if (denied) await o.bootstrap(fenceFor(at)).catch(() => undefined);
      return denied ? { kind: "denied" } : unavailable;
    }
    if (read.data.viewerId !== o.initial.viewerId) { stopped = true; generation++; o.accountChanged(); return unavailable; }
    failures = 0; last = read.data; publish();
    const live = o.live(), next = live ? plan(live, read.data) : "none";
    if (next === "replace") at = ++generation; // the draft changed: nothing from the old one may land any more
    // A reconcile failure leaves the shell where it was, so the next poll sees the same difference and retries.
    try {
      if (next === "read") await o.readDraft(fenceFor(at));
      else if (next !== "none") await o.bootstrap(fenceFor(at));
    } catch { /* retried by the next poll */ }
    // AI and later resources have independent cursors. A failed or stale resource never invalidates saved draft/authority adoption.
    try { await o.reconcileResources?.(last, fenceFor(at)); } catch { /* retried by the next successful status cycle */ }
    if (!fenceFor(at)()) return unavailable;
    if (seen === invalidations) invalid = false;
    schedule();
    return { kind: "current", generation: at, status: last };
  }

  function begin(reason: ReconcileReason): Promise<AuthorityResult> {
    cancelTimer?.(); cancelTimer = null;
    runSeen = invalidations; runReason = reason;
    const flight: Promise<AuthorityResult> = run().finally(() => { if (running === flight) running = null; });
    return running = flight;
  }
  function revalidate(reason: ReconcileReason): Promise<AuthorityResult> {
    // Hidden: polls and hints are paused until a return event; a write barrier still works.
    if (!started || stopped || ((reason === "poll" || reason === "hint") && o.visibility.hidden())) return Promise.resolve(unavailable);
    // A (re)join proves nothing about what was missed: writes wait for the read this starts (or the one it queues behind).
    if (reason === "subscribed") invalidate();
    if (!running) return begin(reason);
    if (queued) return queued;
    const at = session;
    const next: Promise<AuthorityResult> = running.then(() => { if (queued === next) queued = null; return at === session && started && !stopped ? begin(reason) : unavailable; });
    return queued = next;
  }

  function invalidate() { invalid = true; invalidations++; }
  function setDegraded(on: boolean) {
    if (on === degraded) return;
    degraded = on;
    if (cancelTimer) schedule(); // a waiting poll moves to the new cadence; one in flight schedules its own follow-up
  }

  return {
    start() {
      if (started) return;
      started = true; stopped = false; generation++;
      // Leaving and returning may have changed access: writes wait for a request that starts after the event. Focus and
      // visibilitychange fire together, so an event-started request that has seen every invalidation covers this one too.
      unlisten = o.visibility.listen((reason) => {
        // Background autosave keeps running while polling is paused, and another window can sign in as someone else: what was
        // true before this window hid or lost focus is no longer proven.
        if (reason === "hidden" || reason === "blur") { invalidate(); return; }
        // A poll, hint or join read is not a window event: it may have started just before this return, so the return gets its own.
        if (running && runSeen === invalidations && runReason !== "poll" && runReason !== "hint" && runReason !== "subscribed") return;
        invalidate(); void revalidate(reason);
      });
      schedule();
    },
    dispose() {
      started = false; generation++; session++; running = queued = null; degraded = activeJobVisible = false;
      cancelTimer?.(); cancelTimer = null;
      unlisten?.(); unlisten = null;
    },
    revalidate,
    beforeWrite: () => (!started || stopped ? Promise.resolve(unavailable)
      : !invalid ? Promise.resolve<AuthorityResult>({ kind: "current", generation, status: last })
      : running && runSeen === invalidations ? running : revalidate("before-save")),
    invalidate,
    setDegraded,
    setActiveJobVisible(on) {
      if (on === activeJobVisible) return;
      activeJobVisible = on;
      if (cancelTimer) schedule();
    },
    fence: (at = generation) => fenceFor(at),
  };
}
