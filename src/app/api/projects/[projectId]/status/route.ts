import { getProjectStatus } from "@/features/projects/server/management";
import { authConfig } from "@/server/web/auth-config";
import { verifiedIdentity } from "@/server/web/api-request";
import { projectError, projectFailure, projectResponse } from "@/server/web/project-api";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const user = await verifiedIdentity();
  if (!user) return authConfig() ? projectError("UNAUTHENTICATED", "Sign in to continue.", 401) : projectError("UNAVAILABLE", "Project access is unavailable.", 503);
  try { return projectResponse(await getProjectStatus(user, (await params).projectId)); } catch (error) { return projectFailure(error); }
}
