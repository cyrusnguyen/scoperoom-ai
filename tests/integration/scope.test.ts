import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { MAX_VERSION } from "../../src/features/drafts/contracts/strict.ts";
import { executeGraphCommand, getDraft } from "../../src/features/drafts/server/execute-command.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { changeProjectMember, leaveProject, removeProjectMember } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { correctSource, createSource, updateSource } from "../../src/features/sources/server/sources.ts";
import { canRun, withFixture, type Identity } from "./support/fixture.ts";

const refused = (code: string) => (error: unknown) => error instanceof ProjectError && error.code === code;
const key = () => `scope-${randomUUID()}`;
const fields = { title: "Pay by card", statement: "", category: "FUNCTIONAL", inclusion: "UNDECIDED", sourceRefs: [], ownerId: null, verification: null };
const send = (who: Identity, projectId: string, draftId: string, body: Record<string, unknown>) =>
  executeGraphCommand(who, projectId, draftId, { key: key(), commandSchemaVersion: 1, ...body });

test("removal and leave unassign current requirements", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user("unassign owner"), editor = await user("unassign editor"), reviewer = await user("unassign reviewer");
    const projectId = await project(owner);
    await join(owner, projectId, editor, "EDITOR");
    await join(owner, projectId, reviewer, "REVIEWER");
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const [editorId, reviewerId] = [await profileId(editor), await profileId(reviewer)];
    const a = await send(owner, projectId, draftId, { command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: { ...fields, ownerId: editorId } });
    const b = await send(owner, projectId, draftId, { command: "CREATE_REQUIREMENT", expectedDocumentRevision: 2, payload: { ...fields, ownerId: reviewerId } });
    const before = await getDraft(owner, projectId, draftId);
    const historicalId = randomUUID();
    await database.query("insert into app.scope_draft (id, project_id, created_by, document_revision, layout_revision, schema_version, document_json, layout_json, status) select $2, project_id, created_by, document_revision, layout_revision, schema_version, document_json, layout_json, 'ARCHIVED' from app.scope_draft where id = $1", [draftId, historicalId]);
    const historical = await getDraft(owner, projectId, historicalId);

    const { rows: [membership] } = await database.query<{ version: number }>("select version from app.project_membership where project_id = $1 and profile_id = $2 and active", [projectId, editorId]);
    const downgrade = await changeProjectMember(owner, projectId, editorId, { role: "VIEWER", key: key(), expectedMemberVersion: membership!.version });
    assert.deepEqual(await getDraft(owner, projectId, draftId), before, "a role downgrade retains existing ownership");
    const removal = { key: key(), expectedMemberVersion: downgrade.memberVersion! };
    await removeProjectMember(owner, projectId, editorId.toUpperCase(), removal);
    assert.equal((await removeProjectMember(owner, projectId, editorId.toUpperCase(), removal)).replayed, true);
    const leave = { key: key() };
    await leaveProject(reviewer, projectId, leave);
    assert.equal((await leaveProject(reviewer, projectId, leave)).replayed, true);

    const after = await getDraft(owner, projectId, draftId);
    assert.deepEqual(await getDraft(owner, projectId, historicalId), historical, "historical draft ownership and authorship are retained");
    for (const id of [a.createdIds[0]!, b.createdIds[0]!]) {
      assert.equal(after.document.requirements[id]!.ownerId, null);
      assert.equal(after.document.requirements[id]!.version, before.document.requirements[id]!.version + 1);
      assert.equal(after.document.requirements[id]!.behaviourVersion, before.document.requirements[id]!.behaviourVersion);
    }
    assert.equal(after.documentRevision, before.documentRevision + 2, "each new removal advances once; receipt replays do not");
    assert.equal(after.layoutRevision, before.layoutRevision);
    assert.deepEqual(after.layout, before.layout);
  });
});

