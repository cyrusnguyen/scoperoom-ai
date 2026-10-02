import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Client } from "pg";
import { executeGraphCommand, getDraft } from "../../src/features/drafts/server/execute-command.ts";
import { savePositions } from "../../src/features/drafts/server/positions.ts";
import { LIMITS, parseDraftPair } from "../../src/features/drafts/contracts/scope-document.ts";
import { MAX_VERSION } from "../../src/features/drafts/contracts/strict.ts";
import { appendImportedFlow } from "../../src/features/exchange/domain/import-flow.ts";
import { getProjectBootstrap } from "../../src/features/projects/server/projects.ts";
import { findReceipt, withDatabase } from "../../src/features/projects/server/access.ts";
import { archiveProject, changeProjectMember, removeProjectMember } from "../../src/features/projects/server/management.ts";
import { applyFlowImport, discardFlowImport, getFlowImport, previewFlowImport } from "../../src/features/exchange/server/import-flow.ts";
import { cleanupTransient } from "../../src/server/maintenance/cleanup-transient.ts";
import { canRun, withFixture } from "./support/fixture.ts";

const bytes = () => readFile(new URL("../fixtures/flow-files/valid.scoperoom-flow.json", import.meta.url));
const connection = async () => { const client = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL }); await client.connect(); return client; };

// Privileged fixture-only replacement ages immutable timestamps or installs corrupt storage without disabling triggers.
async function replacePreview(database: Client, id: string, replacements: Record<string, unknown>) {
  await database.query("begin");
  try {
    const original = (await database.query("select to_jsonb(p) value from app.flow_import_preview p where id=$1 for update", [id])).rows[0].value;
    await database.query("delete from app.flow_import_preview where id=$1", [id]);
    await database.query("insert into app.flow_import_preview select * from jsonb_populate_record(null::app.flow_import_preview,$1::jsonb)", [{ ...original, ...replacements }]);
    await database.query("commit");
  } catch (error) { await database.query("rollback"); throw error; }
}

// Each barrier observes an independent service connection waiting on this exact backend, never elapsed time.
async function waiter(database: Client, blocker: number, excluded: number[] = [], previewId: string | null = null) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const { rows } = await database.query<{ pid: number; xact_start: Date }>(
      `select a.pid,a.xact_start from pg_stat_activity a
       where a.wait_event_type='Lock' and $1=any(pg_blocking_pids(a.pid)) and not(a.pid=any($2::int[]))
       and ($3::uuid is null or exists (
         select 1 from app.flow_import_preview p join pg_locks owned on owned.transactionid::text=p.xmax::text
         where p.id=$3::uuid and owned.pid=a.pid and owned.locktype='transactionid' and owned.mode='ExclusiveLock' and owned.granted
       ))`, [blocker, excluded, previewId]);
    if (rows[0]) return rows[0];
    await setImmediate();
  }
  assert.fail(`No independent connection waited on backend ${blocker}.`);
}

async function snapshot(database: Client, projectId: string) {
  return {
    drafts: (await database.query("select id,status,document_json,layout_json,document_revision,layout_revision from app.scope_draft where project_id=$1 order by id", [projectId])).rows,
    previews: (await database.query("select * from app.flow_import_preview where project_id=$1 order by id", [projectId])).rows,
    receipts: (await database.query("select * from app.mutation_receipt where scope_id=$1 order by id", [projectId])).rows,
    audit: (await database.query("select * from app.audit_event where project_id=$1 order by sequence", [projectId])).rows,
    project: (await database.query("select current_draft_id,status,event_sequence from app.project where id=$1", [projectId])).rows[0],
  };
}

async function ordered(database: Client, projectId: string, first: () => Promise<unknown>, second: () => Promise<unknown>) {
  const gate = await connection();
  let a: Promise<unknown> | undefined; let b: Promise<unknown> | undefined;
  try {
    const pid = (await gate.query("select pg_backend_pid() pid")).rows[0].pid;
    await gate.query("begin"); await gate.query("select id from app.project where id=$1 for update", [projectId]);
    a = first(); void a.catch(() => undefined);
    const firstWaiter = await waiter(database, pid);
    b = second(); void b.catch(() => undefined);
    const secondWaiter = await waiter(database, firstWaiter.pid);
    assert.notEqual(firstWaiter.pid, secondWaiter.pid);
    await gate.query("commit");
    return await Promise.allSettled([a, b]);
  } finally {
    await gate.query("rollback"); await Promise.allSettled([a, b]); await gate.end();
  }
}

for (const sameKey of [true, false]) test(`barrier: concurrent Apply ${sameKey ? "same" : "different"} keys commit one complete effect`, { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    const before = await snapshot(database, projectId); const key = randomUUID();
    const apply = (key: string) => applyFlowImport(owner, projectId, preview.id, { key, draftId, previewHash: preview.previewHash });
    const results = await ordered(database, projectId, () => apply(key), () => apply(sameKey ? key : randomUUID()));
    assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "fulfilled");
    if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled") return;
    const first = results[0].value as Awaited<ReturnType<typeof apply>>;
    assert.deepEqual(results[1].value, { ...first, replayed: true }); assert.equal(first.replayed, false);
    const after = await snapshot(database, projectId);
    assert.equal(after.drafts[0].document_revision, before.drafts[0].document_revision + 1);
    assert.equal(after.drafts[0].layout_revision, before.drafts[0].layout_revision + 1);
    assert.equal(after.project.event_sequence, String(BigInt(before.project.event_sequence) + BigInt(1)));
    assert.equal(after.audit.length, before.audit.length + 1); assert.equal(after.audit.at(-1).action, "FLOW_IMPORTED");
    assert.deepEqual(after.audit.at(-1).entity_refs, [{ kind: "DRAFT", id: draftId }, { kind: "DRAFT_ENTITY", id: first.flowId }]);
    assert.deepEqual(after.audit.at(-1).metadata, { draftId, flowId: first.flowId, nodeCount: preview.file!.nodes.length, edgeCount: preview.file!.edges.length, documentRevision: first.documentRevision, layoutRevision: first.layoutRevision });
    assert.equal(after.audit.at(-1).sequence, String(first.eventSequence));
    assert.equal(after.receipts.length, before.receipts.length + 1);
    assert.deepEqual(after.previews[0].applied_mapping, first.mapping);
    const { replayed: _, ...result } = first;
    assert.equal(_, false);
    assert.deepEqual({ ...after.previews[0].applied_result, mapping: after.previews[0].applied_mapping }, result);
    const draft = await getDraft(owner, projectId, draftId); assert.ok(draft.document.flows[first.flowId]);
    assert.equal(Object.keys(draft.document.nodes).length, preview.file!.nodes.length);
    assert.equal(Object.keys(draft.document.edges).length, preview.file!.edges.length);
    for (const [id, mapped] of Object.entries(first.mapping.nodes)) {
      const p = preview.positions!.find((p) => p.nodeId === id)!;
      assert.deepEqual(draft.layout.positions[mapped], { x: p.x, y: p.y, version: 1 });
    }
  });
});

