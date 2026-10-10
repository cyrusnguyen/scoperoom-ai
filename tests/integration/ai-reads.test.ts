import { seedSnapshot } from "../support/snapshot-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { executeGraphCommand } from "../../src/features/drafts/server/execute-command.ts";
import { parseDraftPair } from "../../src/features/drafts/contracts/scope-document.ts";
import { canonicalJson, sha256 } from "../../src/features/proposals/domain/capture.ts";
import { applyRun } from "../../src/features/proposals/server/apply-run.ts";
import { discardRun } from "../../src/features/proposals/server/discard-run.ts";
import { workerCleanup } from "../../src/server/maintenance/worker-cleanup.ts";
import { AI_LIMITS, parseStartRunInput } from "../../src/features/proposals/contracts/tasks.ts";
import { admitRun, startRun } from "../../src/features/proposals/server/admit-run.ts";
import { listRuns, readRun } from "../../src/features/proposals/server/read-runs.ts";
import { cancelRun } from "../../src/features/proposals/server/settle-runs.ts";
import { archiveProject } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { readAsMember } from "../../src/features/projects/server/access.ts";
import { applicableCapacityFull } from "../../src/features/proposals/server/applicability.ts";
import { readSourceVersion } from "../../src/features/sources/server/source-versions.ts";
import { canRun } from "./support/fixture.ts";
import { draftOf, seedRun, withAi } from "./support/ai-runs.ts";
import { serializeSweeps } from "./support/sweep-lock.ts";

// Authorized run/source reads, cancellation and overdue settlement (Stage 06.1 Task 3) through the real services on the web runtime role.
serializeSweeps(); // Aged history/body fixtures must not be expired by another file's global sweep.
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
    assert.equal(view.resultHash, sha256(canonicalJson(view.result)));
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

test("a retained result past terminal plus seven days is unavailable before cleanup", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const proposal = generatedProposal;
    const current = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal });
    assert.equal((await readRun(owner.identity, p, current)).applicability, "APPLICABLE");
    const terminalAt = ago(8 * 24 * 60 * MINUTES);
    const run = await seedRun(database, {
      projectId: p, owner: owner.profile, shape: "SUCCEEDED", createdAt: terminalAt,
      result: proposal,
    });
    const view = await readRun(owner.identity, p, run);
    assert.equal(view.disposition, "AVAILABLE");
    assert.equal(view.expiresAt, new Date(terminalAt.getTime() + 7 * 24 * 60 * MINUTES).toISOString());
    assert.equal(view.applicability, "UNAVAILABLE");
  });
});

test("validation and expired validation recovery each advance the AI cursor once", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const q = await projectFor(owner);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "RUNNING" });
    const { rows: [attempt] } = await database.query<{ id: string; token: string }>("select id, token from app.ai_run_attempt where run_id = $1", [run]);
    const beforeValidation = await cursors(database, p);
    assert.equal((await database.query("select app.begin_ai_validation($1, $2, $3) as status", [run, attempt!.id, attempt!.token])).rows[0]!.status, "VALIDATING");
    const afterValidation = await cursors(database, p);
    assert.deepEqual([Number(afterValidation.es) - Number(beforeValidation.es), afterValidation.ai, (await runRow(database, run)).lseq], [1, afterValidation.es, afterValidation.es]);
    assert.equal(await eventCount(database, p, "AI_RUN_VALIDATING"), 1);
    assert.equal((await database.query("select app.begin_ai_validation($1, $2, $3) as status", [run, attempt!.id, attempt!.token])).rows[0]!.status, "STALE");
    assert.deepEqual(await cursors(database, p), afterValidation);

    const recoverable = await seedRun(database, { projectId: q, owner: owner.profile, shape: "RUNNING", createdAt: ago(3 * MINUTES), uncounted: true });
    await database.query("update app.ai_run set state = 'VALIDATING' where id = $1", [recoverable]);
    const beforeRecovery = await cursors(database, q);
    const recovery = (await database.query("select * from app.claim_ai_attempt($1)", [recoverable])).rows[0]!;
    assert.equal(recovery.out_status, "CLAIMED");
    const afterRecovery = await cursors(database, q);
    assert.deepEqual([Number(afterRecovery.es) - Number(beforeRecovery.es), afterRecovery.ai, (await runRow(database, recoverable)).lseq], [1, afterRecovery.es, afterRecovery.es]);
    assert.equal(await eventCount(database, q, "AI_RUN_STARTED"), 1);
    assert.equal((await database.query("select * from app.claim_ai_attempt($1)", [recoverable])).rows[0]!.out_status, "BUSY");
    assert.deepEqual(await cursors(database, q), afterRecovery);
    assert.equal(await eventCount(database, q, "AI_RUN_STARTED"), 1);
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
    for (const cursor of ["", "!!", Buffer.from("nope").toString("base64url"), Buffer.from(JSON.stringify(["2026-01-01T00:00:00.000000Z", "not-a-uuid"])).toString("base64url"), Buffer.from(JSON.stringify(["x", randomUUID()])).toString("base64url"),
      Buffer.from(JSON.stringify(["2026-02-30T00:00:00.000000Z", randomUUID()])).toString("base64url"), Buffer.from(JSON.stringify(["2026-13-01T00:00:00.000000Z", randomUUID()])).toString("base64url")]) {
      await assert.rejects(listRuns(owner.identity, p, { cursor }), refused("INVALID_INPUT"), cursor);
    }
    await assert.rejects(listRuns(owner.identity, p, { flowId: "nope" }), refused("INVALID_INPUT"));
  });
});

