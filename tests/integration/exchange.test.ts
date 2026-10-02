import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Client } from "pg";
import { parseDraftPair } from "../../src/features/drafts/contracts/scope-document.ts";
import { FLOW_IMPORT_PREVIEW_LIMITS } from "../../src/features/exchange/contracts/import.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { applyFlowImport, discardFlowImport, getFlowImport, previewFlowImport } from "../../src/features/exchange/server/import-flow.ts";
import { canRun, withFixture } from "./support/fixture.ts";

const validFile = () => readFile(new URL("../fixtures/flow-files/valid.scoperoom-flow.json", import.meta.url));

async function waitForLockChain(database: Client, holderPid: number, expected: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows: [row] } = await database.query<{ count: number }>(`
      with recursive chain(pid) as (
        select $1::int union select waiting.pid from pg_stat_activity waiting join chain blocker on blocker.pid=any(pg_blocking_pids(waiting.pid))
      ) select count(*)::int count from pg_stat_activity where pid in (select pid from chain) and wait_event_type='Lock'`, [holderPid]);
    if (row!.count >= expected) return;
    await setImmediate();
  }
  assert.fail("Apply callers did not reach the deterministic project-lock barrier.");
}

test("apply commits one imported pair and recovers it for every key", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await validFile());
    const first = await applyFlowImport(owner, projectId.toUpperCase(), preview.id.toUpperCase(), { key: randomUUID(), draftId: draftId.toUpperCase(), previewHash: preview.previewHash });
    const recovered = await applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash });
    assert.deepEqual(recovered, { ...first, replayed: true });
    const saved = await getProjectBootstrap(owner, projectId);
    assert.ok(saved.draft.document.flows[first.flowId]);
    for (const [sourceId, importedId] of Object.entries(first.mapping.nodes)) {
      const position = preview.positions!.find((entry) => entry.nodeId === sourceId)!;
      assert.deepEqual(saved.draft.layout.positions[importedId], { x: position.x, y: position.y, version: 1 });
    }
    assert.equal((await database.query("select count(*)::int count from app.audit_event where project_id=$1 and action='FLOW_IMPORTED'", [projectId])).rows[0].count, 1);
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where id=$1 and state='APPLIED'", [preview.id])).rows[0].count, 1);
  });
});

test("applied imports recover with a fresh key when the target draft is replaced", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await validFile());
    const applied = await applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash });
    await database.query("delete from app.mutation_receipt where scope_id=$1 and operation='FLOW_IMPORT_APPLY_V1'", [projectId]);
    const replacement = randomUUID();
    await database.query("begin");
    try {
      await database.query("update app.scope_draft set status='ARCHIVED' where id=$1", [draftId]);
      await database.query("insert into app.scope_draft (id,project_id,created_by,document_json,layout_json) select $2,project_id,created_by,document_json,layout_json from app.scope_draft where id=$1", [draftId, replacement]);
      await database.query("update app.project set current_draft_id=$2 where id=$1", [projectId, replacement]);
      await database.query("commit");
    } catch (error) { await database.query("rollback"); throw error; }
    const beforeRecovery = (await database.query("select document_json,layout_json from app.scope_draft where id=$1", [replacement])).rows[0];
    const recovered = await applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash });
    assert.deepEqual(recovered, { ...applied, replayed: true });
    assert.deepEqual((await database.query("select document_json,layout_json from app.scope_draft where id=$1", [replacement])).rows[0], beforeRecovery);
  });
});

test("concurrent Apply keys serialize on one preview without a second append", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await validFile());
    const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL }); await holder.connect();
    try {
      const holderPid = (await holder.query("select pg_backend_pid() pid")).rows[0].pid;
      await holder.query("begin"); await holder.query("select id from app.project where id=$1 for update", [projectId]);
      const attempts = [
      applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }),
      applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }),
      ];
      await waitForLockChain(database, holderPid, 2); await holder.query("commit");
      const [first, second] = await Promise.all(attempts);
    assert.deepEqual({ ...first, replayed: undefined }, { ...second, replayed: undefined });
    assert.equal([first.replayed, second.replayed].filter(Boolean).length, 1);
    assert.equal((await database.query("select count(*)::int count from app.audit_event where project_id=$1 and action='FLOW_IMPORTED'", [projectId])).rows[0].count, 1);
    assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where scope_id=$1 and operation='FLOW_IMPORT_APPLY_V1'", [projectId])).rows[0].count, 1);
    } finally { await holder.query("rollback").catch(() => undefined); await holder.end(); }
  });
});

