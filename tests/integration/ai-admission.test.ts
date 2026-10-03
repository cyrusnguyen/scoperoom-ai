import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { emptyDraft } from "../../src/features/drafts/contracts/scope-document.ts";
import { captureInput } from "../../src/features/proposals/domain/capture.ts";
import { parseStartRunInput } from "../../src/features/proposals/contracts/tasks.ts";
import { requireEnv } from "../support/env.ts";
import { insertProfile, insertProject, removeSchemaRows } from "./support/schema-fixture.ts";

// Restricted AI storage (Stage 06.1): constraints and triggers are proved on the owner/bootstrap connection, privileges on the real
// web and worker runtime connections, and the claim/settle/expire functions through the worker runtime that will call them.
const canRun = requireEnv(["SCOPEROOM_BOOTSTRAP_DATABASE_URL", "DATABASE_URL", "WORKER_DATABASE_URL"]);
const code = (expected: string) => (error: unknown) => { assert.equal((error as { code?: string }).code, expected, String((error as Error).message)); return true; };
const CHECK = "23514", FK = "23503", UNIQUE = "23505", DENIED = "42501";

type Seed = { owner: string; actor: string; projectId: string; draftId: string; runId: string; promptVersionId: string };
type Ctx = { admin: Client; web: Client; worker: Client; profiles: string[]; seed: (options?: { createdAt?: Date; actor?: string; projectId?: string; owner?: string }) => Promise<Seed>; project: () => Promise<{ owner: string; projectId: string }> };

async function withContext(run: (ctx: Ctx) => Promise<void>) {
  const admin = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  const web = new Client({ connectionString: process.env.DATABASE_URL! });
  const worker = new Client({ connectionString: process.env.WORKER_DATABASE_URL! });
  await Promise.all([admin.connect(), web.connect(), worker.connect()]);
  const profiles: string[] = [];
  const project = async () => {
    const owner = await insertProfile(admin); profiles.push(owner);
    await admin.query("insert into app.pilot_entitlement (profile_id, granted_by_operator) values ($1, gen_random_uuid())", [owner]);
    return { owner, projectId: await insertProject(admin, owner) };
  };
  const seed: Ctx["seed"] = async (options = {}) => {
    const created = options.projectId && options.owner ? { owner: options.owner, projectId: options.projectId } : await project();
    const actor = options.actor ?? created.owner;
    const createdAt = options.createdAt ?? new Date();
    const { rows: [draft] } = await admin.query<{ current_draft_id: string }>("select current_draft_id from app.project where id = $1", [created.projectId]);
    const input = parseStartRunInput({ taskType: "PROPOSE_FLOW", prompt: "make a flow", draftId: draft!.current_draft_id, expectedDocumentRevision: 1, expectedParentSnapshotId: null, context: { selection: null, sources: [] } }, "k".repeat(20));
    const { capture, hash } = captureInput({ projectId: created.projectId, draftId: draft!.current_draft_id, documentRevision: 1, parentSnapshotId: null, document: emptyDraft().document, sources: [], model: "test-model" }, input);
    await admin.query("begin");
    try {
      await admin.query("insert into app.ai_owner_allowance (owner_id) values ($1) on conflict do nothing", [created.owner]);
      await admin.query("insert into app.ai_budget_day (owner_id, day, reserved_runs) values ($1, ($2::timestamptz at time zone 'UTC')::date, 1) on conflict (owner_id, day) do update set reserved_runs = ai_budget_day.reserved_runs + 1", [created.owner, createdAt]);
      const { rows: [source] } = await admin.query<{ id: string }>("insert into app.source_document (project_id, kind, created_by) values ($1, 'AI_PROMPT', $2) returning id", [created.projectId, actor]);
      const { rows: [version] } = await admin.query<{ id: string }>(
        `insert into app.source_version (project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by)
         select $1, $2, 1, 'Instruction', t, char_length(t), octet_length(t), encode(sha256(convert_to(t, 'UTF8')), 'hex'), $4 from (values ($3::text)) as v(t) returning id`, [created.projectId, source!.id, capture.prompt, actor]);
      await admin.query("update app.source_document set current_version_id = $1 where id = $2", [version!.id, source!.id]);
      const { rows: [run] } = await admin.query<{ id: string }>(
        `insert into app.ai_run (project_id, draft_id, actor_id, owner_id, admission_day, prompt_source_version_id, task_type, model, execution_binding, capture, capture_hash, expected_document_revision, deadline_at, created_at)
         values ($1, $2, $3, $4, ($5::timestamptz at time zone 'UTC')::date, $6, 'PROPOSE_FLOW', 'test-model', 'binding-1', $7::jsonb, $8, 1, $5::timestamptz + interval '300 seconds', $5) returning id`,
        [created.projectId, draft!.current_draft_id, actor, created.owner, createdAt, version!.id, JSON.stringify(capture), hash]);
      await admin.query("commit");
      return { owner: created.owner, actor, projectId: created.projectId, draftId: draft!.current_draft_id, runId: run!.id, promptVersionId: version!.id };
    } catch (error) { await admin.query("rollback"); throw error; }
  };
  try {
    await run({ admin, web, worker, profiles, seed, project });
  } finally {
    await web.end(); await worker.end();
    try { await removeSchemaRows(admin, profiles); } finally { await admin.end(); }
  }
}

