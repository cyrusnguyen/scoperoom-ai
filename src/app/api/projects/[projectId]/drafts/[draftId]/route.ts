import { getDraft } from "@/features/drafts/server/execute-command";
import { readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; draftId: string }> }) {
  const { projectId, draftId } = await params;
  return readRoute(request, (user) => getDraft(user, projectId, draftId));
}
