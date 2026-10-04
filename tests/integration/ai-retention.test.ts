import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { evidenceStats, type SavedSource } from "../../src/features/proposals/domain/capture.ts";
import type { CapturedInput } from "../../src/features/proposals/contracts/tasks.ts";
import { validateResult } from "../../src/features/proposals/domain/validate-result.ts";
import { goodGenerate, SOURCE_TEXT } from "../support/ai-results.ts";
import type { ModelGateway } from "../../src/features/proposals/server/ports.ts";
import { runAi } from "../../src/features/proposals/server/run-ai.ts";
import { requireEnv } from "../support/env.ts";
import { seedRun } from "./support/ai-runs.ts";
import { insertProfile, insertProject, removeSchemaRows } from "./support/schema-fixture.ts";
import { serializeSweeps } from "./support/sweep-lock.ts";

// Bounded AI retention (Stage 06.1 Task 5) on the real local database: the owner/bootstrap connection seeds and sweeps, the restricted
// worker connection settles. The sweeps are global, so this file holds the sweep lock and inspects only the rows it created.
const canRun = requireEnv(["SCOPEROOM_BOOTSTRAP_DATABASE_URL", "WORKER_DATABASE_URL", "SCOPEROOM_ENVIRONMENT_ID"]);
serializeSweeps();

const HOURS = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOURS);
const RESULT = { schemaVersion: 1, kind: "clarification", message: "need more" };
const SWEEP = "select * from app.cleanup_transient(false, 100)";
/** The permanent columns of a run row, without the retained-body flags. */
const identity = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !["no_capture", "no_result", "no_diff", "disposition"].includes(key)));
const IDENTITY = "project_id, draft_id, actor_id, owner_id, admission_day, prompt_source_version_id, task_type, flow_id, model, execution_binding, capture_hash, result_hash, state::text, budget_state::text, terminal_at, failure_code, created_at, deadline_at, dispatch_id";

async function withWorld(run: (context: Awaited<ReturnType<typeof world>>) => Promise<void>) {
  const admin = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL! });
  await admin.connect(); await worker.connect();
  const profiles: string[] = [];
  try { await run(await world(admin, worker, profiles)); } finally {
    try { await removeSchemaRows(admin, profiles); } finally { await worker.end(); await admin.end(); }
  }
}
async function world(admin: Client, worker: Client, profiles: string[]) {
  /** An entitled owner with one project; each run gets its own project because a project holds one nonterminal run. */
  const owner = async () => {
    const id = await insertProfile(admin); profiles.push(id);
    await admin.query("insert into app.pilot_entitlement (profile_id, granted_by_operator) values ($1, gen_random_uuid())", [id]);
    return id;
  };
  const seed = async (ownerId: string, options: { hours?: number; shape?: "QUEUED" | "RUNNING" | "FAILED" | "SUCCEEDED"; projectId?: string; uncounted?: boolean; sources?: SavedSource[]; result?: object; flowId?: string } = {}) => {
    const projectId = options.projectId ?? await insertProject(admin, ownerId);
    const runId = await seedRun(admin, { projectId, owner: ownerId, shape: options.shape, createdAt: options.hours === undefined ? undefined : ago(options.hours), uncounted: options.uncounted, sources: options.sources, result: options.result, flowId: options.flowId });
    return { projectId, runId };
  };
  const row = async (runId: string) => (await admin.query(`select ${IDENTITY}, capture is null no_capture, result is null no_result, diff is null no_diff, disposition::text disposition from app.ai_run where id = $1`, [runId])).rows[0];
  const budget = async (ownerId: string) => (await admin.query("select to_char(day, 'YYYY-MM-DD') as day, reserved_runs, consumed_runs from app.ai_budget_day where owner_id = $1 order by day", [ownerId])).rows;
  const sweep = async () => (await admin.query(SWEEP)).rows[0];
  return { admin, worker, owner, seed, row, budget, sweep };
}

