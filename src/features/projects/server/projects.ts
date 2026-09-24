import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../../../../prisma/generated/client.ts";
import { resolveProfile } from "../../access/server/profile.ts";
import { createDatabase } from "../../../server/db.ts";
import type { CreatedProject, CreateProjectInput, ProjectBootstrap, ProjectErrorCode, ProjectIdentity, WorkspaceProjects } from "../contracts/project.ts";
import { uuid, validateProjectCreateInput } from "../contracts/project.ts";

const OPERATION = "CREATE_PROJECT_V1";
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const emptyDocument = {
  schemaVersion: 3,
  projectGoal: "",
  flows: {}, nodes: {}, edges: {}, requirements: {}, traceLinks: {},
  scenarios: {}, questions: {}, decisions: {}, dependencies: {}, waivers: {},
  retiredEntityIds: [],
} as const;
const emptyLayout = { schemaVersion: 1, positions: {}, directions: {} } as const;

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;

  constructor(code: ProjectErrorCode) {
    super(code);
    this.name = "ProjectError";
    this.code = code;
  }
}

function requestHash(input: CreateProjectInput) {
  return createHash("sha256").update(JSON.stringify({ operation: OPERATION, workspaceId: input.workspaceId, name: input.name })).digest("hex");
}

function entitlementActive(entitlement: { active: boolean; expiresAt: Date | null; revokedAt: Date | null } | null) {
  return Boolean(entitlement?.active && !entitlement.revokedAt && (!entitlement.expiresAt || entitlement.expiresAt > new Date()));
}

function receiptProjectId(result: Prisma.JsonValue): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const id = (result as Record<string, Prisma.JsonValue>).id;
  return typeof id === "string" ? id : null;
}

async function withDatabase<T>(run: (database: PrismaClient) => Promise<T>): Promise<T> {
  let database: PrismaClient | undefined;
  try {
    database = await createDatabase();
    return await run(database);
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError("UNAVAILABLE");
  } finally {
    await database?.$disconnect();
  }
}

async function profileFor(database: PrismaClient, identity: ProjectIdentity) {
  try {
    return await resolveProfile(database, identity);
  } catch {
    throw new ProjectError("UNAVAILABLE");
  }
}

export async function getWorkspaceProjects(identity: ProjectIdentity, workspaceId: string): Promise<WorkspaceProjects> {
  if (!uuid.test(workspaceId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    const workspace = await database.workspace.findFirst({
      where: { id: workspaceId, status: "ACTIVE", memberships: { some: { profileId: profile.id, active: true } } },
      select: { id: true, name: true, ownerId: true },
    });
    if (!workspace) throw new ProjectError("NOT_FOUND");
    const owner = workspace.ownerId === profile.id;
    const [entitlement, projects] = await Promise.all([
      owner ? database.pilotEntitlement.findUnique({ where: { profileId: profile.id } }) : Promise.resolve(null),
      owner ? database.project.findMany({
        where: { workspaceId, status: "ACTIVE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, name: true, status: true, currentDraftId: true, createdAt: true },
      }) : Promise.resolve([]),
    ]);
    return {
      workspace: { id: workspace.id, name: workspace.name, canCreateProject: owner && entitlementActive(entitlement) },
      projects: projects.filter((project) => project.currentDraftId !== null).map((project) => ({
        id: project.id, name: project.name, status: project.status, currentDraftId: project.currentDraftId!, createdAt: project.createdAt.toISOString(),
      })),
    };
  });
}

export async function getProjectBootstrap(identity: ProjectIdentity, projectId: string): Promise<ProjectBootstrap> {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    const project = await database.project.findFirst({
      where: { id: projectId, status: "ACTIVE", workspace: { status: "ACTIVE", ownerId: profile.id, memberships: { some: { profileId: profile.id, role: "OWNER", active: true } } } },
      include: { currentDraft: true },
    });
    if (!project || !project.currentDraft || project.currentDraft.status !== "EDITABLE") throw new ProjectError("NOT_FOUND");
    const draft = project.currentDraft;
    return {
      project: { id: project.id, workspaceId: project.workspaceId, name: project.name, status: project.status, role: "OWNER" },
      draft: { id: draft.id, schemaVersion: 3, documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision, documentJson: draft.documentJson, layoutJson: draft.layoutJson },
    };
  });
}

export async function createProject(identity: ProjectIdentity, input: CreateProjectInput): Promise<CreatedProject> {
  let validated: CreateProjectInput;
  try {
    validated = validateProjectCreateInput(input);
  } catch {
    throw new ProjectError("INVALID_INPUT");
  }
  const hash = requestHash(validated);
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      const currentProfile = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM app.user_profile WHERE id = ${profile.id}::uuid AND auth_user_id = ${identity.authUserId}::uuid FOR SHARE
      `);
      if (currentProfile.length !== 1) throw new ProjectError("NOT_AUTHORIZED");
      await transaction.$queryRaw(Prisma.sql`SELECT app.lock_workspace_for_project_creation(${validated.workspaceId}::uuid)::text AS locked`);
      const workspace = await transaction.workspace.findFirst({
        where: { id: validated.workspaceId, status: "ACTIVE", ownerId: profile.id, memberships: { some: { profileId: profile.id, role: "OWNER", active: true } } },
        select: { id: true },
      });
      if (!workspace) throw new ProjectError("NOT_AUTHORIZED");

      const receipt = await transaction.mutationReceipt.findFirst({
        where: { actorId: profile.id, scopeKind: "WORKSPACE", scopeId: workspace.id, key: validated.key, expiresAt: { gt: new Date() } },
        select: { operation: true, requestHash: true, result: true },
      });
      if (receipt) {
        if (receipt.operation !== OPERATION || receipt.requestHash !== hash) throw new ProjectError("KEY_REUSED");
        const id = receiptProjectId(receipt.result);
        if (!id) throw new ProjectError("UNAVAILABLE");
        const project = await transaction.project.findFirst({ where: { id, workspaceId: workspace.id }, select: { id: true, name: true } });
        if (!project) throw new ProjectError("UNAVAILABLE");
        return { ...project, workspaceId: workspace.id, replayed: true };
      }

      await transaction.$queryRaw(Prisma.sql`SELECT app.lock_pilot_entitlement(${profile.id}::uuid)::text AS locked`);
      const entitlement = await transaction.pilotEntitlement.findUnique({ where: { profileId: profile.id } });
      if (!entitlementActive(entitlement)) throw new ProjectError("NOT_ENTITLED");

      const project = await transaction.project.create({
        data: { workspaceId: workspace.id, name: validated.name, eventSequence: BigInt(1) },
        select: { id: true, name: true },
      });
      const draft = await transaction.scopeDraft.create({
        data: { projectId: project.id, createdBy: profile.id, documentJson: emptyDocument, layoutJson: emptyLayout },
        select: { id: true },
      });
      await transaction.project.update({ where: { id: project.id }, data: { currentDraftId: draft.id } });
      await transaction.auditEvent.create({
        data: { projectId: project.id, workspaceId: workspace.id, sequence: BigInt(1), actorId: profile.id, action: "PROJECT_CREATED", entityRefs: [{ kind: "PROJECT", id: project.id }], metadata: {} },
      });
      await transaction.mutationReceipt.create({
        data: { actorId: profile.id, scopeKind: "WORKSPACE", scopeId: workspace.id, key: validated.key, operation: OPERATION, requestHash: hash, result: { id: project.id, workspaceId: workspace.id, name: project.name }, expiresAt: new Date(Date.now() + RECEIPT_RETENTION_MS) },
      });
      return { ...project, workspaceId: workspace.id, replayed: false };
    });
  });
}