const claim = async (worker: Client, runId: string) => (await worker.query("select * from app.claim_ai_attempt($1)", [runId])).rows[0] as { out_status: string; out_attempt_id: string; out_attempt_number: number; out_attempt_token: string; out_attempt_deadline_at: Date };
const settle = async (worker: Client, runId: string, attempt: { out_attempt_id: string; out_attempt_token: string }, outcome: string, result: object | null = null, hash: string | null = null) =>
  (await worker.query<{ settle_ai_attempt: string }>("select app.settle_ai_attempt($1, $2, $3, $4::text::app.ai_attempt_outcome, $5::jsonb, $6, 11, 7, 'req-1')", [runId, attempt.out_attempt_id, attempt.out_attempt_token, outcome, result && JSON.stringify(result), hash])).rows[0]!.settle_ai_attempt;
const finish = async (worker: Client, runId: string, state: string, failure: string | null = null) =>
  (await worker.query<{ finish_ai_run: string }>("select app.finish_ai_run($1, $2::text::app.ai_run_state, $3)", [runId, state, failure])).rows[0]!.finish_ai_run;
const budget = async (admin: Client, owner: string) => (await admin.query<{ reserved_runs: number; consumed_runs: number }>("select reserved_runs, consumed_runs from app.ai_budget_day where owner_id = $1", [owner])).rows;
const run = async (admin: Client, runId: string) => (await admin.query("select state::text, disposition::text, budget_state::text, current_attempt_id, terminal_at, result, capture, failure_code, last_event_sequence from app.ai_run where id = $1", [runId])).rows[0]!;
const RESULT = { schemaVersion: 1, kind: "clarification", message: "need more" };
const HASH = "a".repeat(64);

test("one nonterminal run per project, owner-day counters stay inside 0..30, attempts stay 1..2", { skip: !canRun }, async () => {
  await withContext(async ({ admin, seed }) => {
    const first = await seed();
    await assert.rejects(seed({ owner: first.owner, projectId: first.projectId }), code(UNIQUE));
    for (const [reserved, consumed] of [[-1, 0], [0, -1], [20, 11], [31, 0]]) {
      await assert.rejects(admin.query("update app.ai_budget_day set reserved_runs = $2, consumed_runs = $3 where owner_id = $1", [first.owner, reserved, consumed]), code(CHECK));
    }
    await admin.query("update app.ai_budget_day set reserved_runs = 20, consumed_runs = 10 where owner_id = $1", [first.owner]);
    for (const number of [0, 3]) await assert.rejects(admin.query("insert into app.ai_run_attempt (run_id, attempt_number, deadline_at) values ($1, $2, now() + interval '1 minute')", [first.runId, number]), code(CHECK));
    await admin.query("insert into app.ai_run_attempt (run_id, attempt_number, deadline_at) values ($1, 1, now() + interval '1 minute')", [first.runId]);
    await assert.rejects(admin.query("insert into app.ai_run_attempt (run_id, attempt_number, deadline_at) values ($1, 1, now() + interval '1 minute')", [first.runId]), code(UNIQUE));
    await assert.rejects(admin.query("insert into app.ai_run_attempt (run_id, attempt_number, deadline_at) values ($1, 2, now() + interval '3 minutes')", [first.runId]), code(CHECK));
  });
});