test("bodies leave only seven days after a run is terminal, and identity, hashes, usage and cited evidence stay", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, owner, seed, row, sweep }) => {
    const person = await owner();
    const projectId = await insertProject(admin, person);
    const sourceVersionId = randomUUID(), sourceId = randomUUID();
    const stats = evidenceStats(SOURCE_TEXT);
    const source: SavedSource = { projectId, sourceId, sourceVersionId, currentVersionId: sourceVersionId, title: "Cited notes", text: stats.text, contentHash: stats.contentHash };
    await admin.query("begin");
    try {
      await admin.query("insert into app.source_document (id, project_id, kind, current_version_id, created_by) values ($1, $2, 'USER_TEXT', $3, $4)", [sourceId, projectId, sourceVersionId, person]);
      await admin.query(`insert into app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by)
        values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`, [sourceVersionId, projectId, sourceId, source.title, stats.text, stats.codePointCount, stats.utf8ByteCount, stats.contentHash, person]);
      await admin.query("commit");
    } catch (error) { await admin.query("rollback"); throw error; }
    const old = await seed(person, { projectId, hours: 7 * 24 + 1, shape: "SUCCEEDED", uncounted: true, sources: [source], result: goodGenerate(sourceVersionId) });
    const retained = (await admin.query<{ capture: CapturedInput; result: ReturnType<typeof goodGenerate> }>("select capture, result from app.ai_run where id = $1", [old.runId])).rows[0];
    assert.deepEqual(retained.capture.sources.map((entry) => ({ id: entry.sourceVersionId, text: entry.text, hash: entry.contentHash })), [{ id: sourceVersionId, text: SOURCE_TEXT, hash: stats.contentHash }]);
    const proposal = validateResult(retained.capture, retained.result);
    assert.equal(proposal.kind, "proposal");
    if (proposal.kind !== "proposal") throw new Error("the seeded result must cite a captured source");
    assert.deepEqual(proposal.citations, [{ sourceVersionId, startLine: 2, endLine: 3, excerpt: "line two\nline three" }]);
    const justUnder = await seed(person, { hours: 7 * 24 - 1, shape: "SUCCEEDED", uncounted: true });
    const flowId = randomUUID();
    const failed = await seed(person, { hours: 7 * 24 + 1, shape: "FAILED", uncounted: true, flowId });
    const live = await seed(person, { hours: 8 * 24, shape: "QUEUED" }); // never terminal: seven days from the terminal time, not from creation
    await admin.query("insert into app.ai_run_attempt (run_id, attempt_number, started_at, deadline_at, call_may_have_started, outcome, settled_at, input_tokens, output_tokens, provider_request_id) values ($1, 1, $2, $2::timestamptz + interval '60 seconds', true, 'COMPLETED', $2::timestamptz + interval '30 seconds', 120, 45, 'req-old')", [old.runId, ago(7 * 24 + 1)]);
    const evidence = async () => (await admin.query("select id, text, content_hash from app.source_version where project_id = $1 order by id", [old.projectId])).rows;
    const evidenceBefore = await evidence();
    assert.equal(evidenceBefore.length, 2, "both prompt and captured/cited evidence exist");
    assert.deepEqual(evidenceBefore.find((entry) => entry.id === sourceVersionId), { id: sourceVersionId, text: SOURCE_TEXT, content_hash: stats.contentHash });
    const before = { old: await row(old.runId), justUnder: await row(justUnder.runId), failed: await row(failed.runId), live: await row(live.runId) };
    assert.equal(before.old.no_capture, false);
    assert.equal(before.failed.flow_id, flowId);
    const promptEvidence = evidenceBefore.find((entry) => entry.id === before.old.prompt_source_version_id);
    assert.ok(promptEvidence);
    assert.equal(promptEvidence.text, retained.capture.prompt);
    assert.equal(promptEvidence.content_hash, retained.capture.promptHash);

    const dry = (await admin.query("select * from app.cleanup_transient(true, 100)")).rows[0];
    assert.ok(dry.expiredAiResults >= 1 && dry.clearedAiBodies >= 1, "the dry run reports what it would do");
    assert.deepEqual(await row(old.runId), before.old, "a dry run changes nothing");

    const result = await sweep();
    assert.ok(result.expiredAiResults >= 1 && result.clearedAiBodies >= 1);
    const after = { old: await row(old.runId), justUnder: await row(justUnder.runId), failed: await row(failed.runId), live: await row(live.runId) };
    assert.deepEqual([after.old.no_capture, after.old.no_result, after.old.no_diff, after.old.disposition], [true, true, true, "EXPIRED"]);
    assert.deepEqual([after.failed.no_capture, after.failed.disposition], [true, null]);
    assert.equal(after.failed.flow_id, flowId, "Improve attribution survives the actual bounded cleanup");
    assert.deepEqual([after.justUnder.no_capture, after.justUnder.no_result, after.justUnder.disposition], [false, false, "AVAILABLE"], "six days and 23 hours is still inside the window");
    assert.deepEqual([after.live.no_capture, after.live.state], [false, "QUEUED"]);
    for (const key of ["old", "justUnder", "failed", "live"] as const) assert.deepEqual(identity(after[key]), identity(before[key]), `${key}: permanent run identity, hashes and attribution survive`);
    assert.deepEqual((await admin.query("select outcome::text, input_tokens, output_tokens, provider_request_id from app.ai_run_attempt where run_id = $1", [old.runId])).rows, [{ outcome: "COMPLETED", input_tokens: 120, output_tokens: 45, provider_request_id: "req-old" }], "usage survives");
    assert.deepEqual(await evidence(), evidenceBefore, "prompt and cited source versions are never removed by body expiry");
  });
});

