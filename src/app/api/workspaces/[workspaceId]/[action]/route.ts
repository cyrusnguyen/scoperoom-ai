import { archiveWorkspace, restoreWorkspace, WorkspaceError } from "@/features/workspaces/server/workspaces";
import { authConfig } from "@/server/web/auth-config";
import { readProcessEnv } from "@/server/env";
import { boundedJsonBody, verifiedIdentity } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function failure(error: unknown) {
  if (!(error instanceof WorkspaceError)) return response({ error: { code: "UNAVAILABLE", message: "Workspace access is unavailable." } }, 503);
  const status = error.code === "NOT_FOUND" ? 404 : error.code === "NOT_ENTITLED" ? 403 : error.code === "CONFLICT" || error.code === "LIMIT_REACHED" || error.code === "KEY_REUSED" ? 409 : error.code === "INVALID_INPUT" ? 400 : 503;
  const message = error.code === "LIMIT_REACHED" ? "Your active workspace limit has been reached." : error.code === "CONFLICT" ? "Workspace changed. Refresh and try again." : error.code === "KEY_REUSED" ? "This request conflicts with an earlier request." : error.code === "NOT_FOUND" ? "Workspace is unavailable." : error.code === "NOT_ENTITLED" ? "Workspace restore is not available for this account." : error.code === "INVALID_INPUT" ? "This request could not be accepted." : "Workspace access is unavailable.";
  return response({ error: { code: error.code, message } }, status);
}

export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string; action: string }> }) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== readProcessEnv().appUrl) return response({ error: { code: "INVALID_REQUEST", message: "This request could not be accepted." } }, 403);
  const user = await verifiedIdentity();
  if (!user) return authConfig()
    ? response({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue." } }, 401)
    : response({ error: { code: "UNAVAILABLE", message: "Workspace access is unavailable." } }, 503);
  const { workspaceId, action } = await params;
  if (action !== "archive" && action !== "restore") return response({ error: { code: "NOT_FOUND", message: "Workspace is unavailable." } }, 404);
  const body = await boundedJsonBody(request);
  const key = request.headers.get("idempotency-key");
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      !Number.isSafeInteger((body as { expectedVersion?: unknown }).expectedVersion) || typeof key !== "string") {
    return response({ error: { code: "INVALID_INPUT", message: "This request could not be accepted." } }, 400);
  }
  try {
    const input = { workspaceId, expectedVersion: (body as { expectedVersion: number }).expectedVersion, key };
    return response(await (action === "archive" ? archiveWorkspace(user, input) : restoreWorkspace(user, input)));
  } catch (error) {
    return failure(error);
  }
}
