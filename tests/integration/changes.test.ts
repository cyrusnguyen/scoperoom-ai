import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Client } from "pg";
import { executeGraphCommand, getDraft } from "../../src/features/drafts/server/execute-command.ts";
import { saveChanges } from "../../src/features/drafts/server/changes.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { archiveProject } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { CHANGES_BODY_LIMIT } from "../../src/features/drafts/contracts/changes.ts";
import { utf8Bytes } from "../../src/features/drafts/contracts/strict.ts";
import { largeDraft, largestBatch } from "../support/large-draft.ts";
import { canRun, withFixture, type Identity } from "./support/fixture.ts";

const refused = (expected: string, details?: Record<string, unknown>) => (error: unknown) =>
  error instanceof ProjectError && error.code === expected && Object.entries(details ?? {}).every(([key, value]) => error.details?.[key] === value);

const createFlow = (expectedDocumentRevision: number, proposedIds: string[]) => ({
  commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision, payload: { title: "Flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, proposedIds,
});
const addNode = (expectedDocumentRevision: number, flowId: string, proposedIds: string[], kind = "ACTION") => ({
  commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision, payload: { flowId, kind, label: "Step", description: "", actorLabel: "" }, proposedIds,
});
const addEdge = (expectedDocumentRevision: number, flowId: string, fromId: string, toId: string, proposedIds: string[]) => ({
  commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision, payload: { flowId, fromId, toId, condition: "" }, proposedIds,
});
const updateNode = (expectedEntityVersion: number, nodeId: string, label: string) => ({ commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion, payload: { nodeId, label } });

const events = async (database: Client, projectId: string) =>
  (await database.query<{ action: string }>("select action from app.audit_event where project_id = $1 order by sequence", [projectId])).rows.map((row) => row.action);

async function started(project: (owner: Identity) => Promise<string>, owner: Identity) {
  const projectId = await project(owner);
  const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
  return { projectId, draftId, base: await getDraft(owner, projectId, draftId) };
}

/** The batch a browser builds from its local replay of the saved draft at `revision`. */
function localBatch(revision: number) {
  const [flowId, start, next, edgeId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const commands = [
    createFlow(revision, [flowId]), addNode(revision + 1, flowId, [start], "START"), addNode(revision + 2, flowId, [next]),
    addEdge(revision + 3, flowId, start, next, [edgeId]), updateNode(1, next, "Renamed"),
  ];
  return { flowId, start, next, edgeId, body: { commands, moves: [{ flowId, items: [{ nodeId: next, expectedPositionVersion: 1, x: 420, y: 360 }] }] } };
}

test("a batch of commands and moves saves atomically with the proposed ids, and its key replays without re-applying", { skip: !canRun }, async () => {
  await withFixture(async ({ database, user, project }) => {
    const owner = await user();
    const { projectId, draftId, base } = await started(project, owner);
    const before = await events(database, projectId);
    const { flowId, start, next, edgeId, body } = localBatch(base.documentRevision);
    const key = randomUUID();
    const saved = await saveChanges(owner, projectId, draftId, { ...body, key });
    assert.deepEqual({ ...saved, eventSequence: 0 }, {
      draftId, documentRevision: base.documentRevision + 5, layoutRevision: base.layoutRevision + 1, eventSequence: 0,
      createdIds: [flowId, start, next, edgeId], versions: { [flowId]: 5, [next]: 2 }, positions: { [next]: { x: 420, y: 360, version: 2 } }, replayed: false,
    });
    const draft = await getDraft(owner, projectId, draftId);
    assert.equal(draft.documentRevision, saved.documentRevision);
    assert.equal(draft.layoutRevision, saved.layoutRevision);
    assert.equal(draft.document.flows[flowId]!.version, 5);
    assert.equal(draft.document.nodes[next]!.label, "Renamed");
    assert.deepEqual([draft.document.edges[edgeId]!.fromId, draft.document.edges[edgeId]!.toId], [start, next]);
    assert.deepEqual(draft.layout.positions[next], { x: 420, y: 360, version: 2 });
    const added = (await events(database, projectId)).slice(before.length);
    assert.deepEqual(added, [...Array(5).fill("DRAFT_COMMAND_SAVED"), "DRAFT_POSITIONS_SAVED"]);
    const { rows: [last] } = await database.query<{ sequence: string }>("select max(sequence)::text as sequence from app.audit_event where project_id = $1", [projectId]);
    assert.equal(saved.eventSequence, Number(last!.sequence));

    const replayed = await saveChanges(owner, projectId, draftId, { ...body, key });
    assert.deepEqual(replayed, { ...saved, replayed: true });
    assert.deepEqual(await getDraft(owner, projectId, draftId), draft);
    assert.equal((await events(database, projectId)).length, before.length + 6);
    await assert.rejects(saveChanges(owner, projectId, draftId, { ...localBatch(draft.documentRevision).body, key }), refused("KEY_REUSED"));
  });
});

test("a side-only RECONNECT_EDGE inside a batch saves the layout without a documentRevision of its own", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const { projectId, draftId, base } = await started(project, owner);
    const [flowId, start, next, edgeId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const setup = {
      commands: [createFlow(base.documentRevision, [flowId]), addNode(base.documentRevision + 1, flowId, [start], "START"), addNode(base.documentRevision + 2, flowId, [next]), addEdge(base.documentRevision + 3, flowId, start, next, [edgeId])],
      moves: [],
    };
    const saved = await saveChanges(owner, projectId, draftId, { ...setup, key: randomUUID() });
    const reconnectSides = {
      commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: saved.documentRevision,
      payload: { edgeId, fromId: start, toId: next, fromSide: "right", toSide: "left" }, proposedIds: [],
    };
    const withSides = await saveChanges(owner, projectId, draftId, { commands: [reconnectSides], moves: [], key: randomUUID() });
    assert.deepEqual([withSides.documentRevision, withSides.layoutRevision], [saved.documentRevision, saved.layoutRevision + 1]);
    assert.deepEqual(withSides.versions, {});
    const draft = await getDraft(owner, projectId, draftId);
    assert.deepEqual(draft.layout.edgeSides[edgeId], { from: "right", to: "left" });
  });
});