test("an applied run keeps its capture and result through any number of sweeps", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, owner, seed, row, sweep }) => {
    const applied = await seed(await owner(), { hours: 30 * 24, shape: "SUCCEEDED", uncounted: true });
    await admin.query("update app.ai_run set disposition = 'APPLIED' where id = $1", [applied.runId]); // PR 2 owns the application row; the disposition is what exists now
    const before = await row(applied.runId);
    await sweep(); await sweep();
    assert.deepEqual(await row(applied.runId), before);
    assert.deepEqual([before.no_capture, before.no_result, before.disposition], [false, false, "APPLIED"]);
    await assert.rejects(admin.query("update app.ai_run set capture = null where id = $1", [applied.runId]), { code: "23514" }, "even the owner connection cannot drop an applied body");
  });
});

test("repeated cleanup is idempotent: one expiry event per run and no new writes", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, owner, seed, row, sweep }) => {
    const old = await seed(await owner(), { hours: 8 * 24, shape: "SUCCEEDED", uncounted: true });
    const events = async () => (await admin.query("select count(*)::int n from app.audit_event where project_id = $1 and action = 'AI_RESULT_EXPIRED'", [old.projectId])).rows[0].n;
    const cursor = async () => (await admin.query("select ai_revision::text, event_sequence::text from app.project where id = $1", [old.projectId])).rows[0];
    await sweep();
    const once = { run: await row(old.runId), events: await events(), cursor: await cursor() };
    assert.equal(once.events, 1);
    await sweep(); await sweep();
    assert.deepEqual({ run: await row(old.runId), events: await events(), cursor: await cursor() }, once);
  });
});

test("bounded expiry dry-run and apply select the same mixed-disposition batch across projects", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, owner, seed, row }) => {
    const person = await owner();
    const projects: string[] = [];
    for (let index = 0; index < 4; index += 1) projects.push(await insertProject(admin, person));
    projects.sort();
    const runs: Awaited<ReturnType<typeof seed>>[] = [];
    for (const [index, projectId] of projects.entries()) {
      // Project order puts the FAILED pair first; terminal-time order puts the AVAILABLE pair first. LIMIT 2 must describe one batch.
      runs.push(await seed(person, { projectId, hours: (index < 2 ? 8 : 10) * 24, shape: index < 2 ? "FAILED" : "SUCCEEDED", uncounted: true }));
    }
    const snapshot = async () => {
      const rows = [];
      for (const run of runs) rows.push(await row(run.runId));
      return rows;
    };
    const before = await snapshot();
    await admin.query("begin");
    try {
      const dry = (await admin.query("select * from app.expire_ai_run_bodies(true, 2)")).rows[0];
      assert.deepEqual(await snapshot(), before, "dry-run preserves every body");
      const applied = (await admin.query("select * from app.expire_ai_run_bodies(false, 2)")).rows[0];
      assert.deepEqual(applied, dry, "without contention, the dry-run predicts the exact bounded counts");
      assert.deepEqual(applied, { expiredResults: 0, clearedBodies: 2 });
      const after = await snapshot();
      assert.deepEqual(after.map((run) => run.no_capture), [true, true, false, false], "the deterministic project order chooses only two rows");
      const nextDry = (await admin.query("select * from app.expire_ai_run_bodies(true, 2)")).rows[0];
      const nextApplied = (await admin.query("select * from app.expire_ai_run_bodies(false, 2)")).rows[0];
      assert.deepEqual(nextApplied, nextDry);
      assert.deepEqual(nextApplied, { expiredResults: 2, clearedBodies: 0 });
    } finally {
      await admin.query("rollback"); // the global sweep cannot persist a change to any foreign fixture
    }
  });
});

