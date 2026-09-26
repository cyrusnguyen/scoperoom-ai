import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "../../../../prisma/generated/client.ts";
import { readProcessEnv } from "../../../server/env.ts";
import {
  MAX_COLLABORATORS, MAX_PENDING_INVITATIONS, MY_INVITATION_LIMIT, type InvitationAcceptInput, type MyInvitation, type ProjectMemberRole,
  validateInvitationAcceptInput, validateInvitationIssueInput, validateInvitationRevokeInput,
} from "../contracts/invitation.ts";
import { type ProjectAccessRole, type ProjectIdentity, uuid } from "../contracts/project.ts";
import {
  checkReceipt, findReceipt, lockActor, lockProject, profileFor, readProject, receiptString, recordEvent, requestHash,
  requireActive, requireMember, requireOwner, saveReceipt, withDatabase, withReadSnapshot,
} from "./access.ts";
import { ProjectError } from "./errors.ts";

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const ISSUE_OPERATION = "ISSUE_INVITATION_V2";
const REVOKE_OPERATION = "REVOKE_INVITATION_V2";
const ACCEPT_OPERATION = "ACCEPT_INVITATION_V2";

export type InvitationIdentity = ProjectIdentity & { verifiedEmail: string };
type SafeInvitation = { id: string; verifiedEmail: string; role: ProjectMemberRole; expiresAt: string; status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED"; version: number };
type InvitationRecord = { id: string; verifiedEmail: string; role: ProjectMemberRole; version: number; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null };

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

function safeInvitation(invitation: InvitationRecord): SafeInvitation {
  const status = invitation.acceptedAt ? "ACCEPTED" : invitation.revokedAt ? "REVOKED" : invitation.expiresAt <= new Date() ? "EXPIRED" : "PENDING";
  return { id: invitation.id, verifiedEmail: invitation.verifiedEmail, role: invitation.role, expiresAt: invitation.expiresAt.toISOString(), status, version: invitation.version };
}

function safeStoredInvitation(result: Prisma.JsonValue): SafeInvitation | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const value = result as Record<string, Prisma.JsonValue>;
  if (typeof value.id !== "string" || typeof value.verifiedEmail !== "string" || (value.role !== "EDITOR" && value.role !== "REVIEWER" && value.role !== "VIEWER") ||
      typeof value.expiresAt !== "string" || typeof value.status !== "string" || !Number.isSafeInteger(value.version)) return null;
  return value as unknown as SafeInvitation;
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
  const token = randomBytes(32).toString("base64url");
  const url = invitationUrl(token);
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId);
      const project = await lockProject(tx, profile.id, projectId);
      requireOwner(project);
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, validated.key);
      if (receipt) {
        checkReceipt(receipt, ISSUE_OPERATION, hash);
        const stored = safeStoredInvitation(receipt.result);
        if (!stored) throw new ProjectError("UNAVAILABLE");
        return { ...stored, url: undefined, linkUnavailable: true, replayed: true };
      }
      requireActive(project);
      if (validated.verifiedEmail === identity.verifiedEmail) throw new ProjectError("ALREADY_MEMBER", { role: "OWNER" });
      const pending = await tx.invitation.count({ where: { projectId: project.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
      if (pending >= MAX_PENDING_INVITATIONS) throw new ProjectError("INVITATION_LIMIT");
      const invitationId = randomUUID();
      const issuedSequence = await recordEvent(tx, project, profile.id, "INVITATION_ISSUED", [{ kind: "INVITATION", id: invitationId }], { role: validated.role });
      const invitation = await tx.invitation.create({
        data: { id: invitationId, projectId: project.id, tokenHash: tokenHash(token), verifiedEmail: validated.verifiedEmail, role: validated.role, issuedSequence, invitedBy: profile.id, expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS) },
      });
      const safe = safeInvitation(invitation);
      await saveReceipt(tx, profile.id, "PROJECT", project.id, validated.key, ISSUE_OPERATION, hash, safe);
      return { ...safe, url, linkUnavailable: false, replayed: false };
    });
  });
}