test("applied request key cannot leak another preview or another actor's result", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, database }) => {
    const owner = await user(); const editor = await user(); const projectId = await project(owner); await join(owner, projectId, editor);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id; const file = await bytes();
    const first = await previewFlowImport(editor, projectId, draftId, randomUUID(), randomUUID(), file);
    const second = await previewFlowImport(editor, projectId, draftId, randomUUID(), randomUUID(), file); const key = randomUUID();
    await applyFlowImport(editor, projectId, first.id, { key, draftId, previewHash: first.previewHash }); const before = await snapshot(database, projectId);
    await assert.rejects(applyFlowImport(editor, projectId, second.id, { key, draftId, previewHash: second.previewHash }), { code: "KEY_REUSED", message: "KEY_REUSED" });
    await assert.rejects(applyFlowImport(owner, projectId, first.id, { key, draftId, previewHash: first.previewHash }), { code: "NOT_FOUND", message: "NOT_FOUND" });
    await assert.rejects(getFlowImport(owner, projectId, first.id), { code: "NOT_FOUND", message: "NOT_FOUND" });
    assert.deepEqual(await snapshot(database, projectId), before);
  });
});

test("recovery-only key stays unknown until a real mutation consumes it, then old Apply is KEY_REUSED", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, profileId, database }) => {
    const owner = await user(); const projectId = await project(owner); const actorId = await profileId(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    const originalKey = randomUUID(); const recoveryKey = randomUUID();
    const applied = await applyFlowImport(owner, projectId, preview.id, { key: originalKey, draftId, previewHash: preview.previewHash });
    const before = await snapshot(database, projectId);
    const receipt = () => withDatabase((db) => db.$transaction((tx) => findReceipt(tx, actorId, "PROJECT", projectId, recoveryKey)));
    assert.equal(await receipt(), null);
    assert.deepEqual(await applyFlowImport(owner, projectId, preview.id, { key: recoveryKey, draftId, previewHash: preview.previewHash }), { ...applied, replayed: true });
    assert.equal(await receipt(), null, "terminal recovery does not consume a fresh key");
    assert.deepEqual(await snapshot(database, projectId), before);
    const command = { key: recoveryKey, commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: applied.documentRevision,
      payload: { title: "Later operation", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } };
    const created = await executeGraphCommand(owner, projectId, draftId, command);
    assert.equal((await receipt())?.operation, "DRAFT_COMMAND_V1");
    const consumed = await snapshot(database, projectId);
    assert.equal(consumed.receipts.length, before.receipts.length + 1);
    assert.equal(consumed.audit.length, before.audit.length + 1);
    assert.equal(consumed.drafts[0].document_revision, before.drafts[0].document_revision + 1);
    assert.equal(consumed.drafts[0].layout_revision, before.drafts[0].layout_revision + 1);
    assert.ok(consumed.drafts[0].document_json.flows[created.createdIds[0]!]);
    await assert.rejects(applyFlowImport(owner, projectId, preview.id, { key: recoveryKey, draftId, previewHash: preview.previewHash }), { code: "KEY_REUSED", message: "KEY_REUSED" });
    assert.deepEqual(await executeGraphCommand(owner, projectId, draftId, command), { ...created, replayed: true });
    for (const key of [originalKey, randomUUID()]) assert.deepEqual(await applyFlowImport(owner, projectId, preview.id, { key, draftId, previewHash: preview.previewHash }), { ...applied, replayed: true });
    assert.deepEqual(await snapshot(database, projectId), consumed);
  });
});

test("expiry at final SQL transition returns IMPORT_EXPIRED and rolls back draft, audit and receipts", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    const now = (await database.query("select clock_timestamp() now")).rows[0].now.getTime();
    await replacePreview(database, preview.id, { created_at: new Date(now - 86_400_000), expires_at: new Date(now + 2000) });
    const before = await snapshot(database, projectId); const gate = await connection(); let apply: ReturnType<typeof applyFlowImport> | undefined;
    try {
      const pid = (await gate.query("select pg_backend_pid() pid")).rows[0].pid;
      await gate.query("begin"); await gate.query("lock table app.flow_import_preview in share mode");
      apply = applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }); void apply.catch(() => undefined);
      const waiting = await waiter(database, pid, [], preview.id);
      const query = (await database.query("select query from pg_stat_activity where pid=$1", [waiting.pid])).rows[0].query;
      assert.match(query, /UPDATE.*flow_import_preview/i);
      const deadline = Date.now() + 4000;
      while (!(await database.query("select clock_timestamp()>=expires_at expired from app.flow_import_preview where id=$1", [preview.id])).rows[0].expired) { assert.ok(Date.now() < deadline); await setImmediate(); }
      await gate.query("commit"); await assert.rejects(apply, { code: "IMPORT_EXPIRED" });
      assert.deepEqual(await snapshot(database, projectId), before);
    } finally { await gate.query("rollback"); await apply?.catch(() => undefined); await gate.end(); }
  });
});

