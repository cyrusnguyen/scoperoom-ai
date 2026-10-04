import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { Client } from "pg";
import { wait } from "@trigger.dev/sdk";
import { canonicalJson, sha256 } from "../../src/features/proposals/domain/capture.ts";
import { dispatchAi } from "../../src/features/proposals/server/dispatch-ai.ts";
import type { JobDispatcher, JobRequest, ModelGateway, ModelReply, ModelRequest } from "../../src/features/proposals/server/ports.ts";
import { repairRuns } from "../../src/features/proposals/server/repair-runs.ts";
import { runAi } from "../../src/features/proposals/server/run-ai.ts";
import { runAiDelivery } from "../../src/trigger/run-ai.ts";
import { seedRun } from "../integration/support/ai-runs.ts";
import { insertProfile, insertProject, removeSchemaRows } from "../integration/support/schema-fixture.ts";
import { edgeOp, nodeOp, flowOp, proposal } from "../support/ai-results.ts";
import { requireEnv } from "../support/env.ts";
import { serializeSweeps } from "../integration/support/sweep-lock.ts";

serializeSweeps(); // repair sweeps every overdue run in the database: see sweep-lock.ts

// Worker services against the real local database through the restricted worker role, with injected fake ports only: no provider
// key, no network. Every assertion inspects persisted attempt/run/budget rows; the gateway counter is only a cross-check (<= 2).
const canRun = requireEnv(["SCOPEROOM_BOOTSTRAP_DATABASE_URL", "WORKER_DATABASE_URL", "SCOPEROOM_ENVIRONMENT_ID"]);
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
const GOOD = proposal([flowOp(), nodeOp("op2", "n1", "flow1", ["op1"]), nodeOp("op3", "n2", "flow1", ["op1"]), edgeOp("op4", "flow1", "n1", "n2", ["op2", "op3"])], { assumptions: ["Pay online"] });
const completed = (output: unknown = GOOD, usage: { inputTokens: number | null; outputTokens: number | null } = { inputTokens: 11, outputTokens: 7 }): ModelReply => ({ kind: "completed", output, requestId: "req-1", usage });

function fakeGateway(handler: (request: ModelRequest, call: number) => Promise<ModelReply> | ModelReply) {
  const requests: ModelRequest[] = [];
  const gateway: ModelGateway = { generate: async (request) => { requests.push(request); return handler(request, requests.length); } };
  return { gateway, requests };
}
function fakeDispatcher(handler: (request: JobRequest, call: number) => Promise<{ kind: "accepted"; taskId: string } | { kind: "unavailable" }> = async (_, call) => ({ kind: "accepted", taskId: `task-${call}` })) {
  const requests: JobRequest[] = [];
  const cancels: string[] = [];
  const dispatcher: JobDispatcher = {
    dispatch: async (request) => { requests.push(request); return handler(request, requests.length); },
    cancel: async (taskId) => { cancels.push(taskId); return "requested"; },
  };
  return { dispatcher, requests, cancels };
}

async function withWorld(run: (ctx: Awaited<ReturnType<typeof world>>) => Promise<void>) {
  const admin = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  await admin.connect();
  const profiles: string[] = [];
  try { await run(await world(admin, profiles)); } finally {
    try { await removeSchemaRows(admin, profiles); } finally { await admin.end(); }
  }
}
async function world(admin: Client, profiles: string[]) {
  const person = async () => { const id = await insertProfile(admin); profiles.push(id); return id; };
  /** A fresh owner (entitled) with one project and one seeded run, so each case owns its single nonterminal slot. */
  const seed = async (options: { createdAt?: Date; shape?: "QUEUED" | "RUNNING"; actor?: string } = {}) => {
    const owner = await person();
    await admin.query("insert into app.pilot_entitlement (profile_id, granted_by_operator) values ($1, gen_random_uuid())", [owner]);
    const projectId = await insertProject(admin, owner);
    const actor = options.actor ?? owner;
    if (actor !== owner) await admin.query("insert into app.project_membership (project_id, profile_id, role) values ($1, $2, 'EDITOR')", [projectId, actor]);
    const runId = await seedRun(admin, { projectId, owner, actor, createdAt: options.createdAt, shape: options.shape });
    return { owner, actor, projectId, runId };
  };
  const row = async (runId: string) => (await admin.query("select state::text, disposition::text, budget_state::text, dispatch_state::text, task_id, dispatch_lease_until, current_attempt_id, result, result_hash, failure_code, terminal_at, cancel_requested_at from app.ai_run where id = $1", [runId])).rows[0]!;
  const attempts = async (runId: string) => (await admin.query("select id, token, attempt_number, outcome::text, call_may_have_started, input_tokens, output_tokens, provider_request_id from app.ai_run_attempt where run_id = $1 order by attempt_number", [runId])).rows;
  const budget = async (owner: string) => (await admin.query("select reserved_runs, consumed_runs from app.ai_budget_day where owner_id = $1", [owner])).rows[0];
  return { admin, person, seed, row, attempts, budget };
}

