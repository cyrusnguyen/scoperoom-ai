export const projectMemberRoles = ["EDITOR", "REVIEWER", "VIEWER"] as const;
export type ProjectMemberRole = (typeof projectMemberRoles)[number];

const keyPattern = /^[\x21-\x7e]{16,128}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

function invalidInput(): never {
  throw new Error("INVALID_INPUT");
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
  if (!input || typeof input !== "object") invalidInput();
  const { verifiedEmail, role, key: inputKey } = input as Record<string, unknown>;
  if (!projectMemberRoles.includes(role as ProjectMemberRole)) invalidInput();
  return { verifiedEmail: normalizeVerifiedEmail(verifiedEmail), role: role as ProjectMemberRole, key: key(inputKey) };
}

export function validateInvitationAcceptInput(input: unknown) {
  if (!input || typeof input !== "object") invalidInput();
  const { token, key: inputKey } = input as Record<string, unknown>;
  if (typeof token !== "string" || !tokenPattern.test(token)) invalidInput();
  return { token, key: key(inputKey) };
}

export function validateInvitationRevokeInput(input: unknown) {
  if (!input || typeof input !== "object") invalidInput();
  const { expectedVersion, key: inputKey } = input as Record<string, unknown>;
  if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) invalidInput();
  return { expectedVersion, key: key(inputKey) };
}
