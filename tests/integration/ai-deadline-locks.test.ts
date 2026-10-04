import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import { requireEnv } from "../support/env.ts";
import { seedRun } from "./support/ai-runs.ts";
import { insertProfile, insertProject, removeSchemaRows } from "./support/schema-fixture.ts";
import { serializeSweeps } from "./support/sweep-lock.ts";

const canRun = requireEnv(["SCOPEROOM_BOOTSTRAP_DATABASE_URL", "WORKER_DATABASE_URL", "SCOPEROOM_ENVIRONMENT_ID"]);
serializeSweeps(); // These runs become due while the test deliberately holds their locks.

async function withRun(run: (context: Awaited<ReturnType<typeof world>>) => Promise<void>) {
  const admin = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  const blocker = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL!, statement_timeout: 10_000 });
  await admin.connect(); await blocker.connect(); await worker.connect();
  const profiles: string[] = [];
  try { await run(await world(admin, blocker, worker, profiles)); } finally {
    await blocker.query("rollback");
    try { await removeSchemaRows(admin, profiles); } finally { await worker.end(); await blocker.end(); await admin.end(); }
  }
}

async function world(admin: Client, blocker: Client, worker: Client, profiles: string[]) {
  const owner = await insertProfile(admin); profiles.push(owner);
  await admin.query("insert into app.pilot_entitlement (profile_id, granted_by_operator) values ($1, gen_random_uuid())", [owner]);
  const projectId = await insertProject(admin, owner);
  // A real counted reservation and an immutable admission deadline with three seconds left.
  const { rows: [clock] } = await admin.query("select clock_timestamp() - interval '297 seconds' as admitted");
  const runId = await seedRun(admin, { projectId, owner, createdAt: clock.admitted });
  const { rows: [deadline] } = await admin.query("select deadline_at from app.ai_run where id = $1", [runId]);
  const { rows: [workerPid] } = await worker.query("select pg_backend_pid() as pid");
  const { rows: [blockerPid] } = await blocker.query("select pg_backend_pid() as pid");
  const row = async () => (await admin.query("select state::text, result, current_attempt_id, terminal_at, deadline_at from app.ai_run where id = $1", [runId])).rows[0];
  const budget = async () => (await admin.query("select reserved_runs, consumed_runs from app.ai_budget_day where owner_id = $1", [owner])).rows[0];
  const claim = async () => (await worker.query("select * from app.claim_ai_attempt($1)", [runId])).rows[0];

  /** Prove the SQL call started before expiry and blocked on this transaction, then release only after SQL time crossed expiry. */
  const crossDeadline = async <T>(lockSql: string, lockParams: unknown[], action: () => Promise<T>) => {
    await blocker.query("begin");
    await blocker.query(lockSql, lockParams);
    assert.equal((await admin.query("select clock_timestamp() < $1::timestamptz as live", [deadline.deadline_at])).rows[0].live, true, "the function starts inside its authority window");
    const pending = action();
    // Attach rejection handling immediately; always release the blocker before awaiting the call.
    const settled = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
    try {
      const timeout = Date.now() + 2_000;
      let blocked = false;
      while (Date.now() < timeout) {
        blocked = (await admin.query("select $2::integer = any(pg_blocking_pids($1::integer)) as blocked", [workerPid.pid, blockerPid.pid])).rows[0].blocked;
        if (blocked) break;
        await sleep(10);
      }
      assert.equal(blocked, true, "pg_blocking_pids proves the function waited behind the held lock");
      await admin.query("select pg_sleep(greatest(0, extract(epoch from ($1::timestamptz - clock_timestamp()))) + 0.025)", [deadline.deadline_at]);
    } finally { await blocker.query("rollback"); }
    const outcome = await settled;
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  };
  return { admin, worker, owner, projectId, runId, row, budget, claim, crossDeadline };
}

for (const lock of ["project", "allowance", "day"] as const) {
  test(`claim refuses provider authority after waiting past the deadline on the ${lock} lock`, { skip: !canRun }, async () => {
    await withRun(async ({ admin, owner, projectId, runId, row, budget, claim, crossDeadline }) => {
      const sql = lock === "project" ? "select 1 from app.project where id = $1 for no key update"
        : lock === "allowance" ? "select 1 from app.ai_owner_allowance where owner_id = $1 for update"
          : "select 1 from app.ai_budget_day where owner_id = $1 for update";
      const outcome = await crossDeadline(sql, [lock === "project" ? projectId : owner], claim);
      assert.equal(outcome.out_status, "DEADLINE");
      assert.equal(outcome.out_attempt_id, null);
      assert.equal((await row()).current_attempt_id, null);
      assert.equal((await admin.query("select count(*)::integer as n from app.ai_run_attempt where run_id = $1", [runId])).rows[0].n, 0);
      assert.deepEqual(await budget(), { reserved_runs: 1, consumed_runs: 0 }, "a refused provider call cannot consume the reservation");
    });
  });
}

