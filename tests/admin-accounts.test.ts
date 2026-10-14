import assert from "node:assert/strict";
import test from "node:test";
import { decodeAccountCursor, encodeAccountCursor, validateAccountQuery, validateEntitlementInput, validateRoleInput } from "../src/features/admin/contracts/admin.ts";
import { ProjectError } from "../src/features/projects/server/errors.ts";
import { accountView, defaultLimits, type SummaryRow } from "../src/features/admin/server/account-view.ts";
import { staffError } from "../src/features/admin/server/staff-error.ts";

const key = "k".repeat(24);
const limits = { key, expectedVersion: 0, reason: "  support request  ", maxOwnedProjects: 4, aiTotalRuns: null, aiDailyRuns: 9, expiresAt: "2030-01-01T00:00:00+02:00", blocked: false };

test("entitlement input: a reset or a full limit set, strictly", () => {
  assert.deepEqual(validateEntitlementInput({ key, expectedVersion: 3, reason: "back to default", reset: true }), { key, expectedVersion: 3, reason: "back to default", reset: true });
  assert.deepEqual(validateEntitlementInput(limits), { ...limits, reason: "support request", reset: false, expiresAt: "2029-12-31T22:00:00.000Z" });
  assert.equal(validateEntitlementInput({ ...limits, expiresAt: null, reset: false }).reset, false);
  const bad: unknown[] = [
    { ...limits, expectedVersion: -1 }, { ...limits, expectedVersion: 1.5 }, { ...limits, reason: "   " }, { ...limits, reason: "x".repeat(501) },
    { ...limits, maxOwnedProjects: null }, { ...limits, maxOwnedProjects: -1 }, { ...limits, aiDailyRuns: -1 }, { ...limits, aiTotalRuns: "5" },
    { ...limits, maxOwnedProjects: 2 ** 31 }, { ...limits, blocked: "no" }, { ...limits, expiresAt: "tomorrow" }, { ...limits, expiresAt: "2030-13-45T00:00:00Z" },
    { ...limits, extra: 1 }, { ...limits, reset: true }, { key, expectedVersion: 0, reason: "r", reset: true, maxOwnedProjects: 1 },
    { key: "short", expectedVersion: 0, reason: "r", reset: true }, { ...limits, key: undefined }, [], null,
  ];
  for (const input of bad) assert.throws(() => validateEntitlementInput(input), /INVALID_INPUT/, JSON.stringify(input));
  const { aiDailyRuns, ...missing } = limits;
  void aiDailyRuns;
  assert.throws(() => validateEntitlementInput(missing), /INVALID_INPUT/);
});

test("role input: ADMIN, MODERATOR or null with a version and a reason", () => {
  assert.deepEqual(validateRoleInput({ key, expectedVersion: 0, reason: "new moderator", role: "MODERATOR" }), { key, expectedVersion: 0, reason: "new moderator", role: "MODERATOR" });
  assert.equal(validateRoleInput({ key, expectedVersion: 2, reason: "left the team", role: null }).role, null);
  for (const input of [{ role: "OWNER" }, { role: "admin" }, { role: undefined }, { reason: "" }, { expectedVersion: undefined }, { extra: true }]) {
    assert.throws(() => validateRoleInput({ key, expectedVersion: 0, reason: "r", role: "ADMIN", ...input }), /INVALID_INPUT/, JSON.stringify(input));
  }
});

test("search term and cursor", () => {
  assert.equal(validateAccountQuery(undefined), null);
  assert.equal(validateAccountQuery("   "), null);
  assert.equal(validateAccountQuery("  Ada  "), "Ada");
  assert.equal(validateAccountQuery("x".repeat(100)), "x".repeat(100));
  assert.throws(() => validateAccountQuery("x".repeat(101)), /INVALID_INPUT/);
  const id = "0b6f6a53-4ad2-4c55-9f0d-6e9f2f7a1c11";
  const cursor = encodeAccountCursor("Zoë \"Q\"", id);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeAccountCursor(cursor), ["Zoë \"Q\"", id]);
  // Any stored display name (1 to 120 code points) must round-trip, including multibyte and escaped characters.
  for (const name of ["漢".repeat(120), "😀".repeat(120), "".repeat(120)]) assert.deepEqual(decodeAccountCursor(encodeAccountCursor(name, id)), [name, id]);
  assert.throws(() => decodeAccountCursor("A".repeat(1025)), /INVALID_INPUT/);
  for (const bad of ["", "not base64!", Buffer.from("[1,2]").toString("base64url"), Buffer.from(JSON.stringify(["a", "nope"])).toString("base64url"), Buffer.from(JSON.stringify(["a", id, 1])).toString("base64url")]) {
    assert.throws(() => decodeAccountCursor(bad), /INVALID_INPUT/);
  }
});

