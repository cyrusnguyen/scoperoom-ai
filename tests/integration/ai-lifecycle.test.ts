import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { runAi } from "../../src/features/proposals/server/run-ai.ts";
import { requireEnv } from "../support/env.ts";
import { seedRun } from "./support/ai-runs.ts";
import { insertProfile, insertProject, removeSchemaRows } from "./support/schema-fixture.ts";
import { serializeSweeps } from "./support/sweep-lock.ts";

const canRun = requireEnv(["SCOPEROOM_BOOTSTRAP_DATABASE_URL", "WORKER_DATABASE_URL", "SCOPEROOM_ENVIRONMENT_ID"]);
serializeSweeps();
type Attempt = { id: string; token: string; deadline_at: Date };
const result = { schemaVersion: 1, kind: "clarification", message: "Synthetic recovery result" };

async function withValidation(options: { second?: boolean; nearRunDeadline?: boolean }, run: (context: Awaited<ReturnType<typeof world>>) => Promise<void>) {
  const admin = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL!, statement_timeout: 10_000 });
  await admin.connect(); await worker.connect();
  const profiles: string[] = [];
  try { await run(await world(admin, worker, profiles, options)); } finally {
    try { await removeSchemaRows(admin, profiles); } finally { await worker.end(); await admin.end(); }
  }
}

async function world(admin: Client, worker: Client, profiles: string[], options: { second?: boolean; nearRunDeadline?: boolean }) {
  const owner = await insertProfile(admin); profiles.push(owner);
  await admin.query("insert into app.pilot_entitlement (profile_id, granted_by_operator) values ($1, gen_random_uuid())", [owner]);
  const projectId = await insertProject(admin, owner);
  const { rows: [clock] } = await admin.query("select clock_timestamp() - make_interval(secs => $1::integer) as admitted", [options.nearRunDeadline ? 296 : 0]);
  const runId = await seedRun(admin, { projectId, owner, createdAt: clock.admitted });
  // Counted crash fixtures: attempt windows are immutable and valid, with one second left. No post-insert clock rewrites.
  const insertAttempt = async (number: number, expired = false) => (await admin.query<Attempt>(
    `insert into app.ai_run_attempt (run_id, attempt_number, started_at, deadline_at, call_may_have_started, outcome, settled_at)
     values ($1, $2, CURRENT_TIMESTAMP - interval '119 seconds', CURRENT_TIMESTAMP + interval '1 second', true,
       case when $3 then 'UNKNOWN'::app.ai_attempt_outcome else null end, case when $3 then clock_timestamp() else null end)
     returning id, token, deadline_at`, [runId, number, expired])).rows[0]!;
  let attempt = await insertAttempt(1, options.second);
  await admin.query("update app.ai_budget_day set reserved_runs = reserved_runs - 1, consumed_runs = consumed_runs + 1 where owner_id = $1", [owner]);
  await admin.query("update app.ai_run set state = 'RUNNING', current_attempt_id = $2, budget_state = 'CONSUMED' where id = $1", [runId, attempt.id]);
  if (options.second) {
    attempt = await insertAttempt(2);
    await admin.query("update app.ai_run set current_attempt_id = $2 where id = $1", [runId, attempt.id]);
  }
  const validate = async (target: Attempt) => (await worker.query("select app.begin_ai_validation($1, $2, $3) as status", [runId, target.id, target.token])).rows[0].status;
  assert.equal(await validate(attempt), "VALIDATING", "the real worker marks a reply validating before the simulated process exit");
  const waitUntil = async (deadline: Date) => { await admin.query("select pg_sleep(greatest(0, extract(epoch from ($1::timestamptz - clock_timestamp()))) + 0.025)", [deadline]); };
  const claim = async () => (await worker.query("select * from app.claim_ai_attempt($1)", [runId])).rows[0];
  const settle = async (target: Attempt, outcome = "COMPLETED") => (await worker.query("select app.settle_ai_attempt($1, $2, $3, $4::app.ai_attempt_outcome, $5::jsonb, $6, 17, 9, 'synthetic-recovery') as status", [runId, target.id, target.token, outcome, outcome === "COMPLETED" ? JSON.stringify(result) : null, outcome === "COMPLETED" ? "a".repeat(64) : null])).rows[0].status;
  const row = async () => (await admin.query("select state::text, result, current_attempt_id, failure_code, deadline_at from app.ai_run where id = $1", [runId])).rows[0];
  const attempts = async () => (await admin.query("select attempt_number, outcome::text, call_may_have_started from app.ai_run_attempt where run_id = $1 order by attempt_number", [runId])).rows;
  const budget = async () => (await admin.query("select reserved_runs, consumed_runs from app.ai_budget_day where owner_id = $1", [owner])).rows[0];
  return { admin, owner, projectId, runId, attempt, claim, validate, settle, row, attempts, budget, waitUntil };
}

