import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../../../../prisma/generated/client.ts";
import { getDatabase } from "../../../server/db.ts";
import { resolveProfile } from "../../access/server/profile.ts";
import type { ProjectAccessRole, ProjectIdentity } from "../contracts/project.ts";
import { ProjectError } from "./errors.ts";

export type Transaction = Prisma.TransactionClient;
export const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ProjectRow = {
  id: string;
  ownerId: string;
  name: string;
  status: "ACTIVE" | "ARCHIVED";
  version: number;
  settingsVersion: number;
  approvalPolicyVersion: number;
  membershipVersion: number;
  designatedApproverId: string | null;
  currentDraftId: string | null;
  realtimeEpoch: string;
  eventSequence: bigint;
  role: ProjectAccessRole | null;
};

type RawProject = {
  id: string; owner_id: string; name: string; status: string; version: number; settings_version: number;
  approval_policy_version: number; membership_version: number; designated_approver_id: string | null;
  current_draft_id: string | null; realtime_epoch: string; event_sequence: bigint; role: string | null;
};

export function requestHash(operation: string, input: unknown) {
  return createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");
}

export async function withDatabase<T>(run: (database: PrismaClient) => Promise<T>): Promise<T> {
  try {
    return await run(await getDatabase());
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError("UNAVAILABLE");
  }
}

