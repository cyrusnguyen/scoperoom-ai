import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { getMe } from "../../src/features/access/server/me.ts";
import { parseStartRunInput } from "../../src/features/proposals/contracts/tasks.ts";
import { createProject } from "../../src/features/projects/server/projects.ts";
import { admissionSubject, admitRun } from "../../src/features/proposals/server/admit-run.ts";
import { readAllowance } from "../../src/features/proposals/server/read-runs.ts";
import { canRun, withFixture, type Fixture, type Identity } from "./support/fixture.ts";

// Staff roles (2026-10-14): the SECURITY DEFINER authority functions on the web runtime role, and unlimited AI for staff-owned projects.
// Refusal SQLSTATEs: SR001 no staff role (the app answers NOT_FOUND), SR002 Admin required, SR003 version conflict, SR004 last Admin, SR005 unknown target.
const CONFIG = { model: "test-model", executionBinding: "binding-1" };
type Person = { identity: Identity; profile: string };
type Env = Fixture & { web: Client; person: (label?: string) => Promise<Person>; staff: (who: Person, role: "ADMIN" | "MODERATOR") => Promise<void> };
type Outcome = { ok: true; value: { profileId: string; version: number; role?: string | null; override?: { blocked: boolean } | null } } | { ok: false; code: string; message: string };

/** Runs a staff function and returns its jsonb result, or the SQLSTATE and message of the refusal. */
async function call(web: Client, sql: string, params: unknown[]): Promise<Outcome> {
  try { return { ok: true, value: (await web.query(sql, params)).rows[0].result }; }
  catch (error) { const { code, message } = error as { code: string; message: string }; return { ok: false, code, message }; }
}
const SET_ENTITLEMENT = "select app.admin_set_entitlement($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as result";
const SET_ROLE = "select app.admin_set_role($1, $2, $3, $4, $5, $6) as result";
const setRole = (web: Client, actor: string, target: string, role: string | null, version: number) => call(web, SET_ROLE, [actor, target, role, "role change", version, randomUUID()]);
const setLimits = (web: Client, actor: string, target: string, version: number, over: { max?: number; total?: number | null; daily?: number | null; blocked?: boolean; reset?: boolean } = {}) =>
  call(web, SET_ENTITLEMENT, [actor, target, over.max ?? 4, over.total === undefined ? 7 : over.total, over.daily === undefined ? 9 : over.daily, null, over.blocked ?? false, over.reset ?? false, "support request", version, randomUUID()]);
const code = (outcome: Outcome) => (outcome.ok ? "OK" : outcome.code);

async function withStaff(run: (env: Env) => Promise<void>) {
  await withFixture(async (fixture) => {
    const web = new Client({ connectionString: process.env.DATABASE_URL! });
    await web.connect();
    const profiles: string[] = [];
    const person = async (label?: string): Promise<Person> => {
      const identity = await fixture.user(label);
      const profile = await fixture.profileId(identity);
      profiles.push(profile);
      return { identity, profile };
    };
    // The first Admin is granted by an operator script (a later task): seed the first staff rows on the bootstrap connection.
    const staff = async (who: Person, role: "ADMIN" | "MODERATOR") => {
      await fixture.database.query("insert into app.platform_role (profile_id, role, granted_by) values ($1, $2, $1)", [who.profile, role]);
    };
    try {
      const { rows: [existing] } = await fixture.database.query<{ n: number }>("select count(*)::int as n from app.platform_role where revoked_at is null");
      assert.equal(existing!.n, 0, "staff tests need a disposable database with no active staff");
      await run({ ...fixture, web, person, staff });
    } finally {
      await fixture.database.query("delete from app.rate_limit_bucket where subject_hash = any($1::text[])", [profiles.map((profile) => admissionSubject(profile))]);
      await web.end();
    }
  });
}

const audits = async (db: Client, target: string) => (await db.query<{ action: string }>("select action from app.account_audit_event where target_profile_id = $1 order by created_at", [target])).rows.map((row) => row.action);
const roleOf = async (web: Client, profile: string) => (await web.query("select app.staff_role($1) as role", [profile])).rows[0].role;

