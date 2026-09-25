import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { createWorkspace, getWorkspaceHome } from "../../src/features/workspaces/server/workspaces.ts";
import { createProject, getProjectBootstrap, getWorkspaceProjects, ProjectError } from "../../src/features/projects/server/projects.ts";
import { acceptInvitation, issueInvitation, listProjectInvitations, revokeInvitation } from "../../src/features/projects/server/invitations.ts";

type Identity = { authUserId: string; displayName: string; verifiedEmail: string };
const canRun = Boolean(process.env.E2E_SUPABASE_URL && process.env.E2E_SUPABASE_SECRET_KEY && process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL);

async function withFixture(run: (fixture: {
  user: () => Promise<Identity>;
  project: (owner: Identity) => Promise<{ workspaceId: string; projectId: string }>;
  database: Client;
}) => Promise<void>) {
  const admin = createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const database = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  const authIds: string[] = [];
  await database.connect();
  try {
    await run({
      user: async () => {
        const verifiedEmail = `invite-${randomUUID()}@example.test`;
        const displayName = "Invitation Test";
        const { data, error } = await admin.auth.admin.createUser({ email: verifiedEmail, password: `Invite-${randomUUID()}-Pass!`, email_confirm: true, user_metadata: { full_name: displayName } });
        if (error || !data.user) throw error ?? new Error("Could not create test user.");
        authIds.push(data.user.id);
        const identity = { authUserId: data.user.id, displayName, verifiedEmail };
        await getWorkspaceHome(identity);
        return identity;
      },
      project: async (owner) => {
        const { rows: [profile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [owner.authUserId]);
        if (!profile) throw new Error("Profile missing.");
        await database.query("insert into app.pilot_entitlement (profile_id, max_workspaces, active, granted_by_operator) values ($1, 1, true, gen_random_uuid())", [profile.id]);
        const workspace = await createWorkspace(owner, { name: "Owner workspace", key: randomUUID() });
        const project = await createProject(owner, { workspaceId: workspace.id, name: "Shared project", key: randomUUID() });
        return { workspaceId: workspace.id, projectId: project.id };
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

test("owner invitation issue replays safe metadata without retaining its token", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user();
    const member = await user();
    const { projectId } = await project(owner);
    const input = { verifiedEmail: member.verifiedEmail, role: "EDITOR" as const, key: randomUUID() };
    const issued = await issueInvitation(owner, projectId, input);
    assert.equal(issued.replayed, false);
    assert.equal(issued.linkUnavailable, false);
    assert.match(issued.url ?? "", /\/invite\//);
    const token = issued.url?.split("/").at(-1);
    assert.ok(token);
    const replayed = await issueInvitation(owner, projectId, input);
    assert.deepEqual(replayed, { ...issued, url: undefined, linkUnavailable: true, replayed: true });
    const { rows: [stored] } = await database.query<{ token_hash: string; result: unknown }>("select token_hash, result from app.invitation join app.mutation_receipt on mutation_receipt.scope_id = invitation.project_id where invitation.id = $1", [issued.id]);
    assert.notEqual(stored?.token_hash, token);
    assert.doesNotMatch(JSON.stringify(stored?.result), new RegExp(token!));
  });
});

test("accepted exact-email invite adds only that project's active member access", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const member = await user();
    const outsider = await user();
    const { workspaceId, projectId } = await project(owner);
    const issued = await issueInvitation(owner, projectId, { verifiedEmail: member.verifiedEmail, role: "REVIEWER", key: randomUUID() });
    const token = issued.url?.split("/").at(-1);
    assert.ok(token);
    await assert.rejects(acceptInvitation(outsider, { token, key: randomUUID() }), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");
    const key = randomUUID();
    const accepted = await acceptInvitation(member, { token, key });
    assert.deepEqual(accepted, { projectId, workspaceId, role: "REVIEWER", replayed: false });
    assert.deepEqual(await acceptInvitation(member, { token, key }), { ...accepted, replayed: true });
    assert.deepEqual((await getWorkspaceProjects(member, workspaceId)).projects.map(({ id }) => id), [projectId]);
    assert.equal((await getProjectBootstrap(member, projectId)).project.role, "REVIEWER");
  });
});
test("only an owner can inspect or revoke a pending invitation", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const member = await user();
    const outsider = await user();
    const { projectId } = await project(owner);
    const issued = await issueInvitation(owner, projectId, { verifiedEmail: member.verifiedEmail, role: "VIEWER", key: randomUUID() });
    await assert.rejects(listProjectInvitations(member, projectId), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");
    const listed = await listProjectInvitations(owner, projectId);
    assert.equal(listed.invitations[0]?.id, issued.id);
    await assert.rejects(revokeInvitation(member, projectId, issued.id, { expectedVersion: issued.version, key: randomUUID() }), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");
    const revoked = await revokeInvitation(owner, projectId, issued.id, { expectedVersion: issued.version, key: randomUUID() });
    assert.equal(revoked.status, "REVOKED");
    const token = issued.url?.split("/").at(-1);
    assert.ok(token);
    await assert.rejects(acceptInvitation(member, { token, key: randomUUID() }), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");
    await assert.rejects(acceptInvitation(outsider, { token, key: randomUUID() }), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");
  });
});

test("acceptance enforces the ten-person project collaborator cap", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user();
    const target = await user();
    const collaborators = await Promise.all(Array.from({ length: 9 }, () => user()));
    const { projectId } = await project(owner);
    const profiles = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = any($1::uuid[])", [collaborators.map(({ authUserId }) => authUserId)]);
    for (const profile of profiles.rows) {
      await database.query("insert into app.project_membership (project_id, profile_id, role) values ($1, $2, 'VIEWER')", [projectId, profile.id]);
    }
    const issued = await issueInvitation(owner, projectId, { verifiedEmail: target.verifiedEmail, role: "VIEWER", key: randomUUID() });
    const token = issued.url?.split("/").at(-1);
    assert.ok(token);
    await assert.rejects(acceptInvitation(target, { token, key: randomUUID() }), (error: unknown) => error instanceof ProjectError && error.code === "COLLABORATOR_LIMIT");
  });
});


