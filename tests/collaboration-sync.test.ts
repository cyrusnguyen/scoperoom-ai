import assert from "node:assert/strict";
import test from "node:test";
import type { ApiResult } from "../src/client/api.ts";
import { createRunResources } from "../src/features/proposals/ui/run-resources.ts";
import type { ProjectStatusView } from "../src/features/projects/contracts/project.ts";
import {
  createProjectSync, plan, statusDelay, type Live, type StatusRead, type SyncOptions, type VisibilityEvent,
} from "../src/features/collaboration/ui/project-sync.ts";
import type { DraftView } from "../src/features/drafts/contracts/scope-document.ts";
import type { PeerMessage, PresenceState } from "../src/features/collaboration/contracts/messages.ts";
import { realtimeTopics } from "../src/features/collaboration/contracts/topics.ts";
import { createProjectLive, savedViewOf, type LiveScope } from "../src/features/collaboration/ui/project-live.ts";
import type { LiveState, RealtimeTransport } from "../src/features/collaboration/ui/realtime-transport.ts";
import { emptyOutbox, type Outbox } from "../src/features/studio/ui/outbox.ts";
import { stranded } from "../src/features/studio/ui/studio-ui.ts";

const status = (over: Partial<ProjectStatusView> = {}): ProjectStatusView => ({
  viewerId: "v1", status: "ACTIVE", role: "OWNER", version: 1, settingsVersion: 1, approvalPolicyVersion: 1, membershipVersion: 1, designatedApproverId: null,
  currentDraftId: "d1", documentRevision: 1, layoutRevision: 1, realtimeEpoch: "e1", eventSequence: 1, aiRevision: 0, approvedSnapshotId: null, ...over,
});
const liveOf = (s: ProjectStatusView): Live => ({ role: s.role, status: s.status, draftId: s.currentDraftId, documentRevision: s.documentRevision, layoutRevision: s.layoutRevision });
const ok = (s: ProjectStatusView): StatusRead => ({ ok: true, data: s });
const fail = (code: number): StatusRead => ({ ok: false, status: code });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A fake clock, fake visibility and a status endpoint answered by hand: no real timers, no DOM. */
function rig(start = status(), reconcileResources?: SyncOptions["reconcileResources"]) {
  let clock = 0, ids = 0, hidden = false;
  const timers: { id: number; at: number; fn: () => void; ms: number }[] = [];
  const listeners = new Set<(reason: VisibilityEvent) => void>();
  const pending: ((read: StatusRead) => void)[] = [];
  const log: string[] = [];
  const published: { status: ProjectStatusView; failures: number }[] = [];
  const shell = { live: liveOf(start), readFails: false };
  const sync = createProjectSync({
    initial: start,
    fetchStatus: () => new Promise<StatusRead>((resolve) => { pending.push(resolve); }),
    random: () => 0.5,
    setTimer: (fn, ms) => {
      const timer = { id: ++ids, at: clock + ms, fn, ms };
      timers.push(timer);
      return () => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); };
    },
    visibility: { hidden: () => hidden, listen: (on) => { listeners.add(on); return () => { listeners.delete(on); }; } },
    accountChanged: () => { log.push("account"); },
    sessionEnded: () => { log.push("session"); },
    live: () => shell.live,
    readDraft: async (fence) => { log.push(`read:${fence()}`); },
    bootstrap: async (fence) => { log.push(`bootstrap:${fence()}`); },
    publish: (state) => published.push(state),
    reconcileResources,
  });
  return {
    sync, log, published, shell, timers, listeners, pending,
    setHidden: (value: boolean) => { hidden = value; },
    /** Answers the oldest unanswered status request. */
    async answer(read: StatusRead) { pending.shift()!(read); await settle(); },
    async advance(ms: number) {
      const until = clock + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock = due.at;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
        await settle();
      }
      clock = until;
    },
  };
}

test("statusDelay: 10 s healthy with +-10% jitter, doubling per failure, capped at 30 s", () => {
  assert.deepEqual([0, 0.5, 1].map((random) => statusDelay(0, random)), [9_000, 10_000, 11_000]);
  assert.deepEqual([0, 0.5, 1].map((random) => statusDelay(1, random)), [18_000, 20_000, 22_000]);
  assert.deepEqual([0, 0.5, 1].map((random) => statusDelay(2, random)), [27_000, 30_000, 30_000]);
  assert.equal(statusDelay(9, 1), 30_000);
  assert.equal(statusDelay(0, -3), 9_000);
  assert.equal(statusDelay(0, 7), 11_000);
});

test("start schedules exactly one timeout; each poll reschedules exactly one after it completes", async () => {
  const t = rig();
  t.sync.start();
  assert.equal(t.timers.length, 1);
  assert.equal(t.timers[0]!.ms, 10_000);
  await t.advance(10_000);
  assert.equal(t.pending.length, 1);
  assert.equal(t.timers.length, 0, "no timer while the request is outstanding");
  await t.answer(ok(status()));
  assert.equal(t.timers.length, 1);
  assert.equal(t.timers[0]!.ms, 10_000);
  t.sync.dispose();
});

test("a slow request never overlaps: callers during it share one follow-up request", async () => {
  const t = rig();
  t.sync.start();
  await t.advance(10_000);
  const results = [t.sync.revalidate("focus"), t.sync.revalidate("manual"), t.sync.beforeWrite(), t.sync.revalidate("reconnect")];
  await settle();
  assert.equal(t.pending.length, 1, "still one request in flight");
  await t.answer(ok(status()));
  assert.equal(t.pending.length, 1, "one follow-up for all four callers");
  assert.equal(t.timers.length, 0);
  await t.answer(ok(status()));
  assert.deepEqual((await Promise.all(results)).map((result) => result.kind), ["current", "current", "current", "current"]);
  assert.equal(t.pending.length, 0);
  assert.equal(t.timers.length, 1);
  t.sync.dispose();
});

test("an explicit revalidation replaces the pending poll timer", async () => {
  const t = rig();
  t.sync.start();
  const result = t.sync.revalidate("manual");
  assert.equal(t.timers.length, 0);
  await t.answer(ok(status()));
  await result;
  assert.equal(t.timers.length, 1);
  t.sync.dispose();
});

