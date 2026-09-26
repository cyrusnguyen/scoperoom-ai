import { uuid } from "./project.ts";

export const projectMemberRoles = ["EDITOR", "REVIEWER", "VIEWER"] as const;
export type ProjectMemberRole = (typeof projectMemberRoles)[number];
export type InvitationAcceptInput = { key: string; token: string; invitationId?: undefined } | { key: string; invitationId: string; token?: undefined };
export type MyInvitation = { id: string; projectName: string; inviterName: string; role: ProjectMemberRole; expiresAt: string };

export const MAX_COLLABORATORS = 10;
export const MAX_PENDING_INVITATIONS = 50;
export const MY_INVITATION_LIMIT = 50;

const keyPattern = /^[\x21-\x7e]{16,128}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

function invalidInput(): never {
  throw new Error("INVALID_INPUT");
}

function object(input: unknown, allowed: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalidInput();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((field) => !allowed.includes(field))) invalidInput();
  return value;
}

function key(value: unknown) {
  if (typeof value !== "string" || !keyPattern.test(value)) invalidInput();
  return value;
}

export function normalizeVerifiedEmail(value: unknown) {
  if (typeof value !== "string") invalidInput();
  const email = value.normalize("NFC").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalidInput();
  return email;
}

export function validateInvitationIssueInput(input: unknown) {
  const value = object(input, ["verifiedEmail", "role", "key"]);
  if (!projectMemberRoles.includes(value.role as ProjectMemberRole)) invalidInput();
  return { verifiedEmail: normalizeVerifiedEmail(value.verifiedEmail), role: value.role as ProjectMemberRole, key: key(value.key) };
}

export function validateInvitationAcceptInput(input: unknown): InvitationAcceptInput {
  const value = object(input, ["token", "invitationId", "key"]);
  if ((value.token === undefined) === (value.invitationId === undefined)) invalidInput();
  if (value.token !== undefined) {
    if (typeof value.token !== "string" || !tokenPattern.test(value.token)) invalidInput();
    return { token: value.token, key: key(value.key) };
  }
  if (typeof value.invitationId !== "string" || !uuid.test(value.invitationId)) invalidInput();
  return { invitationId: value.invitationId, key: key(value.key) };
}

export function validateInvitationRevokeInput(input: unknown) {
  const value = object(input, ["expectedVersion", "key"]);
  if (typeof value.expectedVersion !== "number" || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1) invalidInput();
  return { expectedVersion: value.expectedVersion, key: key(value.key) };
}