test("maximum legal IDs/counts admit layout, mapping and receipt JSONB; SQL caps reject oversized writes atomically", { skip: !canRun }, async (t) => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const file = JSON.parse((await bytes()).toString()); delete file.linkHints;
    const fileId = (kind: string, index: number) => `${kind}${String(index).padStart(63, "0")}`;
    file.nodes = Array.from({ length: 200 }, (_, i) => ({ id: fileId("n", i), kind: "ACTION", label: "Step", description: "", actorLabel: null, assumptionNotes: [] }));
    file.edges = Array.from({ length: 400 }, (_, i) => ({ id: fileId("e", i), fromId: file.nodes[0].id, toId: file.nodes[1].id, condition: null }));
    // JSONB expands scientific notation: negative subnormals need more storage than large coordinates.
    file.positions = file.nodes.map((node: { id: string }) => ({ nodeId: node.id, x: -Number.MIN_VALUE, y: -Number.MIN_VALUE }));
    file.edgeSides = file.edges.map((edge: { id: string }) => ({ edgeId: edge.id, from: "bottom", to: "right" }));
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), Buffer.from(JSON.stringify(file)));
    const applied = await applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash });
    const before = await snapshot(database, projectId);
    const size = (await database.query("select octet_length(applied_mapping::text)::int mapping,octet_length(applied_result::text)::int result,octet_length(r.result::text)::int receipt,octet_length(d.layout_json::text)::int layout from app.flow_import_preview p join app.scope_draft d on d.id=p.draft_id join app.mutation_receipt r on r.scope_id=p.project_id and r.operation='FLOW_IMPORT_APPLY_V1' where p.id=$1", [preview.id])).rows[0];
    assert.deepEqual(before.audit.at(-1).entity_refs, [{ kind: "DRAFT", id: draftId }, { kind: "DRAFT_ENTITY", id: applied.flowId }]);
    assert.deepEqual(before.audit.at(-1).metadata, { draftId, flowId: applied.flowId, nodeCount: 200, edgeCount: 400, documentRevision: applied.documentRevision, layoutRevision: applied.layoutRevision });
    assert.ok(size.mapping > 64_000 && size.mapping <= 65_536); assert.ok(size.receipt > size.mapping && size.receipt <= 65_536); assert.ok(size.result < 1000); assert.ok(size.layout < LIMITS.layoutBytes);
    const maximalDocument = structuredClone(before.drafts[0].document_json);
    const maximalLayout = structuredClone(before.drafts[0].layout_json);
    for (const id of Object.keys(maximalLayout.positions)) maximalLayout.positions[id] = { x: -Number.MIN_VALUE, y: -Number.MIN_VALUE, version: MAX_VERSION };
    for (const id of Object.keys(maximalLayout.edgeSides)) maximalLayout.edgeSides[id] = { from: "bottom", to: "bottom" };
    for (let i = 1; i < LIMITS.flows; i++) {
      const id = randomUUID(); maximalDocument.flows[id] = { ...maximalDocument.flows[applied.flowId], id };
      maximalLayout.directions[id] = "LR";
    }
    parseDraftPair(maximalDocument, maximalLayout);
    const maximalLayoutBytes = (await database.query("select octet_length($1::jsonb::text)::int size", [maximalLayout])).rows[0].size;
    assert.ok(maximalLayoutBytes > 150_000, "the bound includes PostgreSQL decimal expansion");
    assert.ok(maximalLayoutBytes < LIMITS.layoutBytes);
    // ASCII file IDs max64, UUID values36, max600 entries: even max safe-integer counters fit below64KiB.
    const maximumCounters = { ...before.previews[0].applied_result, documentRevision: Number.MAX_SAFE_INTEGER, layoutRevision: Number.MAX_SAFE_INTEGER, eventSequence: Number.MAX_SAFE_INTEGER, mapping: applied.mapping };
    assert.ok((await database.query("select octet_length($1::jsonb::text)::int size", [maximumCounters])).rows[0].size <= 65_536);
    t.diagnostic(`JSONB bytes: mapping=${size.mapping}, result=${size.result}, receipt=${size.receipt}, layout=${size.layout}, maximal-layout=${maximalLayoutBytes}`);
    await assert.rejects(database.query("update app.scope_draft set layout_json=$2 where id=$1", [draftId, { padding: "x".repeat(LIMITS.layoutBytes) }]), /layout.*size|layout.*bytes|layout.*limit/i);
    assert.deepEqual(await snapshot(database, projectId), before);
    await assert.rejects(replacePreview(database, preview.id, { applied_mapping: { flowId: applied.flowId, nodes: { padding: "x".repeat(65_536) }, edges: {} } }), /mapping_size/i);
    assert.deepEqual(await snapshot(database, projectId), before);
    const receipt = before.receipts.find((r) => r.operation === "FLOW_IMPORT_APPLY_V1")!;
    await assert.rejects(database.query("insert into app.mutation_receipt(id,actor_id,scope_kind,scope_id,key,operation,request_hash,result,expires_at) values(gen_random_uuid(),$1,'PROJECT',$2,$3,'TEST',repeat('a',64),$4,now()+interval '30 days')", [receipt.actor_id, projectId, randomUUID(), { padding: "x".repeat(65_536) }]), /result_size|receipt.*size|receipt.*bytes/i);
    assert.deepEqual(await snapshot(database, projectId), before);
  });
});

