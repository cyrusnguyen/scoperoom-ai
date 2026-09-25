import "server-only";
import { ProjectError } from "@/features/projects/server/projects";

export function projectResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function projectError(code: string, message: string, status: number) {
  return projectResponse({ error: { code, message } }, status);
}

export function projectFailure(error: unknown) {
  if (!(error instanceof ProjectError)) return projectError("UNAVAILABLE", "Project access is unavailable.", 503);
  const errors = {
    NOT_ENTITLED: ["NOT_ENTITLED", "Project creation is not available for this account.", 403],
    NOT_AUTHORIZED: ["NOT_AUTHORIZED", "Project creation is not available for this workspace.", 403],
    NOT_FOUND: ["NOT_FOUND", "Project is unavailable.", 404],
    KEY_REUSED: ["KEY_REUSED", "This create request conflicts with an earlier request.", 409],
    INVALID_INPUT: ["INVALID_INPUT", "Enter valid project details and try again.", 400],
    CONFLICT: ["CONFLICT", "That invitation is no longer pending.", 409],
    COLLABORATOR_LIMIT: ["COLLABORATOR_LIMIT", "This project has reached its collaborator limit.", 409],
    INVITATION_LIMIT: ["INVITATION_LIMIT", "This project already has the maximum number of pending invitations.", 409],
    UNAVAILABLE: ["UNAVAILABLE", "Project access is unavailable.", 503],
  } as const;
  const [code, message, status] = errors[error.code];
  return projectError(code, message, status);
}