test("acceptance reactivates an existing bookkeeping workspace membership", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user();
    const target = await user();
    const { workspaceId, projectId } = await project(owner);
    const { rows: [profile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [target.authUserId]);
    if (!profile) throw new Error("Target profile missing.");
    await database.query("insert into app.workspace_membership (workspace_id, profile_id, role, active) values ($1, $2, 'MEMBER', false)", [workspaceId, profile.id]);
    const issued = await issueInvitation(owner, projectId, { verifiedEmail: target.verifiedEmail, role: "EDITOR", key: randomUUID() });
    const token = issued.url?.split("/").at(-1);
    assert.ok(token);
    await acceptInvitation(target, { token, key: randomUUID() });
    const { rows: [membership] } = await database.query<{ active: boolean }>("select active from app.workspace_membership where workspace_id = $1 and profile_id = $2", [workspaceId, profile.id]);
    assert.equal(membership?.active, true);
    assert.equal((await getProjectBootstrap(target, projectId)).project.role, "EDITOR");
  });
});

test("invitation issue limits a project to fifty pending invitations", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const { projectId } = await project(owner);
    for (let index = 0; index < 50; index += 1) {
      await issueInvitation(owner, projectId, { verifiedEmail: `pending-${index}@example.test`, role: "VIEWER", key: randomUUID() });
    }
    await assert.rejects(
      issueInvitation(owner, projectId, { verifiedEmail: "overflow@example.test", role: "VIEWER", key: randomUUID() }),
      (error: unknown) => error instanceof ProjectError && error.code === "INVITATION_LIMIT",
    );
  });
});

test("same-key invitation acceptance returns the committed result to concurrent retries", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const target = await user();
    const { projectId, workspaceId } = await project(owner);
    const issued = await issueInvitation(owner, projectId, { verifiedEmail: target.verifiedEmail, role: "VIEWER", key: randomUUID() });
    const token = issued.url?.split("/").at(-1);
    assert.ok(token);
    const key = randomUUID();
    const accepted = await Promise.all([acceptInvitation(target, { token, key }), acceptInvitation(target, { token, key })]);
    assert.deepEqual(accepted.map(({ replayed }) => replayed).sort(), [false, true]);
    assert.deepEqual(accepted.map(({ projectId: resultProjectId, workspaceId: resultWorkspaceId, role }) => ({ projectId: resultProjectId, workspaceId: resultWorkspaceId, role })), [
      { projectId, workspaceId, role: "VIEWER" },
      { projectId, workspaceId, role: "VIEWER" },
    ]);
  });
});

test("accepted members can recover their established invitation after its expiry", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user();
    const target = await user();
    const { projectId, workspaceId } = await project(owner);
    const issued = await issueInvitation(owner, projectId, { verifiedEmail: target.verifiedEmail, role: "EDITOR", key: randomUUID() });
    const token = issued.url?.split("/").at(-1);
    assert.ok(token);
    await acceptInvitation(target, { token, key: randomUUID() });
    await database.query("update app.invitation set expires_at = current_timestamp - interval '1 second' where id = $1", [issued.id]);
    assert.deepEqual(await acceptInvitation(target, { token, key: randomUUID() }), { projectId, workspaceId, role: "EDITOR", replayed: true });
  });
});
test("project bootstrap and invitation index use compatible workspace read locks", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user();
    const { workspaceId, projectId } = await project(owner);
    await database.query("begin");
    let reads: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await database.query("select id from app.workspace where id = $1 for share", [workspaceId]);
      reads = Promise.all([getProjectBootstrap(owner, projectId), listProjectInvitations(owner, projectId)]);
      const completed = await Promise.race([
        reads.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1500); }),
      ]);
      assert.equal(completed, true, "read paths should not wait for an exclusive workspace lock");
    } finally {
      if (timer) clearTimeout(timer);
      await database.query("rollback");
      await reads?.catch(() => undefined);
    }
  });
});