for (const capacity of ["nodes", "edges"] as const) test(`latest ${capacity} capacity refusal leaves READY and every row unchanged`, { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const base = (await getProjectBootstrap(owner, projectId)).draft; const draftId = base.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    const flowId = randomUUID();
    base.document.flows[flowId] = { id: flowId, version: 1, behaviourVersion: 1, title: "Full", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED", confirmation: null, verificationMethod: null }; base.layout.directions[flowId] = "LR";
    const nodeIds = Array.from({ length: capacity === "nodes" ? 200 : 2 }, () => randomUUID());
    for (const id of nodeIds) { base.document.nodes[id] = { id, flowId, version: 1, behaviourVersion: 1, kind: "ACTION", label: "Full", description: "", actorLabel: "", origin: "HUMAN", sourceRefs: [], assumptionNotes: [] }; base.layout.positions[id] = { x: 0, y: 0, version: 1 }; }
    if (capacity === "edges") for (let i = 0; i < 400; i++) { const id = randomUUID(); base.document.edges[id] = { id, flowId, version: 1, fromId: nodeIds[0]!, toId: nodeIds[1]!, condition: "", origin: "HUMAN", sourceRefs: [] }; }
    parseDraftPair(base.document, base.layout); await database.query("update app.scope_draft set document_json=$2,layout_json=$3 where id=$1", [draftId, base.document, base.layout]);
    const before = await snapshot(database, projectId);
    await assert.rejects(applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }), { code: "LIMIT_EXCEEDED" });
    assert.deepEqual(await snapshot(database, projectId), before); assert.equal(before.previews[0].state, "READY");
  });
});

test("Apply document JSONB admission rolls back despite compact JSON fitting", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const base = (await getProjectBootstrap(owner, projectId)).draft; const draftId = base.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    const imported = appendImportedFlow({ document: base.document, layout: base.layout }, preview.file!, preview.positions!, randomUUID);
    const delta = (await database.query("select octet_length($1::jsonb::text)-octet_length($2::jsonb::text) delta", [imported.draft.document, base.document])).rows[0].delta;
    const initialBytes = (await database.query("select octet_length($1::jsonb::text) size", [base.document])).rows[0].size;
    const count = Math.floor((LIMITS.documentBytes - initialBytes - delta / 2) / 40);
    base.document.retiredEntityIds = Array.from({ length: count }, (_, i) => `10000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`);
    parseDraftPair(base.document, base.layout);
    const candidate = appendImportedFlow({ document: base.document, layout: base.layout }, preview.file!, preview.positions!, randomUUID);
    const sizes = (await database.query("select octet_length($1::jsonb::text) saved,octet_length($2::jsonb::text) candidate", [base.document, candidate.draft.document])).rows[0];
    assert.ok(sizes.saved <= LIMITS.documentBytes); assert.ok(sizes.candidate > LIMITS.documentBytes); assert.ok(Buffer.byteLength(JSON.stringify(candidate.draft.document)) <= LIMITS.documentBytes);
    await database.query("update app.scope_draft set document_json=$2 where id=$1", [draftId, base.document]);
    const before = await snapshot(database, projectId);
    await assert.rejects(applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }), { code: "LIMIT_EXCEEDED" });
    assert.deepEqual(await snapshot(database, projectId), before); assert.equal((await getFlowImport(owner, projectId, preview.id)).state, "READY");
  });
});

for (const invalid of ["payload", "positions", "saved graph", "saved geometry", "expiry", "stale draft"] as const) test(`Apply safely refuses ${invalid} with complete rollback`, { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const base = (await getProjectBootstrap(owner, projectId)).draft; const draftId = base.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    if (invalid === "payload") await replacePreview(database, preview.id, { payload: { ...preview.file, edges: [{ id: "broken", fromId: "missing", toId: "missing", condition: null }] } });
    if (invalid === "positions") await replacePreview(database, preview.id, { positions: preview.positions!.map((p, i) => i ? p : { ...p, x: 100_001 }) });
    if (invalid === "saved graph") await database.query("update app.scope_draft set document_json=jsonb_set(document_json,'{schemaVersion}','99') where id=$1", [draftId]);
    if (invalid === "saved geometry") await database.query("update app.scope_draft set layout_json=jsonb_set(layout_json,'{positions}',$2) where id=$1", [draftId, { [randomUUID()]: { x: 0, y: 0, version: 1 } }]);
    if (invalid === "expiry") { const now = (await database.query("select now() now")).rows[0].now.getTime(); await replacePreview(database, preview.id, { created_at: new Date(now - 86_400_000), expires_at: new Date(now - 1000) }); }
    if (invalid === "stale draft") {
      await database.query("begin");
      try {
        const replacement = randomUUID(); await database.query("update app.scope_draft set status='ARCHIVED' where id=$1", [draftId]);
        await database.query("insert into app.scope_draft(id,project_id,created_by,document_json,layout_json) select $2,project_id,created_by,document_json,layout_json from app.scope_draft where id=$1", [draftId, replacement]);
        await database.query("update app.project set current_draft_id=$2 where id=$1", [projectId, replacement]); await database.query("commit");
      } catch (error) { await database.query("rollback"); throw error; }
    }
    const before = await snapshot(database, projectId);
    await assert.rejects(applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }), { code: invalid === "expiry" ? "IMPORT_EXPIRED" : invalid === "stale draft" ? "IMPORT_STALE" : "UNAVAILABLE" });
    assert.deepEqual(await snapshot(database, projectId), before); assert.equal(before.previews[0].state, "READY");
  });
});