test("unassignment version exhaustion rolls back member removal", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user("unassign exhaustion owner"), editor = await user("unassign exhaustion editor");
    const projectId = await project(owner);
    await join(owner, projectId, editor, "EDITOR");
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const editorId = await profileId(editor);
    const created = await send(owner, projectId, draftId, { command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: { ...fields, ownerId: editorId } });
    const requirementId = created.createdIds[0]!;
    await database.query("update app.scope_draft set document_json = jsonb_set(document_json, ARRAY['requirements', $2, 'version'], to_jsonb($3::int), false) where id = $1", [draftId, requirementId, MAX_VERSION]);
    const before = await getDraft(owner, projectId, draftId);
    const { rows: [membership] } = await database.query<{ active: boolean; version: number }>("select active, version from app.project_membership where project_id = $1 and profile_id = $2", [projectId, editorId]);
    const removalKey = key();

    await assert.rejects(removeProjectMember(owner, projectId, editorId, { key: removalKey, expectedMemberVersion: membership!.version }), refused("VERSION_EXHAUSTED"));

    const { rows: [afterMembership] } = await database.query<{ active: boolean; version: number }>("select active, version from app.project_membership where project_id = $1 and profile_id = $2", [projectId, editorId]);
    assert.deepEqual(afterMembership, membership, "the failed removal keeps access intact");
    assert.deepEqual(await getDraft(owner, projectId, draftId), before, "the failed removal keeps the draft intact");
    const { rows: [effects] } = await database.query<{ events: number; receipts: number }>("select (select count(*)::int from app.audit_event where project_id = $1 and action = 'PROJECT_MEMBER_REMOVED') as events, (select count(*)::int from app.mutation_receipt where scope_id = $1 and key = $2) as receipts", [projectId, removalKey]);
    assert.deepEqual(effects, { events: 0, receipts: 0 });
  });
});

test("requirements cite exact same-project source lines, including archived historical versions", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user("scope owner"), reviewer = await user("scope reviewer"), stranger = await user("stranger");
    const projectId = await project(owner);
    await join(owner, projectId, reviewer, "REVIEWER");
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const source = await createSource(owner, projectId, { key: key(), title: "Brief", text: "Customers pay by card.\nRefunds take 5 days." });
    const cite = (sourceVersionId: string, startLine: number, endLine: number, excerpt: string) => ({ ...fields, sourceRefs: [{ sourceVersionId, startLine, endLine, excerpt }] });
    const snapshot = () => database.query(
      "select (select document_revision from app.scope_draft where id = $2) revision, (select requirement_display_sequence from app.project where id = $1) sequence, (select count(*)::int from app.audit_event where project_id = $1) events, (select count(*)::int from app.mutation_receipt where scope_id = $1) receipts",
      [projectId, draftId],
    ).then((result) => result.rows[0]);

    const created = await send(owner, projectId, draftId, { command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: cite(source.sourceVersionId, 1, 1, "pay by card") });
    const requirementId = created.createdIds[0]!;
    const beforeRefusal = await snapshot();
    for (const ref of [
      cite(source.sourceVersionId, 1, 1, "Refunds"),
      cite(source.sourceVersionId, 3, 3, "invented"),
      cite(source.sourceVersionId, 1, 1, "invented"),
    ]) await assert.rejects(send(owner, projectId, draftId, { command: "CREATE_REQUIREMENT", expectedDocumentRevision: 2, payload: ref }), refused("INVALID_SOURCE_REFERENCE"));
    const foreign = await createSource(stranger, await project(stranger), { key: key(), title: "Theirs", text: "secret" });
    await assert.rejects(send(owner, projectId, draftId, { command: "CREATE_REQUIREMENT", expectedDocumentRevision: 2, payload: cite(foreign.sourceVersionId, 1, 1, "secret") }), refused("INVALID_SOURCE_REFERENCE"));
    assert.deepEqual(await snapshot(), beforeRefusal, "bad citations do not consume a label, event, or receipt");

    const corrected = await correctSource(owner, projectId, source.sourceId, { key: key(), expectedSourceRecordVersion: 1, expectedCurrentVersionId: source.sourceVersionId, title: "Brief", text: "Changed." });
    await updateSource(owner, projectId, source.sourceId, { key: key(), expectedSourceRecordVersion: corrected.version, archived: true });
    const keptRef = { sourceVersionId: source.sourceVersionId, startLine: 1, endLine: 1, excerpt: "pay by card" };
    const owned = await send(owner, projectId, draftId, { command: "UPDATE_REQUIREMENT", expectedEntityVersion: 1, payload: { requirementId, ownerId: await profileId(reviewer), title: "Pay by card or wallet", sourceRefs: [keptRef] } });
    assert.equal(owned.versions[requirementId], 2, "an archived old version citation remains valid after correction");
    await assert.rejects(send(owner, projectId, draftId, { command: "UPDATE_REQUIREMENT", expectedEntityVersion: 2, payload: { requirementId, ownerId: await profileId(stranger) } }), refused("INVALID_INPUT"));
    await assert.rejects(send(reviewer, projectId, draftId, { command: "UPDATE_REQUIREMENT", expectedEntityVersion: 2, payload: { requirementId, title: "Rewrite" } }), refused("FORBIDDEN"));
    assert.equal((await getDraft(owner, projectId, draftId)).document.requirements[requirementId]!.title, "Pay by card or wallet");
  });
});

