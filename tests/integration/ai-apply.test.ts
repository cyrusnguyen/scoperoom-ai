import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { setTimeout as sleep } from "node:timers/promises";
import { executeGraphCommand } from "../../src/features/drafts/server/execute-command.ts";
import type { ProjectIdentity } from "../../src/features/projects/contracts/project.ts";
import { parseApplyRunInput, parseDiscardRunInput, type ApplyRunInput, type CapturedInput } from "../../src/features/proposals/contracts/tasks.ts";
import { workerCleanup } from "../../src/server/maintenance/worker-cleanup.ts";
import { emptyDraft, LIMITS } from "../../src/features/drafts/contracts/scope-document.ts";
import { applyProposal } from "../../src/features/proposals/domain/proposal-diff.ts";
import { applyRun, parseAppliedRun } from "../../src/features/proposals/server/apply-run.ts";
import { discardRun } from "../../src/features/proposals/server/discard-run.ts";
import { canRun } from "./support/fixture.ts";
import { draftOf, seedRun, withAi } from "./support/ai-runs.ts";
import { canonicalJson, sha256 } from "../../src/features/proposals/domain/capture.ts";
import { serializeSweeps } from "./support/sweep-lock.ts";

serializeSweeps();

const proposal = { schemaVersion: 1, kind: "proposal", operations: [
  { id: "flow", dependsOn: [], edit: { command: "CREATE_FLOW", payload: { ref: "flow", title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" } } },
  { id: "step", dependsOn: ["flow"], edit: { command: "ADD_NODE", payload: { ref: "step", flowId: "flow", kind: "ACTION", label: "Pay", description: "", actorLabel: "" } } },
], assumptions: [], citations: [] };
const resultHash = sha256(canonicalJson(proposal));
const inputOf = (draft: { id: string; revision: number }, hash = resultHash): ApplyRunInput => ({ key: randomUUID(), draftId: draft.id, expectedDocumentRevision: draft.revision, expectedParentSnapshotId: null, resultHash: hash, selectedOperationIds: ["flow", "step"] });
const stateOf = async (db: Client, projectId: string, runId: string) => {
  const { rows: [row] } = await db.query(`select d.document_json, d.layout_json, d.document_revision, d.layout_revision, p.event_sequence::text, p.ai_revision::text,
    r.disposition::text, (select count(*)::int from app.ai_suggestion_application where run_id = r.id) applications,
    (select count(*)::int from app.audit_event where project_id = p.id and action like 'AI_PROPOSAL_%') events
    from app.project p join app.scope_draft d on d.id = p.current_draft_id join app.ai_run r on r.project_id = p.id where p.id = $1 and r.id = $2`, [projectId, runId]);
  return row;
};
async function sourceOf(db: Client, projectId: string, actorId: string, text = "First line\nSecond line") {
  const sourceId = randomUUID(), sourceVersionId = randomUUID();
  await db.query("begin");
  try {
    await db.query("insert into app.source_document (id, project_id, kind, current_version_id, created_by) values ($1, $2, 'USER_TEXT', $3, $4)", [sourceId, projectId, sourceVersionId, actorId]);
    await db.query(`insert into app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by)
      values ($1, $2, $3, 1, 'Notes', $4, char_length($4), octet_length($4), $5, $6)`, [sourceVersionId, projectId, sourceId, text, sha256(text), actorId]);
    await db.query("commit");
  } catch (error) { await db.query("rollback"); throw error; }
  return { projectId, sourceId, sourceVersionId, currentVersionId: sourceVersionId, title: "Notes", text, contentHash: sha256(text) };
}
async function ageRun(db: Client, runId: string) {
  // Explicit clock fixture only; production immutable identity/result/capture guards remain enabled after this statement.
  await db.query("alter table app.ai_run disable trigger enforce_ai_run");
  try { await db.query("update app.ai_run set terminal_at = now() - interval '8 days' where id = $1", [runId]); }
  finally { await db.query("alter table app.ai_run enable trigger enforce_ai_run"); }
}
async function blockedBy(db: Client, blocker: number, expected = 1) {
  const until = Date.now() + 3_000;
  while (Date.now() < until) {
    const { rows: [row] } = await db.query(`with recursive waiting(pid) as (
      select pid from pg_stat_activity where $1::integer = any(pg_blocking_pids(pid))
      union select activity.pid from pg_stat_activity activity join waiting on waiting.pid = any(pg_blocking_pids(activity.pid))
    ) select count(*)::int n from waiting`, [blocker]);
    if (row.n >= expected) return;
    await sleep(10);
  }
  assert.fail(`Expected ${expected} independent database connection(s) waiting on blocker`);
}
async function manualGraph(identity: ProjectIdentity, projectId: string, draftId: string) {
  let revision = 1;
  const command = async (command: string, payload: object) => {
    const result = await executeGraphCommand(identity, projectId, draftId, { key: randomUUID(), commandSchemaVersion: 1, command, expectedDocumentRevision: revision, payload });
    revision = result.documentRevision; return result.createdIds[0]!;
  };
  const flow = await command("CREATE_FLOW", { title: "Current", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" });
  const a = await command("ADD_NODE", { flowId: flow, kind: "ACTION", label: "A", description: "", actorLabel: "" });
  const b = await command("ADD_NODE", { flowId: flow, kind: "ACTION", label: "B", description: "", actorLabel: "" });
  const edge = await command("ADD_EDGE", { flowId: flow, fromId: a, toId: b, condition: "" });
  return { flow, a, b, edge, revision };
}

test("Apply/Discard body parsers reject browser operation values and invalid selectors", () => {
  const input = inputOf({ id: randomUUID(), revision: 1 }); const { key, ...body } = input;
  assert.deepEqual(parseApplyRunInput(body, key), input);
  for (const replacement of [{ operations: proposal.operations }, { selectedOperationIds: [] }, { selectedOperationIds: ["flow", "flow"] }, { resultHash: "wrong" }, { expectedLayoutRevision: 1 }]) {
    assert.throws(() => parseApplyRunInput({ ...body, ...replacement }, key), /INVALID_INPUT/);
  }
  assert.throws(() => parseDiscardRunInput({ expectedResultHash: resultHash, operations: [] }, key), /INVALID_INPUT/);
  const receipt = { applicationId: randomUUID(), runId: randomUUID(), draftId: body.draftId, documentRevision: 1, layoutRevision: 1, eventSequence: Number.MAX_SAFE_INTEGER, aiRevision: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(parseAppliedRun(receipt), receipt);
});

test("exact captured source heads, citations and same-project permanent source FKs survive body and receipt cleanup", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const q = await projectFor(owner);
    const draft = await draftOf(database, p); const source = await sourceOf(database, p, owner.profile); const foreign = await sourceOf(database, q, owner.profile);
    const cited = { ...proposal, citations: [{ sourceVersionId: source.sourceVersionId, startLine: 1, endLine: 1, excerpt: "First line" }] };
    const hash = sha256(canonicalJson(cited));
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: cited, sources: [source] });
    const input = { ...inputOf(draft, hash), selectedOperationIds: ["flow"] };
    const applied = await applyRun(owner.identity, p, run, input);
    const permanent = async () => (await database.query("select * from app.ai_suggestion_application where run_id = $1", [run])).rows[0];
    const evidence = await permanent();
    assert.equal(evidence.selected_operations.length, 1); assert.equal(evidence.actual_operations.length, 1);
    assert.deepEqual(evidence.evidence.citations, cited.citations);
    assert.deepEqual((await database.query("select source_version_id from app.ai_application_source where application_id = $1 order by source_version_id", [applied.applicationId])).rows.map(r => r.source_version_id), evidence.source_version_ids);
    // Composite application and source keys each independently refuse a foreign project.
    await assert.rejects(database.query("insert into app.ai_application_source (project_id, application_id, source_version_id) values ($1, $2, $3)", [q, applied.applicationId, foreign.sourceVersionId]), { code: "23514" });
    await assert.rejects(database.query("insert into app.ai_application_source (project_id, application_id, source_version_id) values ($1, $2, $3)", [p, applied.applicationId, foreign.sourceVersionId]), { code: "23514" });
    await assert.rejects(database.query("update app.ai_suggestion_application set result_hash = $2 where id = $1", [applied.applicationId, "f".repeat(64)]), { code: "23514" });
    await ageRun(database, run);
    const beforeCleanup = (await database.query("select capture_hash, result_hash, disposition::text from app.ai_run where id = $1", [run])).rows[0];
    await workerCleanup(); await workerCleanup();
    const after = (await database.query("select capture_hash, result_hash, disposition::text, capture, result from app.ai_run where id = $1", [run])).rows[0];
    assert.deepEqual({ capture_hash: after.capture_hash, result_hash: after.result_hash, disposition: after.disposition }, beforeCleanup);
    assert.equal(after.capture, null); assert.equal(after.result, null); assert.deepEqual(await permanent(), evidence);
    assert.equal((await applyRun(owner.identity, p, run, input)).replayed, true, "safe receipt replays after body cleanup");
    await database.query("delete from app.mutation_receipt where scope_id = $1 and key = $2", [p, input.key]);
    await assert.rejects(applyRun(owner.identity, p, run, { ...input, key: randomUUID(), selectedOperationIds: ["flow", "step"] }), error => {
      assert.equal((error as { code: string }).code, "AI_RUN_CONSUMED");
      assert.deepEqual((error as { details: object }).details, { applicationId: applied.applicationId, runId: run, draftId: draft.id }); return true;
    });
    assert.equal((await stateOf(database, p, run)).document_revision, applied.documentRevision);
  });
});

for (const race of ["apply/apply", "apply/discard", "same-key"] as const) {
  test(`two independently blocked SQL connections serialize ${race} with one permanent effect`, { skip: !canRun }, async () => {
    await withAi(async ({ person, projectFor, database }) => {
      const owner = await person(); const p = await projectFor(owner); const draft = await draftOf(database, p);
      const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal });
      const input = inputOf(draft); const before = await stateOf(database, p, run);
      const blocker = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! }); await blocker.connect();
      let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof applyRun>> | Awaited<ReturnType<typeof discardRun>>>[]> | undefined;
      try {
        await blocker.query("begin");
        const { rows: [pid] } = await blocker.query("select pg_backend_pid() pid from app.project where id = $1 for update", [p]);
        const first = applyRun(owner.identity, p, run, input);
        const second = race === "apply/discard" ? discardRun(owner.identity, p, run, { key: randomUUID(), expectedResultHash: resultHash })
          : applyRun(owner.identity, p, run, race === "same-key" ? input : { ...input, key: randomUUID() });
        pending = Promise.allSettled([first, second]);
        await blockedBy(database, pid.pid, 2); await blocker.query("commit");
        const results = await pending;
        if (race === "same-key") {
          assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
          const a = results[0] as PromiseFulfilledResult<Awaited<typeof first>>; const b = results[1] as PromiseFulfilledResult<Awaited<typeof first>>;
          assert.equal(a.value.applicationId, b.value.applicationId); assert.notEqual(a.value.replayed, b.value.replayed);
        } else {
          assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
          const loser = results.find(result => result.status === "rejected") as PromiseRejectedResult;
          assert.ok(["AI_RUN_CONSUMED", "AI_RESULT_UNAVAILABLE"].includes(loser.reason.code));
        }
        const after = await stateOf(database, p, run);
        assert.equal(after.events, before.events + 1); assert.equal(Number(after.event_sequence), Number(before.event_sequence) + 1);
        assert.equal(Number(after.ai_revision), Number(after.event_sequence));
        assert.equal(after.applications, after.disposition === "APPLIED" ? 1 : 0);
        assert.equal(after.document_revision, before.document_revision + after.applications);
        assert.equal(Object.keys(after.document_json.flows).length, after.applications);
        assert.equal(Object.keys(after.document_json.nodes).length, after.applications);
      } finally { await blocker.query("rollback"); await pending; await blocker.end(); }
    });
  });
}