test("repair delivers a never-dispatched run once with its original identity, then acknowledges it", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed, row }) => {
    const { runId } = await seed({ createdAt: ago(20) });
    const { rows: [before] } = await admin.query("select dispatch_id, execution_binding, deadline_at from app.ai_run where id = $1", [runId]);
    const { dispatcher, requests } = fakeDispatcher();
    await repairRuns(dispatcher, { batchSize: 100 });
    const mine = requests.filter((request) => request.runId === runId);
    assert.equal(mine.length, 1);
    assert.deepEqual(mine[0], { runId, dispatchId: before.dispatch_id, executionBinding: "seed-binding", deadlineAt: before.deadline_at.toISOString() }); // exactly the Data 05 payload
    assert.deepEqual(Object.keys(mine[0]!).sort(), ["deadlineAt", "dispatchId", "executionBinding", "runId"]);
    const stored = await row(runId);
    assert.equal(stored.dispatch_state, "DISPATCHED");
    assert.match(stored.task_id, /^task-/);
    assert.equal(stored.dispatch_lease_until, null);
    const again = fakeDispatcher();
    await repairRuns(again.dispatcher, { batchSize: 100 });
    assert.equal(again.requests.filter((request) => request.runId === runId).length, 0, "an acknowledged run is never delivered again");
  });
});

test("a lost acknowledgement leaves the run PENDING and repair re-delivers the same dispatch id and binding", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed, row }) => {
    const { runId } = await seed({ createdAt: ago(20) });
    const lost = fakeDispatcher(async () => { throw new Error("connection reset after the provider accepted"); });
    await repairRuns(lost.dispatcher, { batchSize: 100 });
    assert.equal((await row(runId)).dispatch_state, "PENDING");
    assert.ok((await row(runId)).dispatch_lease_until, "the lease is the backoff");
    const during = fakeDispatcher();
    await repairRuns(during.dispatcher, { batchSize: 100 });
    assert.equal(during.requests.filter((request) => request.runId === runId).length, 0, "a live lease is not re-leased");
    await admin.query("update app.ai_run set dispatch_lease_until = clock_timestamp() - interval '1 second' where id = $1", [runId]);
    const retry = fakeDispatcher(async () => ({ kind: "accepted", taskId: "task-same" }));
    await repairRuns(retry.dispatcher, { batchSize: 100 });
    const redelivered = retry.requests.filter((request) => request.runId === runId);
    assert.equal(redelivered.length, 1);
    assert.deepEqual(redelivered[0], lost.requests.find((request) => request.runId === runId)); // same dispatch id, binding and deadline: no rebinding
    assert.deepEqual([(await row(runId)).dispatch_state, (await row(runId)).task_id], ["DISPATCHED", "task-same"]);
  });
});

