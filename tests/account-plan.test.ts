import assert from "node:assert/strict";
import test from "node:test";
import { accountPlan, DEFAULT_PLAN } from "../src/features/projects/server/plan.ts";

const now = new Date("2026-10-12T00:00:00Z");
const override = (change: Partial<Parameters<typeof accountPlan>[0] & object> = {}) => ({
  active: true, expiresAt: null, revokedAt: null, maxOwnedProjects: 3, aiTotalRunLimit: null, aiDailyRunLimit: null, ...change,
});

test("an account without an override is on the default plan", () => {
  assert.deepEqual(DEFAULT_PLAN, { maxOwnedProjects: 10, aiTotalRuns: 5, aiDailyRuns: 30 });
  assert.deepEqual(accountPlan(null, now, {}), { allowed: true, maxOwnedProjects: 10, aiTotalRuns: 5, aiDailyRuns: 30 });
  assert.deepEqual(accountPlan(null, now, { AI_TOTAL_RUN_LIMIT: "", AI_DAILY_RUN_LIMIT: " " }), { allowed: true, ...DEFAULT_PLAN });
});

test("environment variables set the default AI limits", () => {
  const env = { AI_TOTAL_RUN_LIMIT: "50", AI_DAILY_RUN_LIMIT: "0" };
  assert.deepEqual(accountPlan(null, now, env), { allowed: true, maxOwnedProjects: 10, aiTotalRuns: 50, aiDailyRuns: 0 });
  assert.deepEqual(accountPlan(override({ expiresAt: now }), now, env).aiTotalRuns, 50);
  assert.deepEqual(accountPlan(override({ aiTotalRunLimit: 7 }), now, env).aiTotalRuns, 7);
  for (const bad of ["-1", "1.5", "ten", "1e3", "unlimited", "1".repeat(400), "9007199254740993"]) {
    assert.throws(() => accountPlan(null, now, { AI_DAILY_RUN_LIMIT: bad }), /AI_DAILY_RUN_LIMIT must be a non-negative integer/);
  }
});

test("an active override replaces the defaults, and null AI limits are unlimited", () => {
  assert.deepEqual(accountPlan(override(), now), { allowed: true, maxOwnedProjects: 3, aiTotalRuns: null, aiDailyRuns: null });
  assert.deepEqual(accountPlan(override({ aiTotalRunLimit: 50, aiDailyRunLimit: 0 }), now), { allowed: true, maxOwnedProjects: 3, aiTotalRuns: 50, aiDailyRuns: 0 });
  assert.deepEqual(accountPlan(override({ expiresAt: new Date("2026-10-13T00:00:00Z") }), now).maxOwnedProjects, 3);
});

test("an expired override falls back to the default plan", () => {
  assert.deepEqual(accountPlan(override({ expiresAt: now }), now, {}), { allowed: true, ...DEFAULT_PLAN });
  assert.deepEqual(accountPlan(override({ expiresAt: new Date("2026-10-11T00:00:00Z") }), now, {}), { allowed: true, ...DEFAULT_PLAN });
});

test("an inactive or revoked override blocks ownership and AI, even after it expires", () => {
  const blocked = { allowed: false, maxOwnedProjects: 0, aiTotalRuns: 0, aiDailyRuns: 0 };
  assert.deepEqual(accountPlan(override({ active: false }), now), blocked);
  assert.deepEqual(accountPlan(override({ revokedAt: now }), now), blocked);
  assert.deepEqual(accountPlan(override({ active: false, expiresAt: new Date("2026-10-01T00:00:00Z") }), now), blocked);
});

test("a staff owner has unlimited AI, keeps the project limit, and a block still blocks", () => {
  const unlimited = { aiTotalRuns: null, aiDailyRuns: null };
  assert.deepEqual(accountPlan(null, now, {}, true), { allowed: true, maxOwnedProjects: 10, ...unlimited });
  assert.deepEqual(accountPlan(override({ maxOwnedProjects: 3, aiTotalRunLimit: 5, aiDailyRunLimit: 2 }), now, {}, true), { allowed: true, maxOwnedProjects: 3, ...unlimited });
  assert.deepEqual(accountPlan(override({ expiresAt: now }), now, {}, true), { allowed: true, maxOwnedProjects: 10, ...unlimited });
  const blocked = { allowed: false, maxOwnedProjects: 0, aiTotalRuns: 0, aiDailyRuns: 0 };
  assert.deepEqual(accountPlan(override({ active: false }), now, {}, true), blocked);
  assert.deepEqual(accountPlan(override({ revokedAt: now }), now, {}, true), blocked);
  assert.deepEqual(accountPlan(null, now, {}, false), { allowed: true, ...DEFAULT_PLAN });
});
