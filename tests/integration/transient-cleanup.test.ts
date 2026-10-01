import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { getProjectBootstrap } from "../../src/features/projects/server/projects.ts";
import { cleanupTransient } from "../../src/server/maintenance/cleanup-transient.ts";
import { canRun, withFixture } from "./support/fixture.ts";

test("transient cleanup dry-runs without mutation and sweeps expired previews in bounded batches", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, profileId, database }) => {
    const owner = await user("Cleanup owner");
    const projectId = await project(owner);
    const draftId = (await getProjectBootstrap(owner, projectId)).draft.id;
    const actorId = await profileId(owner);
    for (let index = 0; index < 101; index += 1) {
      await database.query(
        `insert into app.flow_import_preview (id, project_id, draft_id, actor_id, expected_document_revision, payload, positions, fidelity_report, preview_hash, expires_at, created_at)
         values ($1, $2, $3, $4, 1, '{"format":"scoperoom-flow"}'::jsonb, '[]'::jsonb, '{"nodeCount":0,"edgeCount":0,"omittedLinkHintCount":0,"geometry":"SUPPLIED"}'::jsonb, repeat('a', 64), now() - interval '1 second', now() - interval '2 days')`,
        [randomUUID(), projectId, draftId, actorId],
      );
    }
    const web = new Client({ connectionString: process.env.DATABASE_URL });
    await web.connect();
    try {
      await assert.rejects(web.query("update app.flow_import_preview set payload = null where project_id = $1", [projectId]), /permission denied/i);
    } finally {
      await web.end();
    }
    assert.equal((await cleanupTransient({ dryRun: true, batchSize: 100 })).expiredPreviews, 100);
    let count = await database.query<{ count: number }>("select count(*)::int as count from app.flow_import_preview where project_id = $1 and state = 'READY'", [projectId]);
    assert.equal(count.rows[0]!.count, 101, "dry-run leaves retained bodies and state unchanged");
    assert.equal((await cleanupTransient({ dryRun: false, batchSize: 100 })).expiredPreviews, 100);
    assert.equal((await cleanupTransient({ dryRun: false, batchSize: 100 })).expiredPreviews, 1);
    count = await database.query<{ count: number }>("select count(*)::int as count from app.flow_import_preview where project_id = $1 and state = 'EXPIRED' and payload is null", [projectId]);
    assert.equal(count.rows[0]!.count, 101);
  });
});
