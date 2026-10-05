import { ProjectError } from "@/features/projects/server/errors";
import { parseApplyRunInput } from "@/features/proposals/contracts/tasks";
import { applyRun } from "@/features/proposals/server/apply-run";
import { mutationRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ projectId: string; runId: string }> }) {
  const { projectId, runId } = await params;
  return mutationRoute(request, (user, input) => {
    const { key, ...body } = input;
    let parsed;
    try { parsed = parseApplyRunInput(body, String(key)); } catch { throw new ProjectError("INVALID_INPUT"); }
    return applyRun(user, projectId, runId, parsed);
  }, { bodyLimit: 16 * 1024, limitDetails: { limit: "APPLY_BODY_BYTES" } });
}