test("an acknowledgement from a stale lease or another dispatch id changes zero rows", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed, row }) => {
    const { runId } = await seed({ createdAt: ago(20) });
    const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL! });
    await worker.connect();
    try {
      const lease = async () => (await worker.query("select out_dispatch_id, out_lease from app.lease_ai_dispatches($1, 1, 30)", [runId])).rows[0];
      const first = await lease();
      assert.ok(first);
      assert.equal(await lease(), undefined, "no second lease while one is live");
      await admin.query("update app.ai_run set dispatch_lease_until = clock_timestamp() - interval '1 second' where id = $1", [runId]);
      const second = await lease();
      const ack = async (dispatchId: string, leaseText: string) => (await worker.query("select app.ack_ai_dispatch($1, $2, $3, 'task-x') as ok", [runId, dispatchId, leaseText])).rows[0].ok;
      assert.equal(await ack(first.out_dispatch_id, first.out_lease), false, "the earlier lease no longer matches");
      assert.equal(await ack("00000000-0000-4000-8000-000000000000", second.out_lease), false);
      assert.equal((await row(runId)).dispatch_state, "PENDING");
      assert.equal(await ack(second.out_dispatch_id, second.out_lease), true);
      assert.equal(await ack(second.out_dispatch_id, second.out_lease), false, "an acknowledgement is final");
      await assert.rejects(worker.query("update app.ai_run set task_id = 'x', dispatch_state = 'DISPATCHED' where id = $1", [runId]), (error: { code?: string }) => error.code === "42501");
    } finally { await worker.end(); }
  });
});

test("an unavailable dispatcher or an unexpected failure leaves PENDING, and the fast path races repair into one delivery", { skip: !canRun }, async () => {
  await withWorld(async ({ seed, row }) => {
    const { runId } = await seed({ createdAt: ago(20) });
    const down = fakeDispatcher(async () => ({ kind: "unavailable" }));
    await dispatchAi(runId, down.dispatcher);
    assert.equal(down.requests.length, 1);
    assert.equal((await row(runId)).dispatch_state, "PENDING");
    const throwing = fakeDispatcher(async () => { throw new Error("boom"); });
    await assert.doesNotReject(dispatchAi(runId, throwing.dispatcher)); // never fails the start request
    assert.equal(throwing.requests.length, 0, "the unavailable attempt still holds its lease");
    const second = await seed({ createdAt: ago(20) });
    const slow = fakeDispatcher(async (_, call) => { await sleep(150); return { kind: "accepted", taskId: `task-${call}` }; });
    await Promise.all([dispatchAi(second.runId, slow.dispatcher), repairRuns(slow.dispatcher, { batchSize: 100 }), dispatchAi(second.runId, slow.dispatcher)]);
    assert.equal(slow.requests.filter((request) => request.runId === second.runId).length, 1, "one lease, one delivery");
    assert.equal((await row(second.runId)).dispatch_state, "DISPATCHED");
  });
});

test("repair validates its batch size, skips cancelled or overdue runs and settles them", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed, row, budget }) => {
    const { dispatcher } = fakeDispatcher();
    for (const batchSize of [0, 101, 1.5, -1, Number.NaN]) await assert.rejects(repairRuns(dispatcher, { batchSize }), RangeError);
    const overdue = await seed({ createdAt: ago(301) });
    const cancelled = await seed({ createdAt: ago(20) });
    await admin.query("update app.ai_run set cancel_requested_at = clock_timestamp() where id = $1", [cancelled.runId]);
    const probe = fakeDispatcher();
    await repairRuns(probe.dispatcher, { batchSize: 100 });
    assert.ok(!probe.requests.some((request) => request.runId === overdue.runId || request.runId === cancelled.runId), "neither is delivered");
    assert.equal((await row(overdue.runId)).state, "TIMED_OUT"); // never dispatched: the reservation is refunded once
    assert.deepEqual(await budget(overdue.owner), { reserved_runs: 0, consumed_runs: 0 });
    assert.equal((await row(cancelled.runId)).state, "CANCELLED"); // intent on a run that never reached a provider settles at once
    assert.equal((await row(cancelled.runId)).budget_state, "RELEASED");
    assert.deepEqual(await budget(cancelled.owner), { reserved_runs: 0, consumed_runs: 0 });
    // A dispatched but unstarted cancelled run is settled too, and its task gets a best-effort cancel (never treated as terminal itself).
    const dispatched = await seed({ createdAt: ago(20) });
    await admin.query("update app.ai_run set dispatch_state = 'DISPATCHED', task_id = 'task-9', cancel_requested_at = clock_timestamp() where id = $1", [dispatched.runId]);
    const withCancel = fakeDispatcher();
    await repairRuns(withCancel.dispatcher, { batchSize: 100 });
    assert.ok(withCancel.cancels.includes("task-9"));
    assert.equal((await row(dispatched.runId)).state, "CANCELLED");
  });
});