test("hidden pause: a due poll fetches nothing and reschedules nothing; return revalidates once", async () => {
  const t = rig();
  t.sync.start();
  t.setHidden(true);
  await t.advance(60_000);
  assert.equal(t.pending.length, 0);
  assert.equal(t.timers.length, 0);
  const manual = t.sync.revalidate("manual"); // a write barrier still works while hidden
  assert.equal(t.pending.length, 1);
  await t.answer(ok(status()));
  await manual;
  t.setHidden(false);
  t.timers.length = 0;
  [...t.listeners].forEach((on) => on("focus"));
  assert.equal(t.pending.length, 1);
  await t.answer(ok(status()));
  assert.equal(t.timers.length, 1);
  t.sync.dispose();
});

test("failures back off 20 s then 30 s and stay at the cap; a success resets to 10 s", async () => {
  const t = rig();
  t.sync.start();
  const delays: number[] = [];
  for (const read of [fail(0), fail(503), fail(0), ok(status())]) {
    await t.advance(t.timers[0]!.ms);
    await t.answer(read);
    delays.push(t.timers[0]!.ms);
  }
  assert.deepEqual(delays, [20_000, 30_000, 30_000, 10_000]);
  assert.deepEqual(t.published.map((state) => state.failures), [1, 2, 3, 0]);
  t.sync.dispose();
});

test("dispose clears the timer and listener and drops a late response entirely", async () => {
  const t = rig(status());
  t.sync.start();
  await t.advance(10_000);
  t.shell.live = liveOf(status());
  t.sync.dispose();
  assert.equal(t.timers.length, 0);
  assert.equal(t.listeners.size, 0);
  await t.answer(ok(status({ documentRevision: 9, role: "VIEWER" })));
  assert.deepEqual(t.log, []);
  assert.deepEqual(t.published, []);
  assert.equal(t.timers.length, 0);
  assert.equal((await t.sync.revalidate("manual")).kind, "unavailable");
  assert.equal(t.pending.length, 0);
});

test("start, dispose, start (StrictMode) leaves one timer and one listener; the old generation stays dropped", async () => {
  const t = rig();
  t.sync.start();
  const first = t.sync.fence();
  t.sync.dispose();
  t.sync.start();
  assert.equal(t.timers.length, 1);
  assert.equal(t.listeners.size, 1);
  assert.equal(first(), false);
  assert.equal(t.sync.fence()(), true);
  t.sync.start(); // idempotent
  assert.equal(t.timers.length, 1);
  assert.equal(t.listeners.size, 1);
  t.sync.dispose();
  assert.equal(t.timers.length + t.listeners.size, 0);
});

test("a follow-up queued before dispose never starts after a restart", async () => {
  const t = rig();
  t.sync.start();
  void t.sync.revalidate("focus");
  const queued = t.sync.revalidate("manual");
  t.sync.dispose();
  t.sync.start();
  await t.answer(ok(status())); // the first lifecycle's request answers: dropped
  assert.equal((await queued).kind, "unavailable");
  assert.equal(t.pending.length, 0, "no request from the old lifecycle");
  assert.equal(t.timers.length, 1);
  t.sync.dispose();
});

test("plan: draft counters read D; eventSequence, metadata versions and a shell already ahead do nothing", () => {
  const live = liveOf(status());
  assert.equal(plan(live, status({ eventSequence: 99 })), "none");
  assert.equal(plan(live, status({ membershipVersion: 4, settingsVersion: 4, approvalPolicyVersion: 4, version: 4 })), "none");
  assert.equal(plan(live, status({ documentRevision: 2 })), "read");
  assert.equal(plan(live, status({ layoutRevision: 2 })), "read");
  assert.equal(plan({ ...live, documentRevision: 5 }, status({ documentRevision: 2 })), "none");
  assert.equal(plan(live, status({ role: "VIEWER" })), "project");
  assert.equal(plan(live, status({ status: "ARCHIVED" })), "project");
  assert.equal(plan(live, status({ currentDraftId: "d2" })), "replace");
  assert.equal(plan(live, status({ currentDraftId: "d2", role: "VIEWER", documentRevision: 9 })), "replace");
});

test("a changed document or layout revision performs one D read; eventSequence alone fetches nothing", async () => {
  const t = rig();
  t.sync.start();
  const quiet = t.sync.revalidate("poll");
  await t.answer(ok(status({ eventSequence: 50, membershipVersion: 3 })));
  await quiet;
  assert.deepEqual(t.log, []);
  assert.equal(t.published.at(-1)!.status.membershipVersion, 3, "consumers still see the new metadata");
  const changed = t.sync.revalidate("focus");
  await t.answer(ok(status({ documentRevision: 2, layoutRevision: 2 })));
  assert.equal((await changed).kind, "current");
  assert.deepEqual(t.log, ["read:true"]);
  t.sync.dispose();
});

test("a failed D read leaves the counters unadopted, so the next poll reads again", async () => {
  const t = rig();
  t.sync.start();
  for (let poll = 1; poll <= 2; poll++) {
    await t.advance(t.timers[0]!.ms);
    await t.answer(ok(status({ documentRevision: 2 }))); // the shell's live draft stays at revision 1: the read failed
    assert.equal(t.log.length, poll);
  }
  t.shell.live = { ...t.shell.live, documentRevision: 2 };
  await t.advance(t.timers[0]!.ms);
  await t.answer(ok(status({ documentRevision: 2 })));
  assert.equal(t.log.length, 2, "adopted: no further read");
  t.sync.dispose();
});

test("a replaced draft installs a fresh bootstrap under a new generation and fences the old one", async () => {
  const t = rig();
  t.sync.start();
  const before = t.sync.fence();
  const result = t.sync.revalidate("poll");
  await t.answer(ok(status({ currentDraftId: "d2", documentRevision: 1 })));
  const after = await result;
  assert.deepEqual(t.log, ["bootstrap:true"], "one bootstrap, and no D read of the old draft");
  assert.equal(before(), false);
  assert.ok(after.kind === "current" && after.generation > 1 && after.status.currentDraftId === "d2");
  t.sync.dispose();
});

test("a role or lifecycle change reloads the project (editability) without a separate D read", async () => {
  const t = rig();
  t.sync.start();
  const result = t.sync.revalidate("poll");
  await t.answer(ok(status({ role: "VIEWER", documentRevision: 3 })));
  await result;
  assert.deepEqual(t.log, ["bootstrap:true"]);
  t.sync.dispose();
});