test("concurrent retries with the same Apply key retain one receipt", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await validFile()); const key = randomUUID();
    const [first, second] = await Promise.all([
      applyFlowImport(owner, projectId, preview.id, { key, draftId, previewHash: preview.previewHash }),
      applyFlowImport(owner, projectId, preview.id, { key, draftId, previewHash: preview.previewHash }),
    ]);
    assert.deepEqual({ ...first, replayed: undefined }, { ...second, replayed: undefined });
    assert.equal([first.replayed, second.replayed].filter(Boolean).length, 1);
    assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where scope_id=$1 and key=$2", [projectId, key])).rows[0].count, 1);
  });
});

test("durable Apply recovery survives downgrade and archive but removal denies it", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user(); const editor = await user(); const projectId = await project(owner); await join(owner, projectId, editor);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(editor, projectId, draftId, randomUUID(), randomUUID(), await validFile());
    const applied = await applyFlowImport(editor, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash });
    const editorId = await profileId(editor);
    await database.query("delete from app.mutation_receipt where actor_id=$1 and operation='FLOW_IMPORT_APPLY_V1'", [editorId]);
    await database.query("update app.project_membership set role='VIEWER' where project_id=$1 and profile_id=$2", [projectId, editorId]);
    await database.query("update app.project set status='ARCHIVED' where id=$1", [projectId]);
    assert.deepEqual(await applyFlowImport(editor, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }), { ...applied, replayed: true });
    await assert.rejects(previewFlowImport(editor, projectId, draftId, randomUUID(), randomUUID(), await validFile()), { code: "FORBIDDEN" });
    await database.query("update app.project_membership set active=false,deactivated_sequence=1 where project_id=$1 and profile_id=$2", [projectId, editorId]);
    await assert.rejects(applyFlowImport(editor, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }), { code: "NOT_FOUND" });
  });
});

test("Apply rechecks capacity after preview and leaves a READY preview untouched", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await validFile());
    const base = (await getProjectBootstrap(owner, projectId)).draft;
    const flows = Object.fromEntries(Array.from({ length: 5 }, () => {
      const id = randomUUID(); return [id, { id, version: 1, behaviourVersion: 1, title: "Full", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED", confirmation: null, verificationMethod: null }];
    }));
    const full = { ...base.document, flows, nodes: {}, edges: {} }; const layout = { schemaVersion: 1, positions: {}, directions: Object.fromEntries(Object.keys(flows).map((id) => [id, "LR"])), edgeSides: {} };
    parseDraftPair(full, layout);
    await database.query("update app.scope_draft set document_json=$2,layout_json=$3 where id=$1", [draftId, full, layout]);
    const before = await database.query("select document_revision,layout_revision from app.scope_draft where id=$1", [draftId]);
    await assert.rejects(applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }), { code: "LIMIT_EXCEEDED" });
    assert.deepEqual((await database.query("select document_revision,layout_revision from app.scope_draft where id=$1", [draftId])).rows[0], before.rows[0]);
    assert.equal((await getFlowImport(owner, projectId, preview.id)).state, "READY");
    assert.equal((await database.query("select count(*)::int count from app.audit_event where project_id=$1 and action='FLOW_IMPORTED'", [projectId])).rows[0].count, 0);
  });
});

async function seedRetainedPreviews(database: Client, projectId: string, draftId: string, actorId: string, count: number, state: "DISCARDED" | "EXPIRED", createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000)) {
  await database.query(`insert into app.flow_import_preview (id,project_id,draft_id,actor_id,expected_document_revision,state,preview_hash,payload_hash,created_at,expires_at)
    select gen_random_uuid(),$1,$2,$3,1,$4::text::app.flow_import_state,repeat('a',64),repeat('a',64),$5::timestamptz,$5::timestamptz+interval '1 day' from generate_series(1,$6)`, [projectId, draftId, actorId, state, createdAt, count]);
}

