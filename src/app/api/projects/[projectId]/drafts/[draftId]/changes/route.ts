import { CHANGES_BODY_LIMIT } from "@/features/drafts/contracts/changes";
import { saveChanges } from "@/features/drafts/server/changes";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; draftId: string }> }) {
  const { projectId, draftId } = await params;
  return mutationRoute(request, (user, input) => saveChanges(user, projectId, draftId, input), { bodyLimit: CHANGES_BODY_LIMIT });
}