test("a status result from a discarded generation adopts nothing and cannot undo a newer one", async () => {
  const t = rig();
  t.sync.start();
  const old = t.sync.revalidate("focus"); // request 1, generation 1
  t.sync.dispose();
  t.sync.start(); // generation 2
  const fresh = t.sync.revalidate("focus"); // request 2
  await t.answer(ok(status({ role: "VIEWER", documentRevision: 1 }))); // the older request answers first, late
  await t.answer(ok(status({ role: "OWNER", documentRevision: 2 })));
  assert.equal((await old).kind, "unavailable");
  assert.equal((await fresh).kind, "current");
  assert.deepEqual(t.log, ["read:true"], "only the newer result acted");
  assert.deepEqual(t.published.map((state) => state.status.role), ["OWNER"]);
  t.sync.dispose();
});

test("beforeWrite is immediate while authority is current and waits for one revalidation once invalidated", async () => {
  const t = rig();
  t.sync.start();
  const now = await t.sync.beforeWrite();
  assert.ok(now.kind === "current" && now.status.role === "OWNER");
  assert.equal(t.pending.length, 0);
  t.sync.invalidate();
  const waiting = t.sync.beforeWrite();
  await settle();
  assert.equal(t.pending.length, 1);
  await t.answer(ok(status({ role: "EDITOR" })));
  const after = await waiting;
  assert.ok(after.kind === "current" && after.status.role === "EDITOR");
  assert.equal((await t.sync.beforeWrite()).kind, "current");
  assert.equal(t.pending.length, 0);
  t.sync.dispose();
});

test("beforeWrite reports unavailable after a failed read and denied after 403/404, and recovers on success", async () => {
  const t = rig();
  t.sync.start();
  const down = t.sync.beforeWrite; // authority is current, so fail a poll first
  await t.advance(10_000);
  await t.answer(fail(0));
  const blocked = down();
  await settle();
  await t.answer(fail(503));
  assert.equal((await blocked).kind, "unavailable");
  const gone = down();
  await settle();
  await t.answer(fail(404));
  assert.equal((await gone).kind, "denied");
  assert.deepEqual(t.log, ["bootstrap:true"], "the shell's own unavailable-project path runs; nothing is adopted");
  const back = down();
  await settle();
  await t.answer(ok(status()));
  assert.equal((await back).kind, "current");
  t.sync.dispose();
});

test("a 401 ends the session and stops the controller: no timer, no fetch, nothing adopted", async () => {
  const t = rig();
  t.sync.start();
  await t.advance(10_000);
  await t.answer(fail(401));
  assert.equal(t.timers.length, 0);
  assert.equal((await t.sync.revalidate("manual")).kind, "unavailable");
  assert.equal(t.pending.length, 0);
  assert.deepEqual(t.log, ["session"]);
  t.sync.dispose();
});

test("pending work on a replaced draft is stranded (read-only recovery); the current draft's and empty work are not", () => {
  const old = { id: "d1", documentRevision: 1, layoutRevision: 1 } as unknown as DraftView;
  const withEntry: Outbox = { ...emptyOutbox, base: old, entries: [{ kind: "drop", flowId: "f", items: [] }] };
  assert.equal(stranded(withEntry, "d2"), true);
  assert.equal(stranded(withEntry, "d1"), false);
  assert.equal(stranded({ ...emptyOutbox, base: old }, "d2"), false);
  assert.equal(stranded(emptyOutbox, "d2"), false);
});

const fire = (t: ReturnType<typeof rig>, reason: VisibilityEvent) => { for (const on of [...t.listeners]) on(reason); };

test("focus, online and visibility return invalidate authority: a write waits for the request they start", async () => {
  for (const reason of ["focus", "reconnect"] as const) {
    const t = rig();
    t.sync.start();
    fire(t, reason);
    await settle();
    assert.equal(t.pending.length, 1);
    let admitted = false;
    const write = t.sync.beforeWrite().then((result) => { admitted = true; return result; });
    await settle();
    assert.equal(admitted, false, "no write while the status request is unanswered");
    assert.equal(t.pending.length, 1, "the write shares the event's request instead of starting another");
    await t.answer(ok(status({ role: "VIEWER" })));
    const result = await write;
    assert.ok(result.kind === "current" && result.status.role === "VIEWER");
    assert.equal(t.pending.length, 0);
    t.sync.dispose();
  }
});

test("focus and visibilitychange together cost one status request; an event during a poll still gets its own", async () => {
  const t = rig();
  t.sync.start();
  fire(t, "focus"); fire(t, "focus");
  await settle();
  assert.equal(t.pending.length, 1);
  await t.answer(ok(status()));
  assert.equal(t.pending.length, 0);
  await t.advance(10_000);
  assert.equal(t.pending.length, 1, "a poll is in flight");
  fire(t, "focus");
  const write = t.sync.beforeWrite();
  await t.answer(ok(status()));
  assert.equal(t.pending.length, 1, "the poll predates the event, so one follow-up is required");
  await t.answer(ok(status()));
  assert.equal((await write).kind, "current");
  t.sync.dispose();
});

test("a Realtime-started read (subscribed, hint) in flight does not swallow a focus: the return event gets its own read", async () => {
  for (const reason of ["subscribed", "hint"] as const) {
    const t = rig();
    t.sync.start();
    void t.sync.revalidate(reason);
    await settle();
    assert.equal(t.pending.length, 1);
    fire(t, "focus");
    const write = t.sync.beforeWrite();
    await t.answer(ok(status()));
    assert.equal(t.pending.length, 1, reason + " predates the focus, so one follow-up is required");
    await t.answer(ok(status()));
    assert.equal((await write).kind, "current");
    t.sync.dispose();
  }
});

test("a failed status read after an event keeps writes blocked until a later read succeeds", async () => {
  const t = rig();
  t.sync.start();
  fire(t, "reconnect");
  await settle();
  await t.answer(fail(503));
  const blocked = t.sync.beforeWrite();
  await settle();
  await t.answer(fail(503));
  assert.equal((await blocked).kind, "unavailable");
  const back = t.sync.beforeWrite();
  await settle();
  await t.answer(ok(status()));
  assert.equal((await back).kind, "current");
  t.sync.dispose();
});

