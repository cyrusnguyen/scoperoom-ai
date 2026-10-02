import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Client } from "pg";
import { FLOW_IMPORT_PREVIEW_LIMITS } from "../../src/features/exchange/contracts/import.ts";
import { previewFlowImport } from "../../src/features/exchange/server/import-flow.ts";
import { getProjectBootstrap } from "../../src/features/projects/server/projects.ts";
import { cleanupTransient } from "../../src/server/maintenance/cleanup-transient.ts";
import { canRun, withFixture } from "./support/fixture.ts";

const validFile = () => readFile(new URL("../fixtures/flow-files/valid.scoperoom-flow.json", import.meta.url));
const report = JSON.stringify({ nodeCount: 0, edgeCount: 0, omittedLinkHintCount: 0, geometry: "SUPPLIED" });

async function seed(database: Client, projectId: string, draftId: string, actorId: string, count: number, options: { state?: "READY" | "DISCARDED" | "EXPIRED"; body?: string; createdAt?: Date } = {}) {
  const createdAt = options.createdAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000);
  const state = options.state ?? "EXPIRED";
  await database.query(`insert into app.flow_import_preview (id,project_id,draft_id,actor_id,expected_document_revision,state,payload,positions,fidelity_report,preview_hash,payload_hash,created_at,expires_at)
    select gen_random_uuid(),$1,$2,$3,1,$4::text::app.flow_import_state,
      case when $5::text is null then null else $5::jsonb end,
      case when $5::text is null then null else '[]'::jsonb end,
      case when $5::text is null then null else $6::jsonb end,
      repeat('a',64),repeat('a',64),$7::timestamptz,$8::timestamptz
    from generate_series(1,$9)`, [projectId, draftId, actorId, state, options.body ?? null, report, createdAt, new Date(createdAt.getTime() + 24 * 60 * 60 * 1000), count]);
}

async function rejectWithoutEffects(database: Client, call: Promise<unknown>, projectId: string, id: string, key: string) {
  await assert.rejects(call, { code: "LIMIT_EXCEEDED" });
  assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where id=$1", [id])).rows[0].count, 0);
  assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where scope_id=$1 and key=$2", [projectId, key])).rows[0].count, 0);
}

async function blockedTransactionStart(database: Client, blockerPid: number) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const { rows: [blocked] } = await database.query<{ xact_start: string }>("select xact_start::text from pg_stat_activity where $1=any(pg_blocking_pids(pid)) and state='active'", [blockerPid]);
    if (blocked) return blocked.xact_start;
    await setImmediate();
  }
  throw new Error("Preview creation did not reach the actor lock.");
}

async function seedAtHourBoundary(database: Client, projectId: string, draftId: string, actorId: string, count: number, transactionStart: string) {
  await database.query(`insert into app.flow_import_preview (id,project_id,draft_id,actor_id,expected_document_revision,state,preview_hash,payload_hash,created_at,expires_at)
    select gen_random_uuid(),$1,$2,$3,1,'EXPIRED',repeat('a',64),repeat('a',64),$4::timestamptz-interval '1 hour',$4::timestamptz+interval '23 hours' from generate_series(1,$5)`, [projectId, draftId, actorId, transactionStart, count]);
}

async function seedBodyBytes(database: Client, projectId: string, draftId: string, actorId: string, count: number, total: number) {
  const { rows: [sizes] } = await database.query<{ report: number; positions: number }>("select octet_length($1::jsonb::text)::int report,octet_length('[]'::jsonb::text)::int positions", [report]);
  const characters = total - count * (sizes!.report + sizes!.positions + 2);
  assert.ok(characters >= count, "the requested JSONB body budget must fit every row");
  const base = Math.floor(characters / count); const remainder = characters % count;
  for (let index = 0; index < count; index += 1) await seed(database, projectId, draftId, actorId, 1, { state: "READY", body: JSON.stringify("x".repeat(base + (index < remainder ? 1 : 0))), createdAt: new Date() });
}