test("cross-project keys, attempt pointers and the deferred source head are enforced", { skip: !canRun }, async () => {
  await withContext(async ({ admin, seed, project }) => {
    const a = await seed(); const b = await seed();
    const other = await project();
    const { rows: [otherDraft] } = await admin.query<{ current_draft_id: string }>("select current_draft_id from app.project where id = $1", [other.projectId]);
    await assert.rejects(admin.query("update app.ai_run set draft_id = $2 where id = $1", [a.runId, otherDraft!.current_draft_id]), code(CHECK)); // identity trigger first
    const sql = `insert into app.ai_run (project_id, draft_id, actor_id, owner_id, admission_day, prompt_source_version_id, task_type, model, execution_binding, capture, capture_hash, expected_document_revision, deadline_at)
                 select $1, $2, $3, $3, (now() at time zone 'UTC')::date, $4, 'PROPOSE_FLOW', 'test-model', 'b', capture, capture_hash, 1, now() + interval '5 minutes' from app.ai_run where id = $5`;
    await admin.query("update app.ai_run set state = 'FAILED', failure_code = 'TEST', terminal_at = now() where id = $1", [a.runId]);
    await assert.rejects(admin.query(sql.replace("'b', capture, capture_hash", "'b', jsonb_set(capture, '{draftId}', to_jsonb($2::uuid::text)), capture_hash"), [a.projectId, otherDraft!.current_draft_id, a.owner, a.promptVersionId, a.runId]), code(FK)); // draft of another project (capture agrees, so the key is what rejects)
    await assert.rejects(admin.query(sql, [a.projectId, a.draftId, a.owner, b.promptVersionId, a.runId]), code(CHECK)); // prompt evidence of another project
    await admin.query("insert into app.ai_run_attempt (run_id, attempt_number, deadline_at) values ($1, 1, now() + interval '1 minute') returning id", [b.runId]);
    const { rows: [attemptOfB] } = await admin.query<{ id: string }>("select id from app.ai_run_attempt where run_id = $1", [b.runId]);
    await assert.rejects(admin.query("update app.ai_run set state = 'RUNNING', current_attempt_id = $2 where id = $1", [a.runId, attemptOfB!.id]), code(CHECK)); // terminal run first
    const c = await seed();
    await assert.rejects(admin.query("update app.ai_run set current_attempt_id = $2 where id = $1", [c.runId, attemptOfB!.id]), code(FK)); // pointer to another run's attempt
    await assert.rejects(admin.query("update app.source_document set current_version_id = $2 where project_id = $1 and id = (select source_id from app.source_version where id = $3)", [a.projectId, b.promptVersionId, a.promptVersionId]), code(FK));
    await assert.rejects(admin.query("insert into app.source_document (project_id, kind, created_by) values ($1, 'USER_TEXT', $2)", [a.projectId, a.owner]).then(() => admin.query("select 1")), code(CHECK)); // autocommit: no head at commit
  });
});

test("source versions are immutable and carry exact, normalized, counted evidence", { skip: !canRun }, async () => {
  await withContext(async ({ admin, web, seed }) => {
    const s = await seed();
    await assert.rejects(admin.query("update app.source_version set title = 'changed' where id = $1", [s.promptVersionId]), code(CHECK));
    await assert.rejects(web.query("update app.source_version set text = 'x' where id = $1", [s.promptVersionId]), code(DENIED));
    await assert.rejects(web.query("delete from app.source_version where id = $1", [s.promptVersionId]), code(DENIED));
    const doc = (await admin.query<{ source_id: string }>("select source_id from app.source_version where id = $1", [s.promptVersionId])).rows[0]!.source_id;
    const insert = (text: string, count: number, bytes: number, hash: string, sequence = 2) => admin.query(
      "insert into app.source_version (project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by) values ($1, $2, $3, 't', $4, $5, $6, $7, $8)",
      [s.projectId, doc, sequence, text, count, bytes, hash, s.owner]);
    const hashOf = async (text: string) => (await admin.query<{ h: string }>("select encode(sha256(convert_to($1::text, 'UTF8')), 'hex') h", [text])).rows[0]!.h;
    await assert.rejects(insert("a", 1, 1, HASH), code(CHECK)); // hash is recomputed
    await assert.rejects(insert("a", 2, 1, await hashOf("a")), code(CHECK)); // code points
    await assert.rejects(insert("a", 1, 2, await hashOf("a")), code(CHECK)); // bytes
    await assert.rejects(insert("a\r\nb", 4, 4, await hashOf("a\r\nb")), code(CHECK)); // CR survives normalization
    await assert.rejects(insert("﻿a", 2, 4, await hashOf("﻿a")), code(CHECK)); // BOM survives normalization
    await assert.rejects(insert("a".repeat(50_001), 50_001, 50_001, await hashOf("a".repeat(50_001))), code(CHECK));
    await assert.rejects(insert("a", 1, 1, await hashOf("a"), 1), code(UNIQUE)); // sequence
    await insert("😀é", 2, 6, await hashOf("😀é")); // counts are code points and UTF-8 bytes
  });
});