test("going hidden invalidates without a request; a background write then revalidates, and the return event is not folded into an older request", async () => {
  const t = rig();
  t.sync.start();
  fire(t, "hidden");
  t.setHidden(true);
  await settle();
  assert.equal(t.pending.length, 0, "hiding only invalidates: polling stays paused");
  const write = t.sync.beforeWrite(); // background autosave
  await settle();
  assert.equal(t.pending.length, 1, "before-save revalidation is allowed while hidden");
  await t.answer(ok(status({ role: "VIEWER" })));
  const result = await write;
  assert.ok(result.kind === "current" && result.status.role === "VIEWER");

  // A request that started before the hide does not cover a later write or the return event.
  const t2 = rig();
  t2.sync.start();
  fire(t2, "focus");
  await settle();
  assert.equal(t2.pending.length, 1);
  fire(t2, "hidden");
  const write2 = t2.sync.beforeWrite();
  await t2.answer(ok(status()));
  assert.equal(t2.pending.length, 1, "the write waits for a request that started after the hide");
  await t2.answer(ok(status()));
  assert.equal((await write2).kind, "current");
  t.sync.dispose(); t2.sync.dispose();
});

test("blur invalidates without a request; the next write revalidates", async () => {
  const t = rig();
  t.sync.start();
  fire(t, "blur");
  await settle();
  assert.equal(t.pending.length, 0);
  const write = t.sync.beforeWrite();
  await settle();
  assert.equal(t.pending.length, 1, "the write waits for a status read");
  await t.answer(ok(status()));
  assert.equal((await write).kind, "current");
  t.sync.dispose();
});

test("a stopped controller fences an authority result that had already resolved", async () => {
  const t = rig();
  t.sync.start();
  const write = t.sync.beforeWrite();
  const admitted = await write;
  assert.equal(admitted.kind, "current");
  const stillCurrent = t.sync.fence(admitted.kind === "current" ? admitted.generation : 0);
  assert.equal(stillCurrent(), true);
  await t.advance(10_000);
  await t.answer(ok(status({ viewerId: "someone-else" })));
  assert.equal(stillCurrent(), false, "account change bumps the generation");
  t.sync.dispose();
});

test("a status for another account is an account change: the controller stops, nothing is adopted, the shell is told once", async () => {
  const t = rig();
  t.sync.start();
  await t.advance(10_000);
  await t.answer(ok(status({ viewerId: "someone-else", role: "VIEWER", documentRevision: 9 })));
  assert.deepEqual(t.log, ["account"], "no read, no bootstrap");
  assert.equal(t.published.length, 0);
  assert.equal(t.timers.length, 0);
  assert.equal((await t.sync.revalidate("manual")).kind, "unavailable");
  assert.equal((await t.sync.beforeWrite()).kind, "unavailable");
  assert.equal(t.pending.length, 0);
  t.sync.dispose();
});

test("a 401 from a disposed generation cannot end the new session", async () => {
  const t = rig();
  t.sync.start();
  void t.sync.revalidate("manual");
  assert.equal(t.pending.length, 1);
  t.sync.dispose();
  t.sync.start();
  await t.answer(fail(401));
  assert.deepEqual(t.log, []);
  const current = t.sync.revalidate("manual");
  assert.equal(t.pending.length, 1, "the replacement controller remains usable");
  await t.answer(ok(status()));
  assert.equal((await current).kind, "current");
  t.sync.dispose();
});

test("a follow-up queued behind an account-change stop never fetches, so the shell is told exactly once", async () => {
  const t = rig();
  t.sync.start();
  await t.advance(10_000); // the poll is in flight
  const queued = t.sync.revalidate("manual"); // queued behind it
  await t.answer(ok(status({ viewerId: "someone-else" })));
  assert.equal(t.pending.length, 0, "no second status request after the stop");
  assert.deepEqual(t.log, ["account"]);
  assert.equal((await queued).kind, "unavailable");
  t.sync.dispose();
});

test("statusDelay: the degraded base is 5 s and backs off like the normal one", () => {
  assert.deepEqual([0, 1, 2, 3].map((failures) => statusDelay(failures, 0.5, true)), [5_000, 10_000, 20_000, 20_000]);
  assert.deepEqual([0, 1, 2, 3].map((failures) => statusDelay(failures, 0.5, true, true)), [2_000, 4_000, 8_000, 8_000]);
  assert.equal(statusDelay(0, 0.5, false), 10_000);
});

test("an active visible job uses the 2 s cadence and closing it restores the current cadence", () => {
  const t = rig();
  t.sync.start();
  t.sync.setActiveJobVisible(true);
  assert.deepEqual(t.timers.map((timer) => timer.ms), [2_000]);
  t.sync.setDegraded(true);
  assert.deepEqual(t.timers.map((timer) => timer.ms), [2_000]);
  t.sync.setActiveJobVisible(false);
  assert.deepEqual(t.timers.map((timer) => timer.ms), [5_000]);
  t.sync.setDegraded(false);
  assert.deepEqual(t.timers.map((timer) => timer.ms), [10_000]);
  t.sync.dispose();
  assert.equal(t.timers.length, 0);
});

test("successful status cycles reconcile resources, including identical and AI-only changes, without draft reads", async () => {
  const calls: Array<{ aiRevision: number; current: boolean }> = [];
  const t = rig(status(), async (next, fence) => { calls.push({ aiRevision: next.aiRevision, current: fence() }); });
  t.sync.start();
  const first = t.sync.revalidate("manual");
  await t.answer(ok(status()));
  await first;
  await t.advance(10_000);
  await t.answer(ok(status()));
  await t.advance(10_000);
  await t.answer(ok(status({ aiRevision: 1 })));
  assert.deepEqual(calls, [{ aiRevision: 0, current: true }, { aiRevision: 0, current: true }, { aiRevision: 1, current: true }]);
  assert.deepEqual(t.log, []);
  t.sync.dispose();
});

test("a resource failure leaves authority current and the status timer running", async () => {
  const t = rig(status(), async () => { throw new Error("resource unavailable"); });
  t.sync.start();
  const result = t.sync.revalidate("manual");
  await t.answer(ok(status()));
  assert.equal((await result).kind, "current");
  assert.equal((await t.sync.beforeWrite()).kind, "current");
  assert.deepEqual(t.timers.map((timer) => timer.ms), [10_000]);
  t.sync.dispose();
});

