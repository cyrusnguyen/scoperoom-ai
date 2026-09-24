import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../../../../prisma/generated/client.ts";
import { resolveProfile } from "../../access/server/profile.ts";
import { createDatabase } from "../../../server/db.ts";
import type { CreatedWorkspace, CreateWorkspaceInput, WorkspaceErrorCode, WorkspaceHome, WorkspaceIdentity } from "../contracts/workspace.ts";
import { validateWorkspaceCreateInput } from "../contracts/workspace.ts";

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
      database.workspace.count({ where: { ownerId: profile.id } }),
      database.workspaceMembership.findMany({
        where: { profileId: profile.id, active: true, workspace: { status: "ACTIVE" } },
        orderBy: { workspace: { createdAt: "asc" } },
        select: { workspace: { select: { id: true, name: true, createdAt: true } } },
      }),
    ]);
    const maxWorkspaces = entitlement?.maxWorkspaces ?? 0;
    return {
      profileId: profile.id,
      displayName: profile.displayName,
      canCreate: Boolean(entitlement && isAvailable(entitlement) && ownedCount < maxWorkspaces),
      maxWorkspaces,
      ownedCount,
      workspaces: memberships.map(({ workspace }) => ({ id: workspace.id, name: workspace.name, createdAt: workspace.createdAt.toISOString() })),
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
        const workspace = await transaction.workspace.findFirst({ where: { id: replay.id, ownerId: profile.id, status: "ACTIVE", memberships: { some: { profileId: profile.id, role: "OWNER", active: true } } }, select: { id: true, name: true } });
        if (!workspace) throw new WorkspaceError("UNAVAILABLE");
        return { ...workspace, replayed: true };
      }

      const entitlement = await transaction.pilotEntitlement.findUnique({ where: { profileId: profile.id } });
      if (!entitlement || !isAvailable(entitlement)) throw new WorkspaceError("NOT_ENTITLED");

      const ownedCount = await transaction.workspace.count({ where: { ownerId: profile.id } });
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





