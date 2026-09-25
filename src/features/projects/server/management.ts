import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../../../../prisma/generated/client.ts";
import { resolveProfile } from "../../access/server/profile.ts";
import { createDatabase } from "../../../server/db.ts";
import {
  type ApprovalPolicyInput,
  type MemberChangeInput,
  type MemberRemovalInput,
  type ProjectArchiveInput,
  type ProjectSettingsInput,
  validateApprovalPolicyInput,
  validateMemberChangeInput,
  validateMemberRemovalInput,
  validateProjectArchiveInput,
  validateProjectRestoreInput,
  validateProjectSettingsInput,
} from "../contracts/management.ts";
import { type ProjectAccessRole, type ProjectIdentity, uuid } from "../contracts/project.ts";
import { ProjectError } from "./projects.ts";

const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVE = "ACTIVE";
const ARCHIVED = "ARCHIVED";

type LockedProject = {
  id: string;
  workspaceId: string;
  workspaceStatus: "ACTIVE" | "ARCHIVED";
  status: "ACTIVE" | "ARCHIVED";
  version: number;
  settingsVersion: number;
  approvalPolicyVersion: number;
  membershipVersion: number;
  designatedApproverId: string | null;
  eventSequence: bigint;
  role: ProjectAccessRole | null;
};

type ManagementResult = {
  status: string;
  version: number;
  settingsVersion: number;
  approvalPolicyVersion: number;
  membershipVersion: number;
  workspaceStatus: string;
  designatedApproverId: string | null;
  name?: string;
  profileId?: string;
  role?: string;
  memberVersion?: number;
};

function requestHash(operation: string, input: unknown) {
  return createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");
}

function safeResult(result: Prisma.JsonValue): ManagementResult | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = result as Record<string, Prisma.JsonValue>;
  if ((value.status !== ACTIVE && value.status !== ARCHIVED) || !Number.isSafeInteger(value.version) ||
      !Number.isSafeInteger(value.settingsVersion) || !Number.isSafeInteger(value.approvalPolicyVersion) ||
      !Number.isSafeInteger(value.membershipVersion) ||
      (value.workspaceStatus !== ACTIVE && value.workspaceStatus !== ARCHIVED) ||
      (value.designatedApproverId !== null && typeof value.designatedApproverId !== "string")) return null;
  if (value.name !== undefined && typeof value.name !== "string") return null;
  if (value.profileId !== undefined && typeof value.profileId !== "string") return null;
  if (value.role !== undefined && (value.role !== "EDITOR" && value.role !== "REVIEWER" && value.role !== "VIEWER")) return null;
  if (value.memberVersion !== undefined && !Number.isSafeInteger(value.memberVersion)) return null;
  return value as ManagementResult;
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

