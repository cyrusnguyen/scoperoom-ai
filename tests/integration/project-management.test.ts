import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { acceptInvitation, issueInvitation, listProjectInvitations } from "../../src/features/projects/server/invitations.ts";
import {
  archiveProject, changeProjectMember, getProjectMembers, leaveProject, removeProjectMember, restoreProject, updateApprovalPolicy, updateProjectSettings,
} from "../../src/features/projects/server/management.ts";
import { createProject, getProjectBootstrap, getProjectStatus } from "../../src/features/projects/server/projects.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { canRun, withFixture, type Identity } from "./support/fixture.ts";

const code = (expected: string) => (error: unknown) => error instanceof ProjectError && error.code === expected;
async function waitForLockWaiters(database: Client, holderPid: number, expected: number) {
  const deadline = Date.now() + 5_000;
  let queries: string[] = [];
  while (Date.now() < deadline) {
    const result = await database.query<{ query: string }>(`
      with recursive holder_chain(pid) as (
        select $1::int
        union
        select waiting.pid from pg_stat_activity waiting
        join holder_chain blocker on blocker.pid = any(pg_blocking_pids(waiting.pid))
      )
      select activity.query from pg_stat_activity activity
      join holder_chain on holder_chain.pid = activity.pid
      where activity.wait_event_type = 'Lock'`, [holderPid]);
    queries = result.rows.map((row) => row.query);
    if (queries.filter((query) => query.includes("FROM app.project project")).length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected} leaves behind the held project lock: ${queries.join(" | ")}`);
}
type HeldProjectLock = { client: Client; pid: number };
async function holdProjectLock(projectId: string) {
  const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query("select id from app.project where id = $1 for update", [projectId]);
    const { rows: [row] } = await holder.query<{ pid: number }>("select pg_backend_pid()::int as pid");
    return { client: holder, pid: row!.pid };
  } catch (error) {
    await holder.end();
    throw error;
  }
}
async function releaseHeldProjectLock(holder: HeldProjectLock) {
  try { await holder.client.query("commit"); } finally { await holder.client.end(); }
}
async function join(owner: Identity, projectId: string, member: Identity, role: "EDITOR" | "REVIEWER" | "VIEWER" = "EDITOR") {
  const issued = await issueInvitation(owner, projectId, { verifiedEmail: member.verifiedEmail, role, key: randomUUID() });
  await acceptInvitation(member, { token: issued.url!.split("/").at(-1)!, key: randomUUID() });
}
async function member(owner: Identity, projectId: string, who: Identity) {
  return (await getProjectMembers(owner, projectId)).members.find((entry) => entry.displayName === who.displayName)!;
}

test("only the owner manages members, settings and lifecycle", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user("Owner"); const editor = await user("Editor");
    const projectId = await project(owner);
    await join(owner, projectId, editor);
    const status = await getProjectStatus(editor, projectId);
    await assert.rejects(updateProjectSettings(editor, projectId, { name: "Hijack", expectedSettingsVersion: status.settingsVersion, key: randomUUID() }), code("NOT_FOUND"));
    await assert.rejects(archiveProject(editor, projectId, { expectedProjectVersion: status.version, reason: "No", key: randomUUID() }), code("NOT_FOUND"));
    const self = await member(owner, projectId, editor);
    await assert.rejects(changeProjectMember(editor, projectId, self.profileId, { role: "VIEWER", expectedMemberVersion: self.version, key: randomUUID() }), code("NOT_FOUND"));
  });
});

test("non-owners can leave active and archived projects; the owner cannot", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user(); const a = await user("Leaver A"); const b = await user("Leaver B");
    const projectId = await project(owner);
    await join(owner, projectId, a); await join(owner, projectId, b);
    await assert.rejects(leaveProject(owner, projectId, { key: randomUUID() }), code("OWNER_CANNOT_LEAVE"));
    const key = randomUUID();
    assert.deepEqual(await leaveProject(a, projectId, { key }), { projectId, left: true, replayed: false });
    assert.deepEqual(await leaveProject(a, projectId, { key }), { projectId, left: true, replayed: true });
    await assert.rejects(getProjectBootstrap(a, projectId), code("NOT_FOUND"));
    await join(owner, projectId, a, "VIEWER");
    assert.equal((await getProjectBootstrap(a, projectId)).project.role, "VIEWER");
    await leaveProject(a, projectId, { key: randomUUID() });
    const status = await getProjectStatus(owner, projectId);
    await archiveProject(owner, projectId, { expectedProjectVersion: status.version, reason: "Done", key: randomUUID() });
    assert.equal((await leaveProject(b, projectId, { key: randomUUID() })).left, true);
  });
});

test("same-key leaves queued behind a project lock replay after membership ends", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const member = await user("Same-key leaver");
    const projectId = await project(owner);
    await join(owner, projectId, member);
    const key = randomUUID();
    let holder = await holdProjectLock(projectId);
    const leaves = [leaveProject(member, projectId, { key }), leaveProject(member, projectId, { key })];
    const settled = Promise.allSettled(leaves);
    try {
      await waitForLockWaiters(database, holder.pid, 2);
      await releaseHeldProjectLock(holder); holder = null!;
      const results = (await settled).map((result) => {
        if (result.status !== "fulfilled") throw result.reason;
        return result.value;
      });
      assert.deepEqual(results.map(({ replayed }) => replayed).sort(), [false, true]);
      for (const result of results) assert.deepEqual({ projectId: result.projectId, left: result.left }, { projectId, left: true });
      const events = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1 and action = 'PROJECT_MEMBER_LEFT'", [projectId]);
      const members = await database.query<{ count: number }>("select count(*)::int as count from app.project_membership where project_id = $1 and active", [projectId]);
      const receipts = await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where key = $1", [key]);
      assert.equal(events.rows[0]!.count, 1);
      assert.equal(members.rows[0]!.count, 0);
      assert.equal(receipts.rows[0]!.count, 1);
    } finally {
      if (holder) { await holder.client.query("rollback"); await holder.client.end(); }
      await settled;
    }
  });
});

test("bootstrap returns one coherent status, the caller's role and exact topics", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user("Owner"); const viewer = await user("Viewer"); const outsider = await user("Outsider");
    const projectId = await project(owner);
    await join(owner, projectId, viewer, "VIEWER");
    const check = async (who: Identity, role: string, projectStatus: string) => {
      const boot = await getProjectBootstrap(who, projectId);
      assert.equal(boot.status.role, role);
      assert.equal(boot.project.role, role);
      assert.equal(boot.status.status, projectStatus);
      assert.equal(boot.status.currentDraftId, boot.draft.id);
      assert.equal(boot.status.documentRevision, boot.draft.documentRevision);
      assert.equal(boot.status.layoutRevision, boot.draft.layoutRevision);
      assert.deepEqual(boot.realtime, {
        events: `project:${projectId}:${boot.status.realtimeEpoch}:events`,
        collab: `project:${projectId}:${boot.status.realtimeEpoch}:collab`,
      });
      assert.deepEqual(boot.status, await getProjectStatus(who, projectId));
    };
    await check(owner, "OWNER", "ACTIVE");
    await check(viewer, "VIEWER", "ACTIVE");
    const status = await getProjectStatus(owner, projectId);
    await archiveProject(owner, projectId, { expectedProjectVersion: status.version, reason: "Done", key: randomUUID() });
    await check(viewer, "VIEWER", "ARCHIVED");
    await assert.rejects(getProjectBootstrap(outsider, projectId), code("NOT_FOUND"));
  });
});

test("removal revokes older pending invitations to the member's accepted email", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user(); const target = await user("Removed");
    const projectId = await project(owner);
    await join(owner, projectId, target);
    await issueInvitation(owner, projectId, { verifiedEmail: target.verifiedEmail, role: "VIEWER", key: randomUUID() });
    const current = await member(owner, projectId, target);
    await removeProjectMember(owner, projectId, current.profileId, { expectedMemberVersion: current.version, key: randomUUID() });
    const pending = (await listProjectInvitations(owner, projectId)).invitations.filter((entry) => entry.verifiedEmail === target.verifiedEmail);
    assert.deepEqual(pending, []);
  });
});

test("approver eligibility: the owner or an active editor/reviewer", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, profileId }) => {
    const owner = await user(); const viewer = await user("Viewer"); const reviewer = await user("Reviewer");
    const projectId = await project(owner);
    await join(owner, projectId, viewer, "VIEWER"); await join(owner, projectId, reviewer, "REVIEWER");
    let status = await getProjectStatus(owner, projectId);
    await assert.rejects(updateApprovalPolicy(owner, projectId, { designatedApproverId: await profileId(viewer), expectedApprovalPolicyVersion: status.approvalPolicyVersion, key: randomUUID() }), code("CONFLICT"));
    await updateApprovalPolicy(owner, projectId, { designatedApproverId: await profileId(owner), expectedApprovalPolicyVersion: status.approvalPolicyVersion, key: randomUUID() });
    status = await getProjectStatus(owner, projectId);
    const result = await updateApprovalPolicy(owner, projectId, { designatedApproverId: await profileId(reviewer), expectedApprovalPolicyVersion: status.approvalPolicyVersion, key: randomUUID() });
    assert.equal(result.designatedApproverId, await profileId(reviewer));
  });
});

test("archive revokes invitations, blocks authoring; restore revives none", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user(); const invitee = await user();
    const projectId = await project(owner);
    const issued = await issueInvitation(owner, projectId, { verifiedEmail: invitee.verifiedEmail, role: "EDITOR", key: randomUUID() });
    let status = await getProjectStatus(owner, projectId);
    await archiveProject(owner, projectId, { expectedProjectVersion: status.version, reason: "Paused", key: randomUUID() });
    await assert.rejects(updateProjectSettings(owner, projectId, { name: "Blocked", expectedSettingsVersion: status.settingsVersion, key: randomUUID() }), code("CONFLICT"));
    status = await getProjectStatus(owner, projectId);
    await restoreProject(owner, projectId, { expectedProjectVersion: status.version, key: randomUUID() });
    await assert.rejects(acceptInvitation(invitee, { invitationId: issued.id, key: randomUUID() }), code("NOT_FOUND"));
  });
});

async function archivedProject(owner: Identity, name: string) {
  const id = (await createProject(owner, { name, key: randomUUID() })).id;
  await archiveProject(owner, id, { expectedProjectVersion: (await getProjectStatus(owner, id)).version, reason: "Hold", key: randomUUID() });
  return id;
}
const restoreInput = async (owner: Identity, id: string) => ({ expectedProjectVersion: (await getProjectStatus(owner, id)).version, key: randomUUID() });
const limitReached = (results: PromiseSettledResult<unknown>[]) => {
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.ok(code("OWNED_PROJECT_LIMIT")((results.find((entry) => entry.status === "rejected") as PromiseRejectedResult).reason));
};

test("two concurrent restores at max-1 admit exactly one", { skip: !canRun }, async () => {
  await withFixture(async ({ user, entitle }) => {
    const owner = await user();
    await entitle(owner, 3);
    const [a, b] = [await archivedProject(owner, "A"), await archivedProject(owner, "B")];
    await createProject(owner, { name: "Active 1", key: randomUUID() });
    await createProject(owner, { name: "Active 2", key: randomUUID() });
    const [inputA, inputB] = [await restoreInput(owner, a), await restoreInput(owner, b)];
    limitReached(await Promise.allSettled([restoreProject(owner, a, inputA), restoreProject(owner, b, inputB)]));
  });
});

test("a create racing a restore at max-1 admits exactly one", { skip: !canRun }, async () => {
  await withFixture(async ({ user, entitle }) => {
    const owner = await user();
    await entitle(owner, 2);
    const archived = await archivedProject(owner, "Archived");
    await createProject(owner, { name: "Active", key: randomUUID() });
    const input = await restoreInput(owner, archived);
    limitReached(await Promise.allSettled([createProject(owner, { name: "Racing", key: randomUUID() }), restoreProject(owner, archived, input)]));
  });
});

test("lowering the limit blocks restore without touching active projects", { skip: !canRun }, async () => {
  await withFixture(async ({ user, entitle }) => {
    const owner = await user();
    await entitle(owner, 5);
    const archived = await archivedProject(owner, "Archived");
    await createProject(owner, { name: "Active", key: randomUUID() });
    await entitle(owner, 1);
    await assert.rejects(restoreProject(owner, archived, await restoreInput(owner, archived)), (error: unknown) => code("OWNED_PROJECT_LIMIT")(error) && (error as ProjectError).details?.activeOwned === 1);
    assert.equal((await getProjectStatus(owner, archived)).status, "ARCHIVED");
  });
});
