import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Client } from "pg";
import { emptyDraft } from "../../src/features/drafts/contracts/scope-document.ts";
import { AI_LIMITS, parseStartRunInput, type StartRunInput } from "../../src/features/proposals/contracts/tasks.ts";
import { canonicalJson, captureInput, sha256 } from "../../src/features/proposals/domain/capture.ts";
import { admissionSubject, admitRun, aiConfiguration } from "../../src/features/proposals/server/admit-run.ts";
import { canRun, withFixture, type Fixture, type Identity } from "./support/fixture.ts";
import { serializeSweeps } from "./support/sweep-lock.ts";

serializeSweeps(); // the expiry test sweeps globally: see sweep-lock.ts

// Atomic AI admission (Stage 06.1 Task 2) through the real service on the web runtime role, with independent connections.
const CONFIG = { model: "test-model", executionBinding: "binding-1" };
const OTHER_CONFIG = { model: "other-model", executionBinding: "binding-2" };

type Person = { identity: Identity; profile: string };
type Env = Fixture & { person: (label?: string) => Promise<Person>; projectFor: (owner: Person) => Promise<string> };

async function withAdmission(run: (env: Env) => Promise<void>) {
  await withFixture(async (fixture) => {
    const profiles: string[] = [];
    const person = async (label?: string): Promise<Person> => {
      const identity = await fixture.user(label);
      const profile = await fixture.profileId(identity);
      profiles.push(profile);
      return { identity, profile };
    };
    try {
      await run({ ...fixture, person, projectFor: (owner) => fixture.project(owner.identity) });
    } finally {
      await fixture.database.query("delete from app.rate_limit_bucket where subject_hash = any($1::text[])", [profiles.map((profile) => admissionSubject(profile))]);
    }
  });
}

async function draftOf(db: Client, projectId: string) {
  const { rows: [row] } = await db.query<{ id: string; revision: number }>("select d.id, d.document_revision revision from app.project p join app.scope_draft d on d.id = p.current_draft_id where p.id = $1", [projectId]);
  return row!;
}

type StartOptions = { key?: string; prompt?: string; revision?: number; task?: "PROPOSE_FLOW" | "REFINE_FLOW_SELECTION"; sources?: { sourceVersionId: string; expectedCurrentVersionId: string }[] };
async function start(db: Client, projectId: string, options: StartOptions = {}): Promise<StartRunInput> {
  const draft = await draftOf(db, projectId);
  return parseStartRunInput({
    taskType: options.task ?? "PROPOSE_FLOW", prompt: options.prompt ?? "Outline the checkout flow", draftId: draft.id, expectedDocumentRevision: options.revision ?? draft.revision,
    expectedParentSnapshotId: null, context: { selection: null, sources: options.sources ?? [] },
  }, options.key ?? randomUUID());
}

async function footprint(db: Client, projectId: string, owner: string) {
  const { rows: [row] } = await db.query(`select
    (select count(*) from app.source_document where project_id = $1)::int documents, (select count(*) from app.source_version where project_id = $1)::int versions,
    (select count(*) from app.ai_run where project_id = $1)::int runs, (select count(*) from app.audit_event where project_id = $1)::int audits,
    (select count(*) from app.mutation_receipt where scope_id = $1 and operation = 'AI_RUN_START_V1')::int receipts, (select event_sequence::text || '/' || ai_revision::text from app.project where id = $1) cursors,
    (select coalesce(sum(reserved_runs), 0) from app.ai_budget_day where owner_id = $2)::int reserved`, [projectId, owner]);
  return row;
}

/** Seeds one source with the given version lengths (head = last) on the owner/bootstrap connection. Returns the version ids in order. */
async function seedVersions(db: Client, projectId: string, actor: string, lengths: number[], fill = "a") {
  const ids = lengths.map(() => randomUUID());
  const sourceId = randomUUID();
  await db.query("begin");
  try {
    await db.query("insert into app.source_document (id, project_id, kind, current_version_id, created_by) values ($1, $2, 'USER_TEXT', $3, $4)", [sourceId, projectId, ids.at(-1), actor]);
    await db.query(
      `insert into app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by)
       select v.id, $1, $2, v.n, 'Notes', t.text, char_length(t.text), octet_length(t.text), encode(sha256(convert_to(t.text, 'UTF8')), 'hex'), $3
       from unnest($4::uuid[], $5::int[]) with ordinality as v(id, len, n) cross join lateral (select repeat($6::text, v.len) as text) t`,
      [projectId, sourceId, actor, ids, lengths, fill]);
    await db.query("commit");
  } catch (error) { await db.query("rollback"); throw error; }
  return ids;
}

