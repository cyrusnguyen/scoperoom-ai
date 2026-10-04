import { ProjectError } from "@/features/projects/server/errors";
import { cancelRun } from "@/features/proposals/server/settle-runs";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; runId: string }> }) {
  const { projectId, runId } = await params;
  return mutationRoute(request, (user, input) => {
    if (Object.keys(input).length !== 1) throw new ProjectError("INVALID_INPUT"); // the empty object plus the header key
    return cancelRun(user, projectId, runId, String(input.key));
  });
}