test("preview UUID spelling preserves target identity and keyed recovery", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const previewId = randomUUID(); const key = randomUUID(); const bytes = await validFile();
    const preview = await previewFlowImport(owner, projectId.toUpperCase(), draftId.toUpperCase(), previewId.toUpperCase(), key, bytes);
    assert.deepEqual({ id: preview.id, projectId: preview.projectId, draftId: preview.draftId }, { id: previewId, projectId, draftId });
    assert.deepEqual(await previewFlowImport(owner, projectId, draftId, preview.id, key, bytes), preview);
    assert.deepEqual(await getFlowImport(owner, projectId.toUpperCase(), previewId.toUpperCase()), preview);
    const receipt = (await database.query("select result from app.mutation_receipt where scope_id=$1 and key=$2", [projectId, key])).rows[0].result;
    assert.equal(receipt.previewId, previewId); assert.equal(receipt.draftId, draftId);
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where project_id=$1", [projectId])).rows[0].count, 1);
  });
});

test("returned preview IDs and differently cased discard routes replay the same receipt", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user(); const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const previewId = randomUUID(); const key = randomUUID(); const bytes = await validFile();
    const preview = await previewFlowImport(owner, projectId, draftId, previewId.toUpperCase(), key, bytes);
    assert.deepEqual(await previewFlowImport(owner, projectId, draftId, preview.id, key, bytes), preview);
    const discardKey = randomUUID();
    const discarded = await discardFlowImport(owner, projectId.toUpperCase(), preview.id.toUpperCase(), discardKey);
    assert.equal(discarded.state, "DISCARDED");
    const replay = await discardFlowImport(owner, projectId, preview.id, discardKey);
    // Cleanup may clear transient bodies between responses; the retained identity and state must still replay.
    assert.deepEqual(replay, { ...discarded, ...(replay.file === null ? { file: null, positions: null, fidelityReport: null } : {}) });
  });
});

test("terminal discards do not retain fresh receipts", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const previewKey = randomUUID(); const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), previewKey, await validFile());
    const key = randomUUID(); await discardFlowImport(owner, projectId, preview.id, key);
    const terminal = await discardFlowImport(owner, projectId, preview.id, randomUUID());
    assert.equal(terminal.state, "DISCARDED");
    assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where scope_id=$1 and operation='FLOW_IMPORT_DISCARD_V1'", [projectId])).rows[0].count, 1);
    const actorId = (await database.query<{ actor_id: string }>("select actor_id from app.flow_import_preview where id=$1", [preview.id])).rows[0]!.actor_id;
    const expiredId = randomUUID();
    await database.query(`insert into app.flow_import_preview (id,project_id,draft_id,actor_id,expected_document_revision,payload,positions,fidelity_report,preview_hash,payload_hash,created_at,expires_at)
      values ($1,$2,$3,$4,1,'{}','[]','{"nodeCount":0,"edgeCount":0,"omittedLinkHintCount":0,"geometry":"SUPPLIED"}',repeat('a',64),repeat('a',64),now()-interval '2 days',now()-interval '1 second')`, [expiredId, projectId, draftId, actorId]);
    assert.equal((await database.query("select state::text state from app.flow_import_preview where id=$1", [expiredId])).rows[0].state, "READY");
    const expiredKey = randomUUID(); assert.equal((await discardFlowImport(owner, projectId, expiredId, expiredKey)).state, "EXPIRED");
    assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where scope_id=$1 and key=$2", [projectId, expiredKey])).rows[0].count, 0);
    await assert.rejects(discardFlowImport(owner, projectId, expiredId, previewKey), { code: "KEY_REUSED" });
  });
});

