import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Client } from "pg";
import { getProjectBootstrap } from "../../src/features/projects/server/projects.ts";
import { cleanupTransient } from "../../src/server/maintenance/cleanup-transient.ts";
import { discardFlowImport, getFlowImport } from "../../src/features/exchange/server/import-flow.ts";
import { canRun, withFixture } from "./support/fixture.ts";
import { serializeSweeps } from "./support/sweep-lock.ts";

serializeSweeps(); // these tests sweep, or seed rows a sweep would take: see sweep-lock.ts

test("discard refreshes a preview that cleanup expires while the transaction waits", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, profileId, database }) => {
    const owner = await user(); const projectId = await project(owner); const actorId = await profileId(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const previewId = randomUUID(); const key = randomUUID();
    const actorGate = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL });
    const cleaner = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL });
    await actorGate.connect(); await cleaner.connect();
    const blockedBy = async (pid: number) => {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const { rows: [blocked] } = await database.query<{ xact_start: Date }>("select xact_start from pg_stat_activity where $1=any(pg_blocking_pids(pid)) and state='active'", [pid]);
        if (blocked) return blocked.xact_start;
        await setImmediate();
      }
      throw new Error("Discard did not reach the expected database lock.");
    };
    let discard: ReturnType<typeof discardFlowImport> | undefined;
    try {
      const actorPid = (await actorGate.query("select pg_backend_pid() pid")).rows[0].pid;
      const cleanerPid = (await cleaner.query("select pg_backend_pid() pid")).rows[0].pid;
      await actorGate.query("begin");
      await actorGate.query("select id from app.user_profile where id=$1 for no key update", [actorId]);
      discard = discardFlowImport(owner, projectId, previewId, key);
      void discard.catch(() => undefined);
      const startedAt = await blockedBy(actorPid);
      // Install a valid aged fixture after the discard transaction starts, placing expiry strictly after its clock.
      const file = { format: "scoperoom-flow", formatVersion: 1, exportedAt: "2026-10-01T00:00:00Z", producerVersion: "1.6",
        flow: { title: "Expiring preview", purpose: "", classification: "USER_JOURNEY", direction: "TB" }, nodes: [], edges: [], origin: { kind: "DRAFT", documentRevision: 1, layoutRevision: 1 } };
      await database.query(`insert into app.flow_import_preview (id,project_id,draft_id,actor_id,expected_document_revision,payload,positions,fidelity_report,preview_hash,payload_hash,created_at,expires_at)
        values ($1,$2,$3,$4,1,$5,'[]','{"nodeCount":0,"edgeCount":0,"omittedLinkHintCount":0,"geometry":"SUPPLIED"}',repeat('a',64),repeat('a',64),now()-interval '24 hours',greatest(clock_timestamp(),$6::timestamptz+interval '1 millisecond'))`, [previewId, projectId, draftId, actorId, file, startedAt]);
      const expiryDeadline = Date.now() + 4_000;
      while (!(await database.query<{ expired: boolean }>("select clock_timestamp() >= expires_at expired from app.flow_import_preview where id=$1", [previewId])).rows[0].expired) {
        assert.ok(Date.now() < expiryDeadline, "The preview must expire before cleanup starts.");
        await setImmediate();
      }
      await cleaner.query("begin");
      await cleaner.query("select id from app.flow_import_preview where id=$1 for update", [previewId]);
      await actorGate.query("commit");
      await blockedBy(cleanerPid);
      // The unfixed service blocks at UPDATE after reading READY; the corrected service blocks at its locking read.
      await cleaner.query("select * from app.cleanup_transient(false,100)");
      const expired = (await cleaner.query("select state,payload from app.flow_import_preview where id=$1", [previewId])).rows[0];
      assert.equal(expired.state, "EXPIRED"); assert.equal(expired.payload, null);
      await cleaner.query("commit");
      const result = await discard;
      assert.equal(result.state, "EXPIRED"); assert.equal(result.file, null);
      assert.deepEqual(await discardFlowImport(owner, projectId, previewId, key), result);
      assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where scope_id=$1 and key=$2", [projectId, key])).rows[0].count, 0);
    } finally {
      await actorGate.query("rollback"); await cleaner.query("rollback");
      await discard?.catch(() => undefined);
      await actorGate.end(); await cleaner.end();
    }
  });
});