/** One seeded run (with its prompt evidence) written by the owner/bootstrap connection, optionally aged and terminal. */
async function seedRun(db: Client, p: { projectId: string; owner: string; actor?: string; createdAt?: Date; terminal?: "AVAILABLE" }) {
  const actor = p.actor ?? p.owner;
  const createdAt = p.createdAt ?? new Date();
  const draft = await draftOf(db, p.projectId);
  const input = parseStartRunInput({ taskType: "PROPOSE_FLOW", prompt: "seeded", draftId: draft.id, expectedDocumentRevision: 1, expectedParentSnapshotId: null, context: { selection: null, sources: [] } }, randomUUID());
  const { capture, hash } = captureInput({ projectId: p.projectId, draftId: draft.id, documentRevision: 1, parentSnapshotId: null, document: emptyDraft().document, sources: [], model: "seed-model" }, input);
  const versionId = randomUUID(); const sourceId = randomUUID();
  await db.query("begin");
  await db.query("insert into app.source_document (id, project_id, kind, current_version_id, created_by) values ($1, $2, 'AI_PROMPT', $3, $4)", [sourceId, p.projectId, versionId, actor]);
  await db.query(
    `insert into app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by)
     values ($1, $2, $3, 1, 'AI instruction', $4, char_length($4), octet_length($4), $5, $6)`, [versionId, p.projectId, sourceId, capture.prompt, capture.promptHash, actor]);
  await db.query("commit");
  await db.query("insert into app.ai_owner_allowance (owner_id) values ($1) on conflict do nothing", [p.owner]);
  await db.query("insert into app.ai_budget_day (owner_id, day, reserved_runs, consumed_runs) values ($1, ($2::timestamptz at time zone 'UTC')::date, $3, $4) on conflict (owner_id, day) do update set reserved_runs = ai_budget_day.reserved_runs + $3, consumed_runs = ai_budget_day.consumed_runs + $4", [p.owner, createdAt, p.terminal ? 0 : 1, p.terminal ? 1 : 0]);
  const { rows: [run] } = await db.query<{ id: string }>(
    `insert into app.ai_run (project_id, draft_id, actor_id, owner_id, admission_day, prompt_source_version_id, task_type, model, execution_binding, capture, capture_hash, expected_document_revision, deadline_at, created_at)
     values ($1, $2, $3, $4, ($5::timestamptz at time zone 'UTC')::date, $6, 'PROPOSE_FLOW', 'seed-model', 'seed-binding', $7::jsonb, $8, 1, $5::timestamptz + interval '300 seconds', $5) returning id`,
    [p.projectId, draft.id, actor, p.owner, createdAt, versionId, JSON.stringify(capture), hash]);
  if (p.terminal) {
    await db.query("update app.ai_run set state = 'RUNNING', budget_state = 'CONSUMED' where id = $1", [run!.id]);
    await db.query("update app.ai_run set state = 'SUCCEEDED', disposition = 'AVAILABLE', result = $2::jsonb, result_hash = $3, terminal_at = now() where id = $1", [run!.id, JSON.stringify({ schemaVersion: 1, kind: "clarification", message: "x" }), "a".repeat(64)]);
  }
  return run!.id;
}

/** Waits until at least `expected` backends wait on the holder, directly or through another waiter. */
async function blockedBy(db: Client, blockerPid: number, expected = 1) {
  const deadline = Date.now() + 5_000;
  let waiting = 0;
  while (Date.now() < deadline) {
    const { rows: [row] } = await db.query<{ waiting: number }>(`
      with recursive chain(pid) as (
        select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))
        union select a.pid from pg_stat_activity a join chain c on c.pid = any(pg_blocking_pids(a.pid)))
      select count(*)::int as waiting from chain`, [blockerPid]);
    waiting = row!.waiting;
    if (waiting >= expected) return;
    await setImmediate();
  }
  throw new Error(`Only ${waiting} of ${expected} admissions reached the held lock.`);
}