test("late provider output cannot recreate a purged body or reach a model", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, worker, owner, seed, row, sweep }) => {
    const person = await owner();
    const failed = await seed(person, { hours: 8 * 24, shape: "FAILED", uncounted: true });
    const expired = await seed(person, { hours: 8 * 24, shape: "SUCCEEDED", uncounted: true });
    // Each run had a claimed call whose report never arrived; the run settled, aged and lost its bodies.
    const attempts = new Map<string, { id: string; token: string }>();
    for (const target of [failed, expired]) {
      const { rows: [attempt] } = await admin.query<{ id: string; token: string }>("insert into app.ai_run_attempt (run_id, attempt_number, started_at, deadline_at, call_may_have_started) values ($1, 1, now() - interval '8 days', now() - interval '8 days' + interval '60 seconds', true) returning id, token", [target.runId]);
      attempts.set(target.runId, attempt!);
    }
    await sweep();
    for (const target of [failed, expired]) assert.deepEqual([(await row(target.runId)).no_capture, (await row(target.runId)).no_result], [true, true]);

    // A late "completed" report for a terminal run is stale whatever it carries, and nothing it carries is stored.
    for (const target of [failed, expired]) {
      const attempt = attempts.get(target.runId)!;
      const late = await worker.query("select app.settle_ai_attempt($1, $2, $3, 'COMPLETED', $4::jsonb, repeat('b', 64), 1, 1, 'req-late') as outcome", [target.runId, attempt.id, attempt.token, RESULT]);
      assert.equal(late.rows[0].outcome, "STALE");
      assert.deepEqual([(await row(target.runId)).no_capture, (await row(target.runId)).no_result], [true, true]);
    }
    // No path writes a body back: the trigger and the result-state constraint refuse it even on the owner connection.
    await assert.rejects(admin.query("update app.ai_run set capture = '{}'::jsonb where id = $1", [expired.runId]), { code: "23514" });
    await assert.rejects(admin.query("update app.ai_run set result = $2::jsonb where id = $1", [expired.runId, RESULT]), { code: "23514" });
    await assert.rejects(admin.query("update app.ai_run set result = $2::jsonb where id = $1", [failed.runId, RESULT]), { code: "23514" });
    // A redelivered task for the purged run does nothing: no capture means no request and no model call.
    let calls = 0;
    const gateway: ModelGateway = { generate: async () => { calls += 1; return { kind: "unknown" }; } };
    await runAi(failed.runId, gateway);
    assert.equal(calls, 0);
    assert.equal((await row(failed.runId)).no_capture, true);
  });
});

