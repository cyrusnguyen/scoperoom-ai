import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Client } from "pg";
import { encodeAccountCursor } from "../../src/features/admin/contracts/admin.ts";
import { defaultLimits } from "../../src/features/admin/server/account-view.ts";
import { listAccounts, readAccount } from "../../src/features/admin/server/accounts.ts";
import { setEntitlement, setRole } from "../../src/features/admin/server/changes.ts";
import { parseStartRunInput } from "../../src/features/proposals/contracts/tasks.ts";
import { createProject } from "../../src/features/projects/server/projects.ts";
import { ProjectError } from "../../src/features/projects/server/errors.ts";
import { admitRun } from "../../src/features/proposals/server/admit-run.ts";
import { canRun } from "./support/fixture.ts";
import { withStaff } from "./support/staff.ts";

// Staff account reads and writes (2026-10-14, Task 2) through the real services on the web runtime role.
const CONFIG = { model: "test-model", executionBinding: "binding-1" };
const tag = () => `Acct${randomUUID().slice(0, 8)}`;
const refusal = (code: string, details?: Record<string, unknown>) => (error: unknown) => {
  assert.ok(error instanceof ProjectError, String(error));
  assert.equal(error.code, code);
  if (details) assert.deepEqual(error.details, details);
  return true;
};
const limitsBody = (version: number, over: Record<string, unknown> = {}) => ({
  key: randomUUID(), expectedVersion: version, reason: "support request", maxOwnedProjects: 4, aiTotalRuns: 7, aiDailyRuns: 9, expiresAt: null, blocked: false, ...over,
});
const roleBody = (version: number, role: "ADMIN" | "MODERATOR" | null, over: Record<string, unknown> = {}) => ({ key: randomUUID(), expectedVersion: version, reason: "role change", role, ...over });
const audits = async (db: Client, target: string) => (await db.query<{ action: string }>("select action from app.account_audit_event where target_profile_id = $1 order by created_at", [target])).rows.map((row) => row.action);
const withoutReplay = <T extends { replayed: boolean }>({ replayed, ...rest }: T) => (void replayed, rest);

async function startInput(db: Client, projectId: string) {
  const { rows: [draft] } = await db.query<{ id: string; revision: number }>("select d.id, d.document_revision revision from app.project p join app.scope_draft d on d.id = p.current_draft_id where p.id = $1", [projectId]);
  return parseStartRunInput({ taskType: "PROPOSE_FLOW", prompt: "Outline the checkout flow", draftId: draft!.id, expectedDocumentRevision: draft!.revision, expectedParentSnapshotId: null, context: { selection: null, sources: [] } }, randomUUID());
}

test("Admins and Moderators list and read accounts; a normal account gets NOT_FOUND from every admin service and changes nothing", { skip: !canRun }, async () => {
  await withStaff(async ({ person, staff, database }) => {
    const label = tag();
    const admin = await person(`${label} Admin`), moderator = await person(`${label} Moderator`), normal = await person(`${label} Normal`), target = await person(`${label} Target`);
    await staff(admin, "ADMIN");
    await staff(moderator, "MODERATOR");

    for (const viewer of [admin, moderator]) {
      const page = await listAccounts(viewer.identity, { query: label.toLowerCase() });
      assert.deepEqual(page.accounts.map((account) => [account.displayName, account.staffRole]).sort(), [
        [`${label} Admin`, "ADMIN"], [`${label} Moderator`, "MODERATOR"], [`${label} Normal`, null], [`${label} Target`, null],
      ]);
      assert.equal(page.nextCursor, null);
      const detail = await readAccount(viewer.identity, target.profile);
      assert.deepEqual([detail.account.profileId, detail.account.displayName, detail.account.plan, detail.audit], [target.profile, `${label} Target`, "DEFAULT", []]);
      assert.deepEqual(detail.defaultLimits, defaultLimits());
    }

    const denied = refusal("NOT_FOUND");
    await assert.rejects(listAccounts(normal.identity, {}), denied);
    await assert.rejects(readAccount(normal.identity, target.profile), denied);
    await assert.rejects(setEntitlement(normal.identity, target.profile, limitsBody(0)), denied);
    await assert.rejects(setRole(normal.identity, target.profile, roleBody(0, "ADMIN")), denied);
    await assert.rejects(readAccount(admin.identity, randomUUID()), denied, "an unknown target");
    await assert.rejects(readAccount(admin.identity, "not-a-uuid"), denied);
    assert.deepEqual(await audits(database, target.profile), []);
    assert.equal((await database.query("select count(*)::int as n from app.platform_role where profile_id = $1", [target.profile])).rows[0].n, 0);
    assert.equal((await database.query("select count(*)::int as n from app.pilot_entitlement where profile_id = $1", [target.profile])).rows[0].n, 0);
    assert.equal((await database.query("select count(*)::int as n from app.mutation_receipt where actor_id = $1", [normal.profile])).rows[0].n, 0);
  });
});