test("preview admission retains terminal identities while bounding actor rows", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, profileId, database }) => {
    const owner = await user(); const projectId = await project(owner); const otherProjectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const otherDraftId = (await getProjectBootstrap(owner, otherProjectId)).draft.id;
    const actorId = await profileId(owner); const bytes = await validFile();
    const applied = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), bytes);
    const flowId = randomUUID();
    await database.query("update app.flow_import_preview set state='APPLIED',applied_at=now(),result_flow_id=$2,applied_mapping=$3,applied_result=$4 where id=$1", [applied.id, flowId, { flowId, nodes: {}, edges: {} }, { previewId: applied.id, draftId, flowId, documentRevision: 1, layoutRevision: 1, eventSequence: 1 }]);
    await seedRetainedPreviews(database, otherProjectId, otherDraftId, actorId, Math.floor((FLOW_IMPORT_PREVIEW_LIMITS.actor.rows - 1) / 2), "EXPIRED");
    await seedRetainedPreviews(database, otherProjectId, otherDraftId, actorId, Math.ceil((FLOW_IMPORT_PREVIEW_LIMITS.actor.rows - 1) / 2), "DISCARDED");
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where actor_id=$1", [actorId])).rows[0].count, FLOW_IMPORT_PREVIEW_LIMITS.actor.rows);
    assert.equal((await previewFlowImport(owner, projectId, draftId, applied.id, randomUUID(), bytes)).state, "APPLIED", "recovery precedes quota admission");
    const rejectedId = randomUUID(); const rejectedKey = randomUUID();
    await assert.rejects(previewFlowImport(owner, projectId, draftId, rejectedId, rejectedKey, bytes), { code: "LIMIT_EXCEEDED" });
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where id=$1", [rejectedId])).rows[0].count, 0);
    assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where scope_id=$1 and key=$2", [projectId, rejectedKey])).rows[0].count, 0);
  });
});

test("a preview is durable and leaves its draft and audit cursor unchanged", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user("Preview owner");
    const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const before = await getProjectStatus(owner, projectId);
    const previewId = randomUUID();
    const key = randomUUID();

    const preview = await previewFlowImport(owner, projectId, draftId, previewId, key, await validFile());

    assert.deepEqual({ id: preview.id, projectId: preview.projectId, draftId: preview.draftId, state: preview.state }, { id: previewId, projectId, draftId, state: "READY" });
    assert.ok(preview.file);
    const file = JSON.parse((await validFile()).toString());
    assert.deepEqual(preview.positions, [...file.positions].sort((a: {nodeId: string}, b: {nodeId: string}) => a.nodeId < b.nodeId ? -1 : 1));
    assert.deepEqual(preview.fidelityReport, { nodeCount: 5, edgeCount: 5, omittedLinkHintCount: 1, geometry: "SUPPLIED" });
    assert.deepEqual(preview.file.edgeSides, file.edgeSides);
    assert.equal(preview.file.flow.direction, "LR");
    const stored = (await database.query("select extract(epoch from expires_at-created_at)::int ttl from app.flow_import_preview where id=$1", [previewId])).rows[0];
    assert.equal(stored.ttl, 86400);
    assert.deepEqual(await previewFlowImport(owner, projectId, draftId, previewId, key, await validFile()), preview);
    assert.deepEqual(await getFlowImport(owner, projectId, previewId), preview);
    assert.deepEqual(await getProjectStatus(owner, projectId), before);
    const { rows: [events] } = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId]);
    assert.equal(events!.count, 1, "preview inspection does not add an audit event");
  });
});

