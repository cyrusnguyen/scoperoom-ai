import { COMMAND_REQUEST_BODY_LIMIT } from "@/features/drafts/contracts/commands";
import { executeGraphCommand } from "@/features/drafts/server/execute-command";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; draftId: string }> }) {
  const { projectId, draftId } = await params;
  return mutationRoute(request, (user, input) => executeGraphCommand(user, projectId, draftId, input), { bodyLimit: COMMAND_REQUEST_BODY_LIMIT });
}