test("an interrupted validation stays busy inside its window, then recovers with a fresh second claim and fences old output", { skip: !canRun }, async () => {
  await withValidation({}, async ({ admin, runId, attempt, claim, validate, settle, row, attempts, budget, waitUntil }) => {
    assert.equal((await claim()).out_status, "BUSY");
    assert.equal((await row()).state, "VALIDATING");
    await assert.rejects(admin.query("update app.ai_run set state = 'RUNNING' where id = $1", [runId]), (error: { code?: string }) => error.code === "23514", "validation cannot reverse state while keeping the previous pointer");
    await waitUntil(attempt.deadline_at);
    const next = await claim();
    assert.equal(next.out_status, "CLAIMED");
    assert.equal(next.out_attempt_number, 2);
    assert.notEqual(next.out_attempt_id, attempt.id);
    assert.notEqual(next.out_attempt_token, attempt.token);
    assert.equal((await row()).state, "RUNNING");
    assert.deepEqual(await attempts(), [
      { attempt_number: 1, outcome: "UNKNOWN", call_may_have_started: true },
      { attempt_number: 2, outcome: null, call_may_have_started: true },
    ]);
    assert.deepEqual(await budget(), { reserved_runs: 0, consumed_runs: 1 }, "recovery consumes no second logical allowance");
    assert.equal(await settle(attempt), "STALE", "late output from the interrupted validator cannot settle its replacement");
    assert.equal((await row()).result, null);
    const current = { id: next.out_attempt_id, token: next.out_attempt_token, deadline_at: next.out_attempt_deadline_at };
    assert.equal(await validate(current), "VALIDATING");
    assert.equal(await settle(current), "SUCCEEDED");
    assert.deepEqual((await row()).result, result);
    assert.equal((await claim()).out_status, "TERMINAL");
    assert.equal((await attempts()).length, 2);
  });
});

test("an interrupted second validation exhausts the two-call ceiling and a delivery settles without another model call", { skip: !canRun }, async () => {
  await withValidation({ second: true }, async ({ runId, attempt, claim, settle, row, attempts, budget, waitUntil }) => {
    assert.equal((await claim()).out_status, "BUSY");
    await waitUntil(attempt.deadline_at);
    assert.equal((await claim()).out_status, "CEILING");
    let calls = 0;
    await runAi(runId, { generate: async () => { calls += 1; return { kind: "unknown" }; } });
    assert.equal(calls, 0);
    assert.equal((await row()).state, "FAILED");
    assert.equal((await row()).failure_code, "ATTEMPTS_EXHAUSTED");
    assert.equal((await row()).result, null);
    assert.equal(await settle(attempt), "STALE");
    assert.deepEqual(await attempts(), [
      { attempt_number: 1, outcome: "UNKNOWN", call_may_have_started: true },
      { attempt_number: 2, outcome: "UNKNOWN", call_may_have_started: true },
    ]);
    assert.deepEqual(await budget(), { reserved_runs: 0, consumed_runs: 1 });
  });
});

test("validation interrupted after recording an incomplete attempt can recover without repeating that attempt", { skip: !canRun }, async () => {
  await withValidation({}, async ({ attempt, settle, claim, row, attempts, budget }) => {
    assert.equal(await settle(attempt, "INCOMPLETE"), "RECORDED");
    assert.equal((await row()).state, "VALIDATING", "the process exits before closeOut can settle the run");
    const next = await claim();
    assert.equal(next.out_status, "CLAIMED");
    assert.equal(next.out_attempt_number, 2);
    assert.equal((await row()).state, "RUNNING");
    assert.equal((await attempts())[0].outcome, "INCOMPLETE");
    assert.equal(await settle(attempt), "STALE");
    assert.deepEqual(await budget(), { reserved_runs: 0, consumed_runs: 1 });
  });
});

for (const guard of ["cancel", "access"] as const) {
  test(`an expired validation cannot recover after ${guard} authority is lost`, { skip: !canRun }, async () => {
    await withValidation({}, async ({ admin, owner, runId, attempt, claim, attempts, budget, waitUntil }) => {
      await waitUntil(attempt.deadline_at);
      if (guard === "cancel") await admin.query("update app.ai_run set cancel_requested_at = clock_timestamp() where id = $1", [runId]);
      else await admin.query("update app.pilot_entitlement set active = false where profile_id = $1", [owner]);
      assert.equal((await claim()).out_status, guard === "cancel" ? "CANCELLED" : "DENIED");
      assert.equal((await attempts()).length, 1);
      assert.deepEqual(await budget(), { reserved_runs: 0, consumed_runs: 1 });
    });
  });
}

test("an interrupted validation cannot recover after the original run deadline", { skip: !canRun }, async () => {
  await withValidation({ nearRunDeadline: true }, async ({ runId, claim, row, attempts, budget, waitUntil }) => {
    await waitUntil((await row()).deadline_at);
    assert.equal((await claim()).out_status, "DEADLINE");
    let calls = 0;
    await runAi(runId, { generate: async () => { calls += 1; return { kind: "unknown" }; } });
    assert.equal(calls, 0);
    assert.equal((await row()).state, "TIMED_OUT");
    assert.equal((await attempts()).length, 1);
    assert.deepEqual(await budget(), { reserved_runs: 0, consumed_runs: 1 });
  });
});