test("Apply waits for a source-head writer and refuses the newly stale capture without a partial effect", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const draft = await draftOf(database, p); const source = await sourceOf(database, p, owner.profile);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal, sources: [source] });
    const before = await stateOf(database, p, run);
    const blocker = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! }); await blocker.connect();
    try {
      await blocker.query("begin");
      const { rows: [pid] } = await blocker.query("select pg_backend_pid() pid from app.source_document where id = $1 for update", [source.sourceId]);
      const pending = applyRun(owner.identity, p, run, inputOf(draft));
      const settled = pending.then(value => ({ value }), error => ({ error }));
      await blockedBy(database, pid.pid);
      const newer = randomUUID(); const text = "Newer source";
      await blocker.query(`insert into app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by)
        values ($1, $2, $3, 2, 'Notes', $4, char_length($4), octet_length($4), $5, $6)`, [newer, p, source.sourceId, text, sha256(text), owner.profile]);
      await blocker.query("update app.source_document set current_version_id = $2, version = version + 1 where id = $1", [source.sourceId, newer]);
      await blocker.query("commit");
      const result = await settled; assert.ok("error" in result); assert.equal(result.error.code, "INVALID_SOURCE_REFERENCE");
      assert.deepEqual(await stateOf(database, p, run), before);
      const stale = await discardRun(owner.identity, p, run, { key: randomUUID(), expectedResultHash: resultHash }); assert.equal(stale.disposition, "DISCARDED");
    } finally { await blocker.query("rollback"); await blocker.end(); }
  });
});

