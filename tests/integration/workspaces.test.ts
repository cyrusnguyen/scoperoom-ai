import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { WorkspaceError, createWorkspace, getWorkspaceHome } from "../../src/features/workspaces/server/workspaces.ts";

const authUrl = process.env.E2E_SUPABASE_URL;
const secretKey = process.env.E2E_SUPABASE_SECRET_KEY;
const databaseUrl = process.env.SCOPEROOM_BOOTSTRAP_DATABASE_URL;
const canRun = Boolean(authUrl && secretKey && databaseUrl);

async function withFixture(run: (fixture: {
  identity: (displayName?: string) => Promise<{ authUserId: string; displayName: string }>;
  grant: (authUserId: string, maxWorkspaces?: number) => Promise<void>;
  database: Client;
}) => Promise<void>) {
  const admin = createClient(authUrl!, secretKey!, { auth: { autoRefreshToken: false, persistSession: false } });
  const database = new Client({ connectionString: databaseUrl! });
  const users: string[] = [];
  await database.connect();
  try {
    await run({
      identity: async (displayName = "Workspace Test") => {
        const { data, error } = await admin.auth.admin.createUser({
          email: `workspace-${randomUUID()}@example.test`,
          password: `Workspace-${randomUUID()}-Pass!`,
          email_confirm: true,
          user_metadata: { full_name: displayName },
        });
        if (error || !data.user) throw error ?? new Error("Could not create test user.");
        users.push(data.user.id);
        const identity = { authUserId: data.user.id, displayName };
        await getWorkspaceHome(identity);
        return identity;
      },
      grant: async (authUserId, maxWorkspaces = 1) => {
        const { rows: [profile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [authUserId]);
        if (!profile) throw new Error("Workspace profile was not created.");
        await database.query(
          "insert into app.pilot_entitlement (profile_id, max_workspaces, active, granted_by_operator) values ($1, $2, true, gen_random_uuid())",
          [profile.id, maxWorkspaces],
        );
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

test("workspace creation rejects a profile without an operator entitlement", { skip: !canRun }, async () => {
  await withFixture(async ({ identity }) => {
    const user = await identity();
    await assert.rejects(createWorkspace(user, { name: "Denied", key: "d".repeat(16) }), (error: unknown) => error instanceof WorkspaceError && error.code === "NOT_ENTITLED");
  });
});

test("workspace creation writes one owner membership and replays only the matching key", { skip: !canRun }, async () => {
  await withFixture(async ({ identity, grant, database }) => {
    const user = await identity();
    await grant(user.authUserId);
    const key = "r".repeat(16);
    const created = await createWorkspace(user, { name: "First", key });
    assert.equal(created.replayed, false);
    assert.deepEqual(await createWorkspace(user, { name: "First", key }), { ...created, replayed: true });
    await assert.rejects(createWorkspace(user, { name: "Changed", key }), (error: unknown) => error instanceof WorkspaceError && error.code === "KEY_REUSED");
    const membership = await database.query<{ role: string; active: boolean }>("select role::text, active from app.workspace_membership where workspace_id = $1", [created.id]);
    assert.deepEqual(membership.rows, [{ role: "OWNER", active: true }]);
  });
});

test("profile locking admits only one concurrent workspace under a one-workspace entitlement", { skip: !canRun }, async () => {
  await withFixture(async ({ identity, grant, database }) => {
    const user = await identity();
    await grant(user.authUserId);
    const results = await Promise.allSettled([
      createWorkspace(user, { name: "Concurrent A", key: "a".repeat(16) }),
      createWorkspace(user, { name: "Concurrent B", key: "b".repeat(16) }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof WorkspaceError && result.reason.code === "LIMIT_REACHED").length, 1);
    const owned = await database.query<{ count: number }>("select count(*)::int as count from app.workspace where owner_id = (select id from app.user_profile where auth_user_id = $1)", [user.authUserId]);
    assert.equal(owned.rows[0]?.count, 1);
  });
});

test("an expired receipt no longer reserves its key", { skip: !canRun }, async () => {
  await withFixture(async ({ identity, grant, database }) => {
    const user = await identity();
    await grant(user.authUserId, 2);
    const key = "e".repeat(16);
    await createWorkspace(user, { name: "Expired first", key });
    await database.query(
      "update app.mutation_receipt set expires_at = current_timestamp - interval '1 second' where actor_id = (select id from app.user_profile where auth_user_id = $1) and key = $2",
      [user.authUserId, key],
    );
    const second = await createWorkspace(user, { name: "Expired second", key });
    assert.equal(second.replayed, false);
    assert.equal(second.name, "Expired second");
  });
});

test("separate Auth identities resolve to separate profiles", { skip: !canRun }, async () => {
  await withFixture(async ({ identity }) => {
    const first = await identity("First user");
    const second = await identity("Second user");
    const [firstHome, secondHome] = await Promise.all([getWorkspaceHome(first), getWorkspaceHome(second)]);
    assert.notEqual(firstHome.profileId, secondHome.profileId);
    assert.deepEqual(firstHome.workspaces, []);
    assert.deepEqual(secondHome.workspaces, []);
  });
});


test("replay requires the current active workspace and owner membership", { skip: !canRun }, async () => {
  await withFixture(async ({ identity, grant, database }) => {
    const user = await identity();
    await grant(user.authUserId);
    const key = "s".repeat(16);
    const created = await createWorkspace(user, { name: "Suspended", key });
    await database.query("update app.workspace set status = 'SUSPENDED' where id = $1", [created.id]);
    await assert.rejects(createWorkspace(user, { name: "Suspended", key }), (error: unknown) => error instanceof WorkspaceError && error.code === "UNAVAILABLE");
  });
});

test("a membership in another workspace does not consume owned capacity", { skip: !canRun }, async () => {
  await withFixture(async ({ identity, grant, database }) => {
    const member = await identity("Member");
    const otherOwner = await identity("Other owner");
    await grant(member.authUserId);
    await grant(otherOwner.authUserId);
    const otherWorkspace = await createWorkspace(otherOwner, { name: "Other's workspace", key: "o".repeat(16) });
    const { rows: [memberProfile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [member.authUserId]);
    await database.query("insert into app.workspace_membership (workspace_id, profile_id, role) values ($1, $2, 'MEMBER')", [otherWorkspace.id, memberProfile.id]);
    const home = await getWorkspaceHome(member);
    assert.equal(home.workspaces.length, 1);
    assert.equal(home.ownedCount, 0);
    assert.equal(home.canCreate, true);
    await createWorkspace(member, { name: "Own workspace", key: "m".repeat(16) });
    const after = await getWorkspaceHome(member);
    assert.equal(after.ownedCount, 1);
    assert.equal(after.workspaces.length, 2);
  });
});

test("database rejects a second OWNER membership", { skip: !canRun }, async () => {
  await withFixture(async ({ identity, grant, database }) => {
    const owner = await identity("Owner");
    const second = await identity("Second");
    await grant(owner.authUserId);
    const created = await createWorkspace(owner, { name: "Single owner", key: "u".repeat(16) });
    const { rows: [otherProfile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [second.authUserId]);
    await assert.rejects(database.query("insert into app.workspace_membership (workspace_id, profile_id, role) values ($1, $2, 'OWNER')", [created.id, otherProfile.id]), (error: unknown) => (error as { code?: string }).code === "23514");
  });
});

test("web runtime cannot change operator entitlement", { skip: !canRun }, async () => {
  await withFixture(async ({ identity, grant, database }) => {
    const user = await identity();
    await grant(user.authUserId);
    const { rows: [profile] } = await database.query<{ id: string }>("select id from app.user_profile where auth_user_id = $1", [user.authUserId]);
    const web = new Client({ connectionString: process.env.DATABASE_URL! });
    await web.connect();
    try {
      await assert.rejects(web.query("update app.pilot_entitlement set active = false where profile_id = $1", [profile.id]), (error: unknown) => (error as { code?: string }).code === "42501");
    } finally {
      await web.end();
    }
  });
});

test("operator revocation holds creation behind the entitlement lock", { skip: !canRun }, async () => {
  await withFixture(async ({ identity, grant, database }) => {
    const user = await identity();
    await grant(user.authUserId);
    await database.query("begin");
    await database.query("update app.pilot_entitlement set active = false where profile_id = (select id from app.user_profile where auth_user_id = $1)", [user.authUserId]);
    const observer = new Client({ connectionString: databaseUrl! });
    await observer.connect();
    const pending = createWorkspace(user, { name: "Revoked", key: "v".repeat(16) });
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const { rows: [activity] } = await observer.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%lock_pilot_entitlement%') as blocked");
        if (activity.blocked) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await database.query("commit");
      await observer.end();
    }
    const outcome = await Promise.allSettled([pending]);
    assert.equal(blocked, true, "workspace creation should wait for the operator's entitlement update");
    assert.equal(outcome[0].status, "rejected");
    if (outcome[0].status === "rejected") assert.equal(outcome[0].reason.code, "NOT_ENTITLED");
    const { rows: [count] } = await database.query<{ count: number }>("select count(*)::int as count from app.workspace where owner_id = (select id from app.user_profile where auth_user_id = $1)", [user.authUserId]);
    assert.equal(count.count, 0);
  });
});