async function startInput(db: Client, projectId: string) {
  const { rows: [draft] } = await db.query<{ id: string; revision: number }>("select d.id, d.document_revision revision from app.project p join app.scope_draft d on d.id = p.current_draft_id where p.id = $1", [projectId]);
  return parseStartRunInput({ taskType: "PROPOSE_FLOW", prompt: "Outline the checkout flow", draftId: draft!.id, expectedDocumentRevision: draft!.revision, expectedParentSnapshotId: null, context: { selection: null, sources: [] } }, randomUUID());
}
/** Consumed runs on an earlier day: counts toward the total limit only. */
const spend = async (db: Client, owner: string, consumed: number) => {
  await db.query("insert into app.ai_owner_allowance (owner_id) values ($1) on conflict do nothing", [owner]);
  await db.query("insert into app.ai_budget_day (owner_id, day, consumed_runs) values ($1, (now() at time zone 'UTC')::date - 3, $2)", [owner, consumed]);
};
const refused = (refusal: string) => ({ code: refusal });

test("role matrix: Admins and Moderators set limits, a normal account is refused, only Admins set roles, and each success writes one audit row", { skip: !canRun }, async () => {
  await withStaff(async ({ web, person, staff, database }) => {
    const admin = await person(), moderator = await person(), normal = await person(), target = await person();
    await staff(admin, "ADMIN");
    assert.deepEqual(await setRole(web, admin.profile, moderator.profile, "MODERATOR", 0), { ok: true, value: { profileId: moderator.profile, role: "MODERATOR", version: 1 } });
    assert.deepEqual([await roleOf(web, admin.profile), await roleOf(web, moderator.profile), await roleOf(web, normal.profile)], ["ADMIN", "MODERATOR", null]);

    const byAdmin = await setLimits(web, admin.profile, target.profile, 0);
    assert.ok(byAdmin.ok && byAdmin.value.version === 1);
    const byModerator = await setLimits(web, moderator.profile, target.profile, 1, { max: 6, total: null, daily: null });
    assert.deepEqual(byModerator.ok && byModerator.value.override, { maxOwnedProjects: 6, aiTotalRunLimit: null, aiDailyRunLimit: null, expiresAt: null, blocked: false, version: 2 });
    const { rows: [row] } = await database.query("select max_owned_projects, ai_total_run_limit, ai_daily_run_limit, granted_by_operator from app.pilot_entitlement where profile_id = $1", [target.profile]);
    assert.deepEqual(row, { max_owned_projects: 6, ai_total_run_limit: null, ai_daily_run_limit: null, granted_by_operator: moderator.profile });
    const blocked = await setLimits(web, moderator.profile, target.profile, 2, { blocked: true });
    assert.ok(blocked.ok && blocked.value.override?.blocked === true);
    assert.deepEqual((await database.query("select active, revoked_at is not null as revoked from app.pilot_entitlement where profile_id = $1", [target.profile])).rows[0], { active: false, revoked: true });
    assert.deepEqual(await audits(database, target.profile), ["ENTITLEMENT_SET", "ENTITLEMENT_SET", "ENTITLEMENT_SET"]);
    assert.deepEqual(await audits(database, moderator.profile), ["ROLE_SET"]);

    // Refusals leave no trace: SR001 for no staff role (the app answers NOT_FOUND), SR002 for a Moderator changing roles.
    const refusals = await Promise.all([
      setLimits(web, normal.profile, target.profile, 3), setRole(web, normal.profile, target.profile, "MODERATOR", 0),
      setRole(web, moderator.profile, target.profile, "MODERATOR", 0), setRole(web, moderator.profile, moderator.profile, "ADMIN", 1),
      setLimits(web, admin.profile, randomUUID(), 0),
    ]);
    assert.deepEqual(refusals.map(code), ["SR001", "SR001", "SR002", "SR002", "SR005"]);
    const invalid = await Promise.all([{ max: -1 }, { total: -1 }, { daily: -2 }].map((over) => setLimits(web, admin.profile, target.profile, 3, over)));
    assert.deepEqual([...invalid, await setRole(web, admin.profile, target.profile, "OWNER", 0)].map(code), ["22023", "22023", "22023", "22023"]);
    assert.deepEqual(await audits(database, target.profile), ["ENTITLEMENT_SET", "ENTITLEMENT_SET", "ENTITLEMENT_SET"]);
    assert.equal(await roleOf(web, target.profile), null);
    assert.equal(await roleOf(web, moderator.profile), "MODERATOR");

    // The web role reaches the new tables only through the functions.
    await assert.rejects(web.query("select * from app.platform_role"), { code: "42501" });
    await assert.rejects(web.query("select * from app.account_audit_event"), { code: "42501" });
    await assert.rejects(web.query("update app.pilot_entitlement set max_owned_projects = 99"), { code: "42501" });
  });
});

