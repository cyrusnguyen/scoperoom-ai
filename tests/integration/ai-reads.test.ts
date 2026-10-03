import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { parseStartRunInput } from "../../src/features/proposals/contracts/tasks.ts";
import { admitRun, startRun } from "../../src/features/proposals/server/admit-run.ts";
import { listRuns, readRun } from "../../src/features/proposals/server/read-runs.ts";
import { cancelRun } from "../../src/features/proposals/server/settle-runs.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { readSourceVersion } from "../../src/features/sources/server/source-versions.ts";
import { canRun } from "./support/fixture.ts";
import { draftOf, seedRun, withAi } from "./support/ai-runs.ts";

// Authorized run/source reads, cancellation and overdue settlement (Stage 06.1 Task 3) through the real services on the web runtime role.
const CONFIG = { model: "test-model", executionBinding: "binding-1" };
const refused = (code: string) => ({ code });
const MINUTES = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function admitted(db: Client, owner: Parameters<typeof admitRun>[0], projectId: string) {
  const draft = await draftOf(db, projectId);
  const input = parseStartRunInput({ taskType: "PROPOSE_FLOW", prompt: "Outline checkout", draftId: draft.id, expectedDocumentRevision: draft.revision, expectedParentSnapshotId: null, context: { selection: null, sources: [] } }, randomUUID());
  return admitRun(owner, projectId, input, CONFIG);
}

const runRow = async (db: Client, runId: string) => (await db.query("select state::text, budget_state::text, terminal_at, cancel_requested_at, last_event_sequence::text lseq, failure_code from app.ai_run where id = $1", [runId])).rows[0]!;
const cursors = async (db: Client, projectId: string) => (await db.query("select event_sequence::text es, ai_revision::text ai from app.project where id = $1", [projectId])).rows[0]!;
const budgetOf = async (db: Client, owner: string) => (await db.query("select reserved_runs, consumed_runs from app.ai_budget_day where owner_id = $1 order by day", [owner])).rows;
const eventCount = async (db: Client, projectId: string, action: string) => (await db.query("select count(*)::int n from app.audit_event where project_id = $1 and action = $2", [projectId, action])).rows[0]!.n as number;

test("readers and archived access succeed; strangers, removed members and foreign nested ids are denied", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, join, database }) => {
    const owner = await person(); const editor = await person(); const reviewer = await person(); const viewer = await person(); const stranger = await person(); const removed = await person();
    const p = await projectFor(owner); const q = await projectFor(owner);
    for (const [who, role] of [[editor, "EDITOR"], [reviewer, "REVIEWER"], [viewer, "VIEWER"], [removed, "EDITOR"]] as const) await join(owner.identity, p, who.identity, role);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED" });
    const foreign = await seedRun(database, { projectId: q, owner: owner.profile, shape: "SUCCEEDED" });
    const expected = await readRun(owner.identity, p, run);
    assert.equal(expected.id, run);
    for (const who of [editor, reviewer, viewer]) {
      assert.deepEqual(await readRun(who.identity, p, run), expected);
      assert.deepEqual((await listRuns(who.identity, p, {})).runs.map((entry) => entry.id), [run]);
    }
    await assert.rejects(readRun(owner.identity, p, foreign), refused("NOT_FOUND"));
    await assert.rejects(readRun(owner.identity, q, run), refused("NOT_FOUND"));
    await assert.rejects(readRun(owner.identity, p, "not-a-uuid"), refused("NOT_FOUND"));
    await assert.rejects(readRun(owner.identity, "not-a-uuid", run), refused("NOT_FOUND"));
    await assert.rejects(readRun(stranger.identity, p, run), refused("NOT_FOUND"));
    await assert.rejects(listRuns(stranger.identity, p, {}), refused("NOT_FOUND"));
    await database.query("update app.project_membership set active = false, deactivated_sequence = (select event_sequence from app.project where id = $1) where project_id = $1 and profile_id = $2", [p, removed.profile]);
    await assert.rejects(readRun(removed.identity, p, run), refused("NOT_FOUND"));
    await assert.rejects(listRuns(removed.identity, p, {}), refused("NOT_FOUND"));
    await database.query("update app.project set status = 'ARCHIVED' where id = $1", [p]);
    assert.equal((await readRun(viewer.identity, p, run)).applicability, "UNAVAILABLE");
    assert.equal((await listRuns(viewer.identity, p, {})).runs.length, 1);
  });
});