/** Holds one row lock on its own connection, starts every admission, waits until all are queued behind it, then releases them together. */
async function raceBehind<T>(db: Client, lockSql: string, lockId: string, expected: number, launch: () => Promise<T>[]) {
  const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(lockSql, [lockId]);
    const { rows: [pid] } = await holder.query<{ pid: number }>("select pg_backend_pid() pid");
    const settled = Promise.allSettled(launch()); // started only once the row is held
    await blockedBy(db, pid!.pid, expected);
    await holder.query("commit");
    return await settled;
  } finally { await holder.end(); }
}

const refused = (code: string) => ({ code });

test("one key admits once: one run, prompt evidence, reservation, audit event and receipt; a changed body is refused", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, database }) => {
    const owner = await person(); const projectId = await projectFor(owner);
    const input = await start(database, projectId);
    const baseline = await footprint(database, projectId, owner.profile);
    const [first, second] = await Promise.all([admitRun(owner.identity, projectId, input, CONFIG), admitRun(owner.identity, projectId, input, CONFIG)]);
    assert.equal(first.runId, second.runId);
    assert.deepEqual([first.replayed, second.replayed].sort(), [false, true]);
    assert.equal(first.state, "QUEUED");
    // The manifest is built from the stored run, so the first response and the replay match, and it never carries the prompt.
    assert.deepEqual(first.manifest, second.manifest);
    const { rows: [stored] } = await database.query("select draft_id, capture_hash from app.ai_run where id = $1", [first.runId]);
    assert.deepEqual(first.manifest, { taskType: "PROPOSE_FLOW", draftId: stored.draft_id, documentRevision: 1, parentSnapshotId: null, sourceVersionIds: [], captureHash: stored.capture_hash });
    assert.ok(!JSON.stringify(first).includes("Outline the checkout flow"));
    const after = await footprint(database, projectId, owner.profile);
    assert.deepEqual([after.runs, after.documents, after.versions, after.audits - baseline.audits, after.receipts, after.reserved], [1, 1, 1, 1, 1, 1]);
    assert.equal(after.cursors, `${first.aiRevision}/${first.aiRevision}`);
    await assert.rejects(admitRun(owner.identity, projectId, { ...input, prompt: "Different" }, CONFIG), refused("KEY_REUSED"));
    assert.deepEqual(await footprint(database, projectId, owner.profile), after);
  });
});

test("the persisted run holds the exact capture, pinned clock and deadline, prompt evidence and a safe audit event", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, database }) => {
    const owner = await person(); const projectId = await projectFor(owner);
    const input = await start(database, projectId, { prompt: "  Outline\r\nthe checkout flow  " });
    const result = await admitRun(owner.identity, projectId, input, CONFIG);
    const { rows: [run] } = await database.query(
      `select r.*, extract(epoch from (r.deadline_at - r.created_at)) as window_seconds, (r.created_at at time zone 'UTC')::date = r.admission_day as pinned_day,
              v.text prompt_text, v.content_hash prompt_hash, d.kind, v.created_by prompt_actor, v.origin, v.sequence
       from app.ai_run r join app.source_version v on v.id = r.prompt_source_version_id join app.source_document d on d.id = v.source_id where r.id = $1`, [result.runId]);
    assert.equal(run.state, "QUEUED"); assert.equal(run.budget_state, "RESERVED"); assert.equal(run.dispatch_state, "PENDING");
    assert.equal(run.model, "test-model"); assert.equal(run.execution_binding, "binding-1"); assert.equal(Number(run.window_seconds), 300); assert.equal(run.pinned_day, true);
    assert.equal(run.owner_id, owner.profile); assert.equal(run.actor_id, owner.profile); assert.equal(run.parent_snapshot_id, null);
    assert.deepEqual([run.kind, run.sequence, run.origin, run.prompt_actor], ["AI_PROMPT", 1, null, owner.profile]);
    assert.equal(run.prompt_text, "  Outline\nthe checkout flow  "); assert.equal(run.capture.prompt, run.prompt_text); assert.equal(run.capture.promptHash, run.prompt_hash);
    assert.equal(sha256(canonicalJson(run.capture)), run.capture_hash);
    assert.equal(run.last_event_sequence, String(result.aiRevision));
    const { rows: [event] } = await database.query("select actor_id, action, entity_refs, metadata from app.audit_event where project_id = $1 and sequence = $2", [projectId, result.aiRevision]);
    assert.deepEqual([event.actor_id, event.action], [owner.profile, "AI_RUN_ADMITTED"]);
    assert.ok(!JSON.stringify(event).includes("Outline"));
    const { rows: [budget] } = await database.query("select reserved_runs, consumed_runs from app.ai_budget_day where owner_id = $1", [owner.profile]);
    assert.deepEqual([budget.reserved_runs, budget.consumed_runs], [1, 0]);
  });
});