test("restricted web and worker roles deny application edits, deletion, body replacement and worker insertion", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const draft = await draftOf(database, p);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal });
    const applied = await applyRun(owner.identity, p, run, inputOf(draft));
    for (const role of ["web", "worker"] as const) {
      const client = new Client({ connectionString: role === "web" ? process.env.DATABASE_URL! : process.env.WORKER_DATABASE_URL! }); await client.connect();
      try {
        for (const sql of ["update app.ai_suggestion_application set result_hash = result_hash where id = $1", "delete from app.ai_suggestion_application where id = $1",
          "update app.ai_application_source set source_version_id = source_version_id where application_id = $1", "delete from app.ai_application_source where application_id = $1"]) {
          await assert.rejects(client.query(sql, [applied.applicationId]), { code: "42501" });
        }
        await assert.rejects(client.query("update app.ai_run set result = '{}'::jsonb where id = $1", [run]), { code: "42501" });
        await assert.rejects(client.query("update app.ai_run set capture = null where id = $1", [run]), { code: "42501" });
        if (role === "worker") {
          await assert.rejects(client.query("insert into app.ai_suggestion_application select * from app.ai_suggestion_application where id = $1", [applied.applicationId]), { code: "42501" });
          await assert.rejects(client.query("update app.ai_run set disposition = 'DISCARDED' where id = $1", [run]), { code: "42501" });
          await assert.rejects(client.query("update app.scope_draft set document_revision = document_revision + 1 where id = $1", [draft.id]), { code: "42501" });
        }
        // These URLs select a startup role, so RESET ROLE restores that role. NONE proves the NOINHERIT login itself.
        await client.query("begin"); await client.query("set role none");
        assert.equal((await client.query("select current_user role")).rows[0].role, `app_${role}_runtime`);
        await assert.rejects(client.query("select * from app.ai_suggestion_application where id = $1", [applied.applicationId]), { code: "42501" });
        await client.query("rollback");
      } finally { await client.end(); }
    }
  });
});

