/**
 * Account plans (2026-10-12). An account without a pilot_entitlement row is on the default plan. A row is an operator or admin
 * override: while active and unexpired it replaces the defaults; an inactive or revoked row blocks project ownership and AI; an
 * expired row falls back to the defaults. A null AI limit is unlimited. AI usage is charged to the project owner's plan.
 * AI_TOTAL_RUN_LIMIT and AI_DAILY_RUN_LIMIT replace the default AI limits for every account on the default plan.
 * A staff owner (Admin or Moderator, 2026-10-14) has unlimited AI in the projects they own; project limits and a block are unchanged.
 */
export const DEFAULT_PLAN = { maxOwnedProjects: 10, aiTotalRuns: 5, aiDailyRuns: 30 } as const;
type PlanEnv = Partial<NodeJS.ProcessEnv>;

function envLimit(env: PlanEnv, name: "AI_TOTAL_RUN_LIMIT" | "AI_DAILY_RUN_LIMIT", fallback: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const limit = Number(value);
  // Fail closed: a typo must not grant the default, and an overflow must not become Infinity (unlimited).
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit)) throw new Error(`${name} must be a non-negative integer.`);
  return limit;
}

export type EntitlementOverride = {
  active: boolean; expiresAt: Date | null; revokedAt: Date | null;
  maxOwnedProjects: number; aiTotalRunLimit: number | null; aiDailyRunLimit: number | null;
};
export type AccountPlan = { allowed: boolean; maxOwnedProjects: number; aiTotalRuns: number | null; aiDailyRuns: number | null };

export function accountPlan(override: EntitlementOverride | null, now = new Date(), env: PlanEnv = process.env, staff = false): AccountPlan {
  if (override && (!override.active || override.revokedAt)) return { allowed: false, maxOwnedProjects: 0, aiTotalRuns: 0, aiDailyRuns: 0 };
  const plan = !override || (override.expiresAt && override.expiresAt <= now)
    ? { allowed: true, maxOwnedProjects: DEFAULT_PLAN.maxOwnedProjects,
      aiTotalRuns: envLimit(env, "AI_TOTAL_RUN_LIMIT", DEFAULT_PLAN.aiTotalRuns), aiDailyRuns: envLimit(env, "AI_DAILY_RUN_LIMIT", DEFAULT_PLAN.aiDailyRuns) }
    : { allowed: true, maxOwnedProjects: override.maxOwnedProjects, aiTotalRuns: override.aiTotalRunLimit, aiDailyRuns: override.aiDailyRunLimit };
  return staff ? { ...plan, aiTotalRuns: null, aiDailyRuns: null } : plan;
}