test("an admitted run starts queued, charged to the owner, with matching prompt evidence", { skip: !canRun }, async () => {
  await withContext(async ({ admin, seed, project }) => {
    const s = await seed();
    const row = await run(admin, s.runId);
    assert.deepEqual([row.state, row.budget_state, row.disposition, row.result], ["QUEUED", "RESERVED", null, null]);
    const copy = (column: string, value: string) => admin.query(
      `insert into app.ai_run (project_id, draft_id, actor_id, owner_id, admission_day, prompt_source_version_id, task_type, model, execution_binding, capture, capture_hash, expected_document_revision, deadline_at, ${column})
       select project_id, draft_id, actor_id, owner_id, admission_day, prompt_source_version_id, task_type, model, execution_binding, capture, capture_hash, expected_document_revision, deadline_at, ${value} from app.ai_run where id = $1`, [s.runId]);
    await admin.query("update app.ai_run set state = 'FAILED', failure_code = 'TEST', terminal_at = now() where id = $1", [s.runId]);
    await assert.rejects(copy("state", "'SUCCEEDED'"), code(CHECK));
    await assert.rejects(copy("result", `'{"a":1}'::jsonb`), code(CHECK));
    await assert.rejects(copy("budget_state", "'CONSUMED'"), code(CHECK));
    await assert.rejects(copy("cancel_requested_at", "now()"), code(CHECK));
    const other = await project();
    await assert.rejects(admin.query("update app.ai_run set owner_id = $2 where id = $1", [s.runId, other.owner]), code(CHECK));
    const stranger = await insertProfile(admin);
    try {
      await assert.rejects(admin.query(
        `insert into app.ai_run (project_id, draft_id, actor_id, owner_id, admission_day, prompt_source_version_id, task_type, model, execution_binding, capture, capture_hash, expected_document_revision, deadline_at)
         select project_id, draft_id, $2, owner_id, admission_day, prompt_source_version_id, task_type, model, execution_binding, capture, capture_hash, expected_document_revision, deadline_at from app.ai_run where id = $1`, [s.runId, stranger]), code(CHECK)); // prompt written by someone else
      await assert.rejects(admin.query(
        `insert into app.ai_run (project_id, draft_id, actor_id, owner_id, admission_day, prompt_source_version_id, task_type, model, execution_binding, capture, capture_hash, expected_document_revision, deadline_at)
         select project_id, draft_id, actor_id, owner_id, admission_day, prompt_source_version_id, 'REFINE_FLOW_SELECTION', model, execution_binding, capture, capture_hash, expected_document_revision, deadline_at from app.ai_run where id = $1`, [s.runId]), code(CHECK)); // capture disagrees with the task
    } finally { await admin.query("delete from app.user_profile where id = $1", [stranger]); }
  });
});

