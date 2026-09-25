import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../../../prisma/generated/client.ts";
import { readProcessEnv } from "../../../server/env.ts";
import { createDatabase } from "../../../server/db.ts";
import { resolveProfile } from "../../access/server/profile.ts";
import { uuid, type ProjectIdentity } from "../contracts/project.ts";
import { type ProjectMemberRole, validateInvitationAcceptInput, validateInvitationIssueInput, validateInvitationRevokeInput } from "../contracts/invitation.ts";
import { ProjectError } from "./projects.ts";

const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const ISSUE_OPERATION = "ISSUE_INVITATION_V1";
const REVOKE_OPERATION = "REVOKE_INVITATION_V1";
const ACCEPT_OPERATION = "ACCEPT_INVITATION_V1";

export type InvitationIdentity = ProjectIdentity & { verifiedEmail: string };

type LockedProject = {
  id: string;
  workspaceId: string;
  eventSequence: bigint;
  role: "OWNER" | ProjectMemberRole | null;
};

type InvitationRecord = {
  id: string;
  projectId: string;
  workspaceId: string;
  verifiedEmail: string;
  role: ProjectMemberRole;
  version: number;
  expiresAt: Date;
  acceptedBy: string | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
};

function requestHash(operation: string, input: unknown) {
  return createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function invitationStatus(invitation: Pick<InvitationRecord, "acceptedAt" | "revokedAt" | "expiresAt">) {
  if (invitation.acceptedAt) return "ACCEPTED" as const;
  if (invitation.revokedAt) return "REVOKED" as const;
  return invitation.expiresAt <= new Date() ? "EXPIRED" as const : "PENDING" as const;
}

function safeInvitation(invitation: InvitationRecord) {
  return {
    id: invitation.id,
    verifiedEmail: invitation.verifiedEmail,
    role: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
    status: invitationStatus(invitation),
    version: invitation.version,
  };
}

function safeIssuedResult(result: Prisma.JsonValue) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = result as Record<string, Prisma.JsonValue>;
  if (typeof value.id !== "string" || typeof value.verifiedEmail !== "string" ||
      (value.role !== "EDITOR" && value.role !== "REVIEWER" && value.role !== "VIEWER") ||
      typeof value.expiresAt !== "string" || typeof value.status !== "string" || !Number.isSafeInteger(value.version)) return null;
  return { id: value.id, verifiedEmail: value.verifiedEmail, role: value.role, expiresAt: value.expiresAt, status: value.status, version: value.version };
}

function safeAcceptedResult(result: Prisma.JsonValue) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = result as Record<string, Prisma.JsonValue>;
  if (typeof value.projectId !== "string" || typeof value.workspaceId !== "string" ||
      (value.role !== "OWNER" && value.role !== "EDITOR" && value.role !== "REVIEWER" && value.role !== "VIEWER")) return null;
  return { projectId: value.projectId, workspaceId: value.workspaceId, role: value.role } as const;
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