test("a run view exposes safe state, the captured manifest, the result, applicability and expiry, and never an attempt token or dispatch lease", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", prompt: "Outline the checkout flow" });
    await database.query("insert into app.ai_run_attempt (run_id, attempt_number, deadline_at, call_may_have_started, outcome, settled_at, input_tokens, output_tokens, provider_request_id) values ($1, 1, now() + interval '1 minute', true, 'COMPLETED', now(), 11, 7, 'req-secret-1')", [run]);
    const view = await readRun(owner.identity, p, run);
    assert.equal(view.state, "SUCCEEDED"); assert.equal(view.disposition, "AVAILABLE"); assert.equal(view.actorId, owner.profile);
    assert.equal(view.capture?.prompt, "Outline the checkout flow"); assert.equal(view.capture?.draftId, view.draftId);
    assert.deepEqual(view.result, { schemaVersion: 1, kind: "clarification", message: "need more" });
    assert.equal(view.resultHash, "a".repeat(64));
    assert.deepEqual(view.usage, { inputTokens: 11, outputTokens: 7 });
    assert.deepEqual(view.attempts.map((attempt) => [attempt.number, attempt.outcome, attempt.callMayHaveStarted]), [[1, "COMPLETED", true]]);
    const { rows: [row] } = await database.query<{ terminal_at: Date }>("select terminal_at from app.ai_run where id = $1", [run]);
    assert.equal(view.expiresAt, new Date(row!.terminal_at.getTime() + 7 * 24 * 60 * MINUTES).toISOString());
    assert.equal(view.applicability, "UNAVAILABLE"); // a clarification proposes nothing to apply
    const wire = JSON.stringify(view);
    for (const secret of ["req-secret-1", "token", "dispatch", "taskId", "task_id", "executionBinding", "seed-binding", "providerRequestId"]) assert.ok(!wire.includes(secret), secret);
    assert.deepEqual(Object.keys(view.attempts[0]!).sort(), ["callMayHaveStarted", "number", "outcome", "startedAt", "usage"]);
    // Unknown usage stays unknown: an unreported attempt makes the total null rather than a partial sum.
    const { rows: [pending] } = await database.query<{ id: string }>("insert into app.ai_run_attempt (run_id, attempt_number, deadline_at) values ($1, 2, now() + interval '1 minute') returning id", [run]);
    assert.ok(pending);
    assert.deepEqual((await readRun(owner.identity, p, run)).usage, { inputTokens: null, outputTokens: null });
  });
});

test("run history pages stably through equal timestamps, at most 50 per page, with no prompt bodies and a validated opaque cursor", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const same = new Date(Date.now() - 3 * 24 * 60 * MINUTES);
    const ids: string[] = [];
    for (let index = 0; index < 52; index += 1) ids.push(await seedRun(database, { projectId: p, owner: owner.profile, shape: "FAILED", createdAt: same, uncounted: true, prompt: "SECRET-PROMPT-BODY" }));
    const flowId = randomUUID();
    ids.push(await seedRun(database, { projectId: p, owner: owner.profile, shape: "FAILED", createdAt: ago(5 * 24 * 60 * MINUTES), uncounted: true, flowId }));
    const first = await listRuns(owner.identity, p, {});
    assert.equal(first.runs.length, 50);
    assert.ok(first.nextCursor && /^[A-Za-z0-9_-]+$/.test(first.nextCursor));
    const second = await listRuns(owner.identity, p, { cursor: first.nextCursor });
    assert.equal(second.runs.length, 3); assert.equal(second.nextCursor, null);
    const seen = [...first.runs, ...second.runs].map((entry) => entry.id);
    assert.deepEqual([...seen].sort(), [...ids].sort());
    assert.equal(new Set(seen).size, 53);
    const ordered = first.runs.map((entry) => entry.id);
    assert.deepEqual(ordered, [...ordered].sort().reverse(), "equal createdAt ties break by id descending");
    assert.ok(!JSON.stringify([...first.runs, ...second.runs]).includes("SECRET-PROMPT-BODY"));
    assert.deepEqual(Object.keys(first.runs[0]!).sort(), ["actorId", "cancelRequestedAt", "createdAt", "deadlineAt", "disposition", "failureCode", "flowId", "id", "lastEventSequence", "state", "taskType", "terminalAt", "usage"]);
    assert.deepEqual((await listRuns(owner.identity, p, { flowId })).runs.map((entry) => entry.id), [ids.at(-1)]);
    assert.deepEqual((await listRuns(owner.identity, p, { flowId: randomUUID() })).runs, []);
    for (const cursor of ["", "!!", Buffer.from("nope").toString("base64url"), Buffer.from(JSON.stringify(["2026-01-01T00:00:00.000000Z", "not-a-uuid"])).toString("base64url"), Buffer.from(JSON.stringify(["x", randomUUID()])).toString("base64url")]) {
      await assert.rejects(listRuns(owner.identity, p, { cursor }), refused("INVALID_INPUT"), cursor);
    }
    await assert.rejects(listRuns(owner.identity, p, { flowId: "nope" }), refused("INVALID_INPUT"));
  });
});