test("flow history retains its originating identity after capture expiry and live flow deletion", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const draft = await draftOf(database, p);
    const created = await executeGraphCommand(owner.identity, p, draft.id, { key: randomUUID(), commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: draft.revision,
      payload: { title: "Historical flow", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" } });
    const flowId = created.createdIds[0]!;
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "FAILED", createdAt: ago(8 * 24 * 60 * MINUTES), flowId });
    assert.equal((await readRun(owner.identity, p, run)).flowId, flowId);
    assert.deepEqual((await listRuns(owner.identity, p, { flowId })).runs.map((entry) => entry.id), [run]);
    await executeGraphCommand(owner.identity, p, draft.id, { key: randomUUID(), commandSchemaVersion: 1, command: "DELETE_FLOW", expectedDocumentRevision: created.documentRevision,
      payload: { flowId, removeNodeIds: [], removeEdgeIds: [] } });
    // Exercise the retention write guard on only this fixture; the actual bounded sweep is covered in ai-retention.
    await database.query("update app.ai_run set capture = null where id = $1", [run]);
    const expired = await readRun(owner.identity, p, run);
    assert.equal(expired.capture, null);
    assert.equal(expired.flowId, flowId);
    assert.equal((await listRuns(owner.identity, p, {})).runs[0]!.flowId, flowId);
    assert.deepEqual((await listRuns(owner.identity, p, { flowId })).runs.map((entry) => entry.id), [run]);
    assert.deepEqual((await listRuns(owner.identity, p, { flowId: randomUUID() })).runs, []);
    for (const replacement of [randomUUID(), null]) {
      await assert.rejects(database.query("update app.ai_run set flow_id = $2 where id = $1", [run, replacement]), { code: "23514" }, "historical attribution is immutable even after its capture expired");
    }
  });
});

test("real admission pins Improve flow identity while Generate has no originating flow", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const q = await projectFor(owner);
    const draft = await draftOf(database, p);
    const flow = await executeGraphCommand(owner.identity, p, draft.id, { key: randomUUID(), commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: draft.revision,
      payload: { title: "Improve target", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" } });
    const flowId = flow.createdIds[0]!;
    const node = await executeGraphCommand(owner.identity, p, draft.id, { key: randomUUID(), commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: flow.documentRevision,
      payload: { flowId, kind: "ACTION", label: "Review order", description: "", actorLabel: "" } });
    const input = parseStartRunInput({ taskType: "REFINE_FLOW_SELECTION", prompt: "Make this step clearer", draftId: draft.id, expectedDocumentRevision: node.documentRevision,
      expectedParentSnapshotId: null, context: { selection: { flowId, nodeIds: node.createdIds }, sources: [] } }, randomUUID());
    const improve = await admitRun(owner.identity, p, input, CONFIG);
    assert.equal((await readRun(owner.identity, p, improve.runId)).flowId, flowId);
    assert.deepEqual((await listRuns(owner.identity, p, { flowId })).runs.map((entry) => entry.id), [improve.runId]);
    const generate = await admitted(database, owner.identity, q);
    assert.equal((await readRun(owner.identity, q, generate.runId)).flowId, null);
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

test("a non-member status read settles nothing; a member read settles the overdue run", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const stranger = await person(); const p = await projectFor(owner);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, createdAt: ago(10 * MINUTES) });
    const before = await cursors(database, p);
    await assert.rejects(getProjectStatus(stranger.identity, p), refused("NOT_FOUND"));
    await assert.rejects(getProjectBootstrap(stranger.identity, p), refused("NOT_FOUND"));
    await assert.rejects(readRun(stranger.identity, p, run), refused("NOT_FOUND"));
    assert.equal((await runRow(database, run)).state, "QUEUED");
    assert.deepEqual(await cursors(database, p), before);
    assert.deepEqual(await budgetOf(database, owner.profile), [{ reserved_runs: 1, consumed_runs: 0 }]);
    await getProjectStatus(owner.identity, p);
    assert.equal((await runRow(database, run)).state, "TIMED_OUT");
  });
});

