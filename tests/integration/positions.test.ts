import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { executeGraphCommand, getDraft } from "../../src/features/drafts/server/execute-command.ts";
import { previewArrangement, savePositions } from "../../src/features/drafts/server/positions.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { archiveProject } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { canRun, withFixture, type Identity } from "./support/fixture.ts";

const code = (expected: string) => (error: unknown) => error instanceof ProjectError && error.code === expected;
type Item = [nodeId: string, expectedPositionVersion: number, x: number, y: number];

/** A project whose draft holds one flow with `count` chained steps. */
async function seeded(project: (owner: Identity) => Promise<string>, owner: Identity, count: number) {
  const projectId = await project(owner);
  const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
  const send = async (body: Record<string, unknown>) => executeGraphCommand(owner, projectId, draftId, {
    commandSchemaVersion: 1, ...body, expectedDocumentRevision: (await getDraft(owner, projectId, draftId)).documentRevision, key: randomUUID(),
  });
  const flowId = (await send({ command: "CREATE_FLOW", payload: { title: "Flow", purpose: "", classification: "USER_JOURNEY", inclusion: "UNDECIDED" } })).createdIds[0]!;
  const nodeIds: string[] = [];
  for (let n = 0; n < count; n += 1) {
    nodeIds.push((await send({ command: "ADD_NODE", payload: { flowId, kind: n ? "ACTION" : "START", label: `Step ${n + 1}`, description: "", actorLabel: "" } })).createdIds[0]!);
    if (n) await send({ command: "ADD_EDGE", payload: { flowId, fromId: nodeIds[n - 1], toId: nodeIds[n], condition: "" } });
  }
  return { projectId, draftId, flowId, nodeIds };
}

const moveAs = (who: Identity, projectId: string, draftId: string, flowId: string, items: Item[], key = randomUUID()) =>
  savePositions(who, projectId, draftId, { mode: "MOVE_NODES", flowId, items: items.map(([nodeId, expectedPositionVersion, x, y]) => ({ nodeId, expectedPositionVersion, x, y })), key });

test("moves of different nodes both persist; a same-node race leaves one saved move and one POSITION_CONFLICT", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join }) => {
    const owner = await user("Owner"); const editor = await user("Editor");
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, 2);
    await join(owner, projectId, editor);
    await Promise.all([moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 1, 300, 0]]), moveAs(editor, projectId, draftId, flowId, [[nodeIds[1]!, 1, 300, 200]])]);
    let draft = await getDraft(owner, projectId, draftId);
    assert.deepEqual(nodeIds.map((id) => draft.layout.positions[id]), [{ x: 300, y: 0, version: 2 }, { x: 300, y: 200, version: 2 }]);

    const race = await Promise.allSettled([moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 2, 10, 10]]), moveAs(editor, projectId, draftId, flowId, [[nodeIds[0]!, 2, 20, 20]])]);
    assert.equal(race.filter((entry) => entry.status === "fulfilled").length, 1);
    const lost = race.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    assert(code("POSITION_CONFLICT")(lost.reason));
    assert.deepEqual((lost.reason as ProjectError).details, { nodeId: nodeIds[0], currentVersion: 3 });
    draft = await getDraft(owner, projectId, draftId);
    assert.equal(draft.layout.positions[nodeIds[0]!]!.version, 3);
  });
});

test("a multi-node move with one stale member moves nothing", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, 3);
    await moveAs(owner, projectId, draftId, flowId, [[nodeIds[2]!, 1, 500, 500]]);
    const before = await getDraft(owner, projectId, draftId);
    await assert.rejects(moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 1, 1, 1], [nodeIds[1]!, 1, 2, 2], [nodeIds[2]!, 1, 3, 3]]), code("POSITION_CONFLICT"));
    assert.deepEqual((await getDraft(owner, projectId, draftId)).layout, before.layout);
  });
});

test("position saves never touch the document; a label save and a move of the same node both succeed", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join }) => {
    const owner = await user("Owner"); const editor = await user("Editor");
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, 1);
    await join(owner, projectId, editor);
    const before = await getDraft(owner, projectId, draftId);
    await Promise.all([
      moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 1, 240, 80]]),
      executeGraphCommand(editor, projectId, draftId, { commandSchemaVersion: 1, command: "UPDATE_NODE", expectedEntityVersion: 1, payload: { nodeId: nodeIds[0], label: "Renamed" }, key: randomUUID() }),
    ]);
    const after = await getDraft(owner, projectId, draftId);
    assert.equal(after.document.nodes[nodeIds[0]!]!.label, "Renamed");
    assert.deepEqual(after.layout.positions[nodeIds[0]!], { x: 240, y: 80, version: 2 });
    assert.equal(after.documentRevision, before.documentRevision + 1, "only the label save advanced the document");
    assert.equal(after.layoutRevision, before.layoutRevision + 1, "only the move advanced the layout");
    // A move alone: behaviour versions and the document revision stay put.
    const flowBefore = after.document.flows[flowId]!;
    await moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 2, 0, 0]]);
    const moved = await getDraft(owner, projectId, draftId);
    assert.equal(moved.documentRevision, after.documentRevision);
    assert.deepEqual(moved.document.flows[flowId], flowBefore);
    assert.equal(moved.document.nodes[nodeIds[0]!]!.behaviourVersion, after.document.nodes[nodeIds[0]!]!.behaviourVersion);
  });
});