test("omitted geometry arranges once using only file-local ids", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const file = JSON.parse((await validFile()).toString()); delete file.positions;
    const id = randomUUID(); const key = randomUUID(); const bytes = Buffer.from(JSON.stringify(file));
    const view = await previewFlowImport(owner, projectId, draftId, id, key, bytes);
    assert.equal(view.fidelityReport?.geometry, "AUTOMATIC");
    assert.deepEqual(view.positions?.map((p) => p.nodeId).sort(), file.nodes.map((n: {id: string}) => n.id).sort());
    assert.ok(view.positions?.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
    assert.deepEqual(await previewFlowImport(owner, projectId, draftId, id, key, bytes), view);
    // Seed a retained result whose historical geometry hash cannot be reconstructed from today's layout algorithm.
    const retainedId = randomUUID(); const flowId = randomUUID(); const result = { previewId: retainedId, draftId, flowId, documentRevision: 2, layoutRevision: 2, eventSequence: 2 };
    await database.query(`insert into app.flow_import_preview (id,project_id,draft_id,actor_id,format_version,expected_document_revision,state,payload_hash,preview_hash,expires_at,applied_at,result_flow_id,applied_mapping,applied_result)
      select $2,project_id,draft_id,actor_id,format_version,expected_document_revision,'APPLIED',payload_hash,repeat('b',64),now()+interval '24 hours',now()-interval '7 days',$3,$4,$5 from app.flow_import_preview where id=$1`, [id, retainedId, flowId, { flowId, nodes: {}, edges: {} }, result]);
    const recovered = await previewFlowImport(owner, projectId, draftId, retainedId, randomUUID(), bytes);
    assert.equal(recovered.previewHash, "b".repeat(64)); assert.deepEqual(recovered.result, { ...result, mapping: { flowId, nodes: {}, edges: {} } });
    assert.equal(recovered.positions, null);
  });
});

test("preview authority, collision rejection, read-authorized recovery and keys are atomic", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user(); const editor = await user(); const projectId = await project(owner);
    await join(owner, projectId, editor);
    const otherProjectId = await project(owner); const otherDraftId = (await getProjectBootstrap(owner, otherProjectId)).draft.id;
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const bytes = await validFile(); const id = randomUUID(); const key = randomUUID();
    const first = await previewFlowImport(editor, projectId, draftId, id, key, bytes);
    const permuted = JSON.parse(bytes.toString()) as Record<string, unknown>;
    const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([name, child]) => [name, reverse(child)])) : value;
    assert.deepEqual(await previewFlowImport(editor, projectId, draftId, id, key, Buffer.from(JSON.stringify(reverse(permuted)))), first);
    const before = (await database.query("select count(*)::int count from app.mutation_receipt where scope_id=$1", [projectId])).rows[0].count;
    await assert.rejects(getFlowImport(owner, projectId, id), { code: "NOT_FOUND" });
    await assert.rejects(previewFlowImport(owner, projectId, draftId, id, randomUUID(), bytes), { code: "NOT_FOUND" });
    await assert.rejects(previewFlowImport(owner, otherProjectId, otherDraftId, id, randomUUID(), bytes), { code: "NOT_FOUND" });
    await assert.rejects(previewFlowImport(owner, projectId, otherDraftId, randomUUID(), randomUUID(), bytes), { code: "NOT_FOUND" });
    await assert.rejects(previewFlowImport(owner, projectId, draftId, "n1", randomUUID(), bytes), { code: "NOT_FOUND" });
    await assert.rejects(previewFlowImport(editor, projectId, draftId, randomUUID(), key, bytes), { code: "KEY_REUSED" });
    assert.deepEqual(await previewFlowImport(editor, projectId, draftId, id, randomUUID(), bytes), first);
    await assert.rejects(discardFlowImport(editor, projectId, id, key), { code: "KEY_REUSED" });
    const changed = { ...permuted, producerVersion: "changed" };
    await assert.rejects(previewFlowImport(editor, projectId, draftId, id, key, Buffer.from(JSON.stringify(changed))), { code: "KEY_REUSED" });
    assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where scope_id=$1", [projectId])).rows[0].count, before);
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where project_id=$1", [projectId])).rows[0].count, 1);
    const discarded = await previewFlowImport(editor, projectId, draftId, randomUUID(), randomUUID(), bytes);
    const discardKey = randomUUID(); await discardFlowImport(editor, projectId, discarded.id, discardKey);
    const editorId = await profileId(editor);
    await database.query("update app.project_membership set role='VIEWER' where project_id=$1 and profile_id=$2", [projectId, editorId]);
    assert.deepEqual(await previewFlowImport(editor, projectId, draftId, id, key, bytes), first);
    await assert.rejects(previewFlowImport(editor, projectId, draftId, randomUUID(), randomUUID(), bytes), { code: "FORBIDDEN" });
    await database.query("update app.project set status='ARCHIVED' where id=$1", [projectId]);
    assert.equal((await discardFlowImport(editor, projectId, discarded.id, discardKey)).state, "DISCARDED");
    assert.deepEqual(await getFlowImport(editor, projectId, id), first);
    await assert.rejects(previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), bytes), { code: "CONFLICT" });
    await database.query("update app.project_membership set active=false, deactivated_sequence=1 where project_id=$1 and profile_id=$2", [projectId, editorId]);
    await assert.rejects(getFlowImport(editor, projectId, id), { code: "NOT_FOUND" });
    await assert.rejects(previewFlowImport(editor, projectId, draftId, id, key, bytes), { code: "NOT_FOUND" });
    await assert.rejects(discardFlowImport(editor, projectId, id, randomUUID()), { code: "NOT_FOUND" });
  });
});