test("a delivered run claims once, calls the gateway once and stores the validated result with its canonical hash", { skip: !canRun }, async () => {
  await withWorld(async ({ seed, row, attempts, budget }) => {
    const { runId, owner } = await seed({ createdAt: ago(5) });
    const { gateway, requests } = fakeGateway(() => completed());
    await runAi(runId, gateway);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.runId, runId);
    assert.equal(requests[0]!.model, "seed-model");
    assert.ok(requests[0]!.timeoutMs > 0 && requests[0]!.timeoutMs <= 120_000);
    const stored = await row(runId);
    assert.deepEqual([stored.state, stored.disposition, stored.budget_state], ["SUCCEEDED", "AVAILABLE", "CONSUMED"]);
    assert.deepEqual(stored.result, GOOD);
    assert.equal(stored.result_hash, sha256(canonicalJson(stored.result)));
    const rows = await attempts(runId);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].attempt_number, rows[0].outcome, rows[0].call_may_have_started, rows[0].input_tokens, rows[0].output_tokens, rows[0].provider_request_id], [1, "COMPLETED", true, 11, 7, "req-1"]);
    assert.deepEqual(await budget(owner), { reserved_runs: 0, consumed_runs: 1 });
    await runAi(runId, gateway); // a duplicate delivery after success finds a terminal run
    assert.equal(requests.length, 1);
    assert.equal((await attempts(runId)).length, 1);
  });
});

test("unknown token usage is stored as unknown, never zero", { skip: !canRun }, async () => {
  await withWorld(async ({ seed, attempts }) => {
    const { runId } = await seed({ createdAt: ago(5) });
    await runAi(runId, fakeGateway(() => completed(GOOD, { inputTokens: null, outputTokens: null })).gateway);
    const [attempt] = await attempts(runId);
    assert.deepEqual([attempt.input_tokens, attempt.output_tokens], [null, null]);
  });
});

test("duplicate workers racing one run produce one claim and one provider call", { skip: !canRun }, async () => {
  await withWorld(async ({ seed, row, attempts }) => {
    const { runId } = await seed({ createdAt: ago(5) });
    const { gateway, requests } = fakeGateway(async () => { await sleep(300); return completed(); });
    await Promise.all([runAi(runId, gateway), runAi(runId, gateway), runAi(runId, gateway)]);
    assert.equal(requests.length, 1);
    assert.equal((await attempts(runId)).length, 1);
    assert.equal((await row(runId)).state, "SUCCEEDED");
  });
});

test("an invalid model result never becomes SUCCEEDED: the run fails with a safe code and keeps its consumed call", { skip: !canRun }, async () => {
  await withWorld(async ({ seed, row, attempts, budget }) => {
    const { runId, owner } = await seed({ createdAt: ago(5) });
    const { gateway, requests } = fakeGateway(() => completed({ schemaVersion: 1, kind: "proposal", operations: [{ id: "op1", dependsOn: [], edit: { command: "DELETE_NODES", payload: {} } }], assumptions: [], citations: [] }));
    await runAi(runId, gateway);
    const stored = await row(runId);
    assert.deepEqual([stored.state, stored.failure_code, stored.result, stored.result_hash, stored.disposition], ["FAILED", "RESULT_INVALID", null, null, null]);
    assert.equal(requests.length, 1, "a malformed result is never retried");
    assert.equal((await attempts(runId))[0].outcome, "INCOMPLETE");
    assert.deepEqual(await budget(owner), { reserved_runs: 0, consumed_runs: 1 });
  });
});