test("expiry never moves a budget; settlement refunds a never-dispatched reservation once and keeps a possibly started call consumed", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, worker, owner, seed, row, budget, sweep }) => {
    const person = await owner();
    // Original admission days are in the past: a settlement or sweep today must still touch exactly those days.
    const never = await seed(person, { hours: 52, shape: "QUEUED" }); // reserved on its own day, deadline long gone, never claimed
    const started = await seed(person, { hours: 76, shape: "RUNNING" }); // an attempt was claimed (consumed) and never reported
    const history = await seed(person, { hours: 8 * 24, shape: "FAILED" }); // consumed, old enough to lose its bodies
    const dayOf = async (runId: string) => (await admin.query("select to_char(admission_day, 'YYYY-MM-DD') as day from app.ai_run where id = $1", [runId])).rows[0].day;
    const days = { never: await dayOf(never.runId), started: await dayOf(started.runId), history: await dayOf(history.runId) };
    assert.equal(new Set(Object.values(days)).size, 3);
    const day = async (key: keyof typeof days) => (await budget(person)).find((entry) => entry.day === days[key]);
    assert.deepEqual([(await day("never")).reserved_runs, (await day("never")).consumed_runs], [1, 0]);
    assert.deepEqual([(await day("started")).reserved_runs, (await day("started")).consumed_runs], [0, 1]);

    const settle = async (runId: string) => (await worker.query("select app.finish_ai_run($1, 'TIMED_OUT', null) as outcome", [runId])).rows[0].outcome;
    assert.equal(await settle(never.runId), "SETTLED");
    assert.equal(await settle(never.runId), "TERMINAL", "a second settlement is a no-op");
    assert.equal(await settle(started.runId), "SETTLED");
    assert.equal(await settle(started.runId), "TERMINAL");
    await sweep(); await sweep();
    const state = async (key: keyof typeof days) => (await day(key));
    assert.deepEqual([(await state("never")).reserved_runs, (await state("never")).consumed_runs], [0, 0], "never dispatched: refunded exactly once, on its original day");
    assert.deepEqual([(await state("started")).reserved_runs, (await state("started")).consumed_runs], [0, 1], "possibly started: stays consumed on its original day");
    assert.deepEqual([(await state("history")).reserved_runs, (await state("history")).consumed_runs], [0, 1], "body expiry does not touch the day counters");
    assert.deepEqual([(await row(never.runId)).budget_state, (await row(started.runId)).budget_state, (await row(history.runId)).budget_state], ["RELEASED", "CONSUMED", "CONSUMED"]);
    assert.equal((await row(history.runId)).no_capture, true);
  });
});

test("a sweep skips a project settlement or admission holds, then expires only what is eligible on the next tick", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, owner, seed, row, budget }) => {
    const person = await owner();
    const old = await seed(person, { hours: 8 * 24, shape: "SUCCEEDED", uncounted: true });
    const overdue = await seed(person, { hours: 1, shape: "QUEUED", projectId: old.projectId }); // the same project's nonterminal run, reserved, past its deadline
    const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
    const sweeper = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
    await holder.connect(); await sweeper.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from app.project where id = $1 for no key update", [old.projectId]); // what settlement and admission take first
      await sweeper.query("set statement_timeout = '1s'");
      await sweeper.query(SWEEP);
      assert.equal((await row(old.runId)).no_capture, false, "a busy project is left for the next tick");
      assert.equal((await holder.query("select app.finish_ai_run($1, 'TIMED_OUT', null) as outcome", [overdue.runId])).rows[0].outcome, "SETTLED"); // settlement under the same lock
      await holder.query("commit");
      await sweeper.query(SWEEP);
      assert.deepEqual([(await row(old.runId)).no_capture, (await row(old.runId)).disposition], [true, "EXPIRED"]);
      const settled = await row(overdue.runId);
      assert.deepEqual([settled.state, settled.budget_state, settled.no_capture], ["TIMED_OUT", "RELEASED", false], "the fresh terminal run keeps its bodies");
      assert.deepEqual((await budget(person)).reduce((sum, entry) => sum + entry.reserved_runs, 0), 0, "one refund, no double release");
      assert.equal((await admin.query("select count(*)::int n from app.audit_event where project_id = $1 and action = 'AI_RUN_TIMED_OUT'", [old.projectId])).rows[0].n, 1);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end(); await sweeper.end();
    }
  });
});

