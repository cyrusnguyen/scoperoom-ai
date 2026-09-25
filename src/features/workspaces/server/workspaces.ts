import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../../../prisma/generated/client.ts";
import { resolveProfile } from "../../access/server/profile.ts";
import { createDatabase } from "../../../server/db.ts";
import type { CreatedWorkspace, CreateWorkspaceInput, WorkspaceErrorCode, WorkspaceHome, WorkspaceIdentity, WorkspaceLifecycleInput, WorkspaceLifecycleResult } from "../contracts/workspace.ts";
import { validateWorkspaceCreateInput, validateWorkspaceLifecycleInput } from "../contracts/workspace.ts";

const RECEIPT_OPERATION = "CREATE_WORKSPACE_V1";
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode) {
    super(code);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

function requestHash(input: CreateWorkspaceInput) {
  return createHash("sha256").update(JSON.stringify({ operation: RECEIPT_OPERATION, name: input.name })).digest("hex");
}

function isAvailable(entitlement: { active: boolean; expiresAt: Date | null; revokedAt: Date | null }) {
  return entitlement.active && !entitlement.revokedAt && (!entitlement.expiresAt || entitlement.expiresAt > new Date());
}

function createdWorkspaceFromReceipt(result: Prisma.JsonValue): CreatedWorkspace | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = result as Record<string, Prisma.JsonValue>;
  return typeof value.id === "string" && typeof value.name === "string" ? { id: value.id, name: value.name, replayed: true } : null;
}

async function withDatabase<T>(operation: (database: PrismaClient) => Promise<T>): Promise<T> {
  let database: PrismaClient | undefined;
  try {
    database = await createDatabase();
    return await operation(database);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("UNAVAILABLE");
  } finally {
    await database?.$disconnect();
  }
}

async function profileFor(database: PrismaClient, identity: WorkspaceIdentity) {
  try {
    return await resolveProfile(database, identity);
  } catch {
    throw new WorkspaceError("UNAVAILABLE");
  }
}

export async function getWorkspaceHome(identity: WorkspaceIdentity): Promise<WorkspaceHome> {
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    const [entitlement, ownedCount, memberships] = await Promise.all([
      database.pilotEntitlement.findUnique({ where: { profileId: profile.id } }),
      database.workspace.count({ where: { ownerId: profile.id, status: { in: ["ACTIVE", "SUSPENDED"] } } }),
      database.workspaceMembership.findMany({
        where: { profileId: profile.id, active: true, workspace: { status: { in: ["ACTIVE", "ARCHIVED"] } } },
        orderBy: { workspace: { createdAt: "asc" } },
        select: { role: true, workspace: { select: { id: true, name: true, createdAt: true, status: true, version: true, ownerId: true } } },
      }),
    ]);
    const maxWorkspaces = entitlement?.maxWorkspaces ?? 0;
    return {
      profileId: profile.id,
      displayName: profile.displayName,
      canCreate: Boolean(entitlement && isAvailable(entitlement) && ownedCount < maxWorkspaces),
      maxWorkspaces,
      ownedCount,
      workspaces: memberships.map(({ workspace, role }) => ({ id: workspace.id, name: workspace.name, createdAt: workspace.createdAt.toISOString(), status: workspace.status as "ACTIVE" | "ARCHIVED", version: workspace.version, canManage: workspace.ownerId === profile.id && role === "OWNER" })),
    };
  });
}