test("access precedes replay: a removed actor cannot replay, a downgraded viewer recovers the receipt but cannot start", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, join, database }) => {
    const owner = await person(); const editor = await person(); const projectId = await projectFor(owner);
    await join(owner.identity, projectId, editor.identity);
    const input = await start(database, projectId);
    const admitted = await admitRun(editor.identity, projectId, input, CONFIG);
    await database.query("update app.project_membership set role = 'VIEWER' where project_id = $1 and profile_id = $2", [projectId, editor.profile]);
    assert.deepEqual(await admitRun(editor.identity, projectId, input, CONFIG), { ...admitted, replayed: true });
    await assert.rejects(admitRun(editor.identity, projectId, await start(database, projectId), CONFIG), refused("FORBIDDEN"));
    await database.query("update app.project_membership set active = false, deactivated_sequence = (select event_sequence from app.project where id = $1) where project_id = $1 and profile_id = $2", [projectId, editor.profile]);
    await assert.rejects(admitRun(editor.identity, projectId, input, CONFIG), refused("NOT_FOUND"));
    const stranger = await person();
    await assert.rejects(admitRun(stranger.identity, projectId, await start(database, projectId), CONFIG), refused("NOT_FOUND"));
  });
});

test("an archived project and an unconfigured or oversized request are refused without touching saved data", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, database }) => {
    const owner = await person(); const projectId = await projectFor(owner);
    const before = await footprint(database, projectId, owner.profile);
    assert.throws(() => aiConfiguration({}), refused("UNAVAILABLE"));
    assert.deepEqual(aiConfiguration({ AI_MODEL: "m", AI_EXECUTION_BINDING: "b" }), { model: "m", executionBinding: "b" });
    assert.throws(() => aiConfiguration({ AI_MODEL: "m", AI_EXECUTION_BINDING: "b".repeat(129) }), refused("UNAVAILABLE")); // a Trigger external deployment id is at most 128 characters
    assert.equal(aiConfiguration({ AI_MODEL: "m", AI_EXECUTION_BINDING: "b".repeat(128) }).executionBinding.length, 128);
    const input = await start(database, projectId);
    const many = Array.from({ length: 600 }, () => ({ sourceVersionId: randomUUID(), expectedCurrentVersionId: randomUUID() }));
    assert.throws(() => parseStartRunInput({ taskType: "PROPOSE_FLOW", prompt: "x", draftId: input.draftId, expectedDocumentRevision: 1, expectedParentSnapshotId: null, context: { selection: null, sources: many } }, randomUUID()));
    await assert.rejects(admitRun(owner.identity, projectId, { ...input, context: { selection: null, sources: many } }, CONFIG), refused("LIMIT_EXCEEDED"));
    await database.query("update app.project set status = 'ARCHIVED' where id = $1", [projectId]);
    await assert.rejects(admitRun(owner.identity, projectId, input, CONFIG), refused("CONFLICT"));
    assert.deepEqual(await footprint(database, projectId, owner.profile), before);
    const { rows } = await database.query("select 1 from app.rate_limit_bucket where subject_hash = $1", [admissionSubject(owner.profile)]);
    assert.equal(rows.length, 0); // oversize is refused before the database, archive before the limiter
  });
});