test("archiving records cancel intent on the nonterminal run without settling it, and Apply is off in the run view", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, join, database }) => {
    const owner = await person(); const editor = await person(); const p = await projectFor(owner);
    await join(owner.identity, p, editor.identity);
    const run = await admitted(database, editor.identity, p);
    const finished = await seedRun(database, { projectId: await projectFor(owner), owner: owner.profile, shape: "FAILED" }); // another project's run is never touched
    const before = await readRun(owner.identity, p, run.runId);
    assert.equal(before.cancelRequestedAt, null);
    const status = await getProjectStatus(owner.identity, p);
    await archiveProject(owner.identity, p, { expectedProjectVersion: status.version, reason: "Done", key: randomUUID() });
    const row = await runRow(database, run.runId);
    assert.deepEqual([row.state, row.budget_state, row.terminal_at], ["QUEUED", "RESERVED", null]);
    assert.notEqual(row.cancel_requested_at, null);
    const after = await cursors(database, p);
    assert.equal(after.ai, after.es); assert.equal(Number(after.es) - run.aiRevision, 2, "the archive event and the cancel event");
    assert.equal(row.lseq, after.ai);
    assert.equal(await eventCount(database, p, "AI_RUN_CANCEL_REQUESTED"), 1); assert.equal(await eventCount(database, p, "PROJECT_ARCHIVED"), 1);
    const view = await readRun(editor.identity, p, run.runId);
    assert.deepEqual([view.state, view.applicability, view.lastEventSequence], ["QUEUED", "UNAVAILABLE", Number(after.ai)]); assert.notEqual(view.cancelRequestedAt, null);
    assert.deepEqual(await budgetOf(database, owner.profile), [{ reserved_runs: 1, consumed_runs: 1 }]);
    assert.equal((await database.query("select count(*)::int n from app.ai_run where id = $1 and cancel_requested_at is not null", [finished])).rows[0].n, 0);
  });
});

const generatedProposal = { schemaVersion: 1, kind: "proposal", operations: [
  { id: "flow", dependsOn: [], edit: { command: "CREATE_FLOW", payload: { ref: "flow", title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" } } },
  { id: "step", dependsOn: ["flow"], edit: { command: "ADD_NODE", payload: { ref: "step", flowId: "flow", kind: "ACTION", label: "Pay", description: "", actorLabel: "" } } },
], assumptions: [], citations: [] };

test("run reads expose deterministic captured diff, keep layout applicable and explain semantic staleness", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: generatedProposal });
    const view = await readRun(owner.identity, p, run);
    assert.equal(view.applicability, "APPLICABLE"); assert.deepEqual(view.applicabilityReasons, []);
    assert.deepEqual(view.diff?.selectedOperationIds, ["flow", "step"]);
    assert.equal(view.diff?.before.nodes.length, 0); assert.equal(view.diff?.after.nodes[0]?.label, "Pay");
    assert.equal(view.diff?.after.nodes[0]?.readOnly, false);
    await database.query("update app.scope_draft set layout_revision = layout_revision + 1 where project_id = $1", [p]);
    assert.deepEqual((await readRun(owner.identity, p, run)).diff, view.diff);
    assert.equal((await readRun(owner.identity, p, run)).applicability, "APPLICABLE");
    await database.query("update app.scope_draft set document_revision = document_revision + 1 where project_id = $1", [p]);
    const stale = await readRun(owner.identity, p, run);
    assert.equal(stale.applicability, "STALE"); assert.deepEqual(stale.applicabilityReasons, ["DOCUMENT_CHANGED"]);
    assert.deepEqual(stale.diff, view.diff); assert.deepEqual(stale.capture, view.capture); assert.deepEqual(stale.result, view.result);
  });
});

