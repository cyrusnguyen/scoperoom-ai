import { WorkspaceError, createWorkspace, getWorkspaceHome } from "@/features/workspaces/server/workspaces";
import { authConfig } from "@/server/web/auth-config";
import { readProcessEnv } from "@/server/env";
import { boundedJsonBody, verifiedIdentity } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store" };

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: noStore });
}

function safeError(code: string, message: string, status: number) {
  return response({ error: { code, message } }, status);
}

function workspaceError(error: unknown) {
  if (!(error instanceof WorkspaceError)) return safeError("UNAVAILABLE", "Workspace access is unavailable.", 503);
  const errors = {
    NOT_ENTITLED: ["NOT_ENTITLED", "Workspace creation is not available for this account.", 403],
    LIMIT_REACHED: ["LIMIT_REACHED", "Your workspace limit has been reached.", 409],
    KEY_REUSED: ["KEY_REUSED", "This create request conflicts with an earlier request.", 409],
    INVALID_INPUT: ["INVALID_INPUT", "Enter a valid workspace name and try again.", 400],
    NOT_FOUND: ["NOT_FOUND", "Workspace is unavailable.", 404],
    CONFLICT: ["CONFLICT", "Workspace changed. Refresh and try again.", 409],
    UNAVAILABLE: ["UNAVAILABLE", "Workspace access is unavailable.", 503],
  } as const;
  const [code, message, status] = errors[error.code];
  return safeError(code, message, status);
}

export async function GET() {
  const user = await verifiedIdentity();
  if (!user) return authConfig()
    ? safeError("UNAUTHENTICATED", "Sign in to continue.", 401)
    : safeError("UNAVAILABLE", "Workspace access is unavailable.", 503);

  try {
    return response(await getWorkspaceHome(user));
  } catch (error) {
    return workspaceError(error);
  }
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== readProcessEnv().appUrl) {
    return safeError("INVALID_REQUEST", "This request could not be accepted.", 403);
  }

  const user = await verifiedIdentity();
  if (!user) return authConfig()
    ? safeError("UNAUTHENTICATED", "Sign in to continue.", 401)
    : safeError("UNAVAILABLE", "Workspace access is unavailable.", 503);

  const body = await boundedJsonBody(request);
  const key = request.headers.get("idempotency-key");
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { name?: unknown }).name !== "string" || typeof key !== "string" || !/^[\x21-\x7e]{1,128}$/.test(key)) {
    return safeError("INVALID_INPUT", "Enter a valid workspace name and try again.", 400);
  }

  try {
    const created = await createWorkspace(user, { name: (body as { name: string }).name, key });
    return response(created, created.replayed ? 200 : 201);
  } catch (error) {
    return workspaceError(error);
  }
}