test("JSONB storage caps reject formatted sizes even below compact JSON caps", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, profileId, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id; const actorId = await profileId(owner);
    for (const [column, limit] of [["payload", 1048576], ["positions", 262144], ["fidelity_report", 65536]] as const) {
      const value = JSON.stringify(Array.from({ length: Math.floor(limit / 4) + 1 }, () => ""));
      assert.ok(Buffer.byteLength(value) < limit);
      const sizes = (await database.query("select octet_length($1::jsonb::text) size", [value])).rows[0]; assert.ok(sizes.size > limit);
      await assert.rejects(database.query(`insert into app.flow_import_preview (id,project_id,draft_id,actor_id,expected_document_revision,payload,positions,fidelity_report,preview_hash,payload_hash,expires_at)
        values (gen_random_uuid(),$1,$2,$3,1,${column === "payload" ? "$4" : "'{}'"}::jsonb,${column === "positions" ? "$4" : "'[]'"}::jsonb,${column === "fidelity_report" ? "$4" : "'{}'"}::jsonb,repeat('a',64),repeat('a',64),now()+interval '24 hours')`, [projectId, draftId, actorId, value]), new RegExp(`flow_import_preview_${column === "fidelity_report" ? "report" : column}_size`));
    }
    const p = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await validFile());
    const flowId = randomUUID(); const result = { previewId: p.id, draftId, flowId, documentRevision: 1, layoutRevision: 1, eventSequence: 1 };
    for (const [mapping, applied] of [[{ flowId, nodes: {}, edges: {}, extra: "x".repeat(65536) }, result], [{ flowId, nodes: {}, edges: {} }, { ...result, extra: "x".repeat(65536) }]]) await assert.rejects(database.query("update app.flow_import_preview set state='APPLIED',applied_at=now(),result_flow_id=$2,applied_mapping=$3,applied_result=$4 where id=$1", [p.id, flowId, mapping, applied]), /check constraint/i);
    await assert.rejects(database.query("update app.flow_import_preview set state='APPLIED',applied_at=now(),result_flow_id=$2,applied_mapping=$3,applied_result='{}' where id=$1", [p.id, flowId, { flowId, nodes: {}, edges: {} }]), /result_shape/i);
    await database.query("update app.flow_import_preview set state='APPLIED',applied_at=now(),result_flow_id=$2,applied_mapping=$3,applied_result=$4 where id=$1", [p.id, flowId, { flowId, nodes: {}, edges: {} }, result]);
    await assert.rejects(database.query("update app.flow_import_preview set payload=null,positions=null,fidelity_report=null where id=$1", [p.id]), /retention boundary/i);
  });
});

test("JSONB overflow from a valid upload is a safe limit refusal with no receipt", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const file = JSON.parse((await validFile()).toString()); delete file.positions; delete file.edgeSides; delete file.linkHints;
    file.edges = []; file.nodes = Array.from({ length: 200 }, (_, index) => ({ id: `n${index}`, kind: "ACTION", label: "Step", description: "d".repeat(4000), actorLabel: null, assumptionNotes: Array.from({ length: 20 }, () => "a") }));
    let remaining = 1048575 - Buffer.byteLength(JSON.stringify(file));
    for (const node of file.nodes) for (let index = 0; index < node.assumptionNotes.length; index += 1) { const extra = Math.min(499, remaining); node.assumptionNotes[index] += "a".repeat(extra); remaining -= extra; }
    assert.equal(remaining, 0); const bytes = Buffer.from(JSON.stringify(file)); assert.equal(bytes.length, 1048575);
    assert.ok((await database.query("select octet_length($1::jsonb::text) bytes", [bytes.toString()])).rows[0].bytes > 1048576);
    const id = randomUUID(); const key = randomUUID();
    await assert.rejects(previewFlowImport(owner, projectId, draftId, id, key, bytes), { code: "LIMIT_EXCEEDED" });
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where id=$1", [id])).rows[0].count, 0);
    assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where key=$1", [key])).rows[0].count, 0);
  });
});