test("search is a case-insensitive literal substring on the display name, and keyset paging walks every account once", { skip: !canRun }, async () => {
  await withStaff(async ({ person, staff, database }) => {
    const label = tag();
    const admin = await person(`${label} Admin`);
    await staff(admin, "ADMIN");
    // Profiles without an Auth user are enough to fill pages, and the paging test then does not need 30 Auth users.
    await database.query("insert into app.user_profile (display_name) select $1 || ' P' || lpad(n::text, 2, '0') from generate_series(1, 30) n", [label]);
    await database.query("insert into app.user_profile (display_name) values ($1)", [`${label} 100%_off`]);
    try {
      const everyone = (await database.query<{ id: string }>("select id from app.user_profile where display_name like $1 order by display_name, id", [`${label}%`])).rows.map((row) => row.id);
      assert.equal(everyone.length, 32);

      const first = await listAccounts(admin.identity, { query: `  ${label.toUpperCase()}  ` });
      assert.equal(first.accounts.length, 25);
      assert.ok(first.nextCursor);
      const second = await listAccounts(admin.identity, { query: label, cursor: first.nextCursor });
      assert.equal(second.accounts.length, 7);
      assert.equal(second.nextCursor, null);
      assert.deepEqual([...first.accounts, ...second.accounts].map((account) => account.profileId), everyone);

      assert.deepEqual((await listAccounts(admin.identity, { query: `${label} 100%` })).accounts.map((account) => account.displayName), [`${label} 100%_off`], "% is literal");
      assert.deepEqual((await listAccounts(admin.identity, { query: `${label} P1_` })).accounts, [], "_ is literal");
      assert.equal((await listAccounts(admin.identity, { query: `${label} p07` })).accounts.length, 1);

      await assert.rejects(listAccounts(admin.identity, { cursor: "not a cursor" }), refusal("INVALID_INPUT"));
      await assert.rejects(listAccounts(admin.identity, { cursor: encodeAccountCursor("x", "nope") }), refusal("INVALID_INPUT"));
      await assert.rejects(listAccounts(admin.identity, { query: "x".repeat(101) }), refusal("INVALID_INPUT"));
    } finally {
      await database.query("delete from app.user_profile where display_name like $1 and auth_user_id is null", [`${label}%`]);
    }
  });
});