test("transient cleanup dry-runs without mutation and sweeps expired previews in bounded batches", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, profileId, database }) => {
    const owner = await user("Cleanup owner");
    const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const actorId = await profileId(owner);
    for (let index = 0; index < 101; index += 1) {
      await database.query(
        `insert into app.flow_import_preview (id, project_id, draft_id, actor_id, expected_document_revision, payload, positions, fidelity_report, preview_hash,payload_hash, expires_at, created_at)
         values ($1, $2, $3, $4, 1, '{"format":"scoperoom-flow"}'::jsonb, '[]'::jsonb, '{"nodeCount":0,"edgeCount":0,"omittedLinkHintCount":0,"geometry":"SUPPLIED"}'::jsonb, repeat('a', 64),repeat('a', 64), now() - interval '1 second', now() - interval '2 days')`,
        [randomUUID(), projectId, draftId, actorId],
      );
      await database.query(`insert into app.flow_import_preview (id,project_id,draft_id,actor_id,expected_document_revision,state,payload,positions,fidelity_report,preview_hash,payload_hash,expires_at)
        values (gen_random_uuid(),$1,$2,$3,1,'DISCARDED','{}','[]','{}',repeat('a',64),repeat('a',64),now()+interval '24 hours')`, [projectId, draftId, actorId]);
      await database.query(`insert into app.mutation_receipt (id,actor_id,scope_kind,scope_id,key,operation,request_hash,result,created_at,expires_at)
        values (gen_random_uuid(),$1,'PROJECT',$2,$3,'TEST',repeat('a',64),'{}',now()-interval '30 days',now()-interval '1 second')`, [actorId, projectId, randomUUID()]);
    }
    const web = new Client({ connectionString: process.env.DATABASE_URL });
    await web.connect();
    try {
      await assert.rejects(web.query("update app.flow_import_preview set payload = null where project_id = $1", [projectId]), /permission denied/i);
    } finally {
      await web.end();
    }
    assert.ok((await cleanupTransient({ dryRun: true, batchSize: 100 })).expiredPreviews <= 100);
    let count = await database.query<{ count: number }>("select count(*)::int as count from app.flow_import_preview where project_id = $1 and state = 'READY'", [projectId]);
    assert.equal(count.rows[0]!.count, 101, "dry-run leaves retained bodies and state unchanged");
    for (let sweep = 0; sweep < 20; sweep += 1) {
      const result = await cleanupTransient({ dryRun: false, batchSize: 100 });
      assert.ok(result.expiredPreviews <= 100 && result.clearedAppliedBodies <= 100 && result.deletedReceipts <= 100);
      if (!(await database.query("select 1 from app.flow_import_preview where project_id=$1 and (state='READY' or (state='DISCARDED' and payload is not null)) limit 1", [projectId])).rowCount
        && !(await database.query("select 1 from app.mutation_receipt where actor_id=$1 and expires_at<=now() limit 1", [actorId])).rowCount) break;
    }
    count = await database.query<{ count: number }>("select count(*)::int as count from app.flow_import_preview where project_id = $1 and state = 'EXPIRED' and payload is null", [projectId]);
    assert.equal(count.rows[0]!.count, 101);
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where project_id=$1 and state='DISCARDED' and payload is null", [projectId])).rows[0].count, 101);
    assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where actor_id=$1 and expires_at<=now()", [actorId])).rows[0].count, 0);
  });
});

