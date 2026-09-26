import { getProjectMembers } from "@/features/projects/server/management";
import { readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return readRoute(request, (user) => getProjectMembers(user, projectId));
}