test("usage counts match admission, the plan follows the override, and the detail carries the audit trail", { skip: !canRun }, async () => {
  await withStaff(async ({ person, staff, database }) => {
    const admin = await person(), owner = await person("Usage Owner");
    await staff(admin, "ADMIN");
    const project = (await createProject(owner.identity, { name: "Usage project", key: randomUUID() })).id;
    await admitRun(owner.identity, project, await startInput(database, project), CONFIG);

    const before = (await readAccount(admin.identity, owner.profile)).account;
    assert.deepEqual([before.aiUsed, before.activeOwnedProjects, before.plan, before.entitlementVersion, before.roleVersion, before.override], [{ total: 1, today: 1 }, 1, "DEFAULT", 0, 0, null]);
    assert.deepEqual(before.limits, { maxOwnedProjects: 10, aiTotalRuns: 5, aiDailyRuns: 30 });
    assert.ok(before.lastActivityAt);
    const listed = (await listAccounts(admin.identity, { query: "Usage Owner" })).accounts.find((account) => account.profileId === owner.profile);
    assert.deepEqual(listed, before);

    const set = await setEntitlement(admin.identity, owner.profile, limitsBody(0, { aiTotalRuns: null, expiresAt: "2099-01-01T00:00:00Z" }));
    const { expiresAt, ...stored } = ((set as Record<string, unknown>).override as { expiresAt: string });
    assert.equal(new Date(expiresAt).toISOString(), "2099-01-01T00:00:00.000Z");
    assert.deepEqual([set.version, stored], [1, { maxOwnedProjects: 4, aiTotalRunLimit: null, aiDailyRunLimit: 9, blocked: false, version: 1 }]);
    const custom = await readAccount(admin.identity, owner.profile);
    assert.deepEqual([custom.account.plan, custom.account.limits, custom.account.override, custom.account.entitlementVersion], [
      "CUSTOM", { maxOwnedProjects: 4, aiTotalRuns: null, aiDailyRuns: 9 }, { maxOwnedProjects: 4, aiTotalRuns: null, aiDailyRuns: 9, expiresAt: "2099-01-01T00:00:00.000Z" }, 1,
    ]);
    assert.deepEqual(custom.audit.map((entry) => [entry.action, entry.actorId, entry.reason, entry.before]), [["ENTITLEMENT_SET", admin.profile, "support request", null]]);
    assert.ok(custom.audit[0]!.actorName);

    await setEntitlement(admin.identity, owner.profile, limitsBody(1, { blocked: true }));
    assert.equal((await readAccount(admin.identity, owner.profile)).account.plan, "BLOCKED");
    await setEntitlement(admin.identity, owner.profile, { key: randomUUID(), expectedVersion: 2, reason: "back to default", reset: true });
    const reset = await readAccount(admin.identity, owner.profile);
    assert.deepEqual([reset.account.plan, reset.account.entitlementVersion, reset.audit.map((entry) => entry.action)], ["DEFAULT", 3, ["ENTITLEMENT_RESET", "ENTITLEMENT_SET", "ENTITLEMENT_SET"]]);
  });
});

test("a Moderator sets limits but gets ADMIN_ROLE_REQUIRED on roles; an Admin sets roles", { skip: !canRun }, async () => {
  await withStaff(async ({ person, staff, database }) => {
    const admin = await person(), moderator = await person(), target = await person();
    await staff(admin, "ADMIN");
    await staff(moderator, "MODERATOR");

    assert.equal((await setEntitlement(moderator.identity, target.profile, limitsBody(0, { maxOwnedProjects: 6 }))).version, 1);
    await assert.rejects(setRole(moderator.identity, target.profile, roleBody(0, "MODERATOR")), refusal("ADMIN_ROLE_REQUIRED"));
    await assert.rejects(setRole(moderator.identity, moderator.profile, roleBody(1, "ADMIN")), refusal("ADMIN_ROLE_REQUIRED"));
    assert.deepEqual(await audits(database, target.profile), ["ENTITLEMENT_SET"]);
    assert.deepEqual(await audits(database, moderator.profile), []);

    const granted = await setRole(admin.identity, target.profile, roleBody(0, "MODERATOR"));
    assert.deepEqual(withoutReplay(granted), { profileId: target.profile, role: "MODERATOR", version: 1 });
    assert.equal((await readAccount(moderator.identity, target.profile)).account.staffRole, "MODERATOR");
    const revoked = await setRole(admin.identity, target.profile, roleBody(1, null));
    assert.deepEqual(withoutReplay(revoked), { profileId: target.profile, role: null, version: 2 });
    const detail = await readAccount(admin.identity, target.profile);
    assert.deepEqual([detail.account.staffRole, detail.account.roleVersion], [null, 2]);
    await assert.rejects(listAccounts(target.identity, {}), refusal("NOT_FOUND"), "a revoked role is no longer staff");
  });
});