test("refusal fails the run without a second call, while unavailable and unknown replies take at most one fresh claim", { skip: !canRun }, async () => {
  await withWorld(async ({ seed, row, attempts }) => {
    const refused = await seed({ createdAt: ago(5) });
    const a = fakeGateway(() => ({ kind: "refused" }));
    await runAi(refused.runId, a.gateway);
    assert.deepEqual([(await row(refused.runId)).state, (await row(refused.runId)).failure_code, a.requests.length], ["FAILED", "MODEL_REFUSED", 1]);
    const flaky = await seed({ createdAt: ago(5) });
    const b = fakeGateway((_, call) => (call === 1 ? { kind: "unavailable", retryAfterMs: 10 } : completed()));
    await runAi(flaky.runId, b.gateway);
    assert.equal(b.requests.length, 2);
    assert.deepEqual((await attempts(flaky.runId)).map((attempt) => [attempt.attempt_number, attempt.outcome]), [[1, "UNAVAILABLE"], [2, "COMPLETED"]]);
    assert.equal((await row(flaky.runId)).state, "SUCCEEDED");
    const hopeless = await seed({ createdAt: ago(5) });
    const c = fakeGateway(() => ({ kind: "unknown" }));
    await runAi(hopeless.runId, c.gateway);
    await runAi(hopeless.runId, c.gateway); // a Trigger retry re-enters but cannot grant a third call
    await runAi(hopeless.runId, c.gateway);
    assert.equal(c.requests.length, 2);
    assert.equal((await attempts(hopeless.runId)).length, 2);
    assert.deepEqual([(await row(hopeless.runId)).state, (await row(hopeless.runId)).failure_code], ["FAILED", "MODEL_UNKNOWN"]);
    const thrown = await seed({ createdAt: ago(5) });
    const d = fakeGateway(() => { throw new Error("adapter bug with prompt text"); });
    await runAi(thrown.runId, d.gateway);
    assert.equal(d.requests.length, 2);
    assert.equal((await attempts(thrown.runId)).every((attempt) => attempt.outcome === "UNKNOWN" && attempt.call_may_have_started), true);
    assert.ok(!JSON.stringify(await row(thrown.runId)).includes("adapter bug"), "no error text is stored");
  });
});

test("a crash after the call claim is never repeated while its window is open, and a fresh claim after it closes is the last call", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed, row, attempts, budget }) => {
    const open = await seed({ createdAt: ago(10), shape: "RUNNING" }); // attempt 1 claimed, its process died, window still open
    const idle = fakeGateway(() => completed());
    await runAi(open.runId, idle.gateway);
    assert.equal(idle.requests.length, 0, "the possibly started call is not repeated");
    assert.equal((await attempts(open.runId)).length, 1);
    assert.equal((await row(open.runId)).state, "RUNNING");

    const closed = await seed({ createdAt: ago(200), shape: "RUNNING" }); // window closed with no report: UNKNOWN, one fresh claim
    const g = fakeGateway(() => completed());
    await runAi(closed.runId, g.gateway);
    assert.equal(g.requests.length, 1);
    assert.deepEqual((await attempts(closed.runId)).map((attempt) => attempt.outcome), ["UNKNOWN", "COMPLETED"]);
    assert.equal((await row(closed.runId)).state, "SUCCEEDED");
    assert.deepEqual(await budget(closed.owner), { reserved_runs: 0, consumed_runs: 1 });

    // Both calls already used and the second one's window closed unreported: a third call is refused and the run fails.
    const spent = await seed({ createdAt: ago(260), shape: "RUNNING" });
    const { rows: [second] } = await admin.query("insert into app.ai_run_attempt (run_id, attempt_number, started_at, deadline_at, call_may_have_started) values ($1, 2, $2, $3, true) returning id", [spent.runId, ago(250), ago(130)]);
    await admin.query("update app.ai_run set current_attempt_id = $2 where id = $1", [spent.runId, second.id]);
    const none = fakeGateway(() => completed());
    await runAi(spent.runId, none.gateway);
    await runAi(spent.runId, none.gateway);
    assert.equal(none.requests.length, 0);
    assert.equal((await attempts(spent.runId)).length, 2);
    assert.deepEqual([(await row(spent.runId)).state, (await row(spent.runId)).failure_code], ["FAILED", "ATTEMPTS_EXHAUSTED"]);
  });
});