test("retired imported flow and replacement draft never resurrect or retarget on recovery", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes()); const key = randomUUID();
    const applied = await applyFlowImport(owner, projectId, preview.id, { key, draftId, previewHash: preview.previewHash });
    await executeGraphCommand(owner, projectId, draftId, { key: randomUUID(), commandSchemaVersion: 1, command: "DELETE_FLOW", expectedDocumentRevision: applied.documentRevision, payload: { flowId: applied.flowId, removeNodeIds: Object.values(applied.mapping.nodes).sort(), removeEdgeIds: Object.values(applied.mapping.edges).sort() } });
    const deleted = await snapshot(database, projectId); assert.equal(deleted.drafts[0].document_json.flows[applied.flowId], undefined);
    for (const id of [applied.flowId, ...Object.values(applied.mapping.nodes), ...Object.values(applied.mapping.edges)]) assert.ok(deleted.drafts[0].document_json.retiredEntityIds.includes(id));
    for (const recoveryKey of [key, randomUUID()]) assert.deepEqual(await applyFlowImport(owner, projectId, preview.id, { key: recoveryKey, draftId, previewHash: preview.previewHash }), { ...applied, replayed: true });
    assert.deepEqual(await snapshot(database, projectId), deleted);
    const replacement = randomUUID(); await database.query("begin");
    try {
      await database.query("update app.scope_draft set status='ARCHIVED' where id=$1", [draftId]);
      await database.query("insert into app.scope_draft(id,project_id,created_by,document_json,layout_json) select $2,project_id,created_by,document_json,layout_json from app.scope_draft where id=$1", [draftId, replacement]);
      await database.query("update app.project set current_draft_id=$2 where id=$1", [projectId, replacement]); await database.query("commit");
    } catch (error) { await database.query("rollback"); throw error; }
    const replaced = await snapshot(database, projectId);
    assert.deepEqual(await applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }), { ...applied, replayed: true });
    assert.deepEqual(await snapshot(database, projectId), replaced); assert.equal((await getFlowImport(owner, projectId, preview.id)).result!.draftId, draftId);
    assert.equal((await getDraft(owner, projectId, draftId)).document.flows[applied.flowId], undefined);
  });
});

test("SQL transition guard rejects wall-clock expiry after transaction start", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    const now = (await database.query("select clock_timestamp() now")).rows[0].now.getTime();
    await replacePreview(database, preview.id, { created_at: new Date(now - 86_400_000), expires_at: new Date(now + 500) });
    const before = await snapshot(database, projectId); await database.query("begin");
    try {
      const deadline = Date.now() + 4000;
      while (!(await database.query("select clock_timestamp()>=expires_at expired,current_timestamp<expires_at began_valid from app.flow_import_preview where id=$1", [preview.id])).rows[0].expired) { assert.ok(Date.now() < deadline); await setImmediate(); }
      assert.equal((await database.query("select current_timestamp<expires_at began_valid from app.flow_import_preview where id=$1", [preview.id])).rows[0].began_valid, true);
      const flowId = randomUUID();
      await assert.rejects(database.query("update app.flow_import_preview set state='APPLIED',applied_at=clock_timestamp(),result_flow_id=$2,applied_mapping=$3,applied_result=$4 where id=$1", [preview.id, flowId, { flowId, nodes: {}, edges: {} }, { previewId: preview.id, draftId, flowId, documentRevision: 2, layoutRevision: 2, eventSequence: 2 }]), /flow import expired/i);
    } finally { await database.query("rollback"); }
    assert.deepEqual(await snapshot(database, projectId), before);
  });
});

test("near-cap admitted payload with automatic geometry applies successfully", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const source = JSON.parse((await bytes()).toString()); delete source.positions; delete source.edgeSides; delete source.linkHints;
    source.edges = [];
    source.nodes = Array.from({ length: 100 }, (_, i) => ({ id: `node-${i}`, kind: "ACTION", label: "Step", description: "x".repeat(3500), actorLabel: null, assumptionNotes: Array(13).fill("n".repeat(500)) }));
    const measured = (await database.query("select octet_length($1::jsonb::text)::int size", [source])).rows[0].size;
    const addition = Math.floor((1_048_576 - 500 - measured) / 100);
    assert.ok(addition >= 0 && addition < 500);
    for (const node of source.nodes) node.description += "x".repeat(addition);
    const upload = Buffer.from(JSON.stringify(source)); assert.ok(upload.byteLength <= 1_048_576);
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), upload);
    assert.ok(Buffer.byteLength(JSON.stringify({ ...preview.file, positions: preview.positions })) > 1_048_576, "automatic geometry crosses the upload cap while separately admitted JSONB values fit");
    const result = await applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash });
    assert.equal(Object.keys(result.mapping.nodes).length, 100);
    assert.equal((await getFlowImport(owner, projectId, preview.id)).state, "APPLIED");
  });
});

test("Apply refuses expiry reached while waiting on the draft; cleanup skips its owned expired row", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, profileId, database }) => {
    const owner = await user(); const projectId = await project(owner); const actorId = await profileId(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    const gate = await connection(); const draftGate = await connection(); let apply: ReturnType<typeof applyFlowImport> | undefined;
    try {
      const pid = (await gate.query("select pg_backend_pid() pid")).rows[0].pid;
      await gate.query("begin"); await gate.query("select id from app.user_profile where id=$1 for no key update", [actorId]);
      await draftGate.query("begin"); await draftGate.query("select id from app.scope_draft where id=$1 for no key update", [draftId]);
      const draftPid = (await draftGate.query("select pg_backend_pid() pid")).rows[0].pid;
      apply = applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }); void apply.catch(() => undefined);
      const waiting = await waiter(database, pid);
      const now = (await database.query("select clock_timestamp() now")).rows[0].now.getTime();
      await replacePreview(database, preview.id, { created_at: new Date(now - 86_400_000), expires_at: new Date(now + 500) });
      await gate.query("commit"); await waiter(database, draftPid);
      const deadline = Date.now() + 4000;
      while (!(await database.query("select clock_timestamp()>=expires_at expired from app.flow_import_preview where id=$1", [preview.id])).rows[0].expired) { assert.ok(Date.now() < deadline); await setImmediate(); }
      assert.ok(waiting.xact_start.getTime() < now + 500);
      const held = await snapshot(database, projectId);
      await cleanupTransient({ dryRun: false, batchSize: 100 }); assert.deepEqual(await snapshot(database, projectId), held, "expired preview owned by Apply is skipped");
      await draftGate.query("commit");
      await assert.rejects(apply, { code: "IMPORT_EXPIRED" });
      assert.deepEqual(await snapshot(database, projectId), held);
    } finally { await gate.query("rollback"); await draftGate.query("rollback"); await apply?.catch(() => undefined); await gate.end(); await draftGate.end(); }
  });
});

