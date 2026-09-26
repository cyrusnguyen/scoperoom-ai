import { uuid } from "./project.ts";
import { projectMemberRoles } from "./invitation.ts";

const keyPattern = /^[\x21-\x7e]{16,128}$/;

export type ProjectManagementKey = { key: string };

export type ProjectSettingsInput = ProjectManagementKey & {
  name: string;
  expectedSettingsVersion: number;
};

export type MemberChangeInput = ProjectManagementKey & {
  role: (typeof projectMemberRoles)[number];
  expectedMemberVersion: number;
};

export type MemberRemovalInput = ProjectManagementKey & {
  expectedMemberVersion: number;
};

export type ApprovalPolicyInput = ProjectManagementKey & {
  designatedApproverId: string | null;
  expectedApprovalPolicyVersion: number;
};

export type ProjectArchiveInput = ProjectManagementKey & {
  expectedProjectVersion: number;
  reason?: string;
};

function invalidInput(): never {
  throw new Error("INVALID_INPUT");
}

function version(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalidInput();
  return value;
}

function key(value: unknown) {
  if (typeof value !== "string" || !keyPattern.test(value)) invalidInput();
  return value;
}

function name(value: unknown) {
  if (typeof value !== "string") invalidInput();
  const normalized = value.normalize("NFC").trim();
  if (!normalized || Array.from(normalized).length > 120) invalidInput();
  return normalized;
}

function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidInput();
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((field) => !allowed.includes(field))) invalidInput();
  return value;
}

export function validateLeaveInput(input: unknown): ProjectManagementKey {
  return { key: key(only(object(input), ["key"]).key) };
}

export function validateProjectSettingsInput(input: unknown): ProjectSettingsInput {
  const value = only(object(input), ["name", "expectedSettingsVersion", "key"]);
  return { name: name(value.name), expectedSettingsVersion: version(value.expectedSettingsVersion), key: key(value.key) };
}

export function validateMemberChangeInput(input: unknown): MemberChangeInput {
  const value = only(object(input), ["role", "expectedMemberVersion", "key"]);
  if (!projectMemberRoles.includes(value.role as (typeof projectMemberRoles)[number])) invalidInput();
  return { role: value.role as MemberChangeInput["role"], expectedMemberVersion: version(value.expectedMemberVersion), key: key(value.key) };
}

export function validateMemberRemovalInput(input: unknown): MemberRemovalInput {
  const value = only(object(input), ["expectedMemberVersion", "key"]);
  return { expectedMemberVersion: version(value.expectedMemberVersion), key: key(value.key) };
}

export function validateApprovalPolicyInput(input: unknown): ApprovalPolicyInput {
  const value = only(object(input), ["designatedApproverId", "expectedApprovalPolicyVersion", "key"]);
  if (value.designatedApproverId !== null && (typeof value.designatedApproverId !== "string" || !uuid.test(value.designatedApproverId))) invalidInput();
  return { designatedApproverId: value.designatedApproverId as string | null, expectedApprovalPolicyVersion: version(value.expectedApprovalPolicyVersion), key: key(value.key) };
}

export function validateProjectArchiveInput(input: unknown): ProjectArchiveInput {
  const value = only(object(input), ["expectedProjectVersion", "reason", "key"]);
  if (typeof value.reason !== "string") invalidInput();
  const reason = value.reason.normalize("NFC").trim();
  if (!reason || Array.from(reason).length > 1_000) invalidInput();
  return { expectedProjectVersion: version(value.expectedProjectVersion), reason, key: key(value.key) };
}

export function validateProjectRestoreInput(input: unknown): ProjectArchiveInput {
  const value = only(object(input), ["expectedProjectVersion", "key"]);
  return { expectedProjectVersion: version(value.expectedProjectVersion), key: key(value.key) };
}