test("capture, result and identity are immutable and bodies leave only after the retention window", { skip: !canRun }, async () => {
  await withContext(async ({ admin, seed }) => {
    const s = await seed();
    for (const assignment of ["task_type = 'REFINE_FLOW_SELECTION'", "model = 'other'", "capture_hash = repeat('b', 64)", "deadline_at = deadline_at + interval '1 second'", "expected_document_revision = 2", "dispatch_id = gen_random_uuid()", "capture = '{}'::jsonb"]) {
      await assert.rejects(admin.query(`update app.ai_run set ${assignment} where id = $1`, [s.runId]), code(CHECK), assignment);
    }
    await assert.rejects(admin.query("update app.ai_run set capture = null where id = $1", [s.runId]), code(CHECK)); // not terminal
    await admin.query("update app.ai_run set state = 'RUNNING' where id = $1", [s.runId]);
    await admin.query("update app.ai_run set state = 'SUCCEEDED', disposition = 'AVAILABLE', result = $2::jsonb, result_hash = $3, terminal_at = now() where id = $1", [s.runId, JSON.stringify(RESULT), HASH]);
    for (const assignment of ["result = '{}'::jsonb", "result_hash = repeat('c', 64)", "state = 'FAILED'", "terminal_at = now() - interval '9 days'", "disposition = 'EXPIRED', capture = null"]) {
      await assert.rejects(admin.query(`update app.ai_run set ${assignment} where id = $1`, [s.runId]), code(CHECK), assignment);
    }
    await assert.rejects(admin.query("update app.ai_run set result = null where id = $1", [s.runId]), code(CHECK)); // seven-day boundary
    await admin.query("update app.ai_run set disposition = 'DISCARDED' where id = $1", [s.runId]);
    await assert.rejects(admin.query("update app.ai_run set disposition = 'AVAILABLE' where id = $1", [s.runId]), code(CHECK));
  });
});

test("the worker claims at most two calls, consumes the reservation once and refuses duplicates while one is open", { skip: !canRun }, async () => {
  await withContext(async ({ admin, worker, seed }) => {
    const s = await seed();
    assert.deepEqual(await budget(admin, s.owner), [{ reserved_runs: 1, consumed_runs: 0 }]);
    const first = await claim(worker, s.runId);
    assert.equal(first.out_status, "CLAIMED"); assert.equal(first.out_attempt_number, 1);
    assert.deepEqual(await budget(admin, s.owner), [{ reserved_runs: 0, consumed_runs: 1 }]);
    const open = await run(admin, s.runId);
    assert.equal(open.state, "RUNNING"); assert.equal(open.current_attempt_id, first.out_attempt_id); assert.equal(open.budget_state, "CONSUMED");
    const { rows: [attempt] } = await admin.query("select call_may_have_started, outcome, extract(epoch from deadline_at - started_at)::int as window from app.ai_run_attempt where id = $1", [first.out_attempt_id]);
    assert.equal(attempt.call_may_have_started, true); assert.equal(attempt.outcome, null);
    assert.equal(attempt.window, 120);
    assert.equal((await claim(worker, s.runId)).out_status, "BUSY"); // duplicate delivery while the call is unreported
    assert.equal((await admin.query("select count(*)::int c from app.ai_run_attempt where run_id = $1", [s.runId])).rows[0].c, 1);
    assert.equal(await settle(worker, s.runId, first, "UNAVAILABLE"), "RECORDED");
    const second = await claim(worker, s.runId);
    assert.equal(second.out_status, "CLAIMED"); assert.equal(second.out_attempt_number, 2);
    assert.equal(await settle(worker, s.runId, second, "UNKNOWN"), "RECORDED");
    assert.equal((await claim(worker, s.runId)).out_status, "CEILING");
    assert.equal((await admin.query("select count(*)::int c from app.ai_run_attempt where run_id = $1", [s.runId])).rows[0].c, 2);
    assert.deepEqual(await budget(admin, s.owner), [{ reserved_runs: 0, consumed_runs: 1 }]); // one logical run, however many calls
    const { rows: [project] } = await admin.query("select event_sequence::int es, ai_revision::int ai from app.project where id = $1", [s.projectId]);
    assert.equal(project.ai, project.es); assert.ok(project.ai >= 1);
  });
});

test("an old attempt, a wrong token or late output cannot settle", { skip: !canRun }, async () => {
  await withContext(async ({ admin, worker, seed }) => {
    const s = await seed();
    const first = await claim(worker, s.runId);
    assert.equal(await settle(worker, s.runId, { ...first, out_attempt_token: randomUUID() }, "COMPLETED", RESULT, HASH), "STALE");
    assert.equal(await settle(worker, s.runId, { ...first, out_attempt_id: randomUUID() }, "COMPLETED", RESULT, HASH), "STALE");
    assert.equal(await settle(worker, s.runId, first, "REFUSED"), "RECORDED");
    assert.equal(await settle(worker, s.runId, first, "COMPLETED", RESULT, HASH), "STALE"); // already reported: never overwritten
    const second = await claim(worker, s.runId);
    assert.equal(await settle(worker, s.runId, first, "COMPLETED", RESULT, HASH), "STALE"); // the older attempt cannot settle a newer claim
    assert.equal(await settle(worker, s.runId, second, "COMPLETED", RESULT, HASH), "SUCCEEDED");
    const done = await run(admin, s.runId);
    assert.deepEqual([done.state, done.disposition, done.result], ["SUCCEEDED", "AVAILABLE", RESULT]);
    assert.equal((await claim(worker, s.runId)).out_status, "TERMINAL");
    assert.equal(await settle(worker, s.runId, second, "COMPLETED", { ...RESULT, message: "again" }, HASH), "STALE"); // terminal content is not resurrected
    assert.deepEqual((await run(admin, s.runId)).result, RESULT);
    const { rows: usage } = await admin.query("select input_tokens, output_tokens, provider_request_id from app.ai_run_attempt where id = $1", [second.out_attempt_id]);
    assert.deepEqual(usage, [{ input_tokens: 11, output_tokens: 7, provider_request_id: "req-1" }]);
  });
});