test("live Apply survives actual 30-day receipt and 7-day body cleanup, same/new key recovery and mismatches", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes()); const key = randomUUID();
    const input = { key, draftId, previewHash: preview.previewHash }; const applied = await applyFlowImport(owner, projectId, preview.id, input);
    const original = await snapshot(database, projectId);
    assert.deepEqual(await applyFlowImport(owner, projectId, preview.id, input), { ...applied, replayed: true }, "lost response uses the original receipt");
    assert.deepEqual(await snapshot(database, projectId), original);
    const now = (await database.query("select now() now")).rows[0].now.getTime();
    await replacePreview(database, preview.id, { created_at: new Date(now - 32 * 86_400_000), expires_at: new Date(now - 31 * 86_400_000), applied_at: new Date(now - 8 * 86_400_000) });
    await database.query("update app.mutation_receipt set created_at=now()-interval '31 days',expires_at=now()-interval '1 day' where scope_id=$1", [projectId]);
    const sweep = await cleanupTransient({ dryRun: false, batchSize: 100 }); assert.ok(sweep.deletedReceipts >= original.receipts.length); assert.ok(sweep.clearedAppliedBodies >= 1);
    const cleaned = await snapshot(database, projectId); assert.equal(cleaned.previews[0].payload, null); assert.equal(cleaned.previews[0].positions, null); assert.equal(cleaned.previews[0].fidelity_report, null); assert.equal(cleaned.receipts.length, 0);
    assert.deepEqual(cleaned.drafts, original.drafts); assert.deepEqual(cleaned.audit, original.audit); assert.deepEqual(cleaned.project, original.project);
    const { replayed, ...retainedResult } = applied; assert.equal(replayed, false);
    assert.deepEqual((await getFlowImport(owner, projectId, preview.id)).result, retainedResult);
    for (const recoveryKey of [key, ...Array.from({ length: 30 }, () => randomUUID())]) assert.deepEqual(await applyFlowImport(owner, projectId, preview.id, { ...input, key: recoveryKey }), { ...applied, replayed: true });
    const recovered = await snapshot(database, projectId); assert.deepEqual(recovered, cleaned);
    for (const mismatch of [{ draftId: randomUUID() }, { previewHash: "a".repeat(64) }]) await assert.rejects(applyFlowImport(owner, projectId, preview.id, { ...input, ...mismatch }), { code: "IMPORT_PAYLOAD_MISMATCH" });
    await assert.rejects(applyFlowImport(owner, projectId, preview.id, { ...input, extra: "hidden" } as typeof input), { code: "INVALID_INPUT" });
    await database.query("insert into app.mutation_receipt(id,actor_id,scope_kind,scope_id,key,operation,request_hash,result,expires_at) select gen_random_uuid(),actor_id,'PROJECT',project_id,$2,'OTHER',repeat('b',64),'{}',now()+interval '30 days' from app.flow_import_preview where id=$1", [preview.id, "other-operation-key"]);
    const mismatchSnapshot = await snapshot(database, projectId);
    await assert.rejects(applyFlowImport(owner, projectId, preview.id, { ...input, key: "other-operation-key" }), { code: "KEY_REUSED" });
    assert.deepEqual(await snapshot(database, projectId), mismatchSnapshot);
  });
});

test("cleanup-first locks preview, expires it, and Apply refuses without any partial effect", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    const now = (await database.query("select now() now")).rows[0].now.getTime();
    await replacePreview(database, preview.id, { created_at: new Date(now - 2 * 86_400_000), expires_at: new Date(now - 1000) });
    const before = await snapshot(database, projectId); const cleaner = await connection(); let apply: ReturnType<typeof applyFlowImport> | undefined;
    try {
      const pid = (await cleaner.query("select pg_backend_pid() pid")).rows[0].pid;
      await cleaner.query("begin"); await cleaner.query("select id from app.flow_import_preview where id=$1 for update", [preview.id]);
      apply = applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }); void apply.catch(() => undefined);
      await waiter(database, pid);
      await cleaner.query("select * from app.cleanup_transient(false,100)"); await cleaner.query("commit");
      await assert.rejects(apply, { code: "IMPORT_EXPIRED" });
      const after = await snapshot(database, projectId); assert.deepEqual(after.drafts, before.drafts); assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.audit, before.audit); assert.deepEqual(after.project, before.project);
      assert.deepEqual(after.previews, [{ ...before.previews[0], state: "EXPIRED", payload: null, positions: null, fidelity_report: null }]);
      assert.equal((await getFlowImport(owner, projectId, preview.id)).result, null);
    } finally { await cleaner.query("rollback"); await apply?.catch(() => undefined); await cleaner.end(); }
  });
});