test("SQL locks preview inputs, terminal states and restricted privileges", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const p = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await validFile());
    for (const column of ["preview_hash=repeat('b',64)", "payload_hash=repeat('b',64)", "format_version=2", "expected_document_revision=2", "payload='{}'::jsonb", "positions='[]'::jsonb", "fidelity_report='{}'::jsonb", "draft_id=gen_random_uuid()", "actor_id=gen_random_uuid()", "project_id=gen_random_uuid()", "expires_at=expires_at+interval '1 day'"]) {
      await assert.rejects(database.query(`update app.flow_import_preview set ${column} where id=$1`, [p.id]), /immutable/i);
    }
    await assert.rejects(database.query("update app.flow_import_preview set state='EXPIRED' where id=$1", [p.id]), /not expired/i);
    await assert.rejects(database.query("update app.flow_import_preview set state='APPLIED' where id=$1", [p.id]), /check constraint/i);
    assert.equal((await discardFlowImport(owner, projectId, p.id, randomUUID())).state, "DISCARDED");
    await assert.rejects(database.query("update app.flow_import_preview set state='READY' where id=$1", [p.id]), /terminal/i);
    const web = new Client({ connectionString: process.env.DATABASE_URL }); await web.connect();
    try {
      const role = (await web.query("select current_user, r.rolsuper, r.rolbypassrls from pg_roles r where rolname=current_user")).rows[0];
      assert.deepEqual(role, { current_user: "app_web", rolsuper: false, rolbypassrls: false });
      for (const sql of ["update app.flow_import_preview set payload=null where id=$1", "delete from app.flow_import_preview where id=$1", "delete from app.mutation_receipt where scope_id=$1", "select * from app.cleanup_transient(false, 100)"]) {
        await assert.rejects(web.query(sql, sql.includes("$1") ? [p.id] : []), /permission denied/i);
      }
    } finally { await web.end(); }
    const receiptsBefore = (await database.query("select count(*)::int count from app.mutation_receipt where scope_id=$1", [projectId])).rows[0].count;
    const replacement = randomUUID();
    await database.query("begin");
    try {
      await database.query("update app.scope_draft set status='ARCHIVED' where id=$1", [draftId]);
      await database.query("insert into app.scope_draft (id,project_id,created_by,document_json,layout_json) select $2,project_id,created_by,document_json,layout_json from app.scope_draft where id=$1", [draftId, replacement]);
      await database.query("update app.project set current_draft_id=$2 where id=$1", [projectId, replacement]);
      await database.query("commit");
    } catch (error) { await database.query("rollback"); throw error; }
    await assert.rejects(previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await validFile()), { code: "DRAFT_REPLACED" });
    assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where project_id=$1", [projectId])).rows[0].count, 1);
    assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where scope_id=$1", [projectId])).rows[0].count, receiptsBefore);
  });
});