test("a source version is read exactly with its line map, hash and title and never swapped for the current head", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, join, database }) => {
    const owner = await person(); const viewer = await person(); const stranger = await person();
    const p = await projectFor(owner); const q = await projectFor(owner);
    await join(owner.identity, p, viewer.identity, "VIEWER");
    const source = randomUUID(); const v1 = randomUUID(); const v2 = randomUUID();
    await database.query("begin");
    await database.query("set constraints all deferred");
    await database.query("insert into app.source_document (id, project_id, kind, current_version_id, created_by) values ($1, $2, 'USER_TEXT', $3, $4)", [source, p, v2, owner.profile]);
    const text1 = "Line one\n\nThird \u{1F600} line"; const text2 = "Replaced text\nsecond";
    for (const [id, n, title, text] of [[v1, 1, "Notes v1", text1], [v2, 2, "Notes v2", text2]] as const) {
      await database.query(
        `insert into app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by)
         values ($1, $2, $3, $4, $5, $6, char_length($6), octet_length($6), encode(sha256(convert_to($6, 'UTF8')), 'hex'), $7)`, [id, p, source, n, title, text, owner.profile]);
    }
    await database.query("commit");
    const older = await readSourceVersion(viewer.identity, p, v1);
    assert.equal(older.id, v1); assert.equal(older.text, text1); assert.equal(older.title, "Notes v1"); assert.equal(older.sequence, 1);
    assert.equal(older.contentHash, (await database.query("select content_hash from app.source_version where id = $1", [v1])).rows[0]!.content_hash);
    assert.deepEqual(older.lineStarts, [0, 9, 10]); assert.equal(older.codePointCount, Array.from(text1).length);
    assert.equal(older.kind, "USER_TEXT"); assert.equal(older.createdBy, owner.profile); assert.equal(older.origin, null);
    assert.equal((await readSourceVersion(owner.identity, p, v2)).text, text2);
    await assert.rejects(readSourceVersion(owner.identity, q, v1), refused("NOT_FOUND"));
    await assert.rejects(readSourceVersion(stranger.identity, p, v1), refused("NOT_FOUND"));
    await assert.rejects(readSourceVersion(owner.identity, p, randomUUID()), refused("NOT_FOUND"));
    await assert.rejects(readSourceVersion(owner.identity, p, "not-a-uuid"), refused("NOT_FOUND"));
  });
});