test("a refusal anywhere in the batch rolls back every item and names the failing one", { skip: !canRun }, async () => {
  await withFixture(async ({ database, user, project }) => {
    const owner = await user();
    const { projectId, draftId, base } = await started(project, owner);
    const before = await events(database, projectId);
    const { body } = localBatch(base.documentRevision);
    const staleCommand = { ...body, commands: body.commands.map((command, index) => (index === 2 ? { ...command, expectedDocumentRevision: base.documentRevision } : command)) };
    await assert.rejects(saveChanges(owner, projectId, draftId, { ...staleCommand, key: randomUUID() }),
      refused("STALE_DOCUMENT_REVISION", { part: "commands", index: 2, documentRevision: base.documentRevision + 2 }));
    const staleMove = { ...body, moves: [{ ...body.moves[0]!, items: [{ ...body.moves[0]!.items[0]!, expectedPositionVersion: 2 }] }] };
    await assert.rejects(saveChanges(owner, projectId, draftId, { ...staleMove, key: randomUUID() }),
      refused("POSITION_CONFLICT", { part: "moves", index: 0, currentVersion: 1 }));
    assert.deepEqual(await getDraft(owner, projectId, draftId), base);
    assert.deepEqual(await events(database, projectId), before);
  });
});

test("a foreign save between the local edit and Save refuses the batch", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join }) => {
    const owner = await user("Owner"); const editor = await user("Editor");
    const { projectId, draftId, base } = await started(project, owner);
    await join(owner, projectId, editor);
    const { body } = localBatch(base.documentRevision);
    const foreign = await executeGraphCommand(editor, projectId, draftId, {
      commandSchemaVersion: 1, command: "CREATE_FLOW", expectedDocumentRevision: base.documentRevision, payload: { title: "Theirs", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" }, key: randomUUID(),
    });
    await assert.rejects(saveChanges(owner, projectId, draftId, { ...body, key: randomUUID() }),
      refused("STALE_DOCUMENT_REVISION", { part: "commands", index: 0, documentRevision: foreign.documentRevision }));
    const after = await getDraft(owner, projectId, draftId);
    assert.deepEqual(Object.keys(after.document.flows), foreign.createdIds);
  });
});