async function lockProject(transaction: Prisma.TransactionClient, profileId: string, projectId: string, update: boolean): Promise<LockedProject> {
  const location = await transaction.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (!location) throw new ProjectError("NOT_FOUND");
  await transaction.$queryRaw(Prisma.sql`SELECT app.lock_workspace_for_project_creation(${location.workspaceId}::uuid)::text AS locked`);
  const workspace = await transaction.workspace.findFirst({ where: { id: location.workspaceId, status: "ACTIVE" }, select: { id: true } });
  if (!workspace) throw new ProjectError("NOT_FOUND");
  const projects = update
    ? await transaction.$queryRaw<{ id: string; workspace_id: string; event_sequence: bigint }[]>(Prisma.sql`
      SELECT id, workspace_id, event_sequence FROM app.project WHERE id = ${projectId}::uuid AND workspace_id = ${location.workspaceId}::uuid AND status = 'ACTIVE'::app.project_status FOR UPDATE
    `)
    : await transaction.$queryRaw<{ id: string; workspace_id: string; event_sequence: bigint }[]>(Prisma.sql`
      SELECT id, workspace_id, event_sequence FROM app.project WHERE id = ${projectId}::uuid AND workspace_id = ${location.workspaceId}::uuid AND status = 'ACTIVE'::app.project_status FOR SHARE
    `);
  const project = projects[0];
  if (!project) throw new ProjectError("NOT_FOUND");
  const access = await transaction.$queryRaw<{ role: string | null }[]>(Prisma.sql`
    SELECT CASE
      WHEN workspace.owner_id = ${profileId}::uuid AND EXISTS (
        SELECT 1 FROM app.workspace_membership membership
        WHERE membership.workspace_id = workspace.id AND membership.profile_id = ${profileId}::uuid
          AND membership.role = 'OWNER'::app.workspace_member_role AND membership.active
      ) THEN 'OWNER'
      ELSE (
        SELECT membership.role::text FROM app.project_membership membership
        WHERE membership.project_id = project.id AND membership.profile_id = ${profileId}::uuid AND membership.active
      )
    END AS role
    FROM app.workspace workspace JOIN app.project project ON project.workspace_id = workspace.id
    WHERE project.id = ${projectId}::uuid
  `);
  const role = access[0]?.role;
  return { id: project.id, workspaceId: project.workspace_id, eventSequence: project.event_sequence, role: role === "OWNER" || role === "EDITOR" || role === "REVIEWER" || role === "VIEWER" ? role : null };
}