test("labels never reuse or advance on replay or refusal, and viewers cannot own work", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user("label owner"), viewer = await user("label viewer");
    const projectId = await project(owner);
    await join(owner, projectId, viewer, "VIEWER");
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const firstKey = key();
    const firstBody = { key: firstKey, commandSchemaVersion: 1, command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: fields };
    const first = await executeGraphCommand(owner, projectId, draftId, firstBody);
    assert.equal((await executeGraphCommand(owner, projectId, draftId, firstBody)).replayed, true);
    await send(owner, projectId, draftId, { command: "DELETE_REQUIREMENT", expectedDocumentRevision: 2, payload: { requirementId: first.createdIds[0], removeLinkIds: [] } });
    const second = await send(owner, projectId, draftId, { command: "CREATE_REQUIREMENT", expectedDocumentRevision: 3, payload: fields });
    assert.equal((await getDraft(owner, projectId, draftId)).document.requirements[second.createdIds[0]!]!.displayId, "REQ-002");
    const counter = () => database.query("select requirement_display_sequence as sequence from app.project where id = $1", [projectId]).then((result) => result.rows[0]);
    const before = await counter();
    await assert.rejects(send(owner, projectId, draftId, { command: "UPDATE_REQUIREMENT", expectedEntityVersion: 1, payload: { requirementId: second.createdIds[0], ownerId: await profileId(viewer) } }), refused("INVALID_INPUT"));
    assert.deepEqual(await counter(), before, "refused ownership does not change the label counter");
  });
});

test("a step deletion saves its link removal; a link confirm never bumps endpoints", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user("link owner");
    const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const flow = await send(owner, projectId, draftId, { command: "CREATE_FLOW", expectedDocumentRevision: 1, payload: { title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" } });
    const flowId = flow.createdIds[0]!;
    const node = await send(owner, projectId, draftId, { command: "ADD_NODE", expectedDocumentRevision: 2, payload: { flowId, kind: "ACTION", label: "Pay", description: "", actorLabel: "" } });
    const requirement = await send(owner, projectId, draftId, { command: "CREATE_REQUIREMENT", expectedDocumentRevision: 3, payload: fields });
    const link = await send(owner, projectId, draftId, { command: "ADD_TRACE_LINK", expectedDocumentRevision: 4, payload: { requirementId: requirement.createdIds[0], nodeId: node.createdIds[0], explanation: "" } });
    const confirmed = await send(owner, projectId, draftId, { command: "CONFIRM_TRACE_LINK", expectedEntityVersion: 1, payload: { linkId: link.createdIds[0], expectedRequirementBehaviourVersion: 1, expectedNodeBehaviourVersion: 1 } });
    const after = await getDraft(owner, projectId, draftId);
    assert.equal(after.document.nodes[node.createdIds[0]!]!.behaviourVersion, 1);
    assert.equal(after.document.flows[flowId]!.behaviourVersion, 2, "only the ADD_NODE bumped the flow");
    const removed = await send(owner, projectId, draftId, { command: "DELETE_NODES", expectedDocumentRevision: confirmed.documentRevision, payload: { flowId, nodeIds: [node.createdIds[0]], removeEdgeIds: [] } });
    assert.ok(removed.retiredIds.includes(link.createdIds[0]!));
    assert.deepEqual((await getDraft(owner, projectId, draftId)).document.traceLinks, {});
    assert.equal((await getProjectStatus(owner, projectId)).documentRevision, removed.documentRevision);
  });
});