test("distinct same-project requests admit exactly one", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, join, database }) => {
    const owner = await person(); const editor = await person(); const projectId = await projectFor(owner);
    await join(owner.identity, projectId, editor.identity);
    const inputs = [await start(database, projectId), await start(database, projectId), await start(database, projectId)];
    // The project row is held, so all three queue (one behind another's actor lock) and are released at once.
    const settled = await raceBehind(database, "select id from app.project where id = $1 for update", projectId, 3, () => [
      admitRun(owner.identity, projectId, inputs[0]!, CONFIG), admitRun(editor.identity, projectId, inputs[1]!, CONFIG), admitRun(owner.identity, projectId, inputs[2]!, CONFIG),
    ]);
    assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
    for (const entry of settled) if (entry.status === "rejected") assert.equal(entry.reason.code, "AI_BUSY");
    const after = await footprint(database, projectId, owner.profile);
    assert.deepEqual([after.runs, after.documents, after.reserved, after.receipts], [1, 1, 1, 1]);
  });
});

test("three projects sharing an owner admit at most two, whoever starts them", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, join, database }) => {
    const owner = await person(); const e1 = await person(); const e2 = await person();
    const p1 = await projectFor(owner); const p2 = await projectFor(owner); const p3 = await projectFor(owner);
    await join(owner.identity, p2, e1.identity); await join(owner.identity, p3, e2.identity);
    const [i1, i2, i3] = [await start(database, p1), await start(database, p2), await start(database, p3)];
    await database.query("insert into app.ai_owner_allowance (owner_id) values ($1)", [owner.profile]);
    // The allowance row is the only cross-project guard: all three admissions hold their own project lock and queue on it together.
    const settled = await raceBehind(database, "select owner_id from app.ai_owner_allowance where owner_id = $1 for update", owner.profile, 3, () => [
      admitRun(owner.identity, p1, i1, CONFIG), admitRun(e1.identity, p2, i2, CONFIG), admitRun(e2.identity, p3, i3, CONFIG),
    ]);
    assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 2);
    for (const entry of settled) if (entry.status === "rejected") assert.equal(entry.reason.code, "AI_BUSY");
    const { rows: [counts] } = await database.query("select count(*)::int runs from app.ai_run where owner_id = $1", [owner.profile]);
    assert.equal(counts.runs, 2);
    assert.equal((await footprint(database, p1, owner.profile)).reserved, 2);
  });
});

test("the 31st owner/day reservation fails for any model or collaborator; midnight changes the day budget, not owner concurrency", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, join, database }) => {
    const owner = await person(); const editor = await person();
    const p1 = await projectFor(owner); const p2 = await projectFor(owner);
    await join(owner.identity, p2, editor.identity);
    await database.query("insert into app.ai_owner_allowance (owner_id) values ($1)", [owner.profile]);
    await database.query("insert into app.ai_budget_day (owner_id, day, reserved_runs, consumed_runs) values ($1, (now() at time zone 'UTC')::date, 1, 28)", [owner.profile]);
    await database.query("insert into app.ai_budget_day (owner_id, day, consumed_runs) values ($1, (now() at time zone 'UTC')::date - 1, 30)", [owner.profile]); // yesterday is full and irrelevant
    await admitRun(owner.identity, p1, await start(database, p1), CONFIG); // the 30th
    const before = await footprint(database, p2, owner.profile);
    await assert.rejects(admitRun(editor.identity, p2, await start(database, p2), OTHER_CONFIG), refused("AI_BUDGET_EXCEEDED"));
    assert.deepEqual(await footprint(database, p2, owner.profile), before);
    const { rows: [today] } = await database.query("select reserved_runs, consumed_runs from app.ai_budget_day where owner_id = $1 and day = (now() at time zone 'UTC')::date", [owner.profile]);
    assert.deepEqual([today.reserved_runs, today.consumed_runs], [2, 28]);
  });

  await withAdmission(async ({ person, projectFor, database }) => {
    const owner = await person(); const [p1, p2, p3] = [await projectFor(owner), await projectFor(owner), await projectFor(owner)] as [string, string, string];
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await seedRun(database, { projectId: p1, owner: owner.profile, createdAt: twoDaysAgo }); await seedRun(database, { projectId: p2, owner: owner.profile, createdAt: twoDaysAgo });
    // Overdue runs no longer hold an owner slot (their deadline passed); each settles when its own project is next read or admitted to.
    await admitRun(owner.identity, p3, await start(database, p3), CONFIG); // today's budget is separate from the old day's
    const { rows: stale } = await database.query("select state::text from app.ai_run where project_id = any($1::uuid[])", [[p1, p2]]);
    assert.deepEqual(stale.map((row) => row.state), ["QUEUED", "QUEUED"]);
    const { rows } = await database.query("select day::text from app.ai_budget_day where owner_id = $1 order by day", [owner.profile]);
    assert.equal(rows.length, 2);
  });
});