test("a captured foreign source version cannot enter permanent same-project evidence even if its head guard matches", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const q = await projectFor(owner); const draft = await draftOf(database, p);
    const own = await sourceOf(database, p, owner.profile); const foreign = await sourceOf(database, q, owner.profile);
    // Synthetic SQL-owned corruption: text/head match, but this captured historical version is in another project.
    const corrupt = { ...own, sourceVersionId: foreign.sourceVersionId };
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal, sources: [corrupt] });
    const before = await stateOf(database, p, run);
    const applicationId = randomUUID();
    const { rows: [row] } = await database.query("select prompt_source_version_id from app.ai_run where id = $1", [run]);
    const sources = [row.prompt_source_version_id, own.sourceVersionId, foreign.sourceVersionId].sort();
    await database.query("begin");
    try {
      await database.query(`insert into app.ai_suggestion_application
        (id, project_id, run_id, draft_id, actor_id, prompt_source_version_id, result_hash, selected_operations, actual_operations, id_map, created_id_map, evidence, source_version_ids,
        before_document_revision, after_document_revision, before_layout_revision, after_layout_revision)
        select $2, project_id, id, draft_id, actor_id, prompt_source_version_id, result_hash, result->'operations', result->'operations', '{}', '{}', '{}', $3, 1, 1, 1, 1 from app.ai_run where id = $1`, [run, applicationId, sources]);
      await assert.rejects(database.query("insert into app.ai_application_source (project_id, application_id, source_version_id) values ($1, $2, $3)", [p, applicationId, foreign.sourceVersionId]), { code: "23503", constraint: "ai_application_source_version_fkey" });
    } finally { await database.query("rollback"); }
    await assert.rejects(applyRun(owner.identity, p, run, inputOf(draft)), { code: "UNAVAILABLE" });
    assert.deepEqual(await stateOf(database, p, run), before);
  });
});

for (const failAt of ["application", "audit"] as const) {
  test(`a scoped forced ${failAt} insertion failure rolls back graph, revisions, evidence, receipt and cursor`, { skip: !canRun }, async () => {
    await withAi(async ({ person, projectFor, database }) => {
      const owner = await person(); const p = await projectFor(owner); const draft = await draftOf(database, p);
      const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal });
      const input = inputOf(draft); const before = await stateOf(database, p, run);
      const table = failAt === "application" ? "ai_suggestion_application" : "audit_event";
      await database.query(`create function app.test_ai_insertion_failure() returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $body$
        begin if NEW.project_id = '${p}'::uuid then raise exception 'synthetic evidence insertion refusal' using errcode = '23514'; end if; return NEW; end; $body$`);
      try {
        await database.query(`create trigger test_ai_insertion_failure before insert on app.${table} for each row execute function app.test_ai_insertion_failure()`);
        await assert.rejects(applyRun(owner.identity, p, run, input), { code: "UNAVAILABLE" });
        assert.deepEqual(await stateOf(database, p, run), before);
        assert.equal((await database.query("select count(*)::int n from app.mutation_receipt where scope_id = $1 and key = $2", [p, input.key])).rows[0].n, 0);
        assert.equal((await database.query("select count(*)::int n from app.ai_application_source s join app.ai_suggestion_application a on a.id = s.application_id where a.run_id = $1", [run])).rows[0].n, 0);
      } finally {
        await database.query(`drop trigger if exists test_ai_insertion_failure on app.${table}`);
        await database.query("drop function app.test_ai_insertion_failure()");
      }
      assert.equal((await applyRun(owner.identity, p, run, input)).replayed, false, "the exact refused request can succeed after the fault is removed");
    });
  });
}