test("the requirement label counter refuses exhaustion without a partial write", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user("exhausted labels");
    const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    await database.query("update app.project set requirement_display_sequence = 999999999 where id = $1", [projectId]);
    const before = await getDraft(owner, projectId, draftId);
    await assert.rejects(send(owner, projectId, draftId, { command: "CREATE_REQUIREMENT", expectedDocumentRevision: before.documentRevision, payload: fields }), refused("VERSION_EXHAUSTED"));
    assert.deepEqual(await getDraft(owner, projectId, draftId), before);
  });
});

test("concurrent requirement creates serialize labels without burning one on stale refusal", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, database }) => {
    const owner = await user("label race owner"), editor = await user("label race editor");
    const projectId = await project(owner);
    await join(owner, projectId, editor);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const state = () => database.query<{ sequence: number; events: string; receipts: number }>(
      "select requirement_display_sequence as sequence, event_sequence as events, (select count(*)::int from app.mutation_receipt where scope_kind = 'PROJECT' and scope_id = $1) receipts from app.project where id = $1",
      [projectId],
    ).then((result) => result.rows[0]!);
    const before = await state();
    const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
    await holder.connect();
    let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof send>>>[]> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from app.project where id = $1 for update", [projectId]);
      const { rows: [held] } = await holder.query<{ pid: number }>("select pg_backend_pid()::int as pid");
      pending = Promise.allSettled([owner, editor].map((who) => send(who, projectId, draftId, {
        command: "CREATE_REQUIREMENT", expectedDocumentRevision: 1, payload: fields,
      })));
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const { rows: [row] } = await database.query<{ count: number }>(
          `with recursive holder_chain(pid) as (
            select $1::int
            union
            select waiting.pid from pg_stat_activity waiting
            join holder_chain blocker on blocker.pid = any(pg_blocking_pids(waiting.pid))
          )
          select count(*)::int as count from pg_stat_activity activity
          join holder_chain on holder_chain.pid = activity.pid
          where activity.wait_event_type = 'Lock' and activity.query like '%FROM app.project project%'`,
          [held!.pid],
        );
        if (row!.count >= 2) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(waiting, "both creates must reach the held project lock");
      await holder.query("commit");
      const race = await pending;
      assert.equal(race.filter((entry) => entry.status === "fulfilled").length, 1);
      const loser = race.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
      assert.ok(refused("STALE_DOCUMENT_REVISION")(loser.reason));
      const after = await state();
      assert.deepEqual(after, { sequence: 1, events: String(BigInt(before.events) + BigInt(1)), receipts: before.receipts + 1 });
      const draft = await getDraft(owner, projectId, draftId);
      assert.deepEqual(Object.values(draft.document.requirements).map((entry) => entry.displayId), ["REQ-001"]);
      const next = await send(owner, projectId, draftId, { command: "CREATE_REQUIREMENT", expectedDocumentRevision: draft.documentRevision, payload: fields });
      assert.equal((await getDraft(owner, projectId, draftId)).document.requirements[next.createdIds[0]!]!.displayId, "REQ-002");
    } finally {
      try { await holder.query("rollback"); } finally { await holder.end(); }
      await pending;
    }
  });
});


