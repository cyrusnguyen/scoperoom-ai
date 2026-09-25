import { issueInvitation, listProjectInvitations } from "@/features/projects/server/invitations";
import { authConfig } from "@/server/web/auth-config";
import { boundedJsonBody, verifiedIdentity } from "@/server/web/api-request";
import { projectError, projectFailure, projectResponse } from "@/server/web/project-api";
import { readProcessEnv } from "@/server/env";

export const dynamic = "force-dynamic";

function unavailableIdentity() {
  return authConfig()
    ? projectError("UNAUTHENTICATED", "Sign in to continue.", 401)
    : projectError("UNAVAILABLE", "Project access is unavailable.", 503);
}

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const user = await verifiedIdentity();
  if (!user) return unavailableIdentity();
  try {
    return projectResponse(await listProjectInvitations(user, (await params).projectId));
  } catch (error) {
    return projectFailure(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  if (request.headers.get("origin") !== readProcessEnv().appUrl) return projectError("INVALID_REQUEST", "This request could not be accepted.", 403);
  const user = await verifiedIdentity();
  if (!user) return unavailableIdentity();
  const body = await boundedJsonBody(request);
  const key = request.headers.get("idempotency-key");
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 ||
      typeof (body as { verifiedEmail?: unknown }).verifiedEmail !== "string" || typeof (body as { role?: unknown }).role !== "string" ||
      typeof key !== "string") return projectError("INVALID_INPUT", "Enter valid invitation details and try again.", 400);
  try {
    const issued = await issueInvitation(user, (await params).projectId, { ...(body as { verifiedEmail: string; role: string }), key });
    return projectResponse(issued, issued.replayed ? 200 : 201);
  } catch (error) {
    return projectFailure(error);
  }
}