test("degraded moves the waiting poll to 5 s and recovery back to 10 s, always with exactly one timer", async () => {
  const t = rig();
  t.sync.start();
  t.sync.setDegraded(true);
  assert.deepEqual(t.timers.map((timer) => timer.ms), [5_000]);
  t.sync.setDegraded(true);
  assert.equal(t.timers.length, 1);
  await t.advance(5_000);
  await t.answer(ok(status()));
  assert.deepEqual(t.timers.map((timer) => timer.ms), [5_000], "the next poll keeps the degraded cadence");
  t.sync.setDegraded(false);
  assert.deepEqual(t.timers.map((timer) => timer.ms), [10_000]);
  await t.advance(10_000);
  t.sync.setDegraded(true); // mid-request: no timer yet, the request schedules its own follow-up
  assert.equal(t.timers.length, 0);
  await t.answer(ok(status()));
  assert.deepEqual(t.timers.map((timer) => timer.ms), [5_000]);
  t.sync.dispose();
  assert.equal(t.timers.length, 0);
});

// ---- Realtime session (04.3): a typed fake transport proves lifecycle order, not RLS or delivery. ----
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = uuid(1), E1 = uuid(2), E2 = uuid(3), D1 = uuid(4), D2 = uuid(5), F1 = uuid(6), F2 = uuid(7), ME = uuid(8), ME_PROFILE = uuid(9), PEER = uuid(10), PEER_PROFILE = uuid(11), NODE = uuid(12);
const SCOPE: LiveScope = { projectId: P, epoch: E1, draftId: D1, profileId: ME_PROFILE, canSend: true };
type Wire = {
  scope: Parameters<RealtimeTransport["connect"]>[0]; handlers: Parameters<RealtimeTransport["connect"]>[1];
  sent: PeerMessage[]; tracked: PresenceState[]; disposed: boolean;
};

function liveRig() {
  let clock = 1_000, step = 0; // step > 0: every clock read advances the clock after returning
  const timers: { at: number; fn: () => void }[] = [];
  const wires: Wire[] = [];
  const calls = { revalidate: [] as string[], degraded: [] as boolean[] };
  const transport: RealtimeTransport = {
    connect(scope, handlers) {
      const wire: Wire = { scope, handlers, sent: [], tracked: [], disposed: false };
      wires.push(wire);
      return { sendPeer: (message) => wire.sent.push(message), trackPresence: (state) => wire.tracked.push(state), dispose: async () => { wire.disposed = true; } };
    },
  };
  let revalidate = (reason: string) => { calls.revalidate.push(reason); };
  const live = createProjectLive({
    transport, sessionId: ME, now: () => { const at = clock; clock += step; return at; },
    setTimer: (fn, ms) => { const timer = { at: clock + ms, fn }; timers.push(timer); return () => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); }; },
    revalidate: (reason) => revalidate(reason),
    degraded: (on) => calls.degraded.push(on),
  });
  const harness = {
    live, wires, timers, calls,
    tick(ms: number) { step = ms; },
    get current() { return wires.at(-1)!; },
    liveWires: () => wires.filter((wire) => !wire.disposed),
    onRevalidate(fn: (reason: string) => void) { revalidate = fn; },
    async advance(ms: number) {
      const until = clock + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock = due.at;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
        await settle();
      }
      clock = until;
    },
    state: (value: LiveState) => wires.at(-1)!.handlers.state(value),
    /** Connected, subscribed and standing on flow F1: ready to send. */
    async ready(scope = SCOPE) {
      live.setScope(scope);
      live.setPresence({ flowId: F1, selection: null });
      harness.state("subscribed");
      await harness.advance(0);
    },
  };
  return harness;
}
const peerPresence = (over: Partial<PresenceState> & { presence_ref?: string } = {}) => ({
  projectId: P, epoch: E1, draftId: D1, flowId: F1, sessionId: PEER, profileId: PEER_PROFILE, selection: null, presence_ref: "ref-1", ...over,
});
const wireMessage = (over: Record<string, unknown>) => ({ projectId: P, epoch: E1, draftId: D1, flowId: F1, sessionId: PEER, sequence: 1, type: "CURSOR", x: 5, y: 6, ...over });
const savedDraft = (positionVersion: number) => ({
  id: D1, document: { nodes: { [NODE]: { flowId: F1 } } }, layout: { positions: { [NODE]: { x: 0, y: 0, version: positionVersion } } },
}) as unknown as Parameters<typeof savedViewOf>[0];
const dragOf = (version: number, gestureId = "g1") => ({
  projectId: P, epoch: E1, draftId: D1, flowId: F1, sessionId: PEER, sequence: 1, type: "DRAG_PREVIEW", gestureId, items: [{ nodeId: NODE, x: 10, y: 20, basePositionVersion: version }],
});
const item = (x: number, y: number) => ({ nodeId: NODE, x, y, basePositionVersion: 1 });

test("live: joins the bootstrap's topics; SUBSCRIBED revalidates once and clears the degraded flag", () => {
  const t = liveRig();
  t.live.setScope(SCOPE);
  t.live.setScope({ ...SCOPE });
  assert.equal(t.wires.length, 1, "an unchanged scope keeps the connection");
  assert.deepEqual(t.current.scope, { projectId: P, epoch: E1, topics: realtimeTopics(P, E1) });
  assert.equal(t.live.state(), "connecting");
  t.state("subscribed");
  t.state("subscribed");
  assert.deepEqual(t.calls.revalidate, ["subscribed"]);
  t.state("degraded");
  t.state("subscribed");
  assert.deepEqual(t.calls.revalidate, ["subscribed", "subscribed"], "a rejoin also closes its gap");
  assert.deepEqual(t.calls.degraded, [true, false]);
});

