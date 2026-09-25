import { updateProjectSettings } from "@/features/projects/server/management";
import { authConfig } from "@/server/web/auth-config";
import { boundedJsonBody, verifiedIdentity } from "@/server/web/api-request";
import { projectError, projectFailure, projectResponse } from "@/server/web/project-api";
import { readProcessEnv } from "@/server/env";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  if (request.headers.get("origin") !== readProcessEnv().appUrl) return projectError("INVALID_REQUEST", "This request could not be accepted.", 403);
  const user = await verifiedIdentity();
  if (!user) return authConfig() ? projectError("UNAUTHENTICATED", "Sign in to continue.", 401) : projectError("UNAVAILABLE", "Project access is unavailable.", 503);
  const body = await boundedJsonBody(request);
  const key = request.headers.get("idempotency-key");
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 || typeof (body as { name?: unknown }).name !== "string" || typeof (body as { expectedSettingsVersion?: unknown }).expectedSettingsVersion !== "number" || !key) return projectError("INVALID_INPUT", "Enter valid project settings and try again.", 400);
  try { return projectResponse(await updateProjectSettings(user, (await params).projectId, { ...(body as { name: string; expectedSettingsVersion: number }), key })); } catch (error) { return projectFailure(error); }
}
