import { updateSource } from "@/features/sources/server/sources";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string; sourceId: string }> }) {
  const { projectId, sourceId } = await params;
  return mutationRoute(request, (user, input) => updateSource(user, projectId, sourceId, input));
}