test("live: hints are checked against project and epoch, then debounced 100 ms into one revalidation", async () => {
  const t = liveRig();
  t.live.setScope(SCOPE);
  const hint = (over: Record<string, unknown> = {}) => t.current.handlers.hint({ type: "PROJECT_CHANGED", projectId: P, epoch: E1, eventSequence: 7, ...over });
  for (const bad of [{ projectId: uuid(99) }, { epoch: E2 }, { eventSequence: -1 }, { type: "OTHER" }, { extra: 1 }]) hint(bad);
  t.current.handlers.hint("PROJECT_CHANGED");
  t.current.handlers.hint(null);
  await t.advance(1_000);
  assert.deepEqual(t.calls.revalidate, [], "invalid or other-context hints do nothing");
  hint(); await t.advance(60); hint(); hint();
  await t.advance(39);
  assert.deepEqual(t.calls.revalidate, []);
  await t.advance(1);
  assert.deepEqual(t.calls.revalidate, ["hint"], "a burst is one revalidation");
  hint({ id: "provider-id" }); // the provider adds an id to a sent payload
  await t.advance(100);
  assert.deepEqual(t.calls.revalidate, ["hint", "hint"]);
});

test("live + controller: a hint burst is one request in flight and one trailing", async () => {
  const s = rig(), t = liveRig();
  s.sync.start();
  t.onRevalidate((reason) => { void s.sync.revalidate(reason as "hint"); });
  t.live.setScope(SCOPE);
  const hint = () => t.current.handlers.hint({ type: "PROJECT_CHANGED", projectId: P, epoch: E1, eventSequence: 2 });
  hint(); await t.advance(100);
  assert.equal(s.pending.length, 1);
  hint(); hint(); await t.advance(100); hint(); await t.advance(100);
  assert.equal(s.pending.length, 1, "still one request in flight");
  await s.answer(ok(status()));
  assert.equal(s.pending.length, 1, "one trailing request for every hint that arrived meanwhile");
  await s.answer(ok(status()));
  assert.equal(s.pending.length, 0);
  assert.equal(s.timers.length, 1, "the poll stays a single timer");
  s.sync.dispose();
});

test("live: a status epoch or draft change replaces the connection under a new generation; old callbacks are ignored", async () => {
  const t = liveRig();
  t.live.setScope(SCOPE);
  const old = t.current;
  t.live.setScope({ ...SCOPE, canSend: false }); // a role change only: no reconnect
  assert.equal(t.wires.length, 1);
  t.live.setScope({ ...SCOPE, epoch: E2 });
  assert.equal(t.wires.length, 2);
  assert.equal(old.disposed, true);
  assert.deepEqual(t.current.scope.topics, realtimeTopics(P, E2));
  t.live.setScope({ ...SCOPE, epoch: E2, draftId: D2 });
  assert.equal(t.wires.length, 3);
  assert.deepEqual(t.liveWires().map((wire) => wire.scope.topics), [realtimeTopics(P, E2)]);
  // Everything the older generations report afterwards is dropped.
  old.handlers.state("subscribed");
  old.handlers.hint({ type: "PROJECT_CHANGED", projectId: P, epoch: E1, eventSequence: 9 });
  old.handlers.peer(wireMessage({}));
  old.handlers.presence([peerPresence()]);
  t.wires[1]!.handlers.state("degraded");
  await t.advance(1_000);
  assert.deepEqual(t.calls.revalidate, []);
  assert.deepEqual(t.calls.degraded, []);
  assert.equal(t.live.state(), "connecting");
  assert.deepEqual(t.live.roster(), []);
  assert.equal(t.timers.length, 0);
});

test("live: movement is one trailing 125 ms scheduler keeping only the newest; DRAG_END supersedes a pending preview", async () => {
  const t = liveRig();
  await t.ready();
  for (let x = 1; x <= 5; x++) { t.live.sendCursor({ x, y: x }); await t.advance(10); }
  assert.equal(t.current.sent.length, 0, "nothing goes out before the trailing tick");
  await t.advance(75);
  assert.deepEqual(t.current.sent.map((m) => m.type === "CURSOR" && [m.x, m.y, m.sequence, m.flowId, m.sessionId]), [[5, 5, 1, F1, ME]]);
  t.live.sendCursor({ x: 8, y: 8 });
  t.live.sendDrag("g1", [item(1, 2)]);
  await t.advance(125);
  assert.deepEqual(t.current.sent.slice(1).map((m) => m.type), ["DRAG_PREVIEW"], "the newest pending replaces the cursor");
  t.live.sendDrag("g1", [item(3, 4)]);
  t.live.endDrag("g1");
  t.live.sendCursor({ x: 9, y: 9 }); // movement never displaces an unsent end
  await t.advance(125);
  assert.deepEqual(t.current.sent.slice(2).map((m) => m.type), ["DRAG_END"]);
  assert.deepEqual(t.current.sent.map((m) => m.sequence), [1, 2, 3], "strictly increasing");
  assert.equal(t.timers.length, 0);
  t.live.sendCursor({ x: 1, y: 1 });
  t.live.sendCursor(null); // the pointer left the canvas
  await t.advance(500);
  assert.equal(t.current.sent.length, 3);
});

test("live: the sender's sequence keeps counting across flow changes and reconnects for the provider's lifetime", async () => {
  const t = liveRig();
  await t.ready();
  t.live.sendCursor({ x: 1, y: 1 }); await t.advance(125);
  t.live.setPresence({ flowId: F2, selection: null });
  t.live.sendCursor({ x: 2, y: 2 }); await t.advance(125);
  t.live.setScope({ ...SCOPE, epoch: E2 });
  t.state("subscribed"); await t.advance(0);
  t.live.sendCursor({ x: 3, y: 3 }); await t.advance(125);
  const all = t.wires.flatMap((wire) => wire.sent);
  assert.deepEqual(all.map((m) => [m.sequence, m.flowId, m.sessionId]), [[1, F1, ME], [2, F2, ME], [3, F2, ME]]);
});

