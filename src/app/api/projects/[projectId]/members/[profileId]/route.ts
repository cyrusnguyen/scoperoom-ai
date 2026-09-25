import { changeProjectMember, removeProjectMember } from "@/features/projects/server/management";
import { authConfig } from "@/server/web/auth-config";
import { boundedJsonBody, verifiedIdentity } from "@/server/web/api-request";
import { projectError, projectFailure, projectResponse } from "@/server/web/project-api";
import { readProcessEnv } from "@/server/env";

export const dynamic = "force-dynamic";

function unavailable() {
  return authConfig() ? projectError("UNAUTHENTICATED", "Sign in to continue.", 401) : projectError("UNAVAILABLE", "Project access is unavailable.", 503);
}

function validKey(value: string | null) { return Boolean(value && /^[\x21-\x7e]{16,128}$/.test(value)); }

export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string; profileId: string }> }) {
  if (request.headers.get("origin") !== readProcessEnv().appUrl) return projectError("INVALID_REQUEST", "This request could not be accepted.", 403);
  const user = await verifiedIdentity();
  if (!user) return unavailable();
  const body = await boundedJsonBody(request);
  const key = request.headers.get("idempotency-key");
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2 || typeof (body as { role?: unknown }).role !== "string" || typeof (body as { expectedMemberVersion?: unknown }).expectedMemberVersion !== "number" || !validKey(key)) return projectError("INVALID_INPUT", "Enter valid member details and try again.", 400);
  try { return projectResponse(await changeProjectMember(user, (await params).projectId, (await params).profileId, { ...(body as { role: string; expectedMemberVersion: number }), key: key! })); } catch (error) { return projectFailure(error); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ projectId: string; profileId: string }> }) {
  if (request.headers.get("origin") !== readProcessEnv().appUrl) return projectError("INVALID_REQUEST", "This request could not be accepted.", 403);
  const user = await verifiedIdentity();
  if (!user) return unavailable();
  const body = await boundedJsonBody(request);
  const key = request.headers.get("idempotency-key");
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { expectedMemberVersion?: unknown }).expectedMemberVersion !== "number" || !validKey(key)) return projectError("INVALID_INPUT", "Enter a valid member version and try again.", 400);
  try { return projectResponse(await removeProjectMember(user, (await params).projectId, (await params).profileId, { ...(body as { expectedMemberVersion: number }), key: key! })); } catch (error) { return projectFailure(error); }
}
