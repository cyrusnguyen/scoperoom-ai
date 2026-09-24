import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { createWorkspace, getWorkspaceHome } from "../../src/features/workspaces/server/workspaces.ts";
import { ProjectError, createProject, getProjectBootstrap, getWorkspaceProjects } from "../../src/features/projects/server/projects.ts";

type Identity = { authUserId: string; displayName: string };
const canRun = Boolean(process.env.E2E_SUPABASE_URL && process.env.E2E_SUPABASE_SECRET_KEY && process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL);

async function withFixture(run: (fixture: {
  user: () => Promise<Identity>;
  ownerWorkspace: (identity: Identity) => Promise<string>;
  database: Client;
}) => Promise<void>) {
  const admin = createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const database = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  const authIds: string[] = [];
  await database.connect();
  try {
    await run({
      user: async () => {
        const displayName = "Project Test";
        const { data, error } = await admin.auth.admin.createUser({ email: `project-${randomUUID()}@example.test`, password: `Project-${randomUUID()}-Pass!`, email_confirm: true, user_metadata: { full_name: displayName } });
        if (error || !data.user) throw error ?? new Error("Could not create test user.");
        authIds.push(data.user.id);
        const identity = { authUserId: data.user.id, displayName };
        await getWorkspaceHome(identity);
        return identity;
      },
      ownerWorkspace: async (identity) => {
        const { rows: [profile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [identity.authUserId]);
        if (!profile) throw new Error("Profile missing.");
        await database.query("insert into app.pilot_entitlement (profile_id, max_workspaces, active, granted_by_operator) values ($1, 1, true, gen_random_uuid())", [profile.id]);
        return (await createWorkspace(identity, { name: "Owner workspace", key: randomUUID() })).id;
      },
      database,
    });
  } finally {
    if (authIds.length) {
      await database.query("delete from app.mutation_receipt where actor_id in (select id from app.user_profile where auth_user_id = any($1::uuid[]))", [authIds]);
      await database.query("delete from app.workspace where owner_id in (select id from app.user_profile where auth_user_id = any($1::uuid[]))", [authIds]);
      await database.query("delete from app.pilot_entitlement where profile_id in (select id from app.user_profile where auth_user_id = any($1::uuid[]))", [authIds]);
      await database.query("delete from app.user_profile where auth_user_id = any($1::uuid[])", [authIds]);
      await Promise.all(authIds.map((id) => admin.auth.admin.deleteUser(id)));
    }
    await database.end();
  }
}

test("project creation atomically saves one empty draft and replays a matching workspace key", { skip: !canRun }, async () => {
  await withFixture(async ({ user, ownerWorkspace, database }) => {
    const owner = await user();
    const workspaceId = await ownerWorkspace(owner);
    const input = { workspaceId, name: "First project", key: randomUUID() };
    const created = await createProject(owner, input);
    assert.equal(created.replayed, false);
    assert.deepEqual(await createProject(owner, input), { ...created, replayed: true });
    await assert.rejects(createProject(owner, { ...input, name: "Changed" }), (error: unknown) => error instanceof ProjectError && error.code === "KEY_REUSED");
    const { rows: [row] } = await database.query<{ project_count: number; draft_count: number; audit_count: number; receipt_count: number }>(`
      select (select count(*)::int from app.project where id = $1) project_count,
             (select count(*)::int from app.scope_draft where project_id = $1) draft_count,
             (select count(*)::int from app.audit_event where project_id = $1 and action = 'PROJECT_CREATED') audit_count,
             (select count(*)::int from app.mutation_receipt where scope_kind = 'WORKSPACE' and scope_id = $2 and key = $3) receipt_count`,
      [created.id, workspaceId, input.key],
    );
    assert.deepEqual(row, { project_count: 1, draft_count: 1, audit_count: 1, receipt_count: 1 });
    const bootstrap = await getProjectBootstrap(owner, created.id);
    assert.equal(bootstrap.project.role, "OWNER");
    assert.equal(bootstrap.draft.id, (await getWorkspaceProjects(owner, workspaceId)).projects[0]?.currentDraftId);
    assert.equal(bootstrap.draft.documentRevision, 1);
    assert.equal(bootstrap.draft.layoutRevision, 1);
    assert.deepEqual(bootstrap.draft.layoutJson, { schemaVersion: 1, positions: {}, directions: {} });
  });
});

test("a basic workspace member cannot read or create its owner's project", { skip: !canRun }, async () => {
  await withFixture(async ({ user, ownerWorkspace, database }) => {
    const owner = await user();
    const member = await user();
    const workspaceId = await ownerWorkspace(owner);
    const created = await createProject(owner, { workspaceId, name: "Private project", key: randomUUID() });
    const { rows: [memberProfile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [member.authUserId]);
    await database.query("insert into app.workspace_membership (workspace_id, profile_id, role) values ($1, $2, 'MEMBER')", [workspaceId, memberProfile.id]);
    assert.deepEqual((await getWorkspaceProjects(member, workspaceId)).projects, []);
    await assert.rejects(createProject(member, { workspaceId, name: "Denied", key: randomUUID() }), (error: unknown) => error instanceof ProjectError && error.code === "NOT_AUTHORIZED");
    await assert.rejects(getProjectBootstrap(member, created.id), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");
    await assert.rejects(getProjectBootstrap(await user(), created.id), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");
  });
});

test("revoked entitlement prevents new projects but preserves an owner's matching replay", { skip: !canRun }, async () => {
  await withFixture(async ({ user, ownerWorkspace, database }) => {
    const owner = await user();
    const workspaceId = await ownerWorkspace(owner);
    const input = { workspaceId, name: "Before revocation", key: randomUUID() };
    const created = await createProject(owner, input);
    await database.query("update app.pilot_entitlement set active = false where profile_id = (select id from app.user_profile where auth_user_id = $1)", [owner.authUserId]);
    assert.deepEqual(await createProject(owner, input), { ...created, replayed: true });
    await assert.rejects(createProject(owner, { workspaceId, name: "After revocation", key: randomUUID() }), (error: unknown) => error instanceof ProjectError && error.code === "NOT_ENTITLED");
  });
});