test("final saved JSONB capacity refusal rolls back the selected group before evidence or receipt", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const draft = await draftOf(database, p);
    const saved = emptyDraft();
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal });
    const capture = (await database.query<{ capture: CapturedInput }>("select capture from app.ai_run where id = $1", [run])).rows[0]!.capture;
    const projected = applyProposal(saved, capture, proposal as Parameters<typeof applyProposal>[2], ["flow", "step"], randomUUID);
    const sizes = (await database.query("select octet_length($1::jsonb::text)::int saved, octet_length($2::jsonb::text)::int candidate", [saved.document, projected.document])).rows[0];
    const delta = sizes.candidate - sizes.saved;
    const count = Math.floor((LIMITS.documentBytes - sizes.saved - delta / 2) / 40);
    // Retired IDs are retained saved history; they are outside the proposal's captured live graph.
    saved.document.retiredEntityIds = Array.from({ length: count }, (_, i) => `10000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`);
    const candidate = applyProposal(saved, capture, proposal as Parameters<typeof applyProposal>[2], ["flow", "step"], randomUUID);
    const admitted = (await database.query("select octet_length($1::jsonb::text)::int saved, octet_length($2::jsonb::text)::int candidate", [saved.document, candidate.document])).rows[0];
    assert.ok(admitted.saved <= LIMITS.documentBytes); assert.ok(admitted.candidate > LIMITS.documentBytes);
    assert.ok(Buffer.byteLength(JSON.stringify(candidate.document)) < LIMITS.documentBytes, "only PostgreSQL's saved JSONB representation exceeds capacity");
    await database.query("update app.scope_draft set document_json = $2::jsonb where id = $1", [draft.id, saved.document]);
    const input = inputOf(draft);
    const before = await stateOf(database, p, run);
    await assert.rejects(applyRun(owner.identity, p, run, input), { code: "LIMIT_EXCEEDED" });
    assert.deepEqual(await stateOf(database, p, run), before);
    assert.equal((await database.query("select count(*)::int n from app.mutation_receipt where scope_id = $1 and key = $2", [p, input.key])).rows[0].n, 0);
  });
});

test("cleanup-first holds the parent/run guards and Apply refuses the expired body without partial writes", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const draft = await draftOf(database, p);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal, createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) });
    const before = await stateOf(database, p, run);
    const cleaner = new Client({ connectionString: process.env.WORKER_DATABASE_URL! }); await cleaner.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await cleaner.query("begin");
      const { rows: [pid] } = await cleaner.query("select pg_backend_pid() pid");
      await cleaner.query("select * from app.run_worker_cleanup($1::uuid, 100)", [process.env.SCOPEROOM_ENVIRONMENT_ID]);
      pending = applyRun(owner.identity, p, run, inputOf(draft)).then(value => ({ value }), error => ({ error }));
      await blockedBy(database, pid.pid); await cleaner.query("commit");
      const result = await pending as { error: { code: string } }; assert.equal(result.error.code, "AI_RESULT_UNAVAILABLE");
      const after = await stateOf(database, p, run);
      assert.deepEqual(after.document_json, before.document_json); assert.deepEqual(after.layout_json, before.layout_json);
      assert.equal(after.document_revision, before.document_revision); assert.equal(after.layout_revision, before.layout_revision);
      assert.equal(after.applications, 0); assert.equal(after.events, 0); assert.equal(after.disposition, "EXPIRED");
    } finally { await cleaner.query("rollback"); await pending; await cleaner.end(); }
  });
});

test("cleanup skips Apply's locked project; Apply checks body expiry after its source lock wait", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const draft = await draftOf(database, p); const source = await sourceOf(database, p, owner.profile);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal, sources: [source], createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 2_000) });
    const before = await stateOf(database, p, run);
    const blocker = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! }); await blocker.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("begin");
      const { rows: [pid] } = await blocker.query("select pg_backend_pid() pid from app.source_document where id = $1 for update", [source.sourceId]);
      assert.equal((await database.query("select terminal_at + interval '7 days' > clock_timestamp() live from app.ai_run where id = $1", [run])).rows[0].live, true);
      pending = applyRun(owner.identity, p, run, inputOf(draft)).then(value => ({ value }), error => ({ error }));
      await blockedBy(database, pid.pid);
      await database.query("select pg_sleep(greatest(0, extract(epoch from (terminal_at + interval '7 days' - clock_timestamp()))) + 0.025) from app.ai_run where id = $1", [run]);
      await workerCleanup();
      assert.equal((await database.query("select disposition::text, capture is not null body from app.ai_run where id = $1", [run])).rows[0].disposition, "AVAILABLE");
      await blocker.query("commit");
      const result = await pending as { error: { code: string } }; assert.equal(result.error.code, "AI_RESULT_UNAVAILABLE");
      assert.deepEqual(await stateOf(database, p, run), before);
      await workerCleanup();
      assert.equal((await database.query("select disposition::text from app.ai_run where id = $1", [run])).rows[0].disposition, "EXPIRED");
    } finally { await blocker.query("rollback"); await pending; await blocker.end(); }
  });
});

