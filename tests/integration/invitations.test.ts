import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { acceptInvitation, issueInvitation, listMyInvitations, listProjectInvitations, revokeInvitation } from "../../src/features/projects/server/invitations.ts";
import { removeProjectMember, getProjectMembers } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap } from "../../src/features/projects/server/projects.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { canRun, withFixture, type Identity } from "./support/fixture.ts";

const code = (expected: string) => (error: unknown) => error instanceof ProjectError && error.code === expected;
const tokenOf = (issued: { url?: string }) => issued.url!.split("/").at(-1)!;
async function invite(owner: Identity, projectId: string, email: string, role: "EDITOR" | "REVIEWER" | "VIEWER" = "EDITOR") {
  return issueInvitation(owner, projectId, { verifiedEmail: email, role, key: randomUUID() });
}
async function memberVersion(owner: Identity, projectId: string, member: Identity) {
  return (await getProjectMembers(owner, projectId)).members.find((entry) => entry.displayName === member.displayName)!;
}

test("new membership: exact email joins one project only and revokes sibling invites", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user("Owner"); const member = await user("Member");
    const projectId = await project(owner); const siblingId = await project(owner, "Sibling");
    const first = await invite(owner, projectId, member.verifiedEmail, "EDITOR");
    const second = await invite(owner, projectId, member.verifiedEmail, "VIEWER");
    const accepted = await acceptInvitation(member, { token: tokenOf(first), key: randomUUID() });
    assert.deepEqual(accepted, { projectId, role: "EDITOR", replayed: false });
    const { rows: [revoked] } = await database.query<{ revoked: boolean }>("select revoked_at is not null as revoked from app.invitation where id = $1", [second.id]);
    assert.equal(revoked!.revoked, true);
    await assert.rejects(getProjectBootstrap(member, siblingId), code("NOT_FOUND"));
  });
});

test("wrong email, revoked and expired invitations reveal nothing", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const member = await user(); const outsider = await user();
    const projectId = await project(owner);
    const issued = await invite(owner, projectId, member.verifiedEmail);
    await assert.rejects(acceptInvitation(outsider, { token: tokenOf(issued), key: randomUUID() }), code("NOT_FOUND"));
    await assert.rejects(acceptInvitation(outsider, { invitationId: issued.id, key: randomUUID() }), code("NOT_FOUND"));
    await revokeInvitation(owner, projectId, issued.id, { expectedVersion: issued.version, key: randomUUID() });
    await assert.rejects(acceptInvitation(member, { token: tokenOf(issued), key: randomUUID() }), code("NOT_FOUND"));
    const expiring = await invite(owner, projectId, member.verifiedEmail);
    await database.query("update app.invitation set expires_at = now() - interval '1 second' where id = $1", [expiring.id]);
    await assert.rejects(acceptInvitation(member, { invitationId: expiring.id, key: randomUUID() }), code("NOT_FOUND"));
  });
});

test("self-invite and existing member: ALREADY_MEMBER, role unchanged, invitation untouched", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const member = await user("Viewer Member");
    const projectId = await project(owner);
    await assert.rejects(invite(owner, projectId, owner.verifiedEmail), (error: unknown) => code("ALREADY_MEMBER")(error) && (error as ProjectError).details?.role === "OWNER");
    await acceptInvitation(member, { token: tokenOf(await invite(owner, projectId, member.verifiedEmail, "VIEWER")), key: randomUUID() });
    const upgrade = await invite(owner, projectId, member.verifiedEmail, "EDITOR");
    await assert.rejects(acceptInvitation(member, { invitationId: upgrade.id, key: randomUUID() }), (error: unknown) => code("ALREADY_MEMBER")(error) && (error as ProjectError).details?.role === "VIEWER");
    const { rows: [row] } = await database.query<{ accepted: boolean }>("select accepted_at is not null as accepted from app.invitation where id = $1", [upgrade.id]);
    assert.equal(row!.accepted, false);
    assert.equal((await memberVersion(owner, projectId, member)).role, "VIEWER");
  });
});

test("completed retry replays only while access remains; key reuse and consumed links never restore access", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user(); const member = await user("Returning Member");
    const projectId = await project(owner);
    const issued = await invite(owner, projectId, member.verifiedEmail);
    const key = randomUUID();
    await acceptInvitation(member, { token: tokenOf(issued), key });
    assert.deepEqual(await acceptInvitation(member, { token: tokenOf(issued), key }), { projectId, role: "EDITOR", replayed: true });
    await assert.rejects(acceptInvitation(member, { invitationId: issued.id, key }), code("KEY_REUSED"));
    assert.deepEqual(await acceptInvitation(member, { token: tokenOf(issued), key: randomUUID() }), { projectId, role: "EDITOR", replayed: true });
    const current = await memberVersion(owner, projectId, member);
    await removeProjectMember(owner, projectId, current.profileId, { expectedMemberVersion: current.version, key: randomUUID() });
    await assert.rejects(acceptInvitation(member, { token: tokenOf(issued), key }), code("NOT_FOUND"));
    await assert.rejects(acceptInvitation(member, { token: tokenOf(issued), key: randomUUID() }), code("NOT_FOUND"));
    await assert.rejects(getProjectBootstrap(member, projectId), code("NOT_FOUND"));
  });
});