test("proposed ids must be new and unique, readers and archived projects are refused, and limits are enforced", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join }) => {
    const owner = await user("Owner"); const viewer = await user("Viewer");
    const { projectId, draftId, base } = await started(project, owner);
    await join(owner, projectId, viewer, "VIEWER");
    const send = (who: Identity, body: Record<string, unknown>) => saveChanges(who, projectId, draftId, { ...body, key: randomUUID() });
    const flowId = randomUUID();
    await send(owner, { commands: [createFlow(base.documentRevision, [flowId])], moves: [] });
    const revision = base.documentRevision + 1;
    await assert.rejects(send(owner, { commands: [addNode(revision, flowId, [flowId])], moves: [] }), refused("INVALID_INPUT", { part: "commands", index: 0 }));
    const twice = randomUUID();
    await assert.rejects(send(owner, { commands: [addNode(revision, flowId, [twice]), addNode(revision + 1, flowId, [twice])], moves: [] }), refused("INVALID_INPUT", { part: "commands", index: 1 }));
    await assert.rejects(send(owner, { commands: [addNode(revision, flowId, [])], moves: [] }), refused("INVALID_INPUT", { part: "commands", index: 0 }));
    assert.deepEqual((await getDraft(owner, projectId, draftId)).document.nodes, {});

    await assert.rejects(send(viewer, { commands: [addNode(revision, flowId, [randomUUID()])], moves: [] }), refused("FORBIDDEN"));
    await assert.rejects(send(owner, { commands: [], moves: [] }), refused("INVALID_INPUT"));
    await assert.rejects(send(owner, { commands: Array.from({ length: 101 }, () => updateNode(1, flowId, "x")), moves: [] }), refused("INVALID_INPUT"));
    await assert.rejects(send(owner, { commands: [], moves: [{ flowId, items: Array.from({ length: 201 }, () => ({ nodeId: randomUUID(), expectedPositionVersion: 1, x: 0, y: 0 })) }] }), refused("INVALID_INPUT"));
    await assert.rejects(saveChanges(owner, projectId, draftId, { commands: [addNode(revision, flowId, [randomUUID()])], moves: [] }), refused("INVALID_INPUT"));

    const status = await getProjectStatus(owner, projectId);
    await archiveProject(owner, projectId, { expectedProjectVersion: status.version, reason: "Done", key: randomUUID() });
    await assert.rejects(send(owner, { commands: [addNode(revision, flowId, [randomUUID()])], moves: [] }), refused("CONFLICT"));
  });
});

test("the largest batch on a draft at its size limit saves well inside the transaction budget", { skip: !canRun }, async () => {
  await withFixture(async ({ database, user, project }) => {
    const owner = await user();
    const { projectId, draftId, base } = await started(project, owner);
    const large = largeDraft();
    await database.query("update app.scope_draft set document_json = $1::jsonb, layout_json = $2::jsonb where id = $3", [JSON.stringify(large.document), JSON.stringify(large.layout), draftId]);
    const before = await events(database, projectId);
    const body = largestBatch(large);
    assert(utf8Bytes(body) <= CHANGES_BODY_LIMIT);
    const clock = performance.now();
    const saved = await saveChanges(owner, projectId, draftId, { ...body, key: randomUUID() });
    const elapsed = performance.now() - clock;
    console.log(`largest batch on a ${utf8Bytes(large.document)}-byte draft saved in ${Math.round(elapsed)} ms`);
    assert.equal(saved.documentRevision, base.documentRevision + 100);
    assert.equal(saved.layoutRevision, base.layoutRevision + 1);
    assert.equal(Object.keys(saved.positions).length, 200);
    const draft = await getDraft(owner, projectId, draftId);
    assert.equal(Object.values(draft.document.nodes).filter((node) => node.label === "Renamed").length, 100);
    const added = (await events(database, projectId)).slice(before.length);
    assert.deepEqual(added, [...Array(100).fill("DRAFT_COMMAND_SAVED"), ...Array(5).fill("DRAFT_POSITIONS_SAVED")]);
    // Before the fix this batch ran past Prisma's 5 s default and failed as UNAVAILABLE (8.9 s); now it is about 1–1.7 s.
    assert(elapsed < 5_000, `the save took ${Math.round(elapsed)} ms`);
  });
});
