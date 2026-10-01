import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { getFlowImport, previewFlowImport } from "../../src/features/exchange/server/import-flow.ts";
import { canRun, withFixture } from "./support/fixture.ts";

const validFile = () => readFile(new URL("../fixtures/flow-files/valid.scoperoom-flow.json", import.meta.url));

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
    assert.deepEqual(await previewFlowImport(owner, projectId, draftId, previewId, key, await validFile()), preview);
    assert.deepEqual(await getFlowImport(owner, projectId, previewId), preview);
    assert.deepEqual(await getProjectStatus(owner, projectId), before);
    const { rows: [events] } = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1", [projectId]);
    assert.equal(events!.count, 1, "preview inspection does not add an audit event");
  });
});
