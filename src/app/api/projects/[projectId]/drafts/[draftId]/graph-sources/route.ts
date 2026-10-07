import { createGraphSource } from "@/features/sources/server/sources";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; draftId: string }> }) {
  const { projectId, draftId } = await params;
  return mutationRoute(request, (user, input) => createGraphSource(user, projectId, draftId, input), { createdStatus: 201 });
}