test("mixed preview and AI cleanup never waits on a project while holding its preview", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, owner, seed, row, sweep }) => {
    const person = await owner();
    const old = await seed(person, { hours: 8 * 24, shape: "SUCCEEDED", uncounted: true });
    const { rows: [preview] } = await admin.query(`insert into app.flow_import_preview
      (id,project_id,draft_id,actor_id,expected_document_revision,payload,positions,fidelity_report,preview_hash,payload_hash,created_at,expires_at)
      select gen_random_uuid(),project_id,draft_id,$2,expected_document_revision,'{}','[]','{}',repeat('a',64),repeat('a',64),now()-interval '24 hours',now()-interval '1 second'
      from app.ai_run where id=$1 returning id`, [old.runId, person]);
    const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
    const cleaner = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
    await holder.connect(); await cleaner.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from app.project where id=$1 for update", [old.projectId]);
      await cleaner.query("begin");
      await cleaner.query("set local statement_timeout = '1s'");
      await cleaner.query(SWEEP); // it owns the preview child, but must skip the busy AI parent
      assert.equal((await row(old.runId)).no_capture, false);
      assert.equal((await cleaner.query("select payload from app.flow_import_preview where id=$1", [preview.id])).rows[0].payload, null);
      const previewLock = holder.query("select id from app.flow_import_preview where id=$1 for update", [preview.id]);
      await cleaner.query("commit"); // releases the child so the parent-owning transaction can finish
      await previewLock;
      await holder.query("commit");
    } finally {
      await cleaner.query("rollback").catch(() => undefined);
      await holder.query("rollback").catch(() => undefined);
      await cleaner.end(); await holder.end();
    }
    await sweep();
    assert.deepEqual([(await row(old.runId)).no_capture, (await row(old.runId)).disposition], [true, "EXPIRED"]);
  });
});

test("a run another transaction holds is skipped, never erased or waited for, and expires on the next sweep", { skip: !canRun }, async () => {
  await withWorld(async ({ owner, seed, row, sweep }) => {
    const old = await seed(await owner(), { hours: 9 * 24, shape: "SUCCEEDED", uncounted: true });
    const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from app.ai_run where id = $1 for update", [old.runId]);
      await sweep(); // must return promptly (statement timeout 5 s) and leave the held run alone
      assert.equal((await row(old.runId)).no_capture, false);
      await holder.query("rollback");
    } finally { await holder.end(); }
    await sweep();
    assert.deepEqual([(await row(old.runId)).no_capture, (await row(old.runId)).disposition], [true, "EXPIRED"]);
  });
});

test("project deletion refunds only proved-undispatched reservations once and fences late delivery", { skip: !canRun }, async () => {
  await withWorld(async ({ admin, worker, owner, seed, budget }) => {
    const person = await owner();
    const never = await seed(person, { hours: 52, shape: "QUEUED" });
    const uncertain = await seed(person, { hours: 52, shape: "QUEUED" });
    const started = await seed(person, { hours: 76, shape: "RUNNING" });
    const settled = await seed(person, { hours: 52, shape: "QUEUED" });
    // A dispatch lease can precede a lost acknowledgement. It is not proof that no call started.
    await admin.query("update app.ai_run set dispatch_lease_until = now() - interval '1 hour' where id = $1", [uncertain.runId]);
    await worker.query("select app.finish_ai_run($1, 'TIMED_OUT', null)", [settled.runId]);
    const before = await budget(person);
    assert.equal(before.reduce((sum, day) => sum + day.reserved_runs, 0), 2);
    assert.equal(before.reduce((sum, day) => sum + day.consumed_runs, 0), 1);
    const targets = [never, uncertain, started, settled];
    for (const target of targets) await admin.query("delete from app.project where id = $1", [target.projectId]);
    const after = await budget(person);
    assert.equal(after.reduce((sum, day) => sum + day.reserved_runs, 0), 0);
    assert.equal(after.reduce((sum, day) => sum + day.consumed_runs, 0), 2, "unknown dispatch and claimed usage remain charged");
    assert.deepEqual(after.map((day) => day.day), before.map((day) => day.day), "no charge moves to today's budget");
    for (const target of targets) {
      assert.equal((await admin.query("delete from app.project where id = $1", [target.projectId])).rowCount, 0);
      assert.equal((await worker.query("select app.finish_ai_run($1, 'TIMED_OUT', null) as outcome", [target.runId])).rows[0].outcome, "MISSING");
      await runAi(target.runId, { generate: async () => { throw new Error("deleted runs must never call the model"); } });
      assert.equal((await admin.query("select id from app.ai_run where id = $1", [target.runId])).rowCount, 0);
    }
    assert.deepEqual(await budget(person), after, "repeat deletion and late settlement cannot refund twice");
  });
});
