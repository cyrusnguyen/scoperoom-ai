import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Client } from "pg";
import { getDraft } from "../../src/features/drafts/server/execute-command.ts";
import { savePositions } from "../../src/features/drafts/server/positions.ts";
import { parseFlowFile, serializeFlowFile } from "../../src/features/exchange/domain/flow-file.ts";
import { applyFlowImport, previewFlowImport } from "../../src/features/exchange/server/import-flow.ts";
import { prepareFlow } from "../../src/features/exports/server/prepare-flow.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { archiveProject, removeProjectMember } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { canRun, withFixture, type Fixture, type Identity } from "./support/fixture.ts";

const code = (expected: string) => (error: unknown) => error instanceof ProjectError && error.code === expected;
async function seed(fixture: Fixture, owner: Identity) {
  const projectId = await fixture.project(owner);
  const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
  const bytes = await readFile(new URL("../fixtures/flow-files/valid.scoperoom-flow.json", import.meta.url));
  const preview = await previewFlowImport(owner, projectId, draftId, randomUUID(), randomUUID(), bytes);
  const result = await applyFlowImport(owner, projectId, preview.id, { key: randomUUID(), draftId, previewHash: preview.previewHash });
  const draft = await getDraft(owner, projectId, draftId);
  const request = { format: "native", expectedDocumentRevision: draft.documentRevision, expectedLayoutRevision: draft.layoutRevision, includeLinkHints: false };
  return { projectId, draftId, flowId: result.flowId, draft, request };
}

async function snapshot(database: Client, projectId: string) {
  const tables = ["project", "scope_draft", "audit_event", "flow_import_preview"];
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await database.query(`select to_jsonb(t) value from app.${table} t where ${table === "project" ? "id" : "project_id"}=$1 order by id`, [projectId])).rows;
  rows.receipts = (await database.query("select to_jsonb(t) value from app.mutation_receipt t where scope_id=$1 order by id", [projectId])).rows;
  return rows;
}

test("saved native preparation preserves supported fields and writes no data cursors audit or receipts", { skip: !canRun }, async () => {
  await withFixture(async fixture => {
    const owner = await fixture.user(); const target = await seed(fixture, owner);
    const before = await snapshot(fixture.database, target.projectId);
    const prepared = await prepareFlow(owner, target.projectId, target.draftId, target.flowId, target.request);
    const file = parseFlowFile(serializeFlowFile(prepared.file));
    assert.match(prepared.filename, /\.scoperoom-flow\.json$/);
    assert.deepEqual(file.origin, { kind: "DRAFT", documentRevision: target.draft.documentRevision, layoutRevision: target.draft.layoutRevision });
    assert.deepEqual(file.flow, { title: "Checkout {flow}", purpose: "A complete exploratory journey", classification: "USER_JOURNEY", direction: "LR" });
    const labels = new Map(file.nodes.map(node => [node.id, node.label]));
    assert.deepEqual(file.nodes.map(({ id, ...node }) => { void id; return node; }).sort((a, b) => a.label.localeCompare(b.label)), [
      { kind: "START", label: "Begin", description: "", actorLabel: null, assumptionNotes: [] },
      { kind: "ACTION", label: "Choose \"plan\"", description: "Supports Unicode: café", actorLabel: "Customer", assumptionNotes: ["A plan exists"] },
      { kind: "DECISION", label: "Eligible?", description: "", actorLabel: null, assumptionNotes: [] },
      { kind: "DATA_STORE", label: "Plan catalogue", description: "", actorLabel: null, assumptionNotes: [] },
      { kind: "OUTCOME", label: "Subscribed", description: "", actorLabel: null, assumptionNotes: [] },
    ].sort((a, b) => a.label.localeCompare(b.label)));
    assert.deepEqual(file.positions?.map(position => ({ label: labels.get(position.nodeId), x: position.x, y: position.y })).sort((a, b) => a.x - b.x), [{ label: "Begin", x: 0, y: 0 }, { label: "Choose \"plan\"", x: 240, y: 0 }, { label: "Eligible?", x: 480, y: 0 }, { label: "Plan catalogue", x: 720, y: 0 }, { label: "Subscribed", x: 960, y: 0 }]);
    const edges = new Map(file.edges.map(edge => [edge.id, edge]));
    assert.deepEqual(file.edgeSides?.map(sides => ({ label: labels.get(edges.get(sides.edgeId)!.fromId), from: sides.from, to: sides.to })).sort((a, b) => a.label!.localeCompare(b.label!)), [{ label: "Begin", from: "right", to: "left" }, { label: "Choose \"plan\"", from: "bottom", to: "top" }]);
    assert.deepEqual(file.edges.map(edge => ({ from: labels.get(edge.fromId), to: labels.get(edge.toId), condition: edge.condition })).sort((a, b) => a.from!.localeCompare(b.from!)), [
      { from: "Begin", to: "Choose \"plan\"", condition: null }, { from: "Choose \"plan\"", to: "Eligible?", condition: "Eligible" }, { from: "Eligible?", to: "Plan catalogue", condition: "No" }, { from: "Plan catalogue", to: "Subscribed", condition: null }, { from: "Subscribed", to: "Subscribed", condition: null },
    ]);
    assert.equal(file.linkHints, undefined); assert.equal(file.viewport, undefined);
    assert.deepEqual(await snapshot(fixture.database, target.projectId), before);
  });
});