async function lockProfile(transaction: Prisma.TransactionClient, profileId: string, authUserId: string) {
  const profiles = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM app.user_profile WHERE id = ${profileId}::uuid AND auth_user_id = ${authUserId}::uuid FOR SHARE
  `);
  if (profiles.length !== 1) throw new ProjectError("NOT_AUTHORIZED");
}

async function lockProject(transaction: Prisma.TransactionClient, profileId: string, projectId: string, update: boolean): Promise<LockedProject> {
  const location = await transaction.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (!location) throw new ProjectError("NOT_FOUND");
  await transaction.$queryRaw(update
    ? Prisma.sql`SELECT app.lock_workspace_for_project_creation(${location.workspaceId}::uuid)::text AS locked`
    : Prisma.sql`SELECT app.lock_workspace_for_project_read(${location.workspaceId}::uuid)::text AS locked`);
  const rows = await transaction.$queryRaw<Array<{
    id: string; workspace_id: string; workspace_status: string; status: string; version: number; settings_version: number;
    approval_policy_version: number; membership_version: number; designated_approver_id: string | null; event_sequence: bigint; role: string | null;
  }>>(update ? Prisma.sql`
    SELECT project.id, project.workspace_id, workspace.status::text AS workspace_status, project.status::text, project.version,
      project.settings_version, project.approval_policy_version, project.membership_version, project.designated_approver_id, project.event_sequence,
      CASE WHEN workspace.owner_id = ${profileId}::uuid AND EXISTS (
        SELECT 1 FROM app.workspace_membership membership WHERE membership.workspace_id = workspace.id AND membership.profile_id = ${profileId}::uuid
          AND membership.role = 'OWNER'::app.workspace_member_role AND membership.active
      ) THEN 'OWNER' ELSE (
        SELECT membership.role::text FROM app.project_membership membership
        WHERE membership.project_id = project.id AND membership.profile_id = ${profileId}::uuid AND membership.active
      ) END AS role
    FROM app.project project JOIN app.workspace workspace ON workspace.id = project.workspace_id
    WHERE project.id = ${projectId}::uuid AND workspace.status IN ('ACTIVE'::app.workspace_status, 'ARCHIVED'::app.workspace_status)
      AND project.status IN ('ACTIVE'::app.project_status, 'ARCHIVED'::app.project_status)
    FOR UPDATE OF project
  ` : Prisma.sql`
    SELECT project.id, project.workspace_id, workspace.status::text AS workspace_status, project.status::text, project.version,
      project.settings_version, project.approval_policy_version, project.membership_version, project.designated_approver_id, project.event_sequence,
      CASE WHEN workspace.owner_id = ${profileId}::uuid AND EXISTS (
        SELECT 1 FROM app.workspace_membership membership WHERE membership.workspace_id = workspace.id AND membership.profile_id = ${profileId}::uuid
          AND membership.role = 'OWNER'::app.workspace_member_role AND membership.active
      ) THEN 'OWNER' ELSE (
        SELECT membership.role::text FROM app.project_membership membership
        WHERE membership.project_id = project.id AND membership.profile_id = ${profileId}::uuid AND membership.active
      ) END AS role
    FROM app.project project JOIN app.workspace workspace ON workspace.id = project.workspace_id
    WHERE project.id = ${projectId}::uuid AND workspace.status IN ('ACTIVE'::app.workspace_status, 'ARCHIVED'::app.workspace_status)
      AND project.status IN ('ACTIVE'::app.project_status, 'ARCHIVED'::app.project_status)
    FOR SHARE OF project
  `);
  const project = rows[0];
  if (!project || (project.workspace_status !== ACTIVE && project.workspace_status !== ARCHIVED) || (project.status !== ACTIVE && project.status !== ARCHIVED)) throw new ProjectError("NOT_FOUND");
  const role = project.role === "OWNER" || project.role === "EDITOR" || project.role === "REVIEWER" || project.role === "VIEWER" ? project.role : null;
  return {
    id: project.id, workspaceId: project.workspace_id, workspaceStatus: project.workspace_status, status: project.status,
    version: project.version, settingsVersion: project.settings_version, approvalPolicyVersion: project.approval_policy_version,
    membershipVersion: project.membership_version, designatedApproverId: project.designated_approver_id, eventSequence: project.event_sequence, role,
  };
}

function requireOwner(project: LockedProject) {
  if (project.role !== "OWNER") throw new ProjectError("NOT_FOUND");
}

function requireMember(project: LockedProject) {
  if (!project.role) throw new ProjectError("NOT_FOUND");
}

function requireWritable(project: LockedProject) {
  if (project.workspaceStatus !== ACTIVE || project.status !== ACTIVE) throw new ProjectError("CONFLICT");
}

async function previousReceipt(transaction: Prisma.TransactionClient, actorId: string, projectId: string, key: string) {
  return transaction.mutationReceipt.findFirst({
    where: { actorId, scopeKind: "PROJECT", scopeId: projectId, key, expiresAt: { gt: new Date() } },
    select: { operation: true, requestHash: true, result: true },
  });
}

async function replay(transaction: Prisma.TransactionClient, actorId: string, project: LockedProject, key: string, operation: string, hash: string) {
  const previous = await previousReceipt(transaction, actorId, project.id, key);
  if (!previous) return null;
  if (previous.operation !== operation || previous.requestHash !== hash) throw new ProjectError("KEY_REUSED");
  const result = safeResult(previous.result);
  if (!result) throw new ProjectError("UNAVAILABLE");
  return { ...result, replayed: true };
}

function result(project: LockedProject, extra: Omit<ManagementResult, "status" | "version" | "settingsVersion" | "approvalPolicyVersion" | "membershipVersion" | "workspaceStatus" | "designatedApproverId"> = {}): ManagementResult {
  return {
    status: project.status, version: project.version, settingsVersion: project.settingsVersion,
    approvalPolicyVersion: project.approvalPolicyVersion, membershipVersion: project.membershipVersion, workspaceStatus: project.workspaceStatus,
    designatedApproverId: project.designatedApproverId, ...extra,
  };
}

async function saveReceipt(transaction: Prisma.TransactionClient, actorId: string, projectId: string, key: string, operation: string, hash: string, value: ManagementResult) {
  await transaction.mutationReceipt.create({
    data: { actorId, scopeKind: "PROJECT", scopeId: projectId, key, operation, requestHash: hash, result: value, expiresAt: new Date(Date.now() + RECEIPT_RETENTION_MS) },
  });
}

async function audit(transaction: Prisma.TransactionClient, project: LockedProject, actorId: string, action: string, entityRefs: Prisma.InputJsonValue, metadata: Prisma.InputJsonValue) {
  const sequence = project.eventSequence + BigInt(1);
  await transaction.$executeRaw(Prisma.sql`
    UPDATE app.project SET event_sequence = ${sequence}::bigint, updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid
  `);
  await transaction.auditEvent.create({ data: { projectId: project.id, workspaceId: project.workspaceId, sequence, actorId, action, entityRefs, metadata } });
  return sequence;
}

export async function getProjectMembers(identity: ProjectIdentity, projectId: string) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      const project = await lockProject(transaction, profile.id, projectId, false);
      requireMember(project);
      const members = await transaction.$queryRaw<Array<{ profile_id: string; display_name: string; role: string; version: number }>>(Prisma.sql`
        SELECT profile.id AS profile_id, profile.display_name, membership.role::text, membership.version
        FROM app.project_membership membership JOIN app.user_profile profile ON profile.id = membership.profile_id
        WHERE membership.project_id = ${project.id}::uuid AND membership.active
        UNION ALL
        SELECT profile.id AS profile_id, profile.display_name, 'OWNER'::text AS role, 1 AS version
        FROM app.workspace workspace JOIN app.user_profile profile ON profile.id = workspace.owner_id
        WHERE workspace.id = ${project.workspaceId}::uuid AND EXISTS (
          SELECT 1 FROM app.workspace_membership owner_membership WHERE owner_membership.workspace_id = workspace.id AND owner_membership.profile_id = workspace.owner_id
            AND owner_membership.role = 'OWNER'::app.workspace_member_role AND owner_membership.active
        ) AND NOT EXISTS (
          SELECT 1 FROM app.project_membership membership WHERE membership.project_id = ${project.id}::uuid AND membership.profile_id = profile.id AND membership.active
        )
        ORDER BY display_name ASC, profile_id ASC
      `);
      return { project: result(project), members: members.map((member) => ({ profileId: member.profile_id, displayName: member.display_name, role: member.role as ProjectAccessRole, version: member.version, designatedApprover: member.profile_id === project.designatedApproverId })) };
    });
  });
}

export async function getProjectStatus(identity: ProjectIdentity, projectId: string) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      const project = await lockProject(transaction, profile.id, projectId, false);
      requireMember(project);
      return result(project);
    });
  });
}

export async function updateProjectSettings(identity: ProjectIdentity, projectId: string, input: unknown) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  let validated: ProjectSettingsInput;
  try { validated = validateProjectSettingsInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = "UPDATE_PROJECT_SETTINGS_V1";
  const hash = requestHash(operation, { projectId, name: validated.name, expectedSettingsVersion: validated.expectedSettingsVersion });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      await lockProfile(transaction, profile.id, identity.authUserId);
      const project = await lockProject(transaction, profile.id, projectId, true);
      requireOwner(project);
      const recovered = await replay(transaction, profile.id, project, validated.key, operation, hash);
      if (recovered) return recovered;
      requireWritable(project);
      if (project.settingsVersion !== validated.expectedSettingsVersion) throw new ProjectError("CONFLICT");
      const next = { ...project, settingsVersion: project.settingsVersion + 1 };
      await transaction.$executeRaw(Prisma.sql`UPDATE app.project SET name = ${validated.name}, settings_version = ${next.settingsVersion}, updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`);
      await audit(transaction, next, profile.id, "PROJECT_SETTINGS_UPDATED", [{ kind: "PROJECT", id: project.id }], { settingsVersion: next.settingsVersion });
      const value = result(next, { name: validated.name });
      await saveReceipt(transaction, profile.id, project.id, validated.key, operation, hash, value);
      return { ...value, replayed: false };
    });
  });
}

export async function updateApprovalPolicy(identity: ProjectIdentity, projectId: string, input: unknown) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  let validated: ApprovalPolicyInput;
  try { validated = validateApprovalPolicyInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = "UPDATE_APPROVAL_POLICY_V1";
  const hash = requestHash(operation, { projectId, designatedApproverId: validated.designatedApproverId, expectedApprovalPolicyVersion: validated.expectedApprovalPolicyVersion });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      await lockProfile(transaction, profile.id, identity.authUserId);
      const project = await lockProject(transaction, profile.id, projectId, true);
      requireOwner(project);
      const recovered = await replay(transaction, profile.id, project, validated.key, operation, hash);
      if (recovered) return recovered;
      requireWritable(project);
      if (project.approvalPolicyVersion !== validated.expectedApprovalPolicyVersion) throw new ProjectError("CONFLICT");
      if (validated.designatedApproverId) {
        const eligible = await transaction.$queryRaw<{ profile_id: string }[]>(Prisma.sql`
          SELECT profile_id FROM app.project_membership WHERE project_id = ${project.id}::uuid AND profile_id = ${validated.designatedApproverId}::uuid
            AND active AND role IN ('EDITOR'::app.project_member_role, 'REVIEWER'::app.project_member_role)
          UNION ALL
          SELECT owner_id AS profile_id FROM app.workspace WHERE id = ${project.workspaceId}::uuid AND owner_id = ${validated.designatedApproverId}::uuid
        `);
        if (!eligible.length) throw new ProjectError("CONFLICT");
      }
      const next = { ...project, designatedApproverId: validated.designatedApproverId, approvalPolicyVersion: project.approvalPolicyVersion + 1 };
      await transaction.$executeRaw(Prisma.sql`UPDATE app.project SET designated_approver_id = ${next.designatedApproverId}::uuid, approval_policy_version = ${next.approvalPolicyVersion}, realtime_epoch = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`);
      await audit(transaction, next, profile.id, "APPROVAL_POLICY_UPDATED", [{ kind: "PROJECT", id: project.id }], { designatedApproverId: next.designatedApproverId, approvalPolicyVersion: next.approvalPolicyVersion });
      const value = result(next);
      await saveReceipt(transaction, profile.id, project.id, validated.key, operation, hash, value);
      return { ...value, replayed: false };
    });
  });
}

export async function changeProjectMember(identity: ProjectIdentity, projectId: string, profileId: string, input: unknown) {
  if (!uuid.test(projectId) || !uuid.test(profileId)) throw new ProjectError("NOT_FOUND");
  let validated: MemberChangeInput;
  try { validated = validateMemberChangeInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = "CHANGE_PROJECT_MEMBER_V1";
  const hash = requestHash(operation, { projectId, profileId, role: validated.role, expectedMemberVersion: validated.expectedMemberVersion });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      await lockProfile(transaction, profile.id, identity.authUserId);
      const project = await lockProject(transaction, profile.id, projectId, true);
      requireOwner(project);
      const recovered = await replay(transaction, profile.id, project, validated.key, operation, hash);
      if (recovered) return recovered;
      if (project.workspaceStatus !== ACTIVE) throw new ProjectError("CONFLICT");
      const membership = await transaction.$queryRaw<Array<{ role: string; version: number }>>(Prisma.sql`
        SELECT role::text, version FROM app.project_membership WHERE project_id = ${project.id}::uuid AND profile_id = ${profileId}::uuid AND active FOR UPDATE
      `);
      const current = membership[0];
      if (!current) throw new ProjectError("NOT_FOUND");
      if (current.version !== validated.expectedMemberVersion) throw new ProjectError("CONFLICT");
      const rank = { VIEWER: 1, REVIEWER: 2, EDITOR: 3 } as const;
      if (project.status === ARCHIVED && rank[validated.role] > rank[current.role as keyof typeof rank]) throw new ProjectError("CONFLICT");
      const clearsApprover = project.designatedApproverId === profileId && validated.role === "VIEWER";
      const next = {
        ...project, membershipVersion: project.membershipVersion + 1,
        approvalPolicyVersion: project.approvalPolicyVersion + (clearsApprover ? 1 : 0),
        designatedApproverId: clearsApprover ? null : project.designatedApproverId,
      };
      const memberVersion = current.version + 1;
      await transaction.$executeRaw(Prisma.sql`UPDATE app.project_membership SET role = ${validated.role}::app.project_member_role, version = ${memberVersion}, updated_at = CURRENT_TIMESTAMP WHERE project_id = ${project.id}::uuid AND profile_id = ${profileId}::uuid`);
      await transaction.$executeRaw(Prisma.sql`UPDATE app.project SET membership_version = ${next.membershipVersion}, approval_policy_version = ${next.approvalPolicyVersion}, designated_approver_id = ${next.designatedApproverId}::uuid, realtime_epoch = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`);
      await audit(transaction, next, profile.id, "PROJECT_MEMBER_ROLE_CHANGED", [{ kind: "PROJECT_MEMBER", id: profileId }], { role: validated.role, memberVersion });
      const value = result(next, { profileId, role: validated.role, memberVersion });
      await saveReceipt(transaction, profile.id, project.id, validated.key, operation, hash, value);
      return { ...value, replayed: false };
    });
  });
}

export async function removeProjectMember(identity: ProjectIdentity, projectId: string, profileId: string, input: unknown) {
  if (!uuid.test(projectId) || !uuid.test(profileId)) throw new ProjectError("NOT_FOUND");
  let validated: MemberRemovalInput;
  try { validated = validateMemberRemovalInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = "REMOVE_PROJECT_MEMBER_V1";
  const hash = requestHash(operation, { projectId, profileId, expectedMemberVersion: validated.expectedMemberVersion });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      await lockProfile(transaction, profile.id, identity.authUserId);
      const project = await lockProject(transaction, profile.id, projectId, true);
      requireOwner(project);
      const recovered = await replay(transaction, profile.id, project, validated.key, operation, hash);
      if (recovered) return recovered;
      if (project.workspaceStatus !== ACTIVE) throw new ProjectError("CONFLICT");
      const membership = await transaction.$queryRaw<Array<{ version: number }>>(Prisma.sql`
        SELECT version FROM app.project_membership WHERE project_id = ${project.id}::uuid AND profile_id = ${profileId}::uuid AND active FOR UPDATE
      `);
      const current = membership[0];
      if (!current) throw new ProjectError("NOT_FOUND");
      if (current.version !== validated.expectedMemberVersion) throw new ProjectError("CONFLICT");
      const clearsApprover = project.designatedApproverId === profileId;
      const next = {
        ...project, membershipVersion: project.membershipVersion + 1,
        approvalPolicyVersion: project.approvalPolicyVersion + (clearsApprover ? 1 : 0),
        designatedApproverId: clearsApprover ? null : project.designatedApproverId,
      };
      const memberVersion = current.version + 1;
      await transaction.$executeRaw(Prisma.sql`UPDATE app.project_membership SET active = false, version = ${memberVersion}, updated_at = CURRENT_TIMESTAMP WHERE project_id = ${project.id}::uuid AND profile_id = ${profileId}::uuid`);
      await transaction.$executeRaw(Prisma.sql`UPDATE app.project SET membership_version = ${next.membershipVersion}, approval_policy_version = ${next.approvalPolicyVersion}, designated_approver_id = ${next.designatedApproverId}::uuid, realtime_epoch = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`);
      await audit(transaction, next, profile.id, "PROJECT_MEMBER_REMOVED", [{ kind: "PROJECT_MEMBER", id: profileId }], { memberVersion });
      const value = result(next, { profileId, memberVersion });
      await saveReceipt(transaction, profile.id, project.id, validated.key, operation, hash, value);
      return { ...value, replayed: false };
    });
  });
}

async function changeProjectLifecycle(identity: ProjectIdentity, projectId: string, input: unknown, restoring: boolean) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  let validated: ProjectArchiveInput;
  try { validated = restoring ? validateProjectRestoreInput(input) : validateProjectArchiveInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = restoring ? "RESTORE_PROJECT_V1" : "ARCHIVE_PROJECT_V1";
  const hash = requestHash(operation, { projectId, expectedProjectVersion: validated.expectedProjectVersion, ...(restoring ? {} : { reason: validated.reason }) });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (transaction) => {
      await lockProfile(transaction, profile.id, identity.authUserId);
      const project = await lockProject(transaction, profile.id, projectId, true);
      requireOwner(project);
      const recovered = await replay(transaction, profile.id, project, validated.key, operation, hash);
      if (recovered) return recovered;
      if (project.workspaceStatus !== ACTIVE || project.version !== validated.expectedProjectVersion || project.status !== (restoring ? ARCHIVED : ACTIVE)) throw new ProjectError("CONFLICT");
      const next: LockedProject = { ...project, status: restoring ? ACTIVE : ARCHIVED, version: project.version + 1 };
      if (!restoring) {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE app.invitation SET revoked_at = CURRENT_TIMESTAMP, version = version + 1
          WHERE project_id = ${project.id}::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        `);
      }
      await transaction.$executeRaw(Prisma.sql`UPDATE app.project SET status = ${next.status}::app.project_status, version = ${next.version}, realtime_epoch = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`);
      await audit(transaction, next, profile.id, restoring ? "PROJECT_RESTORED" : "PROJECT_ARCHIVED", [{ kind: "PROJECT", id: project.id }], restoring ? {} : { reason: validated.reason! });
      const value = result(next);
      await saveReceipt(transaction, profile.id, project.id, validated.key, operation, hash, value);
      return { ...value, replayed: false };
    });
  });
}

export function archiveProject(identity: ProjectIdentity, projectId: string, input: unknown) {
  return changeProjectLifecycle(identity, projectId, input, false);
}

export function restoreProject(identity: ProjectIdentity, projectId: string, input: unknown) {
  return changeProjectLifecycle(identity, projectId, input, true);
}