test("live: nothing is sent unless both channels are subscribed, the viewer is an editor and a flow is open", async () => {
  const t = liveRig();
  t.live.setScope(SCOPE);
  t.live.setPresence({ flowId: F1, selection: null });
  t.live.sendCursor({ x: 1, y: 1 });
  await t.advance(1_000);
  assert.equal(t.current.sent.length + t.current.tracked.length, 0, "connecting");
  t.state("subscribed"); await t.advance(0);
  t.live.sendCursor({ x: 1, y: 1 });
  t.state("degraded"); // the pending movement is dropped with the state
  await t.advance(1_000);
  assert.equal(t.current.sent.length, 0);
  t.live.sendCursor({ x: 2, y: 2 });
  await t.advance(1_000);
  assert.equal(t.current.sent.length, 0, "no fallback while degraded");
  t.state("subscribed"); await t.advance(0);
  t.live.setScope({ ...SCOPE, canSend: false });
  t.live.sendCursor({ x: 3, y: 3 }); t.live.sendDrag("g", [item(1, 1)]); t.live.endDrag("g");
  await t.advance(1_000);
  assert.equal(t.current.sent.length, 0, "a viewer or archived project never sends previews");
  assert.ok(t.current.tracked.length >= 1, "but every member tracks Presence");
  t.live.setScope({ ...SCOPE, epoch: E2 });
  t.state("subscribed"); await t.advance(0);
  t.live.setPresence({ flowId: null, selection: null });
  t.live.sendCursor({ x: 1, y: 1 });
  await t.advance(1_000);
  assert.equal(t.current.sent.length, 0, "no flow, no cursor");
  t.live.setPresence({ flowId: F1, selection: null });
  t.live.sendDrag("g", []); // outside the wire limits: refused by the sender too
  await t.advance(125);
  assert.equal(t.current.sent.length, 0);
});

test("live: Presence tracks after join, then on selection or flow change at most once per second, never with coordinates", async () => {
  const t = liveRig();
  t.live.setScope(SCOPE);
  t.state("subscribed"); await t.advance(0);
  assert.equal(t.current.tracked.length, 1);
  assert.deepEqual(t.current.tracked[0], { projectId: P, epoch: E1, draftId: D1, flowId: null, sessionId: ME, profileId: ME_PROFILE, selection: null });
  t.live.setPresence({ flowId: F1, selection: null });
  t.live.setPresence({ flowId: F1, selection: { kind: "NODES", ids: [NODE] } });
  t.live.setPresence({ flowId: F1, selection: { kind: "FLOW", ids: [F1] } });
  await t.advance(900);
  assert.equal(t.current.tracked.length, 1, "within the second");
  await t.advance(100);
  assert.equal(t.current.tracked.length, 2);
  assert.deepEqual(t.current.tracked[1]!.selection, { kind: "FLOW", ids: [F1] }, "only the latest claim goes out");
  t.live.setPresence({ flowId: F1, selection: { kind: "FLOW", ids: [F1] } }); // unchanged
  await t.advance(2_000);
  assert.equal(t.current.tracked.length, 2);
  assert.ok(t.current.tracked.every((state) => !("x" in state) && !("y" in state) && Object.keys(state).length === 7));
});

test("live: Presence feeds the roster (own, other-draft and malformed entries excluded; presence_ref stripped) and only rostered peers draw", async () => {
  const t = liveRig();
  await t.ready();
  t.live.setSavedView(savedViewOf(savedDraft(1)));
  t.current.handlers.peer(wireMessage({ sequence: 1 }));
  assert.deepEqual(t.live.snapshot().cursors, [], "a packet before the first Presence sync draws nothing");
  let notified = 0;
  t.live.subscribe(() => { notified++; });
  t.current.handlers.presence([
    peerPresence(), peerPresence({ sessionId: ME }), peerPresence({ sessionId: uuid(20), draftId: D2 }), peerPresence({ sessionId: uuid(21), epoch: E2 }),
    { ...peerPresence({ sessionId: uuid(22) }), email: "x@y.z" }, "junk", null,
  ]);
  assert.deepEqual(t.live.roster().map((entry) => entry.sessionId), [PEER]);
  assert.ok(!("presence_ref" in t.live.roster()[0]!));
  assert.equal(notified, 1);
  t.current.handlers.presence([peerPresence({ presence_ref: "ref-2" })]);
  assert.equal(notified, 1, "an unchanged roster does not notify");
  t.current.handlers.peer(wireMessage({ sequence: 2 }));
  assert.deepEqual(t.live.snapshot().cursors, [{ sessionId: PEER, x: 5, y: 6 }]);
  t.current.handlers.peer(wireMessage({ sequence: 3, draftId: D2, x: 1 })); // another draft's packet
  t.current.handlers.peer(wireMessage({ sequence: 4, flowId: F2, x: 2 }));
  t.current.handlers.peer(wireMessage({ sessionId: ME, sequence: 9, x: 3 }));
  t.current.handlers.peer({ ...wireMessage({ sequence: 5 }), label: "x" });
  assert.deepEqual(t.live.snapshot().cursors, [{ sessionId: PEER, x: 5, y: 6 }]);
  // The roster survives a flow change (setContext runs before syncSessions), and the peer draws again on the new flow.
  t.live.setPresence({ flowId: F2, selection: null });
  assert.deepEqual(t.live.snapshot().cursors, []);
  t.current.handlers.peer(wireMessage({ sequence: 1, flowId: F2, x: 7, y: 8 }));
  assert.deepEqual(t.live.snapshot().cursors, [{ sessionId: PEER, x: 7, y: 8 }]);
  t.current.handlers.presence([]);
  assert.deepEqual(t.live.snapshot().cursors, [], "a departed session loses its visuals");
});

test("live: previews are validated against the adopted saved draft and reconciled after every adoption; a drop clears overlays", async () => {
  const t = liveRig();
  await t.ready();
  t.current.handlers.presence([peerPresence()]);
  t.current.handlers.peer(dragOf(1));
  assert.deepEqual(t.live.snapshot().drags, [], "no saved view adopted yet");
  t.live.setSavedView(savedViewOf(savedDraft(1)));
  t.current.handlers.peer({ ...dragOf(1), sequence: 2 });
  assert.equal(t.live.snapshot().drags.length, 1);
  t.live.setSavedView(savedViewOf(savedDraft(2))); // a save moved the node
  assert.deepEqual(t.live.snapshot().drags, []);
  t.current.handlers.peer({ ...dragOf(2), sequence: 3 });
  assert.equal(t.live.snapshot().drags.length, 1);
  t.state("degraded");
  assert.deepEqual(t.live.snapshot(), { cursors: [], drags: [] });
  assert.equal(t.live.roster().length, 1, "the roster waits for the next sync");
});