test("an owner entitlement revoked while admission waits for its locks is honoured", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, database }) => {
    const owner = await person(); const projectId = await projectFor(owner);
    await database.query("insert into app.ai_owner_allowance (owner_id) values ($1)", [owner.profile]);
    const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select owner_id from app.ai_owner_allowance where owner_id = $1 for update", [owner.profile]);
      const { rows: [pid] } = await holder.query<{ pid: number }>("select pg_backend_pid() pid");
      const before = await footprint(database, projectId, owner.profile);
      const pending = admitRun(owner.identity, projectId, await start(database, projectId), CONFIG);
      const outcome = assert.rejects(pending, refused("ENTITLEMENT_REQUIRED"));
      await blockedBy(database, pid!.pid);
      await database.query("update app.pilot_entitlement set active = false where profile_id = $1", [owner.profile]);
      await holder.query("commit");
      await outcome;
      assert.deepEqual(await footprint(database, projectId, owner.profile), before);
    } finally { await holder.end(); }
  });
});

test("capacity refusals roll back every write: applicable results, retained versions, project code points and the capture bound", { skip: !canRun }, async () => {
  const refuse = async (env: Env, owner: Person, projectId: string, options: StartOptions = {}) => {
    const before = await footprint(env.database, projectId, owner.profile);
    await assert.rejects(admitRun(owner.identity, projectId, await start(env.database, projectId, options), CONFIG), refused("LIMIT_EXCEEDED"));
    assert.deepEqual(await footprint(env.database, projectId, owner.profile), before);
  };
  await withAdmission(async (env) => { // ten applicable proposals
    const owner = await env.person(); const projectId = await env.projectFor(owner);
    for (let index = 0; index < AI_LIMITS.applicableResults; index += 1) await seedRun(env.database, { projectId, owner: owner.profile, terminal: "AVAILABLE" });
    await refuse(env, owner, projectId);
    await env.database.query("update app.ai_run set disposition = 'DISCARDED' where id = (select id from app.ai_run where project_id = $1 limit 1)", [projectId]);
    await admitRun(owner.identity, projectId, await start(env.database, projectId), CONFIG); // one fewer applicable result admits
  });
  await withAdmission(async (env) => { // 500 retained versions (the prompt would be the 501st); 499 admits as the 500th
    const owner = await env.person(); const projectId = await env.projectFor(owner);
    await seedVersions(env.database, projectId, owner.profile, Array(500).fill(1));
    await refuse(env, owner, projectId);
    const other = await env.person(); const second = await env.projectFor(other);
    await seedVersions(env.database, second, other.profile, Array(499).fill(1));
    await admitRun(other.identity, second, await start(env.database, second), CONFIG);
  });
  await withAdmission(async (env) => { // 500,000 retained code points; the 11-point prompt must fit exactly
    const owner = await env.person(); const projectId = await env.projectFor(owner);
    await seedVersions(env.database, projectId, owner.profile, [...Array(9).fill(50_000), 49_990]);
    await refuse(env, owner, projectId, { prompt: "make a flow" });
    const other = await env.person(); const second = await env.projectFor(other);
    await seedVersions(env.database, second, other.profile, [...Array(9).fill(50_000), 49_989]);
    await admitRun(other.identity, second, await start(env.database, second, { prompt: "make a flow" }), CONFIG);
  });
  await withAdmission(async (env) => { // the complete capture, measured as stored: escapes double the bytes of five 50,000-character sources
    const owner = await env.person(); const projectId = await env.projectFor(owner);
    const versions: string[] = [];
    for (let index = 0; index < 5; index += 1) versions.push((await seedVersions(env.database, projectId, owner.profile, [50_000], "\n"))[0]!);
    await refuse(env, owner, projectId, { sources: versions.map((id) => ({ sourceVersionId: id, expectedCurrentVersionId: id })) });
    const six = await seedVersions(env.database, projectId, owner.profile, [50_000], "a"); // raw bytes alone already exceed the cap
    await refuse(env, owner, projectId, { sources: [...versions, six[0]!].map((id) => ({ sourceVersionId: id, expectedCurrentVersionId: id })) });
  });
});