test("a BUSY attempt returns its SQL wake time instead of completing the retry delivery", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed, row, attempts }) => {
    const { runId } = await seed({ createdAt: ago(10), shape: "RUNNING" });
    await admin.query("update app.ai_run set dispatch_state = 'DISPATCHED', task_id = 'crashed-task' where id = $1", [runId]);
    const { rows: [window] } = await admin.query("select a.deadline_at from app.ai_run r join app.ai_run_attempt a on a.id = r.current_attempt_id where r.id = $1", [runId]);
    const { gateway, requests } = fakeGateway(() => completed());
    const wakeAt: unknown = await runAi(runId, gateway);
    assert.ok(wakeAt instanceof Date, "the Trigger handler must retain execution until SQL permits another claim");
    assert.equal(wakeAt.getTime(), window.deadline_at.getTime() + 1);
    assert.equal(requests.length, 0);
    assert.equal((await attempts(runId)).length, 1);
    assert.equal((await row(runId)).state, "RUNNING");
  });
});

test("the task waits through a crashed attempt and recovers its acknowledged delivery with one fresh model call", { skip: !canRun }, async (context) => {
  await withWorld(async ({ admin, seed, row, attempts, budget }) => {
    const priorKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "synthetic-recovery-test-no-real-key";
    let calls = 0, waits = 0;
    context.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(GOOD) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 }, responseId: "recovered-request" }), { headers: { "content-type": "application/json" } });
    });
    context.mock.method(wait, "until", async ({ date }: { date: Date }) => {
      waits += 1;
      // Emulate only the external wait; the task, provider adapter, SQL claim, validation and settlement remain real.
      await sleep(Math.max(0, date.getTime() - Date.now()));
    });
    try {
      for (const state of ["RUNNING", "VALIDATING"]) {
        const { runId, owner } = await seed({ createdAt: ago(122), shape: "RUNNING" });
        await admin.query("update app.ai_run set state = $2::text::app.ai_run_state, dispatch_state = 'DISPATCHED', task_id = 'crashed-task' where id = $1", [runId, state]);
        const delivery = { runId, dispatchId: "unused-diagnostic-id", executionBinding: "seed-binding", deadlineAt: new Date(Date.now() + 175_000).toISOString() };
        const beforeCalls = calls, beforeWaits = waits;
        await runAiDelivery(delivery);
        assert.equal(calls, beforeCalls + 1, `${state}: only a fresh claim may call the model`);
        assert.equal(waits, beforeWaits + 1, `${state}: BUSY must not complete the delivery`);
        assert.deepEqual((await attempts(runId)).map((attempt) => [attempt.attempt_number, attempt.outcome]), [[1, "UNKNOWN"], [2, "COMPLETED"]]);
        assert.deepEqual([(await row(runId)).state, (await row(runId)).dispatch_state, (await row(runId)).result], ["SUCCEEDED", "DISPATCHED", GOOD]);
        assert.deepEqual(await budget(owner), { reserved_runs: 0, consumed_runs: 1 });
        await runAiDelivery(delivery);
        assert.equal(calls, beforeCalls + 1, "a duplicate after recovery cannot repeat either consumed call");
        assert.equal(waits, beforeWaits + 1);
      }
    } finally {
      if (priorKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = priorKey;
      context.mock.restoreAll();
    }
  });
});