test("a stale version is a conflict on both functions and changes nothing", { skip: !canRun }, async () => {
  await withStaff(async ({ web, person, staff, database }) => {
    const admin = await person(), second = await person(), target = await person();
    await staff(admin, "ADMIN");
    assert.ok((await setLimits(web, admin.profile, target.profile, 0)).ok);
    assert.ok((await setLimits(web, admin.profile, target.profile, 1, { max: 5 })).ok);
    // Two staff opened version 1; the second write is refused instead of overwriting the first.
    assert.equal(code(await setLimits(web, admin.profile, target.profile, 1, { max: 9 })), "SR003");
    assert.equal((await database.query("select max_owned_projects as n from app.pilot_entitlement where profile_id = $1", [target.profile])).rows[0].n, 5);
    assert.equal(code(await setLimits(web, admin.profile, second.profile, 1)), "SR003", "a missing row is version 0");

    assert.ok((await setRole(web, admin.profile, second.profile, "MODERATOR", 0)).ok);
    assert.equal(code(await setRole(web, admin.profile, second.profile, "ADMIN", 0)), "SR003");
    assert.equal(await roleOf(web, second.profile), "MODERATOR");
    assert.deepEqual(await audits(database, target.profile), ["ENTITLEMENT_SET", "ENTITLEMENT_SET"]);
    assert.deepEqual(await audits(database, second.profile), ["ROLE_SET"]);
  });
});

test("the last Admin cannot be revoked or demoted, not even by themselves, and concurrent revocations leave one Admin", { skip: !canRun }, async () => {
  await withStaff(async ({ web, person, staff, database }) => {
    const first = await person(), second = await person();
    await staff(first, "ADMIN");
    assert.deepEqual([await setRole(web, first.profile, first.profile, null, 1), await setRole(web, first.profile, first.profile, "MODERATOR", 1)].map(code), ["SR004", "SR004"]);
    assert.deepEqual(await audits(database, first.profile), []);

    assert.ok((await setRole(web, first.profile, second.profile, "ADMIN", 0)).ok);
    const other = new Client({ connectionString: process.env.DATABASE_URL! });
    await other.connect();
    try {
      const results = await Promise.all([setRole(web, first.profile, second.profile, null, 1), setRole(other, second.profile, first.profile, null, 1)]);
      assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
      assert.ok(results.some((result) => !result.ok && ["SR002", "SR004"].includes(result.code)));
    } finally { await other.end(); }
    const { rows: remaining } = await database.query<{ profile_id: string }>("select profile_id from app.platform_role where role = 'ADMIN' and revoked_at is null");
    assert.equal(remaining.length, 1);
    // The remaining Admin can still bring the other back (the revoked row is at version 2).
    const revoked = remaining[0]!.profile_id === first.profile ? second : first;
    assert.ok((await setRole(web, remaining[0]!.profile_id, revoked.profile, "MODERATOR", 2)).ok);
    assert.equal(await roleOf(web, revoked.profile), "MODERATOR");
  });
});

test("the entitlement version only grows: a stale version from before a reset and recreate is a conflict", { skip: !canRun }, async () => {
  await withStaff(async ({ web, person, staff, database }) => {
    const admin = await person(), target = await person();
    await staff(admin, "ADMIN");
    const created = await setLimits(web, admin.profile, target.profile, 0);
    assert.ok(created.ok && created.value.version === 1);
    const reset = await setLimits(web, admin.profile, target.profile, 1, { reset: true });
    assert.ok(reset.ok && reset.value.version === 2);
    const recreated = await setLimits(web, admin.profile, target.profile, 2, { max: 3 });
    assert.ok(recreated.ok && recreated.value.version === 3);
    // An editor who read version 1 before the reset must not overwrite the recreated override.
    assert.equal(code(await setLimits(web, admin.profile, target.profile, 1, { max: 99 })), "SR003");
    assert.equal(code(await setLimits(web, admin.profile, target.profile, 1, { reset: true })), "SR003");
    assert.equal((await database.query("select max_owned_projects as n from app.pilot_entitlement where profile_id = $1", [target.profile])).rows[0].n, 3);
    assert.deepEqual(await audits(database, target.profile), ["ENTITLEMENT_SET", "ENTITLEMENT_RESET", "ENTITLEMENT_SET"]);
    await assert.rejects(web.query("select * from app.account_entitlement_version"), { code: "42501" });
  });
});