test("explicit source references: historical versions are captured as chosen, a moved head conflicts and another project's version is an invalid reference", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, database }) => {
    const owner = await person(); const projectId = await projectFor(owner); const foreign = await projectFor(owner);
    const [v1, v2] = await seedVersions(database, projectId, owner.profile, [4, 5]) as [string, string];
    const [other] = await seedVersions(database, foreign, owner.profile, [3]) as [string];
    const before = await footprint(database, projectId, owner.profile);
    await assert.rejects(admitRun(owner.identity, projectId, await start(database, projectId, { sources: [{ sourceVersionId: v1, expectedCurrentVersionId: v1 }] }), CONFIG), refused("CONFLICT"));
    await assert.rejects(admitRun(owner.identity, projectId, await start(database, projectId, { sources: [{ sourceVersionId: other, expectedCurrentVersionId: other }] }), CONFIG), refused("INVALID_SOURCE_REFERENCE"));
    assert.deepEqual(await footprint(database, projectId, owner.profile), before);
    const admitted = await admitRun(owner.identity, projectId, await start(database, projectId, { sources: [{ sourceVersionId: v1, expectedCurrentVersionId: v2 }] }), CONFIG);
    const { rows: [run] } = await database.query("select capture from app.ai_run where id = $1", [admitted.runId]);
    assert.deepEqual(run.capture.sources.map((source: { sourceVersionId: string; text: string; expectedCurrentVersionId: string }) => [source.sourceVersionId, source.text, source.expectedCurrentVersionId]), [[v1, "aaaa", v2]]);
    assert.deepEqual(admitted.manifest.sourceVersionIds, [v1]);
  });
});

test("stale revisions, replaced drafts and viewers are refused with no writes", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, join, database }) => {
    const owner = await person(); const viewer = await person(); const projectId = await projectFor(owner);
    await join(owner.identity, projectId, viewer.identity, "VIEWER");
    const before = await footprint(database, projectId, owner.profile);
    await assert.rejects(admitRun(owner.identity, projectId, await start(database, projectId, { revision: 99 }), CONFIG), refused("STALE_DOCUMENT_REVISION"));
    await assert.rejects(admitRun(owner.identity, projectId, { ...(await start(database, projectId)), draftId: randomUUID() }, CONFIG), refused("DRAFT_REPLACED"));
    await assert.rejects(admitRun(viewer.identity, projectId, await start(database, projectId), CONFIG), refused("FORBIDDEN"));
    assert.deepEqual(await footprint(database, projectId, owner.profile), before);
  });
});

