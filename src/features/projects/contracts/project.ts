export const projectErrorCodes = ["NOT_ENTITLED", "NOT_AUTHORIZED", "NOT_FOUND", "KEY_REUSED", "INVALID_INPUT", "CONFLICT", "COLLABORATOR_LIMIT", "INVITATION_LIMIT", "UNAVAILABLE"] as const;

export type ProjectErrorCode = (typeof projectErrorCodes)[number];

export type ProjectIdentity = {
  authUserId: string;
  displayName: string;
};

export type CreateProjectInput = {
  workspaceId: string;
  name: string;
  key: string;
};

export type CreatedProject = {
  id: string;
  workspaceId: string;
  name: string;
  replayed: boolean;
};

export type ProjectAccessRole = "OWNER" | "EDITOR" | "REVIEWER" | "VIEWER";

export type WorkspaceProjects = {
  workspace: { id: string; name: string; canCreateProject: boolean };
  projects: Array<{ id: string; name: string; status: string; currentDraftId: string; createdAt: string; role: ProjectAccessRole }>;
};

export type ProjectBootstrap = {
  project: { id: string; workspaceId: string; name: string; status: string; role: ProjectAccessRole };
  draft: { id: string; schemaVersion: 3; documentRevision: number; layoutRevision: number; documentJson: unknown; layoutJson: unknown };
};

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidInput(): never {
  throw new Error("INVALID_INPUT");
}

export function validateProjectCreateInput(input: CreateProjectInput): CreateProjectInput {
  if (typeof input?.workspaceId !== "string" || typeof input?.name !== "string" || typeof input?.key !== "string") invalidInput();
  const name = input.name.normalize("NFC").trim();
  if (!uuid.test(input.workspaceId) || !name || Array.from(name).length > 120 || !/^[\x21-\x7e]{16,128}$/.test(input.key)) invalidInput();
  return { workspaceId: input.workspaceId, name, key: input.key };
}