test("clarifications, expired results and stale history free admission while ten valid current proposals refuse", { skip: !canRun }, async () => {
  for (const shape of ["clarification", "expired", "stale", "invalid", "applicable"] as const) {
    await withAi(async ({ person, projectFor, database }) => {
      const owner = await person(); const p = await projectFor(owner);
      for (let n = 0; n < 10; n++) await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: shape === "clarification" ? { schemaVersion: 1, kind: "clarification", message: "More information" } : shape === "invalid" ? { schemaVersion: 1, kind: "proposal", operations: [], assumptions: [], citations: [] } : generatedProposal, ...(shape === "expired" ? { createdAt: ago(8 * 24 * 60 * MINUTES) } : {}) });
      if (shape === "stale") await database.query("update app.scope_draft set document_revision = document_revision + 1 where project_id = $1", [p]);
      if (shape === "applicable") await assert.rejects(admitted(database, owner.identity, p), { code: "LIMIT_EXCEEDED", details: { limit: "APPLICABLE_PROPOSALS" } });
      else assert.equal((await admitted(database, owner.identity, p)).state, "QUEUED", shape);
    });
  }
});

test("invalid historical proposal bodies fail closed with no diff or Apply authority", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: { schemaVersion: 1, kind: "proposal", operations: [], assumptions: [], citations: [] } });
    const view = await readRun(owner.identity, p, run);
    assert.equal(view.applicability, "UNAVAILABLE"); assert.deepEqual(view.applicabilityReasons, ["INVALID_RESULT"]);
    assert.equal(view.result, null); assert.equal(view.diff, null); assert.equal(view.application, null);
    assert.equal(view.resultHash, sha256(canonicalJson({ schemaVersion: 1, kind: "proposal", operations: [], assumptions: [], citations: [] })));
    await assert.rejects(applyRun(owner.identity, p, run, { key: randomUUID(), draftId: view.draftId, expectedDocumentRevision: view.documentRevision, expectedParentSnapshotId: null, resultHash: view.resultHash!, selectedOperationIds: ["flow"] }), { code: "AI_RESULT_UNAVAILABLE" });
  });
});

test("permanent applied evidence survives body cleanup and later graph edits; discarded and expired history remain honest", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: generatedProposal });
    const initial = await readRun(owner.identity, p, run);
    const applied = await applyRun(owner.identity, p, run, { key: randomUUID(), draftId: initial.draftId, expectedDocumentRevision: initial.documentRevision, expectedParentSnapshotId: null, resultHash: initial.resultHash!, selectedOperationIds: ["flow", "step"] });
    const before = await readRun(owner.identity, p, run);
    assert.equal(before.application?.id, applied.applicationId); assert.equal(before.application?.evidence.after.find(record => "label" in record)?.label, "Pay");
    assert.deepEqual(before.applicabilityReasons, ["APPLIED"]); assert.equal(before.expiresAt, new Date(new Date(before.terminalAt!).getTime() + 7 * 24 * 60 * MINUTES).toISOString());
    const node = before.application!.createdIdMap.step;
    await executeGraphCommand(owner.identity, p, initial.draftId, { key: randomUUID(), commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: node, label: "Later manual text" } });
    const discarded = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: generatedProposal });
    const dview = await readRun(owner.identity, p, discarded);
    await discardRun(owner.identity, p, discarded, { key: randomUUID(), expectedResultHash: dview.resultHash! });
    const expired = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: generatedProposal, createdAt: ago(8 * 24 * 60 * MINUTES) });
    await database.query("alter table app.ai_run disable trigger enforce_ai_run");
    try { await database.query("update app.ai_run set terminal_at = now() - interval '8 days' where id = any($1::uuid[])", [[run, discarded]]); }
    finally { await database.query("alter table app.ai_run enable trigger enforce_ai_run"); }
    await workerCleanup();
    const after = await readRun(owner.identity, p, run);
    assert.equal(after.capture, null); assert.equal(after.result, null); assert.equal(after.diff, null); assert.equal(after.expiresAt, null);
    assert.deepEqual(after.application, before.application); assert.deepEqual(after.applicabilityReasons, ["APPLIED"]);
    assert.equal((await readRun(owner.identity, p, discarded)).disposition, "DISCARDED");
    assert.deepEqual((await readRun(owner.identity, p, discarded)).applicabilityReasons, ["DISCARDED"]);
    assert.equal((await readRun(owner.identity, p, expired)).disposition, "EXPIRED");
    assert.deepEqual((await readRun(owner.identity, p, expired)).applicabilityReasons, ["EXPIRED"]);
  });
});

