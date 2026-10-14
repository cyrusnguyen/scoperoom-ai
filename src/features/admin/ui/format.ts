import type { AccountView, StaffRole } from "../contracts/admin.ts";

// Pure labels for the staff screens. Times are passed in so a render never reads the clock.

export const roleName = (role: StaffRole | null) => (role === "ADMIN" ? "Admin" : role === "MODERATOR" ? "Moderator" : "None");

/** Default, Custom, Blocked, or "Custom, expired" once the override's expiry has passed (the default plan applies then). */
export function planLabel(account: Pick<AccountView, "plan" | "override">, now: number): string {
  if (account.plan === "BLOCKED") return "Blocked";
  if (account.plan === "DEFAULT") return "Default";
  const expires = account.override?.expiresAt;
  return expires && Date.parse(expires) <= now ? "Custom, expired" : "Custom";
}

export const projectsLabel = (account: Pick<AccountView, "activeOwnedProjects" | "limits">) => `${account.activeOwnedProjects} of ${account.limits.maxOwnedProjects}`;

/** "used of limit", or "used, unlimited" when there is no limit. */
export const usageLabel = (used: number, limit: number | null) => (limit === null ? `${used}, unlimited` : `${used} of ${limit}`);

const UNITS: Array<[number, string]> = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"]];

/** "Never", "Just now", "5 minutes ago", "2 days ago", then a date after a month. */
export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "Never";
  const age = now - Date.parse(iso);
  if (age < 60_000) return "Just now";
  if (age >= 30 * 86_400_000) return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const [size, unit] = UNITS.find(([size]) => age >= size)!;
  const count = Math.floor(age / size);
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** A calendar date in UTC, the zone limit expiry is defined in. */
export const utcDate = (iso: string) => `${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} UTC`;

export const absoluteTime = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export function actionLabel(action: string): string {
  switch (action) {
    case "ENTITLEMENT_SET": return "Changed limits";
    case "ENTITLEMENT_RESET": return "Reset to the default plan";
    case "ROLE_SET": return "Set role";
    case "ROLE_REVOKED": return "Removed role";
    default: return action.toLowerCase().replaceAll("_", " ");
  }
}

const limit = (value: unknown) => (value === null || value === undefined ? "unlimited" : String(value));

/** One audit snapshot in words: a limits object, a role object, or null (the default plan, or no role). */
export function snapshotLabel(action: string, value: unknown): string {
  if (action.startsWith("ROLE_")) return roleName(value && typeof value === "object" && "role" in value ? (value.role as StaffRole | null) : null);
  if (!value || typeof value !== "object") return "Default plan";
  const v = value as Record<string, unknown>;
  const parts = [`Projects ${limit(v.maxOwnedProjects)}`, `AI total ${limit(v.aiTotalRunLimit)}`, `AI daily ${limit(v.aiDailyRunLimit)}`];
  parts.push(typeof v.expiresAt === "string" ? `Expires ${utcDate(v.expiresAt)}` : "No expiry");
  if (v.blocked === true) parts.push("Blocked");
  return parts.join(", ");
}

export const MAX_LIMIT = 2_147_483_647;
/** A whole number from 0 to the server's maximum, or null when the text is anything else. */
export function parseLimit(text: string): number | null {
  if (!/^\d{1,10}$/.test(text)) return null;
  const value = Number(text);
  return value <= MAX_LIMIT ? value : null;
}

/** The expiry date is the end of that day in UTC; an unchanged date keeps the stored instant exactly. */
export function expiryFor(date: string, original: string | null): string | null {
  if (!date) return null;
  return original && original.slice(0, 10) === date ? original : `${date}T23:59:59.000Z`;
}
