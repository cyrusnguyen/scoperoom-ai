import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import test from "node:test";
import { parseCommandResult } from "../../src/features/drafts/contracts/commands.ts";
import { dependencyPlan } from "../../src/features/drafts/domain/graph.ts";
import { draftMutation, executeGraphCommand, getDraft } from "../../src/features/drafts/server/execute-command.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { recordEvent, requestHash } from "../../src/features/projects/server/access.ts";
import { archiveProject, changeProjectMember, getProjectMembers, removeProjectMember } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { canRun, withFixture, type Identity } from "./support/fixture.ts";

const code = (expected: string) => (error: unknown) => error instanceof ProjectError && error.code === expected;
type Body = Record<string, unknown>;

/** Sends one command as `who` with a fresh (or given) idempotency key. */
const send = (who: Identity, projectId: string, draftId: string, body: Body, key = randomUUID()) =>
  executeGraphCommand(who, projectId, draftId, { commandSchemaVersion: 1, ...body, key });
async function holdProjectLock(projectId: string) {
  const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  await holder.connect();
  await holder.query("begin");
  await holder.query("select id from app.project where id = $1 for update", [projectId]);
  return holder;
}

async function waitForProjectLockWaiters(database: Client, expected: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { rows: [row] } = await database.query<{ count: number }>(`
      select count(*)::int as count from pg_stat_activity
      where wait_event_type = 'Lock' and query like '%FROM app.project project%'`);
    if (row!.count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Expected ${expected} command(s) waiting on the held project lock.`);
}
async function releaseHeldProjectLock(holder: Client) {
  try { await holder.query("commit"); } finally { await holder.end(); }
}

/** A project whose draft holds one flow with the given steps, all created by `owner`. */
async function seeded(project: (owner: Identity) => Promise<string>, owner: Identity, labels: string[]) {
  const projectId = await project(owner);
  const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
  let draft = await getDraft(owner, projectId, draftId);
  const flow = await send(owner, projectId, draftId, { command: "CREATE_FLOW", expectedDocumentRevision: draft.documentRevision, payload: { title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } });
  const flowId = flow.createdIds[0]!;
  const nodeIds: string[] = [];
  for (const label of labels) {
    draft = await getDraft(owner, projectId, draftId);
    const added = await send(owner, projectId, draftId, { command: "ADD_NODE", expectedDocumentRevision: draft.documentRevision, payload: { flowId, kind: "ACTION", label, description: "", actorLabel: "" } });
    nodeIds.push(added.createdIds[0]!);
  }
  return { projectId, draftId, flowId, nodeIds };
}

test("an incomplete flow saves content and positions together and reloads intact", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user("Studio Owner");
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, ["Browse", "Pay"]);
    const draft = await getDraft(owner, projectId, draftId);
    // One flow + two nodes: three commands, each advancing both revisions (node creation saves a position).
    assert.deepEqual([draft.documentRevision, draft.layoutRevision], [4, 4]);
    assert.deepEqual(nodeIds.map((id) => draft.layout.positions[id]), [{ x: 0, y: 0, version: 1 }, { x: 0, y: 160, version: 1 }]);
    assert.equal(draft.layout.directions[flowId], "TB");
    const renamed = await send(owner, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[0], label: "Browse catalogue" } });
    assert.deepEqual([renamed.documentRevision, renamed.layoutRevision], [5, 4], "a text edit leaves the layout revision alone");
    const status = await getProjectStatus(owner, projectId);
    assert.equal(status.eventSequence, renamed.eventSequence);
    assert.equal((await getDraft(owner, projectId, draftId)).document.nodes[nodeIds[0]!]!.label, "Browse catalogue");
  });
});

test("cross-flow and dangling edges are refused with no write", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, ["A"]);
    let draft = await getDraft(owner, projectId, draftId);
    const other = await send(owner, projectId, draftId, { command: "CREATE_FLOW", expectedDocumentRevision: draft.documentRevision, payload: { title: "Other", purpose: "", classification: "BUSINESS_PROCESS", inclusion: "UNDECIDED" } });
    draft = await getDraft(owner, projectId, draftId);
    const foreign = await send(owner, projectId, draftId, { command: "ADD_NODE", expectedDocumentRevision: draft.documentRevision, payload: { flowId: other.createdIds[0], kind: "ACTION", label: "B", description: "", actorLabel: "" } });
    draft = await getDraft(owner, projectId, draftId);
    for (const toId of [foreign.createdIds[0], randomUUID()]) {
      await assert.rejects(send(owner, projectId, draftId, { command: "ADD_EDGE", expectedDocumentRevision: draft.documentRevision, payload: { flowId, fromId: nodeIds[0], toId, condition: "" } }), code("INVALID_INPUT"));
    }
    assert.equal((await getDraft(owner, projectId, draftId)).documentRevision, draft.documentRevision);
  });
});

test("concurrent saves to different nodes both persist; a stale same-node save is refused without overwriting", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, database }) => {
    const owner = await user("Owner"); const editor = await user("Editor");
    const { projectId, draftId, nodeIds } = await seeded(project, owner, ["A", "B"]);
    await join(owner, projectId, editor);
    const label = (who: Identity, nodeId: string, text: string) => send(who, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId, label: text } });
    const independentStatusBefore = await getProjectStatus(owner, projectId);
    const independentAuditsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId]);
    const independentReceiptsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where scope_kind = 'PROJECT' and scope_id = $1", [projectId]);
    let independentHolder = await holdProjectLock(projectId);
    try {
      const saves = Promise.all([label(owner, nodeIds[0]!, "Owner's A"), label(editor, nodeIds[1]!, "Editor's B")]);
      await waitForProjectLockWaiters(database, 2);
      await releaseHeldProjectLock(independentHolder); independentHolder = null!;
      await saves;
    } finally {
      if (independentHolder) { await independentHolder.query("rollback"); await independentHolder.end(); }
    }
    let draft = await getDraft(owner, projectId, draftId);
    assert.deepEqual(nodeIds.map((id) => draft.document.nodes[id]!.label), ["Owner's A", "Editor's B"]);
    assert.equal((await getProjectStatus(owner, projectId)).eventSequence, independentStatusBefore.eventSequence + 2);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId])).rows[0]!.count, independentAuditsBefore.rows[0]!.count + 2);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where scope_kind = 'PROJECT' and scope_id = $1", [projectId])).rows[0]!.count, independentReceiptsBefore.rows[0]!.count + 2);
    const staleStatusBefore = await getProjectStatus(owner, projectId);
    const staleAuditsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId]);
    const staleReceiptsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where scope_kind = 'PROJECT' and scope_id = $1", [projectId]);
    let staleHolder = await holdProjectLock(projectId);
    let race: PromiseSettledResult<Awaited<ReturnType<typeof label>>>[];
    try {
      const pending = Promise.allSettled([
        send(owner, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 2, payload: { nodeId: nodeIds[0], label: "First" } }),
        send(editor, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 2, payload: { nodeId: nodeIds[0], label: "Second" } }),
      ]);
      await waitForProjectLockWaiters(database, 2);
      await releaseHeldProjectLock(staleHolder); staleHolder = null!;
      race = await pending;
    } finally {
      if (staleHolder) { await staleHolder.query("rollback"); await staleHolder.end(); }
    }
    const won = race.findIndex((entry) => entry.status === "fulfilled");
    const lost = race[1 - won] as PromiseRejectedResult;
    assert(won >= 0 && code("STALE_ENTITY_VERSION")(lost.reason));
    assert.deepEqual((lost.reason as ProjectError).details, { entityId: nodeIds[0], currentVersion: 3 });
    draft = await getDraft(owner, projectId, draftId);
    assert.equal(draft.document.nodes[nodeIds[0]!]!.label, won === 0 ? "First" : "Second");
    assert.equal((await getProjectStatus(owner, projectId)).eventSequence, staleStatusBefore.eventSequence + 1);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId])).rows[0]!.count, staleAuditsBefore.rows[0]!.count + 1);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where scope_kind = 'PROJECT' and scope_id = $1", [projectId])).rows[0]!.count, staleReceiptsBefore.rows[0]!.count + 1);
  });
});

test("a retried key replays without a second effect; an altered payload under the same key is KEY_REUSED", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const { projectId, draftId, flowId } = await seeded(project, owner, []);
    const draft = await getDraft(owner, projectId, draftId);
    const key = randomUUID();
    const body = { command: "ADD_NODE", expectedDocumentRevision: draft.documentRevision, payload: { flowId, kind: "START", label: "Start", description: "", actorLabel: "" } };
    const first = await send(owner, projectId, draftId, body, key);
    const again = await send(owner, projectId, draftId, body, key);
    assert.deepEqual({ ...again, replayed: false }, first);
    assert.equal(again.replayed, true);
    assert.equal(Object.keys((await getDraft(owner, projectId, draftId)).document.nodes).length, 1);
    await assert.rejects(send(owner, projectId, draftId, { ...body, payload: { ...body.payload, label: "Different" } }, key), code("KEY_REUSED"));
  });
});

test("deletion needs the exact dependency plan, and a delayed edit to a deleted node creates nothing", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, ["A", "B"]);
    let draft = await getDraft(owner, projectId, draftId);
    await send(owner, projectId, draftId, { command: "ADD_EDGE", expectedDocumentRevision: draft.documentRevision, payload: { flowId, fromId: nodeIds[0], toId: nodeIds[1], condition: "" } });
    draft = await getDraft(owner, projectId, draftId);
    const plan = dependencyPlan(draft.document, flowId, [nodeIds[1]!]);
    const remove = (removeEdgeIds: string[]) => send(owner, projectId, draftId, { command: "DELETE_NODES", expectedDocumentRevision: draft.documentRevision, payload: { flowId, nodeIds: [nodeIds[1]], removeEdgeIds } });
    await assert.rejects(remove([]), code("DEPENDENCY_CONFLICT"));
    const removed = await remove(plan.edgeIds);
    assert.deepEqual(removed.retiredIds.sort(), [nodeIds[1]!, ...plan.edgeIds].sort());
    await assert.rejects(send(owner, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[1], label: "Back" } }),
      (error: unknown) => code("STALE_ENTITY_VERSION")(error) && (error as ProjectError).details?.currentVersion === null);
    draft = await getDraft(owner, projectId, draftId);
    assert.equal(draft.document.nodes[nodeIds[1]!], undefined);
    assert.equal(draft.layout.positions[nodeIds[1]!], undefined);
    assert(draft.document.retiredEntityIds.includes(nodeIds[1]!));
  });
});

test("topology changes need the exact document revision; an identical edit moves no counter", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, ["A"]);
    const draft = await getDraft(owner, projectId, draftId);
    await assert.rejects(send(owner, projectId, draftId, { command: "ADD_NODE", expectedDocumentRevision: draft.documentRevision - 1, payload: { flowId, kind: "ACTION", label: "Late", description: "", actorLabel: "" } }),
      (error: unknown) => code("STALE_DOCUMENT_REVISION")(error) && (error as ProjectError).details?.documentRevision === draft.documentRevision);
    const before = await getProjectStatus(owner, projectId);
    const same = await send(owner, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[0], label: "A" } });
    assert.deepEqual([same.documentRevision, same.eventSequence, same.replayed], [draft.documentRevision, before.eventSequence, false]);
    assert.equal((await getProjectStatus(owner, projectId)).eventSequence, before.eventSequence);
  });
});

test("owners and editors author; reviewers and viewers only read; outsiders see nothing", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join }) => {
    const owner = await user(); const reviewer = await user("Reviewer"); const viewer = await user("Viewer"); const outsider = await user("Outsider");
    const { projectId, draftId, nodeIds } = await seeded(project, owner, ["A"]);
    await join(owner, projectId, reviewer, "REVIEWER"); await join(owner, projectId, viewer, "VIEWER");
    const edit = (who: Identity) => send(who, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[0], label: "Forged" } });
    for (const reader of [reviewer, viewer]) {
      assert.equal((await getDraft(reader, projectId, draftId)).document.nodes[nodeIds[0]!]!.label, "A");
      await assert.rejects(edit(reader), code("FORBIDDEN"));
    }
    await assert.rejects(getDraft(outsider, projectId, draftId), code("NOT_FOUND"));
    await assert.rejects(edit(outsider), code("NOT_FOUND"));
  });
});

test("receipts replay only for members who still have access; archived projects refuse new authoring", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join }) => {
    const owner = await user(); const editor = await user("Editor"); const leaver = await user("Leaver");
    const { projectId, draftId, nodeIds } = await seeded(project, owner, ["A", "B"]);
    await join(owner, projectId, editor); await join(owner, projectId, leaver);
    const editorKey = randomUUID(); const leaverKey = randomUUID();
    const editorBody = { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[0], label: "By editor" } };
    const leaverBody = { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[1], label: "By leaver" } };
    await send(editor, projectId, draftId, editorBody, editorKey);
    await send(leaver, projectId, draftId, leaverBody, leaverKey);
    const members = (await getProjectMembers(owner, projectId)).members;
    const editorRow = members.find((entry) => entry.displayName === "Editor")!;
    const leaverRow = members.find((entry) => entry.displayName === "Leaver")!;
    await changeProjectMember(owner, projectId, editorRow.profileId, { role: "VIEWER", expectedMemberVersion: editorRow.version, key: randomUUID() });
    await removeProjectMember(owner, projectId, leaverRow.profileId, { expectedMemberVersion: leaverRow.version, key: randomUUID() });
    // A downgraded member recovers their own earlier result but cannot start new work; a removed member learns nothing.
    assert.equal((await send(editor, projectId, draftId, editorBody, editorKey)).replayed, true);
    await assert.rejects(send(editor, projectId, draftId, { ...editorBody, payload: { ...editorBody.payload, label: "New" } }), code("FORBIDDEN"));
    await assert.rejects(send(leaver, projectId, draftId, leaverBody, leaverKey), code("NOT_FOUND"));
    const status = await getProjectStatus(owner, projectId);
    await archiveProject(owner, projectId, { expectedProjectVersion: status.version, reason: "Done", key: randomUUID() });
    await assert.rejects(send(owner, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[1], label: "Archived" } }), code("CONFLICT"));
    // An admitted reader of the archived project still recovers an earlier acknowledged result.
    assert.equal((await send(editor, projectId, draftId, editorBody, editorKey)).replayed, true);
    assert.equal((await getDraft(owner, projectId, draftId)).document.nodes[nodeIds[0]!]!.label, "By editor");
  });
});

test("the route's draft must be this project's current draft", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database, profileId }) => {
    const owner = await user();
    const { projectId, nodeIds } = await seeded(project, owner, ["A"]);
    const otherProject = await project(owner, "Other project");
    const otherDraftId = (await getProjectBootstrap(owner, otherProject)).draft.id;
    const edit = (routeDraftId: string) => send(owner, projectId, routeDraftId, { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[0], label: "Nope" } });
    await assert.rejects(edit(otherDraftId), code("NOT_FOUND"));
    await assert.rejects(getDraft(owner, projectId, otherDraftId), code("NOT_FOUND"));
    // An archived draft of the same project (Stage 09 reset creates these) is readable history but never writable.
    const empty = JSON.stringify({ schemaVersion: 3, projectGoal: "", flows: {}, nodes: {}, edges: {}, requirements: {}, traceLinks: {}, scenarios: {}, questions: {}, decisions: {}, dependencies: {}, waivers: {}, retiredEntityIds: [] });
    const { rows: [archived] } = await database.query<{ id: string }>(
      `insert into app.scope_draft (project_id, created_by, document_json, layout_json, status) values ($1, $2, $3::jsonb, '{"schemaVersion":1,"positions":{},"directions":{}}'::jsonb, 'ARCHIVED') returning id`,
      [projectId, await profileId(owner), empty]);
    await assert.rejects(edit(archived!.id), code("DRAFT_REPLACED"));
    assert.deepEqual(await getDraft(owner, projectId, archived!.id), { id: archived!.id, status: "ARCHIVED", documentRevision: 1, layoutRevision: 1, document: JSON.parse(empty), layout: { schemaVersion: 1, positions: {}, directions: {} } });
  });
});

test("duplicating a flow saves fresh identities with copied positions", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, ["A", "B"]);
    const draft = await getDraft(owner, projectId, draftId);
    const copy = await send(owner, projectId, draftId, { command: "DUPLICATE_FLOW", expectedDocumentRevision: draft.documentRevision, payload: { flowId } });
    const after = await getDraft(owner, projectId, draftId);
    const [copyFlowId, ...copyNodeIds] = copy.createdIds;
    assert.equal(after.document.flows[copyFlowId!]!.title, "Copy of Checkout");
    assert.equal(copyNodeIds.length, 2);
    assert(copyNodeIds.every((id) => !nodeIds.includes(id) && after.layout.positions[id]!.version === 1));
    // jsonb stores object keys sorted, so copies come back in id order: match each copy to its source by label.
    const placedByLabel = (ids: string[]) => Object.fromEntries(ids.map((id) => [after.document.nodes[id]!.label, [after.layout.positions[id]!.x, after.layout.positions[id]!.y]]));
    assert.deepEqual(placedByLabel(copyNodeIds), placedByLabel(nodeIds));
  });
});

test("two topology commands at one revision: exactly one saves, the other is stale, nothing is half-applied", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, database }) => {
    const owner = await user("Owner"); const editor = await user("Editor");
    const { projectId, draftId, flowId } = await seeded(project, owner, []);
    await join(owner, projectId, editor);
    const revision = (await getDraft(owner, projectId, draftId)).documentRevision;
    const add = (who: Identity, label: string) => send(who, projectId, draftId, { command: "ADD_NODE", expectedDocumentRevision: revision, payload: { flowId, kind: "ACTION", label, description: "", actorLabel: "" } });
    const topologyStatusBefore = await getProjectStatus(owner, projectId);
    const topologyAuditsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId]);
    const topologyReceiptsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where scope_kind = 'PROJECT' and scope_id = $1", [projectId]);
    let topologyHolder = await holdProjectLock(projectId);
    let race: PromiseSettledResult<Awaited<ReturnType<typeof add>>>[];
    try {
      const pending = Promise.allSettled([add(owner, "Owner step"), add(editor, "Editor step")]);
      await waitForProjectLockWaiters(database, 2);
      await releaseHeldProjectLock(topologyHolder); topologyHolder = null!;
      race = await pending;
    } finally {
      if (topologyHolder) { await topologyHolder.query("rollback"); await topologyHolder.end(); }
    }
    assert.equal(race.filter((entry) => entry.status === "fulfilled").length, 1);
    assert(code("STALE_DOCUMENT_REVISION")((race.find((entry) => entry.status === "rejected") as PromiseRejectedResult).reason));
    const draft = await getDraft(owner, projectId, draftId);
    assert.equal(Object.keys(draft.document.nodes).length, 1);
    assert.equal(Object.keys(draft.layout.positions).length, 1);
    assert.equal((await getProjectStatus(owner, projectId)).eventSequence, topologyStatusBefore.eventSequence + 1);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId])).rows[0]!.count, topologyAuditsBefore.rows[0]!.count + 1);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where scope_kind = 'PROJECT' and scope_id = $1", [projectId])).rows[0]!.count, topologyReceiptsBefore.rows[0]!.count + 1);
  });
});

test("a lost acknowledgement retried after a newer save replays the old result without undoing the newer edit", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const { projectId, draftId, nodeIds } = await seeded(project, owner, ["A"]);
    const first = { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[0], label: "First" } };
    const key = randomUUID();
    const original = await send(owner, projectId, draftId, first, key);
    await send(owner, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 2, payload: { nodeId: nodeIds[0], label: "Second" } });
    const retried = await send(owner, projectId, draftId, first, key);
    assert.deepEqual({ ...retried, replayed: false }, original);
    assert.equal((await getDraft(owner, projectId, draftId)).document.nodes[nodeIds[0]!]!.label, "Second");
  });
});

test("event sequence exhaustion rejects before any draft, audit, or receipt write", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database, profileId }) => {
    const owner = await user();
    const { projectId, draftId, nodeIds } = await seeded(project, owner, ["A"]);
    const before = await getDraft(owner, projectId, draftId);
    await database.query("update app.project set event_sequence = $1 where id = $2", [Number.MAX_SAFE_INTEGER, projectId]);
    const auditBefore = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId]);
    const receiptsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where actor_id = $1", [await profileId(owner)]);
    await assert.rejects(send(owner, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[0], label: "Overflow" } }), code("VERSION_EXHAUSTED"));
    const after = await getDraft(owner, projectId, draftId);
    assert.deepEqual([after.documentRevision, after.layoutRevision, after.document.nodes[nodeIds[0]!]!.label], [before.documentRevision, before.layoutRevision, "A"]);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId])).rows[0]!.count, auditBefore.rows[0]!.count);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where actor_id = $1", [await profileId(owner)])).rows[0]!.count, receiptsBefore.rows[0]!.count);
  });
});
test("an invalid fresh result rolls back work, audit, and receipt", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database, profileId }) => {
    const owner = await user();
    const { projectId, draftId } = await seeded(project, owner, []);
    const before = await getDraft(owner, projectId, draftId);
    const profile = await profileId(owner);
    const auditsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId]);
    const receiptsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where actor_id = $1", [profile]);
    const key = randomUUID();
    await assert.rejects(
      draftMutation(owner, projectId, draftId, key, "OVERSIZED_RESULT", requestHash("OVERSIZED_RESULT", { projectId, draftId }), parseCommandResult, async (tx, lockedProject, lockedDraft, actorId) => {
        await tx.scopeDraft.update({ where: { id: lockedDraft.id }, data: { documentRevision: lockedDraft.documentRevision + 1 } });
        await recordEvent(tx, lockedProject, actorId, "OVERSIZED_RESULT", [], {});
        return { draftId: lockedDraft.id, documentRevision: lockedDraft.documentRevision + 1, layoutRevision: lockedDraft.layoutRevision, eventSequence: -1, createdIds: [], versions: {}, retiredIds: [] };
      }),
      code("UNAVAILABLE"),
    );
    const after = await getDraft(owner, projectId, draftId);
    assert.deepEqual([after.documentRevision, after.layoutRevision], [before.documentRevision, before.layoutRevision]);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId])).rows[0]!.count, auditsBefore.rows[0]!.count);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where actor_id = $1", [profile])).rows[0]!.count, receiptsBefore.rows[0]!.count);
  });
});
test("a command waiting on the project lock sees a committed downgrade before authoring", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, database, profileId }) => {
    const owner = await user("Owner"); const editor = await user("Editor");
    const { projectId, draftId, nodeIds } = await seeded(project, owner, ["A"]);
    await join(owner, projectId, editor);
    const editorId = await profileId(editor);
    const before = await getDraft(owner, projectId, draftId);
    const auditsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId]);
    const receiptsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where actor_id = $1", [editorId]);
    let holder = await holdProjectLock(projectId);
    try {
      const pending = assert.rejects(send(editor, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[0], label: "Late editor" } }), code("FORBIDDEN"));
      await waitForProjectLockWaiters(database, 1);
      await holder.query("update app.project_membership set role = 'VIEWER' where project_id = $1 and profile_id = $2", [projectId, editorId]);
      await releaseHeldProjectLock(holder); holder = null!;
      await pending;
    } finally {
      if (holder) { await holder.query("rollback"); await holder.end(); }
    }
    assert.equal((await getDraft(owner, projectId, draftId)).document.nodes[nodeIds[0]!]!.label, before.document.nodes[nodeIds[0]!]!.label);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId])).rows[0]!.count, auditsBefore.rows[0]!.count);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where actor_id = $1", [editorId])).rows[0]!.count, receiptsBefore.rows[0]!.count);
  });
});

test("a receipt retry waiting on the project lock sees a committed removal before replay", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, database, profileId }) => {
    const owner = await user("Owner"); const editor = await user("Editor");
    const { projectId, draftId, nodeIds } = await seeded(project, owner, ["A"]);
    await join(owner, projectId, editor);
    const editorId = await profileId(editor);
    const key = randomUUID();
    const body = { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[0], label: "Saved once" } };
    await send(editor, projectId, draftId, body, key);
    const auditsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId]);
    const receiptsBefore = await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where actor_id = $1", [editorId]);
    let holder = await holdProjectLock(projectId);
    try {
      const pending = assert.rejects(send(editor, projectId, draftId, body, key), code("NOT_FOUND"));
      await waitForProjectLockWaiters(database, 1);
      await holder.query("update app.project_membership set active = false, version = version + 1, deactivated_sequence = 1 where project_id = $1 and profile_id = $2", [projectId, editorId]);
      await releaseHeldProjectLock(holder); holder = null!;
      await pending;
    } finally {
      if (holder) { await holder.query("rollback"); await holder.end(); }
    }
    assert.equal((await getDraft(owner, projectId, draftId)).document.nodes[nodeIds[0]!]!.label, "Saved once");
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId])).rows[0]!.count, auditsBefore.rows[0]!.count);
    assert.equal((await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where actor_id = $1", [editorId])).rows[0]!.count, receiptsBefore.rows[0]!.count);
  });
});