test("reset deletes the override, the account is back on the default plan, and it writes one audit row", { skip: !canRun }, async () => {
  await withStaff(async ({ web, person, staff, database }) => {
    const admin = await person(), target = await person();
    await staff(admin, "ADMIN");
    assert.ok((await setLimits(web, admin.profile, target.profile, 0, { max: 2, total: 50 })).ok);
    assert.deepEqual((await getMe(target.identity)).entitlement, { active: true, maxOwnedProjects: 2 });
    assert.deepEqual(await setLimits(web, admin.profile, target.profile, 1, { reset: true }), { ok: true, value: { profileId: target.profile, version: 2, override: null } });
    assert.equal((await database.query("select count(*)::int as n from app.pilot_entitlement where profile_id = $1", [target.profile])).rows[0].n, 0);
    assert.deepEqual((await getMe(target.identity)).entitlement, { active: true, maxOwnedProjects: 10 });
    assert.deepEqual(await audits(database, target.profile), ["ENTITLEMENT_SET", "ENTITLEMENT_RESET"]);
    assert.equal(code(await setLimits(web, admin.profile, target.profile, 2, { reset: true })), "22023", "nothing to reset");
    assert.equal((await audits(database, target.profile)).length, 2);
  });
});

test("a staff owner's AI admission passes the default total limit; revoking the role restores it, and a block still blocks", { skip: !canRun }, async () => {
  await withStaff(async ({ web, person, staff, database }) => {
    const admin = await person(), owner = await person();
    await staff(admin, "ADMIN");
    const created = async (name: string) => (await createProject(owner.identity, { name, key: randomUUID() })).id;
    const first = await created("Staff project one"), second = await created("Staff project two");
    await spend(database, owner.profile, 5);
    await assert.rejects(admitRun(owner.identity, first, await startInput(database, first), CONFIG), refused("AI_ALLOWANCE_EXCEEDED"));

    assert.ok((await setRole(web, admin.profile, owner.profile, "MODERATOR", 0)).ok);
    assert.equal((await readAllowance(owner.identity, first)).total.limit, null);
    await admitRun(owner.identity, first, await startInput(database, first), CONFIG); // the sixth in total
    assert.equal((await database.query("select count(*)::int as n from app.ai_run where owner_id = $1", [owner.profile])).rows[0].n, 1);

    assert.ok((await setRole(web, admin.profile, owner.profile, null, 1)).ok);
    await assert.rejects(admitRun(owner.identity, second, await startInput(database, second), CONFIG), refused("AI_ALLOWANCE_EXCEEDED"));
    assert.ok((await setRole(web, admin.profile, owner.profile, "ADMIN", 2)).ok);
    assert.ok((await setLimits(web, admin.profile, owner.profile, 0, { blocked: true })).ok);
    await assert.rejects(admitRun(owner.identity, second, await startInput(database, second), CONFIG), refused("ENTITLEMENT_REQUIRED"));
  });
});

test("a staff editor's run in a non-staff owner's project is still charged to that owner", { skip: !canRun }, async () => {
  await withStaff(async ({ person, staff, join, database }) => {
    const editor = await person(), owner = await person();
    await staff(editor, "ADMIN");
    const created = async (name: string) => (await createProject(owner.identity, { name, key: randomUUID() })).id;
    const first = await created("Owner project one"), second = await created("Owner project two");
    await join(owner.identity, first, editor.identity);
    await join(owner.identity, second, editor.identity);
    await spend(database, owner.profile, 4);
    const admitted = await admitRun(editor.identity, first, await startInput(database, first), CONFIG); // the owner's fifth
    const { rows: [run] } = await database.query("select owner_id, actor_id from app.ai_run where id = $1", [admitted.runId]);
    assert.deepEqual(run, { owner_id: owner.profile, actor_id: editor.profile });
    assert.equal((await database.query("select count(*)::int as n from app.ai_budget_day where owner_id = $1", [editor.profile])).rows[0].n, 0);
    // The staff editor is refused by the owner's limit, not waved through by their own role.
    await assert.rejects(admitRun(editor.identity, second, await startInput(database, second), CONFIG), refused("AI_ALLOWANCE_EXCEEDED"));
    const allowance = await readAllowance(editor.identity, second);
    assert.deepEqual([allowance.total.limit, allowance.viewerIsOwner], [5, false]);
  });
});
