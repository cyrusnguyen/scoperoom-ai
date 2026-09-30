import type { ProjectStatusView } from "../../projects/contracts/project.ts";

// One status controller per visible project (Stage 04.2). Pure: every effect it has on the world comes through the
// injected seams below, so a fake clock and fake visibility can drive it in node tests. 04.3 adds "hint" | "subscribed".
export type ReconcileReason = "poll" | "focus" | "reconnect" | "before-save" | "mutation" | "manual";
/** What the window reports: a return (focus, reconnect) revalidates; going hidden only invalidates, since polling is paused there. */
export type VisibilityEvent = ReconcileReason | "hidden";
export type AuthorityResult = { kind: "current"; generation: number; status: ProjectStatusView } | { kind: "unavailable" } | { kind: "denied" };
export type StatusRead = { ok: true; data: ProjectStatusView } | { ok: false; status: number };
/** What the shell has adopted right now: the status is compared with this, so an own save's read costs no extra read. */
export type Live = { role: ProjectStatusView["role"]; status: ProjectStatusView["status"]; draftId: string; documentRevision: number; layoutRevision: number };
export type SyncState = { status: ProjectStatusView; failures: number };
/** replace: another draft is current. project: role or lifecycle changed. read: same draft, newer revisions. */
export type Plan = "none" | "read" | "project" | "replace";

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
  live: () => Live | null;
  /** One coherent D read through the shell's admission gate. Must check `fence()` right before adopting. */
  readDraft: (fence: () => boolean) => Promise<unknown>;
  /** A fresh bootstrap (replaced draft, role or lifecycle change, access loss). Must check `fence()` right before adopting. */
  bootstrap: (fence: () => boolean) => Promise<unknown>;
  /** Latest status and consecutive failure count, when either changed. */
  publish: (state: SyncState) => void;
};

export type ProjectSync = {
  start: () => void;
  dispose: () => void;
  /** Concurrent callers share one request that starts after the call. */
  revalidate: (reason: ReconcileReason) => Promise<AuthorityResult>;
  /** Resolves at once while authority is current; after `invalidate()` or a failed read it waits for one revalidation. */
  beforeWrite: () => Promise<AuthorityResult>;
  invalidate: () => void;
  /** True while this generation is still the current one: check right before adopting anything. */
  /** The current generation, or an earlier one whose result is being checked (an authority result carries its own). */
  fence: (at?: number) => () => boolean;
};

export function statusDelay(failures: number, random: number): number {
  const backedOff = Math.min(30_000, 10_000 * 2 ** Math.min(failures, 2));
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
  let generation = 0, session = 0, started = false, stopped = false, failures = 0, invalid = false, invalidations = 0;
  // What the request in flight started with: an event-driven one that saw every invalidation covers a later beforeWrite or event.
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
    cancelTimer = started && !stopped ? o.setTimer(() => { cancelTimer = null; void revalidate("poll"); }, statusDelay(failures, o.random())) : null;
  }

  async function run(): Promise<AuthorityResult> {
    let at = generation;
    const seen = invalidations;
    const read = await o.fetchStatus().catch((): StatusRead => ({ ok: false, status: 0 }));
    if (!fenceFor(at)()) return unavailable; // a late response after dispose or a newer generation adopts nothing
    if (!read.ok) {
      if (read.status === 401) { stopped = true; return unavailable; } // the client already navigated to sign-in
      failures++; invalid = true;
      const denied = read.status === 403 || read.status === 404;
      publish(); schedule();
      // Nothing is adopted: the shell's own bootstrap read shows the unavailable-project recovery.
      if (denied) await o.bootstrap(fenceFor(at)).catch(() => undefined);
      return denied ? { kind: "denied" } : unavailable;
    }
    if (read.data.viewerId !== o.initial.viewerId) { stopped = true; o.accountChanged(); return unavailable; }
    failures = 0; last = read.data; publish();
    const live = o.live(), next = live ? plan(live, read.data) : "none";
    if (next === "replace") at = ++generation; // the draft changed: nothing from the old one may land any more
    // A reconcile failure leaves the shell where it was, so the next poll sees the same difference and retries.
    try {
      if (next === "read") await o.readDraft(fenceFor(at));
      else if (next !== "none") await o.bootstrap(fenceFor(at));
    } catch { /* retried by the next poll */ }
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
    if (!started || stopped || (reason === "poll" && o.visibility.hidden())) return Promise.resolve(unavailable); // hidden: paused until a return event
    if (!running) return begin(reason);
    if (queued) return queued;
    const at = session;
    const next: Promise<AuthorityResult> = running.then(() => { if (queued === next) queued = null; return at === session && started ? begin(reason) : unavailable; });
    return queued = next;
  }

  function invalidate() { invalid = true; invalidations++; }

  return {
    start() {
      if (started) return;
      started = true; stopped = false; generation++;
      // Leaving and returning may have changed access: writes wait for a request that starts after the event. Focus and
      // visibilitychange fire together, so an event-started request that has seen every invalidation covers this one too.
      unlisten = o.visibility.listen((reason) => {
        // Background autosave keeps running while polling is paused: whatever was true before the tab hid is no longer proven.
        if (reason === "hidden") { invalidate(); return; }
        if (running && runSeen === invalidations && runReason !== "poll") return;
        invalidate(); void revalidate(reason);
      });
      schedule();
    },
    dispose() {
      started = false; generation++; session++; running = queued = null;
      cancelTimer?.(); cancelTimer = null;
      unlisten?.(); unlisten = null;
    },
    revalidate,
    beforeWrite: () => (!started || stopped ? Promise.resolve(unavailable)
      : !invalid ? Promise.resolve<AuthorityResult>({ kind: "current", generation, status: last })
      : running && runSeen === invalidations ? running : revalidate("before-save")),
    invalidate,
    fence: (at = generation) => fenceFor(at),
  };
}
