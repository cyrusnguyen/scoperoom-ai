import { Prisma } from "../../../../prisma/generated/client.ts";
import {
  type ApprovalPolicyInput, type MemberChangeInput, type MemberRemovalInput, type ProjectArchiveInput, type ProjectSettingsInput,
  validateApprovalPolicyInput, validateLeaveInput, validateMemberChangeInput, validateMemberRemovalInput,
  validateProjectArchiveInput, validateProjectRestoreInput, validateProjectSettingsInput,
} from "../contracts/management.ts";
import { type ProjectAccessRole, type ProjectIdentity, uuid } from "../contracts/project.ts";
import {
  assertOwnerCapacity, checkReceipt, findReceipt, lockActor, lockOwnerCapacity, lockProject, profileFor, readProject, recordEvent,
  requestHash, requireActive, requireMember, requireOwner, saveReceipt, withDatabase, withReadSnapshot, type ProjectRow, type Transaction,
} from "./access.ts";
import { ProjectError } from "./errors.ts";
import type { InvitationIdentity } from "./invitations.ts";

type ManagementResult = {
  status: "ACTIVE" | "ARCHIVED"; version: number; settingsVersion: number; approvalPolicyVersion: number; membershipVersion: number;
  designatedApproverId: string | null; name?: string; profileId?: string; role?: string; memberVersion?: number;
};

function result(project: ProjectRow, extra: Pick<ManagementResult, "name" | "profileId" | "role" | "memberVersion"> = {}): ManagementResult {
  return {
    status: project.status, version: project.version, settingsVersion: project.settingsVersion, approvalPolicyVersion: project.approvalPolicyVersion,
    membershipVersion: project.membershipVersion, designatedApproverId: project.designatedApproverId, ...extra,
  };
}

function storedResult(value: Prisma.JsonValue): ManagementResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectError("UNAVAILABLE");
  const stored = value as Record<string, Prisma.JsonValue>;
  if ((stored.status !== "ACTIVE" && stored.status !== "ARCHIVED") || !Number.isSafeInteger(stored.version)) throw new ProjectError("UNAVAILABLE");
  return stored as unknown as ManagementResult;
}

/** Owner-only mutation skeleton: actor lock → project lock → owner check → receipt replay → new work. */
async function ownerMutation(identity: ProjectIdentity, projectId: string, key: string, operation: string, hash: string,
  work: (tx: Transaction, project: ProjectRow, actorId: string) => Promise<ManagementResult>) {
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId);
      const project = await lockProject(tx, profile.id, projectId);
      requireOwner(project);
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, key);
      if (receipt) { checkReceipt(receipt, operation, hash); return { ...storedResult(receipt.result), replayed: true }; }
      const value = await work(tx, project, profile.id);
      await saveReceipt(tx, profile.id, "PROJECT", project.id, key, operation, hash, value);
      return { ...value, replayed: false };
    });
  });
}

/** Revokes pending invitations addressed to any email this profile accepted with here, plus extra emails (the leaver's current one). */
async function revokeInvitationsFor(tx: Transaction, projectId: string, profileId: string, extraEmails: string[] = []) {
  await tx.$executeRaw`
    UPDATE app.invitation SET revoked_at = CURRENT_TIMESTAMP, version = version + 1
    WHERE project_id = ${projectId}::uuid AND accepted_at IS NULL AND revoked_at IS NULL
      AND (verified_email IN (SELECT verified_email FROM app.invitation WHERE project_id = ${projectId}::uuid AND accepted_by = ${profileId}::uuid)
           OR verified_email = ANY(${extraEmails}::text[]))`;
}

