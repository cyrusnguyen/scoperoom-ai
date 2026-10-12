import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getMe } from "../../src/features/access/server/me.ts";
import { createProject, listProjects } from "../../src/features/projects/server/projects.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { canRun, withFixture } from "./support/fixture.ts";

// Default account plan (2026-10-12): no pilot_entitlement row is the default plan; a row is an override.
const code = (expected: string) => (error: unknown) => error instanceof ProjectError && error.code === expected;

test("an account without an override owns up to ten projects, and concurrent creates at nine admit exactly one", { skip: !canRun }, async () => {
  await withFixture(async ({ user, database, profileId }) => {
    const owner = await user();
    assert.deepEqual((await listProjects(owner)).capacity, { entitled: true, activeOwned: 0, maxOwned: 10, canCreate: true });
    for (let index = 1; index <= 9; index++) await createProject(owner, { name: `Project ${index}`, key: randomUUID() });
    const results = await Promise.allSettled([createProject(owner, { name: "Tab A", key: randomUUID() }), createProject(owner, { name: "Tab B", key: randomUUID() })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(code("OWNED_PROJECT_LIMIT")(rejected.reason));
    assert.deepEqual((rejected.reason as ProjectError).details, { activeOwned: 10, maxOwned: 10 });
    const { rows: [count] } = await database.query<{ n: number }>("select count(*)::int as n from app.project where owner_id = $1 and status = 'ACTIVE'", [await profileId(owner)]);
    assert.equal(count!.n, 10);
    const { rows: [rows] } = await database.query<{ n: number }>("select count(*)::int as n from app.pilot_entitlement where profile_id = $1", [await profileId(owner)]);
    assert.equal(rows!.n, 0, "the default plan never writes an entitlement row");
  });
});

test("an inactive or revoked override blocks ownership; an expired override falls back to the default plan", { skip: !canRun }, async () => {
  await withFixture(async ({ user, entitle, database, profileId }) => {
    const owner = await user();
    await entitle(owner, 1);
    const profile = await profileId(owner);
    await database.query("update app.pilot_entitlement set active = false where profile_id = $1", [profile]);
    await assert.rejects(createProject(owner, { name: "Inactive", key: randomUUID() }), code("ENTITLEMENT_REQUIRED"));
    assert.deepEqual((await getMe(owner)).entitlement, { active: false, maxOwnedProjects: 0 });
    await database.query("update app.pilot_entitlement set active = true, revoked_at = now() where profile_id = $1", [profile]);
    await assert.rejects(createProject(owner, { name: "Revoked", key: randomUUID() }), code("ENTITLEMENT_REQUIRED"));
    assert.equal((await listProjects(owner)).capacity.canCreate, false);
    await database.query("update app.pilot_entitlement set revoked_at = null, expires_at = now() - interval '1 minute' where profile_id = $1", [profile]);
    await createProject(owner, { name: "First", key: randomUUID() });
    await createProject(owner, { name: "Second, above the expired override's limit", key: randomUUID() });
    assert.deepEqual((await listProjects(owner)).capacity, { entitled: true, activeOwned: 2, maxOwned: 10, canCreate: true });
    assert.deepEqual((await getMe(owner)).entitlement, { active: true, maxOwnedProjects: 10 });
  });
});

test("AI authority follows the plan: no row or an expired override allows the owner's editors; an inactive or revoked override does not", { skip: !canRun }, async () => {
  await withFixture(async ({ user, entitle, join, database, profileId }) => {
    const owner = await user(), editor = await user(), reviewer = await user();
    const projectId = (await createProject(owner, { name: "Plan authority", key: randomUUID() })).id;
    await join(owner, projectId, editor);
    await join(owner, projectId, reviewer, "REVIEWER");
    const [ownerId, editorId, reviewerId] = [await profileId(owner), await profileId(editor), await profileId(reviewer)];
    const may = async (actor: string) => (await database.query<{ allowed: boolean }>("select app.ai_actor_may_run($1, $2) as allowed", [projectId, actor])).rows[0]!.allowed;
    assert.deepEqual([await may(ownerId), await may(editorId), await may(reviewerId)], [true, true, false]);
    await entitle(owner);
    await database.query("update app.pilot_entitlement set active = false where profile_id = $1", [ownerId]);
    assert.deepEqual([await may(ownerId), await may(editorId)], [false, false]);
    await database.query("update app.pilot_entitlement set active = true, revoked_at = now() where profile_id = $1", [ownerId]);
    assert.equal(await may(editorId), false);
    await database.query("update app.pilot_entitlement set revoked_at = null, expires_at = now() - interval '1 minute' where profile_id = $1", [ownerId]);
    assert.deepEqual([await may(ownerId), await may(editorId)], [true, true]);
  });
});