test("permanent Apply evidence keeps a trace link retired with its selected node after body cleanup", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const draft = await draftOf(database, p);
    const flow = await executeGraphCommand(owner.identity, p, draft.id, { key: randomUUID(), commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: draft.revision,
      payload: { title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" } });
    const flowId = flow.createdIds[0]!;
    const node = await executeGraphCommand(owner.identity, p, draft.id, { key: randomUUID(), commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: flow.documentRevision,
      payload: { flowId, kind: "ACTION", label: "Pay", description: "", actorLabel: "" } });
    const nodeId = node.createdIds[0]!;
    const requirement = await executeGraphCommand(owner.identity, p, draft.id, { key: randomUUID(), commandSchemaVersion: 1, command: "CREATE_REQUIREMENT", expectedDocumentRevision: node.documentRevision,
      payload: { title: "Pay by card", statement: "", category: "FUNCTIONAL", inclusion: "UNDECIDED", ownerId: null, verification: null, sourceRefs: [] } });
    const link = await executeGraphCommand(owner.identity, p, draft.id, { key: randomUUID(), commandSchemaVersion: 1, command: "ADD_TRACE_LINK", expectedDocumentRevision: requirement.documentRevision,
      payload: { requirementId: requirement.createdIds[0]!, nodeId, explanation: "Payment evidence" } });
    const linkId = link.createdIds[0]!;
    const proposal = { schemaVersion: 1, kind: "proposal" as const, operations: [
      { id: "remove", dependsOn: [], edit: { command: "DELETE_NODES" as const, payload: { flowId, nodeIds: [nodeId], removeEdgeIds: [] } } },
    ], assumptions: [], citations: [] };
    const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: proposal, selection: { flowId, nodeIds: [nodeId] } });
    const view = await readRun(owner.identity, p, run);
    await applyRun(owner.identity, p, run, { key: randomUUID(), draftId: view.draftId, expectedDocumentRevision: view.documentRevision, expectedParentSnapshotId: view.parentSnapshotId, resultHash: view.resultHash!, selectedOperationIds: ["remove"] });
    const before = await readRun(owner.identity, p, run);
    const retained = before.application?.evidence.before.find((record) => record.id === linkId);
    assert.deepEqual(retained, { id: linkId, version: 1, requirementId: requirement.createdIds[0], nodeId, explanation: "Payment evidence", reviewedRequirementBehaviourVersion: null, reviewedNodeBehaviourVersion: null, reviewedBy: null, reviewedAt: null });
    assert.ok(!before.application?.evidence.after.some((record) => record.id === linkId));
    await database.query("alter table app.ai_run disable trigger enforce_ai_run");
    try { await database.query("update app.ai_run set terminal_at = now() - interval '8 days' where id = $1", [run]); }
    finally { await database.query("alter table app.ai_run enable trigger enforce_ai_run"); }
    await workerCleanup();
    const after = await readRun(owner.identity, p, run);
    assert.equal(after.capture, null); assert.equal(after.result, null);
    assert.deepEqual(after.application?.evidence.before.find((record) => record.id === linkId), retained);

    const large = (await getProjectBootstrap(owner.identity, p)).draft;
    const nodeIds: string[] = Array.from({ length: 3 }, () => randomUUID()), requirementIds: string[] = [requirement.createdIds[0]!, ...Array.from({ length: 149 }, () => randomUUID())], linkIds: string[] = [];
    for (const nodeId of nodeIds) {
      large.document.nodes[nodeId] = { id: nodeId, flowId, version: 1, behaviourVersion: 1, kind: "ACTION", label: "Retained step", description: "", actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] };
      large.layout.positions[nodeId] = { x: 0, y: 0, version: 1 };
    }
    large.layout.directions[flowId] = "TB";
    for (let index = 1; index < 150; index += 1) {
      const id = requirementIds[index]!;
      large.document.requirements[id] = { id, displayId: `REQ-${String(index + 1).padStart(3, "0")}`, version: 1, behaviourVersion: 1, title: "Retained requirement", statement: "", category: "FUNCTIONAL", inclusion: "UNDECIDED", origin: "HUMAN", sourceRefs: [], decisionIds: [], ownerId: null, confirmation: null, verificationMethod: null };
    }
    for (let index = 0; index < 400; index += 1) {
      const id = randomUUID(); linkIds.push(id);
      large.document.traceLinks[id] = { id, version: 1, requirementId: requirementIds[index % 150]!, nodeId: nodeIds[Math.floor(index / 150)]!, explanation: "x".repeat(4_000), reviewedRequirementBehaviourVersion: null, reviewedNodeBehaviourVersion: null, reviewedBy: null, reviewedAt: null };
    }
    parseDraftPair(large.document, large.layout);
    const { rows: [fixtureSize] } = await database.query<{ bytes: number }>("select octet_length($1::jsonb::text)::int bytes", [large.document]);
    assert.ok(fixtureSize!.bytes > 1_048_576 && fixtureSize!.bytes <= 2_097_152);
    await database.query("begin");
    try {
      await database.query("update app.scope_draft set document_json = $2, layout_json = $3 where id = $1", [large.id, large.document, large.layout]);
      await database.query("update app.project set requirement_display_sequence = 150 where id = $1", [p]);
      await database.query("commit");
    } catch (error) { await database.query("rollback"); throw error; }
    const largeProposal = { schemaVersion: 1, kind: "proposal" as const, operations: [
      { id: "remove", dependsOn: [], edit: { command: "DELETE_NODES" as const, payload: { flowId, nodeIds, removeEdgeIds: [] } } },
    ], assumptions: [], citations: [] };
    const largeRun = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: largeProposal, selection: { flowId, nodeIds } });
    const largeView = await readRun(owner.identity, p, largeRun);
    await assert.rejects(database.query(`INSERT INTO app.ai_suggestion_application
      (id, project_id, run_id, draft_id, actor_id, prompt_source_version_id, result_hash,
       selected_operations, actual_operations, id_map, created_id_map, evidence, source_version_ids,
       before_document_revision, after_document_revision, before_layout_revision, after_layout_revision)
      SELECT $2, project_id, id, draft_id, $3, prompt_source_version_id, result_hash,
       '[{}]'::jsonb, '[{}]'::jsonb, '{}'::jsonb, '{}'::jsonb, jsonb_build_object('padding', repeat('x', $4)), ARRAY[prompt_source_version_id],
       expected_document_revision, expected_document_revision, 1, 1
      FROM app.ai_run WHERE id = $1`, [largeRun, randomUUID(), owner.profile, AI_LIMITS.applicationEvidenceBytes]),
    { code: "23514", constraint: "ai_application_bounds" });
    await applyRun(owner.identity, p, largeRun, { key: randomUUID(), draftId: largeView.draftId, expectedDocumentRevision: largeView.documentRevision, expectedParentSnapshotId: largeView.parentSnapshotId, resultHash: largeView.resultHash!, selectedOperationIds: ["remove"] });
    const retainedLarge = await readRun(owner.identity, p, largeRun);
    const retainedLinks = retainedLarge.application!.evidence.before.filter((record) => "explanation" in record);
    assert.equal(retainedLinks.length, 400); assert.deepEqual(new Set(retainedLinks.map((record) => record.id)), new Set(linkIds));
    assert.deepEqual(Object.fromEntries(retainedLinks.map((record) => [record.id, record])), large.document.traceLinks);
    const { rows: [evidenceSize] } = await database.query<{ bytes: number }>("select octet_length(evidence::text)::int bytes from app.ai_suggestion_application where run_id = $1", [largeRun]);
    assert.ok(evidenceSize!.bytes > 1_048_576);
    await database.query("alter table app.ai_run disable trigger enforce_ai_run");
    try { await database.query("update app.ai_run set terminal_at = now() - interval '8 days' where id = $1", [largeRun]); }
    finally { await database.query("alter table app.ai_run enable trigger enforce_ai_run"); }
    await workerCleanup();
    const retainedAfterCleanup = await readRun(owner.identity, p, largeRun);
    assert.equal(retainedAfterCleanup.capture, null); assert.equal(retainedAfterCleanup.result, null);
    assert.deepEqual(retainedAfterCleanup.application, retainedLarge.application);
  });
});