/** Deactivates a membership at the event sequence of this change and keeps the approver policy consistent. */
async function deactivate(tx: Transaction, project: ProjectRow, actorId: string, memberId: string, action: string, extraEmails: string[] = []) {
  const [membership] = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM app.project_membership WHERE project_id = ${project.id}::uuid AND profile_id = ${memberId}::uuid AND active FOR UPDATE`;
  if (!membership) throw new ProjectError("NOT_FOUND");
  const clearsApprover = project.designatedApproverId === memberId;
  const memberVersion = membership.version + 1;
  const sequence = await recordEvent(tx, project, actorId, action, [{ kind: "PROJECT_MEMBER", id: memberId }], { memberVersion });
  await tx.$executeRaw`UPDATE app.project_membership SET active = false, version = ${memberVersion}, deactivated_sequence = ${sequence}::bigint, updated_at = CURRENT_TIMESTAMP WHERE project_id = ${project.id}::uuid AND profile_id = ${memberId}::uuid`;
  await revokeInvitationsFor(tx, project.id, memberId, extraEmails);
  const next = {
    ...project, eventSequence: sequence, membershipVersion: project.membershipVersion + 1,
    approvalPolicyVersion: project.approvalPolicyVersion + (clearsApprover ? 1 : 0), designatedApproverId: clearsApprover ? null : project.designatedApproverId,
  };
  await tx.$executeRaw`UPDATE app.project SET membership_version = ${next.membershipVersion}, approval_policy_version = ${next.approvalPolicyVersion}, designated_approver_id = ${next.designatedApproverId}::uuid, realtime_epoch = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`;
  return { next, memberVersion };
}

export async function getProjectMembers(identity: ProjectIdentity, projectId: string) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return withReadSnapshot(database, async (tx) => {
      const project = await readProject(tx, profile.id, projectId);
      requireMember(project);
      const members = await tx.$queryRaw<Array<{ profile_id: string; display_name: string; role: string; version: number }>>`
        SELECT profile.id AS profile_id, profile.display_name, membership.role::text AS role, membership.version
        FROM app.project_membership membership JOIN app.user_profile profile ON profile.id = membership.profile_id
        WHERE membership.project_id = ${project.id}::uuid AND membership.active
        UNION ALL
        SELECT profile.id, profile.display_name, 'OWNER', 1 FROM app.user_profile profile WHERE profile.id = ${project.ownerId}::uuid
        ORDER BY display_name ASC, profile_id ASC`;
      return {
        project: result(project),
        members: members.map((entry) => ({ profileId: entry.profile_id, displayName: entry.display_name, role: entry.role as ProjectAccessRole, version: entry.version, designatedApprover: entry.profile_id === project.designatedApproverId })),
      };
    });
  });
}

export async function updateProjectSettings(identity: ProjectIdentity, projectId: string, input: unknown) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  let validated: ProjectSettingsInput;
  try { validated = validateProjectSettingsInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = "UPDATE_PROJECT_SETTINGS_V2";
  const hash = requestHash(operation, { projectId, name: validated.name, expectedSettingsVersion: validated.expectedSettingsVersion });
  return ownerMutation(identity, projectId, validated.key, operation, hash, async (tx, project, actorId) => {
    requireActive(project);
    if (project.settingsVersion !== validated.expectedSettingsVersion) throw new ProjectError("CONFLICT");
    const next = { ...project, settingsVersion: project.settingsVersion + 1 };
    await tx.$executeRaw`UPDATE app.project SET name = ${validated.name}, settings_version = ${next.settingsVersion}, updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`;
    await recordEvent(tx, project, actorId, "PROJECT_SETTINGS_UPDATED", [{ kind: "PROJECT", id: project.id }], { settingsVersion: next.settingsVersion });
    return result(next, { name: validated.name });
  });
}

export async function updateApprovalPolicy(identity: ProjectIdentity, projectId: string, input: unknown) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  let validated: ApprovalPolicyInput;
  try { validated = validateApprovalPolicyInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = "UPDATE_APPROVAL_POLICY_V2";
  const hash = requestHash(operation, { projectId, designatedApproverId: validated.designatedApproverId, expectedApprovalPolicyVersion: validated.expectedApprovalPolicyVersion });
  return ownerMutation(identity, projectId, validated.key, operation, hash, async (tx, project, actorId) => {
    requireActive(project);
    if (project.approvalPolicyVersion !== validated.expectedApprovalPolicyVersion) throw new ProjectError("CONFLICT");
    if (validated.designatedApproverId && validated.designatedApproverId !== project.ownerId) {
      const eligible = await tx.projectMembership.count({ where: { projectId: project.id, profileId: validated.designatedApproverId, active: true, role: { in: ["EDITOR", "REVIEWER"] } } });
      if (!eligible) throw new ProjectError("CONFLICT");
    }
    const next = { ...project, designatedApproverId: validated.designatedApproverId, approvalPolicyVersion: project.approvalPolicyVersion + 1 };
    await tx.$executeRaw`UPDATE app.project SET designated_approver_id = ${next.designatedApproverId}::uuid, approval_policy_version = ${next.approvalPolicyVersion}, realtime_epoch = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`;
    await recordEvent(tx, project, actorId, "APPROVAL_POLICY_UPDATED", [{ kind: "PROJECT", id: project.id }], { designatedApproverId: next.designatedApproverId, approvalPolicyVersion: next.approvalPolicyVersion });
    return result(next);
  });
}

export async function changeProjectMember(identity: ProjectIdentity, projectId: string, profileId: string, input: unknown) {
  if (!uuid.test(projectId) || !uuid.test(profileId)) throw new ProjectError("NOT_FOUND");
  let validated: MemberChangeInput;
  try { validated = validateMemberChangeInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = "CHANGE_PROJECT_MEMBER_V2";
  const hash = requestHash(operation, { projectId, profileId, role: validated.role, expectedMemberVersion: validated.expectedMemberVersion });
  return ownerMutation(identity, projectId, validated.key, operation, hash, async (tx, project, actorId) => {
    const [current] = await tx.$queryRaw<Array<{ role: string; version: number }>>`SELECT role::text AS role, version FROM app.project_membership WHERE project_id = ${project.id}::uuid AND profile_id = ${profileId}::uuid AND active FOR UPDATE`;
    if (!current) throw new ProjectError("NOT_FOUND");
    if (current.version !== validated.expectedMemberVersion) throw new ProjectError("CONFLICT");
    const rank = { VIEWER: 1, REVIEWER: 2, EDITOR: 3 } as const;
    // Archived projects allow downgrades only, never new grants.
    if (project.status === "ARCHIVED" && rank[validated.role] > rank[current.role as keyof typeof rank]) throw new ProjectError("CONFLICT");
    const clearsApprover = project.designatedApproverId === profileId && validated.role === "VIEWER";
    const next = { ...project, membershipVersion: project.membershipVersion + 1, approvalPolicyVersion: project.approvalPolicyVersion + (clearsApprover ? 1 : 0), designatedApproverId: clearsApprover ? null : project.designatedApproverId };
    const memberVersion = current.version + 1;
    await tx.$executeRaw`UPDATE app.project_membership SET role = ${validated.role}::app.project_member_role, version = ${memberVersion}, updated_at = CURRENT_TIMESTAMP WHERE project_id = ${project.id}::uuid AND profile_id = ${profileId}::uuid`;
    await tx.$executeRaw`UPDATE app.project SET membership_version = ${next.membershipVersion}, approval_policy_version = ${next.approvalPolicyVersion}, designated_approver_id = ${next.designatedApproverId}::uuid, realtime_epoch = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`;
    await recordEvent(tx, project, actorId, "PROJECT_MEMBER_ROLE_CHANGED", [{ kind: "PROJECT_MEMBER", id: profileId }], { role: validated.role, memberVersion });
    return result(next, { profileId, role: validated.role, memberVersion });
  });
}

export async function removeProjectMember(identity: ProjectIdentity, projectId: string, profileId: string, input: unknown) {
  if (!uuid.test(projectId) || !uuid.test(profileId)) throw new ProjectError("NOT_FOUND");
  let validated: MemberRemovalInput;
  try { validated = validateMemberRemovalInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = "REMOVE_PROJECT_MEMBER_V2";
  const hash = requestHash(operation, { projectId, profileId, expectedMemberVersion: validated.expectedMemberVersion });
  return ownerMutation(identity, projectId, validated.key, operation, hash, async (tx, project, actorId) => {
    const [current] = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM app.project_membership WHERE project_id = ${project.id}::uuid AND profile_id = ${profileId}::uuid AND active`;
    if (!current) throw new ProjectError("NOT_FOUND");
    if (current.version !== validated.expectedMemberVersion) throw new ProjectError("CONFLICT");
    const { next, memberVersion } = await deactivate(tx, project, actorId, profileId, "PROJECT_MEMBER_REMOVED");
    return result(next, { profileId, memberVersion });
  });
}