test("selected Apply persists one permanent effect; same-key replay and shared Discard respect current access", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, join, database }) => {
    const owner = await person(); const editor = await person(); const viewer = await person();
    const p = await projectFor(owner);
    await join(owner.identity, p, editor.identity, "EDITOR"); await join(owner.identity, p, viewer.identity, "VIEWER");
    const draft = await draftOf(database, p);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal });
    const input = { key: randomUUID(), draftId: draft.id, expectedDocumentRevision: draft.revision, expectedParentSnapshotId: null, resultHash, selectedOperationIds: ["flow", "step"] };
    await assert.rejects(applyRun(viewer.identity, p, run, input), { code: "FORBIDDEN" });
    const applied = await applyRun(editor.identity, p, run, input);
    assert.equal(applied.replayed, false); assert.equal(applied.documentRevision, draft.revision + 1);
    const saved = await stateOf(database, p, run);
    assert.equal(Object.values(saved.document_json.flows as Record<string, { inclusion: string }>)[0]!.inclusion, "UNDECIDED");
    assert.equal(Object.values(saved.document_json.nodes as Record<string, { origin: string }>)[0]!.origin, "AI_SUGGESTED");
    assert.deepEqual(await applyRun(editor.identity, p, run, input), { ...applied, replayed: true });
    await assert.rejects(applyRun(editor.identity, p, run, { ...input, selectedOperationIds: ["flow"] }), { code: "KEY_REUSED" });
    await assert.rejects(applyRun(owner.identity, p, run, { ...input, key: randomUUID() }), { code: "AI_RUN_CONSUMED" });
    await assert.rejects(discardRun(owner.identity, p, run, { key: randomUUID(), expectedResultHash: resultHash }), { code: "AI_RUN_CONSUMED" });
    const { rows: [evidence] } = await database.query("select * from app.ai_suggestion_application where run_id = $1", [run]);
    assert.equal(evidence.actor_id, editor.profile); assert.equal(evidence.id, applied.applicationId);
    assert.equal(evidence.actual_operations.length, 2); assert.equal(Object.keys(evidence.id_map).length, 2);
    await database.query("update app.project_membership set role = 'VIEWER' where project_id = $1 and profile_id = $2", [p, editor.profile]);
    assert.equal((await applyRun(editor.identity, p, run, input)).replayed, true);
    await database.query("update app.project set status = 'ARCHIVED' where id = $1", [p]);
    assert.equal((await applyRun(editor.identity, p, run, input)).replayed, true);
    await database.query("update app.project set status = 'ACTIVE' where id = $1", [p]);
    await database.query("update app.project_membership set active = false, deactivated_sequence = (select event_sequence from app.project where id = $1) where project_id = $1 and profile_id = $2", [p, editor.profile]);
    await assert.rejects(applyRun(editor.identity, p, run, input), { code: "NOT_FOUND" });
    await database.query("delete from app.mutation_receipt where scope_id = $1 and key = $2", [p, input.key]);
    await assert.rejects(applyRun(owner.identity, p, run, { ...input, key: randomUUID() }), { code: "AI_RUN_CONSUMED" });
  });
});

test("Apply refuses foreign run/draft, result mismatch, missing dependencies and newer captured selectors without any effect", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const q = await projectFor(owner);
    const draft = await draftOf(database, p); const foreignDraft = await draftOf(database, q);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal });
    const foreign = await seedRun(database, { projectId: q, owner: owner.profile, shape: "SUCCEEDED", result: proposal });
    const input = inputOf(draft); const before = await stateOf(database, p, run);
    await assert.rejects(applyRun(owner.identity, p, foreign, input), { code: "NOT_FOUND" });
    await assert.rejects(applyRun(owner.identity, q, run, input), { code: "NOT_FOUND" });
    await assert.rejects(applyRun(owner.identity, p, run, { ...input, draftId: foreignDraft.id }), { code: "DRAFT_REPLACED" });
    await assert.rejects(applyRun(owner.identity, p, run, { ...input, resultHash: "f".repeat(64) }), { code: "AI_RESULT_MISMATCH" });
    await assert.rejects(applyRun(owner.identity, p, run, { ...input, selectedOperationIds: ["step"] }), { code: "DEPENDENCY_CONFLICT" });
    await assert.rejects(applyRun(owner.identity, p, run, { ...input, selectedOperationIds: ["unknown"] }), { code: "DEPENDENCY_CONFLICT" });
    await assert.rejects(applyRun(owner.identity, p, run, { ...input, expectedDocumentRevision: draft.revision + 1 }), { code: "STALE_DOCUMENT_REVISION" });
    await assert.rejects(applyRun(owner.identity, p, run, { ...input, expectedParentSnapshotId: randomUUID() }), { code: "BASELINE_CHANGED" });
    await assert.rejects(applyRun(owner.identity, p, run, { ...input, operations: proposal.operations } as ApplyRunInput), { code: "INVALID_INPUT" });
    assert.deepEqual(await stateOf(database, p, run), before);
    await database.query("update app.scope_draft set document_revision = document_revision + 1 where id = $1", [draft.id]);
    await assert.rejects(applyRun(owner.identity, p, run, input), { code: "STALE_DOCUMENT_REVISION" });
    await assert.rejects(applyRun(owner.identity, p, run, { ...input, expectedDocumentRevision: draft.revision + 1 }), { code: "STALE_DOCUMENT_REVISION" });
    const discard = await discardRun(owner.identity, p, run, { key: randomUUID(), expectedResultHash: resultHash });
    assert.equal(discard.disposition, "DISCARDED");
    assert.equal((await stateOf(database, p, run)).applications, 0);
  });
});