test("current source heads stale only Apply authority while exact historical versions and captured diff remain readable", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    const sourceId = randomUUID(), oldId = randomUUID(), newId = randomUUID();
    const text = "Original evidence";
    await database.query("begin");
    try {
      await database.query("insert into app.source_document (id, project_id, kind, current_version_id, created_by) values ($1, $2, 'USER_TEXT', $3, $4)", [sourceId, p, oldId, owner.profile]);
      for (const [id, n, title, value] of [[oldId, 1, "Original title", text], [newId, 2, "New title", "New evidence"]] as const) await database.query("insert into app.source_version (id, project_id, source_id, sequence, title, text, code_point_count, utf8_byte_count, content_hash, created_by) values ($1, $2, $3, $4, $5, $6, char_length($6), octet_length($6), $7, $8)", [id, p, sourceId, n, title, value, sha256(value), owner.profile]);
      await database.query("commit");
    } catch (error) { await database.query("rollback"); throw error; }
    const source = { projectId: p, sourceId, sourceVersionId: oldId, currentVersionId: oldId, title: "Original title", text, contentHash: sha256(text) };
    const runs = [];
    for (let i = 0; i < 10; i++) runs.push(await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: generatedProposal, sources: [source] }));
    const before = await readRun(owner.identity, p, runs[0]!);
    await database.query("update app.source_document set current_version_id = $2 where id = $1", [sourceId, newId]);
    const view = await readRun(owner.identity, p, runs[0]!);
    assert.equal(view.applicability, "STALE"); assert.deepEqual(view.applicabilityReasons, ["SOURCE_HEAD_CHANGED"]);
    assert.deepEqual(view.capture, before.capture); assert.deepEqual(view.diff, before.diff);
    assert.equal((await readSourceVersion(owner.identity, p, oldId)).title, "Original title");
    assert.equal((await readSourceVersion(owner.identity, p, oldId)).text, text);
    assert.equal((await admitted(database, owner.identity, p)).state, "QUEUED");
  });
});