async function retainedBodyBytes(database: Client, where: string, values: string[]) {
  return (await database.query<{ bytes: number }>(`select coalesce(sum(octet_length(payload::text)+octet_length(positions::text)+octet_length(fidelity_report::text)),0)::int bytes from app.flow_import_preview where payload is not null and ${where}`, values)).rows[0]!.bytes;
}

test("project identity quota counts all actors and terminal states", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user(); const editor = await user(); const requester = await user();
    const projectId = await project(owner); await join(owner, projectId, editor); await join(owner, projectId, requester);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    await seed(database, projectId, draftId, await profileId(owner), 1_000, { state: "EXPIRED" });
    await seed(database, projectId, draftId, await profileId(editor), 1_000, { state: "DISCARDED" });
    const id = randomUUID(); const key = randomUUID();
    await rejectWithoutEffects(database, previewFlowImport(requester, projectId, draftId, id, key, await validFile()), projectId, id, key);
  });
});

test("body-count and byte quotas apply separately to actor and project", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user(); const editor = await user(); const member = await user(); const requester = await user();
    const projectId = await project(owner); await join(owner, projectId, editor); await join(owner, projectId, member); await join(owner, projectId, requester);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id; const bytes = await validFile();
    const smallBody = JSON.stringify({ retained: true });
    await seed(database, projectId, draftId, await profileId(owner), FLOW_IMPORT_PREVIEW_LIMITS.actor.bodies, { state: "READY", body: smallBody, createdAt: new Date() });
    let id = randomUUID(); let key = randomUUID();
    await rejectWithoutEffects(database, previewFlowImport(owner, projectId, draftId, id, key, bytes), projectId, id, key);
    await seed(database, projectId, draftId, await profileId(editor), 10, { state: "READY", body: smallBody, createdAt: new Date() });
    await seed(database, projectId, draftId, await profileId(member), 5, { state: "READY", body: smallBody, createdAt: new Date() });
    id = randomUUID(); key = randomUUID();
    await rejectWithoutEffects(database, previewFlowImport(requester, projectId, draftId, id, key, bytes), projectId, id, key);
  });

  await withFixture(async ({ user, project, join, profileId, database }) => {
    const measuredOwner = await user(); const measuredProjectId = await project(measuredOwner);
    const measuredDraftId = (await getProjectBootstrap(measuredOwner, measuredProjectId)).draft.id;
    const measured = await previewFlowImport(measuredOwner, measuredProjectId, measuredDraftId, randomUUID(), randomUUID(), await validFile());
    const candidateBytes = await retainedBodyBytes(database, "id=$1", [measured.id]);
    const owner = await user(); const editor = await user(); const requester = await user();
    const actorProjectId = await project(owner); const actorDraftId = (await getProjectBootstrap(owner, actorProjectId)).draft.id;
    await seedBodyBytes(database, actorProjectId, actorDraftId, await profileId(owner), 8, FLOW_IMPORT_PREVIEW_LIMITS.actor.bodyBytes - candidateBytes);
    assert.equal(await retainedBodyBytes(database, "actor_id=$1", [await profileId(owner)]), FLOW_IMPORT_PREVIEW_LIMITS.actor.bodyBytes - candidateBytes);
    await previewFlowImport(owner, actorProjectId, actorDraftId, randomUUID(), randomUUID(), await validFile());
    assert.equal(await retainedBodyBytes(database, "actor_id=$1", [await profileId(owner)]), FLOW_IMPORT_PREVIEW_LIMITS.actor.bodyBytes, "candidate bytes are counted exactly once");
    const actorOver = await user(); const actorOverProjectId = await project(actorOver); const actorOverDraftId = (await getProjectBootstrap(actorOver, actorOverProjectId)).draft.id;
    await seedBodyBytes(database, actorOverProjectId, actorOverDraftId, await profileId(actorOver), 8, FLOW_IMPORT_PREVIEW_LIMITS.actor.bodyBytes - candidateBytes + 1);
    let id = randomUUID(); let key = randomUUID();
    await rejectWithoutEffects(database, previewFlowImport(actorOver, actorOverProjectId, actorOverDraftId, id, key, await validFile()), actorOverProjectId, id, key);
    const projectId = await project(owner); await join(owner, projectId, editor); await join(owner, projectId, requester);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const projectTarget = FLOW_IMPORT_PREVIEW_LIMITS.project.bodyBytes - candidateBytes;
    await seedBodyBytes(database, projectId, draftId, await profileId(owner), 8, Math.floor(projectTarget / 2));
    await seedBodyBytes(database, projectId, draftId, await profileId(editor), 8, Math.ceil(projectTarget / 2));
    await previewFlowImport(requester, projectId, draftId, randomUUID(), randomUUID(), await validFile());
    assert.equal(await retainedBodyBytes(database, "project_id=$1", [projectId]), FLOW_IMPORT_PREVIEW_LIMITS.project.bodyBytes);
    const projectOverId = await project(owner); const projectOverDraftId = (await getProjectBootstrap(owner, projectOverId)).draft.id;
    await join(owner, projectOverId, editor); await join(owner, projectOverId, requester);
    const projectOverTarget = FLOW_IMPORT_PREVIEW_LIMITS.project.bodyBytes - candidateBytes + 1;
    await seedBodyBytes(database, projectOverId, projectOverDraftId, await profileId(owner), 8, Math.floor(projectOverTarget / 2));
    await seedBodyBytes(database, projectOverId, projectOverDraftId, await profileId(editor), 8, Math.ceil(projectOverTarget / 2));
    id = randomUUID(); key = randomUUID();
    await rejectWithoutEffects(database, previewFlowImport(requester, projectOverId, projectOverDraftId, id, key, await validFile()), projectOverId, id, key);
  });
});