test("Apply owns preview while waiting on draft: cleanup SKIP LOCKED preserves the complete READY row", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const projectId = await project(owner); const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    const before = await snapshot(database, projectId); const gate = await connection(); let apply: ReturnType<typeof applyFlowImport> | undefined;
    try {
      const pid = (await gate.query("select pg_backend_pid() pid")).rows[0].pid;
      await gate.query("begin"); await gate.query("select id from app.scope_draft where id=$1 for update", [draftId]);
      apply = applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }); void apply.catch(() => undefined);
      await waiter(database, pid);
      const probe = await connection();
      try { await probe.query("begin"); assert.equal((await probe.query("select id from app.flow_import_preview where id=$1 for update skip locked", [preview.id])).rowCount, 0); }
      finally { await probe.query("rollback"); await probe.end(); }
      await cleanupTransient({ dryRun: false, batchSize: 100 }); assert.deepEqual(await snapshot(database, projectId), before);
      await gate.query("commit"); const result = await apply;
      const after = await snapshot(database, projectId); assert.equal(after.previews[0].state, "APPLIED"); assert.deepEqual(after.previews[0].applied_mapping, result.mapping);
      assert.equal(after.drafts[0].document_revision, before.drafts[0].document_revision + 1); assert.equal(after.drafts[0].layout_revision, before.drafts[0].layout_revision + 1);
      assert.equal(after.receipts.length, before.receipts.length + 1); assert.equal(after.audit.length, before.audit.length + 1); assert.equal(after.project.event_sequence, String(BigInt(before.project.event_sequence) + BigInt(1)));
    } finally { await gate.query("rollback"); await apply?.catch(() => undefined); await gate.end(); }
  });
});

for (const applyFirst of [true, false]) test(`barrier: Apply versus capacity-filling real edit, ${applyFirst ? "Apply" : "edit"} first`, { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, database }) => {
    const owner = await user(); const editor = await user(); const projectId = await project(owner); await join(owner, projectId, editor);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const create = (expectedDocumentRevision: number, key = randomUUID()) => executeGraphCommand(owner, projectId, draftId, {
      key, commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision,
      payload: { title: "Peer flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" },
    });
    for (let i = 1; i <= 4; i++) await create(i);
    const preview = await previewFlowImport(editor, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    const before = await snapshot(database, projectId); const key = randomUUID(); const editKey = randomUUID();
    const apply = () => applyFlowImport(editor, projectId, preview.id, { key, draftId, previewHash: preview.previewHash });
    const edit = () => create(before.drafts[0].document_revision, editKey);
    const results = await ordered(database, projectId, applyFirst ? apply : edit, applyFirst ? edit : apply);
    assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
    assert.equal((results[1] as PromiseRejectedResult).reason.code, applyFirst ? "STALE_DOCUMENT_REVISION" : "LIMIT_EXCEEDED");
    const after = await snapshot(database, projectId);
    assert.equal(Object.keys(after.drafts[0].document_json.flows).length, 5);
    assert.equal(after.drafts[0].document_revision, before.drafts[0].document_revision + 1);
    assert.equal(after.drafts[0].layout_revision, before.drafts[0].layout_revision + 1);
    assert.equal(after.audit.length, before.audit.length + 1); assert.equal(after.receipts.length, before.receipts.length + 1);
    assert.equal(after.project.event_sequence, String(BigInt(before.project.event_sequence) + BigInt(1)));
    assert.equal(after.previews[0].state, applyFirst ? "APPLIED" : "READY");
    assert.equal(after.receipts.filter((r) => r.key === key).length, Number(applyFirst));
    assert.equal(after.receipts.filter((r) => r.key === editKey).length, Number(!applyFirst));
    if (!applyFirst) {
      assert.deepEqual(after.previews, before.previews);
      await assert.rejects(apply(), { code: "LIMIT_EXCEEDED" }); assert.deepEqual(await snapshot(database, projectId), after);
    }
  });
});

test("latest peer rename/move survives; imported trust and geometry survive refresh and drag; fresh preview copies again", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join }) => {
    const owner = await user(); const editor = await user(); const projectId = await project(owner); await join(owner, projectId, editor);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const send = (body: Record<string, unknown>) => executeGraphCommand(owner, projectId, draftId, { key: randomUUID(), commandSchemaVersion: 1, ...body });
    const peerFlow = (await send({ command: "CREATE_FLOW", expectedDocumentRevision: 1, payload: { title: "Peer", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } })).createdIds[0]!;
    const peerNode = (await send({ command: "ADD_NODE", expectedDocumentRevision: 2, payload: { flowId: peerFlow, kind: "ACTION", label: "Peer", description: "", actorLabel: "" } })).createdIds[0]!;
    const file = await bytes(); const preview = await previewFlowImport(editor, projectId, draftId, randomUUID(), randomUUID(), file);
    await send({ command: "UPDATE_FLOW", expectedEntityVersion: 2, payload: { flowId: peerFlow, title: "Latest peer name" } });
    await savePositions(owner, projectId, draftId, { key: randomUUID(), mode: "MOVE_NODES", flowId: peerFlow, items: [{ nodeId: peerNode, expectedPositionVersion: 1, x: 321, y: -234 }] });
    const latest = await getDraft(owner, projectId, draftId);
    const applied = await applyFlowImport(editor, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash });
    const saved = await getDraft(editor, projectId, draftId);
    assert.deepEqual(saved.document.flows[peerFlow], latest.document.flows[peerFlow]); assert.deepEqual(saved.document.nodes[peerNode], latest.document.nodes[peerNode]); assert.deepEqual(saved.layout.positions[peerNode], latest.layout.positions[peerNode]);
    assert.deepEqual(saved.document.flows[applied.flowId], { id: applied.flowId, version: 1, behaviourVersion: 1, title: preview.file!.flow.title, purpose: preview.file!.flow.purpose, classification: preview.file!.flow.classification, inclusion: "UNDECIDED", confirmation: null, verificationMethod: null });
    for (const node of preview.file!.nodes) {
      const id = applied.mapping.nodes[node.id]!; const p = preview.positions!.find((p) => p.nodeId === node.id)!;
      assert.deepEqual(saved.document.nodes[id], { id, flowId: applied.flowId, version: 1, behaviourVersion: 1, kind: node.kind, label: node.label, description: node.description, actorLabel: node.actorLabel ?? "", origin: "IMPORTED", sourceRefs: [], assumptionNotes: node.assumptionNotes });
      assert.deepEqual(saved.layout.positions[id], { x: p.x, y: p.y, version: 1 });
    }
    for (const edge of preview.file!.edges) assert.deepEqual(saved.document.edges[applied.mapping.edges[edge.id]!], { id: applied.mapping.edges[edge.id], flowId: applied.flowId, version: 1, fromId: applied.mapping.nodes[edge.fromId], toId: applied.mapping.nodes[edge.toId], condition: edge.condition ?? "", origin: "IMPORTED", sourceRefs: [] });
    assert.equal(saved.layout.directions[applied.flowId], preview.file!.flow.direction);
    for (const side of preview.file!.edgeSides!) assert.deepEqual(saved.layout.edgeSides[applied.mapping.edges[side.edgeId]!], { from: side.from, to: side.to });
    const moved = applied.mapping.nodes["n-action"]!;
    await savePositions(editor, projectId, draftId, { key: randomUUID(), mode: "MOVE_NODES", flowId: applied.flowId, items: [{ nodeId: moved, expectedPositionVersion: 1, x: -999, y: 876 }] });
    const dragged = await getDraft(editor, projectId, draftId); assert.deepEqual(dragged.document, saved.document);
    assert.deepEqual(dragged.layout, { ...saved.layout, positions: { ...saved.layout.positions, [moved]: { x: -999, y: 876, version: 2 } } });
    const fresh = await previewFlowImport(editor, projectId, draftId, randomUUID(), randomUUID(), file);
    const second = await applyFlowImport(editor, projectId, fresh.id, { key: randomUUID(), draftId, previewHash: fresh.previewHash });
    assert.notEqual(second.flowId, applied.flowId); assert.equal(Object.keys((await getDraft(editor, projectId, draftId)).document.flows).length, 3);
  });
});