test("guarded baseline-only change stales captured proposals and frees applicable capacity with unchanged draft revisions", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner); const other = await projectFor(owner);
    const target = new URL(process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL!);
    assert.equal(target.hostname, "127.0.0.1");
    assert.equal((await database.query("select environment_id::text id from app.environment_identity where id = 1")).rows[0].id, process.env.SCOPEROOM_ENVIRONMENT_ID);
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result: generatedProposal }));
    const before = await readRun(owner.identity, p, ids[0]!);
    try {
      const baseline = await seedSnapshot(database, p);
      await assert.rejects(database.query("update app.project set approved_snapshot_id = $2 where id = $1", [other, baseline]), { code: "23503", constraint: "project_approved_snapshot_fkey" });
      await database.query("update app.project set approved_snapshot_id = $2 where id = $1", [p, baseline]);
      const view = await readRun(owner.identity, p, ids[0]!);
      assert.equal(view.applicability, "STALE"); assert.deepEqual(view.applicabilityReasons, ["BASELINE_CHANGED"]);
      assert.deepEqual(view.diff, before.diff); assert.equal(view.documentRevision, before.documentRevision);
      assert.equal(await readAsMember(owner.identity, p, (tx, project) => applicableCapacityFull(tx, project)), false);
    } finally {
      await database.query("update app.project set approved_snapshot_id = null where id = $1", [p]);
      assert.ok((await database.query("select 1 from pg_constraint where conrelid='app.project'::regclass and conname='project_approved_snapshot_fkey'")).rowCount);
    }
  });
});