/** Non-owner leave. A replay returns only what the caller already knows, since their access has ended by design. */
export async function leaveProject(identity: InvitationIdentity, projectId: string, input: unknown) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  let validated: { key: string };
  try { validated = validateLeaveInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = "LEAVE_PROJECT_V1";
  const hash = requestHash(operation, { projectId });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId);
      const receipt = await findReceipt(tx, profile.id, "PROJECT", projectId, validated.key);
      if (receipt) { checkReceipt(receipt, operation, hash); return { projectId, left: true as const, replayed: true }; }
      const project = await lockProject(tx, profile.id, projectId);
      if (project.role === "OWNER") throw new ProjectError("OWNER_CANNOT_LEAVE");
      requireMember(project);
      await deactivate(tx, project, profile.id, profile.id, "PROJECT_MEMBER_LEFT", [identity.verifiedEmail]);
      await saveReceipt(tx, profile.id, "PROJECT", project.id, validated.key, operation, hash, { projectId, left: true });
      return { projectId, left: true as const, replayed: false };
    });
  });
}

async function changeLifecycle(identity: ProjectIdentity, projectId: string, input: unknown, restoring: boolean) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  let validated: ProjectArchiveInput;
  try { validated = restoring ? validateProjectRestoreInput(input) : validateProjectArchiveInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const operation = restoring ? "RESTORE_PROJECT_V2" : "ARCHIVE_PROJECT_V2";
  const hash = requestHash(operation, { projectId, expectedProjectVersion: validated.expectedProjectVersion, ...(restoring ? {} : { reason: validated.reason }) });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId);
      if (restoring) {
        // ownerId is immutable, so an unlocked read may choose the capacity guard before the project lock (lock order 2 → 3).
        const owner = await tx.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
        if (!owner || owner.ownerId !== profile.id) throw new ProjectError("NOT_FOUND");
        await lockOwnerCapacity(tx, profile.id);
      }
      const project = await lockProject(tx, profile.id, projectId);
      requireOwner(project);
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, validated.key);
      if (receipt) { checkReceipt(receipt, operation, hash); return { ...storedResult(receipt.result), replayed: true }; }
      if (project.version !== validated.expectedProjectVersion || project.status !== (restoring ? "ARCHIVED" : "ACTIVE")) throw new ProjectError("CONFLICT");
      if (restoring) await assertOwnerCapacity(tx, profile.id);
      else await tx.$executeRaw`UPDATE app.invitation SET revoked_at = CURRENT_TIMESTAMP, version = version + 1 WHERE project_id = ${project.id}::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`;
      const next: ProjectRow = { ...project, status: restoring ? "ACTIVE" : "ARCHIVED", version: project.version + 1 };
      await tx.$executeRaw`UPDATE app.project SET status = ${next.status}::app.project_status, version = ${next.version}, realtime_epoch = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`;
      await recordEvent(tx, project, profile.id, restoring ? "PROJECT_RESTORED" : "PROJECT_ARCHIVED", [{ kind: "PROJECT", id: project.id }], restoring ? {} : { reason: validated.reason! });
      const value = result(next);
      await saveReceipt(tx, profile.id, "PROJECT", project.id, validated.key, operation, hash, value);
      return { ...value, replayed: false };
    });
  });
}

export function archiveProject(identity: ProjectIdentity, projectId: string, input: unknown) {
  return changeLifecycle(identity, projectId, input, false);
}

export function restoreProject(identity: ProjectIdentity, projectId: string, input: unknown) {
  return changeLifecycle(identity, projectId, input, true);
}