test("attempts 1 and 2 racing settlement: the old token and pointer change zero rows", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed, row, attempts }) => {
    const { runId } = await seed({ createdAt: ago(200), shape: "RUNNING" });
    const [first] = await attempts(runId); // attempt 1: its process is gone, the window is closed
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { gateway, requests } = fakeGateway(async () => { await gate; return completed(); });
    const second = runAi(runId, gateway); // claims attempt 2 and blocks inside the provider call
    while (requests.length === 0) await sleep(20);
    const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL! });
    await worker.connect();
    try {
      const snapshot = JSON.stringify(await attempts(runId));
      const settle = async (attemptId: string, token: string, outcome: string, result: unknown) => (await worker.query("select app.settle_ai_attempt($1, $2, $3, $4::text::app.ai_attempt_outcome, $5::jsonb, $6, 1, 1, 'late') as status", [runId, attemptId, token, outcome, result && JSON.stringify(result), result && "b".repeat(64)])).rows[0].status;
      const [, current] = await attempts(runId);
      assert.equal(await settle(first.id, first.token, "COMPLETED", GOOD), "STALE"); // the old attempt reporting late
      assert.equal(await settle(current.id, first.token, "COMPLETED", GOOD), "STALE"); // the current pointer with the old token
      assert.equal(await settle(first.id, current.token, "COMPLETED", GOOD), "STALE"); // the old attempt with the current token
      assert.equal(JSON.stringify(await attempts(runId)), snapshot, "no attempt row changed");
      const stored = await row(runId);
      assert.deepEqual([stored.state, stored.result, stored.result_hash, stored.terminal_at], ["RUNNING", null, null, null]);
    } finally { await worker.end(); }
    release();
    await second;
    assert.equal(requests.length, 1);
    assert.equal((await row(runId)).state, "SUCCEEDED");
    assert.deepEqual((await attempts(runId)).map((attempt) => [attempt.attempt_number, attempt.outcome]), [[1, "UNKNOWN"], [2, "COMPLETED"]]);
    assert.equal(await (async () => { const w = new Client({ connectionString: process.env.WORKER_DATABASE_URL! }); await w.connect(); try { return (await w.query("select app.settle_ai_attempt($1, $2, $3, 'COMPLETED', $4::jsonb, $5, 1, 1, 'x') as s", [runId, first.id, first.token, JSON.stringify(GOOD), "c".repeat(64)])).rows[0].s; } finally { await w.end(); } })(), "STALE");
    assert.equal((await admin.query("select result_hash from app.ai_run where id = $1", [runId])).rows[0].result_hash, sha256(canonicalJson(GOOD)));
  });
});

test("cancel, authority loss, archive and the deadline during a provider call fence the late output", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed, row, attempts, budget }) => {
    const late = async (label: string, mutate: (ids: { runId: string; projectId: string; owner: string; actor: string }) => Promise<unknown>, expected: { state: string; code: string | null; outcome: string }, options: { createdAt?: Date; sleepMs?: number } = {}) => {
      const ids = await seed({ createdAt: options.createdAt ?? ago(5) });
      const { gateway, requests } = fakeGateway(async () => { await mutate(ids); await sleep(options.sleepMs ?? 0); return completed(); });
      await runAi(ids.runId, gateway);
      const stored = await row(ids.runId);
      assert.deepEqual([stored.state, stored.failure_code, stored.result, stored.result_hash, stored.disposition], [expected.state, expected.code, null, null, null], label);
      assert.equal(requests.length, 1, label);
      const recorded = await attempts(ids.runId);
      assert.deepEqual(recorded.map((attempt) => [attempt.outcome, attempt.call_may_have_started]), [[expected.outcome, true]], `${label}: the attempt records the actual cause`);
      assert.deepEqual(await budget(ids.owner), { reserved_runs: 0, consumed_runs: 1 }, `${label}: the consumed call is not refunded`);
      return ids;
    };
    await late("cancel", ({ runId }) => admin.query("update app.ai_run set cancel_requested_at = clock_timestamp() where id = $1", [runId]), { state: "CANCELLED", code: null, outcome: "CANCELLED" });
    await late("owner entitlement revoked", ({ owner }) => admin.query("update app.pilot_entitlement set active = false, revoked_at = clock_timestamp() where profile_id = $1", [owner]), { state: "FAILED", code: "RESULT_FENCED", outcome: "UNKNOWN" });
    await late("archived project", ({ projectId }) => admin.query("update app.project set status = 'ARCHIVED' where id = $1", [projectId]), { state: "FAILED", code: "RESULT_FENCED", outcome: "UNKNOWN" });
    await late("deadline", async () => undefined, { state: "TIMED_OUT", code: null, outcome: "TIMED_OUT" }, { createdAt: ago(294), sleepMs: 6_500 });
  });
});