export async function listProjectInvitations(identity: ProjectIdentity, projectId: string) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return withReadSnapshot(database, async (tx) => {
      const project = await readProject(tx, profile.id, projectId);
      requireOwner(project);
      const invitations = await tx.invitation.findMany({ where: { projectId: project.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_PENDING_INVITATIONS });
      return { invitations: invitations.map(safeInvitation) };
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
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId);
      const project = await lockProject(tx, profile.id, projectId);
      requireOwner(project);
      const receipt = await findReceipt(tx, profile.id, "PROJECT", project.id, validated.key);
      if (receipt) {
        checkReceipt(receipt, REVOKE_OPERATION, hash);
        const stored = safeStoredInvitation(receipt.result);
        if (!stored) throw new ProjectError("UNAVAILABLE");
        return { ...stored, replayed: true };
      }
      const current = await tx.invitation.findFirst({ where: { id: invitationId, projectId: project.id } });
      if (!current) throw new ProjectError("NOT_FOUND");
      if (current.version !== validated.expectedVersion || current.acceptedAt || current.revokedAt || current.expiresAt <= new Date()) throw new ProjectError("CONFLICT");
      await recordEvent(tx, project, profile.id, "INVITATION_REVOKED", [{ kind: "INVITATION", id: current.id }], {});
      const safe = safeInvitation(await tx.invitation.update({ where: { id: current.id }, data: { revokedAt: new Date(), version: { increment: 1 } } }));
      await saveReceipt(tx, profile.id, "PROJECT", project.id, validated.key, REVOKE_OPERATION, hash, safe);
      return { ...safe, replayed: false };
    });
  });
}

type RawMine = { id: string; project_name: string; inviter_name: string; role: string; expires_at: Date };

/** The Invites tab: actionable invitations for the caller's verified email, with invitation metadata only. */
export async function listMyInvitations(identity: InvitationIdentity): Promise<{ items: MyInvitation[]; truncated: boolean }> {
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return withReadSnapshot(database, async (tx) => {
      const rows = await tx.$queryRaw<RawMine[]>`
        SELECT invitation.id, project.name AS project_name, inviter.display_name AS inviter_name, invitation.role::text AS role, invitation.expires_at
        FROM app.invitation invitation
        JOIN app.project project ON project.id = invitation.project_id
        JOIN app.user_profile inviter ON inviter.id = invitation.invited_by
        LEFT JOIN app.project_membership membership ON membership.project_id = project.id AND membership.profile_id = ${profile.id}::uuid
        WHERE invitation.verified_email = ${identity.verifiedEmail} AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
          AND invitation.expires_at > CURRENT_TIMESTAMP AND project.status = 'ACTIVE'::app.project_status AND project.owner_id <> ${profile.id}::uuid
          AND (membership.profile_id IS NULL OR (NOT membership.active AND invitation.issued_sequence > membership.deactivated_sequence))
        ORDER BY invitation.created_at DESC, invitation.id DESC
        LIMIT ${MY_INVITATION_LIMIT + 1}`;
      return {
        items: rows.slice(0, MY_INVITATION_LIMIT).map((row) => ({ id: row.id, projectName: row.project_name, inviterName: row.inviter_name, role: row.role as ProjectMemberRole, expiresAt: row.expires_at.toISOString() })),
        truncated: rows.length > MY_INVITATION_LIMIT,
      };
    });
  });
}

type RawMembership = { active: boolean; deactivated_sequence: bigint | null };
type RawInvitation = { id: string; verified_email: string; role: string; issued_sequence: bigint; expires_at: Date; accepted_by: string | null; accepted_at: Date | null; revoked_at: Date | null };

