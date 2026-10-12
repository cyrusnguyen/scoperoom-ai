import assert from "node:assert/strict";
import test from "node:test";
import { accountPlan, DEFAULT_PLAN } from "../src/features/projects/server/plan.ts";

const now = new Date("2026-10-12T00:00:00Z");
const override = (change: Partial<Parameters<typeof accountPlan>[0] & object> = {}) => ({
  active: true, expiresAt: null, revokedAt: null, maxOwnedProjects: 3, aiTotalRunLimit: null, aiDailyRunLimit: null, ...change,
});

test("an account without an override is on the default plan", () => {
  assert.deepEqual(DEFAULT_PLAN, { maxOwnedProjects: 10, aiTotalRuns: 5, aiDailyRuns: 30 });
  assert.deepEqual(accountPlan(null, now), { allowed: true, maxOwnedProjects: 10, aiTotalRuns: 5, aiDailyRuns: 30 });
});

test("an active override replaces the defaults, and null AI limits are unlimited", () => {
  assert.deepEqual(accountPlan(override(), now), { allowed: true, maxOwnedProjects: 3, aiTotalRuns: null, aiDailyRuns: null });
  assert.deepEqual(accountPlan(override({ aiTotalRunLimit: 50, aiDailyRunLimit: 0 }), now), { allowed: true, maxOwnedProjects: 3, aiTotalRuns: 50, aiDailyRuns: 0 });
  assert.deepEqual(accountPlan(override({ expiresAt: new Date("2026-10-13T00:00:00Z") }), now).maxOwnedProjects, 3);
});

test("an expired override falls back to the default plan", () => {
  assert.deepEqual(accountPlan(override({ expiresAt: now }), now), { allowed: true, ...DEFAULT_PLAN });
  assert.deepEqual(accountPlan(override({ expiresAt: new Date("2026-10-11T00:00:00Z") }), now), { allowed: true, ...DEFAULT_PLAN });
});

test("an inactive or revoked override blocks ownership and AI, even after it expires", () => {
  const blocked = { allowed: false, maxOwnedProjects: 0, aiTotalRuns: 0, aiDailyRuns: 0 };
  assert.deepEqual(accountPlan(override({ active: false }), now), blocked);
  assert.deepEqual(accountPlan(override({ revokedAt: now }), now), blocked);
  assert.deepEqual(accountPlan(override({ active: false, expiresAt: new Date("2026-10-01T00:00:00Z") }), now), blocked);
});