test("creation admission uses a strict one-hour window and project-wide history", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user(); const editor = await user(); const member = await user(); const requester = await user();
    const projectId = await project(owner); await join(owner, projectId, editor); await join(owner, projectId, member); await join(owner, projectId, requester);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id; const bytes = await validFile();
    const boundaryProjectId = await project(owner); const boundaryDraftId = (await getProjectBootstrap(owner, boundaryProjectId)).draft.id;
    const actorId = await profileId(owner); const actorGate = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL }); await actorGate.connect();
    let exactBoundary: ReturnType<typeof previewFlowImport> | undefined;
    try {
      const actorPid = (await actorGate.query("select pg_backend_pid() pid")).rows[0].pid;
      await actorGate.query("begin"); await actorGate.query("select id from app.user_profile where id=$1 for no key update", [actorId]);
      exactBoundary = previewFlowImport(owner, boundaryProjectId, boundaryDraftId, randomUUID(), randomUUID(), bytes); void exactBoundary.catch(() => undefined);
      await seedAtHourBoundary(database, boundaryProjectId, boundaryDraftId, actorId, FLOW_IMPORT_PREVIEW_LIMITS.actor.creationsPerHour, await blockedTransactionStart(database, actorPid));
      await actorGate.query("commit");
      await exactBoundary;
    } finally { await actorGate.query("rollback"); await exactBoundary?.catch(() => undefined); await actorGate.end(); }
    await seed(database, projectId, draftId, await profileId(owner), FLOW_IMPORT_PREVIEW_LIMITS.actor.creationsPerHour, { createdAt: new Date() });
    let id = randomUUID(); let key = randomUUID();
    await rejectWithoutEffects(database, previewFlowImport(owner, projectId, draftId, id, key, bytes), projectId, id, key);
    const rateProjectId = await project(owner); const rateDraftId = (await getProjectBootstrap(owner, rateProjectId)).draft.id;
    await join(owner, rateProjectId, editor); await join(owner, rateProjectId, member); await join(owner, rateProjectId, requester);
    for (const actor of [owner, editor, member]) await seed(database, rateProjectId, rateDraftId, await profileId(actor), 20, { createdAt: new Date() });
    id = randomUUID(); key = randomUUID();
    await rejectWithoutEffects(database, previewFlowImport(requester, rateProjectId, rateDraftId, id, key, bytes), rateProjectId, id, key);
  });
});