test("a late move of a deleted node is refused and the node stays deleted", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, 2);
    const draft = await getDraft(owner, projectId, draftId);
    const edgeIds = Object.keys(draft.document.edges);
    await executeGraphCommand(owner, projectId, draftId, { commandSchemaVersion: 1, command: "DELETE_NODES", expectedDocumentRevision: draft.documentRevision, payload: { flowId, nodeIds: [nodeIds[1]], removeEdgeIds: edgeIds }, key: randomUUID() });
    await assert.rejects(moveAs(owner, projectId, draftId, flowId, [[nodeIds[1]!, 1, 50, 50]]),
      (error: unknown) => code("POSITION_CONFLICT")(error) && (error as ProjectError).details?.currentVersion === null);
    const after = await getDraft(owner, projectId, draftId);
    assert.equal(after.document.nodes[nodeIds[1]!], undefined);
    assert.equal(after.layout.positions[nodeIds[1]!], undefined);
  });
});

test("an old move retried after a newer move replays without moving the node back; undo after someone else's move conflicts", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join }) => {
    const owner = await user("Owner"); const editor = await user("Editor");
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, 1);
    await join(owner, projectId, editor);
    const key = randomUUID();
    const first = await moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 1, 100, 100]], key);
    await moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 2, 200, 200]]);
    const retried = await moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 1, 100, 100]], key);
    assert.deepEqual({ ...retried, replayed: false }, first);
    assert.deepEqual((await getDraft(owner, projectId, draftId)).layout.positions[nodeIds[0]!], { x: 200, y: 200, version: 3 });
    // The owner's "undo" of their last move (back to 100,100 from version 3) loses to the editor's newer move.
    await moveAs(editor, projectId, draftId, flowId, [[nodeIds[0]!, 3, 300, 300]]);
    await assert.rejects(moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 3, 100, 100]]), code("POSITION_CONFLICT"));
    assert.deepEqual((await getDraft(owner, projectId, draftId)).layout.positions[nodeIds[0]!], { x: 300, y: 300, version: 4 });
  });
});

test("an arrangement applies only against its previewed pair, never a forged or stale one", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, 3);
    let draft = await getDraft(owner, projectId, draftId);
    const request = { flowId, expectedDocumentRevision: draft.documentRevision, expectedLayoutRevision: draft.layoutRevision, direction: "LR" as const };
    const preview = await previewArrangement(owner, projectId, draftId, request);
    assert.deepEqual(await previewArrangement(owner, projectId, draftId, request), preview, "previews are deterministic");
    const apply = (hash: string, layoutRevision = draft.layoutRevision) => savePositions(owner, projectId, draftId, {
      mode: "ARRANGE_FLOW", flowId, expectedDocumentRevision: draft.documentRevision, expectedLayoutRevision: layoutRevision, direction: "LR",
      algorithmVersion: preview.algorithmVersion, arrangementHash: hash, key: randomUUID(),
    });
    await assert.rejects(apply("0".repeat(64)), code("ARRANGEMENT_PREVIEW_CHANGED"));
    // Someone moves a step after the preview: the preview is stale.
    await moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 1, 999, 999]]);
    await assert.rejects(apply(preview.arrangementHash), code("STALE_LAYOUT_REVISION"));
    // A fresh preview applies; saved positions equal the preview; the document is untouched.
    draft = await getDraft(owner, projectId, draftId);
    const fresh = await previewArrangement(owner, projectId, draftId, { ...request, expectedLayoutRevision: draft.layoutRevision });
    const saved = await savePositions(owner, projectId, draftId, {
      mode: "ARRANGE_FLOW", flowId, expectedDocumentRevision: draft.documentRevision, expectedLayoutRevision: draft.layoutRevision, direction: "LR",
      algorithmVersion: fresh.algorithmVersion, arrangementHash: fresh.arrangementHash, key: randomUUID(),
    });
    const after = await getDraft(owner, projectId, draftId);
    assert.equal(after.layout.directions[flowId], "LR");
    assert.equal(after.documentRevision, draft.documentRevision);
    for (const nodeId of nodeIds) assert.deepEqual({ x: after.layout.positions[nodeId]!.x, y: after.layout.positions[nodeId]!.y }, fresh.positions[nodeId]);
    assert.equal(saved.layoutRevision, draft.layoutRevision + 1);
  });
});

test("readers cannot move or arrange; archived projects refuse both; limits are enforced", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, join }) => {
    const owner = await user("Owner"); const viewer = await user("Viewer");
    const { projectId, draftId, flowId, nodeIds } = await seeded(project, owner, 1);
    await join(owner, projectId, viewer, "VIEWER");
    const draft = await getDraft(owner, projectId, draftId);
    const request = { flowId, expectedDocumentRevision: draft.documentRevision, expectedLayoutRevision: draft.layoutRevision, direction: "TB" };
    await assert.rejects(moveAs(viewer, projectId, draftId, flowId, [[nodeIds[0]!, 1, 5, 5]]), code("FORBIDDEN"));
    await assert.rejects(previewArrangement(viewer, projectId, draftId, request), code("FORBIDDEN"));
    await assert.rejects(moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 1, 100_001, 5]]), code("INVALID_INPUT"));
    const status = await getProjectStatus(owner, projectId);
    await archiveProject(owner, projectId, { expectedProjectVersion: status.version, reason: "Done", key: randomUUID() });
    await assert.rejects(moveAs(owner, projectId, draftId, flowId, [[nodeIds[0]!, 1, 5, 5]]), code("CONFLICT"));
    await assert.rejects(previewArrangement(owner, projectId, draftId, request), code("CONFLICT"));
  });
});