for (const opponent of ["discard", "removal", "archive", "downgrade"] as const) for (const applyFirst of [true, false]) test(`barrier: Apply versus ${opponent}, ${applyFirst ? "Apply" : opponent} locks first`, { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user(); const editor = await user(); const projectId = await project(owner); await join(owner, projectId, editor);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id; const editorId = await profileId(editor);
    const preview = await previewFlowImport(editor, projectId, draftId, randomUUID(), randomUUID(), await bytes());
    const before = await snapshot(database, projectId); const applyKey = randomUUID(); const otherKey = randomUUID();
    const apply = () => applyFlowImport(editor, projectId, preview.id, { key: applyKey, draftId, previewHash: preview.previewHash });
    const other = () => opponent === "discard" ? discardFlowImport(editor, projectId, preview.id, otherKey)
      : opponent === "removal" ? removeProjectMember(owner, projectId, editorId, { key: otherKey, expectedMemberVersion: 1 })
      : opponent === "downgrade" ? changeProjectMember(owner, projectId, editorId, { key: otherKey, expectedMemberVersion: 1, role: "VIEWER" })
      : archiveProject(owner, projectId, { key: otherKey, expectedProjectVersion: 1, reason: "Acceptance proof" });
    const orderedResults = await ordered(database, projectId, applyFirst ? apply : other, applyFirst ? other : apply);
    const applied = orderedResults[applyFirst ? 0 : 1]; const competing = orderedResults[applyFirst ? 1 : 0]; assert.equal(competing.status, "fulfilled");
    const after = await snapshot(database, projectId);
    if (applyFirst) {
      assert.equal(applied.status, "fulfilled");
      assert.equal(after.previews[0].state, "APPLIED"); assert.ok(after.previews[0].applied_result); assert.ok(after.previews[0].applied_mapping);
      assert.equal(after.drafts[0].document_revision, before.drafts[0].document_revision + 1); assert.equal(after.drafts[0].layout_revision, before.drafts[0].layout_revision + 1);
      assert.ok(after.drafts[0].document_json.flows[after.previews[0].result_flow_id]);
      if (opponent === "removal") await assert.rejects(apply(), { code: "NOT_FOUND" });
      else {
        assert.deepEqual(await apply(), { ...(applied as PromiseFulfilledResult<object>).value, replayed: true });
        for (let i = 0; i < 10; i++) assert.deepEqual(await applyFlowImport(editor, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash }), { ...(applied as PromiseFulfilledResult<object>).value, replayed: true });
      }
    } else {
      assert.equal(applied.status, "rejected");
      assert.equal((applied as PromiseRejectedResult).reason.code, { discard: "IMPORT_STALE", removal: "NOT_FOUND", archive: "CONFLICT", downgrade: "FORBIDDEN" }[opponent]);
      assert.deepEqual(after.drafts, before.drafts);
      assert.equal(after.previews[0].state, opponent === "discard" ? "DISCARDED" : "READY"); assert.equal(after.previews[0].applied_result, null); assert.equal(after.previews[0].applied_mapping, null);
    }
    const effectCount = Number(applyFirst); const authorityCount = Number(opponent !== "discard");
    assert.equal(after.audit.length, before.audit.length + effectCount + authorityCount);
    assert.equal(after.project.event_sequence, String(BigInt(before.project.event_sequence) + BigInt(effectCount + authorityCount)));
    assert.equal(after.receipts.length, before.receipts.length + effectCount + Number(opponent !== "discard" || !applyFirst));
    assert.equal(after.receipts.filter((r) => r.key === applyKey).length, effectCount);
    assert.deepEqual(await snapshot(database, projectId), after, "recovery/refusal has no second effect");
  });
});
