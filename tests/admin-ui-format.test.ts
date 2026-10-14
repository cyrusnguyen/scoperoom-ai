import assert from "node:assert/strict";
import test from "node:test";
import type { AccountView } from "../src/features/admin/contracts/admin.ts";
import { actionLabel, expiryFor, parseLimit, planLabel, relativeTime, snapshotLabel, usageLabel } from "../src/features/admin/ui/format.ts";

const now = Date.parse("2026-10-14T12:00:00Z");
const account = (plan: AccountView["plan"], expiresAt: string | null = null): Pick<AccountView, "plan" | "override"> =>
  ({ plan, override: plan === "DEFAULT" ? null : { maxOwnedProjects: 3, aiTotalRuns: 5, aiDailyRuns: null, expiresAt } });

test("plan label: Default, Custom, Blocked and Custom, expired once the expiry has passed", () => {
  assert.equal(planLabel(account("DEFAULT"), now), "Default");
  assert.equal(planLabel(account("CUSTOM"), now), "Custom");
  assert.equal(planLabel(account("CUSTOM", "2026-10-15T00:00:00Z"), now), "Custom");
  assert.equal(planLabel(account("CUSTOM", "2026-10-14T12:00:00Z"), now), "Custom, expired");
  assert.equal(planLabel(account("CUSTOM", "2026-01-01T00:00:00Z"), now), "Custom, expired");
  assert.equal(planLabel(account("BLOCKED", "2026-01-01T00:00:00Z"), now), "Blocked");
});

test("usage reads 'used of limit' or 'used, unlimited'", () => {
  assert.equal(usageLabel(3, 5), "3 of 5");
  assert.equal(usageLabel(0, 0), "0 of 0");
  assert.equal(usageLabel(7, null), "7, unlimited");
});

test("relative time", () => {
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(relativeTime(null, now), "Never");
  assert.equal(relativeTime(ago(5_000), now), "Just now");
  assert.equal(relativeTime(ago(60_000), now), "1 minute ago");
  assert.equal(relativeTime(ago(3 * 3_600_000), now), "3 hours ago");
  assert.equal(relativeTime(ago(2 * 86_400_000 + 5), now), "2 days ago");
  assert.match(relativeTime(ago(40 * 86_400_000), now), /2026/);
  assert.equal(relativeTime(new Date(now + 60_000).toISOString(), now), "Just now");
});

test("limit text and expiry round trip", () => {
  assert.equal(parseLimit("0"), 0);
  assert.equal(parseLimit("2147483647"), 2147483647);
  for (const bad of ["", "-1", "1.5", "1e3", " 4", "2147483648", "99999999999", "abc"]) assert.equal(parseLimit(bad), null, bad);
  assert.equal(expiryFor("", "2026-12-01T00:00:00.000Z"), null);
  assert.equal(expiryFor("2026-12-31", null), "2026-12-31T23:59:59.000Z");
  assert.equal(expiryFor("2026-12-01", "2026-12-01T08:30:00.000Z"), "2026-12-01T08:30:00.000Z");
  assert.equal(expiryFor("2026-12-02", "2026-12-01T08:30:00.000Z"), "2026-12-02T23:59:59.000Z");
});

test("audit entries read in words", () => {
  assert.equal(actionLabel("ENTITLEMENT_SET"), "Changed limits");
  assert.equal(actionLabel("ROLE_REVOKED"), "Removed role");
  assert.equal(snapshotLabel("ENTITLEMENT_SET", null), "Default plan");
  assert.equal(snapshotLabel("ENTITLEMENT_SET", { maxOwnedProjects: 4, aiTotalRunLimit: null, aiDailyRunLimit: 9, expiresAt: "2026-12-31T23:59:59Z", blocked: true }),
    "Projects 4, AI total unlimited, AI daily 9, Expires Dec 31, 2026 UTC, Blocked");
  assert.equal(snapshotLabel("ROLE_SET", { role: null }), "None");
  assert.equal(snapshotLabel("ROLE_SET", { role: "MODERATOR" }), "Moderator");
});
