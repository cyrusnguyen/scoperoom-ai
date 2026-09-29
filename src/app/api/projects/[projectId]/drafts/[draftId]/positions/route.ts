import { POSITION_BODY_LIMIT } from "@/features/drafts/contracts/positions";
import { savePositions } from "@/features/drafts/server/positions";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; draftId: string }> }) {
  const { projectId, draftId } = await params;
  return mutationRoute(request, (user, input) => savePositions(user, projectId, draftId, input), { bodyLimit: POSITION_BODY_LIMIT });
}