export async function createWorkspace(identity: WorkspaceIdentity, input: CreateWorkspaceInput): Promise<CreatedWorkspace> {
  let validated: CreateWorkspaceInput;
  try {
    validated = validateWorkspaceCreateInput(input);
  } catch {
    throw new WorkspaceError("INVALID_INPUT");
  }
  const hash = requestHash(validated);

  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      const profiles = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "app"."user_profile"
        WHERE "id" = ${profile.id}::uuid AND "auth_user_id" = ${identity.authUserId}::uuid
        FOR UPDATE
      `);
      if (profiles.length !== 1) throw new WorkspaceError("UNAVAILABLE");
      await transaction.$queryRaw(Prisma.sql`SELECT app.lock_pilot_entitlement(${profile.id}::uuid)::text AS locked`);
      const receipt = await transaction.mutationReceipt.findFirst({
        where: { actorId: profile.id, scopeKind: "USER", scopeId: profile.id, key: validated.key, expiresAt: { gt: new Date() } },
        select: { requestHash: true, result: true },
      });
      if (receipt) {
        if (receipt.requestHash !== hash) throw new WorkspaceError("KEY_REUSED");
        const replay = createdWorkspaceFromReceipt(receipt.result);
        if (!replay) throw new WorkspaceError("UNAVAILABLE");
        const workspace = await transaction.workspace.findFirst({ where: { id: replay.id, ownerId: profile.id, status: { in: ["ACTIVE", "ARCHIVED"] }, memberships: { some: { profileId: profile.id, role: "OWNER", active: true } } }, select: { id: true, name: true } });
        if (!workspace) throw new WorkspaceError("UNAVAILABLE");
        return { ...workspace, replayed: true };
      }

      const entitlement = await transaction.pilotEntitlement.findUnique({ where: { profileId: profile.id } });
      if (!entitlement || !isAvailable(entitlement)) throw new WorkspaceError("NOT_ENTITLED");

      const ownedCount = await transaction.workspace.count({ where: { ownerId: profile.id, status: { in: ["ACTIVE", "SUSPENDED"] } } });
      if (ownedCount >= entitlement.maxWorkspaces) throw new WorkspaceError("LIMIT_REACHED");

      const workspace = await transaction.workspace.create({
        data: {
          ownerId: profile.id,
          name: validated.name,
          memberships: { create: { profileId: profile.id, role: "OWNER" } },
        },
        select: { id: true, name: true },
      });
      await transaction.mutationReceipt.create({
        data: {
          actorId: profile.id,
          scopeKind: "USER",
          scopeId: profile.id,
          key: validated.key,
          operation: RECEIPT_OPERATION,
          requestHash: hash,
          result: { id: workspace.id, name: workspace.name },
          expiresAt: new Date(Date.now() + RECEIPT_RETENTION_MS),
        },
      });
      return { ...workspace, replayed: false };
    });
  });
}

function lifecycleHash(operation: string, input: WorkspaceLifecycleInput) {
  return createHash("sha256").update(JSON.stringify({ operation, workspaceId: input.workspaceId, expectedVersion: input.expectedVersion })).digest("hex");
}

function lifecycleResult(value: Prisma.JsonValue): Omit<WorkspaceLifecycleResult, "replayed"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, Prisma.JsonValue>;
  if (typeof result.id !== "string" || (result.status !== "ACTIVE" && result.status !== "ARCHIVED") || !Number.isSafeInteger(result.version)) return null;
  return { id: result.id, status: result.status, version: result.version as number };
}

async function transitionWorkspace(identity: WorkspaceIdentity, input: WorkspaceLifecycleInput, operation: "ARCHIVE_WORKSPACE_V1" | "RESTORE_WORKSPACE_V1"): Promise<WorkspaceLifecycleResult> {
  let validated: WorkspaceLifecycleInput;
  try { validated = validateWorkspaceLifecycleInput(input); } catch { throw new WorkspaceError("INVALID_INPUT"); }
  const nextStatus = operation === "ARCHIVE_WORKSPACE_V1" ? "ARCHIVED" : "ACTIVE";
  const priorStatus = nextStatus === "ARCHIVED" ? "ACTIVE" : "ARCHIVED";
  const hash = lifecycleHash(operation, validated);
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      const profiles = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM app.user_profile WHERE id = ${profile.id}::uuid AND auth_user_id = ${identity.authUserId}::uuid FOR UPDATE
      `);
      if (profiles.length !== 1) throw new WorkspaceError("NOT_FOUND");
      if (nextStatus === "ACTIVE") await transaction.$queryRaw(Prisma.sql`SELECT app.lock_pilot_entitlement(${profile.id}::uuid)::text AS locked`);
      await transaction.$queryRaw(Prisma.sql`SELECT app.lock_workspace_for_project_creation(${validated.workspaceId}::uuid)::text AS locked`);
      const workspace = await transaction.workspace.findFirst({
        where: { id: validated.workspaceId, ownerId: profile.id, status: { in: ["ACTIVE", "ARCHIVED"] }, memberships: { some: { profileId: profile.id, role: "OWNER", active: true } } },
        select: { id: true, status: true, version: true },
      });
      if (!workspace) throw new WorkspaceError("NOT_FOUND");
      const receipt = await transaction.mutationReceipt.findFirst({
        where: { actorId: profile.id, scopeKind: "WORKSPACE", scopeId: workspace.id, key: validated.key, expiresAt: { gt: new Date() } },
        select: { operation: true, requestHash: true, result: true },
      });
      if (receipt) {
        if (receipt.operation !== operation || receipt.requestHash !== hash) throw new WorkspaceError("KEY_REUSED");
        const result = lifecycleResult(receipt.result);
        if (!result || result.id !== workspace.id) throw new WorkspaceError("UNAVAILABLE");
        return { ...result, replayed: true };
      }
      if (workspace.status !== priorStatus || workspace.version !== validated.expectedVersion) throw new WorkspaceError("CONFLICT");
      if (nextStatus === "ACTIVE") {
        const entitlement = await transaction.pilotEntitlement.findUnique({ where: { profileId: profile.id } });
        if (!entitlement || !isAvailable(entitlement)) throw new WorkspaceError("NOT_ENTITLED");
        const activeCount = await transaction.workspace.count({ where: { ownerId: profile.id, status: { in: ["ACTIVE", "SUSPENDED"] } } });
        if (activeCount >= entitlement.maxWorkspaces) throw new WorkspaceError("LIMIT_REACHED");
      }
      const updated = await transaction.workspace.update({ where: { id: workspace.id }, data: { status: nextStatus, version: { increment: 1 } }, select: { id: true, status: true, version: true } });
      if (nextStatus === "ARCHIVED") {
        await transaction.invitation.updateMany({ where: { workspaceId: workspace.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { revokedAt: new Date(), version: { increment: 1 } } });
      }

      const projects = await transaction.project.findMany({ where: { workspaceId: workspace.id, status: { in: ["ACTIVE", "ARCHIVED"] } }, select: { id: true, eventSequence: true } });
      for (const project of projects) {
        const sequence = project.eventSequence + BigInt(1);
        await transaction.project.update({ where: { id: project.id }, data: { realtimeEpoch: randomUUID(), eventSequence: sequence } });
        await transaction.auditEvent.create({ data: { projectId: project.id, workspaceId: workspace.id, sequence, actorId: profile.id, action: operation === "ARCHIVE_WORKSPACE_V1" ? "WORKSPACE_ARCHIVED" : "WORKSPACE_RESTORED", entityRefs: [{ kind: "WORKSPACE", id: workspace.id }], metadata: {} } });
      }
      const result = { id: updated.id, status: updated.status as "ACTIVE" | "ARCHIVED", version: updated.version };
      await transaction.mutationReceipt.create({ data: { actorId: profile.id, scopeKind: "WORKSPACE", scopeId: workspace.id, key: validated.key, operation, requestHash: hash, result, expiresAt: new Date(Date.now() + RECEIPT_RETENTION_MS) } });
      return { ...result, replayed: false };
    });
  });
}

export function archiveWorkspace(identity: WorkspaceIdentity, input: WorkspaceLifecycleInput) {
  return transitionWorkspace(identity, input, "ARCHIVE_WORKSPACE_V1");
}

export function restoreWorkspace(identity: WorkspaceIdentity, input: WorkspaceLifecycleInput) {
  return transitionWorkspace(identity, input, "RESTORE_WORKSPACE_V1");
}