test("cleanup frees retained body capacity but never the identity quota", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, profileId, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const actorId = await profileId(owner); const bytes = await validFile(); const ids = Array.from({ length: FLOW_IMPORT_PREVIEW_LIMITS.actor.bodies }, randomUUID);
    for (const id of ids) await database.query(`insert into app.flow_import_preview (id,project_id,draft_id,actor_id,expected_document_revision,state,payload,positions,fidelity_report,preview_hash,payload_hash,created_at,expires_at)
      values ($1,$2,$3,$4,1,'DISCARDED','{}','[]',$5::jsonb,repeat('a',64),repeat('a',64),now()-interval '2 hours',now()+interval '1 day')`, [id, projectId, draftId, actorId, report]);
    const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL }); await holder.connect();
    try {
      await holder.query("begin"); await holder.query("select id from app.flow_import_preview where id=any($1::uuid[]) for update", [ids]);
      const deniedId = randomUUID(); const deniedKey = randomUUID();
      await rejectWithoutEffects(database, previewFlowImport(owner, projectId, draftId, deniedId, deniedKey, bytes), projectId, deniedId, deniedKey);
      await holder.query("commit");
    } finally { await holder.query("rollback"); await holder.end(); }
    for (let sweep = 0; sweep < 20 && (await database.query("select 1 from app.flow_import_preview where id=any($1::uuid[]) and payload is not null", [ids])).rowCount; sweep += 1) await cleanupTransient({ dryRun: false, batchSize: 100 });
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where id=any($1::uuid[])", [ids])).rows[0].count, FLOW_IMPORT_PREVIEW_LIMITS.actor.bodies);
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where id=any($1::uuid[]) and payload is not null", [ids])).rows[0].count, 0);
    await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), bytes);
  });
});

test("actor and project locks independently serialize final preview slots", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, profileId, database }) => {
    const owner = await user(); const firstProjectId = await project(owner); const secondProjectId = await project(owner);
    const firstDraftId = (await getProjectBootstrap(owner, firstProjectId)).draft.id; const secondDraftId = (await getProjectBootstrap(owner, secondProjectId)).draft.id;
    await seed(database, firstProjectId, firstDraftId, await profileId(owner), FLOW_IMPORT_PREVIEW_LIMITS.actor.rows - 1);
    const bytes = await validFile();
    const attempts = await Promise.allSettled([previewFlowImport(owner, firstProjectId, firstDraftId, randomUUID(), randomUUID(), bytes), previewFlowImport(owner, secondProjectId, secondDraftId, randomUUID(), randomUUID(), bytes)]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected" && (attempt.reason as { code?: string }).code === "LIMIT_EXCEEDED").length, 1);
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where actor_id=$1", [await profileId(owner)])).rows[0].count, FLOW_IMPORT_PREVIEW_LIMITS.actor.rows);
  });

  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user(); const editor = await user(); const third = await user(); const projectId = await project(owner);
    await join(owner, projectId, editor); await join(owner, projectId, third);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    await seed(database, projectId, draftId, await profileId(owner), 999);
    await seed(database, projectId, draftId, await profileId(editor), 999);
    await seed(database, projectId, draftId, await profileId(third), 1);
    const bytes = await validFile();
    const attempts = await Promise.allSettled([previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), bytes), previewFlowImport(editor, projectId, draftId, randomUUID(), randomUUID(), bytes)]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected" && (attempt.reason as { code?: string }).code === "LIMIT_EXCEEDED").length, 1);
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where project_id=$1", [projectId])).rows[0].count, FLOW_IMPORT_PREVIEW_LIMITS.project.rows);
  });
});