test("cancel records intent for the current originating editor or the owner, keeps the slot, disables Apply and replays by key", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, join, database }) => {
    const owner = await person(); const editor = await person(); const other = await person(); const viewer = await person(); const stranger = await person();
    const p = await projectFor(owner);
    for (const [who, role] of [[editor, "EDITOR"], [other, "EDITOR"], [viewer, "VIEWER"]] as const) await join(owner.identity, p, who.identity, role);
    const admission = await admitted(database, editor.identity, p);
    const key = randomUUID();
    await assert.rejects(cancelRun(other.identity, p, admission.runId, randomUUID()), refused("FORBIDDEN"));
    await assert.rejects(cancelRun(viewer.identity, p, admission.runId, randomUUID()), refused("FORBIDDEN"));
    await assert.rejects(cancelRun(stranger.identity, p, admission.runId, randomUUID()), refused("NOT_FOUND"));
    assert.equal((await readRun(other.identity, p, admission.runId)).state, "QUEUED"); // another editor may inspect
    assert.equal((await runRow(database, admission.runId)).cancel_requested_at, null);
    const done = await cancelRun(editor.identity, p, admission.runId, key);
    assert.deepEqual([done.runId, done.cancelRequested, done.replayed], [admission.runId, true, false]);
    const after = await cursors(database, p);
    assert.equal(after.ai, after.es); assert.equal(String(done.aiRevision), after.ai); assert.ok(done.aiRevision > admission.aiRevision);
    const row = await runRow(database, admission.runId);
    assert.deepEqual([row.state, row.budget_state, row.terminal_at], ["QUEUED", "RESERVED", null]);
    assert.notEqual(row.cancel_requested_at, null); assert.equal(row.lseq, after.ai);
    assert.deepEqual(await budgetOf(database, owner.profile), [{ reserved_runs: 1, consumed_runs: 0 }]);
    const view = await readRun(viewer.identity, p, admission.runId);
    assert.equal(view.state, "QUEUED"); assert.equal(view.applicability, "UNAVAILABLE"); assert.notEqual(view.cancelRequestedAt, null);
    assert.equal(await eventCount(database, p, "AI_RUN_CANCEL_REQUESTED"), 1);
    // The slot is still held until a confirmed terminal outcome or the deadline.
    await assert.rejects(admitted(database, owner.identity, p), refused("AI_BUSY"));
    assert.deepEqual(await cancelRun(editor.identity, p, admission.runId, key), { ...done, replayed: true });
    await assert.rejects(cancelRun(editor.identity, p, randomUUID(), key), refused("KEY_REUSED"));
    // A new key on an already cancelling run is idempotent: no second event, same revision.
    assert.deepEqual(await cancelRun(owner.identity, p, admission.runId, randomUUID()), { runId: admission.runId, cancelRequested: true, aiRevision: done.aiRevision, replayed: false });
    assert.equal(await eventCount(database, p, "AI_RUN_CANCEL_REQUESTED"), 1);
    assert.deepEqual(await cursors(database, p), after);
    // Access precedes replay: a removed originator can no longer recover the receipt.
    await database.query("update app.project_membership set active = false, deactivated_sequence = (select event_sequence from app.project where id = $1) where project_id = $1 and profile_id = $2", [p, editor.profile]);
    await assert.rejects(cancelRun(editor.identity, p, admission.runId, key), refused("NOT_FOUND"));
  });
});

test("the owner may cancel another editor's run, a terminal run has nothing to cancel, and an archived project refuses new cancellation", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, join, database }) => {
    const owner = await person(); const editor = await person();
    const p = await projectFor(owner); const q = await projectFor(owner);
    await join(owner.identity, p, editor.identity);
    const run = await admitted(database, editor.identity, p);
    assert.equal((await cancelRun(owner.identity, p, run.runId, randomUUID())).cancelRequested, true);
    const finished = await seedRun(database, { projectId: q, owner: owner.profile, shape: "FAILED" });
    const before = await cursors(database, q);
    assert.deepEqual(await cancelRun(owner.identity, q, finished, randomUUID()), { runId: finished, cancelRequested: false, aiRevision: Number(before.ai), replayed: false });
    assert.deepEqual(await cursors(database, q), before);
    await assert.rejects(cancelRun(owner.identity, q, run.runId, randomUUID()), refused("NOT_FOUND")); // nested foreign id
    await database.query("update app.project set status = 'ARCHIVED' where id = $1", [q]);
    await assert.rejects(cancelRun(owner.identity, q, finished, randomUUID()), refused("CONFLICT"));
  });
});

