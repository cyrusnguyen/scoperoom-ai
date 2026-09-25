import { acceptInvitation } from "@/features/projects/server/invitations";
import { authConfig } from "@/server/web/auth-config";
import { boundedJsonBody, verifiedIdentity } from "@/server/web/api-request";
import { projectError, projectFailure, projectResponse } from "@/server/web/project-api";
import { readProcessEnv } from "@/server/env";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== readProcessEnv().appUrl) return projectError("INVALID_REQUEST", "This request could not be accepted.", 403);
  const user = await verifiedIdentity();
  if (!user) return authConfig()
    ? projectError("UNAUTHENTICATED", "Sign in to continue.", 401)
    : projectError("UNAVAILABLE", "Project access is unavailable.", 503);
  const body = await boundedJsonBody(request);
  const key = request.headers.get("idempotency-key");
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
      typeof (body as { token?: unknown }).token !== "string" || typeof key !== "string") {
    return projectError("INVALID_INPUT", "This invitation is invalid.", 400);
  }
  try {
    const accepted = await acceptInvitation(user, { token: (body as { token: string }).token, key });
    return projectResponse(accepted, accepted.replayed ? 200 : 201);
  } catch (error) {
    return projectFailure(error);
  }
}