test("either saved revision mismatch including a layout-only move rejects with EXPORT_REVISION_CHANGED", { skip: !canRun }, async () => {
  await withFixture(async fixture => {
    const owner = await fixture.user(); const target = await seed(fixture, owner);
    const prepare = (input: unknown) => prepareFlow(owner, target.projectId, target.draftId, target.flowId, input);
    const before = await snapshot(fixture.database, target.projectId);
    await assert.rejects(prepare({ ...target.request, expectedDocumentRevision: target.request.expectedDocumentRevision + 1 }), code("EXPORT_REVISION_CHANGED"));
    await assert.rejects(prepare({ ...target.request, expectedLayoutRevision: target.request.expectedLayoutRevision + 1 }), code("EXPORT_REVISION_CHANGED"));
    await assert.rejects(prepare({ ...target.request, document: target.draft.document }), code("INVALID_INPUT"));
    assert.deepEqual(await snapshot(fixture.database, target.projectId), before);
    const nodeId = Object.keys(target.draft.document.nodes)[0]!;
    await savePositions(owner, target.projectId, target.draftId, { mode: "MOVE_NODES", flowId: target.flowId, key: randomUUID(), items: [{ nodeId, expectedPositionVersion: target.draft.layout.positions[nodeId]!.version, x: 900, y: 400 }] });
    const moved = await getDraft(owner, target.projectId, target.draftId);
    assert.equal(moved.documentRevision, target.draft.documentRevision);
    await assert.rejects(prepare(target.request), code("EXPORT_REVISION_CHANGED"));
    const refreshed = await prepare({ ...target.request, expectedLayoutRevision: moved.layoutRevision });
    const movedNode = refreshed.file.nodes.find(node => node.label === moved.document.nodes[nodeId]!.label)!;
    assert.deepEqual(refreshed.file.positions?.find(position => position.nodeId === movedNode.id), { nodeId: movedNode.id, x: 900, y: 400 });
  });
});

test("viewer and reviewer export archived readable drafts; removed and nonmembers cannot prepare", { skip: !canRun }, async () => {
  await withFixture(async fixture => {
    const owner = await fixture.user(); const target = await seed(fixture, owner);
    const viewer = await fixture.user("Viewer"); const reviewer = await fixture.user("Reviewer"); const stranger = await fixture.user("Stranger");
    await fixture.join(owner, target.projectId, viewer, "VIEWER"); await fixture.join(owner, target.projectId, reviewer, "REVIEWER");
    const prepare = (who: Identity) => prepareFlow(who, target.projectId, target.draftId, target.flowId, target.request);
    assert.equal((await prepare(viewer)).file.flow.title, "Checkout {flow}"); assert.equal((await prepare(reviewer)).file.flow.title, "Checkout {flow}");
    await archiveProject(owner, target.projectId, { expectedProjectVersion: (await getProjectStatus(owner, target.projectId)).version, reason: "Export archived read fixture", key: randomUUID() });
    assert.equal((await prepare(viewer)).file.origin.kind, "DRAFT"); assert.equal((await prepare(reviewer)).file.origin.kind, "DRAFT");
    await removeProjectMember(owner, target.projectId, await fixture.profileId(viewer), { expectedMemberVersion: 1, key: randomUUID() });
    await assert.rejects(prepare(viewer), code("NOT_FOUND")); await assert.rejects(prepare(stranger), code("NOT_FOUND"));
  });
});

test("guessed cross-project draft and flow identities reveal no saved file", { skip: !canRun }, async () => {
  await withFixture(async fixture => {
    const owner = await fixture.user(); const target = await seed(fixture, owner); const other = await seed(fixture, owner);
    for (const [projectId, draftId, flowId] of [[target.projectId, other.draftId, target.flowId], [target.projectId, target.draftId, other.flowId], [other.projectId, target.draftId, target.flowId], [target.projectId, randomUUID(), target.flowId], [target.projectId, target.draftId, randomUUID()], [target.projectId, target.draftId, "__proto__"]]) {
      await assert.rejects(prepareFlow(owner, projectId!, draftId!, flowId!, target.request), code("NOT_FOUND"));
    }
  });
});
