/**
 * Account plans (2026-10-12). An account without a pilot_entitlement row is on the default plan. A row is an operator or admin
 * override: while active and unexpired it replaces the defaults; an inactive or revoked row blocks project ownership and AI; an
 * expired row falls back to the defaults. A null AI limit is unlimited. AI usage is charged to the project owner's plan.
 */
export const DEFAULT_PLAN = { maxOwnedProjects: 10, aiTotalRuns: 5, aiDailyRuns: 30 } as const;

export type EntitlementOverride = {
  active: boolean; expiresAt: Date | null; revokedAt: Date | null;
  maxOwnedProjects: number; aiTotalRunLimit: number | null; aiDailyRunLimit: number | null;
};
export type AccountPlan = { allowed: boolean; maxOwnedProjects: number; aiTotalRuns: number | null; aiDailyRuns: number | null };

export function accountPlan(override: EntitlementOverride | null, now = new Date()): AccountPlan {
  if (override && (!override.active || override.revokedAt)) return { allowed: false, maxOwnedProjects: 0, aiTotalRuns: 0, aiDailyRuns: 0 };
  if (!override || (override.expiresAt && override.expiresAt <= now)) return { allowed: true, ...DEFAULT_PLAN };
  return { allowed: true, maxOwnedProjects: override.maxOwnedProjects, aiTotalRuns: override.aiTotalRunLimit, aiDailyRuns: override.aiDailyRunLimit };
}