export async function acceptInvitation(identity: InvitationIdentity, input: unknown): Promise<{ projectId: string; role: ProjectAccessRole; replayed: boolean }> {
  let validated: InvitationAcceptInput;
  try { validated = validateInvitationAcceptInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const target = validated.token !== undefined ? { tokenHash: tokenHash(validated.token) } : { invitationId: validated.invitationId };
  const hash = requestHash(ACCEPT_OPERATION, target);
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId);
      const receipt = await findReceipt(tx, profile.id, "USER", profile.id, validated.key);
      if (receipt) {
        // A key with a receipt never falls through to new work, and replays only while access remains.
        checkReceipt(receipt, ACCEPT_OPERATION, hash);
        const projectId = receiptString(receipt.result, "projectId");
        if (!projectId) throw new ProjectError("UNAVAILABLE");
        const project = await lockProject(tx, profile.id, projectId);
        return { projectId: project.id, role: requireMember(project), replayed: true };
      }
      const found = await tx.invitation.findFirst({
        where: "tokenHash" in target ? { tokenHash: target.tokenHash } : { id: target.invitationId, verifiedEmail: identity.verifiedEmail },
        select: { id: true, projectId: true },
      });
      if (!found) throw new ProjectError("NOT_FOUND");
      const project = await lockProject(tx, profile.id, found.projectId);
      const [membership] = await tx.$queryRaw<RawMembership[]>`SELECT active, deactivated_sequence FROM app.project_membership WHERE project_id = ${project.id}::uuid AND profile_id = ${profile.id}::uuid FOR UPDATE`;
      const [invitation] = await tx.$queryRaw<RawInvitation[]>`
        SELECT id, verified_email, role::text AS role, issued_sequence, expires_at, accepted_by, accepted_at, revoked_at
        FROM app.invitation WHERE id = ${found.id}::uuid FOR UPDATE`;
      if (!invitation || invitation.revoked_at || invitation.verified_email !== identity.verifiedEmail) throw new ProjectError("NOT_FOUND");
      if (invitation.accepted_at) {
        // A consumed link returns the established result only to its acceptor while still admitted.
        if (invitation.accepted_by !== profile.id || !project.role) throw new ProjectError("NOT_FOUND");
        const established = { projectId: project.id, role: project.role };
        await saveReceipt(tx, profile.id, "USER", profile.id, validated.key, ACCEPT_OPERATION, hash, established);
        return { ...established, replayed: true };
      }
      if (project.status !== "ACTIVE" || invitation.expires_at <= new Date()) throw new ProjectError("NOT_FOUND");
      if (project.role) throw new ProjectError("ALREADY_MEMBER", { role: project.role });
      // An invitation issued at or before the latest removal/leave never readmits (ordered by project event sequence).
      const deactivatedSequence = membership?.deactivated_sequence ?? null;
      if (deactivatedSequence !== null && invitation.issued_sequence <= deactivatedSequence) throw new ProjectError("NOT_FOUND");
      // The owner counts toward the cap; counted under the project lock so concurrent acceptances cannot exceed it.
      const activeMembers = await tx.projectMembership.count({ where: { projectId: project.id, active: true } });
      if (activeMembers + 1 >= MAX_COLLABORATORS) throw new ProjectError("COLLABORATOR_LIMIT");
      const role = invitation.role as ProjectMemberRole;
      await recordEvent(tx, project, profile.id, "INVITATION_ACCEPTED", [{ kind: "INVITATION", id: invitation.id }, { kind: "PROJECT_MEMBER", id: profile.id }], { role });
      if (membership) {
        await tx.$executeRaw`UPDATE app.project_membership SET active = true, role = ${role}::app.project_member_role, version = version + 1, deactivated_sequence = NULL, updated_at = CURRENT_TIMESTAMP WHERE project_id = ${project.id}::uuid AND profile_id = ${profile.id}::uuid`;
      } else {
        await tx.projectMembership.create({ data: { projectId: project.id, profileId: profile.id, role } });
      }
      await tx.$executeRaw`UPDATE app.invitation SET accepted_by = ${profile.id}::uuid, accepted_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ${invitation.id}::uuid`;
      await tx.$executeRaw`UPDATE app.invitation SET revoked_at = CURRENT_TIMESTAMP, version = version + 1
        WHERE project_id = ${project.id}::uuid AND verified_email = ${invitation.verified_email} AND id <> ${invitation.id}::uuid AND accepted_at IS NULL AND revoked_at IS NULL`;
      await tx.$executeRaw`UPDATE app.project SET membership_version = membership_version + 1, realtime_epoch = gen_random_uuid(), updated_at = CURRENT_TIMESTAMP WHERE id = ${project.id}::uuid`;
      const result = { projectId: project.id, role };
      await saveReceipt(tx, profile.id, "USER", profile.id, validated.key, ACCEPT_OPERATION, hash, result);
      return { ...result, replayed: false };
    });
  });
}