test("the AI_ADMISSION bucket limits new attempts across connections, counts refusals, spares receipt recovery and holds no identity", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, database }) => {
    const owner = await person(); const projectId = await projectFor(owner);
    const { rows: [second] } = await database.query<{ sec: number }>("select extract(second from now())::int as sec");
    if (second!.sec >= 55) await new Promise((resolve) => setTimeout(resolve, (61 - second!.sec) * 1000)); // never straddle the database's minute boundary
    const first = await start(database, projectId);
    const admitted = await admitRun(owner.identity, projectId, first, CONFIG); // attempt 1 of the database's current window
    const subject = admissionSubject(owner.profile);
    await database.query("update app.rate_limit_bucket set count = $2 where subject_hash = $1", [subject, AI_LIMITS.admissionAttemptsPerMinute - 2]); // two attempts left
    const stale = await start(database, projectId, { revision: 99 });
    const before = await footprint(database, projectId, owner.profile);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => admitRun(owner.identity, projectId, { ...stale, key: randomUUID() }, CONFIG)));
    const codes = results.map((result) => (result.status === "rejected" ? result.reason.code : "ADMITTED"));
    assert.equal(codes.filter((code) => code === "STALE_DOCUMENT_REVISION").length, 2); // the last two attempts count even though they are refused
    assert.equal(codes.filter((code) => code === "RATE_LIMITED").length, 3);
    assert.deepEqual(await footprint(database, projectId, owner.profile), before);
    const { rows: [bucket] } = await database.query("select count, action, window_start, expires_at, subject_hash from app.rate_limit_bucket where subject_hash = $1", [subject]);
    assert.equal(bucket.count, AI_LIMITS.admissionAttemptsPerMinute); // a full bucket refuses without incrementing
    assert.equal(bucket.action, "AI_ADMISSION");
    assert.match(bucket.subject_hash, /^[0-9a-f]{64}$/);
    for (const part of [owner.profile, owner.identity.authUserId, owner.identity.verifiedEmail]) assert.ok(!bucket.subject_hash.includes(part));
    assert.notEqual(bucket.subject_hash, sha256(owner.profile)); // keyed server-side, not a bare hash of the profile id
    assert.ok(bucket.expires_at > bucket.window_start);
    assert.deepEqual(await admitRun(owner.identity, projectId, first, CONFIG), { ...admitted, replayed: true }); // recovery precedes the limiter
    await assert.rejects(admitRun(owner.identity, projectId, { ...first, prompt: "changed" }, CONFIG), refused("KEY_REUSED")); // and so does the key check
  });
});

test("a same-key replay after the capture body expired returns the original manifest from the receipt", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, database }) => {
    const owner = await person(); const projectId = await projectFor(owner);
    const [v1, v2] = await seedVersions(database, projectId, owner.profile, [4, 5]) as [string, string];
    const input = await start(database, projectId, { sources: [{ sourceVersionId: v1, expectedCurrentVersionId: v2 }] });
    const admitted = await admitRun(owner.identity, projectId, input, CONFIG);
    assert.deepEqual(admitted.manifest.sourceVersionIds, [v1]);
    // The run settles and ages past seven days (bodies go), while the 30 day receipt is still live.
    await database.query("update app.ai_run set state = 'FAILED', failure_code = 'TEST', terminal_at = now() - interval '8 days' where id = $1", [admitted.runId]);
    await database.query("select * from app.cleanup_transient(false, 100)");
    const { rows: [stored] } = await database.query("select capture is null as purged from app.ai_run where id = $1", [admitted.runId]);
    assert.equal(stored.purged, true);
    const replay = await admitRun(owner.identity, projectId, input, CONFIG);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.manifest, admitted.manifest);
    assert.deepEqual([replay.runId, replay.aiRevision], [admitted.runId, admitted.aiRevision]);
  });
});

test("a start receipt replays during an AI configuration pause without a new budget or event", { skip: !canRun }, async () => {
  await withAdmission(async ({ person, projectFor, database }) => {
    const owner = await person(); const projectId = await projectFor(owner);
    const input = await start(database, projectId);
    const admitted = await admitRun(owner.identity, projectId, input, CONFIG);
    const before = await footprint(database, projectId, owner.profile);
    const saved = { model: process.env.AI_MODEL, binding: process.env.AI_EXECUTION_BINDING };
    try {
      process.env.AI_MODEL = ""; process.env.AI_EXECUTION_BINDING = "";
      assert.deepEqual(await admitRun(owner.identity, projectId, input), { ...admitted, replayed: true });
      await assert.rejects(admitRun(owner.identity, projectId, { ...input, key: randomUUID() }), refused("UNAVAILABLE"));
      assert.deepEqual(await footprint(database, projectId, owner.profile), before);
    } finally {
      if (saved.model === undefined) delete process.env.AI_MODEL; else process.env.AI_MODEL = saved.model;
      if (saved.binding === undefined) delete process.env.AI_EXECUTION_BINDING; else process.env.AI_EXECUTION_BINDING = saved.binding;
    }
  });
});