test("reactivation through a fresh invitation takes the new role", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user(); const member = await user("Rejoining Member");
    const projectId = await project(owner);
    await acceptInvitation(member, { token: tokenOf(await invite(owner, projectId, member.verifiedEmail, "EDITOR")), key: randomUUID() });
    const current = await memberVersion(owner, projectId, member);
    await removeProjectMember(owner, projectId, current.profileId, { expectedMemberVersion: current.version, key: randomUUID() });
    const fresh = await invite(owner, projectId, member.verifiedEmail, "REVIEWER");
    assert.deepEqual(await acceptInvitation(member, { invitationId: fresh.id, key: randomUUID() }), { projectId, role: "REVIEWER", replayed: false });
    assert.equal((await memberVersion(owner, projectId, member)).role, "REVIEWER");
  });
});

test("sequence rule under lock contention: an invite issued before removal never readmits", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database, profileId }) => {
    const owner = await user();
    for (const removalFirst of [true, false]) {
      const member = await user(`Contended ${removalFirst}`);
      const projectId = await project(owner, `Contention ${removalFirst}`);
      await acceptInvitation(member, { token: tokenOf(await invite(owner, projectId, member.verifiedEmail)), key: randomUUID() });
      const memberProfile = await profileId(member);
      const current = await memberVersion(owner, projectId, member);
      const changedEmail = `changed-${randomUUID()}@example.test`;
      await database.query("begin");
      await database.query("select id from app.project where id = $1 for update", [projectId]);
      const wait = () => new Promise((resolve) => setTimeout(resolve, 250));
      const first = removalFirst
        ? removeProjectMember(owner, projectId, memberProfile, { expectedMemberVersion: current.version, key: randomUUID() })
        : invite(owner, projectId, changedEmail);
      await wait();
      const second = removalFirst
        ? invite(owner, projectId, changedEmail)
        : removeProjectMember(owner, projectId, memberProfile, { expectedMemberVersion: current.version, key: randomUUID() });
      await wait();
      await database.query("commit");
      await Promise.all([first, second]);
      const pending = (await listProjectInvitations(owner, projectId)).invitations.find((entry) => entry.verifiedEmail === changedEmail)!;
      const attempt = acceptInvitation({ ...member, verifiedEmail: changedEmail }, { invitationId: pending.id, key: randomUUID() });
      if (removalFirst) assert.equal((await attempt).role, "EDITOR");
      else await assert.rejects(attempt, code("NOT_FOUND"));
    }
  });
});

test("collaborator capacity holds under concurrent acceptance at 9 of 10", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const projectId = await project(owner);
    for (let index = 0; index < 8; index++) {
      const member = await user(`Member ${index}`);
      await acceptInvitation(member, { token: tokenOf(await invite(owner, projectId, member.verifiedEmail)), key: randomUUID() });
    }
    const a = await user("Late A"); const b = await user("Late B");
    const [ia, ib] = [await invite(owner, projectId, a.verifiedEmail), await invite(owner, projectId, b.verifiedEmail)];
    const results = await Promise.allSettled([acceptInvitation(a, { token: tokenOf(ia), key: randomUUID() }), acceptInvitation(b, { token: tokenOf(ib), key: randomUUID() })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.ok(code("COLLABORATOR_LIMIT")((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason));
  });
});

test("acceptance works with zero owned projects and at the owned limit", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, entitle }) => {
    const owner = await user(); const atLimit = await user(); const none = await user();
    await entitle(atLimit, 1);
    await project(atLimit, "Own only");
    const projectId = await project(owner);
    await acceptInvitation(atLimit, { token: tokenOf(await invite(owner, projectId, atLimit.verifiedEmail)), key: randomUUID() });
    await acceptInvitation(none, { token: tokenOf(await invite(owner, projectId, none.verifiedEmail)), key: randomUUID() });
    assert.equal((await getProjectBootstrap(none, projectId)).project.role, "EDITOR");
  });
});

test("my invitations list is email-bound, actionable-only and metadata-only", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user("Inviting Owner"); const member = await user(); const outsider = await user();
    const projectId = await project(owner, "Invited project");
    const live = await invite(owner, projectId, member.verifiedEmail, "VIEWER");
    const expired = await invite(owner, projectId, member.verifiedEmail, "EDITOR");
    await database.query("update app.invitation set expires_at = now() - interval '1 second' where id = $1", [expired.id]);
    const mine = await listMyInvitations(member);
    assert.deepEqual(mine.items.map((item) => Object.keys(item).sort()), [["expiresAt", "id", "inviterName", "projectName", "role"]]);
    assert.deepEqual(mine.items.map((item) => [item.id, item.projectName, item.inviterName, item.role]), [[live.id, "Invited project", "Inviting Owner", "VIEWER"]]);
    assert.equal(mine.truncated, false);
    assert.deepEqual((await listMyInvitations(outsider)).items, []);
  });
});
