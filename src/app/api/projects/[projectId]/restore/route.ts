import { restoreProject } from "@/features/projects/server/management";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return mutationRoute(request, (user, input) => restoreProject(user, projectId, input));
}