/** Ordinary reads: one read-only REPEATABLE READ snapshot with no row locks. Resolve the profile before calling. */
export function withReadSnapshot<T>(database: PrismaClient, run: (tx: Transaction) => Promise<T>): Promise<T> {
  return database.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return run(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function profileFor(database: PrismaClient, identity: ProjectIdentity) {
  try {
    return await resolveProfile(database, identity);
  } catch {
    throw new ProjectError("UNAVAILABLE");
  }
}

/** Lock order 1: the actor's profile, rechecking the Auth-to-profile mapping. */
export async function lockActor(tx: Transaction, profileId: string, authUserId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM app.user_profile WHERE id = ${profileId}::uuid AND auth_user_id = ${authUserId}::uuid FOR SHARE`;
  if (rows.length !== 1) throw new ProjectError("FORBIDDEN");
}

function projectQuery(profileId: string, projectId: string, lock: boolean) {
  return Prisma.sql`
    SELECT project.id, project.owner_id, project.name, project.status::text AS status, project.version, project.settings_version,
      project.approval_policy_version, project.membership_version, project.designated_approver_id, project.current_draft_id,
      project.realtime_epoch::text AS realtime_epoch, project.event_sequence,
      CASE WHEN project.owner_id = ${profileId}::uuid THEN 'OWNER' ELSE membership.role::text END AS role
    FROM app.project project
    LEFT JOIN app.project_membership membership
      ON membership.project_id = project.id AND membership.profile_id = ${profileId}::uuid AND membership.active
    WHERE project.id = ${projectId}::uuid AND project.status IN ('ACTIVE'::app.project_status, 'ARCHIVED'::app.project_status)
    ${lock ? Prisma.sql`FOR UPDATE OF project` : Prisma.empty}`;
}

function toProjectRow(row: RawProject | undefined): ProjectRow {
  if (!row || (row.status !== "ACTIVE" && row.status !== "ARCHIVED")) throw new ProjectError("NOT_FOUND");
  const role = row.role === "OWNER" || row.role === "EDITOR" || row.role === "REVIEWER" || row.role === "VIEWER" ? row.role : null;
  return {
    id: row.id, ownerId: row.owner_id, name: row.name, status: row.status, version: row.version, settingsVersion: row.settings_version,
    approvalPolicyVersion: row.approval_policy_version, membershipVersion: row.membership_version, designatedApproverId: row.designated_approver_id,
    currentDraftId: row.current_draft_id, realtimeEpoch: row.realtime_epoch, eventSequence: row.event_sequence, role,
  };
}

/** Reads the project and the caller's role without row locks (read snapshots, and before a capacity lock). */
export async function readProject(tx: Transaction, profileId: string, projectId: string) {
  return toProjectRow((await tx.$queryRaw<RawProject[]>(projectQuery(profileId, projectId, false)))[0]);
}

/** Lock order 3: the project row, for mutations only. */
export async function lockProject(tx: Transaction, profileId: string, projectId: string) {
  return toProjectRow((await tx.$queryRaw<RawProject[]>(projectQuery(profileId, projectId, true)))[0]);
}

/** Lock order 2: the owner capacity guard shared by project creation and restore. Operators lock the same row. */
export async function lockOwnerCapacity(tx: Transaction, ownerId: string) {
  await tx.$queryRaw`SELECT app.lock_pilot_entitlement(${ownerId}::uuid)::text AS locked`;
}

export function entitlementActive(entitlement: { active: boolean; expiresAt: Date | null; revokedAt: Date | null } | null): boolean {
  return Boolean(entitlement?.active && !entitlement.revokedAt && (!entitlement.expiresAt || entitlement.expiresAt > new Date()));
}

/** Call after lockOwnerCapacity in the same READ COMMITTED transaction so the count includes every committed project. */
export async function assertOwnerCapacity(tx: Transaction, ownerId: string) {
  const entitlement = await tx.pilotEntitlement.findUnique({ where: { profileId: ownerId } });
  if (!entitlement || !entitlementActive(entitlement)) throw new ProjectError("ENTITLEMENT_REQUIRED");
  const activeOwned = await tx.project.count({ where: { ownerId, status: "ACTIVE" } });
  if (activeOwned >= entitlement.maxOwnedProjects) throw new ProjectError("OWNED_PROJECT_LIMIT", { activeOwned, maxOwned: entitlement.maxOwnedProjects });
}

export function requireOwner(project: ProjectRow) {
  if (project.role !== "OWNER") throw new ProjectError("NOT_FOUND");
}

export function requireMember(project: ProjectRow): ProjectAccessRole {
  if (!project.role) throw new ProjectError("NOT_FOUND");
  return project.role;
}

export function requireActive(project: ProjectRow) {
  if (project.status !== "ACTIVE") throw new ProjectError("CONFLICT");
}

/** Assigns the next per-project event sequence (under the project lock) and writes its audit event. */
export async function recordEvent(tx: Transaction, project: Pick<ProjectRow, "id" | "eventSequence">, actorId: string, action: string, entityRefs: Prisma.InputJsonValue, metadata: Prisma.InputJsonValue) {
  const sequence = project.eventSequence + BigInt(1);
  await tx.$executeRaw`UPDATE app.project SET event_sequence = ${sequence}::bigint, updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`;
  await tx.auditEvent.create({ data: { projectId: project.id, sequence, actorId, action, entityRefs, metadata } });
  return sequence;
}

export function findReceipt(tx: Transaction, actorId: string, scopeKind: "USER" | "PROJECT", scopeId: string, key: string) {
  return tx.mutationReceipt.findFirst({
    where: { actorId, scopeKind, scopeId, key, expiresAt: { gt: new Date() } },
    select: { operation: true, requestHash: true, result: true },
  });
}

/** A receipt is only a lookup: callers must still revalidate current access before returning its result. */
export function checkReceipt(receipt: { operation: string; requestHash: string }, operation: string, hash: string) {
  if (receipt.operation !== operation || receipt.requestHash !== hash) throw new ProjectError("KEY_REUSED");
}

export async function saveReceipt(tx: Transaction, actorId: string, scopeKind: "USER" | "PROJECT", scopeId: string, key: string, operation: string, hash: string, result: Prisma.InputJsonValue) {
  await tx.mutationReceipt.create({ data: { actorId, scopeKind, scopeId, key, operation, requestHash: hash, result, expiresAt: new Date(Date.now() + RECEIPT_RETENTION_MS) } });
}

export function receiptString(result: Prisma.JsonValue, field: string): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = (result as Record<string, Prisma.JsonValue>)[field];
  return typeof value === "string" ? value : null;
}