test("cancellation, lost access and the deadline fence claims and late output", { skip: !canRun }, async () => {
  await withContext(async ({ admin, web, worker, seed }) => {
    // Cancel intent recorded by the web runtime fences a claim; the worker then settles CANCELLED, releasing the unclaimed slot once.
    const cancelled = await seed();
    await web.query("update app.ai_run set cancel_requested_at = now() where id = $1", [cancelled.runId]);
    assert.equal((await claim(worker, cancelled.runId)).out_status, "CANCELLED");
    assert.equal(await finish(worker, cancelled.runId, "TIMED_OUT"), "REFUSED"); // before the deadline
    assert.equal(await finish(worker, cancelled.runId, "CANCELLED"), "SETTLED");
    assert.equal(await finish(worker, cancelled.runId, "CANCELLED"), "TERMINAL");
    assert.deepEqual(await budget(admin, cancelled.owner), [{ reserved_runs: 0, consumed_runs: 0 }]);
    assert.equal((await run(admin, cancelled.runId)).budget_state, "RELEASED");

    // Cancellation after the call began: late output is fenced, the call stays consumed, the attempt reads CANCELLED.
    const midCall = await seed();
    const attempt = await claim(worker, midCall.runId);
    await web.query("update app.ai_run set cancel_requested_at = now() where id = $1", [midCall.runId]);
    await assert.rejects(web.query("update app.ai_run set cancel_requested_at = null where id = $1", [midCall.runId]), code(CHECK));
    assert.equal(await settle(worker, midCall.runId, attempt, "COMPLETED", RESULT, HASH), "FENCED");
    assert.deepEqual([(await run(admin, midCall.runId)).state, (await run(admin, midCall.runId)).result], ["RUNNING", null]);
    assert.equal(await finish(worker, midCall.runId, "CANCELLED"), "SETTLED");
    assert.deepEqual(await budget(admin, midCall.owner), [{ reserved_runs: 0, consumed_runs: 1 }]);

    // A revoked owner entitlement cannot claim (read, never locked, by the worker). Member authority is covered in the next test.

    const denied = await seed();
    await admin.query("update app.pilot_entitlement set revoked_at = now() where profile_id = $1", [denied.owner]);
    assert.equal((await claim(worker, denied.runId)).out_status, "DENIED");
    await admin.query("update app.pilot_entitlement set revoked_at = null where profile_id = $1", [denied.owner]);
    // Deadline: no claim after it, and the overdue run settles TIMED_OUT without a release for a call that may have started.
    const overdue = await seed({ createdAt: new Date(Date.now() - 10 * 60_000) });
    assert.equal((await claim(worker, overdue.runId)).out_status, "DEADLINE");
    assert.equal(await finish(worker, overdue.runId, "TIMED_OUT", "DEADLINE_EXCEEDED"), "SETTLED");
    assert.equal((await run(admin, overdue.runId)).failure_code, "DEADLINE_EXCEEDED");
    assert.equal((await run(admin, overdue.runId)).state, "TIMED_OUT");
    assert.deepEqual(await budget(admin, overdue.owner), [{ reserved_runs: 0, consumed_runs: 0 }]); // never claimed: proved never dispatched
  });
});