test("an unacknowledged cancellation of a possibly started call keeps the run, the slot and the consumed reservation until the deadline", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "RUNNING", createdAt: ago(60_000) });
    const done = await cancelRun(owner.identity, p, run, randomUUID());
    assert.equal(done.cancelRequested, true);
    for (const read of [() => readRun(owner.identity, p, run), () => listRuns(owner.identity, p, {}), () => getProjectStatus(owner.identity, p), () => getProjectBootstrap(owner.identity, p)]) await read();
    assert.equal((await runRow(database, run)).state, "RUNNING");
    assert.deepEqual(await budgetOf(database, owner.profile), [{ reserved_runs: 0, consumed_runs: 1 }]);
    await assert.rejects(admitted(database, owner.identity, p), refused("AI_BUSY"));
    assert.equal((await getProjectStatus(owner.identity, p)).aiRevision, done.aiRevision);
  });
});

test("reads discover an overdue QUEUED run, refund its never-dispatched reservation once and advance aiRevision", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const other = await projectFor(owner);
    await seedRun(database, { projectId: other, owner: owner.profile, createdAt: new Date() }); // a live reservation on the same day must be untouched
    const run = await seedRun(database, { projectId: p, owner: owner.profile, createdAt: ago(10 * MINUTES) });
    assert.deepEqual(await budgetOf(database, owner.profile), [{ reserved_runs: 2, consumed_runs: 0 }]);
    const before = await cursors(database, p);
    const view = await readRun(owner.identity, p, run);
    assert.equal(view.state, "TIMED_OUT"); assert.equal(view.terminalAt !== null, true); assert.equal(view.applicability, "UNAVAILABLE");
    const row = await runRow(database, run);
    assert.deepEqual([row.state, row.budget_state], ["TIMED_OUT", "RELEASED"]);
    const after = await cursors(database, p);
    assert.equal(after.ai, after.es); assert.equal(Number(after.es) - Number(before.es), 1); assert.equal(row.lseq, after.ai); assert.equal(view.lastEventSequence, Number(after.ai));
    assert.deepEqual(await budgetOf(database, owner.profile), [{ reserved_runs: 1, consumed_runs: 0 }]);
    assert.equal(await eventCount(database, p, "AI_RUN_TIMED_OUT"), 1);
    // Repeated expiry through every entry point settles nothing again and never refunds twice.
    for (const read of [() => readRun(owner.identity, p, run), () => listRuns(owner.identity, p, {}), () => getProjectStatus(owner.identity, p), () => getProjectBootstrap(owner.identity, p)]) await read();
    assert.deepEqual(await cursors(database, p), after);
    assert.deepEqual(await budgetOf(database, owner.profile), [{ reserved_runs: 1, consumed_runs: 0 }]);
    assert.equal((await database.query("select state::text from app.ai_run where project_id = $1", [other])).rows[0]!.state, "QUEUED");
  });
});

test("an overdue possibly started call times out but stays consumed, even with a cancellation requested", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "RUNNING", createdAt: ago(10 * MINUTES) });
    await database.query("update app.ai_run set cancel_requested_at = now() - interval '9 minutes' where id = $1", [run]);
    const status = await getProjectStatus(owner.identity, p);
    const row = await runRow(database, run);
    assert.deepEqual([row.state, row.budget_state], ["TIMED_OUT", "CONSUMED"]);
    assert.equal(status.aiRevision, Number((await cursors(database, p)).ai));
    assert.deepEqual(await budgetOf(database, owner.profile), [{ reserved_runs: 0, consumed_runs: 1 }]);
    assert.equal((await database.query("select outcome::text, call_may_have_started from app.ai_run_attempt where run_id = $1", [run])).rows[0]!.outcome, "TIMED_OUT");
    await getProjectStatus(owner.identity, p);
    assert.deepEqual(await budgetOf(database, owner.profile), [{ reserved_runs: 0, consumed_runs: 1 }]);
  });
});