test("live: StrictMode double mount, remount and project switch leave one connection, no obsolete timers or callbacks", async () => {
  const t = liveRig();
  t.live.setScope(SCOPE); t.live.setScope(null); t.live.setScope(SCOPE); // a simulated unmount and remount of the same provider
  assert.equal(t.wires.length, 2);
  assert.deepEqual(t.liveWires(), [t.wires[1]]);
  t.wires[0]!.handlers.state("subscribed");
  t.wires[0]!.handlers.hint({ type: "PROJECT_CHANGED", projectId: P, epoch: E1, eventSequence: 1 });
  await t.advance(1_000);
  assert.deepEqual(t.calls.revalidate, []);
  t.state("subscribed"); await t.advance(0);
  t.live.setPresence({ flowId: F1, selection: null });
  t.current.handlers.hint({ type: "PROJECT_CHANGED", projectId: P, epoch: E1, eventSequence: 2 });
  t.live.sendCursor({ x: 1, y: 1 });
  assert.ok(t.timers.length > 0);
  t.live.setScope(null); // sign-out, project switch or unmount
  assert.equal(t.liveWires().length, 0);
  assert.equal(t.timers.length, 0, "pending hint, movement and Presence timers are cancelled");
  await t.advance(5_000);
  assert.deepEqual(t.calls.revalidate, ["subscribed"]);
  assert.equal(t.wires.flatMap((wire) => wire.sent).length, 0);
  // A different project mounts its own session (the old one is unmounted): only its callbacks count.
  const other = liveRig();
  other.live.setScope({ ...SCOPE, projectId: uuid(50) });
  assert.equal(other.liveWires().length, 1);
  t.wires[1]!.handlers.state("subscribed"); // the unmounted session's late callback
  assert.deepEqual(other.calls.revalidate, []);
  other.state("subscribed");
  assert.deepEqual(other.calls.revalidate, ["subscribed"]);
  assert.deepEqual(t.calls.revalidate, ["subscribed"], "the old session heard nothing more");
  other.live.setScope(null);
  assert.equal(other.liveWires().length + other.timers.length, 0);
});

test("SUBSCRIBED invalidates authority: a write after a (re)join waits for the status read it starts", async () => {
  const s = rig(), t = liveRig();
  s.sync.start();
  t.onRevalidate((reason) => { void s.sync.revalidate(reason as "subscribed"); });
  t.live.setScope(SCOPE);
  t.state("subscribed");
  await settle();
  assert.equal(s.pending.length, 1);
  let admitted = false;
  const write = s.sync.beforeWrite().then((result) => { admitted = true; return result; });
  await settle();
  assert.equal(admitted, false, "not admitted before the status answers");
  assert.equal(s.pending.length, 1, "it shares the in-flight read");
  await s.answer(ok(status()));
  assert.equal((await write).kind, "current");
  // A rejoin after a drop does the same, even after authority was proven.
  t.state("degraded"); t.state("subscribed");
  await settle();
  const again = s.sync.beforeWrite();
  await settle();
  assert.equal(s.pending.length, 1);
  await s.answer(ok(status()));
  assert.equal((await again).kind, "current");
  s.sync.dispose();
});

test("a hint while the tab is hidden fetches nothing; a return event still revalidates", async () => {
  const s = rig();
  s.sync.start();
  s.setHidden(true);
  assert.equal((await s.sync.revalidate("hint")).kind, "unavailable");
  assert.equal(s.pending.length, 0);
  s.setHidden(false);
  void s.sync.revalidate("hint");
  assert.equal(s.pending.length, 1);
  await s.answer(ok(status()));
  s.sync.dispose();
});

test("live: snapshot and nextExpiry share one clock read, so an entry is never shown with no timer to expire it", async () => {
  const t = liveRig();
  await t.ready();
  t.live.setSavedView(savedViewOf(savedDraft(1)));
  t.current.handlers.presence([peerPresence()]);
  t.current.handlers.peer(wireMessage({ sequence: 1 }));
  const expiry = 1_000 + 2_000; // received at clock 1000, PREVIEW_TTL_MS 2000
  await t.advance(1_999); // one millisecond before the cursor expires
  t.tick(1); // the clock passes the expiry between two separate reads
  const now = expiry - 1;
  assert.equal(t.live.snapshot(now).cursors.length, 1);
  assert.equal(t.live.nextExpiry(now), expiry, "the shown entry has an expiry to arm a timer for");
});

test("live: the preview snapshot keeps its identity while unchanged and changes when a preview arrives or expires", async () => {
  const t = liveRig();
  await t.ready();
  t.live.setSavedView(savedViewOf(savedDraft(1)));
  t.current.handlers.presence([peerPresence()]);
  const empty = t.live.snapshot();
  assert.equal(t.live.snapshot(), empty);
  t.current.handlers.peer(wireMessage({ sequence: 1 }));
  const drawn = t.live.snapshot();
  assert.notEqual(drawn, empty);
  assert.equal(t.live.snapshot(), drawn);
  await t.advance(2_000);
  assert.deepEqual(t.live.snapshot().cursors, [], "an expired entry drops on the next read");
});

test("held AI resources do not block authority or the next status poll, and share one flight per generation", async () => {
  const held: Array<(value: { ok: true; data: never }) => void> = [];
  const adopted: string[] = [];
  const resources = createRunResources({
    projectId: "project",
    apiRead: <T,>() => new Promise<ApiResult<T>>((resolve) => { held.push(resolve as (value: { ok: true; data: never }) => void); }),
    adoptPage: () => { adopted.push("page"); }, adoptRun: (value) => { if (value) adopted.push("run"); },
  });
  resources.selectRun("run-1");
  const t = rig(status(), resources.reconcile);
  t.sync.start();
  t.sync.setActiveJobVisible(true);
  t.sync.invalidate();
  let current = false;
  void t.sync.beforeWrite().then((result) => { current = result.kind === "current"; });
  await t.answer(ok(status()));
  assert.equal(current, true, "status authority resolves while AI reads are held");
  assert.deepEqual(t.timers.map((timer) => timer.ms), [2_000]);
  assert.equal(held.length, 2);
  await t.advance(2_000);
  await t.answer(ok(status()));
  assert.equal(held.length, 2, "identical status shares held page/detail reads");
  await t.advance(2_000);
  await t.answer(fail(401));
  assert.deepEqual(t.log, ["session"]);
  for (const resolve of held) resolve({ ok: true, data: {} as never });
  await settle();
  assert.deepEqual(adopted, [], "session stop fences late resource adoption");
  t.sync.dispose();
});