test("bounded quota pages skip malformed historical proposals and still find ten later valid proposals", { skip: !canRun }, async () => {
  await withAi(async ({ person, projectFor, database }) => {
    const owner = await person(); const p = await projectFor(owner);
    for (let i = 1; i <= 11; i++) await seedRun(database, { id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, projectId: p, owner: owner.profile, shape: "SUCCEEDED", uncounted: true, result: { schemaVersion: 1, kind: "proposal", operations: [], assumptions: [], citations: [] } });
    for (let i = 1; i <= 10; i++) await seedRun(database, { id: `ffffffff-ffff-4fff-8fff-${String(i).padStart(12, "0")}`, projectId: p, owner: owner.profile, shape: "SUCCEEDED", uncounted: true, result: generatedProposal });
    await assert.rejects(admitted(database, owner.identity, p), { code: "LIMIT_EXCEEDED", details: { limit: "APPLICABLE_PROPOSALS" } });
    await database.query("update app.ai_run set disposition = 'DISCARDED' where id = 'ffffffff-ffff-4fff-8fff-000000000010'");
    assert.equal((await admitted(database, owner.identity, p)).state, "QUEUED");
  });
});

test("hash-consistent malformed legacy captures cannot gain direct Apply authority", { skip: !canRun }, async () => {
  for (const shape of ["widened-limit", "malformed-sources"] as const) {
    await withAi(async ({ person, projectFor, database }) => {
      const owner = await person(); const p = await projectFor(owner);
      const result = shape === "widened-limit" ? { ...generatedProposal, operations: [generatedProposal.operations[0],
        ...Array.from({ length: 21 }, (_, i) => ({ id: `node${i}`, dependsOn: ["flow"], edit: { command: "ADD_NODE", payload: { ref: `node${i}`, flowId: "flow", kind: "ACTION", label: "Step", description: "", actorLabel: "" } } }))] } : generatedProposal;
      const run = await seedRun(database, { projectId: p, owner: owner.profile, shape: "SUCCEEDED", result });
      const original = (await database.query("select capture from app.ai_run where id = $1", [run])).rows[0].capture;
      const capture = shape === "widened-limit" ? { ...original, limits: { ...original.limits, maxGraphNodes: 21 } } : { ...original, sources: { length: 0 } };
      // Historical corruption fixture only. LOCAL replica mode resets at transaction end without disabling any trigger.
      await database.query("begin");
      try {
        await database.query("set local session_replication_role = replica");
        await database.query("update app.ai_run set capture = $2::jsonb, capture_hash = $3 where id = $1", [run, JSON.stringify(capture), sha256(canonicalJson(capture))]);
        await database.query("commit");
      } catch (error) { await database.query("rollback"); throw error; }
      const view = await readRun(owner.identity, p, run);
      assert.equal(view.applicability, "UNAVAILABLE"); assert.deepEqual(view.applicabilityReasons, ["INVALID_CAPTURE"]);
      assert.equal(view.capture, null); assert.equal(view.result, null); assert.equal(view.diff, null);
      const state = async () => (await database.query(`select d.document_json, d.layout_json, d.document_revision, d.layout_revision,
        p.event_sequence::text, p.ai_revision::text, row_to_json(r) run,
        (select count(*)::int from app.ai_suggestion_application where project_id = p.id) applications,
        (select count(*)::int from app.ai_application_source where project_id = p.id) application_sources,
        (select count(*)::int from app.source_version where project_id = p.id) sources,
        (select count(*)::int from app.mutation_receipt where scope_id = p.id) receipts,
        (select count(*)::int from app.audit_event where project_id = p.id) audits
        from app.project p join app.scope_draft d on d.id = p.current_draft_id join app.ai_run r on r.project_id = p.id where p.id = $1 and r.id = $2`, [p, run])).rows[0];
      const before = await state();
      await assert.rejects(applyRun(owner.identity, p, run, { key: randomUUID(), draftId: view.draftId, expectedDocumentRevision: view.documentRevision,
        expectedParentSnapshotId: null, resultHash: view.resultHash!, selectedOperationIds: result.operations.map(operation => operation!.id) }), { code: "AI_RESULT_UNAVAILABLE" });
      assert.deepEqual(await state(), before, shape);
    });
  }
});