test("a collaborator's authority is rechecked at claim and settlement", { skip: !canRun }, async () => {
  await withContext(async ({ admin, worker, seed, project, profiles }) => {
    const { owner, projectId } = await project();
    const editor = await insertProfile(admin); profiles.push(editor);
    await admin.query("insert into app.project_membership (project_id, profile_id, role) values ($1, $2, 'EDITOR')", [projectId, editor]);
    const s = await seed({ owner, projectId, actor: editor });
    const first = await claim(worker, s.runId);
    assert.equal(first.out_status, "CLAIMED");
    await admin.query("update app.project_membership set role = 'VIEWER' where project_id = $1 and profile_id = $2", [projectId, editor]);
    assert.equal(await settle(worker, s.runId, first, "COMPLETED", RESULT, HASH), "FENCED"); // lost authority during the call
    assert.equal(await finish(worker, s.runId, "FAILED", "ACCESS_DENIED"), "SETTLED");
    const { rows: [attempt] } = await admin.query("select outcome::text from app.ai_run_attempt where id = $1", [first.out_attempt_id]);
    assert.equal(attempt.outcome, "COMPLETED"); // the call happened; its output was not stored
    assert.deepEqual([(await run(admin, s.runId)).state, (await run(admin, s.runId)).result], ["FAILED", null]);
  });
});

test("the web runtime cannot forge worker results or touch immutable evidence; the worker cannot write drafts", { skip: !canRun }, async () => {
  await withContext(async ({ admin, web, worker, seed }) => {
    const s = await seed();
    const r = s.runId;
    for (const statement of [
      `update app.ai_run set state = 'SUCCEEDED' where id = '${r}'`, `update app.ai_run set result = '{}'::jsonb where id = '${r}'`, `update app.ai_run set capture = '{}'::jsonb where id = '${r}'`,
      `update app.ai_run set current_attempt_id = null where id = '${r}'`, `update app.ai_run set budget_state = 'RELEASED' where id = '${r}'`, `update app.ai_run set task_id = 'x' where id = '${r}'`,
      `delete from app.ai_run where id = '${r}'`, `update app.source_version set text = 'x' where id = '${s.promptVersionId}'`, `delete from app.source_document where project_id = '${s.projectId}'`,
    ]) await assert.rejects(web.query(statement), code(DENIED), statement);
    await assert.rejects(web.query("insert into app.ai_run_attempt (run_id, attempt_number, deadline_at) values ($1, 1, now() + interval '1 minute')", [s.runId]), code(DENIED));
    await assert.rejects(web.query("update app.ai_budget_day set consumed_runs = 0 where owner_id = $1", [s.owner]), code(DENIED));
    for (const call of [`select * from app.claim_ai_attempt('${r}')`, `select app.finish_ai_run('${r}', 'FAILED', 'X')`, "select * from app.expire_ai_run_bodies(true, 10)", `select app.record_ai_event(gen_random_uuid(), '${r}', 'x', '{}')`]) {
      await assert.rejects(web.query(call), code(DENIED), call);
    }
    await web.query("update app.ai_run set cancel_requested_at = now() where id = $1", [s.runId]); // allowed: cancel intent
    await web.query("update app.ai_budget_day set reserved_runs = reserved_runs where owner_id = $1", [s.owner]); // allowed: admission reservation
    await web.query("update app.project set ai_revision = ai_revision where id = $1", [s.projectId]);

    for (const statement of [
      `update app.ai_run set state = 'RUNNING' where id = '${r}'`, `update app.ai_run set cancel_requested_at = null where id = '${r}'`, `update app.ai_run set result = '{}'::jsonb where id = '${r}'`,
      "insert into app.ai_owner_allowance (owner_id) values (gen_random_uuid())", "update app.ai_budget_day set reserved_runs = 0", "update app.ai_run_attempt set outcome = 'COMPLETED'",
      "update app.scope_draft set document_json = '{}'::jsonb", "update app.project_membership set role = 'EDITOR'", "update app.pilot_entitlement set active = true",
      "update app.project set ai_revision = 0, event_sequence = 0", "insert into app.source_version (project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by) values (gen_random_uuid(), gen_random_uuid(), 1, 't', 'a', 1, 1, 'x', gen_random_uuid())",
      "insert into app.audit_event (project_id, sequence, service_action, action, entity_refs, metadata) values (gen_random_uuid(), 1, 'x', 'x', '{}', '{}')",
    ]) await assert.rejects(worker.query(statement), code(DENIED), statement);
    await worker.query("update app.ai_run set dispatch_state = 'DISPATCHED', task_id = 'task-1', dispatch_lease_until = null where id = $1", [s.runId]); // allowed: dispatch acknowledgement
    await assert.rejects(admin.query("update app.ai_run set task_id = 'task-2' where id = $1", [s.runId]), code(CHECK)); // and final
    // Even after RESET ROLE the runtime login holds nothing of its own.
    await worker.query("begin"); await worker.query("reset role");
    await assert.rejects(worker.query("update app.ai_run set state = 'RUNNING' where id = $1", [s.runId]), code(DENIED));
    await worker.query("rollback");
  });
});