test("a stale version is a CONFLICT that carries the current version, and changes nothing", { skip: !canRun }, async () => {
  await withStaff(async ({ person, staff, database }) => {
    const admin = await person(), second = await person(), target = await person();
    await staff(admin, "ADMIN");
    await staff(second, "MODERATOR");

    // Both staff opened the account at version 0; the second write is refused instead of overwriting the first.
    await setEntitlement(admin.identity, target.profile, limitsBody(0, { maxOwnedProjects: 5 }));
    await assert.rejects(setEntitlement(second.identity, target.profile, limitsBody(0, { maxOwnedProjects: 9 })), refusal("CONFLICT", { currentVersion: 1 }));
    assert.equal((await database.query("select max_owned_projects as n from app.pilot_entitlement where profile_id = $1", [target.profile])).rows[0].n, 5);

    await setRole(admin.identity, target.profile, roleBody(0, "MODERATOR"));
    await assert.rejects(setRole(admin.identity, target.profile, roleBody(0, "ADMIN")), refusal("CONFLICT", { currentVersion: 1 }));
    await assert.rejects(setRole(admin.identity, second.profile, roleBody(7, null)), refusal("CONFLICT", { currentVersion: 1 }));
    assert.deepEqual(await audits(database, target.profile), ["ENTITLEMENT_SET", "ROLE_SET"]);
    // The version a conflict reports works.
    assert.equal((await setEntitlement(second.identity, target.profile, limitsBody(1, { maxOwnedProjects: 9 }))).version, 2);
  });
});

test("the same Idempotency-Key replays the stored result and writes one audit row; a changed body is KEY_REUSED", { skip: !canRun }, async () => {
  await withStaff(async ({ person, staff, database }) => {
    const admin = await person(), target = await person();
    await staff(admin, "ADMIN");

    const body = limitsBody(0);
    const first = await setEntitlement(admin.identity, target.profile, body);
    const replay = await setEntitlement(admin.identity, target.profile, { ...body });
    assert.deepEqual([first.replayed, replay.replayed], [false, true]);
    assert.deepEqual(withoutReplay(replay), withoutReplay(first));
    await assert.rejects(setEntitlement(admin.identity, target.profile, { ...body, maxOwnedProjects: 5 }), refusal("KEY_REUSED"));
    await assert.rejects(setEntitlement(admin.identity, randomUUID(), { ...body }), refusal("KEY_REUSED"), "another target");

    const role = roleBody(0, "MODERATOR");
    const granted = await setRole(admin.identity, target.profile, role);
    const regranted = await setRole(admin.identity, target.profile, { ...role });
    assert.deepEqual([granted.replayed, regranted.replayed, regranted.version], [false, true, 1]);
    await assert.rejects(setRole(admin.identity, target.profile, { ...role, role: "ADMIN" }), refusal("KEY_REUSED"));
    assert.deepEqual(await audits(database, target.profile), ["ENTITLEMENT_SET", "ROLE_SET"]);

    // A retry arriving after the actor lost the role does not return the stored result.
    await setRole(admin.identity, target.profile, roleBody(1, "ADMIN"));
    await setRole(target.identity, admin.profile, roleBody(1, null));
    await assert.rejects(setEntitlement(admin.identity, target.profile, { ...body }), refusal("NOT_FOUND"));

    // Concurrent requests with one key: one change, the other replays.
    const target2 = await person();
    const concurrent = limitsBody(0);
    const results = await Promise.all([setEntitlement(target.identity, target2.profile, concurrent), setEntitlement(target.identity, target2.profile, { ...concurrent })]);
    assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
    assert.deepEqual(await audits(database, target2.profile), ["ENTITLEMENT_SET"]);
  });
});

test("invalid bodies are INVALID_INPUT and write nothing", { skip: !canRun }, async () => {
  await withStaff(async ({ person, staff, database }) => {
    const admin = await person(), target = await person();
    await staff(admin, "ADMIN");
    for (const body of [limitsBody(0, { reason: "" }), limitsBody(0, { maxOwnedProjects: -1 }), limitsBody(0, { aiDailyRuns: 1.5 }), limitsBody(0, { extra: true }), limitsBody(-1)]) {
      await assert.rejects(setEntitlement(admin.identity, target.profile, body), refusal("INVALID_INPUT"));
    }
    await assert.rejects(setRole(admin.identity, target.profile, roleBody(0, "OWNER" as "ADMIN")), refusal("INVALID_INPUT"));
    // Nothing to change is refused by the database as invalid input, not recorded.
    await assert.rejects(setEntitlement(admin.identity, target.profile, { key: randomUUID(), expectedVersion: 0, reason: "reset", reset: true }), refusal("INVALID_INPUT"));
    await assert.rejects(setRole(admin.identity, target.profile, roleBody(0, null)), refusal("INVALID_INPUT"));
    assert.deepEqual(await audits(database, target.profile), []);
  });
});

