import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { createWorkspace, getWorkspaceHome } from "../../src/features/workspaces/server/workspaces.ts";
import { acceptInvitation, issueInvitation, listProjectInvitations } from "../../src/features/projects/server/invitations.ts";
import { ProjectError, createProject, getProjectBootstrap, getWorkspaceProjects } from "../../src/features/projects/server/projects.ts";
import { archiveProject, changeProjectMember, getProjectMembers, removeProjectMember, restoreProject, updateApprovalPolicy, updateProjectSettings } from "../../src/features/projects/server/management.ts";

type Identity = { authUserId: string; displayName: string; verifiedEmail: string };
const canRun = Boolean(process.env.E2E_SUPABASE_URL && process.env.E2E_SUPABASE_SECRET_KEY && process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL);

async function withFixture(run: (fixture: { user: () => Promise<Identity>; project: (owner: Identity) => Promise<{ workspaceId: string; projectId: string }>; database: Client }) => Promise<void>) {
  const admin = createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SECRET_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const database = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  const users: string[] = [];
  await database.connect();
  try {
    await run({
      user: async () => {
        const verifiedEmail = `management-${randomUUID()}@example.test`;
        const displayName = "Project Management Test";
        const { data, error } = await admin.auth.admin.createUser({ email: verifiedEmail, password: `Project-${randomUUID()}-Pass!`, email_confirm: true, user_metadata: { full_name: displayName } });
        if (error || !data.user) throw error ?? new Error("Could not create test user.");
        users.push(data.user.id);
        const identity = { authUserId: data.user.id, displayName, verifiedEmail };
        await getWorkspaceHome(identity);
        return identity;
      },
      project: async (owner) => {
        const { rows: [profile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [owner.authUserId]);
        if (!profile) throw new Error("Owner profile missing.");
        await database.query("insert into app.pilot_entitlement (profile_id, max_workspaces, active, granted_by_operator) values ($1, 1, true, gen_random_uuid())", [profile.id]);
        const workspaceId = (await createWorkspace(owner, { name: "Management workspace", key: randomUUID() })).id;
        const projectId = (await createProject(owner, { workspaceId, name: "Management project", key: randomUUID() })).id;
        return { workspaceId, projectId };
      },
      database,
    });
  } finally {
    if (users.length) {
      await database.query("delete from app.mutation_receipt where actor_id in (select id from app.user_profile where auth_user_id = any($1::uuid[]))", [users]);
      await database.query("delete from app.workspace where owner_id in (select id from app.user_profile where auth_user_id = any($1::uuid[]))", [users]);
      await database.query("delete from app.pilot_entitlement where profile_id in (select id from app.user_profile where auth_user_id = any($1::uuid[]))", [users]);
      await database.query("delete from app.user_profile where auth_user_id = any($1::uuid[])", [users]);
      await Promise.all(users.map((id) => admin.auth.admin.deleteUser(id)));
    }
    await database.end();
  }
}

test("owner manages member role, settings, approval policy, and each matching retry", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user();
    const member = await user();
    const { projectId } = await project(owner);
    const invitation = await issueInvitation(owner, projectId, { verifiedEmail: member.verifiedEmail, role: "VIEWER", key: randomUUID() });
    const token = invitation.url?.split("/").at(-1);
    assert.ok(token);
    await acceptInvitation(member, { token, key: randomUUID() });
    const firstMembers = await getProjectMembers(owner, projectId);
    const { rows: [memberProfile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [member.authUserId]);
    const target = firstMembers.members.find(({ profileId }) => profileId === memberProfile?.id);
    assert.ok(target);
    assert.equal(target.role, "VIEWER");
    const roleInput = { role: "REVIEWER", expectedMemberVersion: target.version, key: randomUUID() } as const;
    const changed = await changeProjectMember(owner, projectId, target.profileId, roleInput);
    assert.equal(changed.role, "REVIEWER");
    assert.deepEqual(await changeProjectMember(owner, projectId, target.profileId, roleInput), { ...changed, replayed: true });
    const policy = await updateApprovalPolicy(owner, projectId, { designatedApproverId: target.profileId, expectedApprovalPolicyVersion: changed.approvalPolicyVersion, key: randomUUID() });
    assert.equal(policy.designatedApproverId, target.profileId);
    const settings = await updateProjectSettings(owner, projectId, { name: "Renamed project", expectedSettingsVersion: changed.settingsVersion, key: randomUUID() });
    assert.equal(settings.name, "Renamed project");
    assert.equal(settings.approvalPolicyVersion, policy.approvalPolicyVersion);
    const removal = await removeProjectMember(owner, projectId, target.profileId, { expectedMemberVersion: changed.memberVersion, key: randomUUID() });
    assert.equal(removal.designatedApproverId, null);
    assert.ok(removal.approvalPolicyVersion > policy.approvalPolicyVersion);
    assert.ok(!(await getProjectMembers(owner, projectId)).members.some(({ profileId }) => profileId === target.profileId));
    await assert.rejects(updateProjectSettings(member, projectId, { name: "Denied", expectedSettingsVersion: settings.settingsVersion, key: randomUUID() }), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");
  });
});

