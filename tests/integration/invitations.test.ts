import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { acceptInvitation, issueInvitation, listMyInvitations, listProjectInvitations, revokeInvitation } from "../../src/features/projects/server/invitations.ts";
import { removeProjectMember, getProjectMembers } from "../../src/features/projects/server/management.ts";
import { getProjectBootstrap } from "../../src/features/projects/server/projects.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { canRun, withFixture, type Identity } from "./support/fixture.ts";

const code = (expected: string) => (error: unknown) => error instanceof ProjectError && error.code === expected;
const tokenOf = (issued: { url?: string }) => issued.url!.split("/").at(-1)!;
async function waitForLockWaiters(database: Client, holderPid: number, ready: (queries: string[]) => boolean, description: string) {
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
    if (ready(queries)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}: ${queries.join(" | ")}`);
}
const countLockQueries = (queries: string[], fragment: string) => queries.filter((query) => query.includes(fragment)).length;
const acceptanceWaiters = (queries: string[]) => countLockQueries(queries, "FROM app.project project") >= 2 ||
  (countLockQueries(queries, "FROM app.project project") >= 1 && countLockQueries(queries, "FROM app.user_profile") >= 1);
type HeldProjectLocks = { client: Client; pid: number };
async function holdProjectLocks(projectIds: string[]) {
  const holder = new Client({ connectionString: process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL! });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query("select id from app.project where id = any($1::uuid[]) for update", [projectIds]);
    const { rows: [row] } = await holder.query<{ pid: number }>("select pg_backend_pid()::int as pid");
    return { client: holder, pid: row!.pid };
  } catch (error) {
    await holder.end();
    throw error;
  }
}
async function releaseHeldProjectLocks(holder: HeldProjectLocks) {
  try { await holder.client.query("commit"); } finally { await holder.client.end(); }
}
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

test("two tabs accepting the same link at once both land on the membership", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const member = await user("Two Tabs");
    const projectId = await project(owner);
    const token = tokenOf(await invite(owner, projectId, member.verifiedEmail));
    // Queue both acceptances behind a held project lock so the second one re-reads the row the first one changed.
    let holder = await holdProjectLocks([projectId]);
    const tabs = [acceptInvitation(member, { token, key: randomUUID() }), acceptInvitation(member, { token, key: randomUUID() })];
    const settled = Promise.allSettled(tabs);
    try {
      await waitForLockWaiters(database, holder.pid, acceptanceWaiters, "both acceptances behind the held project lock");
      await releaseHeldProjectLocks(holder); holder = null!;
      const results = (await settled).map((result) => {
        if (result.status !== "fulfilled") throw result.reason;
        return result.value;
      });
      assert.deepEqual(results.map(({ replayed }) => replayed).sort(), [false, true]);
      for (const result of results) assert.deepEqual({ projectId: result.projectId, role: result.role }, { projectId, role: "EDITOR" });
    } finally {
      if (holder) { await holder.client.query("rollback"); await holder.client.end(); }
      await settled;
    }
  });
});

test("same-key acceptances queued behind a project lock replay the one established membership", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const member = await user("Same-key tabs");
    const projectId = await project(owner);
    const token = tokenOf(await invite(owner, projectId, member.verifiedEmail));
    const key = randomUUID();
    let holder = await holdProjectLocks([projectId]);
    const tabs = [acceptInvitation(member, { token, key }), acceptInvitation(member, { token, key })];
    const settled = Promise.allSettled(tabs);
    try {
      await waitForLockWaiters(database, holder.pid, acceptanceWaiters, "both acceptances behind the held project lock");
      await releaseHeldProjectLocks(holder); holder = null!;
      const results = (await settled).map((result) => {
        if (result.status !== "fulfilled") throw result.reason;
        return result.value;
      });
      assert.deepEqual(results.map(({ replayed }) => replayed).sort(), [false, true]);
      for (const result of results) assert.deepEqual({ projectId: result.projectId, role: result.role }, { projectId, role: "EDITOR" });
      const accepted = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id = $1 and action = 'INVITATION_ACCEPTED'", [projectId]);
      const members = await database.query<{ count: number }>("select count(*)::int as count from app.project_membership where project_id = $1 and active", [projectId]);
      const receipts = await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where key = $1", [key]);
      assert.equal(accepted.rows[0]!.count, 1);
      assert.equal(members.rows[0]!.count, 1);
      assert.equal(receipts.rows[0]!.count, 1);
    } finally {
      if (holder) { await holder.client.query("rollback"); await holder.client.end(); }
      await settled;
    }
  });
});

test("same USER key accepting different projects has one effect and reports key reuse", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user(); const member = await user("Cross-project key");
    const firstProjectId = await project(owner, "First"); const secondProjectId = await project(owner, "Second");
    const firstToken = tokenOf(await invite(owner, firstProjectId, member.verifiedEmail));
    const secondToken = tokenOf(await invite(owner, secondProjectId, member.verifiedEmail));
    const key = randomUUID();
    let holder = await holdProjectLocks([firstProjectId, secondProjectId]);
    const attempts = [acceptInvitation(member, { token: firstToken, key }), acceptInvitation(member, { token: secondToken, key })];
    const settled = Promise.allSettled(attempts);
    try {
      await waitForLockWaiters(database, holder.pid, acceptanceWaiters, "both acceptances behind the held project lock");
      await releaseHeldProjectLocks(holder); holder = null!;
      const results = await settled;
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.ok(code("KEY_REUSED")((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason));
      const accepted = await database.query<{ count: number }>("select count(*)::int as count from app.audit_event where project_id in ($1, $2) and action = 'INVITATION_ACCEPTED'", [firstProjectId, secondProjectId]);
      const members = await database.query<{ count: number }>("select count(*)::int as count from app.project_membership where project_id in ($1, $2) and active", [firstProjectId, secondProjectId]);
      const receipts = await database.query<{ count: number }>("select count(*)::int as count from app.mutation_receipt where key = $1", [key]);
      assert.equal(accepted.rows[0]!.count, 1);
      assert.equal(members.rows[0]!.count, 1);
      assert.equal(receipts.rows[0]!.count, 1);
    } finally {
      if (holder) { await holder.client.query("rollback"); await holder.client.end(); }
      await settled;
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

test("pending invitations are capped at 50 per project", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user();
    const projectId = await project(owner);
    for (let index = 0; index < 50; index++) {
      await invite(owner, projectId, `capped-${randomUUID()}@example.test`);
    }
    await assert.rejects(invite(owner, projectId, `capped-${randomUUID()}@example.test`), code("INVITATION_LIMIT"));
  });
});

test("only the owner lists and revokes invitations", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project }) => {
    const owner = await user(); const active = await user("Active Member");
    const projectId = await project(owner);
    await acceptInvitation(active, { token: tokenOf(await invite(owner, projectId, active.verifiedEmail)), key: randomUUID() });
    const issued = await invite(owner, projectId, `other-${randomUUID()}@example.test`);
    await assert.rejects(listProjectInvitations(active, projectId), code("NOT_FOUND"));
    await assert.rejects(revokeInvitation(active, projectId, issued.id, { expectedVersion: issued.version, key: randomUUID() }), code("NOT_FOUND"));
  });
});

test("an issue replay returns the stored result without the link, and the raw token is never stored", { skip: !canRun }, async () => {
  await withFixture(async ({ user, project, database }) => {
    const owner = await user();
    const projectId = await project(owner);
    const email = `replay-${randomUUID()}@example.test`;
    const key = randomUUID();
    const first = await issueInvitation(owner, projectId, { verifiedEmail: email, role: "EDITOR", key });
    const token = tokenOf(first);
    const replay = await issueInvitation(owner, projectId, { verifiedEmail: email, role: "EDITOR", key });
    assert.deepEqual(replay, { ...first, url: undefined, linkUnavailable: true, replayed: true });
    const { rows: hashed } = await database.query<{ found: boolean }>("select exists(select 1 from app.invitation where token_hash = $1) as found", [token]);
    assert.equal(hashed[0]!.found, false);
    const { rows: receipts } = await database.query<{ result: string }>("select result::text as result from app.mutation_receipt where key = $1", [key]);
    assert.ok(receipts.length > 0);
    assert.ok(receipts.every((entry) => !entry.result.includes(token)));
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
