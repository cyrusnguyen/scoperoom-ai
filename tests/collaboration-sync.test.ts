import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectStatusView } from "../src/features/projects/contracts/project.ts";
import {
  createProjectSync, plan, statusDelay, type Live, type StatusRead, type VisibilityEvent,
} from "../src/features/collaboration/ui/project-sync.ts";
import type { DraftView } from "../src/features/drafts/contracts/scope-document.ts";
import { emptyOutbox, type Outbox } from "../src/features/studio/ui/outbox.ts";
import { stranded } from "../src/features/studio/ui/studio-ui.ts";

const status = (over: Partial<ProjectStatusView> = {}): ProjectStatusView => ({
  viewerId: "v1", status: "ACTIVE", role: "OWNER", version: 1, settingsVersion: 1, approvalPolicyVersion: 1, membershipVersion: 1, designatedApproverId: null,
  currentDraftId: "d1", documentRevision: 1, layoutRevision: 1, realtimeEpoch: "e1", eventSequence: 1, ...over,
});
const liveOf = (s: ProjectStatusView): Live => ({ role: s.role, status: s.status, draftId: s.currentDraftId, documentRevision: s.documentRevision, layoutRevision: s.layoutRevision });
const ok = (s: ProjectStatusView): StatusRead => ({ ok: true, data: s });
const fail = (code: number): StatusRead => ({ ok: false, status: code });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A fake clock, fake visibility and a status endpoint answered by hand: no real timers, no DOM. */
function rig(start = status()) {
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
    live: () => shell.live,
    readDraft: async (fence) => { log.push(`read:${fence()}`); },
    bootstrap: async (fence) => { log.push(`bootstrap:${fence()}`); },
    publish: (state) => published.push(state),
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

test("a 401 stops the controller: no timer, no fetch, nothing adopted", async () => {
  const t = rig();
  t.sync.start();
  await t.advance(10_000);
  await t.answer(fail(401));
  assert.equal(t.timers.length, 0);
  assert.equal((await t.sync.revalidate("manual")).kind, "unavailable");
  assert.equal(t.pending.length, 0);
  assert.deepEqual(t.log, []);
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
