import type { AccountView, AuditView, StaffRole } from "../contracts/admin.ts";
import { accountPlan } from "../../projects/server/plan.ts";

/** One account_summary row (snake_case, from the list function or the detail JSON). */
export type SummaryRow = {
  profile_id: string; display_name: string; staff_role: string | null; plan_kind: string;
  override_max_owned: number | null; override_ai_total: number | null; override_ai_daily: number | null; override_expires_at: Date | string | null;
  active_owned_projects: number; ai_used_total: number; ai_used_today: number; entitlement_version: number; role_version: number; last_activity: Date | string | null;
};

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

/** Limits come from the same resolver admission uses, so the screen shows what is enforced, not what is stored. */
export function accountView(row: SummaryRow, now = new Date(), env: Partial<NodeJS.ProcessEnv> = process.env): AccountView {
  const staffRole = row.staff_role === "ADMIN" || row.staff_role === "MODERATOR" ? (row.staff_role as StaffRole) : null;
  const plan = row.plan_kind === "BLOCKED" || row.plan_kind === "CUSTOM" ? row.plan_kind : "DEFAULT";
  const stored = plan === "DEFAULT" ? null : {
    maxOwnedProjects: row.override_max_owned!, aiTotalRuns: row.override_ai_total, aiDailyRuns: row.override_ai_daily, expiresAt: iso(row.override_expires_at),
  };
  const effective = accountPlan(stored && {
    active: plan !== "BLOCKED", revokedAt: null, expiresAt: row.override_expires_at === null ? null : new Date(row.override_expires_at),
    maxOwnedProjects: stored.maxOwnedProjects, aiTotalRunLimit: stored.aiTotalRuns, aiDailyRunLimit: stored.aiDailyRuns,
  }, now, env, staffRole !== null);
  return {
    profileId: row.profile_id, displayName: row.display_name, staffRole, plan,
    limits: { maxOwnedProjects: effective.maxOwnedProjects, aiTotalRuns: effective.aiTotalRuns, aiDailyRuns: effective.aiDailyRuns },
    override: stored, activeOwnedProjects: row.active_owned_projects, aiUsed: { total: row.ai_used_total, today: row.ai_used_today },
    entitlementVersion: row.entitlement_version, roleVersion: row.role_version, lastActivityAt: iso(row.last_activity),
  };
}

/** The default plan without the staff exemption: what the limits editor starts from when an account has no stored override. */
export function defaultLimits(now = new Date(), env: Partial<NodeJS.ProcessEnv> = process.env): AccountView["limits"] {
  const { maxOwnedProjects, aiTotalRuns, aiDailyRuns } = accountPlan(null, now, env);
  return { maxOwnedProjects, aiTotalRuns, aiDailyRuns };
}

export function auditView(entry: Omit<AuditView, "createdAt"> & { createdAt: string }): AuditView {
  return { ...entry, createdAt: new Date(entry.createdAt).toISOString() };
}