test("layout-only peer moves and remembered sides survive Improve; no-op consumes without draft increments", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const draft = await draftOf(database, p);
    const { flow, a, b, edge, revision } = await manualGraph(owner.identity, p, draft.id);
    const improvement = { schemaVersion: 1, kind: "proposal", operations: [
      { id: "edit", dependsOn: [], edit: { command: "UPDATE_NODE", payload: { nodeId: a, label: "Improved" } } },
      { id: "reconnect", dependsOn: [], edit: { command: "RECONNECT_EDGE", payload: { edgeId: edge, fromId: a, toId: b } } },
    ], assumptions: ["Review this change"], citations: [] };
    const hash = sha256(canonicalJson(improvement));
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: improvement, selection: { flowId: flow, nodeIds: [a, b] } });
    await database.query(`update app.scope_draft set layout_json = jsonb_set(jsonb_set(layout_json, array['positions', $2], '{"x":333,"y":444,"version":2}'), array['edgeSides', $3], '{"from":"right","to":"left"}'), layout_revision = layout_revision + 1 where id = $1`, [draft.id, a, edge]);
    const before = await stateOf(database, p, run);
    const applied = await applyRun(owner.identity, p, run, { ...inputOf({ id: draft.id, revision }, hash), selectedOperationIds: ["edit", "reconnect"] });
    const after = await stateOf(database, p, run);
    assert.deepEqual(after.layout_json, before.layout_json); assert.equal(applied.layoutRevision, before.layout_revision);
    assert.equal(after.document_json.nodes[a].label, "Improved"); assert.equal(after.document_json.nodes[a].version, before.document_json.nodes[a].version + 1);
    assert.deepEqual(after.document_json.nodes[b], before.document_json.nodes[b]); assert.deepEqual(after.document_json.edges[edge], before.document_json.edges[edge]);
    const { rows: [evidence] } = await database.query("select actual_operations, evidence from app.ai_suggestion_application where run_id = $1", [run]);
    assert.deepEqual(evidence.actual_operations[1].payload.expectedSides, { from: "right", to: "left" });
    assert.deepEqual(evidence.evidence.changedIds, [a, flow].sort());
    assert.deepEqual(evidence.evidence.assumptions, ["Review this change"]);
    const noOp = { ...improvement, operations: [improvement.operations[0]] };
    const noOpHash = sha256(canonicalJson(noOp));
    const second = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: noOp, selection: { flowId: flow, nodeIds: [a] } });
    const noopBefore = await stateOf(database, p, second);
    const noop = await applyRun(owner.identity, p, second, { ...inputOf({ id: draft.id, revision: applied.documentRevision }, noOpHash), selectedOperationIds: ["edit"] });
    assert.equal(noop.documentRevision, applied.documentRevision); assert.equal(noop.layoutRevision, applied.layoutRevision);
    const noopAfter = await stateOf(database, p, second);
    assert.deepEqual(noopAfter.document_json, noopBefore.document_json); assert.deepEqual(noopAfter.layout_json, noopBefore.layout_json);
    assert.equal(noopAfter.events, noopBefore.events + 1); assert.equal(noopAfter.applications, 1);
  });
});