for (const operation of ["validation", "settlement"] as const) {
  for (const lock of ["project", "attempt"] as const) {
    test(`${operation} fences a result after waiting past the deadline on the ${lock} lock`, { skip: !canRun }, async () => {
      await withRun(async ({ admin, worker, projectId, runId, row, budget, claim, crossDeadline }) => {
        const attempt = await claim(); assert.equal(attempt.out_status, "CLAIMED");
        const params = [runId, attempt.out_attempt_id, attempt.out_attempt_token];
        const action = async () => (await (operation === "validation"
          ? worker.query("select app.begin_ai_validation($1, $2, $3) as status", params)
          : worker.query("select app.settle_ai_attempt($1, $2, $3, 'COMPLETED', $4::jsonb, $5, 17, 9, 'lock-test') as status", [...params, JSON.stringify({ schemaVersion: 1, kind: "clarification", message: "synthetic" }), "a".repeat(64)]))).rows[0].status;
        const outcome = await crossDeadline(lock === "project" ? "select 1 from app.project where id = $1 for no key update" : "select 1 from app.ai_run_attempt where id = $1 for update", [lock === "project" ? projectId : attempt.out_attempt_id], action);
        assert.equal(outcome, "FENCED");
        assert.equal((await row()).state, "RUNNING");
        assert.equal((await row()).result, null);
        assert.deepEqual(await budget(), { reserved_runs: 0, consumed_runs: 1 });
        const saved = (await admin.query("select outcome::text, input_tokens, output_tokens from app.ai_run_attempt where id = $1", [attempt.out_attempt_id])).rows[0];
        assert.deepEqual(saved, operation === "settlement" ? { outcome: "COMPLETED", input_tokens: 17, output_tokens: 9 } : { outcome: null, input_tokens: null, output_tokens: null }, "reported usage survives even when output is fenced");
      });
    });
  }
}

test("timeout settlement observes the deadline after waiting on the project lock and refunds once", { skip: !canRun }, async () => {
  await withRun(async ({ worker, projectId, runId, row, budget, crossDeadline }) => {
    const finish = async () => (await worker.query("select app.finish_ai_run($1, 'TIMED_OUT', 'DEADLINE') as status", [runId])).rows[0].status;
    const outcome = await crossDeadline("select 1 from app.project where id = $1 for no key update", [projectId], finish);
    assert.equal(outcome, "SETTLED");
    const saved = await row();
    assert.equal(saved.state, "TIMED_OUT");
    assert.ok(saved.terminal_at >= saved.deadline_at, "terminal time records settlement after the wait");
    assert.deepEqual(await budget(), { reserved_runs: 0, consumed_runs: 0 });
    assert.equal(await finish(), "TERMINAL");
    assert.deepEqual(await budget(), { reserved_runs: 0, consumed_runs: 0 }, "repeated settlement cannot refund twice");
  });
});

for (const lock of ["project", "allowance", "day"] as const) {
  test(`input rejection observes the deadline after waiting on the ${lock} lock`, { skip: !canRun }, async () => {
    await withRun(async ({ worker, owner, projectId, runId, row, budget, crossDeadline }) => {
      const finish = async () => (await worker.query("select app.finish_ai_run($1, 'FAILED', 'INPUT_TOO_LARGE') as status", [runId])).rows[0].status;
      const lockSql = lock === "project" ? "select 1 from app.project where id = $1 for no key update"
        : lock === "allowance" ? "select 1 from app.ai_owner_allowance where owner_id = $1 for update"
          : "select 1 from app.ai_budget_day where owner_id = $1 for update";
      assert.equal(await crossDeadline(lockSql, [lock === "project" ? projectId : owner], finish), "SETTLED");
      const saved = await row();
      assert.equal(saved.state, "TIMED_OUT");
      assert.ok(saved.terminal_at >= saved.deadline_at);
      assert.deepEqual(await budget(), { reserved_runs: 0, consumed_runs: 0 });
      assert.equal(await finish(), "TERMINAL");
      assert.deepEqual(await budget(), { reserved_runs: 0, consumed_runs: 0 });
    });
  });
}