test("applied previews retain recovery metadata after bodies and receipts are cleared", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user(); const editor = await user(); const projectId = await project(owner); await join(owner, projectId, editor);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const key = randomUUID(); const bytes = await validFile(); const preview = await previewFlowImport(editor, projectId, draftId, randomUUID(), key, bytes);
    const flowId = randomUUID(); const mapping = { flowId, nodes: { n1: randomUUID() }, edges: {} };
    const result = { previewId: preview.id, draftId, flowId, documentRevision: 2, layoutRevision: 2, eventSequence: 2 };
    await database.query("update app.flow_import_preview set state='APPLIED', applied_at=now()-interval '7 days', result_flow_id=$2, applied_mapping=$3, applied_result=$4, payload=null, positions=null, fidelity_report=null where id=$1", [preview.id, flowId, mapping, result]);
    const editorId = await profileId(editor);
    await database.query("delete from app.mutation_receipt where actor_id=$1", [editorId]);
    await database.query("update app.project_membership set role='VIEWER' where project_id=$1 and profile_id=$2", [projectId, editorId]);
    await database.query("update app.project set status='ARCHIVED' where id=$1", [projectId]);
    assert.deepEqual((await getFlowImport(editor, projectId, preview.id)).result, { ...result, mapping });
    assert.deepEqual((await discardFlowImport(editor, projectId, preview.id, randomUUID())).result, { ...result, mapping });
    assert.deepEqual((await previewFlowImport(editor, projectId, draftId, preview.id, key, bytes)).result, { ...result, mapping });
    const changed = JSON.parse(bytes.toString()); changed.producerVersion = "changed-after-cleanup";
    await assert.rejects(previewFlowImport(editor, projectId, draftId, preview.id, key, Buffer.from(JSON.stringify(changed))), { code: "KEY_REUSED" });
    assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where actor_id=$1", [editorId])).rows[0].count, 0);
    for (const change of ["applied_mapping='{}'::jsonb", "applied_result='{}'::jsonb", "applied_at=now()", "result_flow_id=gen_random_uuid()", "state='DISCARDED'"]) await assert.rejects(database.query(`update app.flow_import_preview set ${change} where id=$1`, [preview.id]), /immutable/i);
    await database.query("update app.project_membership set active=false, deactivated_sequence=1 where project_id=$1 and profile_id=$2", [projectId, editorId]);
    await assert.rejects(discardFlowImport(editor, projectId, preview.id, randomUUID()), { code: "NOT_FOUND" });
  });
});

test("new previews refuse exhausted draft capacity without a receipt", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const base = (await getProjectBootstrap(owner, projectId)).draft;
    for (const [flowCount, nodeCount, edgeCount] of [[5,0,0], [1,200,0], [1,2,400]]) {
      const flows = Object.fromEntries(Array.from({ length: flowCount }, () => { const id = randomUUID(); return [id, { id, version: 1, behaviourVersion: 1, title: "Full", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED", confirmation: null, verificationMethod: null }]; }));
      const flowId = Object.keys(flows)[0]!;
      const nodes = Object.fromEntries(Array.from({ length: nodeCount }, () => { const id = randomUUID(); return [id, { id, flowId, version: 1, behaviourVersion: 1, kind: "ACTION", label: "Full", description: "", actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] }]; }));
      const edges = Object.fromEntries(Array.from({ length: edgeCount }, () => { const id = randomUUID(); return [id, { id, flowId, version: 1, fromId: Object.keys(nodes)[0], toId: Object.keys(nodes)[1], condition: "", origin: "HUMAN", sourceRefs: [] }]; }));
      const layout = { schemaVersion: 1, positions: Object.fromEntries(Object.keys(nodes).map((id) => [id, { x: 0, y: 0, version: 1 }])), directions: Object.fromEntries(Object.keys(flows).map((id) => [id, "LR"])), edgeSides: {} };
      const document = { ...base.document, flows, nodes, edges }; parseDraftPair(document, layout);
      await database.query("update app.scope_draft set document_json=$2,layout_json=$3 where id=$1", [draftId, document, layout]);
      const id = randomUUID(); const key = randomUUID();
      await assert.rejects(previewFlowImport(owner, projectId, draftId, id, key, await validFile()), { code: "LIMIT_EXCEEDED" });
      assert.equal((await database.query("select count(*)::int count from app.flow_import_preview where id=$1", [id])).rows[0].count, 0);
      assert.equal((await database.query("select count(*)::int count from app.mutation_receipt where key=$1", [key])).rows[0].count, 0);
    }
  });
});

test("READY bodies cannot be cleared through privileged SQL", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await validFile());
    await assert.rejects(database.query("update app.flow_import_preview set payload=null where id=$1", [preview.id]), /check constraint|retention boundary/i);
  });
});