const row: SummaryRow = {
  profile_id: "0b6f6a53-4ad2-4c55-9f0d-6e9f2f7a1c11", display_name: "Ada", staff_role: null, plan_kind: "DEFAULT", override_max_owned: null, override_ai_total: null,
  override_ai_daily: null, override_expires_at: null, active_owned_projects: 2, ai_used_total: 3, ai_used_today: 1, entitlement_version: 0, role_version: 0, last_activity: "2026-10-14T10:00:00.123456+00:00",
};

test("account view shows the limits that are enforced", () => {
  const env = {};
  assert.deepEqual(accountView(row, new Date(), env).limits, { maxOwnedProjects: 10, aiTotalRuns: 5, aiDailyRuns: 30 });
  assert.equal(accountView(row, new Date(), env).override, null);
  assert.equal(accountView(row, new Date(), env).lastActivityAt, "2026-10-14T10:00:00.123Z");
  const custom = { ...row, plan_kind: "CUSTOM", override_max_owned: 4, override_ai_total: null, override_ai_daily: 9, entitlement_version: 2 };
  const view = accountView(custom, new Date(), env);
  assert.deepEqual(view.limits, { maxOwnedProjects: 4, aiTotalRuns: null, aiDailyRuns: 9 });
  assert.deepEqual(view.override, { maxOwnedProjects: 4, aiTotalRuns: null, aiDailyRuns: 9, expiresAt: null });
  // An expired override is stored but no longer enforced.
  assert.deepEqual(accountView({ ...custom, override_expires_at: "2020-01-01T00:00:00Z" }, new Date(), env).limits, { maxOwnedProjects: 10, aiTotalRuns: 5, aiDailyRuns: 30 });
  const blocked = accountView({ ...custom, plan_kind: "BLOCKED" }, new Date(), env);
  assert.deepEqual(blocked.limits, { maxOwnedProjects: 0, aiTotalRuns: 0, aiDailyRuns: 0 });
  assert.equal(blocked.override?.maxOwnedProjects, 4);
  const staff = accountView({ ...row, staff_role: "MODERATOR" }, new Date(), env);
  assert.deepEqual([staff.staffRole, staff.limits.aiTotalRuns, staff.limits.aiDailyRuns, staff.limits.maxOwnedProjects], ["MODERATOR", null, null, 10]);
  // The editor's start without an override: the default plan with its AI settings, never the staff exemption.
  assert.deepEqual(defaultLimits(new Date(), env), { maxOwnedProjects: 10, aiTotalRuns: 5, aiDailyRuns: 30 });
  assert.deepEqual(defaultLimits(new Date(), { AI_TOTAL_RUN_LIMIT: "7", AI_DAILY_RUN_LIMIT: "3" }), { maxOwnedProjects: 10, aiTotalRuns: 7, aiDailyRuns: 3 });
});

test("staff refusals map to the shared error codes", () => {
  // The shape Prisma 7 with the pg adapter raises for a function's RAISE ... USING ERRCODE (checked against a local PostgreSQL 15).
  const driver = (code: string) => ({ code: "P2010", meta: { driverAdapterError: { cause: { code } } } });
  assert.equal(staffError(driver("SR001")).code, "NOT_FOUND");
  assert.equal(staffError(driver("SR005")).code, "NOT_FOUND");
  assert.equal(staffError(driver("SR002")).code, "ADMIN_ROLE_REQUIRED");
  assert.equal(staffError(driver("SR003")).code, "CONFLICT");
  assert.equal(staffError(driver("SR004")).code, "LAST_ADMIN");
  assert.equal(staffError(driver("22023")).code, "INVALID_INPUT");
  assert.equal(staffError({ code: "P2010", meta: { code: "SR004" } }).code, "LAST_ADMIN");
  assert.equal(staffError(new Error("ERROR: VERSION_CONFLICT")).code, "CONFLICT");
  assert.equal(staffError(driver("40P01")).code, "UNAVAILABLE");
  const own = new ProjectError("KEY_REUSED");
  assert.equal(staffError(own), own);
});
