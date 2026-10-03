import { prepareFlow } from "@/features/exports/server/prepare-flow";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; draftId: string; flowId: string }> }) {
  const { projectId, draftId, flowId } = await params;
  return mutationRoute(request, (user, input) => prepareFlow(user, projectId, draftId, flowId, input), { keyless: true });
}