test("the last Admin cannot revoke or demote themselves; with a second Admin they can", { skip: !canRun }, async () => {
  await withStaff(async ({ person, staff, database }) => {
    const first = await person(), second = await person();
    await staff(first, "ADMIN");
    await assert.rejects(setRole(first.identity, first.profile, roleBody(1, null)), refusal("LAST_ADMIN"));
    await assert.rejects(setRole(first.identity, first.profile, roleBody(1, "MODERATOR")), refusal("LAST_ADMIN"));
    assert.deepEqual(await audits(database, first.profile), []);

    await setRole(first.identity, second.profile, roleBody(0, "ADMIN"));
    assert.deepEqual(withoutReplay(await setRole(first.identity, first.profile, roleBody(1, null))), { profileId: first.profile, role: null, version: 2 });
    await assert.rejects(setRole(second.identity, second.profile, roleBody(1, null)), refusal("LAST_ADMIN"));
    assert.equal((await readAccount(second.identity, first.profile)).account.staffRole, null);
  });
});

test("lowering a limit below current usage refuses new projects and AI requests and touches no existing project or run", { skip: !canRun }, async () => {
  await withStaff(async ({ person, staff, database }) => {
    const admin = await person(), owner = await person();
    await staff(admin, "ADMIN");
    const created = async (name: string) => (await createProject(owner.identity, { name, key: randomUUID() })).id;
    const first = await created("Kept project one"), second = await created("Kept project two");
    await admitRun(owner.identity, first, await startInput(database, first), CONFIG);
    const snapshot = async () => ({
      projects: (await database.query("select id, status::text, version, updated_at from app.project where owner_id = $1 order by id", [owner.profile])).rows,
      runs: (await database.query("select id, state::text, project_id from app.ai_run where owner_id = $1 order by id", [owner.profile])).rows,
      budget: (await database.query("select day, reserved_runs, consumed_runs from app.ai_budget_day where owner_id = $1 order by day", [owner.profile])).rows,
    });
    const before = await snapshot();
    assert.equal(before.projects.length, 2);
    assert.equal(before.runs.length, 1);

    // One project and one request in total (five a day) allowed, while the account owns two projects and has used one request.
    await setEntitlement(admin.identity, owner.profile, limitsBody(0, { maxOwnedProjects: 1, aiTotalRuns: 1, aiDailyRuns: 5 }));
    await assert.rejects(createProject(owner.identity, { name: "Refused project", key: randomUUID() }), refusal("OWNED_PROJECT_LIMIT", { activeOwned: 2, maxOwned: 1 }));
    await assert.rejects(admitRun(owner.identity, second, await startInput(database, second), CONFIG), refusal("AI_ALLOWANCE_EXCEEDED"));
    assert.deepEqual(await snapshot(), before);
    assert.equal((await readAccount(admin.identity, owner.profile)).account.activeOwnedProjects, 2);
  });
});

test("a Moderator is refused STAFF_TARGET_FORBIDDEN on an Admin and on themselves; account reads carry the creation date and actor ids", { skip: !canRun }, async () => {
  await withStaff(async ({ person, staff, database }) => {
    const admin = await person(), moderator = await person(), target = await person();
    await staff(admin, "ADMIN");
    await staff(moderator, "MODERATOR");

    await assert.rejects(setEntitlement(moderator.identity, admin.profile, limitsBody(0)), refusal("STAFF_TARGET_FORBIDDEN"));
    await assert.rejects(setEntitlement(moderator.identity, moderator.profile, limitsBody(0)), refusal("STAFF_TARGET_FORBIDDEN"));
    assert.deepEqual([await audits(database, admin.profile), await audits(database, moderator.profile)], [[], []]);
    assert.equal((await setEntitlement(admin.identity, moderator.profile, limitsBody(0))).version, 1);

    await setEntitlement(moderator.identity, target.profile, limitsBody(0));
    const detail = await readAccount(admin.identity, target.profile);
    const { rows: [created] } = await database.query<{ created_at: Date }>("select created_at from app.user_profile where id = $1", [target.profile]);
    assert.equal(detail.account.createdAt, created!.created_at.toISOString());
    assert.equal(detail.audit[0]!.actorId, moderator.profile);
    const { accounts } = await listAccounts(admin.identity, { query: "" });
    assert.ok(accounts.every((account) => typeof account.createdAt === "string"));
  });
});