test("archived projects retain admitted reads, revoke pending invitations, and reject new grants", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const member = await user();
    const pending = await user();
    const { workspaceId, projectId } = await project(owner);
    const memberInvitation = await issueInvitation(owner, projectId, { verifiedEmail: member.verifiedEmail, role: "REVIEWER", key: randomUUID() });
    const memberToken = memberInvitation.url?.split("/").at(-1);
    assert.ok(memberToken);
    await acceptInvitation(member, { token: memberToken, key: randomUUID() });
    const pendingInvitation = await issueInvitation(owner, projectId, { verifiedEmail: pending.verifiedEmail, role: "EDITOR", key: randomUUID() });
    const archived = await archiveProject(owner, projectId, { expectedProjectVersion: 1, reason: "Finished", key: randomUUID() });
    assert.equal(archived.status, "ARCHIVED");
    assert.equal((await getProjectBootstrap(member, projectId)).project.status, "ARCHIVED");
    assert.equal((await getWorkspaceProjects(member, workspaceId)).projects[0]?.status, "ARCHIVED");
    const membership = (await getProjectMembers(owner, projectId)).members.find(({ role }) => role === "REVIEWER");
    assert.ok(membership);
    await assert.rejects(
      changeProjectMember(owner, projectId, membership.profileId, { role: "EDITOR", expectedMemberVersion: membership.version, key: randomUUID() }),
      (error: unknown) => error instanceof ProjectError && error.code === "CONFLICT",
    );
    const downgraded = await changeProjectMember(owner, projectId, membership.profileId, { role: "VIEWER", expectedMemberVersion: membership.version, key: randomUUID() });
    assert.equal(downgraded.role, "VIEWER");
    await removeProjectMember(owner, projectId, membership.profileId, { expectedMemberVersion: downgraded.memberVersion!, key: randomUUID() });
    await assert.rejects(getProjectBootstrap(member, projectId), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");

    assert.equal((await listProjectInvitations(owner, projectId)).invitations.length, 0);
    await assert.rejects(issueInvitation(owner, projectId, { verifiedEmail: `later-${randomUUID()}@example.test`, role: "VIEWER", key: randomUUID() }), (error: unknown) => error instanceof ProjectError && error.code === "CONFLICT");
    const pendingToken = pendingInvitation.url?.split("/").at(-1);
    assert.ok(pendingToken);
    await assert.rejects(acceptInvitation(pending, { token: pendingToken, key: randomUUID() }), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");
    const restored = await restoreProject(owner, projectId, { expectedProjectVersion: archived.version, key: randomUUID() });
    assert.equal(restored.status, "ACTIVE");
  });
});
test("suspended workspaces deny project reads", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user();
    const member = await user();
    const { workspaceId, projectId } = await project(owner);
    const invitation = await issueInvitation(owner, projectId, { verifiedEmail: member.verifiedEmail, role: "VIEWER", key: randomUUID() });
    const token = invitation.url?.split("/").at(-1);
    assert.ok(token);
    await acceptInvitation(member, { token, key: randomUUID() });
    await database.query("update app.workspace set status = 'SUSPENDED' where id = $1", [workspaceId]);
    await assert.rejects(getWorkspaceProjects(member, workspaceId), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");
    await assert.rejects(getProjectBootstrap(member, projectId), (error: unknown) => error instanceof ProjectError && error.code === "NOT_FOUND");
  });
});