test("flow confirmation is exact, role guarded and replayable without repeating effects", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join, profileId, database }) => {
    const owner = await user("flow owner"), editor = await user("flow editor"), reviewer = await user("flow reviewer"), viewer = await user("flow viewer");
    const projectId = await project(owner);
    await join(owner, projectId, editor, "EDITOR");
    await join(owner, projectId, reviewer, "REVIEWER");
    await join(owner, projectId, viewer, "VIEWER");
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const flow = await send(owner, projectId, draftId, { command: "CREATE_FLOW", expectedDocumentRevision: 1, payload: { title: "Checkout", purpose: "", classification: "USER_JOURNEY", inclusion: "INCLUDED" } });
    const flowId = flow.createdIds[0]!;
    const node = await send(owner, projectId, draftId, { command: "ADD_NODE", expectedDocumentRevision: 2, payload: { flowId, kind: "ACTION", label: "Pay", description: "", actorLabel: "" } });
    const before = await getDraft(owner, projectId, draftId);
    const body = { key: key(), commandSchemaVersion: 1, command: "CONFIRM_FLOW", expectedEntityVersion: before.document.flows[flowId]!.version, payload: { flowId } };
    for (const reader of [reviewer, viewer]) await assert.rejects(executeGraphCommand(reader, projectId, draftId, body), refused("FORBIDDEN"));
    assert.deepEqual(await getDraft(owner, projectId, draftId), before);
    const confirmed = await executeGraphCommand(editor, projectId, draftId, body);
    const after = await getDraft(owner, projectId, draftId);
    const record = after.document.flows[flowId]!;
    assert.equal(record.confirmation?.actorId, await profileId(editor));
    assert.equal(record.confirmation?.behaviourVersion, before.document.flows[flowId]!.behaviourVersion);
    assert.ok(record.confirmation?.confirmedAt && !Number.isNaN(Date.parse(record.confirmation.confirmedAt)));
    assert.equal(record.version, before.document.flows[flowId]!.version + 1);
    assert.equal(record.behaviourVersion, before.document.flows[flowId]!.behaviourVersion);
    assert.equal(after.documentRevision, before.documentRevision + 1);
    assert.equal(after.layoutRevision, before.layoutRevision);
    assert.deepEqual(after.layout, before.layout);
    assert.deepEqual(after.document.nodes, before.document.nodes);
    assert.deepEqual(after.document.edges, before.document.edges);
    assert.deepEqual(after.document.traceLinks, before.document.traceLinks);
    const cursor = await getProjectStatus(owner, projectId);
    const replay = await executeGraphCommand(editor, projectId, draftId, body);
    assert.deepEqual(replay, { ...confirmed, replayed: true });
    assert.deepEqual(await getDraft(owner, projectId, draftId), after);
    const noop = await send(owner, projectId, draftId, { command: "CONFIRM_FLOW", expectedEntityVersion: record.version, payload: { flowId } });
    assert.equal(noop.documentRevision, after.documentRevision);
    assert.equal(noop.eventSequence, cursor.eventSequence);
    await assert.rejects(send(owner, projectId, draftId, { command: "CONFIRM_FLOW", expectedEntityVersion: body.expectedEntityVersion, payload: { flowId } }), refused("STALE_ENTITY_VERSION"));
    await send(owner, projectId, draftId, { command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: node.createdIds[0], label: "Pay by wallet" } });
    const changed = await getDraft(owner, projectId, draftId);
    assert.deepEqual(changed.document.flows[flowId]!.confirmation, record.confirmation);
    assert.equal(changed.document.flows[flowId]!.behaviourVersion, record.behaviourVersion + 1);
    await assert.rejects(send(owner, projectId, draftId, { command: "CONFIRM_FLOW", expectedEntityVersion: record.version, payload: { flowId } }), refused("STALE_ENTITY_VERSION"));
    assert.deepEqual(await getDraft(owner, projectId, draftId), changed);
    assert.equal((await executeGraphCommand(editor, projectId, draftId, body)).replayed, true, "exact replay still works after meaning advances");
    assert.deepEqual(await getDraft(owner, projectId, draftId), changed);
    const { rows: [membership] } = await database.query<{ version: number }>("select version from app.project_membership where project_id = $1 and profile_id = $2", [projectId, await profileId(editor)]);
    const downgraded = await changeProjectMember(owner, projectId, await profileId(editor), { key: key(), expectedMemberVersion: membership!.version, role: "VIEWER" });
    assert.equal((await executeGraphCommand(editor, projectId, draftId, body)).replayed, true, "admitted readers may replay completed receipts");
    await removeProjectMember(owner, projectId, await profileId(editor), { key: key(), expectedMemberVersion: downgraded.memberVersion! });
    await assert.rejects(executeGraphCommand(editor, projectId, draftId, body), refused("NOT_FOUND"), "removed access is checked before completed replay");
  });
});
