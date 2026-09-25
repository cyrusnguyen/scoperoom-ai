export const workspaceErrorCodes = ["NOT_ENTITLED", "LIMIT_REACHED", "KEY_REUSED", "INVALID_INPUT", "NOT_FOUND", "CONFLICT", "UNAVAILABLE"] as const;

export type WorkspaceErrorCode = (typeof workspaceErrorCodes)[number];

export type WorkspaceIdentity = {
  authUserId: string;
  displayName: string;
};

export type CreateWorkspaceInput = {
  name: string;
  key: string;
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  createdAt: string;
  status: "ACTIVE" | "ARCHIVED";
  version: number;
  canManage: boolean;
};

export type WorkspaceHome = {
  profileId: string;
  displayName: string;
  canCreate: boolean;
  maxWorkspaces: number;
  ownedCount: number;
  workspaces: WorkspaceSummary[];
};

export type CreatedWorkspace = {
  id: string;
  name: string;
  replayed: boolean;
};

function invalidInput(): never {
  throw new Error("INVALID_INPUT");
}

export function validateWorkspaceCreateInput(input: CreateWorkspaceInput): CreateWorkspaceInput {
  if (typeof input?.name !== "string" || typeof input?.key !== "string") invalidInput();

  const name = input.name.normalize("NFC").trim();
  if (!name || Array.from(name).length > 120) invalidInput();
  if (input.key.length < 16 || input.key.length > 128) invalidInput();

  return { name, key: input.key };
}

export type WorkspaceLifecycleInput = { workspaceId: string; expectedVersion: number; key: string };
export type WorkspaceLifecycleResult = { id: string; status: "ACTIVE" | "ARCHIVED"; version: number; replayed: boolean };

export function validateWorkspaceLifecycleInput(input: WorkspaceLifecycleInput): WorkspaceLifecycleInput {
  if (typeof input?.workspaceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.workspaceId) ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      typeof input.key !== "string" || !/^[\x21-\x7e]{16,128}$/.test(input.key)) invalidInput();
  return input;
}