test("body expiry is bounded, spares applied evidence and marks only unused results expired", { skip: !canRun }, async () => {
  await withContext(async ({ admin, web, worker, seed }) => {
    const age = (days: number) => `now() - interval '${days} days'`;
    const terminal = async (s: Seed, state: "SUCCEEDED" | "FAILED", days: number, disposition?: string) => {
      if (state === "SUCCEEDED") {
        await admin.query("update app.ai_run set state = 'RUNNING' where id = $1", [s.runId]);
        await admin.query(`update app.ai_run set state = 'SUCCEEDED', disposition = 'AVAILABLE', result = $2::jsonb, result_hash = $3, terminal_at = ${age(days)} where id = $1`, [s.runId, JSON.stringify(RESULT), HASH]);
        if (disposition) await admin.query("update app.ai_run set disposition = $2::text::app.ai_result_disposition where id = $1", [s.runId, disposition]);
      } else await admin.query(`update app.ai_run set state = 'FAILED', failure_code = 'TEST', terminal_at = ${age(days)} where id = $1`, [s.runId]);
    };
    const unused = await seed(); await terminal(unused, "SUCCEEDED", 8);
    const discarded = await seed(); await terminal(discarded, "SUCCEEDED", 8, "DISCARDED");
    const applied = await seed(); await terminal(applied, "SUCCEEDED", 30, "APPLIED");
    const recent = await seed(); await terminal(recent, "SUCCEEDED", 6);
    const failed = await seed(); await terminal(failed, "FAILED", 8);
    const live = await seed();
    const ids = [unused, discarded, applied, recent, failed, live].map((s) => s.runId);
    const owned = (rows: { id: string }[]) => rows.filter((row) => ids.includes(row.id));
    const before = (await admin.query("select ai_revision::int ai from app.project where id = $1", [unused.projectId])).rows[0].ai;
    const { rows: [dry] } = await worker.query("select * from app.expire_ai_run_bodies(true, 100)");
    assert.ok(dry.expiredResults >= 1 && dry.clearedBodies >= 2);
    assert.equal((await admin.query("select count(*)::int c from app.ai_run where id = $1 and result is not null", [unused.runId])).rows[0].c, 1, "a dry run changes nothing");
    await worker.query("select * from app.expire_ai_run_bodies(false, 100)");
    const rows = (await admin.query("select id, disposition::text d, result is null no_result, capture is null no_capture, result_hash, capture_hash from app.ai_run where id = any($1::uuid[])", [ids])).rows;
    const by = (s: Seed) => rows.find((row) => row.id === s.runId)!;
    assert.deepEqual([by(unused).d, by(unused).no_result, by(unused).no_capture], ["EXPIRED", true, true]);
    assert.deepEqual([by(discarded).d, by(discarded).no_result, by(discarded).no_capture], ["DISCARDED", true, true]);
    assert.deepEqual([by(failed).d, by(failed).no_capture], [null, true]);
    assert.deepEqual([by(applied).d, by(applied).no_result, by(applied).no_capture], ["APPLIED", false, false], "applied evidence survives");
    assert.deepEqual([by(recent).d, by(recent).no_result, by(recent).no_capture], ["AVAILABLE", false, false]);
    assert.deepEqual([by(live).no_capture], [false]);
    assert.equal(by(unused).result_hash, HASH); assert.match(by(unused).capture_hash, /^[0-9a-f]{64}$/); // identity survives
    assert.equal(owned(rows).length, 6);
    assert.ok((await admin.query("select ai_revision::int ai from app.project where id = $1", [unused.projectId])).rows[0].ai > before, "expiry advances the AI cursor");
    await assert.rejects(web.query("select * from app.expire_ai_run_bodies(false, 100)"), code(DENIED));
  });
});
