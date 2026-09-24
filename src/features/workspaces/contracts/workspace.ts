export const workspaceErrorCodes = ["NOT_ENTITLED", "LIMIT_REACHED", "KEY_REUSED", "INVALID_INPUT", "UNAVAILABLE"] as const;

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
