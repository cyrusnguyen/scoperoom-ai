import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createProject, getProjectBootstrap, getProjectStatus, listProjects } from "../../src/features/projects/server/projects.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { canRun, withFixture } from "./support/fixture.ts";

const code = (expected: string) => (error: unknown) => error instanceof ProjectError && error.code === expected;

test("a named project is owned by its creator, replays by key and needs nothing else", { skip: !canRun }, async () => {
  await withFixture(async ({ user, entitle, database }) => {
    const owner = await user("Owner");
    await entitle(owner);
    const key = randomUUID();
    const created = await createProject(owner, { name: "  Booking  ", key });
    assert.deepEqual({ name: created.name, replayed: created.replayed }, { name: "Booking", replayed: false });
    assert.deepEqual(await createProject(owner, { name: "Booking", key }), { ...created, replayed: true });
    await assert.rejects(createProject(owner, { name: "Different", key }), code("KEY_REUSED"));
    const { rows: [row] } = await database.query<{ owner: string; events: number; designated: string | null }>(
      "select (select auth_user_id::text from app.user_profile where id = project.owner_id) as owner, (select count(*)::int from app.audit_event where project_id = project.id) as events, designated_approver_id as designated from app.project where id = $1",
      [created.id]);
    assert.deepEqual(row, { owner: owner.authUserId, events: 1, designated: null });
    const bootstrap = await getProjectBootstrap(owner, created.id);
    assert.equal(bootstrap.project.role, "OWNER");
    assert.equal(bootstrap.draft.documentRevision, 1);
  });
});

test("owning a project requires an active entitlement; accepting never does", { skip: !canRun }, async () => {
  await withFixture(async ({ user }) => {
    const person = await user();
    await assert.rejects(createProject(person, { name: "Denied", key: randomUUID() }), code("ENTITLEMENT_REQUIRED"));
  });
});

test("concurrent creates at max-1 admit exactly one project", { skip: !canRun }, async () => {
  await withFixture(async ({ user, entitle, database, profileId }) => {
    const owner = await user();
    await entitle(owner, 2);
    await createProject(owner, { name: "Existing", key: randomUUID() });
    const results = await Promise.allSettled([createProject(owner, { name: "Tab A", key: randomUUID() }), createProject(owner, { name: "Tab B", key: randomUUID() })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    assert.ok(code("OWNED_PROJECT_LIMIT")(rejected.reason));
    assert.deepEqual((rejected.reason as ProjectError).details, { activeOwned: 2, maxOwned: 2 });
    const { rows: [count] } = await database.query<{ n: number }>("select count(*)::int as n from app.project where owner_id = $1 and status = 'ACTIVE'", [await profileId(owner)]);
    assert.equal(count!.n, 2);
  });
});

test("the same key sent twice concurrently creates one project", { skip: !canRun }, async () => {
  await withFixture(async ({ user, entitle }) => {
    const owner = await user();
    await entitle(owner);
    const key = randomUUID();
    const [a, b] = await Promise.all([createProject(owner, { name: "Once", key }), createProject(owner, { name: "Once", key })]);
    assert.equal(a.id, b.id);
    assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
  });
});

test("a committed entitlement revocation denies a waiting create", { skip: !canRun }, async () => {
  await withFixture(async ({ user, entitle, database, profileId }) => {
    const owner = await user();
    await entitle(owner);
    await database.query("begin");
    await database.query("update app.pilot_entitlement set revoked_at = now() where profile_id = $1", [await profileId(owner)]);
    const pending = createProject(owner, { name: "Racing", key: randomUUID() });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await database.query("commit");
    await assert.rejects(pending, code("ENTITLEMENT_REQUIRED"));
  });
});

test("lowering the limit blocks new creation without touching existing projects", { skip: !canRun }, async () => {
  await withFixture(async ({ user, entitle }) => {
    const owner = await user();
    await entitle(owner, 3);
    await createProject(owner, { name: "One", key: randomUUID() });
    await createProject(owner, { name: "Two", key: randomUUID() });
    await entitle(owner, 1);
    await assert.rejects(createProject(owner, { name: "Three", key: randomUUID() }), code("OWNED_PROJECT_LIMIT"));
    assert.equal((await listProjects(owner)).owned.items.length, 2);
  });
});

test("lists group owned, shared and archived projects with truncation and server capacity", { skip: !canRun }, async () => {
  await withFixture(async ({ user, entitle, database, profileId, project }) => {
    const owner = await user("List Owner");
    const other = await user("Other Owner");
    await entitle(owner, 200);
    const ownerProfile = await profileId(owner);
    await database.query(`
      with ids as (select gen_random_uuid() as project_id, gen_random_uuid() as draft_id, g from generate_series(1, 101) g),
      p as (insert into app.project (id, owner_id, name, current_draft_id) select project_id, $1, 'Bulk ' || g, draft_id from ids returning id),
      d as (insert into app.scope_draft (id, project_id, created_by, document_json, layout_json) select draft_id, project_id, $1, '{}'::jsonb, '{}'::jsonb from ids returning id)
      select count(*) from p`, [ownerProfile]);
    const sharedId = await project(other, "Shared with owner");
    await database.query("insert into app.project_membership (project_id, profile_id, role) values ($1, $2, 'VIEWER')", [sharedId, ownerProfile]);
    const lists = await listProjects(owner);
    assert.equal(lists.owned.items.length, 100);
    assert.equal(lists.owned.truncated, true);
    assert.deepEqual(lists.shared.items.map((item) => [item.name, item.role, item.ownerName]), [["Shared with owner", "VIEWER", "Other Owner"]]);
    assert.deepEqual(lists.archived, { items: [], truncated: false });
    assert.deepEqual(lists.capacity, { entitled: true, activeOwned: 101, maxOwned: 200, canCreate: true });
    assert.deepEqual((await listProjects(other)).shared.items, []);
  });
});

test("ordinary reads do not wait for a held project write lock", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user();
    const projectId = await project(owner);
    await database.query("begin");
    let reads: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await database.query("select id from app.project where id = $1 for update", [projectId]);
      reads = Promise.all([getProjectBootstrap(owner, projectId), getProjectStatus(owner, projectId), listProjects(owner)]);
      const completed = await Promise.race([reads.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1500); })]);
      assert.equal(completed, true, "GET paths must not take row locks");
    } finally {
      if (timer) clearTimeout(timer);
      await database.query("rollback");
      await reads?.catch(() => undefined);
    }
  });
});

test("status carries the draft, revision, epoch and sequence fields; outsiders get NOT_FOUND", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const outsider = await user();
    const projectId = await project(owner);
    const status = await getProjectStatus(owner, projectId);
    assert.equal(status.status, "ACTIVE");
    assert.match(status.currentDraftId, /^[0-9a-f-]{36}$/);
    assert.equal(status.documentRevision, 1);
    assert.equal(status.layoutRevision, 1);
    assert.match(status.realtimeEpoch, /^[0-9a-f-]{36}$/);
    assert.equal(status.eventSequence, 1);
    await assert.rejects(getProjectStatus(outsider, projectId), code("NOT_FOUND"));
    await assert.rejects(getProjectBootstrap(outsider, projectId), code("NOT_FOUND"));
  });
});
