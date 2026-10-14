import { invalid, keys, MAX_VERSION, object, oneOf, text } from "../../drafts/contracts/strict.ts";
import { keyPattern, uuid } from "../../projects/contracts/project.ts";

export const STAFF_ROLES = ["ADMIN", "MODERATOR"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const QUERY_MAX = 100;
export const ACCOUNT_PAGE_SIZE = 25;

export type EntitlementInput =
  | { key: string; expectedVersion: number; reason: string; reset: true }
  | { key: string; expectedVersion: number; reason: string; reset: false; maxOwnedProjects: number; aiTotalRuns: number | null; aiDailyRuns: number | null; expiresAt: string | null; blocked: boolean };
export type RoleInput = { key: string; expectedVersion: number; reason: string; role: StaffRole | null };

export type AccountView = {
  profileId: string; displayName: string; staffRole: StaffRole | null; plan: "DEFAULT" | "CUSTOM" | "BLOCKED";
  /** What is enforced today: the plan after expiry, a block and the staff exemption. A null AI limit is unlimited. */
  limits: { maxOwnedProjects: number; aiTotalRuns: number | null; aiDailyRuns: number | null };
  /** The stored override (what an editor starts from), or null on the default plan. */
  override: { maxOwnedProjects: number; aiTotalRuns: number | null; aiDailyRuns: number | null; expiresAt: string | null } | null;
  activeOwnedProjects: number; aiUsed: { total: number; today: number };
  entitlementVersion: number; roleVersion: number; lastActivityAt: string | null;
};
export type AuditView = { id: string; actorId: string; actorName: string | null; action: string; before: unknown; after: unknown; reason: string; createdAt: string };

/** The Idempotency-Key header arrives as `key`; the version may be 0 (no row yet), unlike record versions. */
function common(value: Record<string, unknown>) {
  if (typeof value.key !== "string" || !keyPattern.test(value.key)) invalid();
  if (typeof value.expectedVersion !== "number" || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 0 || value.expectedVersion > MAX_VERSION) invalid();
  if (typeof value.reason !== "string") invalid();
  const reason = value.reason.normalize("NFC").trim();
  text(reason, 500, true);
  return { key: value.key, expectedVersion: value.expectedVersion, reason };
}

function limit(value: unknown, nullable: boolean) {
  if (value === null && nullable) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_VERSION) invalid();
  return value;
}

export function validateEntitlementInput(input: unknown): EntitlementInput {
  const value = object(input);
  if (value.reset === true) {
    keys(value, ["key", "expectedVersion", "reason", "reset"]);
    return { ...common(value), reset: true };
  }
  keys(value, ["key", "expectedVersion", "reason", "maxOwnedProjects", "aiTotalRuns", "aiDailyRuns", "expiresAt", "blocked"], ["reset"]);
  if (value.reset !== undefined && value.reset !== false) invalid();
  if (typeof value.blocked !== "boolean") invalid();
  let expiresAt: string | null = null;
  if (value.expiresAt !== null) {
    if (typeof value.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value.expiresAt)) invalid();
    const parsed = new Date(value.expiresAt);
    if (Number.isNaN(parsed.getTime())) invalid();
    expiresAt = parsed.toISOString();
  }
  return {
    ...common(value), reset: false, maxOwnedProjects: limit(value.maxOwnedProjects, false) as number,
    aiTotalRuns: limit(value.aiTotalRuns, true), aiDailyRuns: limit(value.aiDailyRuns, true), expiresAt, blocked: value.blocked,
  };
}

export function validateRoleInput(input: unknown): RoleInput {
  const value = object(input);
  keys(value, ["key", "expectedVersion", "reason", "role"]);
  return { ...common(value), role: value.role === null ? null : oneOf(value.role, STAFF_ROLES) };
}

/** A search term: trimmed, at most 100 characters; empty means everything. */
export function validateAccountQuery(query: string | undefined): string | null {
  const trimmed = query?.normalize("NFC").trim() ?? "";
  if ([...trimmed].length > QUERY_MAX || trimmed.includes("\u0000") || !trimmed.isWellFormed()) invalid();
  return trimmed || null;
}

export function encodeAccountCursor(name: string, id: string) {
  return Buffer.from(JSON.stringify([name, id])).toString("base64url");
}

export function decodeAccountCursor(cursor: string): [string, string] {
  try {
    if (!/^[A-Za-z0-9_-]{1,400}$/.test(cursor)) throw new Error();
    const [name, id, ...rest] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown[];
    if (typeof name !== "string" || typeof id !== "string" || rest.length || !name.isWellFormed() || name.includes("\u0000") || [...name].length > 120 || !uuid.test(id)) throw new Error();
    return [name, id.toLowerCase()];
  } catch {
    invalid();
  }
}