test("DB-clock retention boundaries preserve applied identity and serialize with a locked row", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, profileId, database }) => {
    const owner = await user(); const projectId = await project(owner); const actorId = await profileId(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const ids = Object.fromEntries(["expired", "ready", "discarded", "appliedOld", "appliedNew", "alreadyExpired"].map((name) => [name, randomUUID()]));
    const flowId = randomUUID(); const mapping = { flowId, nodes: {}, edges: {} };
    await database.query("begin");
    try {
      for (const [name, id] of Object.entries(ids)) {
        const state = name.startsWith("applied") ? "APPLIED" : name === "discarded" ? "DISCARDED" : name === "alreadyExpired" ? "EXPIRED" : "READY";
        const result = { previewId: id, draftId, flowId, documentRevision: 2, layoutRevision: 3, eventSequence: 4 };
        await database.query(`insert into app.flow_import_preview (id, project_id, draft_id, actor_id, expected_document_revision, state, payload, positions, fidelity_report, preview_hash,payload_hash, created_at, expires_at, applied_at, result_flow_id, applied_mapping, applied_result)
          values ($1,$2,$3,$4,1,$5::text::app.flow_import_state,'{}','[]','{}',repeat('a',64),repeat('a',64),now()-interval '24 hours',
          case when $6 in ('expired','alreadyExpired') then now() else now()+interval '1 hour' end,
          case when $5='APPLIED' then now()-interval '7 days'+case when $6='appliedNew' then interval '1 second' else interval '0 seconds' end end,
          $7,$8,$9)`, [id, projectId, draftId, actorId, state, name, state === "APPLIED" ? flowId : null, state === "APPLIED" ? mapping : null, state === "APPLIED" ? result : null]);
      }
      for (const [expired, key] of [[true, "old-retention-key"], [false, "fresh-retention-key"]] as const) await database.query(`insert into app.mutation_receipt (id,actor_id,scope_kind,scope_id,key,operation,request_hash,result,created_at,expires_at)
        values (gen_random_uuid(),$1,'PROJECT',$2,$3,'TEST',repeat('a',64),'{}',now()-interval '30 days',now()+case when $4 then interval '0 seconds' else interval '1 second' end)`, [actorId, projectId, key, expired]);
      const snapshot = (await database.query("select * from app.flow_import_preview where project_id=$1 order by id", [projectId])).rows;
      await database.query("select * from app.cleanup_transient(true,100)");
      assert.deepEqual((await database.query("select * from app.flow_import_preview where project_id=$1 order by id", [projectId])).rows, snapshot);
      await database.query("select * from app.cleanup_transient(false,100)");
      const retained = (await database.query("select * from app.flow_import_preview where project_id=$1", [projectId])).rows;
      for (const name of ["expired", "discarded", "appliedOld", "alreadyExpired"]) assert.equal(retained.find((p) => p.id === ids[name]).payload, null, name);
      assert.notEqual(retained.find((p) => p.id === ids.ready).payload, null);
      assert.notEqual(retained.find((p) => p.id === ids.appliedNew).payload, null);
      const old = retained.find((p) => p.id === ids.appliedOld);
      assert.equal(old.state, "APPLIED"); assert.equal(old.actor_id, actorId); assert.equal(old.project_id, projectId); assert.equal(old.draft_id, draftId); assert.equal(old.result_flow_id, flowId); assert.deepEqual(old.applied_mapping, mapping);
      assert.deepEqual((await database.query("select key from app.mutation_receipt where actor_id=$1 and key in ('old-retention-key','fresh-retention-key')", [actorId])).rows, [{ key: "fresh-retention-key" }]);
      await database.query("commit");
    } catch (error) { await database.query("rollback"); throw error; }
    assert.equal((await getFlowImport(owner, projectId, ids.expired!)).state, "EXPIRED");
    assert.equal((await getFlowImport(owner, projectId, ids.appliedOld!)).result?.flowId, flowId);
    // A competing transition owns a row lock; SKIP LOCKED must neither wait nor erase it.
    const lockedId = randomUUID();
    await database.query(`insert into app.flow_import_preview (id,project_id,draft_id,actor_id,expected_document_revision,payload,positions,fidelity_report,preview_hash,payload_hash,created_at,expires_at)
      values ($1,$2,$3,$4,1,'{}','[]','{}',repeat('a',64),repeat('a',64),now()-interval '24 hours',now()-interval '1 second')`, [lockedId, projectId, draftId, actorId]);
    assert.equal((await getFlowImport(owner, projectId, lockedId)).state, "EXPIRED", "expiry is virtual before cleanup");
    await assert.rejects(database.query("update app.flow_import_preview set state='APPLIED',applied_at=now(),result_flow_id=$2,applied_mapping=$3,applied_result=$4 where id=$1", [lockedId, flowId, mapping, { previewId: lockedId, draftId, flowId, documentRevision: 2, layoutRevision: 3, eventSequence: 4 }]), /flow import expired/i);
    await database.query("begin");
    try {
      await database.query("select id from app.flow_import_preview where id=$1 for update", [lockedId]);
      const result = await cleanupTransient({ dryRun: false, batchSize: 100 });
      assert.ok(result.clearedAppliedBodies <= 100);
      assert.notEqual((await database.query("select payload from app.flow_import_preview where id=$1", [lockedId])).rows[0].payload, null);
    } finally { await database.query("rollback"); }
    await cleanupTransient({ dryRun: false, batchSize: 100 });
    assert.equal((await database.query("select payload from app.flow_import_preview where id=$1", [lockedId])).rows[0].payload, null);
  });
});

test("cleanup refuses a mismatched environment before any mutation", { skip: !canRun }, async () => {
  const expected = process.env.SCOPEROOM_ENVIRONMENT_ID;
  try {
    process.env.SCOPEROOM_ENVIRONMENT_ID = randomUUID();
    await assert.rejects(cleanupTransient({ dryRun: false, batchSize: 100 }), /environment identity/i);
  } finally { process.env.SCOPEROOM_ENVIRONMENT_ID = expected; }
});