test("current draft replacement, cancellation, expired and discarded results refuse Apply", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person();
    for (const kind of ["replacement", "cancel", "expiry", "discard", "failed", "clarification"] as const) {
      const p = await projectFor(owner); const draft = await draftOf(database, p);
      const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: kind === "failed" ? "FAILED" : "SUCCEEDED", result: kind === "clarification" ? { schemaVersion: 1, kind: "clarification", message: "Need more" } : proposal,
        ...(kind === "expiry" ? { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } : {}) });
      let code = "AI_RESULT_UNAVAILABLE";
      if (kind === "replacement") {
        const replacement = randomUUID();
        await database.query("begin");
        try {
          await database.query("update app.scope_draft set status = 'ARCHIVED' where id = $1", [draft.id]);
          await database.query(`insert into app.scope_draft (id, project_id, created_by, document_json, layout_json)
            select $2, project_id, created_by, document_json, layout_json from app.scope_draft where id = $1`, [draft.id, replacement]);
          await database.query("update app.project set current_draft_id = $2 where id = $1", [p, replacement]);
          await database.query("commit");
        } catch (error) { await database.query("rollback"); throw error; }
        code = "DRAFT_REPLACED";
      }
      if (kind === "cancel") await database.query("update app.ai_run set cancel_requested_at = now() where id = $1", [run]);
      if (kind === "discard") {
        const key = randomUUID(); const result = await discardRun(owner.identity, p, run, { key, expectedResultHash: resultHash });
        assert.deepEqual(await discardRun(owner.identity, p, run, { key, expectedResultHash: resultHash }), { ...result, replayed: true });
      }
      const hash = kind === "clarification" ? sha256(canonicalJson({ schemaVersion: 1, kind: "clarification", message: "Need more" })) : resultHash;
      if (kind === "failed") code = "AI_RESULT_MISMATCH";
      const before = await stateOf(database, p, run);
      await assert.rejects(applyRun(owner.identity, p, run, inputOf(draft, hash)), { code });
      assert.deepEqual(await stateOf(database, p, run), before);
    }
  });
});

test("a guarded synthetic baseline-head change refuses Apply and restores the pending-snapshot check", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const other = await projectFor(owner); const draft = await draftOf(database, p);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal });
    const target = new URL(process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL!);
    assert.equal(target.hostname, "127.0.0.1");
    assert.equal((await database.query("select environment_id::text id from app.environment_identity where id = 1")).rows[0].id, process.env.SCOPEROOM_ENVIRONMENT_ID);
    const definition = (await database.query("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid = 'app.project'::regclass and conname = 'project_baseline_pending_snapshots'")).rows[0].definition as string;
    assert.ok(definition.startsWith("CHECK ("));
    // This one synthetic ID is the only exception. Other projects keep the original published guard throughout.
    await database.query("begin");
    try {
      await database.query("alter table app.project drop constraint project_baseline_pending_snapshots");
      await database.query(`alter table app.project add constraint project_baseline_pending_snapshots CHECK ((id = '${p}'::uuid) OR ${definition.slice(6)})`);
      await database.query("commit");
    } catch (error) { await database.query("rollback"); throw error; }
    try {
      await assert.rejects(database.query("update app.project set approved_snapshot_id = $2 where id = $1", [other, randomUUID()]), { code: "23514" });
      const baseline = randomUUID();
      await database.query("update app.project set approved_snapshot_id = $2 where id = $1", [p, baseline]);
      const before = await stateOf(database, p, run);
      await assert.rejects(applyRun(owner.identity, p, run, inputOf(draft)), { code: "BASELINE_CHANGED" });
      await assert.rejects(applyRun(owner.identity, p, run, { ...inputOf(draft), expectedParentSnapshotId: baseline }), { code: "BASELINE_CHANGED" });
      assert.deepEqual(await stateOf(database, p, run), before);
    } finally {
      await database.query("update app.project set approved_snapshot_id = null where id = $1", [p]);
      await database.query("begin");
      try {
        await database.query("alter table app.project drop constraint project_baseline_pending_snapshots");
        await database.query(`alter table app.project add constraint project_baseline_pending_snapshots ${definition}`);
        await database.query("commit");
      } catch (error) { await database.query("rollback"); throw error; }
      assert.equal((await database.query("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid = 'app.project'::regclass and conname = 'project_baseline_pending_snapshots'")).rows[0].definition, definition);
    }
  });
});

test("permanent source-manifest capacity refuses safely with no graph or receipt effect", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const draft = await draftOf(database, p);
    const sources = [];
    // These small sources fit capture and model-input bounds, but their prompt adds the 202nd permanent reference.
    for (let i = 0; i < 201; i++) sources.push(await sourceOf(database, p, owner.profile, "Go"));
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal, sources });
    const input = inputOf(draft); const before = await stateOf(database, p, run);
    await assert.rejects(applyRun(owner.identity, p, run, input), { code: "LIMIT_EXCEEDED" });
    assert.deepEqual(await stateOf(database, p, run), before);
    assert.equal((await database.query("select count(*)::int n from app.mutation_receipt where scope_id = $1 and key = $2", [p, input.key])).rows[0].n, 0);
  });
});