async function lockProfile(transaction: Prisma.TransactionClient, profileId: string, authUserId: string) {
  const profiles = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM app.user_profile WHERE id = ${profileId}::uuid AND auth_user_id = ${authUserId}::uuid FOR SHARE
  `);
  if (profiles.length !== 1) throw new ProjectError("NOT_AUTHORIZED");
}

function requireOwner(project: LockedProject) {
  if (project.role !== "OWNER") throw new ProjectError("NOT_FOUND");
}

function requireMember(project: LockedProject) {
  if (!project.role) throw new ProjectError("NOT_FOUND");
  return project.role;
}

async function receipt(transaction: Prisma.TransactionClient, actorId: string, scopeKind: "PROJECT" | "USER", scopeId: string, key: string) {
  return transaction.mutationReceipt.findFirst({
    where: { actorId, scopeKind, scopeId, key, expiresAt: { gt: new Date() } },
    select: { operation: true, requestHash: true, result: true },
  });
}

function invitationUrl(token: string) {
  let appUrl: string | undefined;
  try { appUrl = readProcessEnv().appUrl; } catch { throw new ProjectError("UNAVAILABLE"); }
  if (!appUrl) throw new ProjectError("UNAVAILABLE");
  return `${appUrl}/invite/${token}`;
}

export async function issueInvitation(identity: InvitationIdentity, projectId: string, input: unknown) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  let validated: ReturnType<typeof validateInvitationIssueInput>;
  try { validated = validateInvitationIssueInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const hash = requestHash(ISSUE_OPERATION, { projectId, verifiedEmail: validated.verifiedEmail, role: validated.role });
  const url = invitationUrl(randomBytes(32).toString("base64url"));
  const token = url.split("/").at(-1)!;
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      await lockProfile(transaction, profile.id, identity.authUserId);
      const project = await lockProject(transaction, profile.id, projectId, true);
      requireOwner(project);
      const previous = await receipt(transaction, profile.id, "PROJECT", project.id, validated.key);
      if (previous) {
        if (previous.operation !== ISSUE_OPERATION || previous.requestHash !== hash) throw new ProjectError("KEY_REUSED");
        const result = safeIssuedResult(previous.result);
        if (!result) throw new ProjectError("UNAVAILABLE");
        return { ...result, url: undefined, linkUnavailable: true, replayed: true };
      }
      const pending = await transaction.invitation.count({ where: { projectId: project.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
      if (pending >= 50) throw new ProjectError("INVITATION_LIMIT");
      const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
      const invitation = await transaction.invitation.create({
        data: { projectId: project.id, workspaceId: project.workspaceId, tokenHash: tokenHash(token), verifiedEmail: validated.verifiedEmail, role: validated.role as never, invitedBy: profile.id, expiresAt },
      });
      const safe = safeInvitation(invitation as InvitationRecord);
      const sequence = project.eventSequence + BigInt(1);
      await transaction.project.update({ where: { id: project.id }, data: { eventSequence: sequence } });
      await transaction.auditEvent.create({
        data: { projectId: project.id, workspaceId: project.workspaceId, sequence, actorId: profile.id, action: "INVITATION_ISSUED", entityRefs: [{ kind: "INVITATION", id: invitation.id }], metadata: { role: invitation.role, verifiedEmail: invitation.verifiedEmail } },
      });
      await transaction.mutationReceipt.create({
        data: { actorId: profile.id, scopeKind: "PROJECT", scopeId: project.id, key: validated.key, operation: ISSUE_OPERATION, requestHash: hash, result: safe, expiresAt: new Date(Date.now() + RECEIPT_RETENTION_MS) },
      });
      return { ...safe, url, linkUnavailable: false, replayed: false };
    });
  });
}

export async function listProjectInvitations(identity: ProjectIdentity, projectId: string) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      const project = await lockProject(transaction, profile.id, projectId, false);
      requireOwner(project);
      const invitations = await transaction.invitation.findMany({ where: { projectId: project.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
      return { invitations: invitations.map((invitation) => safeInvitation(invitation as InvitationRecord)) };
    });
  });
}

export async function revokeInvitation(identity: ProjectIdentity, projectId: string, invitationId: string, input: unknown) {
  if (!uuid.test(projectId) || !uuid.test(invitationId)) throw new ProjectError("NOT_FOUND");
  let validated: ReturnType<typeof validateInvitationRevokeInput>;
  try { validated = validateInvitationRevokeInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const hash = requestHash(REVOKE_OPERATION, { projectId, invitationId, expectedVersion: validated.expectedVersion });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      await lockProfile(transaction, profile.id, identity.authUserId);
      const project = await lockProject(transaction, profile.id, projectId, true);
      requireOwner(project);
      const previous = await receipt(transaction, profile.id, "PROJECT", project.id, validated.key);
      if (previous) {
        if (previous.operation !== REVOKE_OPERATION || previous.requestHash !== hash) throw new ProjectError("KEY_REUSED");
        const result = safeIssuedResult(previous.result);
        if (!result) throw new ProjectError("UNAVAILABLE");
        return { ...result, replayed: true };
      }
      const invitation = await transaction.invitation.findFirst({ where: { id: invitationId, projectId: project.id } });
      if (!invitation) throw new ProjectError("NOT_FOUND");
      const current = invitation as InvitationRecord;
      if (current.version !== validated.expectedVersion || current.acceptedAt || current.revokedAt || current.expiresAt <= new Date()) throw new ProjectError("CONFLICT");
      const revoked = await transaction.invitation.update({ where: { id: current.id }, data: { revokedAt: new Date(), version: { increment: 1 } } });
      const safe = safeInvitation(revoked as InvitationRecord);
      const sequence = project.eventSequence + BigInt(1);
      await transaction.project.update({ where: { id: project.id }, data: { eventSequence: sequence } });
      await transaction.auditEvent.create({
        data: { projectId: project.id, workspaceId: project.workspaceId, sequence, actorId: profile.id, action: "INVITATION_REVOKED", entityRefs: [{ kind: "INVITATION", id: current.id }], metadata: {} },
      });
      await transaction.mutationReceipt.create({
        data: { actorId: profile.id, scopeKind: "PROJECT", scopeId: project.id, key: validated.key, operation: REVOKE_OPERATION, requestHash: hash, result: safe, expiresAt: new Date(Date.now() + RECEIPT_RETENTION_MS) },
      });
      return { ...safe, replayed: false };
    });
  });
}

export async function acceptInvitation(identity: InvitationIdentity, input: unknown) {
  let validated: ReturnType<typeof validateInvitationAcceptInput>;
  try { validated = validateInvitationAcceptInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const hash = requestHash(ACCEPT_OPERATION, { tokenHash: tokenHash(validated.token) });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      await lockProfile(transaction, profile.id, identity.authUserId);
      const prior = await receipt(transaction, profile.id, "USER", profile.id, validated.key);
      if (prior) {
        if (prior.operation !== ACCEPT_OPERATION || prior.requestHash !== hash) throw new ProjectError("KEY_REUSED");
        const result = safeAcceptedResult(prior.result);
        if (!result) throw new ProjectError("UNAVAILABLE");
        const project = await lockProject(transaction, profile.id, result.projectId, false);
        requireMember(project);
        return { ...result, replayed: true };
      }
      const found = await transaction.invitation.findUnique({ where: { tokenHash: tokenHash(validated.token) } });
      if (!found) throw new ProjectError("NOT_FOUND");
      const project = await lockProject(transaction, profile.id, found.projectId, true);
      const completed = await receipt(transaction, profile.id, "USER", profile.id, validated.key);
      if (completed) {
        if (completed.operation !== ACCEPT_OPERATION || completed.requestHash !== hash) throw new ProjectError("KEY_REUSED");
        const result = safeAcceptedResult(completed.result);
        if (!result) throw new ProjectError("UNAVAILABLE");
        requireMember(project);
        return { ...result, replayed: true };
      }
      const invitation = await transaction.invitation.findUnique({ where: { id: found.id } });
      if (!invitation) throw new ProjectError("NOT_FOUND");
      const current = invitation as InvitationRecord;
      if (current.revokedAt || current.verifiedEmail !== identity.verifiedEmail.toLowerCase()) throw new ProjectError("NOT_FOUND");
      if (current.acceptedAt) {
        if (current.acceptedBy !== profile.id) throw new ProjectError("NOT_FOUND");
        const role = requireMember(project);
        const result = { projectId: project.id, workspaceId: project.workspaceId, role };
        await transaction.mutationReceipt.create({
          data: { actorId: profile.id, scopeKind: "USER", scopeId: profile.id, key: validated.key, operation: ACCEPT_OPERATION, requestHash: hash, result, expiresAt: new Date(Date.now() + RECEIPT_RETENTION_MS) },
        });
        return { ...result, replayed: true };
      }
      if (current.expiresAt <= new Date() || project.role) throw new ProjectError("NOT_FOUND");
      const activeCollaborators = await transaction.projectMembership.count({ where: { projectId: project.id, active: true } });
      if (activeCollaborators + 1 >= 10) throw new ProjectError("COLLABORATOR_LIMIT");
      const workspaceMembership = await transaction.workspaceMembership.findUnique({
        where: { workspaceId_profileId: { workspaceId: project.workspaceId, profileId: profile.id } },
        select: { active: true },
      });
      if (!workspaceMembership) {
        await transaction.workspaceMembership.create({ data: { workspaceId: project.workspaceId, profileId: profile.id, role: "MEMBER" } });
      } else if (!workspaceMembership.active) {
        await transaction.workspaceMembership.update({
          where: { workspaceId_profileId: { workspaceId: project.workspaceId, profileId: profile.id } },
          data: { active: true, version: { increment: 1 } },
        });
      }
      await transaction.projectMembership.create({ data: { projectId: project.id, profileId: profile.id, role: current.role as never } });
      await transaction.invitation.update({ where: { id: current.id }, data: { acceptedBy: profile.id, acceptedAt: new Date(), version: { increment: 1 } } });
      const sequence = project.eventSequence + BigInt(1);
      await transaction.project.update({ where: { id: project.id }, data: { eventSequence: sequence, membershipVersion: { increment: 1 }, realtimeEpoch: randomUUID() } });
      const result = { projectId: project.id, workspaceId: project.workspaceId, role: current.role };
      await transaction.auditEvent.create({
        data: { projectId: project.id, workspaceId: project.workspaceId, sequence, actorId: profile.id, action: "INVITATION_ACCEPTED", entityRefs: [{ kind: "INVITATION", id: current.id }, { kind: "PROJECT_MEMBERSHIP", id: profile.id }], metadata: { role: current.role } },
      });
      await transaction.mutationReceipt.create({
        data: { actorId: profile.id, scopeKind: "USER", scopeId: profile.id, key: validated.key, operation: ACCEPT_OPERATION, requestHash: hash, result, expiresAt: new Date(Date.now() + RECEIPT_RETENTION_MS) },
      });
      return { ...result, replayed: false };
    });
  });
}
