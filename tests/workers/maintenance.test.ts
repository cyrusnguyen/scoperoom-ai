import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { runMaintenance } from "../../src/features/proposals/server/maintenance.ts";
import type { JobDispatcher, JobRequest } from "../../src/features/proposals/server/ports.ts";
import { workerCleanup } from "../../src/server/maintenance/worker-cleanup.ts";
import { seedRun } from "../integration/support/ai-runs.ts";
import { insertProfile, insertProject, removeSchemaRows } from "../integration/support/schema-fixture.ts";
import { serializeSweeps } from "../integration/support/sweep-lock.ts";
import { requireEnv } from "../support/env.ts";

// The scheduled maintenance path against the real local database through the restricted worker role: no bootstrap credential, no provider.
const canRun = requireEnv(["SCOPEROOM_BOOTSTRAP_DATABASE_URL", "WORKER_DATABASE_URL", "SCOPEROOM_ENVIRONMENT_ID"]);
serializeSweeps();
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);

async function withWorld(run: (world: { admin: Client; worker: Client; seed: (options: { hours: number; shape: "FAILED" | "QUEUED" | "SUCCEEDED" }) => Promise<string> }) => Promise<void>) {
  const admin = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL! });
  await admin.connect(); await worker.connect();
  const profiles: string[] = [];
  try {
    await run({
      admin, worker,
      seed: async ({ hours, shape }) => {
        const owner = await insertProfile(admin); profiles.push(owner);
        await admin.query("insert into app.pilot_entitlement (profile_id, granted_by_operator) values ($1, gen_random_uuid())", [owner]);
        return seedRun(admin, { projectId: await insertProject(admin, owner), owner, shape, createdAt: ago(hours), uncounted: shape !== "QUEUED" });
      },
    });
  } finally {
    try { await removeSchemaRows(admin, profiles); } finally { await worker.end(); await admin.end(); }
  }
}
const purged = async (admin: Client, runId: string) => (await admin.query("select capture is null as purged from app.ai_run where id = $1", [runId])).rows[0].purged;
const noDispatch: JobDispatcher = { dispatch: async () => ({ kind: "unavailable" }), cancel: async () => "unknown" };

test("the worker role sweeps expired bodies through the environment-validated function", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed }) => {
    const runId = await seed({ hours: 8 * 24, shape: "SUCCEEDED" });
    const result = await workerCleanup(100);
    assert.deepEqual(Object.keys(result).sort(), ["clearedAiBodies", "clearedAppliedBodies", "deletedReceipts", "expiredAiResults", "expiredPreviews"]);
    assert.ok(result.expiredAiResults >= 1);
    assert.equal(await purged(admin, runId), true);
  });
});

test("worker cleanup arms its SQL timeout before executing the maintenance statement", { skip: !canRun }, async () => {
  const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL! });
  await worker.connect();
  // Replace only the maintenance statement with a harmless slow query on the same real worker connection. A timeout configured
  // inside the SQL function would not cancel this statement; SET LOCAL must run as its own preceding statement in the transaction.
  const statement = async () => { await worker.query("select pg_sleep(6)"); return []; };
  const db = {
    $queryRaw: statement,
    $transaction: async (work: (tx: { $executeRaw: (parts: TemplateStringsArray) => Promise<number>; $queryRaw: typeof statement }) => Promise<unknown>) => {
      await worker.query("begin");
      try {
        const result = await work({ $executeRaw: async (parts) => { await worker.query(parts.join("")); return 0; }, $queryRaw: statement });
        await worker.query("commit");
        return result;
      } catch (error) { await worker.query("rollback"); throw error; }
    },
  };
  try {
    await worker.query("set statement_timeout = 0");
    await assert.rejects(workerCleanup(100, db as never), { code: "57014" });
    assert.equal((await worker.query("select current_setting('statement_timeout') setting")).rows[0].setting, "0", "the local setting cannot leak to the next statement");
  } finally { await worker.end(); }
});

test("a wrong environment, a bad batch and every raw sweep are refused to the worker, with no mutation", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, worker, seed }) => {
    const runId = await seed({ hours: 8 * 24, shape: "FAILED" });
    await assert.rejects(worker.query("select * from app.run_worker_cleanup(gen_random_uuid(), 100)"), { code: "28000" });
    await assert.rejects(worker.query("select * from app.run_worker_cleanup(null, 100)"), { code: "28000" });
    for (const batch of [0, 101, null]) await assert.rejects(worker.query("select * from app.run_worker_cleanup($1::uuid, $2)", [process.env.SCOPEROOM_ENVIRONMENT_ID, batch]), { code: "22023" });
    for (const sql of ["select * from app.cleanup_transient(false, 100)", "select * from app.expire_ai_run_bodies(false, 100)", "update app.ai_run set capture = null where true", "delete from app.mutation_receipt"]) {
      await assert.rejects(worker.query(sql), { code: "42501" }, sql);
    }
    assert.equal(await purged(admin, runId), false);
    const original = process.env.SCOPEROOM_ENVIRONMENT_ID;
    try {
      delete process.env.SCOPEROOM_ENVIRONMENT_ID;
      await assert.rejects(workerCleanup(100), /environment identity/);
      process.env.SCOPEROOM_ENVIRONMENT_ID = crypto.randomUUID();
      await assert.rejects(workerCleanup(100), /environment identity/); // the verified client itself refuses a mismatched database
    } finally { process.env.SCOPEROOM_ENVIRONMENT_ID = original; }
    await assert.rejects(workerCleanup(0), RangeError);
    assert.equal(await purged(admin, runId), false);
  });
});

test("one maintenance tick repairs due dispatches and cleans bodies; each step survives the other's failure", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, seed }) => {
    const due = await seed({ hours: 0, shape: "QUEUED" });
    const old = await seed({ hours: 8 * 24, shape: "FAILED" });
    const requests: JobRequest[] = [];
    const dispatcher: JobDispatcher = { dispatch: async (request) => { requests.push(request); return { kind: "accepted", taskId: `task-${requests.length}` }; }, cancel: async () => "requested" };
    const cleaned = await runMaintenance(dispatcher);
    assert.equal(requests.filter((request) => request.runId === due).length, 1);
    assert.equal((await admin.query("select dispatch_state::text s from app.ai_run where id = $1", [due])).rows[0].s, "DISPATCHED");
    assert.ok(cleaned.clearedAiBodies >= 1);
    assert.equal(await purged(admin, old), true);

    const old2 = await seed({ hours: 9 * 24, shape: "FAILED" });
    await assert.rejects(runMaintenance(undefined), /TRIGGER_SECRET_KEY/); // repair cannot deliver, and that is reported...
    assert.equal(await purged(admin, old2), true, "...after cleanup still ran");

    const old3 = await seed({ hours: 9 * 24, shape: "FAILED" });
    const boom = new Error("database unavailable");
    await assert.rejects(runMaintenance(noDispatch, { $queryRaw: async () => { throw boom; }, $transaction: async () => { throw boom; } } as never), boom); // a failing database fails both steps and is rethrown
    assert.equal(await purged(admin, old3), false, "nothing ran against the failing database");
    await workerCleanup(100);
    assert.equal(await purged(admin, old3), true);
  });
});