test("an editor removed from the project while the call runs cannot store the result", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, person, seed, row, attempts }) => {
    const editor = await person();
    const { runId, projectId } = await seed({ createdAt: ago(5), actor: editor });
    const { gateway } = fakeGateway(async () => {
      await admin.query("update app.project_membership set active = false, deactivated_sequence = 1 where project_id = $1 and profile_id = $2", [projectId, editor]);
      return completed();
    });
    await runAi(runId, gateway);
    const stored = await row(runId);
    assert.deepEqual([stored.state, stored.failure_code, stored.result], ["FAILED", "RESULT_FENCED", null]);
    assert.equal((await attempts(runId)).length, 1);
  });
});

test("a delivery after the 300 second deadline makes no call and settles TIMED_OUT with its refund", { skip: !canRun }, async () => {
  await withWorld(async ({ seed, row, attempts, budget }) => {
    const { runId, owner } = await seed({ createdAt: ago(301) });
    const { gateway, requests } = fakeGateway(() => completed());
    await runAi(runId, gateway);
    assert.equal(requests.length, 0);
    assert.equal((await attempts(runId)).length, 0);
    assert.equal((await row(runId)).state, "TIMED_OUT");
    assert.deepEqual(await budget(owner), { reserved_runs: 0, consumed_runs: 0 }); // never claimed: proved never dispatched
    await runAi(runId, gateway);
    assert.equal(requests.length, 0);
  });
});

test("a cancelled run is never called, authority removed before the claim fails the run, and a missing run is ignored", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed, row, attempts, budget }) => {
    const cancelled = await seed({ createdAt: ago(5) });
    await admin.query("update app.ai_run set cancel_requested_at = clock_timestamp() where id = $1", [cancelled.runId]);
    const g = fakeGateway(() => completed());
    await runAi(cancelled.runId, g.gateway);
    assert.deepEqual([(await row(cancelled.runId)).state, (await budget(cancelled.owner))], ["CANCELLED", { reserved_runs: 0, consumed_runs: 0 }]);
    const denied = await seed({ createdAt: ago(5) });
    await admin.query("update app.pilot_entitlement set active = false, revoked_at = clock_timestamp() where profile_id = $1", [denied.owner]);
    await runAi(denied.runId, g.gateway);
    assert.deepEqual([(await row(denied.runId)).state, (await row(denied.runId)).failure_code, (await attempts(denied.runId)).length], ["FAILED", "ACCESS_REVOKED", 0]);
    assert.deepEqual(await budget(denied.owner), { reserved_runs: 0, consumed_runs: 0 });
    await runAi("00000000-0000-4000-8000-000000000000", g.gateway);
    assert.equal(g.requests.length, 0);
  });
});

test("an oversized capture fails before any claim and refunds its reservation", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed, row, attempts, budget }) => {
    const { runId, owner } = await seed({ createdAt: ago(5) });
    // The captured limits are immutable data; a stored capture whose limit is below its own size is refused without touching a provider.
    const { gateway, requests } = fakeGateway(() => completed());
    await admin.query("alter table app.ai_run disable trigger enforce_ai_run");
    try { await admin.query("update app.ai_run set capture = jsonb_set(capture, '{limits,maxInputTokens}', '10') where id = $1", [runId]); } finally { await admin.query("alter table app.ai_run enable trigger enforce_ai_run"); }
    await runAi(runId, gateway);
    assert.equal(requests.length, 0);
    assert.deepEqual([(await row(runId)).state, (await row(runId)).failure_code, (await attempts(runId)).length], ["FAILED", "INPUT_TOO_LARGE", 0]);
    assert.deepEqual(await budget(owner), { reserved_runs: 0, consumed_runs: 0 });
  });
});