test("status carries aiRevision and the nullable baseline identity from one read-only snapshot", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const first = await getProjectStatus(owner.identity, p);
    assert.equal(first.aiRevision, 0); assert.equal(first.approvedSnapshotId, null);
    const admission = await admitted(database, owner.identity, p);
    const status = await getProjectStatus(owner.identity, p);
    assert.equal(status.aiRevision, admission.aiRevision); assert.equal(status.eventSequence, admission.aiRevision);
    assert.deepEqual((await getProjectBootstrap(owner.identity, p)).status, status);
    // A live run inside its window is never settled by a read.
    assert.equal((await runRow(database, admission.runId)).state, "QUEUED");
    const stranger = await person();
    await assert.rejects(getProjectStatus(stranger.identity, p), refused("NOT_FOUND"));
    assert.equal((await runRow(database, admission.runId)).state, "QUEUED");
  });
});

test("admission discovers an overdue run on its own project and an overdue run elsewhere no longer holds an owner slot", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const q = await projectFor(owner); const r = await projectFor(owner);
    const overdue = await seedRun(database, { projectId: p, owner: owner.profile, createdAt: ago(10 * MINUTES) });
    const live = await admitted(database, owner.identity, p);
    assert.notEqual(live.runId, overdue);
    const settled = await runRow(database, overdue);
    assert.deepEqual([settled.state, settled.budget_state], ["TIMED_OUT", "RELEASED"]);
    const cursor = await cursors(database, p);
    assert.equal(cursor.ai, cursor.es); assert.equal(String(live.aiRevision), cursor.ai);
    assert.equal((await runRow(database, live.runId)).lseq, cursor.ai);
    assert.equal(await eventCount(database, p, "AI_RUN_TIMED_OUT"), 1);
    assert.deepEqual(await budgetOf(database, owner.profile), [{ reserved_runs: 1, consumed_runs: 0 }]);
    // Another project's overdue run: the owner slot count ignores it, so the owner's second slot is free.
    await seedRun(database, { projectId: q, owner: owner.profile, createdAt: ago(10 * MINUTES) });
    await admitted(database, owner.identity, r);
    assert.equal((await database.query("select count(*)::int n from app.ai_run where owner_id = $1 and state in ('QUEUED','RUNNING')", [owner.profile])).rows[0]!.n, 3);
  });
});

test("concurrent discoveries of one overdue run settle it exactly once", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, createdAt: ago(10 * MINUTES) });
    await seedRun(database, { projectId: await projectFor(owner), owner: owner.profile }); // reserved total 2: a double refund would show as 0
    const before = await cursors(database, p);
    await Promise.all([1, 2, 3, 4, 5, 6].map((n) => (n % 2 ? readRun(owner.identity, p, run) : getProjectStatus(owner.identity, p))));
    assert.equal(await eventCount(database, p, "AI_RUN_TIMED_OUT"), 1);
    assert.equal(Number((await cursors(database, p)).es) - Number(before.es), 1);
    assert.deepEqual(await budgetOf(database, owner.profile), [{ reserved_runs: 1, consumed_runs: 0 }]);
  });
});

test("the start entry maps the parser's size refusal to LIMIT_EXCEEDED on START_BODY_BYTES and every other parser failure to INVALID_INPUT", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const draft = await draftOf(database, p);
    const body = { taskType: "PROPOSE_FLOW", prompt: "Outline checkout", draftId: draft.id, expectedDocumentRevision: draft.revision, expectedParentSnapshotId: null, context: { selection: null, sources: [] } };
    const sources = Array.from({ length: 600 }, () => ({ sourceVersionId: randomUUID(), expectedCurrentVersionId: randomUUID() }));
    await assert.rejects(startRun(owner.identity, p, { ...body, context: { selection: null, sources }, key: randomUUID() }), { code: "LIMIT_EXCEEDED", details: { limit: "START_BODY_BYTES" } });
    await assert.rejects(startRun(owner.identity, p, { ...body, actorId: randomUUID(), key: randomUUID() }), refused("INVALID_INPUT"));
    await assert.rejects(startRun(owner.identity, p, { ...body, taskType: "CHAT", key: randomUUID() }), refused("INVALID_INPUT"));
    await assert.rejects(startRun(owner.identity, p, { ...body }), refused("INVALID_INPUT")); // no key
    assert.equal((await database.query("select count(*)::int n from app.ai_run where project_id = $1", [p])).rows[0].n, 0);
  });
});
